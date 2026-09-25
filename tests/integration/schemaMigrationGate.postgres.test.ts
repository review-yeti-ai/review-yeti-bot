import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { SCHEMA_MIGRATIONS_TABLE } from '../../src/persistence/schemaMigrationGate';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

// REL-1069: fail loudly in CI if the DB URL is missing.
requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();
const ownedSchema = /^review_yeti_schema_gate_test_[0-9a-f]{16}$/u;

/**
 * REL-1127: a rollout used to re-run the full DDL (ALTER TABLE review_runs ...)
 * while live dispatcher transactions held locks on the same tables, and Postgres
 * resolved it with 40P01. These tests hold a live transaction open on the hot
 * table, exactly as a serving pod does, and start a new pod's initialize().
 */
describeWithPostgres('schema migration gate — real scoped PostgreSQL (REL-1127)', () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema = '';
  let scopedUrl = '';
  let previousDatabaseUrl: string | undefined;
  let live: PoolClient | undefined;

  async function initializeFresh(): Promise<void> {
    const store = new PostgresStore();
    try {
      await store.initialize();
    } finally {
      await store.close();
    }
  }

  /** A serving pod mid-transaction: it holds ROW EXCLUSIVE on review_runs, as any INSERT/UPDATE does. */
  async function openLiveTransactionOnReviewRuns(): Promise<PoolClient> {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE review_runs IN ROW EXCLUSIVE MODE');
    return client;
  }

  async function withDeadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds}ms`)), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  beforeAll(async () => {
    schema = `review_yeti_schema_gate_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schema)) throw new Error(`Generated schema is not owned by this test: ${schema}`);
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.toString();
  });

  beforeEach(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scopedUrl;
  });

  afterEach(async () => {
    if (live) {
      await live.query('ROLLBACK').catch(() => undefined);
      live.release();
      live = undefined;
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  afterAll(async () => {
    try {
      if (adminPool && ownedSchema.test(schema)) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool?.end();
      await adminPool?.end();
    }
  });

  it('records the applied schema on first start', async () => {
    await initializeFresh();
    const recorded = await pool.query(`SELECT fingerprint FROM ${SCHEMA_MIGRATIONS_TABLE}`);
    expect(recorded.rows).toHaveLength(1);
    expect(String(recorded.rows[0].fingerprint)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('a rollout start completes promptly while a serving pod holds a live transaction on review_runs', async () => {
    await initializeFresh();
    live = await openLiveTransactionOnReviewRuns();

    // Before REL-1127 this blocked on ALTER TABLE review_runs (ACCESS EXCLUSIVE)
    // behind the live transaction — the precondition of the 40P01 deadlocks.
    await withDeadline(initializeFresh(), 3_000, 'initialize() during live traffic');

    const waiting = await adminPool.query(`SELECT COUNT(*)::int AS count FROM pg_locks
      WHERE NOT granted AND relation = to_regclass($1)`, [`"${schema}".review_runs`]);
    expect(waiting.rows[0].count).toBe(0);
  });

  it('a start that must apply DDL waits at most lock_timeout per attempt, retries, and succeeds once the live transaction ends', async () => {
    await initializeFresh();
    await pool.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`);
    live = await openLiveTransactionOnReviewRuns();

    const started = Date.now();
    const initialization = initializeFresh();
    // Keep the live transaction for longer than one lock_timeout so the first
    // attempt fails with 55P03 and must be retried rather than crash the pod.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    await live.query('COMMIT');
    live.release();
    live = undefined;

    await withDeadline(initialization, 20_000, 'initialize() after live transaction ended');
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    const recorded = await pool.query(`SELECT COUNT(*)::int AS count FROM ${SCHEMA_MIGRATIONS_TABLE}`);
    expect(recorded.rows[0].count).toBe(1);
  }, 40_000);

  it('re-creates a table that was dropped after the schema was recorded', async () => {
    await initializeFresh();
    await pool.query('DROP TABLE IF EXISTS review_event_v2_outbox CASCADE');

    await initializeFresh();

    const exists = await pool.query(`SELECT to_regclass('review_event_v2_outbox') IS NOT NULL AS present`);
    expect(exists.rows[0].present).toBe(true);
  });
});
