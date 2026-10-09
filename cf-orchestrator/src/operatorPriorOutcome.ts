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

async function latestPriorRunForPr(env: Env, spec: ReviewRunSpec): Promise<string | null> {
  const repoKey = `${spec.owner}/${spec.repo}`.toLowerCase();
  const gate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
  const response = await gate.fetch(`http://do/active-run/${spec.prNumber}`);
  if (!response.ok) reject('prior_queue_state_unavailable');
  const state = await response.json() as { activeRunId?: string | null; latestRunId?: string | null };
  if (state.activeRunId && state.activeRunId !== spec.runId) reject('prior_review_active');
  const latestRunId = state.latestRunId;
  if (!latestRunId || latestRunId === '__EVICTED__' || latestRunId === spec.runId) return null;

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

export async function assertNoBlockingPriorOutcome(env: Env, spec: ReviewRunSpec, token: string, appId: number): Promise<string[]> {
  const base = `https://api.github.com/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repo)}`;
  await assertCurrentRunIsFresh(env, spec);
  const latestPriorRunId = await latestPriorRunForPr(env, spec);
  const reviewResponse = await fetch(`${base}/pulls/${spec.prNumber}/reviews?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!reviewResponse.ok) reject('prior_review_state_unavailable');
  const reviews = await reviewResponse.json() as any[];
  if (!Array.isArray(reviews) || reviews.length >= 100 || reviewResponse.headers.get('Link')?.includes('rel="next"')) reject('prior_review_history_incomplete');
  if (reviews.some((review) => review.state === 'CHANGES_REQUESTED')) reject('prior_semantic_block');

  const checkResponse = await fetch(`${base}/commits/${encodeURIComponent(spec.headSha)}/check-runs?filter=all&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!checkResponse.ok) reject('prior_check_state_unavailable');
  const checkList = await checkResponse.json() as any;
  const allChecks = checkList.check_runs;
  if (!Array.isArray(allChecks) || checkList.total_count !== allChecks.length || allChecks.length >= 100) reject('prior_check_history_incomplete');
  const checks = allChecks.filter((check: any) => check.name === REVIEW_WORKER_CHECK_NAME || check.name === REVIEW_GATE_CHECK_NAME);
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
    const match = String(worker.external_id || '').match(/^(run_[A-Za-z0-9_-]{1,128}):a([1-9][0-9]*)$/u);
    if (!match) reject('prior_check_identity_unverified');
    const runId = match[1];
    const attempt = Number(match[2]);
    if (worker.external_id !== deriveWorkerExternalId(runId, attempt)) reject('prior_check_identity_unverified');
    const gateExternalId = await deriveGateExternalId({ owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId, executionAttempt: attempt });
    const matchingGates = gates.filter((gate: any) => gate.external_id === gateExternalId);
    if (matchingGates.length !== 1) reject('prior_check_pair_incomplete');
    const gate = matchingGates[0];
    usedGates.add(Number(gate.id));

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
