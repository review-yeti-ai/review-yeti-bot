import type { Env, ReviewRunSpec } from './types.js';
import { deriveGateExternalId, deriveWorkerExternalId, REVIEW_GATE_CHECK_NAME, REVIEW_WORKER_CHECK_NAME } from './github/index.js';
import { reviewRunSpecDigest } from './reviewRunIdentity.js';

const PRE_DISPATCH_CONFIG_ERROR = 'Step config for "dispatch-container" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/';
const SAFE_SUCCESS_VERDICTS = new Set(['SHIP', 'success']);
type WorkflowStatusValue = Awaited<ReturnType<WorkflowInstance['status']>>['status'];
const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatusValue>(['complete', 'errored', 'terminated']);
const LIVE_WORKFLOW_STATUSES = new Set<WorkflowStatusValue>([
  'queued', 'running', 'paused', 'waiting', 'waitingForPause',
]);
function reject(code: string): never { throw new Error(code); }

async function getJson(url: string, token: string, code: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!response.ok) reject(code);
  return response.json();
}

async function readDoStatus(env: Env, runId: string): Promise<any> {
  const stub = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(runId));
  const response = await stub.fetch('http://do/status');
  if (!response.ok) reject('prior_do_unavailable');
  const status = await response.json() as any;
  if (status.runId !== runId) reject('prior_do_identity_mismatch');
  return status;
}

async function priorDoStatus(env: Env, spec: ReviewRunSpec, runId: string): Promise<any> {
  const status = await readDoStatus(env, runId);
  if (
    status.headSha !== spec.headSha ||
    status.specDigest !== await reviewRunSpecDigest({ ...spec, runId }) ||
    !status.isCurrentHead ||
    status.cancelRequested
  ) reject('prior_do_identity_mismatch');
  return status;
}

async function assertCurrentRunIsFresh(env: Env, spec: ReviewRunSpec): Promise<void> {
  const status = await priorDoStatus(env, spec, spec.runId);
  if (
    status.phase !== 'Pending' ||
    status.terminalReceiptSummary !== null ||
    status.workerId ||
    status.jobId
  ) reject('prior_outcome_unknown');
}

async function assertCurrentPublisherRunIsCurrent(env: Env, spec: ReviewRunSpec): Promise<void> {
  const status = await priorDoStatus(env, spec, spec.runId);
  if (status.workerId || status.jobId) reject('prior_outcome_unknown');
  if (status.phase === 'Pending' && status.terminalReceiptSummary === null) return;
  const operator = status.operatorPassthrough;
  if (!operator?.cancelRequested && status.phase === 'Completed' && status.terminalReceiptSummary?.status === 'succeeded'
    && status.terminalReceiptSummary?.verdict === 'SHIP' && status.terminalReceiptSummary?.findingsCount === 0
    && operator?.version === 'OperatorPassthroughState.v2' && operator.runId === spec.runId
    && operator.status === 'succeeded' && operator.mergeEligible === false) return;
  reject('prior_outcome_unknown');
}

interface CurrentPassthroughChecks {
  appId: number;
  workerExternalId: string;
  gateExternalId: string;
}

interface PriorOutcomeOptions {
  /** Permit only this publisher DO's exact current operator receipt on status/readback. */
  allowCurrentPublisherTerminal?: boolean;
  /** Exclude only this publication's exact service-owned in-progress/successful check IDs. */
  currentPassthroughChecks?: CurrentPassthroughChecks;
  /** Exclude only after matching its live source DO and exact RepoGate registration. */
  sourceRunId?: string | null;
}

interface RepoGatePrRunState {
  activeRunId: string | null;
  activeRunIds: string[];
  activeRunIdsComplete: true;
  latestRunId: string | null;
  queuedRunIds: string[];
}

const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{1,128}$/u;

