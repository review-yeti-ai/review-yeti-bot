import type { Env, ReviewRunSpec } from './types.js';
import { deriveGateExternalId, deriveWorkerExternalId, REVIEW_GATE_CHECK_NAME, REVIEW_WORKER_CHECK_NAME } from './github/index.js';
import { reviewRunSpecDigest } from './reviewRunIdentity.js';

const PRE_DISPATCH_CONFIG_ERROR = 'Step config for "dispatch-container" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/';
const SAFE_SUCCESS_VERDICTS = new Set(['SHIP', 'success']);
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

async function latestPriorRunForPr(env: Env, spec: ReviewRunSpec, sourceRunId?: string | null): Promise<string | null> {
  const repoKey = `${spec.owner}/${spec.repo}`.toLowerCase();
  const gate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
  const response = await gate.fetch(`http://do/active-run/${spec.prNumber}`);
  if (!response.ok) reject('prior_queue_state_unavailable');
  const state = await response.json() as { activeRunId?: string | null; latestRunId?: string | null };
  if (state.activeRunId && state.activeRunId !== spec.runId && state.activeRunId !== sourceRunId) reject('prior_review_active');
  const latestRunId = state.latestRunId;
  if (!latestRunId || latestRunId === '__EVICTED__' || latestRunId === spec.runId || latestRunId === sourceRunId) return null;

  const prior = await readDoStatus(env, latestRunId);
  if (prior.phase === 'Pending' || prior.phase === 'Running') reject('prior_review_active');
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
  const latestPriorRunId = await latestPriorRunForPr(env, spec, sourceRunId);
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
