import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import {
  INCOMPLETE_INFRASTRUCTURE_REASON,
  infrastructureRetryDelayMs,
  isInfrastructureIncompleteResult,
  laneProviderStatus,
  renderIncompleteInfrastructureTitle,
} from '../../src/review/publicationFailurePolicy';
import {
  AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT,
  requeueAuthoritativeInfrastructureIncomplete,
  type RunRetryContext,
} from '../../src/review/recoverablePanelRetry';
import { buildReviewRunIdentity, deriveReviewRunId } from '../../src/review/reviewAdmission';
import { isRecoverableFailureTitle, MAX_CHECK_RUN_TITLE_CHARACTERS } from '../../src/review/reviewCheckIdentity';
import type { WorkerReviewCompletion, WorkerReviewResult } from '../../src/review/workerReviewCompletion';
import { logger } from '../../src/utils/logger';

const NOW = Date.parse('2026-09-24T18:28:53.000Z');
const identity = buildReviewRunIdentity({ owner: 'calltelemetry', repo: 'ct-meta', prNumber: 3446,
  headSha: '6b560284'.padEnd(40, '0'), baseSha: 'c'.repeat(40) });
const RUN_ID = deriveReviewRunId(identity);
const EXPECTED_APP_ID = 777;

/** The ct-meta#3446 result: 2 lanes, 1 completed clean, 1 lost to a gateway 502, 0 findings. */
function infraResult(overrides: Partial<WorkerReviewResult> = {}): WorkerReviewResult {
  return {
    version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T18:28:50.000Z',
    personas: [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'arch-lane', decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'provider_error' },
    ],
    coverageComplete: true, quorumSatisfied: false,
    failureDiagnostics: { reason: INCOMPLETE_INFRASTRUCTURE_REASON, providerStatus: 502,
      logTail: 'lanes did not complete: arch-lane=provider_error/502', recoverableIncompletePanel: true },
    ...overrides,
  };
}

function completion(result: WorkerReviewResult = infraResult(), executionAttempt = 1): WorkerReviewCompletion {
  return { version: 'WorkerReviewCompletion.v1', runId: RUN_ID, repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta',
    prNumber: 3446, headSha: identity.headSha, baseSha: identity.baseSha,
    policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), executionAttempt, result };
}

const prepared = { policy: { effectivePolicyDigest: 'd'.repeat(64) } } as never;

function harness(context: Partial<RunRetryContext> | null = {}) {
  const readRunRetryContext = vi.fn(async () => (context === null ? null : {
    publicationMode: 'app-gate' as const, authoritativeGateAppId: EXPECTED_APP_ID, repositoryId: 123, installationId: 55,
    identity, runStatus: 'failed', errorText: AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT, ...context,
  }));
  const admit = vi.fn(async () => ({}) as never);
  const resolve = vi.fn(async () => ({ identity, prepared }));
  const logs = { error: vi.fn(), info: vi.fn() };
  return {
    readRunRetryContext, admit, resolve, logs,
    run: (event: WorkerReviewCompletion) => requeueAuthoritativeInfrastructureIncomplete({
      event, now: NOW, repository: { admit, readRunRetryContext },
      authoritative: { expectedAppId: EXPECTED_APP_ID, repositoryIds: [123], resolver: { resolve } as never }, logger: logs,
    }),
  };
}

