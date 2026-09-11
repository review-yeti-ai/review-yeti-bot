import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { sha256 } from '../../src/review/reviewCore';
import { MAX_TERMINAL_DEADLINE_MS, MIN_TERMINAL_DEADLINE_MS, TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

const identity = {
  owner: 'calltelemetry',
  repo: 'cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};

const row = {
  run_id: `run_${'e'.repeat(32)}`,
  identity_digest: 'e'.repeat(64),
  owner: identity.owner,
  repo: identity.repo,
  pr_number: identity.prNumber,
  head_sha: identity.headSha,
  base_sha: identity.baseSha,
  snapshot_digest: identity.snapshotDigest,
  config_digest: identity.configDigest,
  effective_policy_digest: identity.configDigest,
  effective_config_digest: identity.configDigest,
  publication_mode: 'disabled',
  index_epoch: 0,
  identity,
  status: 'queued',
  stage: 'admission',
  attempt: 0,
  artifacts: {},
  created_at: new Date(1_000),
  updated_at: new Date(1_000),
};

function input() {
  return {
    deliveryId: 'actions:987:1:123:42:head',
    eventName: 'workflow_dispatch',
    repositoryId: 123,
    installationId: 456,
    receivedAt: 1_000,
    terminalDeadline: 1_000 + TERMINAL_DEADLINE_MS,
    payloadDigest: 'f'.repeat(64),
    publicationMode: 'disabled' as const,
    identity,
  };
}

function clientWithRows(rows: any[][]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: rows.shift() || [] }));
  const release = vi.fn();
  return { query, release };
}

function workerFailureRepository(query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>) {
  const transactionQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || /SELECT pg_advisory_xact_lock/u.test(sql)) return { rows: [] };
    return query(sql, values);
  });
  const release = vi.fn();
  return {
    repository: new PostgresReviewDispatchRepository({ connect: async () => ({ query: transactionQuery, release }) }),
    transactionQuery,
    release,
  };
}

const claimMutations = [
  { name: 'heartbeat', invoke: (r: PostgresReviewDispatchRepository, attempt: number) => r.heartbeat(row.run_id, 'dispatcher-a', attempt, 2_000, 30_000) },
  { name: 'bindWorkerTokenDigest', invoke: (r: PostgresReviewDispatchRepository, attempt: number) => r.bindWorkerTokenDigest(row.run_id, 'dispatcher-a', attempt, 'a'.repeat(64), 2_000) },
  { name: 'markProjected', invoke: (r: PostgresReviewDispatchRepository, attempt: number) => r.markProjected(row.run_id, 'dispatcher-a', attempt, 'projection', 2_000) },
  { name: 'releaseForRetry', invoke: (r: PostgresReviewDispatchRepository, attempt: number) => r.releaseForRetry(row.run_id, 'dispatcher-a', attempt, 2_000, 3_000) },
  { name: 'markTerminal', invoke: (r: PostgresReviewDispatchRepository, attempt: number) => r.markTerminal(row.run_id, 'dispatcher-a', attempt, 2_000, 'projection rejected') },
];

