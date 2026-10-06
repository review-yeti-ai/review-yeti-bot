import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import {
  ACTIVE_JOBS_BASE_SQL,
  createQueryActiveJobsTool,
} from '../../src/mcp/server/tools/queryActiveJobs';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();

/** The query that shipped broken: review_runs has no verdict column. */
const LEGACY_SQL = `SELECT r.run_id FROM review_runs r WHERE (r.verdict IS NULL OR r.status IN ('pending'))`;

describeWithPostgres('query_active_jobs against the migrated review_runs schema', () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema = '';
  let previousDatabaseUrl: string | undefined;

  async function insertRun(runId: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO review_runs (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
         snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
         identity, status, stage)
       VALUES ($1, $1, 'acme', 'widgets', 7, $2, $2, $1, $1, $1, $1, '{}'::jsonb, $3, 'review')`,
      [runId, 'a'.repeat(40), status],
    );
  }

  beforeAll(async () => {
    schema = `review_yeti_active_jobs_test_${randomBytes(8).toString('hex')}`;
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    const store = new PostgresStore();
    try {
      await store.initialize();
    } finally {
      await store.close();
    }
    await insertRun('run-queued', 'queued');
    await insertRun('run-running', 'running');
    await insertRun('run-publishing', 'publishing');
    await insertRun('run-succeeded', 'succeeded');
    await insertRun('run-failed', 'failed');
    await insertRun('run-cancelled', 'cancelled');
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    try {
      if (adminPool && /^review_yeti_active_jobs_test_[0-9a-f]{16}$/u.test(schema)) {
        await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await pool?.end();
      await adminPool?.end();
    }
  });

  it('the legacy query is rejected by the real schema (negative control)', async () => {
    await expect(pool.query(LEGACY_SQL)).rejects.toThrow(/column r\.verdict does not exist/u);
  });

  it('returns only non-terminal runs without a SQL error', async () => {
    const tool = createQueryActiveJobsTool({ query: (sql, values) => pool.query(sql, values) });
    const result = await tool.execute({ owner: 'acme', repo: 'widgets' });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.error).toBeUndefined();
    expect(payload.active_jobs.map((j: { run_id: string }) => j.run_id).sort())
      .toEqual(['run-publishing', 'run-queued', 'run-running']);
    expect(payload.status).toBe('busy');
  });

  it('the exported SQL executes directly', async () => {
    const res = await pool.query(ACTIVE_JOBS_BASE_SQL);
    expect(res.rows).toHaveLength(3);
  });
});
