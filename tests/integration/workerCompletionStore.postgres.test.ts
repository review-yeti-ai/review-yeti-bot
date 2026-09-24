import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresWorkerCompletionStore } from '../../src/persistence/workerCompletionStore';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { MAX_COMPLETION_BYTES } from '../../src/review/workerReviewCompletion';

import { requireDatabaseUrlInCi } from '../support/postgresSuite';

// REL-1069: fail loudly in CI if the DB URL is missing, so a lost env var cannot
// turn these suites into a silent green skip.
requireDatabaseUrlInCi();

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('PostgresWorkerCompletionStore', () => {
  const schema = `wcs_${randomBytes(6).toString('hex')}`;
  let pool: Pool;
  const runId = 'run_' + 'a'.repeat(32);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(REVIEW_GATE_SCHEMA_SQL);
    await pool.query('INSERT INTO review_runs (run_id) VALUES ($1)', [runId]);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  it('inserts once per (run, attempt), is a no-op on repeat, and records UTF-8 bytes', async () => {
    const store = new PostgresWorkerCompletionStore(pool);
    const payload = { version: 'WorkerReviewCompletion.v1', note: 'naïve 例' };
    expect(await store.put({ runId, executionAttempt: 1, contentDigest: 'f'.repeat(64), payload })).toBe('inserted');
    expect(await store.put({ runId, executionAttempt: 1, contentDigest: '0'.repeat(64), payload: { other: true } })).toBe('exists');
    const rows = (await pool.query('SELECT content_digest, payload, byte_length FROM review_worker_completions WHERE run_id = $1', [runId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_digest).toBe('f'.repeat(64));
    expect(rows[0].payload).toEqual(payload);
    expect(Number(rows[0].byte_length)).toBe(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    expect(Number(rows[0].byte_length)).toBeGreaterThan(JSON.stringify(payload).length);
  });

  it('refuses a payload over the wire bound at the schema, not silently', async () => {
    const store = new PostgresWorkerCompletionStore(pool);
    await expect(store.put({ runId, executionAttempt: 2, contentDigest: 'e'.repeat(64),
      payload: { pad: 'x'.repeat(MAX_COMPLETION_BYTES + 1) } })).rejects.toThrow(/byte_length/);
  });
});
