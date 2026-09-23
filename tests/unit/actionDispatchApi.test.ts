import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import type { ReviewDispatchRepository, RunStatusResult } from '../../src/persistence/reviewDispatchRepository';
import { WorkerCompletionPersistenceError } from '../../src/review/workerCompletionPersistenceError';

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