describe('REL-1113 shared infrastructure-incomplete decision', () => {
  it('accepts the #3446 shape', () => {
    expect(isInfrastructureIncompleteResult(infraResult())).toBe(true);
  });

  it.each([
    ['a finding on the completed lane (findings BLOCK stays BLOCK)', infraResult({ personas: [
      { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [{ severity: 'P1', path: 'a.ts', line: 1, title: 't', body: 'b' }] },
      { id: 'arch-lane', decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'provider_error' }] })],
    ['a non-infrastructure failed lane', infraResult({ personas: [
      { id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
      { id: 'arch-lane', decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'malformed_output' }] })],
    ['no failed lane at all', infraResult({ personas: [{ id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] }] })],
    ['incomplete coverage (deterministic)', infraResult({ coverageComplete: false })],
    ['a satisfied quorum', infraResult({ quorumSatisfied: true })],
    ['no worker marker', infraResult({ failureDiagnostics: undefined })],
    ['a different diagnostic reason', infraResult({ failureDiagnostics: { reason: 'provider_5xx', logTail: 'x', recoverableIncompletePanel: true } })],
    ['the marker without the recoverable bit', infraResult({ failureDiagnostics: { reason: INCOMPLETE_INFRASTRUCTURE_REASON, logTail: 'x' } })],
  ])('refuses %s', (_label, result) => {
    expect(isInfrastructureIncompleteResult(result)).toBe(false);
  });

  it('ignores shadow lanes for the failure shape but never lets a gating finding through', () => {
    const withShadowError = infraResult();
    withShadowError.personas.push({ id: 'shadow_composed_engine', decision: 'ERROR', status: 'ERROR', findings: [],
      errorClass: 'malformed_output', evidenceSource: 'shadow' });
    expect(isInfrastructureIncompleteResult(withShadowError)).toBe(true);
  });

  it('extracts only a numeric provider status from free-form lane errors', () => {
    expect(laneProviderStatus('bifrost: gateway-internal.calltelemetry.com HTTP 502: <html>nginx</html>')).toBe(502);
    expect(laneProviderStatus('OpenRouter SDK connection failure for model pr-reviewer: terminated')).toBeUndefined();
    expect(laneProviderStatus('HTTP 200 fine')).toBeUndefined();
  });

  it('renders a bounded, recoverable INCOMPLETE title that never names a verdict', () => {
    const one = renderIncompleteInfrastructureTitle([{ id: 'arch-lane', failureClass: 'provider_error', providerStatus: 502 }]);
    expect(one).toBe('Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502)');
    const retrying = renderIncompleteInfrastructureTitle([{ id: 'arch-lane', failureClass: 'transport' }], { nextAttempt: 2, maxAttempts: 3 });
    expect(retrying).toBe('Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: transport); retrying as attempt 2 of 3');
    const many = renderIncompleteInfrastructureTitle(
      Array.from({ length: 6 }, (_, index) => ({ id: `very-long-reviewer-lane-name-${index}`, failureClass: 'provider_error', providerStatus: 503 })),
      { nextAttempt: 3, maxAttempts: 3 });
    for (const title of [one, retrying, many]) {
      expect(title.length).toBeLessThanOrEqual(MAX_CHECK_RUN_TITLE_CHARACTERS);
      expect(title).not.toMatch(/BLOCK|FIX_FIRST|SHIP/u);
      // Keeps the exact-head re-run action on the exhausted check.
      expect(isRecoverableFailureTitle(title)).toBe(true);
    }
    expect(isRecoverableFailureTitle('Review Yeti: BLOCK')).toBe(false);
  });

  it('grows the re-attempt delay per attempt, capped', () => {
    expect(infrastructureRetryDelayMs(1)).toBe(30_000);
    expect(infrastructureRetryDelayMs(2)).toBe(60_000);
    expect(infrastructureRetryDelayMs(20)).toBe(300_000);
  });
});

