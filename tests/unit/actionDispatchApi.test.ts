import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import type { ReviewDispatchRepository, RunStatusResult } from '../../src/persistence/reviewDispatchRepository';

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
