import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { runReviewPipeline } from '../../src/app';

const payload: ParsedPRPayload = { repositoryId: 123, installationId: '456', owner: 'example', repo: 'service',
  prNumber: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), title: '', body: '', sender: 'developer',
  labels: [], triggerSource: 'pr_event', triggerAction: 'opened', deliveryId: 'identity-fixture' };

describe('legacy application lifecycle wiring', () => {
  beforeEach(() => {
    fixture.createOrGet.mockReset().mockRejectedValue(new Error('fixture admission boundary'));
  });

  it('constructs the durable repository with lifecycle events explicitly enabled', () => {
    expect(fixture.constructorOptions).toEqual({ lifecycleEvents: 'enabled' });
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

  it('leaves unknown identity absent for the enabled repository to reject, never fabricates one', async () => {
    await expect(runReviewPipeline({ ...payload, repositoryId: undefined })).rejects.toThrow('fixture admission boundary');
    expect(fixture.createOrGet.mock.calls[0][0].repositoryId).toBeUndefined();
  });
});
