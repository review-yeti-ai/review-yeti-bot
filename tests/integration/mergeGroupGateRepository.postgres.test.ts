import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { PostgresMergeGroupGateRepository } from '../../src/persistence/mergeGroupGateRepository';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import {
  describeWithPostgres as describeWithPostgresShared,
  postgresDatabaseUrl,
  requireDatabaseUrlInCi,
} from '../support/postgresSuite';

requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();
const describeWithPostgres = describeWithPostgresShared;
const OWNED_SCHEMA = /^merge_group_gate_[0-9a-f]{16}$/u;
const LEGACY_REPOSITORY_ID = 1_987_650_123;
const LEGACY_HEAD = 'a'.repeat(40);
const LEGACY_CHECK_ID = 987_650_123;
const LEGACY_CONCLUSION = 'success';

class IsolatedPostgresStore extends PostgresStore {
  constructor(private readonly isolatedPool: Pool) { super(); }

  public override isConfigured(): boolean { return true; }

  public override getPool(): Pool { return this.isolatedPool; }
}

interface GateIdentity {
  repositoryId: number;
  headSha: string;
  snapshotDigest: string;
}

function identity(overrides: Partial<GateIdentity> = {}): GateIdentity {
  return {
    repositoryId: randomInt(2_000_000_000, 2_100_000_000),
    headSha: randomBytes(20).toString('hex'),
    snapshotDigest: randomBytes(32).toString('hex'),
    ...overrides,
  };
}

function claimToken(): string { return randomUUID(); }