async function readRepoGatePrRunState(env: Env, spec: ReviewRunSpec): Promise<RepoGatePrRunState> {
  try {
    const repoKey = `${spec.owner}/${spec.repo}`.toLowerCase();
    const gate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
    const response = await gate.fetch(`http://do/active-run/${spec.prNumber}`);
    if (!response.ok) reject('prior_queue_state_unavailable');
    const value = await response.json() as any;
    const validActiveRunId = value?.activeRunId === null || RUN_ID_PATTERN.test(value?.activeRunId);
    const activeRunIds = value?.activeRunIds;
    const validActiveRunIds = Array.isArray(activeRunIds)
      && activeRunIds.every((runId: unknown) => typeof runId === 'string' && RUN_ID_PATTERN.test(runId))
      && new Set(activeRunIds).size === activeRunIds.length;
    const validLatestRunId = value?.latestRunId === null || value?.latestRunId === '__EVICTED__'
      || RUN_ID_PATTERN.test(value?.latestRunId);
    const queuedRunIds = value?.queuedRunIds;
    if (!value || typeof value !== 'object' || !validActiveRunId || !validActiveRunIds
      || value.activeRunIdsComplete !== true
      || (value.activeRunId !== null && !activeRunIds.includes(value.activeRunId))
      || !validLatestRunId
      || !Array.isArray(queuedRunIds) || queuedRunIds.some((runId: unknown) =>
        typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId))
      || new Set(queuedRunIds).size !== queuedRunIds.length) {
      reject('prior_queue_state_unavailable');
    }
    return {
      activeRunId: value.activeRunId,
      activeRunIds,
      activeRunIdsComplete: true,
      latestRunId: value.latestRunId,
      queuedRunIds,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'prior_queue_state_unavailable') throw error;
    reject('prior_queue_state_unavailable');
  }
}

function sameRepoGatePrRunState(left: RepoGatePrRunState, right: RepoGatePrRunState): boolean {
  return left.activeRunId === right.activeRunId
    && left.activeRunIdsComplete === right.activeRunIdsComplete
    && left.activeRunIds.length === right.activeRunIds.length
    && left.activeRunIds.every((runId) => right.activeRunIds.includes(runId))
    && left.latestRunId === right.latestRunId
    && left.queuedRunIds.length === right.queuedRunIds.length
    && left.queuedRunIds.every((runId, index) => runId === right.queuedRunIds[index]);
}

function isIgnoredCurrentRun(runId: string, spec: ReviewRunSpec, sourceRunId?: string | null): boolean {
  return runId === spec.runId || runId === sourceRunId;
}

async function assertRegisteredPriorRunIsLive(env: Env, runId: string): Promise<void> {
  const status = await readDoStatus(env, runId);
  if (status.phase === 'Pending' || status.phase === 'Running') return;
  reject(status.phase === 'Completed' || status.phase === 'Failed' || status.phase === 'Cancelled'
    ? 'prior_queue_state_unavailable' : 'prior_outcome_unknown');
}

async function assertUnstartedPendingPriorIdentity(
  env: Env,
  spec: ReviewRunSpec,
  runId: string,
  status: any
): Promise<void> {
  if (status.runId !== runId || status.phase !== 'Pending' || status.cancelRequested !== false
    || status.isCurrentHead !== true || status.workerId || status.jobId || status.terminalReceiptSummary !== null
    || typeof status.specDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(status.specDigest)
    || typeof status.headSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(status.headSha)) {
    reject('prior_outcome_unknown');
  }

  let identityResponse: Response;
  try {
    const prior = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(runId));
    identityResponse = await prior.fetch('http://do/source-identity');
  } catch {
    reject('prior_do_unavailable');
  }
  if (!identityResponse.ok) reject('prior_do_unavailable');
  let identity: any;
  try { identity = await identityResponse.json(); }
  catch { reject('prior_do_identity_mismatch'); }
  if (identity?.version !== 'ReviewRunSourceIdentity.v1' || identity.runId !== runId
    || identity.owner?.toLowerCase() !== spec.owner.toLowerCase()
    || identity.repo?.toLowerCase() !== spec.repo.toLowerCase()
    || identity.prNumber !== spec.prNumber
    || !/^[a-f0-9]{40}$/iu.test(identity.headSha || '')
    || !/^[a-f0-9]{40}$/iu.test(identity.baseSha || '')
    || identity.headSha.toLowerCase() !== status.headSha.toLowerCase()
    || identity.specDigest !== status.specDigest) {
    reject('prior_do_identity_mismatch');
  }
}

