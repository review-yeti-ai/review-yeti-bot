import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import {
  describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi,
} from '../support/postgresSuite';

requireDatabaseUrlInCi();

const RUN = 'run_attempt_timing';
const OLD = `${RUN}-g0-e1`;
const CURRENT = `${RUN}-g1-e2`;
const HEAD = 'a'.repeat(40);
const CREATED = '2026-09-30T11:13:08.000Z';
const RECEIVED = '2026-09-30T13:12:51.000Z';
const DISPATCHED = '2026-09-30T13:13:01.000Z';
const STARTED = '2026-09-30T13:13:03.000Z';
const COMPLETED = '2026-09-30T13:13:33.000Z';

describeWithPostgres('get_review_status attempt-bound timing on real PostgreSQL', () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `review_status_timing_test_${randomBytes(8).toString('hex')}`;
    if (!/^review_status_timing_test_[a-f0-9]{16}$/u.test(schema)) {
      throw new Error('Timing test schema ownership is invalid');
    }
    // No public search-path fallback: this test cannot read shared tables.
    pool = new Pool({ connectionString: postgresDatabaseUrl(), max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY, owner TEXT, repo TEXT, pr_number INTEGER,
      head_sha TEXT, status TEXT, stage TEXT, attempt INTEGER,
      lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, artifacts JSONB,
      received_at TIMESTAMPTZ, burst_started_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ, cancel_propagated_at TIMESTAMPTZ,
      terminal_deadline TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE review_gate_attempts (
      attempt_id TEXT PRIMARY KEY, run_id TEXT, check_id BIGINT,
      desired_state TEXT, decision JSONB, current_attempt BOOLEAN
    )`);
    await pool.query(`CREATE TABLE review_event_outbox (
      run_id TEXT, attempt_id TEXT, event_kind TEXT, occurred_at TIMESTAMPTZ
    )`);
  });

  afterAll(async () => {
    if (pool) {
      try {
        if (/^review_status_timing_test_[a-f0-9]{16}$/u.test(schema)) {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
      } finally {
        await pool.end();
      }
    }
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE review_event_outbox, review_gate_attempts, review_runs');
    await pool.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, head_sha, status, stage, attempt,
       created_at, updated_at, received_at, burst_started_at, terminal_deadline, artifacts)
      VALUES ($1, 'calltelemetry', 'timing-fixture', 42, $2, 'failed', 'publish', 1,
        $3, $4, $5, $3, $6, '{}'::jsonb)`,
    [RUN, HEAD, CREATED, COMPLETED, RECEIVED, '2026-09-30T13:42:51.000Z']);
    await pool.query(`INSERT INTO review_gate_attempts
      VALUES ($1, $2, 7002, 'failure', NULL, true), ($3, $2, 7001, 'failure', NULL, false)`,
    [CURRENT, RUN, OLD]);
    for (const [kind, at] of [
      ['dispatched', '2026-09-30T11:14:08.000Z'],
      ['started', '2026-09-30T11:14:09.000Z'],
      ['terminal', '2026-09-30T11:42:07.000Z'],
    ]) {
      await marker(OLD, kind, at);
    }
  });

  async function marker(attempt: string, kind: string, at: string) {
    await pool.query('INSERT INTO review_event_outbox VALUES ($1, $2, $3, $4)',
      [RUN, attempt, `review.lifecycle.${kind}`, at]);
  }

  async function status(head = true) {
    const result = await createGetReviewStatusTool(pool).execute({
      owner: 'calltelemetry', repo: 'timing-fixture', pull_number: 42,
      ...(head ? { head_sha: HEAD } : {}),
    });
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it.each([true, false])('selects only the current retry markers (head filter=%s)', async (head) => {
    await marker(CURRENT, 'dispatched', DISPATCHED);
    await marker(CURRENT, 'started', STARTED);
    await marker(CURRENT, 'terminal', COMPLETED);
    const data = await status(head);
    expect(data.attempt_id).toBe(CURRENT);
    expect(data.verdict).toBe('FAILED');
    expect(data.timing.dispatched_at).toBe(DISPATCHED);
    expect(data.timing.started_at).toBe(STARTED);
    expect(data.timing.completed_at).toBe(COMPLETED);
    expect(data.timing.queue_seconds).toBe(12);
    expect(data.timing.execution_seconds).toBe(30);
    expect(data.timing.created_at).toBe(CREATED);
    expect(data.timing.burst_started_at).toBe(CREATED);
  });

  it('never borrows a previous complete attempt for a still-running retry', async () => {
    await pool.query("UPDATE review_runs SET status = 'running', stage = 'review' WHERE run_id = $1", [RUN]);
    await pool.query("UPDATE review_gate_attempts SET desired_state = 'in_progress' WHERE current_attempt = true");
    const data = await status();
    expect(data.verdict).toBe('RUNNING');
    expect(data.timing.dispatched_at).toBeNull();
    expect(data.timing.started_at).toBeNull();
    expect(data.timing.completed_at).toBeNull();
    expect(data.timing.queue_seconds).toBeNull();
    expect(data.timing.execution_seconds).toBeNull();
  });

  it('treats legacy completed as terminal without allowing SHIP over gate failure', async () => {
    await pool.query("UPDATE review_runs SET status = 'completed', stage = 'continuation_completed', updated_at = $2 WHERE run_id = $1",
      [RUN, COMPLETED]);
    await pool.query('UPDATE review_gate_attempts SET decision = $1::jsonb WHERE current_attempt = true',
      [JSON.stringify({ verdict: 'SHIP' })]);
    await marker(CURRENT, 'started', STARTED);

    const data = await status();
    expect(data.verdict).toBe('FAILED');
    expect(data.timing.completed_at).toBe(COMPLETED);
    expect(data.timing.execution_seconds).toBe(30);
  });

  it('keeps timing unknown when no durable current-attempt identity exists', async () => {
    await pool.query('DELETE FROM review_gate_attempts');
    const data = await status();
    expect(data.found).toBe(true);
    expect(data.verdict).toBe('FAILED');
    expect(data.timing.dispatched_at).toBeNull();
    expect(data.timing.started_at).toBeNull();
    expect(data.timing.execution_seconds).toBeNull();
  });
});
