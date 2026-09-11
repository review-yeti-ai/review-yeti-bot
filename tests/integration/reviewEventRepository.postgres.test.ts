import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  REVIEW_EVENT_SCHEMA_SQL,
  appendLifecycleEvent,
  type ReviewLifecycleEventInput,
} from '../../src/persistence/reviewEventRepository';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const ownedSchema = /^review_event_test_[0-9a-f]{16}$/u;
const eventIdSeed = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';
const eventAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function eventId(index: number): string {
  return `${eventIdSeed.slice(0, -1)}${eventAlphabet[index % eventAlphabet.length]}`;
}

function lifecycleEvent(id: string, sequence = 999): ReviewLifecycleEventInput {
  return {
    schema: 'review-yeti-event.v1', event_id: id, event_kind: 'review.lifecycle.queued',
    occurred_at: '2026-09-11T12:00:00.000Z', repository_id: 123, pr_number: 42,
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    attempt_id: 'run_00000000000000000000000000000000-g0-e1',
    run_id: 'run_00000000000000000000000000000000', sequence, correlation_id: 'delivery-42',
    trace_id: 'trace-42', visibility: 'internal', data: { stage: 'queued' },
  };
}

describeWithPostgres('Postgres review lifecycle event repository', () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `review_event_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schema)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE review_runs (run_id TEXT PRIMARY KEY)');
    await pool.query(REVIEW_EVENT_SCHEMA_SQL);
    await pool.query(REVIEW_EVENT_SCHEMA_SQL);
  });

  afterEach(async () => {
    await pool.query('TRUNCATE review_event_outbox, review_event_sequence_counters, review_runs CASCADE');
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (!ownedSchema.test(schema)) throw new Error(`Refusing to drop unowned schema: ${schema}`);
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('initializes idempotently with the outbox and sequence counter', async () => {
    const tables = (await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('review_event_outbox','review_event_sequence_counters')
      ORDER BY table_name`)).rows.map((row) => row.table_name);
    expect(tables).toEqual(['review_event_outbox', 'review_event_sequence_counters']);
    const unique = await pool.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'review_event_outbox'
      ORDER BY indexname`);
    expect(unique.rows.map((row) => row.indexname).join(' ')).toMatch(/run.*sequence|event_id/iu);
  });

  it('rolls back the authoritative transition and event intent together', async () => {
    await pool.query("INSERT INTO review_runs(run_id) VALUES ('run_00000000000000000000000000000000')");
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE review_runs SET run_id = run_id WHERE run_id = 'run_00000000000000000000000000000000'");
      await appendLifecycleEvent(client, lifecycleEvent(eventId(1)));
      expect((await client.query('SELECT COUNT(*)::int AS count FROM review_event_outbox')).rows[0].count).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_outbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_sequence_counters')).rows[0].count).toBe(0);
  });

  it('replays an event idempotently without consuming another sequence', async () => {
    await pool.query("INSERT INTO review_runs(run_id) VALUES ('run_00000000000000000000000000000000')");
    const firstClient = await pool.connect();
    try {
      await firstClient.query('BEGIN');
      const first = await appendLifecycleEvent(firstClient, lifecycleEvent(eventId(10), 999));
      await firstClient.query('COMMIT');
      expect(first.sequence).toBe(1);
    } finally {
      firstClient.release();
    }
    const replayClient = await pool.connect();
    try {
      await replayClient.query('BEGIN');
      const replay = await appendLifecycleEvent(replayClient, lifecycleEvent(eventId(10), 123));
      await replayClient.query('COMMIT');
      expect(replay.sequence).toBe(1);
    } finally {
      replayClient.release();
    }
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_outbox')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT next_sequence FROM review_event_sequence_counters')).rows[0].next_sequence).toBe('1');
  });

  it('allocates unique contiguous sequences per run under concurrent callers', async () => {
    await pool.query("INSERT INTO review_runs(run_id) VALUES ('run_00000000000000000000000000000000')");
    const appendAndCommit = async (id: string): Promise<void> => {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        await appendLifecycleEvent(client, lifecycleEvent(id));
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    };
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendAndCommit(eventId(index + 2))));
    const rows = await pool.query('SELECT sequence FROM review_event_outbox ORDER BY sequence');
    expect(rows.rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('serializes concurrent replay callbacks without consuming another sequence', async () => {
    await pool.query("INSERT INTO review_runs(run_id) VALUES ('run_00000000000000000000000000000000')");
    const appendAndCommit = async (): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await appendLifecycleEvent(client, lifecycleEvent(eventId(21), 999));
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => appendAndCommit()));
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_outbox')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT next_sequence FROM review_event_sequence_counters')).rows[0].next_sequence).toBe('1');
  });
});
