import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { PostgresOperatorMaintenanceRepository } from '../../src/persistence/operatorMaintenanceRepository';
import {
  createOperatorMaintenanceIntentId,
  type OperatorMaintenanceIdentity,
  type OperatorMaintenanceReceiptV1,
} from '../../src/review/operatorMaintenanceContracts';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();
const ownedSchema = /^operator_maintenance_test_[a-f0-9]{16}$/u;

describeWithPostgres('operator maintenance persistence (real PostgreSQL)', () => {
  let adminPool: Pool | undefined;
  let scopedPool: Pool | undefined;
  let schemaName = '';
  let scopedUrl = '';
  let previousDatabaseUrl: string | undefined;
  let repository: PostgresOperatorMaintenanceRepository;

  async function initializeStore(): Promise<void> {
    const store = new PostgresStore();
    try {
      await store.initialize();
    } finally {
      await store.close();
    }
  }

  beforeAll(async () => {
    schemaName = `operator_maintenance_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schemaName)) throw new Error(`Generated schema is not owned by this test: ${schemaName}`);
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    scopedPool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schemaName}` });
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    scopedUrl = url.toString();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scopedUrl;
    try {
      await initializeStore();
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    repository = new PostgresOperatorMaintenanceRepository(scopedPool);
  });

  beforeEach(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scopedUrl;
    await scopedPool!.query('TRUNCATE operator_maintenance_intents');
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  afterAll(async () => {
    try {
      if (adminPool && ownedSchema.test(schemaName)) await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await scopedPool?.end();
      await adminPool?.end();
    }
  });

  it('installs the maintenance intent table through existing PostgresStore initialization without a review-run foreign key', async () => {
    await initializeStore();
    await initializeStore();

    const table = await scopedPool!.query(`SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'operator_maintenance_intents'`);
    expect(table.rows.map((row) => row.table_name)).toEqual(['operator_maintenance_intents']);

    const foreignKeys = await scopedPool!.query(`SELECT COUNT(*)::int AS count
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
      WHERE schema_row.nspname = current_schema()
        AND table_row.relname = 'operator_maintenance_intents'
        AND constraint_row.contype = 'f'`);
    expect(foreignKeys.rows[0].count).toBe(0);
  });

  it('reuses a target across admission sources but rejects changed immutable policy or authority', async () => {
    const receipt = makeReceipt();
    const first = await repository.reserve(receipt);
    const intentDigest = receipt.intentId.slice('operator-maintenance:v1:'.length);
    expect(first.checks.raw.externalId).toBe(`review-yeti-maintenance:v1:${intentDigest}:raw`);
    expect(first.checks.gate.externalId).toBe(`review-yeti-maintenance:v1:${intentDigest}:gate`);
    const replay = await repository.reserve({ ...receipt, source: 'mcp-trigger' });
    expect(replay).toEqual(first);

    const immutableMutations: OperatorMaintenanceReceiptV1[] = [
      { ...receipt, authority: { ...receipt.authority, configDigest: 'd'.repeat(64) } },
      { ...receipt, policy: { ...receipt.policy, effectivePolicyDigest: '7'.repeat(64) } },
      { ...receipt, policy: { ...receipt.policy, effectiveConfigDigest: '6'.repeat(64) } },
      { ...receipt, policy: { ...receipt.policy, sources: [{ ...receipt.policy.sources[0], contentDigest: '5'.repeat(64) }] } },
      { ...receipt, checks: { ...receipt.checks, raw: { ...receipt.checks.raw, appId: 987654 } } },
    ];
    for (const mutation of immutableMutations) {
      await expect(repository.reserve(mutation)).rejects.toThrow(/conflicts with persisted immutable/u);
    }

    const row = await scopedPool!.query(`SELECT COUNT(*)::int AS count
      FROM operator_maintenance_intents WHERE identity_digest = $1`, [
      receipt.intentId.slice('operator-maintenance:v1:'.length),
    ]);
    expect(row.rows[0].count).toBe(1);
  });

  it('lists only a bounded page of pending intents and advances by the stable intent cursor', async () => {
    const base = makeReceipt();
    const receipts = [base, makeReceipt({ ...base.identity, headSha: 'd'.repeat(40) }),
      makeReceipt({ ...base.identity, headSha: 'e'.repeat(40) })];
    const ordered = [...receipts].sort((left, right) => left.intentId.localeCompare(right.intentId));
    for (const receipt of receipts) await repository.reserve(receipt);
    const first = await repository.listPending(2);
    expect(first.map(({ intentId }) => intentId)).toEqual(ordered.slice(0, 2).map(({ intentId }) => intentId));
    const next = await repository.listPending(2, first.at(-1)!.intentId);
    expect(next.map(({ intentId }) => intentId)).toEqual([ordered[2].intentId]);
    await repository.markStale(ordered[1].intentId, new Date('2026-10-05T12:00:00.000Z'));
    expect((await repository.listPending(10)).map(({ intentId }) => intentId)).not.toContain(ordered[1].intentId);
    await expect(repository.listPending(0)).rejects.toThrow();
    await expect(repository.listPending(101)).rejects.toThrow();
  });

  it('uses distinct identity-only intents for pull requests and merge groups without a fake PR number', async () => {
    const pullRequest = makeReceipt();
    const mergeGroupIdentity: OperatorMaintenanceIdentity = {
      ...pullRequest.identity,
      subject: { kind: 'merge_group', headRef: 'refs/heads/gh-readonly-queue/main/pr-71-abc123', baseRef: 'refs/heads/main' },
    };
    const mergeGroup = makeReceipt(mergeGroupIdentity);
    expect(mergeGroup.intentId).toBe(createOperatorMaintenanceIntentId(mergeGroupIdentity));
    expect(mergeGroup.intentId).not.toBe(pullRequest.intentId);
    expect(mergeGroup.identity.subject).not.toHaveProperty('prNumber');
    expect(mergeGroup.policyResolution).toEqual({ repositoryId: mergeGroupIdentity.repositoryId,
      owner: mergeGroupIdentity.owner, repo: mergeGroupIdentity.repo, prNumber: 71,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) });
    await repository.reserve(pullRequest);
    await repository.reserve(mergeGroup);

    const rows = await scopedPool!.query('SELECT COUNT(*)::int AS count FROM operator_maintenance_intents');
    expect(rows.rows[0].count).toBe(2);
  });

  it('serializes concurrent raw claims and fences expired-lease recovery through partial publication', async () => {
    const receipt = await repository.reserve(makeReceipt());
    const now = new Date('2026-10-05T12:00:00.000Z');
    const simultaneous = await Promise.all([
      repository.claimRaw(receipt.intentId, now, 1_000),
      repository.claimRaw(receipt.intentId, now, 1_000),
    ]);
    expect(simultaneous.filter((result) => result.kind === 'lease')).toHaveLength(1);
    expect(simultaneous.filter((result) => result.kind === 'busy')).toHaveLength(1);
    const firstLease = simultaneous.find((result) => result.kind === 'lease');
    if (!firstLease || firstLease.kind !== 'lease') throw new Error('Expected the initial raw lease');
    expect(firstLease.reconcileFirst).toBe(true);
    expect(await repository.claimGate(receipt.intentId, now, 1_000)).toEqual({ kind: 'blocked' });

    expect(await repository.claimRaw(receipt.intentId, new Date(now.getTime() + 500), 1_000)).toEqual({ kind: 'busy' });
    const recoveredRaw = await repository.claimRaw(receipt.intentId, new Date(now.getTime() + 1_001), 1_000);
    expect(recoveredRaw.kind).toBe('lease');
    if (recoveredRaw.kind !== 'lease') throw new Error('Expected expired raw lease recovery');
    expect(recoveredRaw.reconcileFirst).toBe(true);
    expect(recoveredRaw.leaseToken).not.toBe(firstLease.leaseToken);
    await expect(repository.bindRaw(receipt.intentId, firstLease.leaseToken, 101, new Date(now.getTime() + 1_002)))
      .rejects.toThrow(/stale, expired, or fenced/u);
    await repository.bindRaw(receipt.intentId, recoveredRaw.leaseToken, 101, new Date(now.getTime() + 1_002));
    expect(await repository.claimRaw(receipt.intentId, new Date(now.getTime() + 1_003), 1_000))
      .toEqual({ kind: 'bound', checkId: 101 });

    const firstGate = await repository.claimGate(receipt.intentId, new Date(now.getTime() + 1_003), 1_000);
    expect(firstGate.kind).toBe('lease');
    if (firstGate.kind !== 'lease') throw new Error('Expected the gate lease');
    const recoveredGate = await repository.claimGate(receipt.intentId, new Date(now.getTime() + 2_004), 1_000);
    expect(recoveredGate.kind).toBe('lease');
    if (recoveredGate.kind !== 'lease') throw new Error('Expected gate lease recovery');
    await expect(repository.bindGate(receipt.intentId, firstGate.leaseToken, 202, new Date(now.getTime() + 2_005)))
      .rejects.toThrow(/stale, expired, or fenced/u);
    await repository.bindGate(receipt.intentId, recoveredGate.leaseToken, 202, new Date(now.getTime() + 2_005));
    expect(await repository.claimGate(receipt.intentId, new Date(now.getTime() + 2_006), 1_000))
      .toEqual({ kind: 'bound', checkId: 202 });
  });

  it('marks an intent stale without allowing claims and allows a changed head as a new target', async () => {
    const receipt = await repository.reserve(makeReceipt());
    const now = new Date('2026-10-05T13:00:00.000Z');
    const activeClaim = await repository.claimRaw(receipt.intentId, now, 1_000);
    expect(activeClaim.kind).toBe('lease');
    await repository.markStale(receipt.intentId, now);
    expect(await repository.claimRaw(receipt.intentId, now, 1_000)).toEqual({ kind: 'stale' });
    if (activeClaim.kind === 'lease') {
      await expect(repository.bindRaw(receipt.intentId, activeClaim.leaseToken, 303, now))
        .rejects.toThrow(/stale, expired, or fenced/u);
    }

    const changedHead = makeReceipt({ ...receipt.identity, headSha: 'd'.repeat(40) });
    expect(changedHead.intentId).not.toBe(receipt.intentId);
    await repository.reserve(changedHead);
    expect((await repository.claimRaw(changedHead.intentId, now, 1_000)).kind).toBe('lease');
  });
});

