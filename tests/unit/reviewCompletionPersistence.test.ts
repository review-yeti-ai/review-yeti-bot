import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import {
  WorkerCompletionPersistenceError,
  workerCompletionPersistenceStages,
} from '../../src/review/workerCompletionPersistenceError';
import type { WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';

const PRIVATE_DETAIL = 'private-sql-detail-must-not-escape';

function completion(): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', runId: `run_${'a'.repeat(32)}`,
    repositoryId: 123, owner: 'calltelemetry', repo: 'example', prNumber: 42,
    headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
    policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), executionAttempt: 2,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T12:00:00.000Z',
      coverageComplete: true, quorumSatisfied: true,
      personas: [{ id: 'security', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
    },
  };
}

describe('worker completion persistence diagnostics', () => {
  it('publishes only the finite completion persistence stages', () => {
    expect(workerCompletionPersistenceStages).toEqual([
      'transaction-begin', 'binding-lookup', 'advisory-lock', 'state-load',
      'trusted-completion-resolution', 'gate-update', 'completion-insert',
      'outbox-update', 'run-update', 'lifecycle-append',
      'eligible-completion-hook', 'commit',
    ]);
  });

  it('classifies a pool-connect rejection before a transaction without leaking private detail', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    const connect = vi.fn(async () => { throw new Error(PRIVATE_DETAIL); });
    const repository = new PostgresReviewGateRepository({ connect, query: vi.fn() }, { lifecycleEvents: 'disabled' });

    let thrown: unknown;
    try {
      await repository.recordWorkerResult(completion(), { workerTokenDigest: 'f'.repeat(64) }, vi.fn());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkerCompletionPersistenceError);
    expect(thrown).toMatchObject({ name: 'WorkerCompletionPersistenceError', stage: 'transaction-begin' });
    expect((thrown as Error).message).toBe('Worker completion persistence failed at transaction-begin');
    expect(JSON.stringify(thrown)).not.toContain(PRIVATE_DETAIL);
    expect(Object.getOwnPropertyNames(thrown as object)).not.toContain('cause');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it('classifies a binding lookup failure without retaining private database detail', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql.startsWith('SET LOCAL')) return { rows: [] };
        if (sql.startsWith('SELECT repository_id, pr_number')) throw new Error(PRIVATE_DETAIL);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new PostgresReviewGateRepository({
      connect: vi.fn(async () => client),
      query: vi.fn(),
    }, { lifecycleEvents: 'disabled' });

    let thrown: unknown;
    try {
      await repository.recordWorkerResult(completion(), { workerTokenDigest: 'f'.repeat(64) }, vi.fn());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkerCompletionPersistenceError);
    expect(thrown).toMatchObject({ name: 'WorkerCompletionPersistenceError', stage: 'binding-lookup' });
    expect((thrown as Error).message).toBe('Worker completion persistence failed at binding-lookup');
    expect(JSON.stringify(thrown)).not.toContain(PRIVATE_DETAIL);
    expect(Object.getOwnPropertyNames(thrown as object)).not.toContain('cause');
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
});
