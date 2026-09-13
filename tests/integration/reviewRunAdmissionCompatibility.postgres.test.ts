import { randomBytes } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { sha256 } from '../../src/review/reviewCore';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';
import { PostgresStore } from '../../src/persistence/postgresStore';
import {
  PostgresReviewRunRepository,
  type ReviewRunIdentity,
} from '../../src/persistence/reviewRunRepository';
import { reviewPrLockKey } from '../../src/persistence/reviewPrTransaction';

const configuredDatabaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl || '';

const repositoryId = 123;
const owner = 'calltelemetry';
const repo = 'review-yeti';
const baseIdentity: ReviewRunIdentity = {
  owner,
  repo,
  prNumber: 640,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};
const baseTime = new Date('2026-09-13T12:00:00.000Z').getTime();

type EnvSnapshot = Record<string, { present: boolean; value?: string }>;

function snapshotEnv(names: string[]): EnvSnapshot {
  return Object.fromEntries(
    names.map((name) => [name, { present: Object.hasOwn(process.env, name), value: process.env[name] }]),
  );
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, state] of Object.entries(snapshot)) {
    if (state.present) {
      process.env[name] = state.value;
    } else {
      delete process.env[name];
    }
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^review_run_admission_[a-f0-9]{16}$/u.test(identifier)) {
    throw new Error('Unexpected test schema identifier');
  }
  return `"${identifier}"`;
}

function scopedDatabaseUrl(schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return url.toString();
}

function identity(overrides: Partial<ReviewRunIdentity> = {}): ReviewRunIdentity {
  return { ...baseIdentity, ...overrides };
}

function runIdFor(runIdentity: ReviewRunIdentity): string {
  return deriveReviewRunId(runIdentity);
}

async function insertRun(
  pool: Pool,
  runIdentity: ReviewRunIdentity,
  overrides: Partial<{
    repositoryId: number | null;
    status: string;
    stage: string;
    attempt: number;
    runId: string;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
): Promise<string> {
  const runId = overrides.runId ?? runIdFor(runIdentity);
  const createdAt = overrides.createdAt ?? new Date(baseTime);
  const updatedAt = overrides.updatedAt ?? createdAt;
  await pool.query(
    `
      INSERT INTO review_runs (
      run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
        snapshot_digest, config_digest, effective_policy_digest,
        effective_config_digest, identity, repository_id, status, stage,
        attempt, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
        $13, $14, $15, $16, $17, $18
      )
    `,
    [
      runId,
      sha256(runIdentity),
      runIdentity.owner,
      runIdentity.repo,
      runIdentity.prNumber,
      runIdentity.headSha,
      runIdentity.baseSha,
      runIdentity.snapshotDigest,
      runIdentity.configDigest,
      runIdentity.snapshotDigest,
      runIdentity.configDigest,
      JSON.stringify(runIdentity),
      overrides.repositoryId === undefined ? repositoryId : overrides.repositoryId,
      overrides.status ?? 'queued',
      overrides.stage ?? 'queued',
      overrides.attempt ?? 0,
      createdAt,
      updatedAt,
    ],
  );
  return runId;
}

async function countRows(pool: Pool, table: string): Promise<number> {
  if (!/^review_(?:runs|dispatch_outbox|event_outbox|event_sequence_counters)$/u.test(table)) {
    throw new Error('Unexpected test table name');
  }
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0].count);
}

async function runRow(pool: Pool, runId: string): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM review_runs WHERE run_id = $1',
    [runId],
  );
  return result.rows[0];
}

async function eventRows(pool: Pool, runId: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM review_event_outbox WHERE run_id = $1 ORDER BY event_id',
    [runId],
  );
  return result.rows;
}

async function truncateFixture(pool: Pool): Promise<void> {
  await pool.query(
    `
      TRUNCATE TABLE
        review_event_v2_outbox,
        review_event_v2_sequence_counters,
        review_event_outbox,
        review_event_sequence_counters,
        review_dispatch_outbox,
        review_runs
      CASCADE
    `,
  );
}

