import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewRunRepository } from '../../src/persistence/reviewRunRepository';

const identity = {
  owner: 'calltelemetry',
  repo: 'review-yeti',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};

function queryOnlyDatabase() {
  return { query: vi.fn(async () => ({ rows: [] })) };
}

function connectionPool() {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  };
}

describe('PostgresReviewRunRepository lifecycle mode', () => {
  it('keeps omitted and explicitly disabled options compatible with the legacy query seam', () => {
    expect(() => new PostgresReviewRunRepository(queryOnlyDatabase())).not.toThrow();
    expect(() => new PostgresReviewRunRepository(queryOnlyDatabase(), { lifecycleEvents: 'disabled' })).not.toThrow();
  });

  it('rejects an omitted or invalid explicit lifecycle mode when options are supplied', () => {
    expect(() => new PostgresReviewRunRepository(queryOnlyDatabase(), {} as never)).toThrow(/explicit lifecycle event mode/i);
    expect(() => new PostgresReviewRunRepository(queryOnlyDatabase(), { lifecycleEvents: 'sometimes' } as never))
      .toThrow(/explicit lifecycle event mode/i);
    expect(() => new PostgresReviewRunRepository(queryOnlyDatabase(), null as never))
      .toThrow(/explicit lifecycle event mode/i);
  });

  it('requires a connection pool for enabled lifecycle events', () => {
    expect(() => new PostgresReviewRunRepository(queryOnlyDatabase(), { lifecycleEvents: 'enabled' }))
      .toThrow(/connection pool/i);
    expect(() => new PostgresReviewRunRepository(connectionPool(), { lifecycleEvents: 'enabled' })).not.toThrow();
  });

  it('requires a positive safe trusted repository ID before enabled admission', async () => {
    const pool = connectionPool();
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    for (const repositoryId of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123']) {
      await expect(repository.createOrGet({ identity, repositoryId: repositoryId as never, now: 1_000 }))
        .rejects.toThrow(/repository id/i);
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
