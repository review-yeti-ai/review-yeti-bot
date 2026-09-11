import { describe, expect, it, vi } from 'vitest';
import {
  PostgresReviewCompletionRepository,
  ReviewCompletionRecordInput,
} from '../../src/persistence/reviewCompletionRepository';

function clientWithRows(rows: any[][]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: rows.shift() || [] }));
  const release = vi.fn();
  return { query, release };
}

const DISABLED_LIFECYCLE_EVENTS = { lifecycleEvents: 'disabled' as const };
const ENABLED_LIFECYCLE_EVENTS = { lifecycleEvents: 'enabled' as const };

describe('PostgresReviewCompletionRepository', () => {
  const baseInput: ReviewCompletionRecordInput = {
    runId: 'run_12345',
    repositoryId: 98765,
    repository: 'calltelemetry/dashboard',
    prNumber: 42,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    attemptId: 'run_12345',
    policyDigest: `sha256:${'c'.repeat(64)}`,
    verdict: 'SHIP',
    conclusion: 'success',
  };

  const sampleDbRow = {
    completion_id: 'cpl_12345',
    run_id: 'run_12345',
    delivery_id: null,
    repository_id: '98765',
    repository: 'calltelemetry/dashboard',
    pr_number: 42,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    attempt_id: 'run_12345',
    policy_digest: `sha256:${'c'.repeat(64)}`,
    validation_request_id: 'validation-42-run_12345',
    status: 'pending',
    draft_deferred: false,
    verdict: 'SHIP',
    conclusion: 'success',
    lease_owner: null,
    lease_expires_at: null,
    attempt: 0,
    available_at: new Date(1_000),
    created_at: new Date(1_000),
    updated_at: new Date(1_000),
    error_text: null,
  };

  it('records completion with calculated defaults and ON CONFLICT update', async () => {
    const client = clientWithRows([[sampleDbRow]]);
    const pool = { connect: vi.fn(async () => client) };
    const repository = new PostgresReviewCompletionRepository(pool, DISABLED_LIFECYCLE_EVENTS);

    const record = await repository.recordCompletion(baseInput);

    expect(record.completionId).toBe('cpl_12345');
    expect(record.status).toBe('pending');
    expect(record.validationRequestId).toBe('validation-42-run_12345');
    expect(record.draftDeferred).toBe(false);
    expect(client.query).toHaveBeenCalledOnce();
    const [, values] = client.query.mock.calls[0];
    expect(values).toContain('cpl_12345');
    expect(values).toContain(98765);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('claims next available eligible completion record using FOR UPDATE SKIP LOCKED and sets lease', async () => {
    const claimedRow = {
      ...sampleDbRow,
      status: 'claimed',
      lease_owner: 'worker-1',
      lease_expires_at: new Date(31_000),
      attempt: 1,
    };
    const client = clientWithRows([[claimedRow]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const claim = await repository.claimNext('worker-1', 1_000, 30_000);

    expect(claim).not.toBeNull();
    expect(claim?.completionId).toBe('cpl_12345');
    expect(claim?.leaseOwner).toBe('worker-1');
    expect(claim?.attempt).toBe(1);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual(['worker-1', 1_000, 30_000]);
  });

  it('returns null when no candidate record is available for claim', async () => {
    const client = clientWithRows([[]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const claim = await repository.claimNext('worker-1', 1_000, 30_000);

    expect(claim).toBeNull();
  });

  describe('lifecycle-enabled claim preflight', () => {
    const claimedRow = {
      ...sampleDbRow,
      status: 'claimed',
      lease_owner: 'worker-1',
      lease_expires_at: new Date(31_000),
      attempt: 1,
    };

    it('returns idle without checking out a transaction client', async () => {
      const connect = vi.fn();
      const probe = vi.fn(async () => ({ rows: [] }));
      const repository = new PostgresReviewCompletionRepository(
        { connect, query: probe }, ENABLED_LIFECYCLE_EVENTS,
      );

      await expect(repository.claimNext('worker-1', 1_000, 30_000)).resolves.toBeNull();
      expect(probe).toHaveBeenCalledOnce();
      expect(connect).not.toHaveBeenCalled();
    });

    it('keeps a positive candidate claim on one transaction client', async () => {
      const clientCalls: string[] = [];
      const clientQuery = vi.fn(async (sql: string) => {
        clientCalls.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (/WITH candidate/u.test(sql)) return { rows: [claimedRow] };
        throw new Error(`unexpected completion claim query: ${sql}`);
      });
      const client = { query: clientQuery, release: vi.fn() };
      const connect = vi.fn(async () => client);
      const probe = vi.fn(async () => ({ rows: [{}] }));
      const repository = new PostgresReviewCompletionRepository(
        { connect, query: probe }, ENABLED_LIFECYCLE_EVENTS,
      );

      await expect(repository.claimNext('worker-1', 1_000, 30_000)).resolves.toMatchObject({
        completionId: sampleDbRow.completion_id, attempt: 1,
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledOnce();
      expect(clientCalls).toEqual(['BEGIN', expect.stringContaining('WITH candidate'), 'COMMIT']);
      expect(client.release).toHaveBeenCalledOnce();
    });

    it('commits a safe empty transaction when a probed candidate is claimed by a race', async () => {
      const clientCalls: string[] = [];
      const clientQuery = vi.fn(async (sql: string) => {
        clientCalls.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (/WITH candidate/u.test(sql)) return { rows: [] };
        throw new Error(`unexpected completion race query: ${sql}`);
      });
      const client = { query: clientQuery, release: vi.fn() };
      const connect = vi.fn(async () => client);
      const probe = vi.fn(async () => ({ rows: [{}] }));
      const repository = new PostgresReviewCompletionRepository(
        { connect, query: probe }, ENABLED_LIFECYCLE_EVENTS,
      );

      await expect(repository.claimNext('worker-1', 1_000, 30_000)).resolves.toBeNull();
      expect(clientCalls).toEqual(['BEGIN', expect.stringContaining('WITH candidate'), 'COMMIT']);
      expect(client.release).toHaveBeenCalledOnce();
    });
  });

  it('renews lease via heartbeat', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_12345' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const renewed = await repository.heartbeat('cpl_12345', 'worker-1', 5_000, 30_000);

    expect(renewed).toBe(true);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual(['cpl_12345', 'worker-1', 5_000, 30_000]);
  });

  it('marks record as dispatched and clears lease fields', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_12345' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const marked = await repository.markDispatched('cpl_12345', 'worker-1', 10_000);

    expect(marked).toBe(true);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual(['cpl_12345', 'worker-1', 10_000]);
  });

  it('marks record as completed and clears lease fields', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_12345' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const marked = await repository.markCompleted('cpl_12345', 'worker-1', 10_000);

    expect(marked).toBe(true);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual(['cpl_12345', 'worker-1', 10_000]);
  });

  it('releases record for retry with exponential backoff delay and records error', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_12345' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const released = await repository.releaseForRetry(
      'cpl_12345',
      'worker-1',
      10_000,
      4_000,
      'GitHub HTTP 503 Service Unavailable',
    );

    expect(released).toBe(true);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual(['cpl_12345', 'worker-1', 10_000, 4_000, 'GitHub HTTP 503 Service Unavailable']);
  });

  it('marks record as permanent error and clears lease', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_12345' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const marked = await repository.markError(
      'cpl_12345',
      'worker-1',
      10_000,
      'Authentication failure HTTP 401: Bad credentials',
    );

    expect(marked).toBe(true);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual(['cpl_12345', 'worker-1', 'Authentication failure HTTP 401: Bad credentials', 10_000]);
  });

  it('returns false when markError is called after lease loss or status not claimed', async () => {
    const client = clientWithRows([[]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const marked = await repository.markError(
      'cpl_12345',
      'worker-1',
      10_000,
      'Authentication failure HTTP 401: Bad credentials',
    );

    expect(marked).toBe(false);
  });

  it('un-defers draft completions when PR is marked ready', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_12345' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const count = await repository.markReady(98765, 42, 'b'.repeat(40), 12_000);

    expect(count).toBe(1);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual([98765, 42, 'b'.repeat(40), 12_000]);
  });

  it('supersedes older pending or claimed heads for the same PR', async () => {
    const client = clientWithRows([[{ completion_id: 'cpl_old_1' }, { completion_id: 'cpl_old_2' }]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const count = await repository.supersedeOlderHeads(98765, 42, 'b'.repeat(40), 15_000);

    expect(count).toBe(2);
    const [, values] = client.query.mock.calls[0];
    expect(values).toEqual([98765, 42, 'b'.repeat(40), 15_000]);
  });

  it('queries record by validationRequestId and runId', async () => {
    const client = clientWithRows([[sampleDbRow], [sampleDbRow]]);
    const repository = new PostgresReviewCompletionRepository({ connect: vi.fn(async () => client) }, DISABLED_LIFECYCLE_EVENTS);

    const byVal = await repository.getByValidationRequestId('validation-42-run_12345');
    expect(byVal?.validationRequestId).toBe('validation-42-run_12345');

    const byRun = await repository.getByRunId('run_12345');
    expect(byRun?.runId).toBe('run_12345');
  });
});
