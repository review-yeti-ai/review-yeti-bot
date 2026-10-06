import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import type { ReviewDispatchRepository, RunStatusResult } from '../../src/persistence/reviewDispatchRepository';
import { WorkerCompletionPersistenceError } from '../../src/review/workerCompletionPersistenceError';
import { AUTHORITATIVE_REVIEW_APP_ID } from '../../src/auth/authoritativeServiceIdentity';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('ActionDispatchApi - GET status endpoint', () => {
  const token = 'test-worker-token-xyz-12345';
  const tokenDigest = sha256Hex(token);

  function createTestApp(options: {
    runStatusResult?: RunStatusResult | null;
    hasRepo?: boolean;
  } = {}) {
    const app = express();
    app.use(express.json());

    const mockRepo: Partial<ReviewDispatchRepository> = {
      getRunStatus: vi.fn(async (runId: string, executionAttempt: number) => {
        if (options.runStatusResult !== undefined) return options.runStatusResult;
        return {
          current: true,
          status: 'running',
          cancelRequested: false,
          cancelReason: undefined,
          currentHeadSha: 'headsha12345',
          isCurrentHead: true,
          workerTokenDigest: tokenDigest,
        };
      }),
    };

    const router = createActionDispatchRouter({
      verifier: { verify: vi.fn() } as any,
      admission: { admit: vi.fn() } as any,
      resolveInstallationId: vi.fn(),
      runStatusRepository: options.hasRepo === false ? undefined : (mockRepo as any),
    });

    app.use('/api/dispatch', router);
    return { app, mockRepo };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/dispatch/runs/run_123/attempts/1/status');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Bearer token is required');
  });

  it('rejects requests with mismatched token digest with 401', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get('/api/dispatch/runs/run_123/attempts/1/status')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects invalid attempt numbers with 400', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get('/api/dispatch/runs/run_123/attempts/invalid/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid run ID or execution attempt');
  });

  it('returns 404 when run is not found', async () => {
    const { app } = createTestApp({ runStatusResult: null });
    const res = await request(app)
      .get('/api/dispatch/runs/run_not_found/attempts/1/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  it('returns 503 when run status repository is not configured', async () => {
    const { app } = createTestApp({ hasRepo: false });
    const res = await request(app)
      .get('/api/dispatch/runs/run_123/attempts/1/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Run status lookup is not configured');
  });

  it('returns authenticated run status with stripped token digest on success', async () => {
    const { app, mockRepo } = createTestApp();
    const res = await request(app)
      .get('/api/dispatch/runs/run_abc123/attempts/2/status')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockRepo.getRunStatus).toHaveBeenCalledWith('run_abc123', 2);
    expect(res.body).toEqual({
      current: true,
      status: 'running',
      cancelRequested: false,
      currentHeadSha: 'headsha12345',
      isCurrentHead: true,
    });
    expect(res.body.workerTokenDigest).toBeUndefined();
  });

  it('returns a durable receipt only to the exact worker token', async () => {
    const receipt = {
      version: 'AppGateReceipt.v1' as const,
      runId: 'run_abc123', executionAttempt: 2, repositoryId: 42,
      owner: 'exampleorg', repo: 'example-meta', prNumber: 3591,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
      digest: `sha256:${'e'.repeat(64)}`,
      evidenceRef: 'audit://review-yeti/run_abc123/attempts/2/completion',
    };
    const { app } = createTestApp({ runStatusResult: {
      current: false, status: 'succeeded', cancelRequested: false,
      isCurrentHead: true, workerTokenDigest: tokenDigest, receipt,
    } });

    const authorized = await request(app)
      .get('/api/dispatch/runs/run_abc123/attempts/2/status')
      .set('Authorization', `Bearer ${token}`);
    expect(authorized.status).toBe(200);
    expect(authorized.body.receipt).toEqual(receipt);
    expect(authorized.body.workerTokenDigest).toBeUndefined();

    const unauthorized = await request(app)
      .get('/api/dispatch/runs/run_abc123/attempts/2/status')
      .set('Authorization', 'Bearer another-worker');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.receipt).toBeUndefined();
  });

  it('returns superseded status when cancelRequested is true', async () => {
    const { app } = createTestApp({
      runStatusResult: {
        current: false,
        status: 'superseded',
        cancelRequested: true,
        cancelReason: 'superseded_by_new_head',
        currentHeadSha: 'newheadsha999',
        isCurrentHead: false,
        workerTokenDigest: tokenDigest,
      },
    });

    const res = await request(app)
      .get('/api/dispatch/runs/run_old/attempts/1/status')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current: false,
      status: 'superseded',
      cancelRequested: true,
      cancelReason: 'superseded_by_new_head',
      currentHeadSha: 'newheadsha999',
      isCurrentHead: false,
    });
  });

  it('supports the /status query-parameter route alias', async () => {
    const { app, mockRepo } = createTestApp();
    const res = await request(app)
      .get('/api/dispatch/status?runId=run_xyz&attempt=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockRepo.getRunStatus).toHaveBeenCalledWith('run_xyz', 3);
  });
});