function pendingRunRemainsUnstarted(status: any, runId: string, original: any): boolean {
  return status.runId === runId
    && status.phase === 'Pending'
    && status.cancelRequested === false
    && status.isCurrentHead === true
    && !status.workerId
    && !status.jobId
    && status.terminalReceiptSummary === null
    && status.specDigest === original.specDigest
    && status.headSha === original.headSha;
}

async function assertPriorWorkflowTerminal(env: Env, runId: string): Promise<void> {
  // Cloudflare's binding types and API do not expose a typed not-found error;
  // any get/status exception therefore remains an unavailable read, not absence.
  const binding = env.REVIEW_JOB_WORKFLOW as {
    get?: (id: string) => Promise<Pick<WorkflowInstance, 'id' | 'status'>>;
  } | undefined;
  if (!binding || typeof binding.get !== 'function') reject('prior_workflow_state_unavailable');

  let instance: Pick<WorkflowInstance, 'id' | 'status'>;
  try { instance = await binding.get(runId); }
  catch { reject('prior_workflow_state_unavailable'); }
  if (!instance || instance.id !== runId || typeof instance.status !== 'function') {
    reject('prior_workflow_state_unavailable');
  }

  let status: Awaited<ReturnType<WorkflowInstance['status']>>;
  try { status = await instance.status(); }
  catch { reject('prior_workflow_state_unavailable'); }
  if (!status || typeof status !== 'object' || typeof status.status !== 'string') {
    reject('prior_workflow_state_unavailable');
  }
  // Every recognized nonterminal state blocks; future or unknown states fail closed below.
  if (TERMINAL_WORKFLOW_STATUSES.has(status.status)) return;
  if (LIVE_WORKFLOW_STATUSES.has(status.status)) reject('prior_review_active');
  reject('prior_workflow_state_unavailable');
}

function blockingReviewerPresent(reviews: any[], currentHeadSha: string): boolean {
  if (!Array.isArray(reviews)) reject('prior_review_state_unavailable');
  if (!/^[a-f0-9]{40}$/u.test(currentHeadSha)) reject('prior_review_state_unavailable');
  const byReviewer = new Map<number, Array<{ id: number; at: number; state: string; commitId: string | null }>>();
  const seenReviewIds = new Set<number>();
  for (const review of reviews) {
    const state = review?.state;
    if (state === 'PENDING') continue;
    if (!['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED', 'COMMENTED'].includes(state)) {
      reject('prior_review_state_unavailable');
    }
    const reviewerId = Number(review?.user?.id);
    const id = Number(review?.id);
    const at = typeof review?.submitted_at === 'string' ? Date.parse(review.submitted_at) : Number.NaN;
    const commitId = typeof review?.commit_id === 'string' && /^[a-f0-9]{40}$/iu.test(review.commit_id)
      ? review.commit_id.toLowerCase() : null;
    if (!Number.isSafeInteger(reviewerId) || reviewerId <= 0 || !Number.isSafeInteger(id) || id <= 0
      || !Number.isFinite(at) || seenReviewIds.has(id)) reject('prior_review_state_unavailable');
    seenReviewIds.add(id);
    const history = byReviewer.get(reviewerId) || [];
    history.push({ id, at, state, commitId });
    byReviewer.set(reviewerId, history);
  }

  for (const history of byReviewer.values()) {
    history.sort((left, right) => left.at - right.at || left.id - right.id);
    let blocking = false;
    for (const review of history) {
      if (review.state === 'CHANGES_REQUESTED') blocking = true;
      else if (review.state === 'DISMISSED'
        || (review.state === 'APPROVED' && review.commitId === currentHeadSha)) blocking = false;
    }
    if (blocking) return true;
  }
  return false;
}

