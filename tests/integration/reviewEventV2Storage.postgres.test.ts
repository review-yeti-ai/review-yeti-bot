import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const ownedSchema = /^review_yeti_v2_storage_test_[0-9a-f]{16}$/u;
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const eventAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const eventSeed = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';
const runIds = [
  'run_legacy_pending_0000000000000000000000',
  'run_legacy_claimed_0000000000000000000000',
  'run_legacy_published_000000000000000000000',
];

function eventId(index: number): string {
  return `${eventSeed.slice(0, -1)}${eventAlphabet[index]}`;
}

function v1Payload(runId: string, sequence: number) {
  return {
    schema: 'review-yeti-event.v1',
    event_id: eventId(sequence),
    event_kind: 'review.lifecycle.queued',
    occurred_at: '2026-09-11T12:00:00.000Z',
    repository_id: 123,
    pr_number: 42,
    base_sha: baseSha,
    head_sha: headSha,
    attempt_id: `${runId}-attempt`,
    run_id: runId,
    sequence,
    correlation_id: `${runId}-correlation`,
    trace_id: `${runId}-trace`,
    visibility: 'internal',
    data: { stage: 'queued' },
  };
}

function v2Payload(runId: string, id: string, sequence: number) {
  return {
    schema: 'review-yeti-event.v2',
    event_id: id,
    event_kind: 'review.lifecycle.terminal',
    occurred_at: '2026-09-11T12:00:00.000Z',
    repository_id: 123,
    pr_number: 42,
    base_sha: baseSha,
    head_sha: headSha,
    attempt_id: `${runId}-attempt`,
    run_id: runId,
    sequence,
    sequence_domain: 'pr_lifecycle_v2',
    correlation_id: `${runId}-correlation`,
    trace_id: `${runId}-trace`,
    visibility: 'internal',
    data: { stage: 'terminal' },
  };
}