function makeReceipt(identity: OperatorMaintenanceIdentity = {
  repositoryId: 12345,
  owner: 'review-yeti-ai',
  repo: 'public-fixture',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  subject: { kind: 'pull_request', prNumber: 71 },
}): OperatorMaintenanceReceiptV1 {
  const intentId = createOperatorMaintenanceIntentId(identity);
  return {
    version: 'OperatorMaintenanceReceipt.v1',
    intentId,
    source: 'github-app-webhook',
    mode: 'passthrough',
    decision: 'SHIP',
    reason: 'operator_global_passthrough',
    reviewCompleted: false,
    identity,
    ...(identity.subject.kind === 'merge_group' ? { policyResolution: {
      repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
      prNumber: 71, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    } } : {}),
    authority: {
      kind: 'trusted-runtime-operator-config',
      setting: 'REVIEW_YETI_PASSTHROUGH',
      configDigest: 'c'.repeat(64),
    },
    policy: {
      effectivePolicyDigest: 'e'.repeat(64),
      effectiveConfigDigest: 'f'.repeat(64),
      sources: [{
        repositoryId: 12345,
        repository: 'review-yeti-ai/public-fixture',
        sha: '9'.repeat(40),
        path: '.github/review-yeti.yml',
        contentDigest: '8'.repeat(64),
      }],
    },
    checks: {
      raw: { name: 'Review Yeti', appId: 4385771, externalId: `review-yeti-maintenance:v1:${intentId.slice('operator-maintenance:v1:'.length)}:raw` },
      gate: { name: 'Review Yeti Gate', appId: 4385771, externalId: `review-yeti-maintenance:v1:${intentId.slice('operator-maintenance:v1:'.length)}:gate` },
    },
  };
}