async function verifiedRegisteredSourceRunId(
  env: Env,
  spec: ReviewRunSpec,
  sourceRunId: string | null | undefined
): Promise<string | null> {
  if (!sourceRunId || sourceRunId === spec.runId || !/^run_[A-Za-z0-9_-]{1,128}$/u.test(sourceRunId)) return null;
  try {
    const source = await readDoStatus(env, sourceRunId);
    const sourceStub = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(sourceRunId));
    const identityResponse = await sourceStub.fetch('http://do/source-identity');
    if (!identityResponse.ok) return null;
    const sourceIdentity = await identityResponse.json() as any;
    const expectedDigest = await reviewRunSpecDigest({ ...spec, runId: sourceRunId });
    if (sourceIdentity?.version !== 'ReviewRunSourceIdentity.v1' || sourceIdentity.runId !== sourceRunId
      || sourceIdentity.owner?.toLowerCase() !== spec.owner.toLowerCase()
      || sourceIdentity.repo?.toLowerCase() !== spec.repo.toLowerCase()
      || sourceIdentity.prNumber !== spec.prNumber || sourceIdentity.headSha !== spec.headSha || sourceIdentity.baseSha !== spec.baseSha
      || sourceIdentity.specDigest !== expectedDigest || source.specDigest !== expectedDigest
      || source.phase !== 'Pending' || !source.isCurrentHead
      || source.cancelRequested || source.workerId || source.jobId || source.terminalReceiptSummary !== null
      || source.operatorPassthrough) return null;
    const repoKey = `${spec.owner}/${spec.repo}`.toLowerCase();
    const gate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
    const response = await gate.fetch(`http://do/active-run/${spec.prNumber}`);
    if (!response.ok) return null;
    const state = await response.json() as { activeRunId?: string | null; latestRunId?: string | null };
    if (state.latestRunId !== sourceRunId || (state.activeRunId && state.activeRunId !== sourceRunId)) return null;
    return sourceRunId;
  } catch {
    return null;
  }
}

async function latestPriorRunForPr(
  env: Env,
  spec: ReviewRunSpec,
  sourceRunId?: string | null,
  candidateSourceRunId?: string | null
): Promise<string | null> {
  const state = await readRepoGatePrRunState(env, spec);
  for (const activeRunId of state.activeRunIds) {
    if (isIgnoredCurrentRun(activeRunId, spec, sourceRunId)) continue;
    await assertRegisteredPriorRunIsLive(env, activeRunId);
    reject('prior_review_active');
  }
  for (const queuedRunId of state.queuedRunIds) {
    if (isIgnoredCurrentRun(queuedRunId, spec, sourceRunId)) continue;
    await assertRegisteredPriorRunIsLive(env, queuedRunId);
    reject('prior_review_active');
  }

  const latestRunId = state.latestRunId;
  if (!latestRunId || latestRunId === '__EVICTED__'
    || isIgnoredCurrentRun(latestRunId, spec, sourceRunId)) return null;
  if (latestRunId === candidateSourceRunId && candidateSourceRunId !== sourceRunId) {
    reject('prior_outcome_unknown');
  }

  const prior = await readDoStatus(env, latestRunId);
  if (prior.phase === 'Pending') {
    if (state.activeRunIds.includes(latestRunId) || state.queuedRunIds.includes(latestRunId)) {
      reject('prior_review_active');
    }
    await assertUnstartedPendingPriorIdentity(env, spec, latestRunId, prior);

    // The first complete membership read showed an unstarted pointer without a
    // slot or queue entry. Re-read both state owners before treating it as stale.
    const confirmedMembership = await readRepoGatePrRunState(env, spec);
    if (confirmedMembership.activeRunIds.includes(latestRunId) || confirmedMembership.queuedRunIds.includes(latestRunId)) {
      reject('prior_review_active');
    }
    for (const activeRunId of confirmedMembership.activeRunIds) {
      if (isIgnoredCurrentRun(activeRunId, spec, sourceRunId)) continue;
      await assertRegisteredPriorRunIsLive(env, activeRunId);
      reject('prior_review_active');
    }
    for (const queuedRunId of confirmedMembership.queuedRunIds) {
      if (isIgnoredCurrentRun(queuedRunId, spec, sourceRunId)) continue;
      await assertRegisteredPriorRunIsLive(env, queuedRunId);
      reject('prior_review_active');
    }
    if (!sameRepoGatePrRunState(state, confirmedMembership)) reject('prior_queue_state_unavailable');

    const confirmedPrior = await readDoStatus(env, latestRunId);
    if (!pendingRunRemainsUnstarted(confirmedPrior, latestRunId, prior)) reject('prior_outcome_unknown');
    await assertPriorWorkflowTerminal(env, latestRunId);
    return null;
  }
  if (prior.phase === 'Running') {
    reject(state.activeRunIds.includes(latestRunId) || state.queuedRunIds.includes(latestRunId)
      ? 'prior_review_active' : 'prior_outcome_unknown');
  }
  if (prior.phase !== 'Completed' && prior.phase !== 'Failed' && prior.phase !== 'Cancelled') reject('prior_outcome_unknown');
  if (prior.headSha !== spec.headSha) return null;
  await priorDoStatus(env, spec, latestRunId);
  return latestRunId;
}