describeWithPostgres('Review Yeti v2 additive storage foundation', () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema: string;
  let scopedDatabaseUrl: string;

  beforeAll(async () => {
    schema = `review_yeti_v2_storage_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schema)) throw new Error(`Generated schema is not owned by this test: ${schema}`);
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await createLegacyPreV2State();
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    scopedDatabaseUrl = url.toString();
  });

  beforeEach(() => {
    process.env.DATABASE_URL = scopedDatabaseUrl;
    delete process.env.POSTGRES_URL;
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query('TRUNCATE review_event_v2_outbox, review_event_v2_sequence_counters').catch(() => undefined);
  });

  afterAll(async () => {
    try {
      if (adminPool && ownedSchema.test(schema)) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool?.end();
      await adminPool?.end();
    }
  });

  async function createLegacyPreV2State(): Promise<void> {
    await pool.query(`CREATE TABLE review_runs (
      run_id VARCHAR(255) PRIMARY KEY,
      identity_digest VARCHAR(64) UNIQUE NOT NULL,
      owner VARCHAR(255) NOT NULL,
      repo VARCHAR(255) NOT NULL,
      pr_number BIGINT NOT NULL,
      head_sha VARCHAR(255) NOT NULL,
      base_sha VARCHAR(255) NOT NULL,
      snapshot_digest VARCHAR(64) NOT NULL,
      config_digest VARCHAR(64) NOT NULL,
      effective_policy_digest VARCHAR(64) NOT NULL,
      effective_config_digest VARCHAR(64) NOT NULL,
      index_epoch BIGINT NOT NULL DEFAULT 0,
      identity JSONB NOT NULL,
      publication_mode TEXT NOT NULL DEFAULT 'disabled'
        CHECK (publication_mode IN ('disabled', 'app-gate')),
      status VARCHAR(32) NOT NULL,
      stage VARCHAR(32) NOT NULL,
      attempt INT NOT NULL DEFAULT 0,
      lease_owner VARCHAR(255),
      lease_expires_at TIMESTAMP WITH TIME ZONE,
      publication_fence VARCHAR(64),
      result_digest VARCHAR(64),
      artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_text TEXT,
      failure_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      repository_id BIGINT,
      installation_id BIGINT,
      delivery_id TEXT,
      received_at TIMESTAMP WITH TIME ZONE,
      terminal_deadline TIMESTAMP WITH TIME ZONE
    )`);
    await pool.query(REVIEW_EVENT_SCHEMA_SQL);

    for (const [index, runId] of runIds.entries()) {
      await pool.query(`INSERT INTO review_runs (
        run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
        snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
        identity, status, stage
      ) VALUES ($1, $2, 'legacy-owner', 'legacy-repo', 42, $3, $4, $5, $6, $7, $7, $8, 'completed', 'terminal')`, [
        runId,
        `${String(index + 1).repeat(64)}`,
        headSha,
        baseSha,
        `${String(index + 2).repeat(64)}`,
        `${String(index + 3).repeat(64)}`,
        `${String(index + 4).repeat(64)}`,
        JSON.stringify({ source: 'legacy-fixture', index }),
      ]);
      await pool.query(
        `INSERT INTO review_event_sequence_counters (run_id, next_sequence, updated_at)
         VALUES ($1, $2, '2026-09-11T12:05:00.000Z')`,
        [runId, 7 + index],
      );
    }

    const legacyRows = [
      { runId: runIds[0], state: 'pending', attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, ackAt: null, ack: null },
      { runId: runIds[1], state: 'claimed', attemptCount: 2, leaseOwner: 'legacy-worker', leaseExpiresAt: '2026-09-11T13:00:00.000Z', ackAt: null, ack: null },
      { runId: runIds[2], state: 'published', attemptCount: 3, leaseOwner: null, leaseExpiresAt: null, ackAt: '2026-09-11T12:10:00.000Z', ack: 'legacy-ack-3' },
    ];
    for (const [index, row] of legacyRows.entries()) {
      const payload = v1Payload(row.runId, index + 1);
      await pool.query(`INSERT INTO review_event_outbox (
        event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
        schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload,
        state, attempt_count, lease_owner, lease_expires_at, next_attempt_at,
        publish_acknowledged_at, publish_ack, created_at, updated_at
      ) VALUES ($1, $2, $3, 123, 42, $4, $5, $6, 'review-yeti-event.v1', 'review.lifecycle.queued',
        '2026-09-11T12:00:00.000Z', $7, $8, 'internal', $9, $10, $11, $12, $13,
        '2026-09-11T12:01:00.000Z', $14, $15, '2026-09-11T12:02:00.000Z', '2026-09-11T12:03:00.000Z')`, [
        payload.event_id,
        row.runId,
        `${row.runId}-attempt`,
        baseSha,
        headSha,
        index + 1,
        payload.correlation_id,
        payload.trace_id,
        JSON.stringify(payload),
        row.state,
        row.attemptCount,
        row.leaseOwner,
        row.leaseExpiresAt,
        row.ackAt,
        row.ack,
      ]);
    }
  }

  async function legacySnapshot(): Promise<{ runs: any[]; counters: any[]; events: any[] }> {
    const runs = (await pool.query(`SELECT run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
      snapshot_digest, config_digest, effective_policy_digest, effective_config_digest, index_epoch, identity,
      publication_mode, status, stage, attempt, lease_owner, lease_expires_at, publication_fence, result_digest,
      artifacts, error_text, failure_diagnostics, created_at::text AS created_at, updated_at::text AS updated_at
      FROM review_runs ORDER BY run_id`)).rows;
    const counters = (await pool.query(`SELECT run_id, next_sequence, updated_at::text AS updated_at
      FROM review_event_sequence_counters ORDER BY run_id`)).rows;
    const events = (await pool.query(`SELECT event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha,
      sequence, schema, event_kind, occurred_at::text AS occurred_at, correlation_id, trace_id, visibility,
      payload, state, attempt_count, lease_owner, lease_expires_at::text AS lease_expires_at,
      next_attempt_at::text AS next_attempt_at, publish_acknowledged_at::text AS publish_acknowledged_at,
      publish_ack, created_at::text AS created_at, updated_at::text AS updated_at
      FROM review_event_outbox ORDER BY event_id`)).rows;
    return { runs, counters, events };
  }

  async function initializeWithFreshStore(): Promise<void> {
    const store = new PostgresStore();
    try {
      await store.initialize();
    } finally {
      await store.close();
    }
  }

  it('runs actual PostgresStore.initialize concurrently and repeatedly without touching pre-v2 history or allocating v2 state', async () => {
    const before = await legacySnapshot();
    expect((await pool.query(`SELECT to_regclass(current_schema() || '.review_event_v2_outbox') AS table_name`)).rows[0].table_name)
      .toBeNull();

    const first = new PostgresStore();
    const second = new PostgresStore();
    try {
      await Promise.all([first.initialize(), second.initialize()]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    await initializeWithFreshStore();

    const after = await legacySnapshot();
    expect(after).toEqual(before);
    expect((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'review_event_v2_%'
      ORDER BY table_name`)).rows.map((row) => row.table_name)).toEqual([
      'review_event_v2_outbox',
      'review_event_v2_sequence_counters',
    ]);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_outbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_sequence_counters')).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE '%readiness%'`)).rows).toEqual([]);

    await pool.query(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
      VALUES (123, 42, 7)`);
    await initializeWithFreshStore();
    expect((await pool.query(`SELECT repository_id, pr_number, next_sequence
      FROM review_event_v2_sequence_counters`)).rows).toEqual([{
      repository_id: '123', pr_number: '42', next_sequence: '7',
    }]);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_outbox')).rows[0].count).toBe(0);
  });

  it('enforces independent PR counter keys, immutable v2 envelope columns, unique positions, and bounded retry state', async () => {
    await initializeWithFreshStore();
    await pool.query(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
      VALUES (123, 42, 7), (123, 43, 0)`);
    expect((await pool.query(`SELECT repository_id, pr_number, next_sequence
      FROM review_event_v2_sequence_counters ORDER BY pr_number`)).rows).toEqual([
      { repository_id: '123', pr_number: '42', next_sequence: '7' },
      { repository_id: '123', pr_number: '43', next_sequence: '0' },
    ]);

    const runId = runIds[0];
    const id = eventId(10);
    const payload = v2Payload(runId, id, 8);
    await pool.query(`INSERT INTO review_event_v2_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, sequence_domain, correlation_id, trace_id, visibility, payload
    ) VALUES ($1, $2, $3, 123, 42, $4, $5, 8, 'review-yeti-event.v2', 'review.lifecycle.terminal',
      '2026-09-11T12:00:00.000Z', 'pr_lifecycle_v2', $6, $7, 'internal', $8)`, [
      id, runId, `${runId}-attempt`, baseSha, headSha, payload.correlation_id, payload.trace_id, JSON.stringify(payload),
    ]);

    const invalid = (sql: string, values: unknown[] = []) => pool.query(sql, values);
    await expect(invalid(`INSERT INTO review_event_v2_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, sequence_domain, correlation_id, trace_id, visibility, payload
    ) VALUES ('${eventId(11)}', '${runId}', 'attempt', 123, 42, '${baseSha}', '${headSha}', 8,
      'review-yeti-event.v2', 'review.lifecycle.terminal', CURRENT_TIMESTAMP, 'pr_lifecycle_v2', 'correlation', 'trace', 'internal', '{}')`)).rejects.toThrow();
    await expect(invalid(`INSERT INTO review_event_v2_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, sequence_domain, correlation_id, trace_id, visibility, payload
    ) VALUES ('${eventId(12)}', '${runId}', 'attempt', 0, 42, '${baseSha}', '${headSha}', 9,
      'review-yeti-event.v2', 'review.lifecycle.terminal', CURRENT_TIMESTAMP, 'pr_lifecycle_v2', 'correlation', 'trace', 'public', '{}')`)).rejects.toThrow();
    await expect(invalid(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
      VALUES (123, 42, 1)`)).rejects.toThrow();
    await expect(invalid(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
      VALUES (123, 44, 9007199254740992)`)).rejects.toThrow();

    const constraints = (await pool.query(`SELECT table_class.relname AS table_name,
      pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_class.relnamespace
      WHERE namespace_row.nspname = current_schema()
        AND table_class.relname IN ('review_event_v2_sequence_counters', 'review_event_v2_outbox')
        AND constraint_row.contype IN ('p', 'u', 'c')`)).rows;
    expect(constraints).toEqual(expect.arrayContaining([
      { table_name: 'review_event_v2_sequence_counters', definition: 'PRIMARY KEY (repository_id, pr_number)' },
      { table_name: 'review_event_v2_outbox', definition: 'UNIQUE (repository_id, pr_number, sequence)' },
    ]));
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /schema.*review-yeti-event\.v2/iu.test(row.definition))).toBe(true);
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /sequence_domain.*pr_lifecycle_v2/iu.test(row.definition))).toBe(true);
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /visibility.*internal/iu.test(row.definition))).toBe(true);
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /state.*pending.*claimed.*published/iu.test(row.definition))).toBe(true);
  });
});