describe('ActionDispatchApi - paused SHIP projection', () => {
  it('returns truthful SHIP without touching publication storage during paused bootstrap', async () => {
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    const dispatch = {
      version: 'ActionDispatch.v1', deliveryId: `actions:98765:1:123:42:${'a'.repeat(40)}`, repositoryId: 123,
      owner: 'exampleorg', repo: 'example-meta', prNumber: 42,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), actionSha: 'c'.repeat(40), publishMode: 'app-gate',
      requestedAt: new Date(now).toISOString(),
      caller: { runId: '98765', runAttempt: 1, eventName: 'workflow_dispatch' },
    };
    const verify = vi.fn(async () => ({ repository: 'exampleorg/example-meta', repository_id: '123',
      repository_owner_id: '99', run_id: '98765', run_attempt: '1', event_name: 'workflow_dispatch' }));
    const recordOperatorPassthrough = vi.fn();
    const admit = vi.fn();
    const app = express(); app.use(express.json());
    app.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify }, admission: { admit } as any, resolveInstallationId: vi.fn(),
      allowAppGate: true, passthroughEnabled: true, storageInitialized: () => false, now: () => now,
      authoritativePublishing: { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, repositoryIds: [123],
        recordOperatorPassthrough } as any,
    }));

    const response = await request(app).post('/api/dispatch/action').auth('opaque-oidc-token', { type: 'bearer' }).send(dispatch);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: 'ActionDispatchPassthrough.v1', status: 'passthrough',
      reason: 'operator_global_passthrough', candidateState: 'unavailable', verdict: 'SHIP',
      expectedLanes: 0, completedLanes: 0, publicationId: null, auditDigest: null,
      publicationState: 'unavailable', publicationReceiptAvailable: null,
      reviewCheckId: null, gateCheckId: null, mergeEligible: false,
      headSha: null, baseSha: null });
    expect(verify).toHaveBeenCalledOnce();
    expect(recordOperatorPassthrough).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('preserves OIDC-authenticated SHIP with null current authority coordinates after initial authority outage', async () => {
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    const runId = '98765';
    const repositoryId = 123;
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const deliveryId = `actions:${runId}:1:${repositoryId}:42:${headSha}`;
    const dispatch = {
      version: 'ActionDispatch.v1', deliveryId, repositoryId,
      owner: 'exampleorg', repo: 'example-meta', prNumber: 42,
      headSha, baseSha, actionSha: 'c'.repeat(40), publishMode: 'app-gate',
      requestedAt: new Date(now).toISOString(),
      caller: { runId, runAttempt: 1, eventName: 'workflow_dispatch' },
    };
    const claims = { repository: 'exampleorg/example-meta', repository_id: String(repositoryId),
      repository_owner_id: '99', run_id: runId, run_attempt: '1', event_name: 'workflow_dispatch' };
    const verify = vi.fn(async () => claims);
    const admit = vi.fn();
    const recordOperatorPassthrough = vi.fn(async () => ({ status: 'unavailable' as const,
      candidateState: 'unavailable' as const, verdict: 'SHIP' as const, expectedLanes: 0 as const,
      completedLanes: 0 as const, publicationId: null, auditDigest: null,
      publicationState: 'unavailable' as const, publicationReceiptAvailable: null,
      reviewCheckId: null, gateCheckId: null, mergeEligible: false,
      message: 'Operator pause preserves logical SHIP; current authority and publication receipt are unavailable.' }));
    const app = express(); app.use(express.json());
    app.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify }, admission: { admit } as any, resolveInstallationId: vi.fn(),
      allowAppGate: true, passthroughEnabled: true, now: () => now,
      authoritativePublishing: { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, repositoryIds: [repositoryId],
        repositoryIdentities: [{ repositoryId, owner: 'exampleorg', repo: 'example-meta' }],
        recordOperatorPassthrough } as any,
    }));

    const response = await request(app).post('/api/dispatch/action').auth('opaque-oidc-token', { type: 'bearer' }).send(dispatch);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: 'ActionDispatchPassthrough.v1', status: 'passthrough',
      candidateState: 'unavailable', verdict: 'SHIP', expectedLanes: 0, completedLanes: 0,
      publicationId: null, auditDigest: null, publicationState: 'unavailable',
      publicationReceiptAvailable: null, reviewCheckId: null, gateCheckId: null, mergeEligible: false,
      repositoryId, owner: 'exampleorg', repo: 'example-meta', prNumber: 42,
      headSha: null, baseSha: null });
    expect(verify).toHaveBeenCalledOnce();
    expect(recordOperatorPassthrough).toHaveBeenCalledOnce();
    expect((recordOperatorPassthrough.mock.calls as unknown as any[])[0]?.[0]).toMatchObject({
      requested: { repositoryId, owner: 'exampleorg', repo: 'example-meta', prNumber: 42, headSha, baseSha },
      event: { transport: 'github-actions-oidc', deliveryId: `github-actions-oidc:${deliveryId}` },
    });
    expect(admit).not.toHaveBeenCalled();
  });

  it.each([
    { storageInitialized: false, repositoryId: 123, owner: 'exampleorg', repo: 'renamed-meta' },
    { storageInitialized: true, repositoryId: 123, owner: 'exampleorg', repo: 'renamed-meta' },
    { storageInitialized: false, repositoryId: 456, owner: 'exampleorg', repo: 'example-meta' },
    { storageInitialized: true, repositoryId: 456, owner: 'exampleorg', repo: 'example-meta' },
  ])('rejects configured name/ID conflicts before any paused work (storageInitialized=$storageInitialized, $repositoryId/$owner/$repo)', async (testCase) => {
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    const dispatch = {
      version: 'ActionDispatch.v1',
      deliveryId: `actions:98765:1:${testCase.repositoryId}:42:${'a'.repeat(40)}`,
      repositoryId: testCase.repositoryId,
      owner: testCase.owner,
      repo: testCase.repo,
      prNumber: 42,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), actionSha: 'c'.repeat(40), publishMode: 'app-gate',
      requestedAt: new Date(now).toISOString(),
      caller: { runId: '98765', runAttempt: 1, eventName: 'workflow_dispatch' },
    };
    const verify = vi.fn(async () => ({ repository: `${testCase.owner}/${testCase.repo}`,
      repository_id: String(testCase.repositoryId), repository_owner_id: '99', run_id: '98765',
      run_attempt: '1', event_name: 'workflow_dispatch' }));
    const resolveInstallationId = vi.fn();
    const recordOperatorPassthrough = vi.fn();
    const admit = vi.fn();
    const app = express(); app.use(express.json());
    app.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify }, admission: { admit } as any, resolveInstallationId,
      allowAppGate: true, passthroughEnabled: true,
      storageInitialized: () => testCase.storageInitialized, now: () => now,
      authoritativePublishing: { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, repositoryIds: [123, 456],
        repositoryIdentities: [{ repositoryId: 123, owner: 'exampleorg', repo: 'example-meta' }],
        recordOperatorPassthrough } as any,
    }));

    const response = await request(app).post('/api/dispatch/action')
      .auth('opaque-oidc-token', { type: 'bearer' }).send(dispatch);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Action dispatch is not authorized' });
    expect(verify).toHaveBeenCalledOnce();
    expect(resolveInstallationId).not.toHaveBeenCalled();
    expect(recordOperatorPassthrough).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
});