describe('REL-1113 authoritative infrastructure re-attempt', () => {
  it('#3446 shape: re-admits the exact head as the next execution attempt through the recovery path', async () => {
    const h = harness();
    await expect(h.run(completion())).resolves.toBe('requeued');
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith({ repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta',
      prNumber: 3446, headSha: identity.headSha, baseSha: identity.baseSha });
    expect(h.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deliveryId: `internal-infrastructure-incomplete-retry:${RUN_ID}:a1`,
      eventName: 'internal_infrastructure_incomplete_retry',
      repositoryId: 123, installationId: 55, publicationMode: 'app-gate', centralActionDispatch: false,
      retryRequested: true, retryAfterExecutionAttempt: 1, availableAt: NOW + 30_000, identity,
      authoritativeGate: { expectedAppId: EXPECTED_APP_ID, prepared },
    }));
  });

  it('attempts exhausted: no re-admission (the INCOMPLETE check stands)', async () => {
    const h = harness();
    await expect(h.run(completion(infraResult(), 3))).resolves.toBe('attempts-exhausted');
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('never re-rolls a findings BLOCK', async () => {
    const h = harness();
    const result = infraResult({ personas: [
      { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [{ severity: 'P0', path: 'a.ts', line: 1, title: 't', body: 'b' }] },
      { id: 'arch-lane', decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'provider_error' }] });
    await expect(h.run(completion(result))).resolves.toBe('not-infrastructure-incomplete');
    expect(h.readRunRetryContext).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it.each([
    ['the service recorded a different decision', { errorText: 'review gate: invalid-evidence' }],
    ['the run did not fail', { runStatus: 'succeeded' }],
    ['a legacy (non-authoritative) run', { authoritativeGateAppId: null }],
    ['another App identity', { authoritativeGateAppId: 1 }],
  ])('refuses when %s', async (_label, context) => {
    const h = harness(context);
    await expect(h.run(completion())).resolves.toBe('run-not-infrastructure-failure');
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('refuses when the pull request moved (a superseded head is never re-reviewed)', async () => {
    const h = harness();
    h.resolve.mockResolvedValue({ identity: buildReviewRunIdentity({ owner: 'calltelemetry', repo: 'ct-meta', prNumber: 3446,
      headSha: 'f'.repeat(40), baseSha: identity.baseSha }), prepared });
    await expect(h.run(completion())).resolves.toBe('candidate-changed');
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('logs and swallows an admission failure', async () => {
    const h = harness();
    h.admit.mockRejectedValue(new Error('lock timeout'));
    await expect(h.run(completion())).resolves.toBe('admission-failed');
    expect(h.logs.error).toHaveBeenCalledWith('Automatic infrastructure-incomplete retry admission failed',
      expect.objectContaining({ runId: RUN_ID, reasonClass: 'incomplete_infra' }));
  });
});

describe('REL-1113 completion API wiring', () => {
  function app(recordStatus: 'recorded' | 'duplicate') {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const recordWorkerResult = vi.fn().mockResolvedValue(recordStatus);
    const retryAdmit = vi.fn(async () => ({}) as never);
    const readRunRetryContext = vi.fn(async () => ({ publicationMode: 'app-gate' as const, authoritativeGateAppId: EXPECTED_APP_ID,
      repositoryId: 123, installationId: 55, identity, runStatus: 'failed', errorText: AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT }));
    const resolve = vi.fn(async () => ({ identity, prepared }));
    const server = express();
    server.use(express.json({ limit: 1_000_000, strict: true }));
    server.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify: vi.fn() }, admission: { admit: vi.fn() }, resolveInstallationId: vi.fn(), now: () => NOW,
      authoritativePublishing: { expectedAppId: EXPECTED_APP_ID, repositoryIds: [123], resolver: { resolve } } as never,
      authoritativeWorkerCompletion: { verifier: { verify: vi.fn(async () => ({ workerTokenDigest: 'f'.repeat(64) })) },
        repository: { recordWorkerResult }, resolve: vi.fn() } as never,
      workerCompletion: { verifier: { verify: vi.fn() }, repository: { markWorkerFailure: vi.fn(), markWorkerSuccess: vi.fn(),
        authorizeWorkerEvidence: vi.fn(), admit: retryAdmit, readRunRetryContext } } as never,
    }));
    return { server, retryAdmit, recordWorkerResult };
  }

  it('acknowledges the recorded completion, then re-admits the next attempt', async () => {
    const a = app('recorded');
    const response = await request(a.server).post('/api/dispatch/completion').auth('ghs_x', { type: 'bearer' }).send(completion());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 'WorkerReviewCompletionAccepted.v1', runId: RUN_ID, status: 'recorded' });
    await vi.waitFor(() => expect(a.retryAdmit).toHaveBeenCalledOnce());
    expect(a.retryAdmit).toHaveBeenCalledWith(expect.objectContaining({ retryRequested: true, retryAfterExecutionAttempt: 1 }));
  });

  it('never re-admits on a duplicate delivery', async () => {
    const a = app('duplicate');
    const response = await request(a.server).post('/api/dispatch/completion').auth('ghs_x', { type: 'bearer' }).send(completion());
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.retryAdmit).not.toHaveBeenCalled();
  });
});