function interposedPool(
  pool: Pool,
  onFirstIdentityMiss: () => Promise<void>,
  observations: string[],
  onEmptyInsert?: () => Promise<void>,
  onPrLockAcquired?: () => Promise<void>,
): { connect(): Promise<{
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}> } {
  return {
    async connect() {
      const client: PoolClient = await pool.connect();
      let identityLookups = 0;
      return {
        async query(text: string, values?: unknown[]) {
          const result = await client.query(text, values);
          if (/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/u.test(text) && onPrLockAcquired) {
            await onPrLockAcquired();
          }
          if (/SELECT \* FROM review_runs WHERE identity_digest = \$1 FOR UPDATE/u.test(text)) {
            identityLookups += 1;
            if (identityLookups === 1 && result.rows.length === 0) {
              observations.push('first-identity-miss');
              await onFirstIdentityMiss();
            } else if (identityLookups === 2) {
              observations.push('recovery-identity-select');
            }
          }
          if (/INSERT INTO review_runs/u.test(text) && /ON CONFLICT \(identity_digest\) DO NOTHING/u.test(text)) {
            observations.push(`insert-returning-${result.rows.length}`);
            if (result.rows.length === 0 && onEmptyInsert) await onEmptyInsert();
          }
          return result;
        },
        release() {
          client.release();
        },
      };
    },
  };
}

async function writeWithDisabledRepository(
  pool: Pool,
  runIdentity: ReviewRunIdentity,
  repositoryBinding: number | null | undefined = undefined,
): Promise<string> {
  const legacy = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'disabled' });
  const record = await legacy.createOrGet({ identity: runIdentity, now: baseTime });
  if (repositoryBinding !== undefined) {
    await pool.query('UPDATE review_runs SET repository_id = $2 WHERE run_id = $1', [record.runId, repositoryBinding]);
  }
  return record.runId;
}

async function writeNonParticipatingRun(
  pool: Pool,
  runIdentity: ReviewRunIdentity,
  repositoryBinding: number | null | undefined = undefined,
): Promise<string> {
  const runId = await insertRun(pool, runIdentity, { repositoryId: repositoryBinding });
  return runId;
}

async function canAcquirePrLock(pool: Pool, runIdentity: ReviewRunIdentity): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
      [reviewPrLockKey(repositoryId, runIdentity.prNumber)],
    );
    return result.rows[0]?.acquired === true;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

let bootstrapPool: Pool | undefined;
let store: PostgresStore | undefined;
let pool: Pool | undefined;
let schema: string | undefined;
let environment: EnvSnapshot;
let nextUniquePrNumber = 700;

beforeAll(async () => {
  if (!databaseUrl) {
    throw new Error('REVIEW_YETI_TEST_DATABASE_URL is required for this compatibility suite');
  }
  environment = snapshotEnv(['DATABASE_URL', 'POSTGRES_URL']);
  bootstrapPool = new Pool({ connectionString: databaseUrl, max: 2 });
  schema = `review_run_admission_${randomBytes(8).toString('hex')}`;
  const quotedSchema = quoteIdentifier(schema);
  try {
    await bootstrapPool.query(`CREATE SCHEMA ${quotedSchema}`);
    process.env.DATABASE_URL = scopedDatabaseUrl(schema);
    delete process.env.POSTGRES_URL;
    store = new PostgresStore();
    await store.initialize();
    pool = store.getPool();
  } catch (error) {
    if (store) {
      await store.getPool().end().catch(() => undefined);
    }
    if (schema) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
    }
    await bootstrapPool.end().catch(() => undefined);
    restoreEnv(environment);
    throw error;
  }
});

afterEach(async () => {
  if (pool) {
    await truncateFixture(pool);
  }
});

