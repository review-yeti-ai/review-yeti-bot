import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { ParsedPRPayload } from '../../src/github/eventHandler';

const fixture = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  constructorOptions: undefined as unknown,
  createOrGet: vi.fn(),
}));

vi.mock('../../src/persistence/postgresStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/persistence/postgresStore')>();
  return { ...actual, postgresStore: { ...actual.postgresStore,
    isConfigured: () => true, getPool: () => fixture.pool } };
});
vi.mock('../../src/persistence/reviewRunRepository', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/persistence/reviewRunRepository')>();
  return { ...actual, PostgresReviewRunRepository: class {
    constructor(_pool: unknown, options: unknown) { fixture.constructorOptions = options; }
    createOrGet = fixture.createOrGet;
  } };
});

import { createApp, runReviewPipeline } from '../../src/app';

const payload: ParsedPRPayload = { repositoryId: 123, installationId: '456', owner: 'example', repo: 'service',
  prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), title: '', body: '', sender: 'developer',
  labels: [], triggerSource: 'pr_event', triggerAction: 'opened', deliveryId: 'identity-fixture' };

describe('legacy application lifecycle wiring', () => {
  beforeEach(() => {
    fixture.createOrGet.mockReset().mockRejectedValue(new Error('fixture admission boundary'));
  });

  it('keeps production legacy lifecycle events explicitly disabled pending Task 3R-B acceptance', () => {
    expect(fixture.constructorOptions).toEqual({ lifecycleEvents: 'disabled' });
  });

  it('passes numeric identity separately without changing the hashed review identity', async () => {
    await expect(runReviewPipeline(payload)).rejects.toThrow('fixture admission boundary');
    expect(fixture.createOrGet).toHaveBeenCalledTimes(1);
    const admission = fixture.createOrGet.mock.calls[0][0];
    expect(admission.repositoryId).toBe(123);
    expect(admission.identity).toMatchObject({ owner: 'example', repo: 'service', prNumber: 42,
      baseSha: payload.baseSha, headSha: payload.headSha });
    expect(admission.identity).not.toHaveProperty('repositoryId');
  });

  it('preserves an absent repository identity without fabricating one', async () => {
    await expect(runReviewPipeline({ ...payload, repositoryId: undefined })).rejects.toThrow('fixture admission boundary');
    expect(fixture.createOrGet.mock.calls[0][0].repositoryId).toBeUndefined();
  });

  it.each([123, undefined])('forwards repositoryId %s through the signed createApp webhook route', async (repositoryId) => {
    process.env.WEBHOOK_SECRET = 'legacy-route-fixture-secret';
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 456 },
      repository: { id: repositoryId, owner: { login: payload.owner }, name: payload.repo },
      sender: { login: payload.sender },
      pull_request: { number: payload.prNumber, state: 'open',
        base: { sha: payload.baseSha }, head: { sha: payload.headSha, repo: { id: 999 } } },
    });
    const signature = 'sha256=' + createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex');
    // The admission sentinel ends this request before a background review can start.
    await request(createApp()).post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', randomUUID())
      .set('x-hub-signature-256', signature)
      .send(body)
      .expect(500);

    expect(fixture.createOrGet).toHaveBeenCalledTimes(1);
    const admission = fixture.createOrGet.mock.calls[0][0];
    expect(admission.repositoryId).toBe(repositoryId);
    expect(admission.identity).toMatchObject({ owner: payload.owner, repo: payload.repo,
      prNumber: payload.prNumber, baseSha: payload.baseSha, headSha: payload.headSha });
    expect(admission.identity).not.toHaveProperty('repositoryId');
  });
});
