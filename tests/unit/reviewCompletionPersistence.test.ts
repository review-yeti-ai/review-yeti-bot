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

const COMPLETION_NOW = Date.parse('2026-09-09T12:01:00.000Z');

function enrolledStateRow() {
  const event = completion();
  return {
    coordinates: {
      runId: event.runId, repositoryId: event.repositoryId, owner: event.owner, repo: event.repo,
      prNumber: event.prNumber, headSha: event.headSha, baseSha: event.baseSha,
      policyDigest: event.policyDigest, configDigest: event.configDigest, executionAttempt: event.executionAttempt,
      attemptId: `${event.runId}-g2-e2`,
    },
    review_generation: 2, expected_app_id: 77, external_id: 'gate_123', check_id: 88,
    creation_state: 'bound', desired_state: 'pending', desired_version: 1, published_version: 0,
    current_attempt: true, worker_token_digest: 'f'.repeat(64), current_execution: 1,
    run_status: 'queued', outbox_status: 'pending', effective_config_digest: event.configDigest,
    current_generation: 2, authoritative_gate_app_id: 77,
    received_at: '2026-09-09T11:59:00.000Z', terminal_deadline: '2026-09-09T12:10:00.000Z',
  };
}

function trustedCompletion() {
  const event = completion();
  return {
    current: {
      repositoryId: event.repositoryId, prNumber: event.prNumber, headSha: event.headSha,
      baseSha: event.baseSha, policyDigest: event.policyDigest, open: true, draft: false,
    },
    coverage: {
      expectedPersonaIds: ['security'],
      changedFiles: [{ path: 'src/example.ts', patch: '@@ -0,0 +1 @@\n+const example = 1;\n' }],
      coverageComplete: true, quorumSatisfied: true,
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

  it.each([
    { stage: 'advisory-lock', matches: (sql: string) => sql.startsWith('SELECT pg_advisory_xact_lock') },
    { stage: 'state-load', matches: (sql: string) => sql.startsWith('SELECT gate.*, runs.status') },
    { stage: 'trusted-completion-resolution', resolver: true },
    { stage: 'gate-update', matches: (sql: string) => sql.startsWith('UPDATE review_gate_attempts') },
    { stage: 'completion-insert', matches: (sql: string) => sql.startsWith('INSERT INTO review_worker_completions') },
    { stage: 'outbox-update', matches: (sql: string) => sql.startsWith('UPDATE review_dispatch_outbox') },
    { stage: 'run-update', matches: (sql: string) => sql.startsWith('UPDATE review_runs') },
    { stage: 'lifecycle-append', lifecycleEvents: 'enabled' as const,
      matches: (sql: string) => sql.startsWith('SELECT runs.run_id, runs.repository_id') },
    { stage: 'eligible-completion-hook', hook: true },
    { stage: 'commit', matches: (sql: string) => sql === 'COMMIT' },
  ])('redacts a $stage failure and rolls back its enrolled transaction', async (target) => {
    const state = enrolledStateRow();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (target.matches?.(sql)) throw new Error(PRIVATE_DETAIL);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [] };
        if (sql.startsWith('SELECT repository_id, pr_number')) return { rows: [{ repository_id: 123, pr_number: 42 }] };
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (sql.startsWith('SELECT gate.*, runs.status')) return { rows: [state] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new PostgresReviewGateRepository({ connect: vi.fn(async () => client), query: vi.fn() }, {
      lifecycleEvents: target.lifecycleEvents ?? 'disabled',
      ...(target.hook ? { onEligibleCompletion: async () => { throw new Error(PRIVATE_DETAIL); } } : {}),
    });
    const resolve = target.resolver
      ? vi.fn(async () => { throw new Error(PRIVATE_DETAIL); })
      : vi.fn(async () => trustedCompletion());

    let thrown: unknown;
    try {
      await repository.recordWorkerResult(completion(), { workerTokenDigest: 'f'.repeat(64) }, resolve, COMPLETION_NOW);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkerCompletionPersistenceError);
    expect(thrown).toMatchObject({ name: 'WorkerCompletionPersistenceError', stage: target.stage });
    expect((thrown as Error).message).toBe(`Worker completion persistence failed at ${target.stage}`);
    expect(JSON.stringify(thrown)).not.toContain(PRIVATE_DETAIL);
    expect(Object.getOwnPropertyNames(thrown as object)).not.toContain('cause');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
});
