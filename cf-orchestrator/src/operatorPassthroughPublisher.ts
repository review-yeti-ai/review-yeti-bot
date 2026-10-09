import type { DurableObjectStub } from '@cloudflare/workers-types';
import type { Env, ReviewRunSpec } from './types.js';
import { isPilotRepository } from './pilotRepository.js';
import { assertNoBlockingPriorOutcome } from './operatorPriorOutcome.js';
import {
  completeChecks, createPendingChecks, deriveGateExternalId, deriveWorkerExternalId,
  getInstallationToken, REVIEW_GATE_CHECK_NAME, REVIEW_WORKER_CHECK_NAME,
} from './github/index.js';

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40}$/iu;
const FAILURE_CODES = new Set([
  'pause_binding_unavailable', 'policy_not_current', 'invalid_pr_identity', 'publication_disabled',
  'current_pr_unavailable', 'current_head_mismatch', 'durable_state_unavailable',
  'app_identity_unavailable', 'check_publication_unavailable', 'check_identity_unverified',
  'audit_unavailable', 'check_readback_unavailable', 'check_summary_unverified',
  'prior_review_state_unavailable', 'prior_review_history_incomplete', 'prior_semantic_block',
  'prior_check_state_unavailable', 'prior_check_history_incomplete', 'prior_check_identity_unverified',
  'prior_check_metadata_unavailable', 'prior_semantic_findings', 'prior_review_active',
  'prior_outcome_unknown', 'prior_check_pair_incomplete', 'prior_semantic_outcome_unknown',
  'prior_do_unavailable', 'prior_do_identity_mismatch',
]);
const WORKER_SUMMARY = 'Operator passthrough: SHIP; no semantic review was performed; zero lanes were started.';
const GATE_TITLE = 'Review Yeti Gate: Operator Passthrough (SHIP)';
const GATE_SUMMARY = 'Current, audited operator passthrough. No semantic review was run; zero lanes were started.';
const FAILURE_SUMMARY = 'Operator passthrough publication is unavailable. No semantic review was run; merge eligibility is false.';

function reject(code: string): never { throw new Error(code); }

async function sha256(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function writeReceipt(runDO: DurableObjectStub, receipt: Record<string, unknown>): Promise<boolean> {
  const response = await runDO.fetch('http://do/receipt', { method: 'POST', body: JSON.stringify({ receipt, epoch: 1 }) });
  if (!response.ok) return false;
  return (await response.json() as { accepted?: boolean }).accepted === true;
}

async function currentBaseRef(env: Env, spec: ReviewRunSpec, token: string): Promise<string> {
  if (env.OPERATOR_GLOBAL_PASSTHROUGH !== 'true') reject('pause_binding_unavailable');
  if (!isPilotRepository(`${spec.owner}/${spec.repo}`, env.PILOT_REPOSITORIES)) reject('policy_not_current');
  if (!SAFE_NAME.test(spec.owner) || !SAFE_NAME.test(spec.repo) || !Number.isSafeInteger(spec.prNumber) || spec.prNumber < 1 || !SHA.test(spec.headSha) || !SHA.test(spec.baseSha)) reject('invalid_pr_identity');
  if (spec.publicationMode === 'disabled') reject('publication_disabled');
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repo)}/pulls/${spec.prNumber}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!response.ok) reject('current_pr_unavailable');
  const pr = await response.json() as any;
  if (pr.state !== 'open' || pr.draft !== false || pr.head?.sha !== spec.headSha || pr.base?.sha !== spec.baseSha || typeof pr.base?.ref !== 'string' || !pr.base.ref) reject('current_head_mismatch');
  return pr.base.ref;
}

async function checkRun(
  owner: string, repo: string, token: string,
  expected: { id: number; appId: number; name: string; externalId: string; headSha: string; status: string; conclusion?: string; passthrough?: boolean }
): Promise<any> {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${expected.id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'review-yeti-cf-orchestrator' },
  });
  if (!response.ok) reject('check_readback_unavailable');
  const check = await response.json() as any;
  if (Number(check.id) !== expected.id || Number(check.app?.id) !== expected.appId || check.name !== expected.name || check.head_sha !== expected.headSha || check.external_id !== expected.externalId || check.status !== expected.status || (expected.conclusion !== undefined && check.conclusion !== expected.conclusion)) reject('check_identity_unverified');
  if (expected.passthrough) {
    const summary = String(check.output?.summary || '').toLowerCase();
    if (!summary.includes('operator passthrough') || !summary.includes('no semantic review') || !summary.includes('zero lanes')) reject('check_summary_unverified');
  }
  return check;
}

