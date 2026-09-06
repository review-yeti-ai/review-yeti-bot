import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';

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
    terminalDeadline: 901_000,
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

describe('PostgresReviewDispatchRepository', () => {
  it('admits delivery, run, and one outbox row in one committed transaction', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [], [row], [], [], []]);
    const pool = { connect: vi.fn(async () => client) };
    const repository = new PostgresReviewDispatchRepository(pool);

    const result = await repository.admit(input());

    expect(result.status).toBe('accepted');
    expect(result.run.runId).toBe(row.run_id);
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/u)[0])).toEqual([
      'BEGIN', 'SELECT', 'INSERT', 'WITH', 'INSERT', 'UPDATE', 'INSERT', 'COMMIT',
    ]);
    expect(client.query.mock.calls[6][0]).toMatch(/review_dispatch_outbox/u);
    expect(client.query.mock.calls[3][0]).not.toContain('$6');
    expect(client.query.mock.calls[3][1]).toHaveLength(5);
    expect(client.query.mock.calls[4][0]).toMatch(/publication_mode/u);
    expect(client.query.mock.calls[4][1]).toContain('disabled');
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

  it('rolls back when the outbox insert fails so acknowledgement cannot lose work', async () => {
    const client = clientWithRows([[], [], [{ delivery_id: input().deliveryId }], [], [row], []]);
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => ({ rows: [{ delivery_id: input().deliveryId }] }));
    client.query.mockImplementationOnce(async () => ({ rows: [] }));
    client.query.mockImplementationOnce(async () => ({ rows: [row] }));
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
      repository_id: 123,
      installation_id: 456,
      publication_mode: 'disabled',
      owner: identity.owner,
      repo: identity.repo,
      pr_number: identity.prNumber,
      head_sha: identity.headSha,
      base_sha: identity.baseSha,
      received_at: new Date(1_000),
      terminal_deadline: new Date(901_000),
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
      terminalDeadline: 901_000,
      policyDigest: 'c'.repeat(64),
      configDigest: identity.configDigest,
    }));
    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE OF outbox SKIP LOCKED/u);
    expect(await repository.heartbeat(row.run_id, 'dispatcher-a', 2_000, 30_000)).toBe(true);
  });

  it('terminalizes both the outbox and run only for the owning dispatcher lease', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ run_id: row.run_id }] }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });
    await expect(repository.markTerminal(
      row.run_id,
      'dispatcher-a',
      1_000,
      'review job projection rejected',
    )).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/WITH terminalized AS/u);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE review_dispatch_outbox/u);
    expect(query.mock.calls[0][0]).toMatch(/SET status = 'terminal'/u);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE review_runs/u);
    expect(query.mock.calls[0][0]).toMatch(/SET status = 'failed'/u);
    expect(query.mock.calls[0][0]).toMatch(/lease_owner = \$2 AND status = 'claimed'/u);
    expect(query.mock.calls[0][1]).toEqual([
      row.run_id,
      'dispatcher-a',
      1_000,
      'review job projection rejected',
    ]);
  });

  it('defines migration-safe delivery and outbox tables', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/persistence/postgresStore.ts'), 'utf8');
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS github_deliveries/u);
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS review_dispatch_outbox/u);
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
  };

  function repositoryWith(rows: unknown[]) {
    // Typed parameters so the call assertions below can read sql/values.
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows, rowCount: rows.length }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as never, { query } as never);
    return { repository, query };
  }

  it('sweeps only queued app-gate runs whose deadline has passed', async () => {
    // These three predicates are what keep the reaper from force-failing live
    // traffic. Dropping publication_mode would fail non-publishing runs; dropping
    // the status guard would fail runs a worker still owns; dropping the deadline
    // comparison would fail runs that are simply in flight.
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 20);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/status\s*=\s*'queued'/u);
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
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/u);
    expect(sql).toMatch(/SET status = 'terminal'/u);
    expect(sql).toMatch(/RETURNING/u);
  });

  it('records which reaper swept the run', async () => {
    const { repository, query } = repositoryWith([swept]);
    await repository.claimAbandonedPublishingRuns('reaper-a', 1_700_000_000_000, 20);
    expect(String(query.mock.calls[0][0])).toMatch(/last_error/u);
    expect(query.mock.calls[0][1]).toEqual(['reaper-a', 1_700_000_000_000, 20]);
  });

  it('maps returned rows to the identity the reaper publishes against', async () => {
    const { repository } = repositoryWith([swept]);
    await expect(repository.claimAbandonedPublishingRuns('reaper-a', 1, 20)).resolves.toEqual([{
      runId: swept.run_id,
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 2795,
      headSha: swept.head_sha,
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
