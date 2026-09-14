import { describe, expect, it, vi } from 'vitest';
import {
  assertReviewPrCoordinates,
  lockReviewPr,
  reviewPrLockKey,
  tryLockReviewPr,
  withReviewPrTransaction,
  type ReviewPrTransactionClient,
  type ReviewPrTransactionPool,
} from '../../src/persistence/reviewPrTransaction';

function clientFor(query: ReviewPrTransactionClient['query']): {
  client: ReviewPrTransactionClient;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return { client: { query, release }, release };
}

function poolFor(client: ReviewPrTransactionClient): ReviewPrTransactionPool {
  return { connect: vi.fn(async () => client) };
}

describe('review PR transaction boundary', () => {
  it('accepts only positive safe numeric coordinates and reuses the canonical lock namespace', () => {
    expect(assertReviewPrCoordinates(123, 42)).toEqual({ repositoryId: 123, prNumber: 42 });
    expect(reviewPrLockKey(123, 42)).toBe('review-dispatch:123:42');

    for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123']) {
      expect(() => assertReviewPrCoordinates(value, 42)).toThrow(/positive safe integer/i);
      expect(() => reviewPrLockKey(value as never, 42)).toThrow(/positive safe integer|lock identity/i);
    }
    for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
      expect(() => assertReviewPrCoordinates(123, value)).toThrow(/positive safe integer/i);
      expect(() => reviewPrLockKey(123, value as never)).toThrow(/positive safe integer|lock identity/i);
    }
  });

  it('acquires the canonical PR lock and reports a try-lock result', async () => {
    const query = vi.fn(async () => ({ rows: [{ acquired: true }] }));
    const { client } = clientFor(query);

    await lockReviewPr(client, 123, 42);
    await expect(tryLockReviewPr(client, 123, 42)).resolves.toBe(true);

    expect(query.mock.calls).toEqual([
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['review-dispatch:123:42']],
      ['SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', ['review-dispatch:123:42']],
    ]);
  });

  it('commits the operation on the acquired client and releases exactly once', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const { client, release } = clientFor(query);

    await expect(withReviewPrTransaction(poolFor(client), async transactionClient => {
      await transactionClient.query('SELECT operation');
      return 'result';
    })).resolves.toBe('result');

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT operation', 'COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves an operation error when rollback and release cleanup also fail', async () => {
    const operationError = new Error('operation failed');
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      if (sql === 'operation') throw operationError;
      return { rows: [] };
    });
    const { client, release } = clientFor(query);
    release.mockImplementation(() => { throw new Error('release failed'); });

    await expect(withReviewPrTransaction(poolFor(client), async transactionClient => {
      await transactionClient.query('operation');
    })).rejects.toBe(operationError);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'operation', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['begin', 'BEGIN'],
    ['commit', 'COMMIT'],
  ])('preserves a failed %s error and never retries the transaction', async (_label, failedStatement) => {
    const transactionError = new Error(`${failedStatement} failed`);
    const query = vi.fn(async (sql: string) => {
      if (sql === failedStatement) throw transactionError;
      return { rows: [] };
    });
    const { client, release } = clientFor(query);

    await expect(withReviewPrTransaction(poolFor(client), async transactionClient => {
      if (failedStatement === 'COMMIT') await transactionClient.query('operation');
    })).rejects.toBe(transactionError);

    expect(query.mock.calls.filter(([sql]) => sql === failedStatement)).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('surfaces a release failure after a successful commit without rolling back', async () => {
    const releaseError = new Error('release failed after commit');
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const { client, release } = clientFor(query);
    release.mockImplementation(() => { throw releaseError; });

    await expect(withReviewPrTransaction(poolFor(client), async () => 'result')).rejects.toBe(releaseError);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
