import { randomBytes } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { sha256 } from '../../src/review/reviewCore';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';
import { appendLifecycleEventForRun } from '../../src/persistence/reviewEventRepository';
import { PostgresStore } from '../../src/persistence/postgresStore';
import {
  PostgresReviewRunRepository,
  type ReviewRunIdentity,
} from '../../src/persistence/reviewRunRepository';
import { reviewPrLockKey } from '../../src/persistence/reviewPrTransaction';

import { requireDatabaseUrlInCi } from '../support/postgresSuite';

// REL-1069: fail loudly in CI if the DB URL is missing, so a lost env var cannot
// turn these suites into a silent green skip.
requireDatabaseUrlInCi();

const configuredDatabaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const databaseUrl = configuredDatabaseUrl || '';
// REL-1069 follow-up: skip cleanly without Postgres, like the ten sibling
// suites. Previously an absent URL reached a thrown error instead of a skip.
const describeWithPostgres = databaseUrl ? describe : describe.skip;

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

const environment = snapshotEnv(['DATABASE_URL', 'POSTGRES_URL']);

interface FixtureCleanupPool {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

type FixtureCleanupResources = {
  environment: EnvSnapshot;
  bootstrapPool?: FixtureCleanupPool;
  storePool?: FixtureCleanupPool;
  schema?: string;
  schemaCreated: boolean;
  schemaDropped: boolean;
  bootstrapPoolEnded: boolean;
  storePoolEnded: boolean;
};

async function cleanupOwnedFixture(resources: FixtureCleanupResources): Promise<void> {
  try {
    if (resources.storePool && !resources.storePoolEnded) {
      resources.storePoolEnded = true;
      await resources.storePool.end();
    }
    if (resources.bootstrapPool && resources.schema && resources.schemaCreated && !resources.schemaDropped
      && !resources.bootstrapPoolEnded) {
      await resources.bootstrapPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(resources.schema)} CASCADE`);
      resources.schemaDropped = true;
    }
    if (resources.bootstrapPool && !resources.bootstrapPoolEnded) {
      resources.bootstrapPoolEnded = true;
      await resources.bootstrapPool.end();
    }
  } finally {
    restoreEnv(resources.environment);
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

type RunSeedOverrides = {
  repositoryId?: number | null;
  status?: string;
  stage?: string;
  attempt?: number;
  runId?: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  errorText?: string | null;
  resultDigest?: string | null;
  artifacts?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
};

async function insertRun(
  pool: Pool,
  runIdentity: ReviewRunIdentity,
  overrides: RunSeedOverrides = {},
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
        attempt, lease_owner, lease_expires_at, error_text, result_digest,
        artifacts, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
        $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23
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
      overrides.stage ?? (overrides.status === 'queued' ? 'queued' : 'admission'),
      overrides.attempt ?? 0,
      overrides.leaseOwner === undefined ? null : overrides.leaseOwner,
      overrides.leaseExpiresAt === undefined ? null : overrides.leaseExpiresAt,
      overrides.errorText === undefined ? null : overrides.errorText,
      overrides.resultDigest === undefined ? null : overrides.resultDigest,
      JSON.stringify(overrides.artifacts ?? {}),
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

type LifecycleEventSummary = {
  eventKind: string;
  sequence: number;
  data: Record<string, unknown>;
};

async function lifecycleEvents(pool: Pool, runId: string): Promise<LifecycleEventSummary[]> {
  const result = await pool.query<{
    event_kind: string;
    sequence: string | number;
    data: Record<string, unknown>;
  }>(
    `SELECT event_kind, sequence, payload->'data' AS data
       FROM review_event_outbox
      WHERE run_id = $1
      ORDER BY sequence`,
    [runId],
  );
  return result.rows.map(row => ({
    eventKind: row.event_kind,
    sequence: Number(row.sequence),
    data: row.data,
  }));
}

async function eventCounters(pool: Pool, runId: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM review_event_sequence_counters WHERE run_id = $1',
    [runId],
  );
  return result.rows;
}

async function appendLifecycleHistory(pool: Pool, runId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendLifecycleEventForRun(client, {
      runId,
      eventKind: 'review.lifecycle.started',
      occurredAt: baseTime - 1_500,
      data: { stage: 'admission' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function statusSeed(status: string): RunSeedOverrides {
  const seed: RunSeedOverrides = {
    createdAt: new Date(baseTime - 2_000),
    updatedAt: new Date(baseTime - 1_000),
    leaseOwner: null,
    leaseExpiresAt: null,
    errorText: null,
    resultDigest: null,
    artifacts: {},
  };
  switch (status) {
    case 'queued':
      return { ...seed, stage: 'queued' };
    case 'running':
      return {
        ...seed,
        stage: 'review',
        attempt: 2,
        leaseOwner: 'worker-running',
        leaseExpiresAt: new Date(baseTime + 60_000),
        artifacts: { snapshot: 'snapshot-running', config: 'config-running' },
      };
    case 'publishing':
      return {
        ...seed,
        stage: 'publish',
        attempt: 3,
        leaseOwner: 'worker-publishing',
        leaseExpiresAt: new Date(baseTime + 60_000),
        artifacts: { publish: 'publish-publishing' },
      };
    case 'succeeded':
      return {
        ...seed,
        stage: 'complete',
        attempt: 4,
        resultDigest: 's'.repeat(64),
        artifacts: { publish: 'publish-succeeded' },
      };
    case 'failed':
      return {
        ...seed,
        stage: 'review',
        attempt: 2,
        errorText: 'preserved failure',
        artifacts: { review: 'review-failed' },
      };
    case 'cancelled':
      return {
        ...seed,
        stage: 'admission',
        attempt: 1,
        errorText: 'preserved cancellation',
      };
    case 'superseded':
      return {
        ...seed,
        stage: 'superseded',
        attempt: 2,
        errorText: 'preserved supersession',
        artifacts: { snapshot: 'snapshot-superseded' },
      };
    default:
      throw new Error(`Unexpected status seed ${status}`);
  }
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

let pool: Pool | undefined;
const fixtureCleanup: FixtureCleanupResources = {
  environment,
  schemaCreated: false,
  schemaDropped: false,
  bootstrapPoolEnded: false,
  storePoolEnded: false,
};
let nextUniquePrNumber = 700;

// REL-1069 follow-up: this hook is registered at module scope, so an
// unconditional throw failed the SUITE even when every test skipped. Guarded so
// a DB-less run is a clean skip; CI always supplies the URL, so coverage is
// unchanged there.
beforeAll(async () => {
  if (!databaseUrl) return;
  const bootstrapPool = new Pool({ connectionString: databaseUrl, max: 2 });
  fixtureCleanup.bootstrapPool = bootstrapPool;
  fixtureCleanup.schema = `review_run_admission_${randomBytes(8).toString('hex')}`;
  const schemaName = fixtureCleanup.schema!;
  const quotedSchema = quoteIdentifier(schemaName);
  try {
    await bootstrapPool.query(`CREATE SCHEMA ${quotedSchema}`);
    fixtureCleanup.schemaCreated = true;
    process.env.DATABASE_URL = scopedDatabaseUrl(schemaName);
    delete process.env.POSTGRES_URL;
    const store = new PostgresStore();
    fixtureCleanup.storePool = store.getPool();
    await store.initialize();
    pool = fixtureCleanup.storePool as Pool;
  } catch (error) {
    await cleanupOwnedFixture(fixtureCleanup).catch(() => undefined);
    throw error;
  }
});

afterEach(async () => {
  if (pool) {
    await truncateFixture(pool);
  }
});

afterAll(async () => {
  await cleanupOwnedFixture(fixtureCleanup);
});

describeWithPostgres('owned fixture cleanup boundary', () => {
  it('preserves the setup error and performs owned cleanup exactly once', async () => {
    const testEnvironment = snapshotEnv(['DATABASE_URL', 'POSTGRES_URL']);
    process.env.DATABASE_URL = 'synthetic-mutated-database';
    process.env.POSTGRES_URL = 'synthetic-mutated-postgres';
    const operations: string[] = [];
    const resources: FixtureCleanupResources = {
      environment: testEnvironment,
      bootstrapPool: {
        query: async (text) => {
          operations.push(text);
        },
        end: async () => {
          operations.push('bootstrap-end');
        },
      },
      storePool: {
        query: async () => undefined,
        end: async () => {
          operations.push('store-end');
        },
      },
      schema: 'review_run_admission_0123456789abcdef',
      schemaCreated: true,
      schemaDropped: false,
      bootstrapPoolEnded: false,
      storePoolEnded: false,
    };
    const setupError = new Error('synthetic setup failure');
    let observedError: unknown;

    try {
      throw setupError;
    } catch (error) {
      await cleanupOwnedFixture(resources).catch(() => undefined);
      observedError = error;
    }

    expect(observedError).toBe(setupError);
    expect(operations).toEqual([
      'store-end',
      'DROP SCHEMA IF EXISTS "review_run_admission_0123456789abcdef" CASCADE',
      'bootstrap-end',
    ]);
    await cleanupOwnedFixture(resources);
    expect(operations).toHaveLength(3);
    expect(snapshotEnv(['DATABASE_URL', 'POSTGRES_URL'])).toEqual(testEnvironment);

    const uncreatedOperations: string[] = [];
    const uncreatedResources: FixtureCleanupResources = {
      environment: snapshotEnv(['DATABASE_URL', 'POSTGRES_URL']),
      bootstrapPool: {
        query: async (text) => {
          uncreatedOperations.push(text);
        },
        end: async () => {
          uncreatedOperations.push('bootstrap-end');
        },
      },
      schema: 'review_run_admission_fedcba9876543210',
      schemaCreated: false,
      schemaDropped: false,
      bootstrapPoolEnded: false,
      storePoolEnded: false,
    };
    await cleanupOwnedFixture(uncreatedResources);
    expect(uncreatedOperations).toEqual(['bootstrap-end']);
  });
});

describeWithPostgres('enabled run admission compatibility boundary', () => {
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

  it('rejects contradictory immutable metadata on the ordinary duplicate lookup without mutation', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 645 });
    const runId = await insertRun(pool, runIdentity, { status: 'running', ...statusSeed('running') });
    await pool.query('UPDATE review_runs SET head_sha = $2 WHERE run_id = $1', [runId, 'e'.repeat(40)]);
    const before = await runRow(pool, runId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    await expect(repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime })).rejects.toThrow(
      /inconsistent review lifecycle run identity/u,
    );

    expect(await runRow(pool, runId)).toEqual(before);
    expect(await lifecycleEvents(pool, runId)).toEqual([]);
    expect(await eventCounters(pool, runId)).toEqual([]);
  });

  it('rejects a self-consistent stored identity with a wrong digest through the lock guard', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 646 });
    const runId = await insertRun(pool, runIdentity, { status: 'queued', ...statusSeed('queued') });
    await pool.query('UPDATE review_runs SET identity_digest = $2 WHERE run_id = $1', [runId, '0'.repeat(64)]);
    const before = await runRow(pool, runId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    await expect(repository.claim(runId, 'digest-guard-worker', baseTime, 30_000)).rejects.toThrow(
      /inconsistent review lifecycle run identity/u,
    );

    expect(await runRow(pool, runId)).toEqual(before);
    expect(await lifecycleEvents(pool, runId)).toEqual([]);
    expect(await eventCounters(pool, runId)).toEqual([]);
  });

  it('rejects a malformed missing-key identity through the lock guard', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 647 });
    const runId = await insertRun(pool, runIdentity, { status: 'queued', ...statusSeed('queued') });
    await pool.query("UPDATE review_runs SET identity = identity - 'configDigest' WHERE run_id = $1", [runId]);
    const before = await runRow(pool, runId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    await expect(repository.claim(runId, 'shape-guard-worker', baseTime, 30_000)).rejects.toThrow(
      /inconsistent review lifecycle run identity/u,
    );

    expect(await runRow(pool, runId)).toEqual(before);
    expect(await lifecycleEvents(pool, runId)).toEqual([]);
    expect(await eventCounters(pool, runId)).toEqual([]);
  });

  it('rolls back earlier candidate supersession and v1 history when a later candidate binding conflicts', async () => {
    if (!pool) throw new Error('test pool was not initialized');
    const candidateIdentities = [
      identity({ prNumber: 654, headSha: '1'.repeat(40) }),
      identity({ prNumber: 654, headSha: '2'.repeat(40) }),
    ].sort((left, right) => runIdFor(left).localeCompare(runIdFor(right)));
    const validCandidateId = await insertRun(pool, candidateIdentities[0], {
      status: 'running',
      ...statusSeed('running'),
    });
    const conflictingCandidateId = await insertRun(pool, candidateIdentities[1], {
      status: 'queued',
      ...statusSeed('queued'),
      repositoryId: repositoryId + 1,
    });
    await appendLifecycleHistory(pool, validCandidateId);
    const beforeValid = await runRow(pool, validCandidateId);
    const beforeConflicting = await runRow(pool, conflictingCandidateId);
    const beforeEvents = await lifecycleEvents(pool, validCandidateId);
    const beforeCounters = await eventCounters(pool, validCandidateId);
    const runIdentity = identity({ prNumber: 654, headSha: 'a'.repeat(40) });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    await expect(repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime })).rejects.toThrow(
      /conflicting review lifecycle repository binding/iu,
    );

    expect(await countRows(pool, 'review_runs')).toBe(2);
    expect(await runRow(pool, runIdFor(runIdentity))).toBeUndefined();
    expect(await runRow(pool, validCandidateId)).toEqual(beforeValid);
    expect(await runRow(pool, conflictingCandidateId)).toEqual(beforeConflicting);
    expect(await lifecycleEvents(pool, validCandidateId)).toEqual(beforeEvents);
    expect(await eventCounters(pool, validCandidateId)).toEqual(beforeCounters);
    expect(await lifecycleEvents(pool, runIdFor(runIdentity))).toEqual([]);
    expect(await eventCounters(pool, runIdFor(runIdentity))).toEqual([]);
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

describeWithPostgres('enabled versus disabled status compatibility', () => {
  const statuses = ['queued', 'running', 'publishing', 'succeeded', 'failed', 'cancelled', 'superseded'];

  it.each(statuses)('enabled exact duplicate preserves %s without new events', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 648 });
    const runId = await insertRun(pool, runIdentity, { status, ...statusSeed(status) });
    await appendLifecycleHistory(pool, runId);
    const before = await runRow(pool, runId);
    const beforeEvents = await lifecycleEvents(pool, runId);
    const beforeCounters = await eventCounters(pool, runId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    const duplicate = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime + 1_000 });

    expect(duplicate.runId).toBe(runId);
    expect(duplicate.status).toBe(status);
    expect(duplicate.repositoryId).toBe(repositoryId);
    expect(await runRow(pool, runId)).toEqual(before);
    expect(await lifecycleEvents(pool, runId)).toEqual(beforeEvents);
    expect(await eventCounters(pool, runId)).toEqual(beforeCounters);
  });

  it.each(statuses)('disabled exact duplicate preserves legacy %s without repository binding', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 649 });
    const runId = await insertRun(pool, runIdentity, { repositoryId: null, status, ...statusSeed(status) });
    const before = await runRow(pool, runId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'disabled' });

    const duplicate = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime + 1_000 });

    expect(duplicate.runId).toBe(runId);
    expect(duplicate.status).toBe(status);
    expect(duplicate.repositoryId).toBeUndefined();
    expect(await runRow(pool, runId)).toEqual(before);
    expect(await lifecycleEvents(pool, runId)).toEqual([]);
    expect(await eventCounters(pool, runId)).toEqual([]);
  });

  it.each(statuses)('enabled admission only supersedes %s when eligible', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const runIdentity = identity({ prNumber: 650, headSha: '1'.repeat(40) });
    const candidateId = await insertRun(pool, identity({ prNumber: 650, headSha: '2'.repeat(40) }), {
      status,
      ...statusSeed(status),
    });
    await appendLifecycleHistory(pool, candidateId);
    const before = await runRow(pool, candidateId);
    const beforeEvents = await lifecycleEvents(pool, candidateId);
    const beforeCounters = await eventCounters(pool, candidateId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'enabled' });

    const admitted = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });
    const candidate = await runRow(pool, candidateId);
    const admittedRow = await runRow(pool, admitted.runId);
    const eligible = status === 'queued' || status === 'running';

    if (eligible) {
      expect(candidate).toEqual({
        ...before,
        status: 'superseded',
        error_text: 'superseded by a newer pull request head',
        cancel_requested_at: new Date(baseTime),
        cancel_reason: 'superseded_by_new_head',
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date(baseTime),
      });
      const candidateEvents = await lifecycleEvents(pool, candidateId);
      expect(candidateEvents.map(({ eventKind, sequence }) => ({ eventKind, sequence }))).toEqual([
        ...beforeEvents.map(({ eventKind, sequence }) => ({ eventKind, sequence })),
        { eventKind: 'review.lifecycle.superseded', sequence: beforeEvents.length + 1 },
      ]);
      expect(candidateEvents[candidateEvents.length - 1]?.data).toMatchObject({
        stage: 'superseded',
        terminal_class: 'candidate_superseded',
      });
      expect(await eventCounters(pool, candidateId)).not.toEqual(beforeCounters);
    } else {
      expect(candidate).toEqual(before);
      expect(await lifecycleEvents(pool, candidateId)).toEqual(beforeEvents);
      expect(await eventCounters(pool, candidateId)).toEqual(beforeCounters);
    }

    expect(admittedRow).toMatchObject({
      run_id: admitted.runId,
      identity_digest: sha256(runIdentity),
      owner: runIdentity.owner,
      repo: runIdentity.repo,
      pr_number: runIdentity.prNumber,
      head_sha: runIdentity.headSha,
      base_sha: runIdentity.baseSha,
      snapshot_digest: runIdentity.snapshotDigest,
      config_digest: runIdentity.configDigest,
      identity: runIdentity,
      repository_id: String(repositoryId),
      status: 'queued',
      stage: 'admission',
      attempt: 0,
      lease_owner: null,
      lease_expires_at: null,
      error_text: null,
      result_digest: null,
      artifacts: {},
      created_at: new Date(baseTime),
      updated_at: new Date(baseTime),
    });
    const admittedEvents = await lifecycleEvents(pool, admitted.runId);
    expect(admittedEvents.map(({ eventKind, sequence }) => ({ eventKind, sequence }))).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1 },
      { eventKind: 'review.lifecycle.queued', sequence: 2 },
    ]);
  });

  it.each(statuses)('disabled admission preserves legacy %s eligibility semantics', async (status) => {
    if (!pool) throw new Error('test pool was not initialized');
    const candidateIdentity = identity({ prNumber: 651, headSha: '3'.repeat(40) });
    const runIdentity = identity({ prNumber: 651, headSha: '4'.repeat(40) });
    const candidateId = await insertRun(pool, candidateIdentity, {
      repositoryId: null,
      status,
      ...statusSeed(status),
    });
    const before = await runRow(pool, candidateId);
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: 'disabled' });

    const admitted = await repository.createOrGet({ identity: runIdentity, repositoryId, now: baseTime });
    const candidate = await runRow(pool, candidateId);
    const eligible = status === 'queued' || status === 'running';
    if (eligible) {
      expect(candidate).toEqual({
        ...before,
        status: 'superseded',
        error_text: 'superseded by a newer pull request head',
        cancel_requested_at: new Date(baseTime),
        cancel_reason: 'superseded_by_new_head',
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date(baseTime),
      });
    } else {
      expect(candidate).toEqual(before);
    }
    expect(await lifecycleEvents(pool, candidateId)).toEqual([]);
    expect(await eventCounters(pool, candidateId)).toEqual([]);
    expect(await runRow(pool, admitted.runId)).toMatchObject({
      run_id: admitted.runId,
      identity: runIdentity,
      repository_id: null,
      status: 'queued',
      stage: 'admission',
      attempt: 0,
      lease_owner: null,
      lease_expires_at: null,
      error_text: null,
      result_digest: null,
      artifacts: {},
      created_at: new Date(baseTime),
      updated_at: new Date(baseTime),
    });
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

  it.each(['enabled', 'disabled'] as const)('creates a separate run for a same-head identity with different immutable metadata in %s mode', async (mode) => {
    if (!pool) throw new Error('test pool was not initialized');
    const firstIdentity = identity({ prNumber: 653, headSha: '7'.repeat(40), configDigest: '8'.repeat(64) });
    const secondIdentity = identity({ prNumber: 653, headSha: '7'.repeat(40), configDigest: '9'.repeat(64) });
    const repository = new PostgresReviewRunRepository(pool, { lifecycleEvents: mode });

    const first = await repository.createOrGet({ identity: firstIdentity, repositoryId, now: baseTime });
    const second = await repository.createOrGet({ identity: secondIdentity, repositoryId, now: baseTime });

    expect(second.runId).not.toBe(first.runId);
    expect(first.repositoryId).toBe(mode === 'enabled' ? repositoryId : undefined);
    expect(second.repositoryId).toBe(mode === 'enabled' ? repositoryId : undefined);
    expect(await runRow(pool, first.runId)).toMatchObject({
      run_id: first.runId,
      identity_digest: sha256(firstIdentity),
      owner: firstIdentity.owner,
      repo: firstIdentity.repo,
      pr_number: firstIdentity.prNumber,
      head_sha: firstIdentity.headSha,
      base_sha: firstIdentity.baseSha,
      snapshot_digest: firstIdentity.snapshotDigest,
      config_digest: firstIdentity.configDigest,
      identity: firstIdentity,
      repository_id: mode === 'enabled' ? String(repositoryId) : null,
      status: 'queued',
      stage: 'admission',
      attempt: 0,
      lease_owner: null,
      lease_expires_at: null,
      error_text: null,
      result_digest: null,
      artifacts: {},
      created_at: new Date(baseTime),
      updated_at: new Date(baseTime),
    });
    expect(await runRow(pool, second.runId)).toMatchObject({
      run_id: second.runId,
      identity_digest: sha256(secondIdentity),
      owner: secondIdentity.owner,
      repo: secondIdentity.repo,
      pr_number: secondIdentity.prNumber,
      head_sha: secondIdentity.headSha,
      base_sha: secondIdentity.baseSha,
      snapshot_digest: secondIdentity.snapshotDigest,
      config_digest: secondIdentity.configDigest,
      identity: secondIdentity,
      repository_id: mode === 'enabled' ? String(repositoryId) : null,
      status: 'queued',
      stage: 'admission',
      attempt: 0,
      lease_owner: null,
      lease_expires_at: null,
      error_text: null,
      result_digest: null,
      artifacts: {},
      created_at: new Date(baseTime),
      updated_at: new Date(baseTime),
    });
    const expectedEvents = mode === 'enabled'
      ? [
        { eventKind: 'review.lifecycle.admission', sequence: 1 },
        { eventKind: 'review.lifecycle.queued', sequence: 2 },
      ]
      : [];
    expect((await lifecycleEvents(pool, first.runId)).map(({ eventKind, sequence }) => ({ eventKind, sequence })))
      .toEqual(expectedEvents);
    expect((await lifecycleEvents(pool, second.runId)).map(({ eventKind, sequence }) => ({ eventKind, sequence })))
      .toEqual(expectedEvents);
    if (mode === 'enabled') {
      expect(await eventCounters(pool, first.runId)).not.toEqual([]);
      expect(await eventCounters(pool, second.runId)).not.toEqual([]);
    } else {
      expect(await eventCounters(pool, first.runId)).toEqual([]);
      expect(await eventCounters(pool, second.runId)).toEqual([]);
    }
  });
});
