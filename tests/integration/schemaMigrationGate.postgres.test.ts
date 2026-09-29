import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { SCHEMA_MIGRATIONS_TABLE } from '../../src/persistence/schemaMigrationGate';
import { logger } from '../../src/utils/logger';
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

  it('REL-1189 upgrades a pre-priority outbox with the bounded constraint and claim index idempotently', async () => {
    await initializeFresh();

    // Recreate the catalog state from before REL-1189 while keeping the table in
    // place. CREATE TABLE IF NOT EXISTS must therefore be a no-op on the next
    // initialize; only the explicit ALTER/DO migration path can restore these
    // objects. Deleting the recorded fingerprint mirrors a new build whose DDL
    // digest is absent from an existing deployment.
    await pool.query('DROP INDEX IF EXISTS review_dispatch_priority_claim_idx');
    await pool.query(`ALTER TABLE review_dispatch_outbox
      DROP CONSTRAINT IF EXISTS review_dispatch_outbox_priority_check`);
    await pool.query(`ALTER TABLE review_dispatch_outbox
      DROP COLUMN IF EXISTS dispatch_priority`);
    await pool.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`);

    const before = await pool.query(`SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'review_dispatch_outbox'
           AND column_name = 'dispatch_priority'
      ) AS has_column,
      EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'review_dispatch_outbox'::regclass
           AND conname = 'review_dispatch_outbox_priority_check'
      ) AS has_constraint`);
    expect(before.rows[0]).toEqual({ has_column: false, has_constraint: false });

    await initializeFresh();
    await initializeFresh();

    const column = await pool.query(`SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'review_dispatch_outbox'
        AND column_name = 'dispatch_priority'`);
    expect(column.rows[0]).toMatchObject({ is_nullable: 'NO', column_default: '0' });

    const constraint = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'review_dispatch_outbox'::regclass
        AND conname = 'review_dispatch_outbox_priority_check'`);
    expect(constraint.rows[0].definition).toContain('dispatch_priority = ANY (ARRAY[0, 1])');

    const index = await pool.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'review_dispatch_outbox'
        AND indexname = 'review_dispatch_priority_claim_idx'`);
    expect(index.rows[0].indexdef).toContain('dispatch_priority DESC, available_at, created_at');
  });

  it('API-3371 backfills only legacy successful terminal receipts', async () => {
    await initializeFresh();
    const suffix = randomBytes(8).toString('hex');
    const receiptDigest = 'd'.repeat(64);
    const scenarios = [
      { label: 'legacy', publicationMode: 'app-gate', runStatus: 'succeeded',
        outboxStatus: 'terminal', resultDigest: receiptDigest, authoritativeGateAppId: null },
      { label: 'authoritative', publicationMode: 'app-gate', runStatus: 'succeeded',
        outboxStatus: 'terminal', resultDigest: receiptDigest, authoritativeGateAppId: 43_857_710 },
      { label: 'failed', publicationMode: 'app-gate', runStatus: 'failed',
        outboxStatus: 'terminal', resultDigest: receiptDigest, authoritativeGateAppId: null },
      { label: 'disabled', publicationMode: 'disabled', runStatus: 'succeeded',
        outboxStatus: 'terminal', resultDigest: receiptDigest, authoritativeGateAppId: null },
      { label: 'projected', publicationMode: 'app-gate', runStatus: 'succeeded',
        outboxStatus: 'projected', resultDigest: receiptDigest, authoritativeGateAppId: null },
      { label: 'invalid_digest', publicationMode: 'app-gate', runStatus: 'succeeded',
        outboxStatus: 'terminal', resultDigest: 'not-a-digest', authoritativeGateAppId: null },
    ] as const;

    for (const scenario of scenarios) {
      const runId = `run_${scenario.label}_${suffix}`;
      const deliveryId = `delivery_${scenario.label}_${suffix}`;
      await pool.query(`INSERT INTO review_runs
        (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
         snapshot_digest, config_digest, effective_policy_digest,
         effective_config_digest, identity, publication_mode, status, stage,
         repository_id, installation_id, delivery_id, result_digest,
         authoritative_gate_app_id)
        VALUES ($1, $2, 'exampleorg', 'example-api', 42, $3, $4, $5, $6,
          $7, $8, '{}'::jsonb, $9, $10, 'complete', 123, 456,
          $11, $12, $13)`, [
        runId,
        randomBytes(32).toString('hex'),
        'a'.repeat(40),
        'b'.repeat(40),
        'c'.repeat(64),
        'e'.repeat(64),
        'f'.repeat(64),
        '1'.repeat(64),
        scenario.publicationMode,
        scenario.runStatus,
        deliveryId,
        scenario.resultDigest,
        scenario.authoritativeGateAppId,
      ]);
      await pool.query(`INSERT INTO github_deliveries
        (delivery_id, event_name, repository_id, installation_id,
         payload_digest, run_id, received_at)
        VALUES ($1, 'pull_request', 123, 456, $2, $3, NOW())`,
      [deliveryId, '2'.repeat(64), runId]);
      await pool.query(`INSERT INTO review_dispatch_outbox
        (run_id, delivery_id, status, execution_attempt, worker_token_digest)
        VALUES ($1, $2, $3, 0, $4)`,
      [runId, deliveryId, scenario.outboxStatus, '3'.repeat(64)]);
    }

    await pool.query(`ALTER TABLE review_dispatch_outbox
      DROP COLUMN IF EXISTS terminal_receipt_digest`);
    await pool.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`);

    await initializeFresh();

    const receipts = await pool.query(`SELECT run_id, terminal_receipt_digest
      FROM review_dispatch_outbox WHERE run_id = ANY($1::text[])`,
    [scenarios.map(({ label }) => `run_${label}_${suffix}`)]);
    expect(Object.fromEntries(receipts.rows.map(({ run_id: runId, terminal_receipt_digest: digest }) =>
      [runId, digest]))).toEqual(Object.fromEntries(scenarios.map(({ label }) => [
      `run_${label}_${suffix}`,
      label === 'legacy' ? receiptDigest : null,
    ])));

    const persistedReceipt = '9'.repeat(64);
    await pool.query(`UPDATE review_dispatch_outbox SET terminal_receipt_digest = $2
      WHERE run_id = $1`, [`run_legacy_${suffix}`, persistedReceipt]);
    await pool.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`);
    await initializeFresh();
    expect((await pool.query(`SELECT terminal_receipt_digest
      FROM review_dispatch_outbox WHERE run_id = $1`, [`run_legacy_${suffix}`])).rows[0])
      .toEqual({ terminal_receipt_digest: persistedReceipt });
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

    const warnLog = vi.spyOn(logger, 'warn');
    const initialization = initializeFresh();
    // Keep the live transaction for longer than one lock_timeout so the first
    // attempt fails with 55P03 and must be retried rather than crash the pod.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    await live.query('COMMIT');
    live.release();
    live = undefined;

    await withDeadline(initialization, 20_000, 'initialize() after live transaction ended');
    // The first attempt must have given up on lock_timeout (55P03) and retried,
    // rather than blocking behind the live transaction until it committed.
    expect(warnLog).toHaveBeenCalledWith(
      '[PostgresStore] Schema initialization lock conflict; retrying',
      expect.objectContaining({ code: 'postgres_initialization_lock_conflict', sqlState: '55P03', attempt: 1 }),
    );
    warnLog.mockRestore();
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
