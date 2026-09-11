import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  REVIEW_EVENT_SCHEMA_SQL,
  PostgresReviewEventRepository,
  appendLifecycleEvent,
  appendLifecycleEventForRun,
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

async function persistedEvents(pool: Pool, runId: string): Promise<Array<{
  eventKind: string;
  sequence: number;
  data: Record<string, unknown>;
}>> {
  const result = await pool.query(
    'SELECT event_kind, sequence, payload FROM review_event_outbox WHERE run_id = $1 ORDER BY sequence',
    [runId],
  );
  return result.rows.map((row) => ({
    eventKind: String(row.event_kind),
    sequence: Number(row.sequence),
    data: row.payload.data as Record<string, unknown>,
  }));
}

describeWithPostgres('Postgres review lifecycle event repository', () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `review_event_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schema)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY,
      repository_id BIGINT,
      pr_number INTEGER,
      base_sha TEXT,
      head_sha TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      effective_policy_digest TEXT
    )`);
    await pool.query(`CREATE TABLE review_dispatch_outbox (
      run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
      execution_attempt INTEGER NOT NULL DEFAULT 0
    )`);
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

  it('proves event defaults, checks, cascades, and run sequence uniqueness in PostgreSQL', async () => {
    const columns = (await pool.query(`
      SELECT table_name, column_name, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name = 'review_event_sequence_counters' AND column_name IN ('next_sequence', 'updated_at'))
           OR (table_name = 'review_event_outbox' AND column_name IN ('state', 'attempt_count', 'next_attempt_at', 'created_at', 'updated_at')))
    `)).rows;
    const column = (tableName: string, columnName: string) => columns.find((row) =>
      row.table_name === tableName && row.column_name === columnName);
    expect(column('review_event_sequence_counters', 'next_sequence')).toMatchObject({
      column_default: '0', is_nullable: 'NO',
    });
    expect(column('review_event_sequence_counters', 'updated_at')).toMatchObject({
      column_default: 'CURRENT_TIMESTAMP', is_nullable: 'NO',
    });
    expect(column('review_event_outbox', 'state')).toMatchObject({
      column_default: expect.stringContaining('pending'), is_nullable: 'NO',
    });
    expect(column('review_event_outbox', 'attempt_count')).toMatchObject({
      column_default: '0', is_nullable: 'NO',
    });
    for (const name of ['next_attempt_at', 'created_at', 'updated_at']) {
      expect(column('review_event_outbox', name)).toMatchObject({
        column_default: 'CURRENT_TIMESTAMP', is_nullable: 'NO',
      });
    }

    const checks = (await pool.query(`
      SELECT table_class.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_class.relnamespace
       WHERE namespace_row.nspname = current_schema() AND constraint_row.contype = 'c'
         AND table_class.relname IN ('review_event_sequence_counters', 'review_event_outbox')
    `)).rows;
    const hasCheck = (tableName: string, pattern: RegExp) => checks.some((row) =>
      row.table_name === tableName && pattern.test(row.definition));
    expect(hasCheck('review_event_sequence_counters', /next_sequence\s*>=\s*0/iu)).toBe(true);
    expect(hasCheck('review_event_outbox', /sequence\s*>\s*0/iu)).toBe(true);
    expect(hasCheck('review_event_outbox', /event_kind.*(?:LIKE|~~).*review\.lifecycle/iu)).toBe(true);
    expect(hasCheck('review_event_outbox', /visibility\s*=\s*'internal'/iu)).toBe(true);
    expect(hasCheck('review_event_outbox', /attempt_count\s*>=\s*0/iu)).toBe(true);

    const foreignKeys = (await pool.query(`
      SELECT child.relname AS child_table, parent.relname AS parent_table, constraint_row.confdeltype
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS child ON child.oid = constraint_row.conrelid
        JOIN pg_class AS parent ON parent.oid = constraint_row.confrelid
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = child.relnamespace
       WHERE namespace_row.nspname = current_schema() AND constraint_row.contype = 'f'
         AND child.relname IN ('review_event_sequence_counters', 'review_event_outbox')
    `)).rows;
    expect(foreignKeys).toEqual(expect.arrayContaining([
      { child_table: 'review_event_sequence_counters', parent_table: 'review_runs', confdeltype: 'c' },
      { child_table: 'review_event_outbox', parent_table: 'review_runs', confdeltype: 'c' },
    ]));
    const uniqueConstraints = (await pool.query(`
      SELECT pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_class.relnamespace
       WHERE namespace_row.nspname = current_schema() AND table_class.relname = 'review_event_outbox'
         AND constraint_row.contype IN ('p', 'u')
    `)).rows.map((row) => row.definition);
    expect(uniqueConstraints).toContain('UNIQUE (run_id, sequence)');

    const defaultsRun = 'run_00000000000000000000000000000001';
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [defaultsRun]);
    await pool.query('INSERT INTO review_event_sequence_counters(run_id) VALUES ($1)', [defaultsRun]);
    await pool.query(`INSERT INTO review_event_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload
    ) VALUES ($1, $2, $3, 123, 42, $4, $5, 1, 'review-yeti-event.v1', 'review.lifecycle.queued',
      CURRENT_TIMESTAMP, 'correlation', 'trace', 'internal', $6)`, [
      eventId(40), defaultsRun, `${defaultsRun}-g0-e1`, 'a'.repeat(40), 'b'.repeat(40), JSON.stringify({}),
    ]);
    expect((await pool.query('SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [defaultsRun])).rows[0])
      .toEqual({ next_sequence: '0' });
    expect((await pool.query(`SELECT state, attempt_count, next_attempt_at IS NOT NULL AS has_next_attempt,
        created_at IS NOT NULL AS has_created, updated_at IS NOT NULL AS has_updated
      FROM review_event_outbox WHERE event_id = $1`, [eventId(40)])).rows[0]).toEqual({
      state: 'pending', attempt_count: 0, has_next_attempt: true, has_created: true, has_updated: true,
    });

    const invalidInsert = (id: string, sequence: number, eventKind: string, attemptCount: number) => pool.query(`
      INSERT INTO review_event_outbox (
        event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
        schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload, attempt_count
      ) VALUES ($1, $2, $3, 123, 42, $4, $5, $6, 'review-yeti-event.v1', $7,
        CURRENT_TIMESTAMP, 'correlation', 'trace', 'internal', '{}'::jsonb, $8)`, [
      id, defaultsRun, `${defaultsRun}-g0-e${sequence}`, 'a'.repeat(40), 'b'.repeat(40), sequence,
      eventKind, attemptCount,
    ]);
    await expect(invalidInsert(eventId(41), 2, 'review.lifecycle.queued', -1)).rejects.toThrow();
    await expect(invalidInsert(eventId(42), 3, 'review.not-a-lifecycle-event', 0)).rejects.toThrow();

    const uniqueRun = 'run_00000000000000000000000000000002';
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [uniqueRun]);
    await pool.query(`INSERT INTO review_event_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload
    ) VALUES ($1, $2, $3, 123, 42, $4, $5, 1, 'review-yeti-event.v1', 'review.lifecycle.queued',
      CURRENT_TIMESTAMP, 'correlation', 'trace', 'internal', '{}'::jsonb)`, [
      eventId(43), uniqueRun, `${uniqueRun}-g0-e1`, 'a'.repeat(40), 'b'.repeat(40),
    ]);
    await expect(pool.query(`INSERT INTO review_event_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload
    ) VALUES ($1, $2, $3, 123, 42, $4, $5, 1, 'review-yeti-event.v1', 'review.lifecycle.dispatched',
      CURRENT_TIMESTAMP, 'correlation', 'trace', 'internal', '{}'::jsonb)`, [
      eventId(44), uniqueRun, `${uniqueRun}-g0-e2`, 'a'.repeat(40), 'b'.repeat(40),
    ])).rejects.toThrow();

    const cascadeRun = 'run_00000000000000000000000000000003';
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [cascadeRun]);
    await pool.query('INSERT INTO review_event_sequence_counters(run_id) VALUES ($1)', [cascadeRun]);
    await pool.query(`INSERT INTO review_event_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload
    ) VALUES ($1, $2, $3, 123, 42, $4, $5, 1, 'review-yeti-event.v1', 'review.lifecycle.queued',
      CURRENT_TIMESTAMP, 'correlation', 'trace', 'internal', '{}'::jsonb)`, [
      eventId(45), cascadeRun, `${cascadeRun}-g0-e1`, 'a'.repeat(40), 'b'.repeat(40),
    ]);
    await pool.query('DELETE FROM review_runs WHERE run_id = $1', [cascadeRun]);
    expect((await pool.query('SELECT 1 FROM review_event_sequence_counters WHERE run_id = $1', [cascadeRun])).rows).toEqual([]);
    expect((await pool.query('SELECT 1 FROM review_event_outbox WHERE run_id = $1', [cascadeRun])).rows).toEqual([]);
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

  it('rejects a same-event identity conflict without consuming a sequence', async () => {
    const runId = 'run_00000000000000000000000000000000';
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [runId]);
    const firstClient = await pool.connect();
    try {
      await firstClient.query('BEGIN');
      await appendLifecycleEvent(firstClient, lifecycleEvent(eventId(11)));
      await firstClient.query('COMMIT');
    } finally {
      firstClient.release();
    }

    const conflictClient = await pool.connect();
    try {
      await conflictClient.query('BEGIN');
      await expect(appendLifecycleEvent(conflictClient, {
        ...lifecycleEvent(eventId(11)), head_sha: 'c'.repeat(40), data: { stage: 'conflict' },
      })).rejects.toThrow('identity conflict');
      expect((await conflictClient.query('SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [runId])).rows[0])
        .toEqual({ next_sequence: '1' });
      await conflictClient.query('ROLLBACK');
    } finally {
      conflictClient.release();
    }

    const nextClient = await pool.connect();
    try {
      await nextClient.query('BEGIN');
      const next = await appendLifecycleEvent(nextClient, lifecycleEvent(eventId(12)));
      expect(next.sequence).toBe(2);
      await nextClient.query('COMMIT');
    } finally {
      nextClient.release();
    }
    expect(await persistedEvents(pool, runId)).toHaveLength(2);
    expect((await pool.query('SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [runId])).rows[0])
      .toEqual({ next_sequence: '2' });
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

  it('rejects incomplete run metadata before allocating an event sequence', async () => {
    await pool.query(`INSERT INTO review_runs
      (run_id, pr_number, base_sha, head_sha, attempt, effective_policy_digest)
      VALUES ('run_00000000000000000000000000000000', 42, $1, $2, 0, $3)`,
    ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(appendLifecycleEventForRun(client, {
        runId: 'run_00000000000000000000000000000000',
        eventKind: 'review.lifecycle.queued',
      })).rejects.toThrow(/metadata/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_outbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_sequence_counters')).rows[0].count).toBe(0);
  });

  it('excludes a live lease, increments attempts, and reclaims an expired lease', async () => {
    const runId = 'run_00000000000000000000000000000000';
    const occurredAt = Date.parse('2026-09-11T12:00:00.000Z');
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [runId]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendLifecycleEvent(client, lifecycleEvent(eventId(30), 999));
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const repository = new PostgresReviewEventRepository(pool);
    const first = await repository.claimNext('worker-a', occurredAt + 1_000, 30_000);
    expect(first).toMatchObject({ eventId: eventId(30), state: 'claimed', leaseOwner: 'worker-a', attemptCount: 1 });
    expect(first?.leaseExpiresAt).toBe(occurredAt + 31_000);
    await expect(repository.claimNext('worker-b', occurredAt + 2_000, 30_000)).resolves.toBeNull();

    const reclaimed = await repository.claimNext('worker-b', occurredAt + 31_001, 10_000);
    expect(reclaimed).toMatchObject({ eventId: eventId(30), state: 'claimed', leaseOwner: 'worker-b', attemptCount: 2 });
    expect((await pool.query('SELECT attempt_count, lease_owner FROM review_event_outbox WHERE event_id = $1', [eventId(30)])).rows[0])
      .toMatchObject({ attempt_count: 2, lease_owner: 'worker-b' });
  });

  it('requires the live lease owner and window for publication, and schedules a retry', async () => {
    const runId = 'run_00000000000000000000000000000000';
    const occurredAt = Date.parse('2026-09-11T12:00:00.000Z');
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [runId]);
    const append = async (event: ReviewLifecycleEventInput): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await appendLifecycleEvent(client, event);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    };
    await append(lifecycleEvent(eventId(31)));
    await append({ ...lifecycleEvent(eventId(32)), occurred_at: new Date(occurredAt + 2_000).toISOString() });
    const repository = new PostgresReviewEventRepository(pool);
    const published = await repository.claimNext('publisher-a', occurredAt + 1_000, 10_000);
    expect(published).not.toBeNull();
    await expect(repository.markPublished(eventId(31), 'publisher-b', occurredAt + 2_000)).resolves.toBe(false);
    await expect(repository.markPublished(eventId(31), 'publisher-a', occurredAt + 11_001)).resolves.toBe(false);

    const retry = await repository.claimNext('retry-a', occurredAt + 11_002, 10_000);
    expect(retry?.eventId).toBe(eventId(31));
    await expect(repository.markPublished(eventId(31), 'retry-a', occurredAt + 12_000, 'ack-31')).resolves.toBe(true);
    expect((await pool.query('SELECT state, publish_ack FROM review_event_outbox WHERE event_id = $1', [eventId(31)])).rows[0])
      .toMatchObject({ state: 'published', publish_ack: 'ack-31' });

    const released = await repository.claimNext('retry-owner', occurredAt + 13_000, 10_000);
    expect(released?.eventId).toBe(eventId(32));
    await expect(repository.releaseForRetry(eventId(32), 'wrong-owner', occurredAt + 14_000, 5_000)).resolves.toBe(false);
    await expect(repository.releaseForRetry(eventId(32), 'retry-owner', occurredAt + 23_001, 5_000)).resolves.toBe(false);
    await expect(repository.releaseForRetry(eventId(32), 'retry-owner', occurredAt + 15_000, 5_000)).resolves.toBe(true);
    expect((await pool.query('SELECT state, next_attempt_at FROM review_event_outbox WHERE event_id = $1', [eventId(32)])).rows[0])
      .toMatchObject({ state: 'pending' });
    await expect(repository.claimNext('scheduled-too-early', occurredAt + 19_999, 10_000)).resolves.toBeNull();
    const scheduled = await repository.claimNext('scheduled-worker', occurredAt + 20_000, 10_000);
    expect(scheduled).toMatchObject({ eventId: eventId(32), attemptCount: 2, leaseOwner: 'scheduled-worker' });
  });

  it('extends only the live owner heartbeat and prevents reclaim until the extension expires', async () => {
    const runId = 'run_00000000000000000000000000000000';
    const occurredAt = Date.parse('2026-09-11T12:00:00.000Z');
    await pool.query('INSERT INTO review_runs(run_id) VALUES ($1)', [runId]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendLifecycleEvent(client, lifecycleEvent(eventId(33)));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const repository = new PostgresReviewEventRepository(pool);
    await expect(repository.claimNext('heartbeat-owner', occurredAt + 1_000, 10_000)).resolves.toMatchObject({ attemptCount: 1 });
    await expect(repository.heartbeat(eventId(33), 'wrong-owner', occurredAt + 5_000, 10_000)).resolves.toBe(false);
    await expect(repository.heartbeat(eventId(33), 'heartbeat-owner', occurredAt + 5_000, 10_000)).resolves.toBe(true);
    expect((await pool.query('SELECT lease_expires_at FROM review_event_outbox WHERE event_id = $1', [eventId(33)])).rows[0].lease_expires_at)
      .toEqual(new Date(occurredAt + 15_000));
    await expect(repository.claimNext('before-heartbeat-expiry', occurredAt + 10_001, 10_000)).resolves.toBeNull();
    const reclaimed = await repository.claimNext('after-heartbeat-expiry', occurredAt + 15_001, 10_000);
    expect(reclaimed).toMatchObject({ eventId: eventId(33), attemptCount: 2, leaseOwner: 'after-heartbeat-expiry' });
  });
});