function unavailableReceipt(spec: ReviewRunSpec, code: string, workerCheckId?: number, gateCheckId?: number, preparedDigest?: string, priorControlRunIds: string[] = []) {
  return {
    version: 'OperatorPassthroughReceipt.v1', status: 'failed', reason: 'operator_global_passthrough', errorCode: code,
    operatorPassthrough: true, runId: spec.runId, candidateState: 'unavailable', verdict: 'unavailable',
    reviewStarted: false, expectedLanes: 0, completedLanes: 0, publicationState: 'unavailable',
    publicationReceiptAvailable: false, publicationId: spec.runId, workerCheckId: workerCheckId ?? null,
    gateCheckId: gateCheckId ?? null, checksTerminalized: false, mergeEligible: false,
    preparedAuditDigest: preparedDigest ?? null, priorControlRunIds,
    owner: spec.owner, repo: spec.repo, prNumber: spec.prNumber, headSha: spec.headSha, baseSha: spec.baseSha,
    recordedAt: new Date().toISOString(),
  };
}

export async function publishOperatorPassthrough(env: Env, spec: ReviewRunSpec): Promise<Record<string, unknown>> {
  let runDO: DurableObjectStub | undefined;
  let token: string | null = null;
  let appId: number | undefined;
  let workerCheckId: number | undefined;
  let gateCheckId: number | undefined;
  let preparedDigest: string | undefined;
  let priorControlRunIds: string[] = [];
  let errorCode = 'publication_unavailable';
  try {
    runDO = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(spec.runId));
    const initialized = await runDO.fetch('http://do/init', { method: 'POST', body: JSON.stringify(spec) });
    if (!initialized.ok) reject('durable_state_unavailable');
    if (env.OPERATOR_GLOBAL_PASSTHROUGH !== 'true') reject('pause_binding_unavailable');

    errorCode = 'app_identity_unavailable';
    appId = Number(env.GITHUB_APP_ID);
    if (!Number.isSafeInteger(appId) || appId <= 0) reject(errorCode);
    token = await getInstallationToken(env, spec.owner, spec.repo, spec.installationId);
    if (!token || token.startsWith('ghs_dummy_') || token.startsWith('ghs_ephemeral_')) reject(errorCode);

    errorCode = 'current_pr_unavailable';
    const baseRef = await currentBaseRef(env, spec, token);
    errorCode = 'prior_check_state_unavailable';
    priorControlRunIds = await assertNoBlockingPriorOutcome(env, spec, token, appId);
    errorCode = 'check_publication_unavailable';
    const pending = await createPendingChecks({ owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId: spec.runId, token, executionAttempt: 1 });
    workerCheckId = pending.workerCheckId;
    gateCheckId = pending.gateCheckId;
    if (pending.errors?.length || !workerCheckId || !gateCheckId) reject(errorCode);

    errorCode = 'check_identity_unverified';
    const workerExternalId = deriveWorkerExternalId(spec.runId, 1);
    const gateExternalId = await deriveGateExternalId({ owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId: spec.runId, executionAttempt: 1 });
    await checkRun(spec.owner, spec.repo, token, { id: workerCheckId, appId, name: REVIEW_WORKER_CHECK_NAME, externalId: workerExternalId, headSha: spec.headSha, status: 'in_progress' });
    await checkRun(spec.owner, spec.repo, token, { id: gateCheckId, appId, name: REVIEW_GATE_CHECK_NAME, externalId: gateExternalId, headSha: spec.headSha, status: 'in_progress' });

    const prepared = {
      version: 'OperatorPassthroughReceipt.v1', state: 'prepared', reason: 'operator_global_passthrough', operatorPassthrough: true,
      runId: spec.runId, owner: spec.owner, repo: spec.repo, prNumber: spec.prNumber, headSha: spec.headSha, baseSha: spec.baseSha,
      baseRef, appId, workerCheckId, gateCheckId, reviewStarted: false, expectedLanes: 0, completedLanes: 0,
      policy: { pilotRepositoryAllowed: true, pauseSource: 'deployment' }, priorControlRunIds,
      currentHeadVerifiedAt: new Date().toISOString(),
    };
    preparedDigest = await sha256(prepared);
    const preparedEvent = await runDO.fetch('http://do/events', {
      method: 'POST', body: JSON.stringify({ type: 'operator_passthrough_prepared', data: { ...prepared, auditDigest: preparedDigest } }),
    });
    if (!preparedEvent.ok || (await preparedEvent.json() as { ok?: boolean }).ok !== true) reject('audit_unavailable');

    errorCode = 'current_head_mismatch';
    if (await currentBaseRef(env, spec, token) !== baseRef) reject(errorCode);
    errorCode = 'check_publication_unavailable';
    const completed = await completeChecks({
      owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId: spec.runId, token, verdict: 'success',
      summaryMarkdown: `${WORKER_SUMMARY}\n\nPublication ID: ${spec.runId}\nPrepared audit digest: ${preparedDigest}`,
      workerTitle: 'Review Yeti: Operator Passthrough (SHIP)',
      gateTitle: GATE_TITLE,
      gateSummary: `${GATE_SUMMARY}\nPublication ID: ${spec.runId}\nPrepared audit digest: ${preparedDigest}`,
      findings: [],
      workerCheckId, gateCheckId, executionAttempt: 1,
    });
    if (completed.errors?.length || completed.workerCheckId !== workerCheckId || completed.gateCheckId !== gateCheckId) reject(errorCode);

    errorCode = 'check_readback_unavailable';
    const worker = await checkRun(spec.owner, spec.repo, token, { id: workerCheckId, appId, name: REVIEW_WORKER_CHECK_NAME, externalId: workerExternalId, headSha: spec.headSha, status: 'completed', conclusion: 'success', passthrough: true });
    const gate = await checkRun(spec.owner, spec.repo, token, { id: gateCheckId, appId, name: REVIEW_GATE_CHECK_NAME, externalId: gateExternalId, headSha: spec.headSha, status: 'completed', conclusion: 'success', passthrough: true });

    errorCode = 'current_head_mismatch';
    if (await currentBaseRef(env, spec, token) !== baseRef) reject(errorCode);
    errorCode = 'audit_unavailable';
    const audit = {
      ...prepared, state: 'published', publicationState: 'published', publicationReceiptAvailable: true,
      candidateState: 'current', verdict: 'SHIP', mergeEligible: true,
      currentHeadVerifiedAt: new Date().toISOString(),
      checks: {
        worker: { id: worker.id, appId: Number(worker.app.id), name: worker.name, headSha: worker.head_sha, externalId: worker.external_id, status: worker.status, conclusion: worker.conclusion },
        gate: { id: gate.id, appId: Number(gate.app.id), name: gate.name, headSha: gate.head_sha, externalId: gate.external_id, status: gate.status, conclusion: gate.conclusion },
      },
    };
    const auditDigest = await sha256(audit);
    const receipt = {
      ...audit,
      status: 'succeeded',
      publicationId: spec.runId,
      auditDigest,
      preparedAuditDigest: preparedDigest,
      recordedAt: new Date().toISOString(),
    };
    if (!(await writeReceipt(runDO, receipt))) reject(errorCode);
    return {
      runId: spec.runId, status: 'succeeded', verdict: 'SHIP', publicationState: 'published',
      publicationReceiptAvailable: true, reviewStarted: false, expectedLanes: 0, completedLanes: 0,
      workerCheckId, gateCheckId, auditDigest, preparedAuditDigest: preparedDigest, priorControlRunIds,
      mergeEligible: true,
    };
  } catch (error) {
    if (error instanceof Error && FAILURE_CODES.has(error.message)) errorCode = error.message;
    let checksTerminalized = false;
    if (runDO && token && appId && (workerCheckId || gateCheckId)) {
      try {
        const failed = await completeChecks({
          owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId: spec.runId, token, verdict: 'failure',
          summaryMarkdown: `${FAILURE_SUMMARY}\nPublication ID: ${spec.runId}${preparedDigest ? `\nPrepared audit digest: ${preparedDigest}` : ''}`,
          workerTitle: 'Review Yeti: Operator Passthrough Unavailable',
          gateTitle: 'Review Yeti Gate: Operator Passthrough Unavailable',
          gateSummary: `${FAILURE_SUMMARY}\nPublication ID: ${spec.runId}${preparedDigest ? `\nPrepared audit digest: ${preparedDigest}` : ''}`,
          findings: [], workerCheckId, gateCheckId, executionAttempt: 1,
        });
        workerCheckId = failed.workerCheckId ?? workerCheckId;
        gateCheckId = failed.gateCheckId ?? gateCheckId;
        if (!failed.errors?.length && workerCheckId && gateCheckId) {
          const workerExternalId = deriveWorkerExternalId(spec.runId, 1);
          const gateExternalId = await deriveGateExternalId({ owner: spec.owner, repo: spec.repo, headSha: spec.headSha, runId: spec.runId, executionAttempt: 1 });
          await checkRun(spec.owner, spec.repo, token, { id: workerCheckId, appId, name: REVIEW_WORKER_CHECK_NAME, externalId: workerExternalId, headSha: spec.headSha, status: 'completed', conclusion: 'failure' });
          await checkRun(spec.owner, spec.repo, token, { id: gateCheckId, appId, name: REVIEW_GATE_CHECK_NAME, externalId: gateExternalId, headSha: spec.headSha, status: 'completed', conclusion: 'failure' });
          checksTerminalized = true;
        }
      } catch {
        // Failed readback remains unavailable and merge-ineligible.
      }
    }
    const receipt = unavailableReceipt(spec, errorCode, workerCheckId, gateCheckId, preparedDigest, priorControlRunIds);
    receipt.checksTerminalized = checksTerminalized;
    if (runDO) {
      try { await writeReceipt(runDO, receipt); } catch { /* keep the caller fail-closed */ }
    }
    return { runId: spec.runId, status: 'unavailable', verdict: 'unavailable', publicationState: 'unavailable', publicationReceiptAvailable: false, reviewStarted: false, expectedLanes: 0, completedLanes: 0, workerCheckId: workerCheckId ?? null, gateCheckId: gateCheckId ?? null, errorCode, checksTerminalized, mergeEligible: false };
  }
}