async function isExactPreDispatchFailure(env: Env, spec: ReviewRunSpec, runId: string, attempt: number): Promise<boolean> {
  if (attempt !== 1) return false;
  const doStatus = await priorDoStatus(env, spec, runId);
  const receipt = doStatus.terminalReceiptSummary;
  if (doStatus.phase !== 'Failed' || receipt?.status !== 'failed' || receipt?.verdict !== null || receipt?.findingsCount !== 0) return false;
  const workflow = await (await env.REVIEW_JOB_WORKFLOW.get(runId)).status();
  return workflow.status === 'errored' && workflow.error?.message === PRE_DISPATCH_CONFIG_ERROR;
}

export async function assertNoBlockingPriorOutcome(
  env: Env,
  spec: ReviewRunSpec,
  token: string,
  appId: number,
  fetchFn: typeof fetch = fetch,
  options: PriorOutcomeOptions = {}
): Promise<string[]> {
  const base = `https://api.github.com/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repo)}`;
  if (options.allowCurrentPublisherTerminal) await assertCurrentPublisherRunIsCurrent(env, spec);
  else await assertCurrentRunIsFresh(env, spec);
  const sourceRunId = await verifiedRegisteredSourceRunId(env, spec, options.sourceRunId);
  const latestPriorRunId = await latestPriorRunForPr(env, spec, sourceRunId, options.sourceRunId);
  const reviewResponse = await fetchFn(`${base}/pulls/${spec.prNumber}/reviews?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!reviewResponse.ok) reject('prior_review_state_unavailable');
  const reviews = await reviewResponse.json() as any[];
  if (!Array.isArray(reviews) || reviews.length >= 100 || reviewResponse.headers.get('Link')?.includes('rel="next"')) reject('prior_review_history_incomplete');
  if (blockingReviewerPresent(reviews, spec.headSha)) reject('prior_semantic_block');

  const checkResponse = await fetchFn(`${base}/commits/${encodeURIComponent(spec.headSha)}/check-runs?filter=all&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!checkResponse.ok) reject('prior_check_state_unavailable');
  const checkList = await checkResponse.json() as any;
  const allChecks = checkList.check_runs;
  if (!Array.isArray(allChecks) || checkList.total_count !== allChecks.length || allChecks.length >= 100) reject('prior_check_history_incomplete');
  const controlChecks = allChecks.filter((check: any) => check.name === REVIEW_WORKER_CHECK_NAME || check.name === REVIEW_GATE_CHECK_NAME);
  const currentPair = options.currentPassthroughChecks;
  const currentIds = currentPair ? new Set([currentPair.workerExternalId, currentPair.gateExternalId]) : new Set<string>();
  const ownChecks = controlChecks.filter((check: any) => currentIds.has(String(check.external_id || '')));
  if (currentPair) {
    if (!Number.isSafeInteger(currentPair.appId) || currentPair.appId !== appId
      || !currentPair.workerExternalId || !currentPair.gateExternalId
      || currentPair.workerExternalId === currentPair.gateExternalId) reject('prior_check_identity_unverified');
    for (const check of ownChecks) {
      const expectedName = check.external_id === currentPair.workerExternalId
        ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME;
      if (check.name !== expectedName || check.head_sha !== spec.headSha || Number(check.app?.id) !== appId
        || !Number.isSafeInteger(Number(check.id)) || Number(check.id) <= 0
        || !String(check.output?.summary || '').includes('review-mode=passthrough')) reject('prior_check_identity_unverified');
      const annotations = check.output?.annotations_count;
      if (!Number.isSafeInteger(annotations) || annotations !== 0) reject('prior_check_metadata_unavailable');
      if (check.status !== 'in_progress' && !(check.status === 'completed' && check.conclusion === 'success')) {
        reject('prior_semantic_block');
      }
    }
    for (const externalId of currentIds) {
      if (controlChecks.filter((check: any) => String(check.external_id || '') === externalId).length > 1) {
        reject('prior_check_identity_unverified');
      }
    }
  }
  const checks = controlChecks.filter((check: any) => !currentIds.has(String(check.external_id || '')));
  if (checks.some((check: any) => check.head_sha !== spec.headSha || Number(check.app?.id) !== appId)) reject('prior_check_identity_unverified');
  if (checks.length === 0) {
    if (latestPriorRunId) reject('prior_check_pair_incomplete');
    return [];
  }

  for (const check of checks) {
    const annotationCount = check.output?.annotations_count;
    if (!Number.isSafeInteger(annotationCount) || annotationCount < 0) reject('prior_check_metadata_unavailable');
    if (annotationCount > 0) reject('prior_semantic_findings');
    if (check.status !== 'completed') reject('prior_review_active');
    if (check.conclusion !== 'success' && check.conclusion !== 'failure') reject('prior_outcome_unknown');
  }

  const workers = checks.filter((check: any) => check.name === REVIEW_WORKER_CHECK_NAME);
  const gates = checks.filter((check: any) => check.name === REVIEW_GATE_CHECK_NAME);
  if (workers.length !== gates.length) reject('prior_check_pair_incomplete');
  if (latestPriorRunId && !workers.some((worker: any) => String(worker.external_id || '').startsWith(`${latestPriorRunId}:a`))) reject('prior_check_pair_incomplete');
  const usedGates = new Set<number>();
  const allowedTransportRunIds: string[] = [];
  for (const worker of workers) {
    const match = String(worker.external_id || '').match(/^(run_[A-Za-z0-9_-]{1,128}):a([1-9][0-9]*)(:review-mode=passthrough:op2)?$/u);
    if (!match) reject('prior_check_identity_unverified');
    const runId = match[1];
    const attempt = Number(match[2]);
    const passthroughSuffix = match[3] || '';
    const expectedWorkerExternalId = deriveWorkerExternalId(runId, attempt);
    if (worker.external_id !== `${expectedWorkerExternalId}${passthroughSuffix}`) reject('prior_check_identity_unverified');
    const gateBaseExternalId = await deriveGateExternalId({ owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId, executionAttempt: attempt });
    const gateExternalId = `${gateBaseExternalId}${passthroughSuffix}`;
    const matchingGates = gates.filter((gate: any) => gate.external_id === gateExternalId);
    if (matchingGates.length !== 1) reject('prior_check_pair_incomplete');
    const gate = matchingGates[0];
    usedGates.add(Number(gate.id));

    if (passthroughSuffix === ':review-mode=passthrough:op2'
      && (!String(worker.output?.summary || '').includes('review-mode=passthrough')
        || !String(gate.output?.summary || '').includes('review-mode=passthrough'))) {
      reject('prior_check_identity_unverified');
    }

    if (worker.conclusion === 'success' && gate.conclusion === 'success') {
      const status = await priorDoStatus(env, spec, runId);
      const receipt = status.terminalReceiptSummary;
      if (status.phase !== 'Completed' || receipt?.status !== 'succeeded' || !SAFE_SUCCESS_VERDICTS.has(receipt?.verdict) || receipt?.findingsCount !== 0) reject('prior_semantic_outcome_unknown');
      continue;
    }

    if (worker.conclusion === 'failure' && gate.conclusion === 'failure' && await isExactPreDispatchFailure(env, spec, runId, attempt)) {
      allowedTransportRunIds.push(runId);
      continue;
    }
    reject('prior_semantic_block');
  }
  if (usedGates.size !== gates.length) reject('prior_check_pair_incomplete');
  return allowedTransportRunIds;
}