describeWithPostgres('PostgresMergeGroupGateRepository durable publication lifecycle', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let schemaName = '';
  let store: IsolatedPostgresStore;
  let repository: PostgresMergeGroupGateRepository;

  async function publicationRow(candidate: GateIdentity): Promise<Record<string, unknown> | undefined> {
    const result = await pool!.query(`SELECT repository_id, head_sha, snapshot_digest, check_id,
      check_creation_started, conclusion, claim_token, lease_expires_at
      FROM merge_group_gate_publications
      WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3`,
    [candidate.repositoryId, candidate.headSha, candidate.snapshotDigest]);
    return result.rows[0];
  }

  beforeAll(async () => {
    schemaName = `merge_group_gate_${randomBytes(8).toString('hex')}`;
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schemaName},public`,
      application_name: schemaName,
    });

    // Model the pre-snapshot merge_group_gates table. Its check ID is historical
    // only: the migration must preserve it without inventing a v2 snapshot key.
    await pool.query(`CREATE TABLE merge_group_gates (
      repository_id BIGINT NOT NULL,
      head_sha CHAR(40) NOT NULL,
      check_id BIGINT NOT NULL,
      conclusion TEXT CHECK (conclusion IN ('success','failure')),
      claim_token UUID,
      lease_expires_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, head_sha)
    )`);
    await pool.query(`INSERT INTO merge_group_gates(repository_id,head_sha,check_id,conclusion)
      VALUES($1,$2,$3,$4)`, [LEGACY_REPOSITORY_ID, LEGACY_HEAD, LEGACY_CHECK_ID, LEGACY_CONCLUSION]);

    store = new IsolatedPostgresStore(pool);
    await store.initialize();
    repository = new PostgresMergeGroupGateRepository(pool);
  });

  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      try {
        if (adminPool && OWNED_SCHEMA.test(schemaName)) {
          await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
        }
      } finally {
        await adminPool?.end();
      }
    }
  });

  it('reapplies the durable schema and preserves unbound legacy check history', async () => {
    await store.initialize();
    await store.initialize();

    const tables = await pool!.query(`SELECT
      to_regclass('merge_group_gates') IS NOT NULL AS legacy_table,
      to_regclass('merge_group_gate_publications') IS NOT NULL AS publications_table`);
    expect(tables.rows[0]).toEqual({ legacy_table: true, publications_table: true });

    const legacy = await pool!.query(`SELECT repository_id,head_sha,check_id,conclusion
      FROM merge_group_gates WHERE repository_id=$1 AND head_sha=$2`, [LEGACY_REPOSITORY_ID, LEGACY_HEAD]);
    expect(legacy.rows).toEqual([{
      repository_id: String(LEGACY_REPOSITORY_ID),
      head_sha: LEGACY_HEAD,
      check_id: String(LEGACY_CHECK_ID),
      conclusion: LEGACY_CONCLUSION,
    }]);

    const v2 = await pool!.query(`SELECT 1 FROM merge_group_gate_publications
      WHERE repository_id=$1 AND head_sha=$2`, [LEGACY_REPOSITORY_ID, LEGACY_HEAD]);
    expect(v2.rows).toEqual([]);
  });

  it('commits a first create reservation and keeps an unknown acknowledgement reconcile-only', async () => {
    const candidate = identity();
    const firstOwner = claimToken();
    await expect(repository.claim(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner)).resolves.toEqual({ status: 'acquired' });

    const notCreated = await publicationRow(candidate);
    expect(notCreated).toMatchObject({ check_id: null, check_creation_started: false, conclusion: null });
    await expect(repository.reserveCheckCreation(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner)).resolves.toBe(true);
    await repository.release(candidate.repositoryId, candidate.headSha, candidate.snapshotDigest, firstOwner);

    const afterUnknownAcknowledgement = await publicationRow(candidate);
    expect(afterUnknownAcknowledgement).toMatchObject({
      check_id: null,
      check_creation_started: true,
      conclusion: null,
      claim_token: null,
      lease_expires_at: null,
    });

    const retryOwner = claimToken();
    await expect(repository.claim(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, retryOwner)).resolves.toEqual({ status: 'acquired' });
    await expect(repository.reserveCheckCreation(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, retryOwner)).resolves.toBe(false);
    await expect(publicationRow(candidate)).resolves.toMatchObject({
      check_id: null,
      check_creation_started: true,
      conclusion: null,
    });
    await repository.release(candidate.repositoryId, candidate.headSha, candidate.snapshotDigest, retryOwner);
  });

  it('binds one exact reconciled check and requalifies a cached terminal result', async () => {
    const candidate = identity();
    const firstOwner = claimToken();
    await expect(repository.claim(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner)).resolves.toEqual({ status: 'acquired' });
    await expect(repository.reserveCheckCreation(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner)).resolves.toBe(true);

    const exactCheckId = 7_654_321;
    await repository.bindCheck(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner, exactCheckId);
    await expect(repository.bindCheck(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner, exactCheckId)).resolves.toBeUndefined();
    await expect(repository.bindCheck(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, firstOwner, exactCheckId + 1)).rejects.toThrow();

    await repository.complete(candidate.repositoryId, candidate.headSha, candidate.snapshotDigest, firstOwner, {
      checkId: exactCheckId,
      conclusion: 'success',
      snapshotDigest: candidate.snapshotDigest,
    });
    await expect(publicationRow(candidate)).resolves.toMatchObject({
      check_id: String(exactCheckId),
      check_creation_started: true,
      conclusion: 'success',
      claim_token: null,
      lease_expires_at: null,
    });

    const requalificationOwner = claimToken();
    await expect(repository.claim(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, requalificationOwner)).resolves.toEqual({ status: 'acquired' });
    await expect(publicationRow(candidate)).resolves.toMatchObject({
      check_id: String(exactCheckId),
      check_creation_started: true,
      conclusion: null,
    });
    await expect(repository.reserveCheckCreation(candidate.repositoryId, candidate.headSha,
      candidate.snapshotDigest, requalificationOwner)).resolves.toBe(false);
    await repository.release(candidate.repositoryId, candidate.headSha, candidate.snapshotDigest, requalificationOwner);
  });

  it('preserves an uncertain prior snapshot and fences a new mode identity until exact settlement', async () => {
    const prior = identity();
    const modeBoundSnapshot = {
      version: 'ReviewYetiMergeQueueSnapshot.v1',
      repositoryId: prior.repositoryId,
      repository: 'review-yeti-ai/review-yeti-bot',
      queueId: 'Q_merge_group_gate_integration',
      groupHeadSha: prior.headSha,
      entries: [{ position: 1, headSha: prior.headSha }],
    };
    prior.snapshotDigest = sha256(canonicalJson({ ...modeBoundSnapshot, operatorPassthroughEnabled: false }));
    const current = { ...prior,
      snapshotDigest: sha256(canonicalJson({ ...modeBoundSnapshot, operatorPassthroughEnabled: true })) };
    expect(current.snapshotDigest).not.toBe(prior.snapshotDigest);

    const priorOwner = claimToken();
    await expect(repository.claim(prior.repositoryId, prior.headSha, prior.snapshotDigest,
      priorOwner)).resolves.toEqual({ status: 'acquired' });
    await expect(repository.reserveCheckCreation(prior.repositoryId, prior.headSha, prior.snapshotDigest,
      priorOwner)).resolves.toBe(true);
    await repository.release(prior.repositoryId, prior.headSha, prior.snapshotDigest, priorOwner);

    const priorAfterUnknownAck = await publicationRow(prior);
    expect(priorAfterUnknownAck).toMatchObject({
      check_id: null,
      check_creation_started: true,
      conclusion: null,
      claim_token: null,
      lease_expires_at: null,
    });

    const currentOwner = claimToken();
    await expect(repository.claim(current.repositoryId, current.headSha, current.snapshotDigest,
      currentOwner)).resolves.toEqual({ status: 'acquired' });
    await expect(publicationRow(current)).resolves.toMatchObject({
      check_id: null,
      check_creation_started: false,
      conclusion: null,
    });
    await expect(repository.listPriorPublications(current.repositoryId, current.headSha,
      current.snapshotDigest, currentOwner)).resolves.toEqual([{
      snapshotDigest: prior.snapshotDigest,
      checkId: null,
      checkCreationStarted: true,
      conclusion: null,
    }]);
    await expect(repository.reserveCheckCreation(current.repositoryId, current.headSha,
      current.snapshotDigest, currentOwner)).resolves.toBe(false);
    await expect(publicationRow(prior)).resolves.toMatchObject({
      check_id: null,
      check_creation_started: true,
      conclusion: null,
    });
    await expect(publicationRow(current)).resolves.toMatchObject({
      check_id: null,
      check_creation_started: false,
      conclusion: null,
    });

    // The current owner has reconciled the exact old external ID and retired
    // that check. This durable settlement releases the same-head create fence.
    const exactPriorCheckId = 8_765_432;
    await repository.settlePriorPublication(current.repositoryId, current.headSha, current.snapshotDigest,
      currentOwner, prior.snapshotDigest, exactPriorCheckId);
    await expect(repository.listPriorPublications(current.repositoryId, current.headSha,
      current.snapshotDigest, currentOwner)).resolves.toEqual([]);
    await expect(publicationRow(prior)).resolves.toMatchObject({
      check_id: String(exactPriorCheckId),
      check_creation_started: true,
      conclusion: 'failure',
      claim_token: null,
      lease_expires_at: null,
    });

    await expect(repository.reserveCheckCreation(current.repositoryId, current.headSha,
      current.snapshotDigest, currentOwner)).resolves.toBe(true);
    await expect(publicationRow(current)).resolves.toMatchObject({
      check_id: null,
      check_creation_started: true,
      conclusion: null,
    });

    const publications = await pool!.query(`SELECT snapshot_digest,check_id,check_creation_started,conclusion
      FROM merge_group_gate_publications WHERE repository_id=$1 AND head_sha=$2 ORDER BY snapshot_digest`,
    [prior.repositoryId, prior.headSha]);
    expect(publications.rows).toHaveLength(2);
    expect(publications.rows).toContainEqual(expect.objectContaining({
      snapshot_digest: prior.snapshotDigest,
      check_id: String(exactPriorCheckId),
      check_creation_started: true,
      conclusion: 'failure',
    }));
    expect(publications.rows).toContainEqual(expect.objectContaining({
      snapshot_digest: current.snapshotDigest,
      check_id: null,
      check_creation_started: true,
      conclusion: null,
    }));
    await repository.release(current.repositoryId, current.headSha, current.snapshotDigest, currentOwner);
  });
});
