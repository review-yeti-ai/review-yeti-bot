import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  createActionDispatchRouter,
  createWorkerCompletionVerifier,
  type ActionDispatchRouterOptions,
  type WorkerCompletionVerifier,
} from '../../src/api/actionDispatchApi';
import type { WorkerCompletionProof } from '../../src/review/workerCompletion';
import type { WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { logger } from '../../src/utils/logger';

const ENDPOINT = '/api/dispatch/completion';
const TOKEN = 'ghs_fake-worker-completion-credential';
const PRIVATE_DETAIL = 'private-provider-body-do-not-return';
const NOW = Date.parse('2026-09-09T12:00:01.000Z');
type CompletionHandler = NonNullable<ActionDispatchRouterOptions['authoritativeWorkerCompletion']>;

function event(): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', runId: `run_${'a'.repeat(32)}`,
    repositoryId: 123, owner: 'calltelemetry', repo: 'example', prNumber: 42,
    headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
    policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), executionAttempt: 2,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T12:00:00.000Z',
      coverageComplete: true, quorumSatisfied: true,
      personas: [{ id: 'security', decision: 'FINDINGS', status: 'COMPLETE', findings: [{
        severity: 'P2', path: 'src/example.ts', line: 2, startLine: 1,
        title: 'Validate input', body: 'The input needs validation.',
        suggestion: null, replacementCode: null, confidence: 90,
        recommendation: 'Validate before use.', isArchitectural: false,
        fixOptions: [{ rank: 1, title: 'Guard', explanation: 'Reject invalid input.', suggestionCode: 'validate(input);' }],
      }] }],
      verdict: 'FIX_FIRST', findingCount: 1, blockingFindingCount: 1,
    },
  };
}

function fixture({ authoritative = true, legacy = true } = {}) {
  const proof: WorkerCompletionProof = { workerTokenDigest: 'f'.repeat(64) };
  const verify = vi.fn<WorkerCompletionVerifier['verify']>().mockResolvedValue(proof);
  const recordWorkerResult = vi.fn<CompletionHandler['repository']['recordWorkerResult']>().mockResolvedValue('recorded');
  const resolve = vi.fn<CompletionHandler['resolve']>();
  const legacyVerify = vi.fn<WorkerCompletionVerifier['verify']>().mockResolvedValue(proof);
  const markWorkerFailure = vi.fn().mockResolvedValue({ runId: event().runId, status: 'failed' });
  const markWorkerSuccess = vi.fn().mockResolvedValue({ runId: event().runId, status: 'succeeded' });
  const oidcVerify = vi.fn();
  const admit = vi.fn();
  const resolveInstallationId = vi.fn();
  const now = vi.fn(() => NOW);
  const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const app = express();
  app.use(express.json({ limit: 1_000_000, strict: true }));
  app.use('/api/dispatch', createActionDispatchRouter({
    verifier: { verify: oidcVerify }, admission: { admit }, resolveInstallationId, now,
    authoritativeWorkerCompletion: authoritative ? { verifier: { verify }, repository: { recordWorkerResult }, resolve } : undefined,
    workerCompletion: legacy ? { verifier: { verify: legacyVerify }, repository: { markWorkerFailure, markWorkerSuccess } } : undefined,
  }));
  return { app, proof, verify, recordWorkerResult, resolve, now, legacyVerify, markWorkerFailure, markWorkerSuccess,
    oidcVerify, admit, resolveInstallationId, errorLog, warnLog };
}

function expectNoPersistence(f: ReturnType<typeof fixture>) {
  expect(f.recordWorkerResult).not.toHaveBeenCalled();
  expect(f.markWorkerFailure).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
}