describe('PostgresReviewDispatchRepository', () => {
  // Real stale/current claim and deadline behavior is exercised for every
  // mutation in reviewDispatchRepository.postgres.test.ts. This unit seam only
  // verifies that matched/unmatched persistence acknowledgements are exposed.
  it.each(claimMutations)('$name returns the persistence mutation outcome', async ({ invoke }) => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[] }> => ({ rows: [] }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });
    await expect(invoke(repository, 7)).resolves.toBe(false);
    query.mockResolvedValueOnce({ rows: [{ run_id: row.run_id }] });
    await expect(invoke(repository, 7)).resolves.toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])('rejects an invalid claim generation %s before any mutation', async (attempt) => {
    const query = vi.fn();
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });
    for (const { invoke } of claimMutations) {
      await expect(invoke(repository, attempt as number)).rejects.toThrow(/claim attempt must be a positive integer/u);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the admitted run after committing and releases its transaction client', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [row], [], [], [], []]);
    const pool = { connect: vi.fn(async () => client) };
    const repository = new PostgresReviewDispatchRepository(pool);

    const result = await repository.admit(input());

    expect(result.status).toBe('accepted');
    expect(result.run.runId).toBe(row.run_id);
    // Transaction completion is the contract here, not incidental statement
    // order or SQL parameter numbering. The real database suite observes the
    // delivery/run/outbox state, identity collision rollback and lane isolation.
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns the existing run for an identical duplicate delivery without another outbox insert', async () => {
    const client = clientWithRows([[], [], [], [{ ...row, payload_digest: input().payloadDigest, repository_id: 123 }], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) });

    const result = await repository.admit(input());

    expect(result.status).toBe('duplicate');
    expect(result.run.runId).toBe(row.run_id);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO review_dispatch_outbox/u.test(String(sql)))).toBe(false);
  });

  // A run id is derived from the identity digest, so every re-dispatch of the
  // same complete identity lands on the same row. Without a retry path a terminally failed run
  // pins that head forever: the run stays 'failed', the outbox stays 'projected'
  // or 'terminal', and no label, re-run or re-dispatch can produce another review. Observed on
  // cisco-cdr#4836, where three dispatches were accepted and none created a job.
  //
  // Known limit, stated plainly: this suite has no Postgres, so the retry rule
  // cannot be executed here -- these assertions read it off the emitted SQL, as
  // the other tests in this file do. They pin the payloads as well as the guards,
  // so a re-arm that sets a wrong value fails. Collapsing whitespace only removes
  // formatting differences; it does not survive reordering or aliasing the
  // clauses, and a rewrite of these queries is expected to update this test.
  it('re-arms a terminally failed run for the same current identity, and nothing else', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [row], [], [], [], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) });

    await repository.admit(input());

    const sqlFor = (table: RegExp) => String(
      client.query.mock.calls.find(([sql]) => table.test(String(sql)))?.[0] || '',
    ).replace(/\s+/gu, ' ');

    const runSql = sqlFor(/INSERT INTO review_runs/u);
    // Each re-arm payload, not just that a CASE exists: a retry must become
    // runnable ('queued'), be countable (attempt + 1), stop carrying the old
    // failure (error_text NULL), and get a deadline it can actually meet -- the
    // previous one is in the past and the reaper would sweep the retry at once.
    expect(runSql).toContain("status = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN 'queued' ELSE review_runs.status END");
    expect(runSql).toContain("attempt = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN review_runs.attempt + 1 ELSE review_runs.attempt END");
    expect(runSql).toContain("error_text = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN NULL ELSE review_runs.error_text END");
    expect(runSql).toContain("received_at = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN EXCLUDED.received_at ELSE review_runs.received_at END");
    expect(runSql).toContain("terminal_deadline = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN EXCLUDED.terminal_deadline ELSE review_runs.terminal_deadline END");
    // Every re-arm is conditioned on failure; active and superseded identities
    // are not retryable. Older legacy identities are fenced by persisted history.
    expect(runSql.match(/CASE WHEN review_runs\.status IN \('failed', 'terminal'\)/gu) || []).toHaveLength(8);
    // markTerminal writes 'failed'; the reaper writes 'terminal'. Both are dead
    // runs and both must be retryable, and no other status may be named.
    expect(runSql).not.toMatch(/CASE WHEN review_runs\.status (=|IN \()\s*'?(queued|running|superseded)/u);
    expect(runSql).toContain("AND review_runs.status <> 'superseded'");
    expect(runSql).toContain('AND (other.authoritative_gate_app_id IS NOT NULL) = (review_runs.authoritative_gate_app_id IS NOT NULL)');
    expect(runSql).toContain('other.identity_digest <> review_runs.identity_digest');
    expect(runSql).toContain('other.created_at >= review_runs.created_at');

    const outboxSql = sqlFor(/INSERT INTO review_dispatch_outbox/u);
    // Payload and both guards, so a superseded run's terminal row is never
    // re-armed and an in-flight row is never disturbed.
    expect(outboxSql).toContain("SET status = 'pending'");
    expect(outboxSql).toContain("lease_owner = NULL");
    expect(outboxSql).toContain('projection_name = NULL');
    expect(outboxSql).toContain("WHERE review_dispatch_outbox.status IN ('projected', 'terminal')");
    expect(outboxSql).toContain("execution_attempt = CASE WHEN review_dispatch_outbox.status = 'projected' OR review_dispatch_outbox.worker_token_digest IS NOT NULL OR review_dispatch_outbox.projection_name IS NOT NULL THEN review_dispatch_outbox.execution_attempt + 1 ELSE review_dispatch_outbox.execution_attempt END");
    expect(outboxSql).toContain("worker_token_digest = CASE WHEN review_dispatch_outbox.status IN ('projected', 'terminal') THEN NULL ELSE review_dispatch_outbox.worker_token_digest END");
    expect(outboxSql).toContain("r.status = 'queued'");
    expect(outboxSql).toContain('r.delivery_id = EXCLUDED.delivery_id');
  });

  it('binds supersession and the stable run id to the entire policy-bearing identity', async () => {
    const policyIdentity = {
      ...identity,
      reviewPolicy: {
        version: 'ReviewPolicyIdentity.v1', repositoryId: 123,
        effectivePolicyDigest: '1'.repeat(64), sources: [{
          repositoryId: 789, repository: 'calltelemetry/ct-review-actions',
          sha: 'c'.repeat(40), path: 'review-policy.json', contentDigest: 'f'.repeat(64),
        }],
      },
    };
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [row], [], [], [], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: async () => client });
    await repository.admit({ ...input(), identity: policyIdentity, effectivePolicyDigest: '1'.repeat(64) });
    const digest = sha256(policyIdentity);
    expect(digest).not.toBe(sha256(identity));
    expect(client.query.mock.calls[3][1]?.slice(0, 2)).toEqual([`run_${digest.slice(0, 32)}`, digest]);
    expect(client.query.mock.calls[4][1]?.[3]).toBe(digest);
  });

  it('rejects a fenced identity before superseding current work or inserting an outbox', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: async () => client });
    await expect(repository.admit(input())).rejects.toThrow(
      'review run identity conflict: identity is no longer current or publication mode differs',
    );
    expect(client.query.mock.calls.some(([sql]) => /WITH superseded|INSERT INTO review_dispatch_outbox/u.test(sql))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('does not supersede work when returning an already completed identity', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [{ ...row, status: 'succeeded' }], [], [], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: async () => client });
    expect((await repository.admit(input())).run.status).toBe('succeeded');
    expect(client.query.mock.calls.some(([sql]) => /WITH superseded/u.test(sql))).toBe(false);
  });

  it.each([
    { priorStatus: 'terminal', expectedExecutionAttempt: 7 },
    { priorStatus: 'projected', expectedExecutionAttempt: 8 },
  ] as const)('re-arms a $priorStatus outbox row with the correct execution identity', async ({ priorStatus, expectedExecutionAttempt }) => {
    let outbox: {
      status: 'pending' | 'claimed' | 'projected' | 'terminal';
      executionAttempt: number;
      projectionName: string;
    } = {
      status: priorStatus,
      executionAttempt: 7,
      projectionName: 'ct-review-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    };
    const query = vi.fn(async (sql: string) => {
      if (/WITH candidate/u.test(sql)) {
        // The re-armed row is the only state eligible for a new claim. The
        // repository's RETURNING expression exposes the next one-based
        // execution identity from the stored zero-based counter.
        expect(outbox.status).toBe('pending');
        expect(sql.replace(/\s+/gu, ' ')).toContain('outbox.execution_attempt + 1 AS execution_attempt');
        outbox.status = 'claimed';
        return { rows: [{
          run_id: row.run_id,
          delivery_id: input().deliveryId,
          claim_attempt: 1,
          execution_attempt: outbox.executionAttempt + 1,
          repository_id: 123,
          installation_id: 456,
          publication_mode: 'disabled',
          owner: identity.owner,
          repo: identity.repo,
          pr_number: identity.prNumber,
          head_sha: identity.headSha,
          base_sha: identity.baseSha,
          received_at: new Date(1_000),
          terminal_deadline: new Date(1_000 + TERMINAL_DEADLINE_MS),
          effective_policy_digest: identity.configDigest,
          effective_config_digest: identity.configDigest,
          lease_owner: 'dispatcher-a',
          lease_expires_at: new Date(31_000),
        }] };
      }
      if (/INSERT INTO github_deliveries/u.test(sql)) return { rows: [{ delivery_id: input().deliveryId }] };
      if (/WITH superseded/u.test(sql)) return { rows: [] };
      if (/INSERT INTO review_runs/u.test(sql)) return { rows: [row] };
      if (/INSERT INTO review_dispatch_outbox/u.test(sql)) {
        // Model the two state transitions guarded by the emitted SQL. A
        // terminal dispatcher failure has no worker object to replace, while a
        // projected worker failure must advance to a new CR/Secret name.
        const normalized = sql.replace(/\s+/gu, ' ');
        expect(normalized).toContain(
          "execution_attempt = CASE WHEN review_dispatch_outbox.status = 'projected' OR review_dispatch_outbox.worker_token_digest IS NOT NULL OR review_dispatch_outbox.projection_name IS NOT NULL THEN review_dispatch_outbox.execution_attempt + 1 ELSE review_dispatch_outbox.execution_attempt END",
        );
        expect(normalized).toContain("WHERE review_dispatch_outbox.status IN ('projected', 'terminal')");
        expect(normalized).toContain("r.status = 'queued'");
        expect(normalized).toContain('r.delivery_id = EXCLUDED.delivery_id');
        const prior = outbox.status;
        outbox = {
          status: 'pending',
          executionAttempt: prior === 'projected' ? outbox.executionAttempt + 1 : outbox.executionAttempt,
          projectionName: '',
        };
        return { rows: [] };
      }
      if (/UPDATE github_deliveries/u.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
      query,
    };
    const repository = new PostgresReviewDispatchRepository(pool);

    await repository.admit(input());

    expect(outbox).toEqual({
      status: 'pending',
      executionAttempt: expectedExecutionAttempt,
      projectionName: '',
    });
    const claim = await repository.claimNext('dispatcher-a', 2_000, 30_000);
    expect(claim?.executionAttempt).toBe(expectedExecutionAttempt + 1);
  });

  it('rejects a delivery id replayed with a different digest or repository', async () => {
    const client = clientWithRows([[], [], [], [{ ...row, payload_digest: '0'.repeat(64), repository_id: 999 }], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) });
    await expect(repository.admit(input())).rejects.toThrow(/delivery identity conflict/i);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects a delivery id replayed with a different publication mode', async () => {
    const client = clientWithRows([[], [], [], [{
      ...row,
      payload_digest: input().payloadDigest,
      repository_id: 123,
      publication_mode: 'app-gate',
    }], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) });
    await expect(repository.admit(input())).rejects.toThrow(/publication mode/i);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects a new delivery that changes publication mode for an existing run identity', async () => {
    const persistedMode = 'app-gate';
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (/INSERT INTO github_deliveries/u.test(sql)) return { rows: [{ delivery_id: 'new-delivery' }] };
      if (/INSERT INTO review_runs/u.test(sql)) {
        const enforcesModeIdentity = /WHERE review_runs\.publication_mode = EXCLUDED\.publication_mode/u.test(sql);
        const requestedMode = values[17];
        return { rows: enforcesModeIdentity && requestedMode !== persistedMode
          ? []
          : [{ ...row, publication_mode: persistedMode }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) });
    await expect(repository.admit({ ...input(), deliveryId: 'new-delivery' }))
      .rejects.toThrow(/publication mode/i);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects an invalid publication mode before opening a transaction', async () => {
    const connect = vi.fn();
    const repository = new PostgresReviewDispatchRepository({ connect } as any);
    await expect(repository.admit({ ...input(), publicationMode: 'bogus' as any }))
      .rejects.toThrow(/publication mode/i);
    expect(connect).not.toHaveBeenCalled();
  });

  // A run's persisted terminalDeadline reflects whichever REVIEW_YETI_TERMINAL_DEADLINE_MS
  // value was in effect at admission time. A later dispatcher restart or rolling config
  // update must not orphan that already-admitted run: this invariant validates the
  // bounded [MIN, MAX] window (the same range the CRD's CEL rule and the Go operator
  // enforce), not exact equality to whatever this process currently resolves.
  it('accepts an admitted window that differs from the current TERMINAL_DEADLINE_MS but is still within [MIN, MAX]', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [row], [], [], [], []]);
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) } as any);
    const admittedUnderADifferentWindow = {
      ...input(),
      // Neither MIN_TERMINAL_DEADLINE_MS nor the current TERMINAL_DEADLINE_MS -- a
      // third in-range value simulating an env change between admission and now.
      terminalDeadline: input().receivedAt + Math.round((MIN_TERMINAL_DEADLINE_MS + MAX_TERMINAL_DEADLINE_MS) / 2),
    };
    expect(admittedUnderADifferentWindow.terminalDeadline).not.toBe(input().terminalDeadline);
    await expect(repository.admit(admittedUnderADifferentWindow)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('rejects a terminal deadline outside the bounded [MIN, MAX] window before opening a transaction', async () => {
    const connect = vi.fn();
    const repository = new PostgresReviewDispatchRepository({ connect } as any);
    await expect(repository.admit({ ...input(), terminalDeadline: input().receivedAt + MIN_TERMINAL_DEADLINE_MS - 1 }))
      .rejects.toThrow(/terminal deadline must be between/i);
    await expect(repository.admit({ ...input(), terminalDeadline: input().receivedAt + MAX_TERMINAL_DEADLINE_MS + 1 }))
      .rejects.toThrow(/terminal deadline must be between/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rolls back when the outbox insert fails so acknowledgement cannot lose work', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [row], [], []]);
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => ({ rows: [{ delivery_id: input().deliveryId }] }));
    client.query.mockImplementationOnce(async () => ({ rows: [row] }));
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => { throw new Error('outbox unavailable'); });
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) });

    await expect(repository.admit(input())).rejects.toThrow('outbox unavailable');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('claims pending or expired work with SKIP LOCKED and a renewable lease', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{
      run_id: row.run_id,
      delivery_id: input().deliveryId,
      claim_attempt: 7,
      execution_attempt: 0,
      repository_id: 123,
      installation_id: 456,
      publication_mode: 'disabled',
      owner: identity.owner,
      repo: identity.repo,
      pr_number: identity.prNumber,
      head_sha: identity.headSha,
      base_sha: identity.baseSha,
      received_at: new Date(1_000),
      terminal_deadline: new Date(1_000 + TERMINAL_DEADLINE_MS),
      effective_policy_digest: 'c'.repeat(64),
      effective_config_digest: identity.configDigest,
      lease_owner: 'dispatcher-a',
      lease_expires_at: new Date(31_000),
    }] }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });
    const claim = await repository.claimNext('dispatcher-a', 1_000, 30_000);
    expect(claim?.runId).toBe(row.run_id);
    expect(claim?.publicationMode).toBe('disabled');
    expect(claim).toEqual(expect.objectContaining({
      repo: 'calltelemetry/cisco-cdr',
      prNumber: 42,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      receivedAt: 1_000,
      terminalDeadline: 1_000 + TERMINAL_DEADLINE_MS,
      policyDigest: 'c'.repeat(64),
      configDigest: identity.configDigest,
      claimAttempt: 7,
      executionAttempt: 1,
    }));
    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE OF outbox SKIP LOCKED/u);
    expect(query.mock.calls[0][0]).toContain("outbox.status = 'pending'");
    expect(query.mock.calls[0][0]).toContain('execution_attempt');
    expect(query.mock.calls[0][0]).toContain('outbox.attempt AS claim_attempt');
    expect(await repository.heartbeat(row.run_id, 'dispatcher-a', claim!.claimAttempt, 2_000, 30_000)).toBe(true);
  });

  it('keeps active claims single-owner and stable across projection retries', async () => {
    let dispatchStatus: 'pending' | 'claimed' = 'pending';
    let leaseActive = false;
    let executionAttempt = 0;
    let claimAttempt = 0;
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (/WITH candidate/u.test(sql)) {
        // This stateful double follows the UPDATE ... RETURNING contract rather
        // than returning a hard-coded execution attempt. A projected row is not
        // claimable: only admit() after a durable failed/terminal run transition
        // re-arms it to pending, preventing a second dispatcher from minting a
        // fresh Kubernetes identity while the first worker is still starting.
        const normalized = sql.replace(/\s+/gu, ' ');
        expect(normalized).toContain("outbox.status = 'pending'");
        expect(normalized).not.toContain("outbox.status IN ('pending', 'projected')");
        expect(normalized).toContain('outbox.execution_attempt + 1 AS execution_attempt');
        const now = Number(values[1]);
        if (dispatchStatus === 'claimed' && leaseActive) return { rows: [] };
        dispatchStatus = 'claimed';
        leaseActive = true;
        const storedExecutionAttempt = executionAttempt;
        return { rows: [{
          run_id: row.run_id,
          delivery_id: input().deliveryId,
          claim_attempt: ++claimAttempt,
          execution_attempt: storedExecutionAttempt + 1,
          repository_id: 123,
          installation_id: 456,
          publication_mode: 'disabled',
          owner: identity.owner,
          repo: identity.repo,
          pr_number: identity.prNumber,
          head_sha: identity.headSha,
          base_sha: identity.baseSha,
          received_at: new Date(1_000),
          terminal_deadline: new Date(1_000 + TERMINAL_DEADLINE_MS),
          effective_policy_digest: 'c'.repeat(64),
          effective_config_digest: identity.configDigest,
          lease_owner: 'dispatcher-a',
          lease_expires_at: new Date(now + 30_000),
        }] };
      }
      if (/UPDATE review_dispatch_outbox\s+SET status = 'pending'/u.test(sql)) {
        dispatchStatus = 'pending';
        leaseActive = false;
        return { rows: [{ run_id: row.run_id }] };
      }
      return { rows: [{ run_id: row.run_id }] };
    });
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });

    const initial = await repository.claimNext('dispatcher-a', 1_000, 30_000);
    expect(initial?.executionAttempt).toBe(1);
    await expect(repository.claimNext('dispatcher-b', 2_000, 30_000)).resolves.toBeNull();
    await expect(repository.releaseForRetry(row.run_id, 'dispatcher-a', initial!.claimAttempt, 2_000, 3_000)).resolves.toBe(true);
    const infrastructureRetry = await repository.claimNext('dispatcher-a', 3_000, 30_000);
    expect(infrastructureRetry?.executionAttempt).toBe(1);
    expect(initial?.claimAttempt).toBe(1);
    expect(infrastructureRetry?.claimAttempt).toBe(2);
  });

  it('fails the run atomically while retaining token-bound projected executions and terminalizing unbound executions', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ run_id: row.run_id }] }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });
    await expect(repository.markTerminal(
      row.run_id,
      'dispatcher-a',
      7,
      1_000,
      'review job projection rejected',
    )).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    const sql = query.mock.calls[0][0].replace(/\s+/gu, ' ');
    expect(sql).toContain('WITH terminalized AS');
    expect(sql).toContain('UPDATE review_dispatch_outbox');
    // Pin both branches: a bound token can represent a worker with a lost ACK.
    // Keep its digest/execution until explicit admission rotates them; an
    // unbound failure has no worker to replace and remains safely terminal.
    expect(sql).toContain("SET status = CASE WHEN worker_token_digest IS NOT NULL THEN 'projected' ELSE 'terminal' END");
    expect(sql).not.toMatch(/\b(?:worker_token_digest|execution_attempt)\s*=/u);
    expect(sql).toContain('lease_owner = NULL, lease_expires_at = NULL');
    expect(sql).toContain('UPDATE review_runs AS runs');
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("FROM terminalized WHERE runs.run_id = terminalized.run_id AND runs.status = 'queued'");
    expect(sql).toContain("lease_owner = $2 AND status = 'claimed'");
    expect(query.mock.calls[0][1]).toEqual([
      row.run_id,
      'dispatcher-a',
      1_000,
      'review job projection rejected',
      7,
    ]);
  });

  it.each(['projected', 'claimed', 'pending'])('atomically records a matching failure from a %s execution', async (outboxStatus) => {
    const tokenDigest = 'a'.repeat(64);
    const query = vi.fn(async (sql: string, _values?: unknown[]) => /SELECT runs\.status/u.test(sql)
      ? { rows: [{
        ...row,
        repository_id: 123,
        publication_mode: 'app-gate',
        status: 'running',
        outbox_status: outboxStatus,
        execution_attempt: 0,
        worker_token_digest: tokenDigest,
      }] }
      : { rows: [{ run_id: row.run_id }] });
    const { repository, transactionQuery, release } = workerFailureRepository(query);
    const failure = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: row.run_id,
      owner: identity.owner,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      repositoryId: 123,
      policyDigest: identity.configDigest,
      configDigest: identity.configDigest,
      executionAttempt: 1,
      checkId: 4242,
      failureClass: 'provider_error' as const,
    };

    await expect(repository.markWorkerFailure(failure, { workerTokenDigest: tokenDigest }, 4_000)).resolves.toEqual({
      runId: row.run_id,
      status: 'failed',
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF runs, outbox');
    expect(query.mock.calls[1][0]).toContain("SET status = 'projected', lease_owner = NULL");
    expect(transactionQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(transactionQuery.mock.calls[1][1]).toEqual(['review-dispatch:123:42']);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[2][0]).replace(/\s+/gu, ' ');
    expect(sql).toContain("publication_mode = 'app-gate'");
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(sql).toContain("outbox.status = 'projected'");
    expect(sql).toContain('outbox.worker_token_digest = $13');
    expect(query.mock.calls[2][1]).toEqual([
      row.run_id,
      'worker terminal failure: provider_error',
      4_000,
      identity.owner,
      identity.repo,
      identity.prNumber,
      identity.headSha,
      identity.baseSha,
      123,
      identity.configDigest,
      identity.configDigest,
      1,
      tokenDigest,
    ]);
  });

  it.each([
    { name: 'missing run', runStatus: null, outboxStatus: 'projected' },
    { name: 'superseded run', runStatus: 'superseded', outboxStatus: 'projected' },
    { name: 'cancelled run', runStatus: 'cancelled', outboxStatus: 'projected' },
    { name: 'successful run', runStatus: 'succeeded', outboxStatus: 'projected' },
    { name: 'terminal outbox', runStatus: 'queued', outboxStatus: 'terminal' },
  ])('ignores a callback for $name without changing durable state', async ({ runStatus, outboxStatus }) => {
    const tokenDigest = 'a'.repeat(64);
    const query = vi.fn(async () => ({ rows: runStatus === null ? [] : [{
      ...row,
      repository_id: 123,
      publication_mode: 'app-gate',
      status: runStatus,
      outbox_status: outboxStatus,
      execution_attempt: 0,
      worker_token_digest: tokenDigest,
    }] }));
    const { repository, transactionQuery, release } = workerFailureRepository(query);
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1',
      runId: row.run_id,
      repositoryId: 123,
      owner: identity.owner,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      policyDigest: identity.configDigest,
      configDigest: identity.configDigest,
      executionAttempt: 1,
      failureClass: 'transport',
    }, { workerTokenDigest: tokenDigest }, 4_000)).resolves.toEqual({
      runId: row.run_id,
      status: 'ignored',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(transactionQuery.mock.calls.some(([sql]) => /\bUPDATE\s+(?:review_runs|review_dispatch_outbox)/u.test(sql))).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'terminal'])('treats a duplicate worker failure in %s state as already failed', async (status) => {
    const tokenDigest = 'a'.repeat(64);
    const query = vi.fn(async () => ({ rows: [{
      ...row,
      repository_id: 123,
      publication_mode: 'app-gate',
      status,
      outbox_status: 'projected',
      execution_attempt: 0,
      worker_token_digest: tokenDigest,
    }] }));
    const { repository } = workerFailureRepository(query);
    const failure = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: row.run_id,
      owner: identity.owner,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      repositoryId: 123,
      policyDigest: identity.configDigest,
      configDigest: identity.configDigest,
      executionAttempt: 1,
      checkId: 4242,
      failureClass: 'transport' as const,
    };

    await expect(repository.markWorkerFailure(failure, { workerTokenDigest: tokenDigest }, 4_500)).resolves.toEqual({
      runId: row.run_id,
      status: 'already_failed',
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'different bound token', stored: 'a'.repeat(64) },
    { name: 'unbound NULL token', stored: null },
    { name: 'missing token', stored: undefined },
    { name: 'empty token', stored: '' },
    { name: 'non-hex token', stored: 'z'.repeat(64) },
    { name: 'uppercase token', stored: 'B'.repeat(64) },
    { name: 'short token', stored: 'b'.repeat(63) },
    { name: 'long token', stored: 'b'.repeat(65) },
  ])('rejects a same-head callback with $name before any UPDATE', async ({ stored }) => {
    const query = vi.fn(async (sql: string) => /SELECT runs\.status/u.test(sql)
      ? { rows: [{
        ...row,
        repository_id: 123,
        publication_mode: 'app-gate',
        status: 'running',
        outbox_status: 'projected',
        execution_attempt: 0,
        worker_token_digest: stored,
      }] }
      : { rows: [{ run_id: row.run_id }] });
    const { repository, transactionQuery } = workerFailureRepository(query);
    const failure = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: row.run_id,
      repositoryId: 123,
      owner: identity.owner,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      policyDigest: identity.configDigest,
      configDigest: identity.configDigest,
      executionAttempt: 1,
      failureClass: 'provider_error' as const,
    };
    await expect(repository.markWorkerFailure(failure, { workerTokenDigest: 'b'.repeat(64) }, 4_100)).resolves.toEqual({
      runId: row.run_id,
      status: 'unauthorized',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(transactionQuery.mock.calls.some(([sql]) => /\bUPDATE\s+(?:review_runs|review_dispatch_outbox)/u.test(sql))).toBe(false);
  });

  it.each([
    { name: 'prior execution attempt', mismatch: { execution_attempt: 1 } },
    { name: 'different repository ID', mismatch: { repository_id: 124 } },
    { name: 'different owner', mismatch: { owner: 'another-owner' } },
    { name: 'different repository name', mismatch: { repo: 'another-repo' } },
    { name: 'different PR', mismatch: { pr_number: 43 } },
    { name: 'different head', mismatch: { head_sha: 'f'.repeat(40) } },
    { name: 'different base', mismatch: { base_sha: 'f'.repeat(40) } },
    { name: 'different policy', mismatch: { effective_policy_digest: 'f'.repeat(64) } },
    { name: 'different config', mismatch: { effective_config_digest: 'f'.repeat(64) } },
    { name: 'nonpublishing run', mismatch: { publication_mode: 'disabled' } },
  ])('rejects $name with an otherwise valid credential before any UPDATE', async ({ mismatch }) => {
    const query = vi.fn(async (sql: string) => /SELECT runs\.status/u.test(sql)
      ? { rows: [{
        ...row,
        repository_id: 123,
        publication_mode: 'app-gate',
        status: 'running',
        outbox_status: 'projected',
        execution_attempt: 0,
        worker_token_digest: 'b'.repeat(64),
        ...mismatch,
      }] }
      : { rows: [{ run_id: row.run_id }] });
    const { repository, transactionQuery } = workerFailureRepository(query);
    const failure = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: row.run_id,
      repositoryId: 123,
      owner: identity.owner,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      policyDigest: identity.configDigest,
      configDigest: identity.configDigest,
      executionAttempt: 1,
      failureClass: 'transport' as const,
    };
    await expect(repository.markWorkerFailure(failure, { workerTokenDigest: 'b'.repeat(64) }, 4_200)).resolves.toEqual({
      runId: row.run_id,
      status: 'unauthorized',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(transactionQuery.mock.calls.some(([sql]) => /\bUPDATE\s+(?:review_runs|review_dispatch_outbox)/u.test(sql))).toBe(false);
  });

  it.each(['NOT-A-DIGEST', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), ''])('rejects invalid worker digest %j before SQL', async (digest) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() }, { query });
    await expect(repository.markProjected(row.run_id, 'dispatcher-a', 1, 'projection', 1_000, digest))
      .rejects.toThrow('worker token digest must be 64 lowercase hex characters');
    await expect(repository.bindWorkerTokenDigest(row.run_id, 'dispatcher-a', 1, digest, 1_000))
      .rejects.toThrow('worker token digest must be 64 lowercase hex characters');
    expect(query).not.toHaveBeenCalled();
  });

  it('defines migration-safe delivery and outbox tables', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/persistence/postgresStore.ts'), 'utf8');
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS github_deliveries/u);
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS review_dispatch_outbox/u);
    expect(source).toMatch(/execution_attempt INTEGER NOT NULL DEFAULT 0/u);
    expect(source).toMatch(/ADD COLUMN IF NOT EXISTS execution_attempt INTEGER NOT NULL DEFAULT 0/u);
    expect(source).toMatch(/ADD COLUMN IF NOT EXISTS terminal_deadline/u);
    expect(source).toMatch(/ADD COLUMN IF NOT EXISTS publication_mode TEXT NOT NULL DEFAULT 'disabled'/u);
    expect(source).toMatch(/UPDATE review_runs SET publication_mode = 'disabled' WHERE publication_mode IS NULL/u);
    expect(source).toMatch(/ALTER COLUMN publication_mode SET DEFAULT 'disabled'/u);
    expect(source).toMatch(/ALTER COLUMN publication_mode SET NOT NULL/u);
    expect(source).toMatch(/publication_mode IN \('disabled', 'app-gate'\)/u);
  });
});