afterAll(async () => {
  try {
    if (store) {
      await store.getPool().end();
    }
    if (schema && bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
    if (bootstrapPool) {
      await bootstrapPool.end();
    }
  } finally {
    restoreEnv(environment);
  }
});

describe('enabled run admission compatibility boundary', () => {
  it('holds the canonical PR lock before the first run-row lookup', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 639 });
    const observations: string[] = [];
    const concurrentPool = interposedPool(
      pool,
      async () => undefined,
      observations,
      undefined,
      async () => {
        observations.push((await canAcquirePrLock(pool!, runIdentity)) ? 'pr-lock-free' : 'pr-lock-held');
      },
    );
    const repository = new PostgresReviewRunRepository(concurrentPool, { lifecycleEvents: 'enabled' });

    await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });

    expect(observations[0]).toBe('pr-lock-held');
    expect(observations[1]).toBe('first-identity-miss');
  });

  it('recovers a bound concurrent row after empty INSERT RETURNING without admission side effects', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity();
    const observations: string[] = [];
    const concurrentPool = interposedPool(
      pool,
      async () => {
        await writeNonParticipatingRun(pool!, runIdentity, repositoryId);
      },
      observations,
    );
    const repository = new PostgresReviewRunRepository(concurrentPool, { lifecycleEvents: 'enabled' });

    const recovered = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });

    expect(recovered.repositoryId).toBe(repositoryId);
    expect(observations).toEqual(['first-identity-miss', 'insert-returning-0', 'recovery-identity-select']);
    expect(await countRows(pool, 'review_runs')).toBe(1);
    expect(await countRows(pool, 'review_event_outbox')).toBe(0);
    expect(await countRows(pool, 'review_event_sequence_counters')).toBe(0);
    expect(await eventRows(pool, recovered.runId)).toEqual([]);
  });

  it('recovers an exact historical NULL-binding row without assigning it', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 641 });
    const observations: string[] = [];
    const concurrentPool = interposedPool(
      pool,
      async () => {
        await writeNonParticipatingRun(pool!, runIdentity, null);
      },
      observations,
    );
    const repository = new PostgresReviewRunRepository(concurrentPool, { lifecycleEvents: 'enabled' });

    const recovered = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });

    expect(recovered.repositoryId).toBeUndefined();
    expect(observations).toEqual(['first-identity-miss', 'insert-returning-0', 'recovery-identity-select']);
    expect(await countRows(pool, 'review_runs')).toBe(1);
    expect(await countRows(pool, 'review_event_outbox')).toBe(0);
  });

  it.each([
    ['missing recovery row', async (runIdentity: ReviewRunIdentity) => {
      await writeWithDisabledRepository(pool!, runIdentity);
    }, /could not be created or recovered/u],
    ['conflicting repository binding', async (runIdentity: ReviewRunIdentity) => {
      await writeWithDisabledRepository(pool!, runIdentity, repositoryId + 1);
    }, /conflicting review lifecycle repository binding/iu],
    ['conflicting stored metadata', async (runIdentity: ReviewRunIdentity) => {
      const runId = await writeWithDisabledRepository(pool!, runIdentity, repositoryId);
      await pool!.query('UPDATE review_runs SET head_sha = $2 WHERE run_id = $1', [runId, 'e'.repeat(40)]);
    }, /inconsistent review lifecycle run identity/u],
  ])('fails atomically when recovery is %s', async (_label, writeConflict, errorPattern) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: nextUniquePrNumber++ });
    const observations: string[] = [];
    const concurrentPool = interposedPool(
      pool,
      async () => {
        await writeConflict(runIdentity);
      },
      observations,
      _label === 'missing recovery row'
        ? async () => {
          await pool!.query('DELETE FROM review_runs WHERE identity_digest = $1', [sha256(runIdentity)]);
        }
        : undefined,
    );
    const repository = new PostgresReviewRunRepository(concurrentPool, { lifecycleEvents: 'enabled' });

    await expect(repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime })).rejects.toThrow(errorPattern);
    expect(observations).toEqual(['first-identity-miss', 'insert-returning-0', 'recovery-identity-select']);
    expect(await countRows(pool, 'review_event_outbox')).toBe(0);
    expect(await countRows(pool, 'review_event_sequence_counters')).toBe(0);
  });

  it('does not supersede an existing different-head candidate before a duplicate recovery', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 643 });
    const candidateId = await insertRun(pool, identity({ prNumber: 643, headSha: 'f'.repeat(40) }), {
      status: 'queued',
    });
    const observations: string[] = [];
    const concurrentPool = interposedPool(
      pool,
      async () => {
        await writeNonParticipatingRun(pool!, runIdentity, repositoryId);
      },
      observations,
    );
    const repository = new PostgresReviewRunRepository(concurrentPool, { lifecycleEvents: 'enabled' });

    const recovered = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });
    const candidate = await runRow(pool, candidateId);

    expect(recovered.runId).toBe(runIdFor(runIdentity));
    expect(candidate?.status).toBe('queued');
    expect(await countRows(pool, 'review_event_outbox')).toBe(0);
  });

  it.each([
    ['NULL', null, /repository binding is unavailable/u],
    ['invalid', 0, /repository binding is invalid/u],
    ['conflicting', repositoryId + 1, /conflicting review lifecycle repository binding/iu],
  ])('rejects a different-head candidate with %s binding without partial state', async (_label, candidateBinding, errorPattern) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 644 });
    const candidateId = await insertRun(pool, identity({ prNumber: 644, headSha: 'f'.repeat(40) }), {
      repositoryId: candidateBinding,
      status: 'queued',
    });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    await expect(repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime })).rejects.toThrow(errorPattern);

    expect((await runRow(pool, candidateId))?.status).toBe('queued');
    expect(await countRows(pool, 'review_runs')).toBe(1);
    expect(await countRows(pool, 'review_event_outbox')).toBe(0);
    expect(await countRows(pool, 'review_event_sequence_counters')).toBe(0);
  });
});

