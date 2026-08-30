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
    identity,
  };
}

function clientWithRows(rows: any[][]) {
  const query = vi.fn(async () => ({ rows: rows.shift() || [] }));
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
    const query = vi.fn(async () => ({ rows: [{
      run_id: row.run_id,
      delivery_id: input().deliveryId,
      repository_id: 123,
      installation_id: 456,
      lease_owner: 'dispatcher-a',
      lease_expires_at: new Date(31_000),
    }] }));
    const repository = new PostgresReviewDispatchRepository({ connect: vi.fn() } as any, { query });
    const claim = await repository.claimNext('dispatcher-a', 1_000, 30_000);
    expect(claim?.runId).toBe(row.run_id);
    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE OF outbox SKIP LOCKED/u);
    expect(await repository.heartbeat(row.run_id, 'dispatcher-a', 2_000, 30_000)).toBe(true);
  });

  it('defines migration-safe delivery and outbox tables', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/persistence/postgresStore.ts'), 'utf8');
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS github_deliveries/u);
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS review_dispatch_outbox/u);
    expect(source).toMatch(/ADD COLUMN IF NOT EXISTS terminal_deadline/u);
  });
});