describe('claimAbandonedPublishingRuns (REL-586)', () => {
  const swept = {
    run_id: `run_${'1'.repeat(32)}`,
    owner: 'calltelemetry',
    repo: 'ct-meta',
    pr_number: 2795,
    head_sha: 'a'.repeat(40),
    delivery_id: 'delivery-1', execution_attempt: 2,
    received_at: new Date(1_000), terminal_deadline: new Date(901_000),
  };

  function repositoryWith(rows: unknown[]) {
    // Typed parameters so the call assertions below can read sql/values.
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows, rowCount: rows.length }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as never, { query } as never);
    return { repository, query };
  }

  it('binds expired publishing claims to a deadline (real eligibility is covered by the PostgreSQL lifecycle test)', async () => {
    // These three predicates are what keep the reaper from force-failing live
    // traffic. Dropping publication_mode would fail non-publishing runs; dropping
    // the status guard would fail runs a worker still owns; dropping the deadline
    // comparison would fail runs that are simply in flight.
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 20);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/runs.status IN \('queued', 'running'\)/u);
    expect(sql).toMatch(/publication_mode\s*=\s*'app-gate'/u);
    expect(sql).toMatch(/terminal_deadline\s*<=\s*to_timestamp\(\$2/u);
  });

  it('claims and marks terminal in a single statement, under SKIP LOCKED', async () => {
    // Two reapers must never both publish for one run. Splitting the SELECT and
    // UPDATE would lose that guarantee silently.
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 20);
    const sql = String(query.mock.calls[0][0]);
    expect(query).toHaveBeenCalledOnce();
    expect(sql).toMatch(/FOR UPDATE OF runs, outbox SKIP LOCKED/u);
    expect(sql).toMatch(/SET status = 'terminal'/u);
    expect(sql).toMatch(/UPDATE review_dispatch_outbox AS outbox/u);
    expect(sql).toMatch(/RETURNING/u);
  });

  it('prioritizes newly expired active runs over the historical terminal publication backlog', async () => {
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(
      /ORDER BY CASE WHEN runs\.status IN \('queued', 'running'\) THEN 0 ELSE 1 END,\s*runs\.terminal_deadline/u,
    );
  });

  // This assertion previously read `last_error`, a column that does not exist.
  // The test passed while every sweep threw
  // `column "last_error" of relation "review_runs" does not exist`, so the reaper
  // never marked anything terminal and 161 app-gate runs sat 'queued' forever --
  // each one a head that could never be re-dispatched. Pinning a column name is
  // only useful if it is the real one.
  it('records which reaper swept the run, in the column that exists', async () => {
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 20);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/error_text/u);
    expect(sql).not.toMatch(/last_error/u);
    expect(query.mock.calls[0][1]).toEqual(['reaper-a', 1_700_000_000_000, 20]);
  });

  it('declares the reaper identifier as text everywhere PostgreSQL infers its parameter type', async () => {
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 20);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/lease_owner = \$1::text/u);
    expect(sql).toMatch(/reaped by ' \|\| \$1::text/u);
  });

  it('maps returned rows to the identity the reaper publishes against', async () => {
    const { repository } = repositoryWith([swept]);
    await expect(repository.claimAbandonedPublishingRuns('reaper-a', 1, 20)).resolves.toEqual([{
      runId: swept.run_id,
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 2795,
      headSha: swept.head_sha,
      deliveryId: 'delivery-1', executionAttempt: 2, receivedAt: 1_000, terminalDeadline: 901_000,
    }]);
  });

  it('returns nothing when no run is abandoned', async () => {
    const { repository } = repositoryWith([]);
    await expect(repository.claimAbandonedPublishingRuns('reaper-a', 1, 20)).resolves.toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a non-positive-integer limit (%s)', async (limit) => {
    // An unbounded or malformed sweep could mint tokens without limit.
    const { repository, query } = repositoryWith([]);
    await expect(repository.claimAbandonedPublishingRuns('reaper-a', 1, limit as number))
      .rejects.toThrow(/positive integer/u);
    expect(query).not.toHaveBeenCalled();
  });
});