/**
 * REL-1056. The headline behaviour of this change — a DETERMINISTIC completion
 * failure returning a terminal 422 instead of a retryable 503 — lives in the
 * router's catch block, so it must be asserted through the router. Asserting
 * only on `isDeterministicCompletionFailure` would pass even if the branch were
 * inverted, the wrong field were read, or the reason were dropped in transit,
 * and a finished review would then be retried until it was discarded.
 */
describe('ActionDispatchApi - worker completion classification (REL-1056)', () => {
  const token = 'ghs_' + 'a'.repeat(40);
  const event = {
    version: 'WorkerReviewCompletion.v1',
    runId: `run_${'1'.repeat(32)}`,
    repositoryId: 1, owner: 'example', repo: 'candidate', prNumber: 42,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), executionAttempt: 2,
    result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-23T18:00:00Z',
      coverageComplete: true, quorumSatisfied: true, personas: [] },
  };

  function createCompletionApp(recordWorkerResult: (input: unknown, proof: unknown,
    resolve: unknown, now?: number) => Promise<string>) {
    const app = express();
    app.use('/api/dispatch/completion', express.json({ limit: '256kb', strict: true }));
    app.use(express.json({ limit: '64kb', strict: true }));
    const router = createActionDispatchRouter({
      verifier: { verify: vi.fn() } as any,
      admission: { admit: vi.fn() } as any,
      resolveInstallationId: vi.fn(),
      authoritativeWorkerCompletion: {
        verifier: { verify: vi.fn(async () => ({ workerTokenDigest: 'e'.repeat(64) })) } as any,
        repository: { recordWorkerResult: vi.fn(recordWorkerResult) } as any,
        resolve: vi.fn(),
      },
    } as any);
    app.use('/api/dispatch', router);
    return app;
  }

  it('returns terminal 422 with the reason for a deterministic failure', async () => {
    const app = createCompletionApp(async () => {
      throw new WorkerCompletionPersistenceError('trusted-completion-resolution',
        'exact-diff', 'coverage-no-persona');
    });
    const res = await request(app).post('/api/dispatch/completion')
      .set('Authorization', `Bearer ${token}`).send(event);
    // 422 is the contract rejection; the worker must NOT retry it.
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('coverage-no-persona');
    expect(res.body.error).toContain('trusted review contract');
  });

  it('still returns retryable 503 for a genuinely transient failure', async () => {
    // An `unknown` reason is the unclassified case: a real outage must keep
    // retrying, so this branch must not have been widened to everything.
    const app = createCompletionApp(async () => {
      throw new WorkerCompletionPersistenceError('trusted-completion-resolution',
        'exact-diff', 'unknown');
    });
    const res = await request(app).post('/api/dispatch/completion')
      .set('Authorization', `Bearer ${token}`).send(event);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('could not be persisted');
  });

  it('keeps a failure with no reason retryable', async () => {
    const app = createCompletionApp(async () => {
      throw new WorkerCompletionPersistenceError('commit');
    });
    const res = await request(app).post('/api/dispatch/completion')
      .set('Authorization', `Bearer ${token}`).send(event);
    expect(res.status).toBe(503);
  });

  it('does not classify on a substage that is not a reason', async () => {
    // Counterfactual guard: reading `substage` instead of `reason` would make
    // every failure retryable again, silently restoring the REL-1056 bug.
    const app = createCompletionApp(async () => {
      throw new WorkerCompletionPersistenceError('trusted-completion-resolution', 'exact-diff');
    });
    const res = await request(app).post('/api/dispatch/completion')
      .set('Authorization', `Bearer ${token}`).send(event);
    expect(res.status).toBe(503);
  });
});
