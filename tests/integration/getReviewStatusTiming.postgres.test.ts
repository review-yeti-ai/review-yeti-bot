import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import {
  REVIEW_EVENT_SCHEMA_SQL, appendLifecycleEvent, buildLifecycleEvent,
} from '../../src/persistence/reviewEventRepository';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
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

// The typed shape is installed from the canonical exported schema. The payload-
// only variant exercises the legacy read contract in getReviewStatus, not a
// claim about the schema currently deployed in production.
for (const shape of ['typed', 'payload-only legacy'] as const) {
  describeWithPostgres(`get_review_status attempt-bound timing on real PostgreSQL (${shape})`, () => {
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
      await pool.query(REVIEW_GATE_SCHEMA_SQL);
      await pool.query(REVIEW_EVENT_SCHEMA_SQL);
      if (shape === 'payload-only legacy') {
        await pool.query('ALTER TABLE review_event_outbox DROP COLUMN attempt_id');
      }
    });

    afterAll(async () => {
      if (pool) {
        try {
          if (!/^review_status_timing_test_[a-f0-9]{16}$/u.test(schema)) {
            throw new Error('Refusing to drop an unowned timing test schema');
          }
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE review_event_outbox, review_event_sequence_counters, review_gate_attempts, review_runs CASCADE');
      await pool.query(`INSERT INTO review_runs
        (run_id, owner, repo, pr_number, head_sha, status, stage, attempt,
         created_at, updated_at, received_at, burst_started_at, terminal_deadline, artifacts)
        VALUES ($1, 'exampleorg', 'timing-fixture', 42, $2, 'failed', 'publish', 1,
          $3, $4, $5, $3, $6, '{}'::jsonb)`,
      [RUN, HEAD, CREATED, COMPLETED, RECEIVED, '2026-09-30T13:42:51.000Z']);
      await pool.query(`INSERT INTO review_gate_attempts
        (attempt_id, run_id, review_generation, execution_attempt, repository_id,
         pr_number, expected_app_id, coordinates, external_id, creation_state,
         check_id, desired_state, current_attempt)
        VALUES ($1, $2, 1, 2, 123, 42, 4385771, '{}'::jsonb,
          'timing-current', 'bound', 7002, 'failure', true),
          ($3, $2, 0, 1, 123, 42, 4385771, '{}'::jsonb,
          'timing-old', 'bound', 7001, 'failure', false)`,
      [CURRENT, RUN, OLD]);
      for (const [kind, at] of [
        ['dispatched', '2026-09-30T11:14:08.000Z'],
        ['started', '2026-09-30T11:14:09.000Z'],
        ['terminal', '2026-09-30T11:42:07.000Z'],
      ]) {
        await marker(OLD, kind, at);
      }
    });

    async function marker(attempt: string, kind: string, at: string, unkeyed = false) {
      const event = buildLifecycleEvent({
        runId: RUN, attemptId: attempt, eventKind: `review.lifecycle.${kind}`,
        occurredAt: at, repositoryId: 123, prNumber: 42,
        baseSha: 'b'.repeat(40), headSha: HEAD,
        correlationId: 'timing-fixture', traceId: 'timing-fixture',
      });
      if (shape === 'typed') {
        // The real writer persists matching typed and payload identities.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await appendLifecycleEvent(client, event);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } else {
        const sequence = Number((await pool.query(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM review_event_outbox WHERE run_id = $1', [RUN],
        )).rows[0].next);
        const payload: Record<string, unknown> = { ...event, sequence };
        if (unkeyed) delete payload.attempt_id;
        await pool.query(`INSERT INTO review_event_outbox
          (event_id, run_id, repository_id, pr_number, base_sha, head_sha, sequence,
           schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload)
          VALUES ($1, $2, 123, 42, $3, $4, $5, $6, $7, $8, $9, $10, 'internal', $11::jsonb)`,
        [event.event_id, RUN, event.base_sha, HEAD, sequence, event.schema,
          event.event_kind, at, event.correlation_id, event.trace_id, JSON.stringify(payload)]);
      }
    }

    async function status(head = true) {
      const result = await createGetReviewStatusTool(pool).execute({
        owner: 'exampleorg', repo: 'timing-fixture', pull_number: 42,
        ...(head ? { head_sha: HEAD } : {}),
      });
      return JSON.parse((result.content[0] as { text: string }).text);
    }

    it('uses the canonical typed schema or explicitly supported payload-only read shape', async () => {
      const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'review_event_outbox'`)).rows
        .map((row) => row.column_name);
      expect(columns).toContain('payload');
      expect(columns.includes('attempt_id')).toBe(shape === 'typed');
      const rows = (await pool.query(`SELECT payload->>'attempt_id' AS payload_attempt
        ${shape === 'typed' ? ', attempt_id AS typed_attempt' : ''} FROM review_event_outbox`)).rows;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.payload_attempt).toBe(OLD);
        if (shape === 'typed') expect(row.typed_attempt).toBe(OLD);
      }
    });

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

    it('does not replace an identified current attempt with unkeyed or foreign markers', async () => {
      if (shape === 'payload-only legacy') await marker(OLD, 'started', STARTED, true);
      await marker(OLD, 'terminal', COMPLETED);
      const data = await status();
      expect(data.attempt_id).toBe(CURRENT);
      expect(data.timing.started_at).toBeNull();
      expect(data.timing.execution_seconds).toBeNull();
    });

    it('keeps missing receipt and missing attempt timing unknown', async () => {
      await pool.query('DELETE FROM review_gate_attempts');
      await pool.query('UPDATE review_runs SET received_at = NULL, created_at = NULL WHERE run_id = $1', [RUN]);
      if (shape === 'payload-only legacy') await marker(OLD, 'started', STARTED, true);
      const data = await status();
      expect(data.timing.started_at).toBeNull();
      expect(data.timing.queue_seconds).toBeNull();
      expect(data.timing.execution_seconds).toBeNull();
    });

    it('keeps an unrecognized run status nonterminal even with current terminal markers', async () => {
      await marker(CURRENT, 'started', STARTED);
      await marker(CURRENT, 'terminal', COMPLETED);
      await pool.query("UPDATE review_runs SET status = 'future-status' WHERE run_id = $1", [RUN]);
      const data = await status();
      expect(data.verdict).toBe('FAILED');
      expect(data.timing.started_at).toBe(STARTED);
      expect(data.timing.completed_at).toBeNull();
      expect(data.timing.execution_seconds).toBeNull();
    });

    it.each([true, false])('returns the real run and unknown identified-attempt timing when the gate table is absent (head filter=%s)', async (head) => {
      await marker(CURRENT, 'started', STARTED);
      await marker(CURRENT, 'terminal', COMPLETED);
      await pool.query(`UPDATE review_runs
        SET cancel_requested_at = $2, cancel_propagated_at = $3 WHERE run_id = $1`,
      [RUN, '2026-09-30T13:13:08.000Z', '2026-09-30T13:13:09.000Z']);
      // This suite owns the entire schema and has no public search-path fallback.
      // Remove dependent constraints to model a legacy schema without a Gate table.
      await pool.query('DROP TABLE review_gate_attempts CASCADE');
      try {
        const data = await status(head);
        expect(data.found).toBe(true);
        expect(data.head_sha).toBe(HEAD);
        expect(data.verdict).toBe('FAILED');
        expect(data.check_run).toBeNull();
        expect(data.attempt_id).toBe('review-attempt-42-1');
        expect(data.timing).toEqual({
          basis: 'control_plane_lifecycle',
          received_at: RECEIVED, created_at: CREATED, burst_started_at: CREATED,
          dispatched_at: null, started_at: null, completed_at: COMPLETED,
          cancel_requested_at: '2026-09-30T13:13:08.000Z',
          cancel_propagated_at: '2026-09-30T13:13:09.000Z',
          terminal_deadline: '2026-09-30T13:42:51.000Z',
          queue_seconds: null, execution_seconds: null,
        });
      } finally {
        // Reinstall only this owned schema's canonical gate tables, even RED.
        await pool.query(REVIEW_GATE_SCHEMA_SQL);
      }
    });

    if (shape === 'payload-only legacy') {
      it.each([true, false])('uses only unkeyed markers after this receipt when current identity is absent (head filter=%s)', async (head) => {
        await pool.query('DELETE FROM review_gate_attempts');
        await marker(OLD, 'started', '2026-09-30T11:14:09.000Z', true);
        await marker(OLD, 'terminal', '2026-09-30T11:42:07.000Z', true);
        await marker(OLD, 'started', DISPATCHED); // Identified foreign attempt after receipt.
        await marker(CURRENT, 'dispatched', DISPATCHED, true);
        await marker(CURRENT, 'started', STARTED, true);
        await marker(CURRENT, 'terminal', COMPLETED, true);
        const data = await status(head);
        expect(data.verdict).toBe('FAILED');
        expect(data.timing.dispatched_at).toBe(DISPATCHED);
        expect(data.timing.started_at).toBe(STARTED);
        expect(data.timing.completed_at).toBe(COMPLETED);
        expect(data.timing.queue_seconds).toBe(12);
        expect(data.timing.execution_seconds).toBe(30);
      });

      it.each([true, false])('retains the unkeyed receipt window when the gate table is absent (head filter=%s)', async (head) => {
        await marker(OLD, 'started', '2026-09-30T11:14:09.000Z', true);
        await marker(OLD, 'terminal', '2026-09-30T11:42:07.000Z', true);
        await marker(OLD, 'started', DISPATCHED); // Foreign identified row after receipt.
        await marker(CURRENT, 'dispatched', DISPATCHED, true);
        await marker(CURRENT, 'started', STARTED, true);
        await marker(CURRENT, 'terminal', COMPLETED, true);
        // This suite owns the entire schema and has no public search-path fallback.
      // Remove dependent constraints to model a legacy schema without a Gate table.
      await pool.query('DROP TABLE review_gate_attempts CASCADE');
        try {
          const data = await status(head);
          expect(data.found).toBe(true);
          expect(data.verdict).toBe('FAILED');
          expect(data.check_run).toBeNull();
          expect(data.timing.dispatched_at).toBe(DISPATCHED);
          expect(data.timing.started_at).toBe(STARTED);
          expect(data.timing.completed_at).toBe(COMPLETED);
          expect(data.timing.queue_seconds).toBe(12);
          expect(data.timing.execution_seconds).toBe(30);
        } finally {
          await pool.query(REVIEW_GATE_SCHEMA_SQL);
        }
      });
    }
  });
}