describe('enabled versus disabled status compatibility', () => {
  const statuses = ['queued', 'running', 'publishing', 'succeeded', 'failed', 'cancelled', 'superseded'];

  it.each(statuses)('enabled exact duplicate preserves %s without new events', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 648 });
    const runId = await insertRun(pool, runIdentity, { status });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    const duplicate = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime + 1_000 });

    expect(duplicate.runId).toBe(runId);
    expect(duplicate.status).toBe(status);
    expect(duplicate.repositoryId).toBe(repositoryId);
    expect(await eventRows(pool, runId)).toEqual([]);
  });

  it.each(statuses)('disabled exact duplicate preserves legacy %s without repository binding', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 649 });
    const runId = await insertRun(pool, runIdentity, { repositoryId: null, status });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'disabled' });

    const duplicate = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime + 1_000 });

    expect(duplicate.runId).toBe(runId);
    expect(duplicate.status).toBe(status);
    expect(duplicate.repositoryId).toBeUndefined();
  });

  it.each(statuses)('enabled admission only supersedes %s when eligible', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 650, headSha: '1'.repeat(40) });
    const candidateId = await insertRun(pool, identity({ prNumber: 650, headSha: '2'.repeat(40) }), { status });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });
    const candidate = await runRow(pool, candidateId);
    expect(candidate?.status).toBe(status === 'queued' || status === 'running' ? 'superseded' : status);
  });

  it.each(statuses)('disabled admission preserves legacy %s eligibility semantics', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const candidateIdentity = identity({ prNumber: 651, headSha: '3'.repeat(40) });
    const runIdentity = identity({ prNumber: 651, headSha: '4'.repeat(40) });
    const candidateId = await insertRun(pool, candidateIdentity, { repositoryId: null, status });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'disabled' });

    await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });
    const candidate = await runRow(pool, candidateId);
    expect(candidate?.status).toBe(status === 'queued' || status === 'running' ? 'superseded' : status);
  });

  it('keeps enabled old-head redelivery bound to the old run while legacy CTE semantics remain observable', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const oldIdentity = identity({ prNumber: 652, headSha: '5'.repeat(40) });
    const newIdentity = identity({ prNumber: 652, headSha: '6'.repeat(40) });
    const oldRunId = await insertRun(pool, oldIdentity, { status: 'succeeded' });
    const newRunId = await insertRun(pool, newIdentity, { status: 'queued' });
    const enabled = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    const redelivered = await enabled.createOrGet({ identity: oldIdentity, repositoryId, now: baseTime });
    expect(redelivered.runId).toBe(oldRunId);
    expect((await runRow(pool, newRunId))?.status).toBe('queued');

    await truncateFixture(pool);
    const legacyOldRunId = await writeWithDisabledRepository(pool, oldIdentity);
    const legacyNewRunId = await writeWithDisabledRepository(pool, newIdentity);
    const disabled = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'disabled' });
    const legacyRedelivered = await disabled.createOrGet({ identity: oldIdentity, now: baseTime });

    expect(legacyRedelivered.runId).toBe(legacyOldRunId);
    expect((await runRow(pool, legacyNewRunId))?.status).toBe('superseded');
  });

  it('creates a separate run for a same-head identity with different immutable metadata', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const firstIdentity = identity({ prNumber: 653, headSha: '7'.repeat(40), configDigest: '8'.repeat(64) });
    const secondIdentity = identity({ prNumber: 653, headSha: '7'.repeat(40), configDigest: '9'.repeat(64) });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    const first = await repository.createOrGet({ identity: firstIdentity, repositoryId, now: baseTime });
    const second = await repository.createOrGet({ identity: secondIdentity, repositoryId, now: baseTime });

    expect(second.runId).not.toBe(first.runId);
    expect((await runRow(pool, first.runId))?.status).toBe('queued');
    expect((await runRow(pool, second.runId))?.status).toBe('queued');
  });
});