describe('authoritative worker completion API', () => {
  it.each(['recorded', 'duplicate', 'ignored'] as const)('returns the exact %s receipt and forwards trusted arguments', async (status) => {
    const f = fixture();
    f.recordWorkerResult.mockResolvedValue(status);
    const payload = event();
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 'WorkerReviewCompletionAccepted.v1', runId: payload.runId, status });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith(TOKEN, payload);
    expect(f.recordWorkerResult).toHaveBeenCalledExactlyOnceWith(payload, f.proof, f.resolve, NOW);
    const [forwardedEvent, forwardedProof, forwardedResolver] = f.recordWorkerResult.mock.calls[0];
    expect(forwardedEvent).toBe(f.verify.mock.calls[0][1]);
    expect(forwardedProof).toBe(f.proof);
    expect(forwardedResolver).toBe(f.resolve);
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(f.resolve).not.toHaveBeenCalled();
    for (const unrelated of [f.oidcVerify, f.admit, f.resolveInstallationId, f.legacyVerify, f.markWorkerFailure]) {
      expect(unrelated).not.toHaveBeenCalled();
    }
  });

  it('waits for authentication before reading the clock or entering persistence', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const authenticated = Promise.withResolvers<WorkerCompletionProof>();
    f.verify.mockImplementation(() => { entered.resolve(); return authenticated.promise; });
    const responsePromise = request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(event()).then((response) => response);
    await entered.promise;
    try {
      expectNoPersistence(f);
    } finally {
      authenticated.resolve(f.proof);
    }
    expect((await responsePromise).status).toBe(200);
    expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'Basic secret', 'Bearer', 'Bearer one two'])('rejects a missing or malformed bearer (%s)', async (authorization) => {
    const f = fixture();
    const pending = request(f.app).post(ENDPOINT);
    if (authorization !== undefined) pending.set('Authorization', authorization);
    const response = await pending.send(event());
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Worker installation bearer token is required' });
    expect(f.verify).not.toHaveBeenCalled();
    expectNoPersistence(f);
  });

  it('returns a redacted 403 for verifier rejection without entering persistence', async () => {
    const f = fixture();
    f.verify.mockRejectedValue(new Error(`${TOKEN} ${PRIVATE_DETAIL}`));
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(event());
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Worker completion is not authorized' });
    expectNoPersistence(f);
    expect(JSON.stringify([f.errorLog.mock.calls, f.warnLog.mock.calls])).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify([f.errorLog.mock.calls, f.warnLog.mock.calls])).not.toContain(TOKEN);
  });

  it('does not trust an installation-token shape when persistence rejects its binding', async () => {
    const f = fixture();
    f.verify.mockImplementation(createWorkerCompletionVerifier().verify);
    f.recordWorkerResult.mockResolvedValue('unauthorized');
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(event());
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Worker completion is not authorized' });
    expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it('returns a redacted 409 for conflicting recorded evidence', async () => {
    const f = fixture();
    f.recordWorkerResult.mockResolvedValue('conflict');
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(event());
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Worker completion conflicts with recorded evidence' });
    expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
  });

  it('returns a redacted 503 on persistence failure without a fallback or retry', async () => {
    const f = fixture();
    f.recordWorkerResult.mockRejectedValue(new Error(`${PRIVATE_DETAIL} ${TOKEN}`));
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(event());
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Worker review completion could not be persisted' });
    expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
    expect(f.markWorkerFailure).not.toHaveBeenCalled();
    expect(f.errorLog).toHaveBeenCalledExactlyOnceWith('Failed to persist authoritative worker completion', {
      reason: 'persistence_unavailable', runId: event().runId,
    });
  });

  it('returns 503 when the optional authoritative handler is absent, without using the legacy handler', async () => {
    const f = fixture({ authoritative: false });
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(event());
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Authoritative worker completion is not configured' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.legacyVerify).not.toHaveBeenCalled();
    expectNoPersistence(f);
  });

  it('accepts strict evidence without optional worker summaries or the legacy handler', async () => {
    const f = fixture({ legacy: false });
    const payload = event();
    delete payload.result.verdict;
    delete payload.result.findingCount;
    delete payload.result.blockingFindingCount;
    delete payload.result.personas[0].status;
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(payload);
    expect(response.status).toBe(200);
    expect(f.recordWorkerResult).toHaveBeenCalledExactlyOnceWith(payload, f.proof, f.resolve, NOW);
  });

  it('keeps legacy terminal failures on their own handler at the shared endpoint', async () => {
    const f = fixture();
    const { result: _result, ...coordinates } = event();
    const payload = { ...coordinates, version: 'WorkerTerminalFailure.v1', failureClass: 'transport', checkId: 8080 };
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 'WorkerTerminalFailureAccepted.v1', runId: payload.runId, status: 'failed' });
    expect(f.legacyVerify).toHaveBeenCalledExactlyOnceWith(TOKEN, payload);
    expect(f.markWorkerFailure).toHaveBeenCalledExactlyOnceWith(payload, f.proof, NOW);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.recordWorkerResult).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  const invalidBodies: Array<[string, (payload: WorkerReviewCompletion) => object]> = [
    ['top-level check selector', (p) => ({ ...p, checkId: 8080 })],
    ['top-level result URL', (p) => ({ ...p, resultUrl: `https://example.invalid/${PRIVATE_DETAIL}` })],
    ['worker-supplied proof', (p) => ({ ...p, workerTokenDigest: 'f'.repeat(64) })],
    ['worker-supplied policy override', (p) => ({ ...p, override: { verdict: 'SHIP' } })],
    ['nested result URL', (p) => ({ ...p, result: { ...p.result, url: `https://example.invalid/${PRIVATE_DETAIL}` } })],
    ['nested check selector', (p) => ({ ...p, result: { ...p.result, checkId: 8080 } })],
    ['GitHub conclusion override', (p) => ({ ...p, result: { ...p.result, conclusion: 'success' } })],
    ['persona provider transcript', (p) => ({ ...p, result: { ...p.result, personas: [{ ...p.result.personas[0], error: PRIVATE_DETAIL }] } })],
    ['finding override', (p) => ({ ...p, result: { ...p.result, personas: [{ ...p.result.personas[0], findings: [{ ...p.result.personas[0].findings[0], checkId: 8080 }] }] } })],
    ['fix-option override', (p) => ({ ...p, result: { ...p.result, personas: [{ ...p.result.personas[0], findings: [{ ...p.result.personas[0].findings[0], fixOptions: [{ rank: 1, verdict: 'SHIP' }] }] }] } })],
    ['missing result', (p) => { const { result: _result, ...rest } = p; return rest; }],
    ['invalid result version', (p) => ({ ...p, result: { ...p.result, version: 'WorkerReviewResult.v2' } })],
    ['invalid timestamp', (p) => ({ ...p, result: { ...p.result, completedAt: PRIVATE_DETAIL } })],
    ['invalid run identity', (p) => ({ ...p, runId: PRIVATE_DETAIL })],
    ['zero repository ID', (p) => ({ ...p, repositoryId: 0 })],
    ['fractional attempt', (p) => ({ ...p, executionAttempt: 1.5 })],
    ['zero attempt', (p) => ({ ...p, executionAttempt: 0 })],
    ['string attempt', (p) => ({ ...p, executionAttempt: '2' })],
    ['unsafe attempt', (p) => ({ ...p, executionAttempt: Number.MAX_SAFE_INTEGER + 1 })],
    ['invalid head', (p) => ({ ...p, headSha: PRIVATE_DETAIL })],
    ['invalid config digest', (p) => ({ ...p, configDigest: PRIVATE_DETAIL })],
    ['string coverage flag', (p) => ({ ...p, result: { ...p.result, coverageComplete: 'true' } })],
    ['metrics-only persona', (p) => ({ ...p, result: { ...p.result, personas: [{ id: 'security', decision: 'APPROVE', findingCount: 0 }] } })],
    ['unclassified error persona', (p) => ({ ...p, result: { ...p.result, personas: [{ id: 'security', decision: 'ERROR', findings: [] }] } })],
    ['error class on complete persona', (p) => ({ ...p, result: { ...p.result, personas: [{ id: 'security', decision: 'APPROVE', errorClass: 'transport', findings: [] }] } })],
  ];

  it.each(invalidBodies)('rejects %s before verification or persistence', async (_name, invalid) => {
    const f = fixture();
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(invalid(event()));
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid worker review completion' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.legacyVerify).not.toHaveBeenCalled();
    expectNoPersistence(f);
    expect(response.text).not.toContain(PRIVATE_DETAIL);
    expect(response.text).not.toContain(TOKEN);
  });

  it.each([{}, [], { ...event(), version: 'WorkerReviewCompletion.v2' }])('rejects an unknown completion envelope without calling either handler', async (payload) => {
    const f = fixture();
    const response = await request(f.app).post(ENDPOINT).auth(TOKEN, { type: 'bearer' }).send(payload);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid worker terminal failure' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.legacyVerify).not.toHaveBeenCalled();
    expectNoPersistence(f);
  });
});
