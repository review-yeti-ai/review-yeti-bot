import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { REVIEW_GATE_CHECK_NAME } from '../../src/github/reviewGateClient';
import { PostgresVerdictCacheBaseLookup, selectVerdictCacheSource } from '../../src/persistence/verdictCacheSource';
import {
  PostgresReviewGateRepository,
  type StoredReviewGate,
  type TrustedGateCompletionContext,
} from '../../src/persistence/reviewGateRepository';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';
import { sha256 } from '../../src/review/reviewCore';
import { gateRecordFor } from '../support/priorGateRecord';
import type { VerdictCacheVerificationInput } from '../../src/review/verdictCache';
import {
  workerReviewCompletionDigest,
  type WorkerReviewCompletion,
} from '../../src/review/workerReviewCompletion';

/**
 * REL-1085: the verdict cache's source is the SAME stored completion row W7
 * selects, in real SQL: repository- and pull-request-scoped, stored before this
 * run's admission, and never another repository's record. The trusted
 * completion transaction hands the service's OWN source (never the worker's)
 * to the resolver, and fails the gate when the resolver cannot verify it.
 */
const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const OWNED_SCHEMA = /^verdict_cache_test_[0-9a-f]{16}$/u;
const APP_ID = 7001;
const POLICY = 'c'.repeat(64);
const CONFIG = 'e'.repeat(64);
const TOKEN = 'ghs_verdict_cache_test_token';
const TOKEN_DIGEST = sha256(TOKEN);
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PREV_HEAD = '1'.repeat(40);
const PREV_BASE = '2'.repeat(40);
const RECEIVED_AT = Date.parse('2026-09-24T12:00:00.000Z');
const LANE_KEYS = { 'sec-lane': 'a'.repeat(64) };
const ENTRY = { path: 'src/same.ts', contentKey: 'b'.repeat(64), viewDigest: 'c'.repeat(64), lanes: ['sec-lane'] };

function runId(number: number): string {
  return `run_${number.toString(16).padStart(32, '0')}`;
}

function completionFor(id: string, headSha: string, baseSha: string, options: { repositoryId?: number; prNumber?: number;
  verdictCache?: boolean } = {}): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', runId: id, repositoryId: options.repositoryId ?? 3210, owner: 'calltelemetry',
    repo: 'ct-review-actions', prNumber: options.prNumber ?? 42, headSha, baseSha, policyDigest: POLICY, configDigest: CONFIG,
    executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T11:00:00.000Z',
      personas: [{ id: 'sec-lane', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
      // No `verdict`: the authoritative worker never sets it (REL-1084).
      coverageComplete: true, quorumSatisfied: true,
      ...(options.verdictCache === false ? {} : {
        verdictCache: { version: 'VerdictCache.v1', laneKeys: LANE_KEYS, entries: [ENTRY] },
      }),
    },
  };
}

describeWithPostgres('verdict cache source selection (real SQL)', () => {
  let pool: Pool | undefined;
  let schemaName: string | undefined;

  async function insertRun(id: string, options: { status?: string; headSha?: string; baseSha?: string; prNumber?: number;
    repositoryId?: number; generation?: number; executionAttempt?: number } = {}): Promise<void> {
    await pool!.query(`
      INSERT INTO review_runs (
        run_id, owner, repo, pr_number, head_sha, base_sha,
        effective_policy_digest, publication_mode, status, attempt, repository_id,
        effective_config_digest, received_at, terminal_deadline, authoritative_gate_app_id
      ) VALUES ($1, 'calltelemetry', 'ct-review-actions', $2, $3, $4, $5, 'app-gate', $6, $7, $8, $9,
        to_timestamp($10/1000.0), to_timestamp(($10+900000)/1000.0), $11)
    `, [id, options.prNumber ?? 42, options.headSha ?? HEAD, options.baseSha ?? BASE, POLICY, options.status ?? 'queued',
      options.generation ?? 0, options.repositoryId ?? 3210, CONFIG, RECEIVED_AT, APP_ID]);
    await pool!.query(`
      INSERT INTO review_dispatch_outbox (run_id, status, execution_attempt, worker_token_digest)
      VALUES ($1, 'pending', $2, $3)
    `, [id, options.executionAttempt ?? 0, TOKEN_DIGEST]);
  }

  async function insertCompletion(event: WorkerReviewCompletion, createdAt: number): Promise<void> {
    const json = JSON.stringify(event);
    await pool!.query(`
      INSERT INTO review_worker_completions (run_id, execution_attempt, content_digest, payload, byte_length, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, to_timestamp($6/1000.0))
    `, [event.runId, event.executionAttempt, workerReviewCompletionDigest(event), json, Buffer.byteLength(json, 'utf8'), createdAt]);
    // The gate attempt row the trusted transaction writes for it (REL-1084: the source's verdict is derived from it).
    const recorded = gateRecordFor(event, { expectedPersonaIds: ['sec-lane'], changedFiles: [{ path: 'src/changed.ts' }, { path: 'src/same.ts' }] });
    await pool!.query(`
      INSERT INTO review_gate_attempts (attempt_id, run_id, review_generation, execution_attempt, repository_id, pr_number,
        expected_app_id, coordinates, external_id, current_attempt, desired_state, evidence, decision, worker_result_digest)
      VALUES ($1, $2, 0, $3, $4, $5, $6, '{}'::jsonb, $7, false, $8, $9::jsonb, $10::jsonb, $11)
    `, [`gate_${event.runId}_${event.executionAttempt}`, event.runId, event.executionAttempt, event.repositoryId, event.prNumber,
      APP_ID, `external_${event.runId}_${event.executionAttempt}`, recorded.decision.status,
      recorded.gate.evidence, recorded.gate.decision, recorded.gate.worker_result_digest]);
  }

  beforeAll(async () => {
    schemaName = `verdict_cache_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schemaName}` });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`
        CREATE TABLE review_runs (
          run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
          head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, effective_policy_digest TEXT NOT NULL,
          publication_mode TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
          repository_id BIGINT NOT NULL, effective_config_digest VARCHAR(64) NOT NULL,
          received_at TIMESTAMPTZ NOT NULL, terminal_deadline TIMESTAMPTZ,
          stage TEXT NOT NULL DEFAULT 'admission', result_digest VARCHAR(64), error_text TEXT,
          failure_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb, lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE review_dispatch_outbox (
          run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
          status TEXT NOT NULL, execution_attempt INTEGER NOT NULL DEFAULT 0,
          worker_token_digest VARCHAR(64), lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(REVIEW_GATE_SCHEMA_SQL);
      await client.query(REVIEW_EVENT_SCHEMA_SQL);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    await pool?.query('TRUNCATE review_event_outbox, review_event_sequence_counters, review_gate_attempts, review_worker_completions, review_dispatch_outbox, review_runs CASCADE');
  });

  afterAll(async () => {
    if (!schemaName) return;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error(`Refusing to drop unowned schema: ${schemaName}`);
    try { await pool?.query(`DROP SCHEMA "${schemaName}" CASCADE`); } finally { await pool?.end(); pool = undefined; }
  });

  it('selects the pull request\'s latest stored completion, with its entries, from the existing record', async () => {
    const current = runId(100);
    await insertRun(current);
    const prior = runId(1);
    await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    await insertCompletion(completionFor(prior, PREV_HEAD, PREV_BASE), RECEIVED_AT - 3_600_000);
    expect(await selectVerdictCacheSource(pool!, current)).toEqual({
      prior: expect.objectContaining({ runId: prior, repositoryId: 3210, prNumber: 42, headSha: PREV_HEAD, shipComplete: true,
        completionDigest: workerReviewCompletionDigest(completionFor(prior, PREV_HEAD, PREV_BASE)), ageMs: 3_600_000 }),
      laneKeys: LANE_KEYS,
      entries: [ENTRY],
      lanes: ['sec-lane'],
    });
  });

  it('never selects another repository\'s record, even for the same pull request number (planted)', async () => {
    const current = runId(100);
    await insertRun(current);
    const foreign = runId(2);
    await insertRun(foreign, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE, repositoryId: 9999 });
    await insertCompletion(completionFor(foreign, PREV_HEAD, PREV_BASE, { repositoryId: 9999 }), RECEIVED_AT - 60_000);
    expect(await selectVerdictCacheSource(pool!, current)).toBeNull();
  });

  it('is null when the latest record carries no entries, and never reaches back past it', async () => {
    const current = runId(100);
    await insertRun(current);
    const older = runId(1);
    await insertRun(older, { status: 'succeeded', headSha: '5'.repeat(40), baseSha: PREV_BASE });
    await insertCompletion(completionFor(older, '5'.repeat(40), PREV_BASE), RECEIVED_AT - 7_200_000);
    const newest = runId(2);
    await insertRun(newest, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    await insertCompletion(completionFor(newest, PREV_HEAD, PREV_BASE, { verdictCache: false }), RECEIVED_AT - 3_600_000);
    expect(await selectVerdictCacheSource(pool!, current)).toBeNull();
  });

  it('answers the worker only for its own live execution and bearer', async () => {
    const current = runId(100);
    await insertRun(current, { executionAttempt: 0 });
    const lookup = new PostgresVerdictCacheBaseLookup(pool!, { maxAgeMs: 3_600_000 });
    expect(await lookup.read({ runId: current, executionAttempt: 1, workerTokenDigest: TOKEN_DIGEST }))
      .toEqual({ status: 'ok', source: null, maxAgeMs: 3_600_000 });
    expect(await lookup.read({ runId: current, executionAttempt: 1, workerTokenDigest: 'f'.repeat(64) }))
      .toEqual({ status: 'unauthorized' });
    expect(await lookup.read({ runId: current, executionAttempt: 2, workerTokenDigest: TOKEN_DIGEST }))
      .toEqual({ status: 'unauthorized' });
  });

  describe('trusted completion transaction', () => {
    async function fixture() {
      const prior = runId(1);
      await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
      const priorEvent = completionFor(prior, PREV_HEAD, PREV_BASE);
      await insertCompletion(priorEvent, RECEIVED_AT - 3_600_000);
      const id = runId(100);
      await insertRun(id, { generation: 2, executionAttempt: 0 });
      const repository = new PostgresReviewGateRepository(pool!, { lifecycleEvents: 'enabled', verdictCacheMaxAgeMs: 7_200_000 });
      const gate = (await repository.reserve(id, APP_ID, RECEIVED_AT + 1_000))!;
      const claimed = (await repository.claimPublication('test-publisher', RECEIVED_AT + 2_000, 5_000))!;
      await repository.publishLocked(claimed, async () => ({
        id: 8080, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID, headSha: gate.coordinates.headSha,
        externalId: gate.externalId, status: 'queued', conclusion: null,
      }), () => RECEIVED_AT + 3_000);
      await pool!.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [id]);
      await pool!.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [id]);
      const base = completionFor(id, HEAD, BASE);
      const event: WorkerReviewCompletion = {
        ...base,
        result: {
          ...base.result,
          completedAt: new Date(RECEIVED_AT + 30_000).toISOString(),
          verdictCache: {
            version: 'VerdictCache.v1', laneKeys: LANE_KEYS, entries: [ENTRY],
            hits: { runId: prior, executionAttempt: 1, completionDigest: workerReviewCompletionDigest(priorEvent), paths: ['src/same.ts'] },
          },
        },
      };
      const trusted = (verdictCacheVerified: boolean | undefined): TrustedGateCompletionContext => ({
        current: { repositoryId: 3210, prNumber: 42, headSha: HEAD, baseSha: BASE, policyDigest: POLICY, open: true, draft: false },
        coverage: {
          expectedPersonaIds: ['sec-lane'],
          changedFiles: [
            { path: 'src/changed.ts', patch: '@@ -0,0 +1 @@\n+const changed = 1;\n' },
            { path: 'src/same.ts', patch: '@@ -0,0 +1 @@\n+const same = 1;\n' },
          ],
          coverageComplete: true, quorumSatisfied: true,
          ...(verdictCacheVerified === undefined ? {} : { verdictCacheVerified }),
        },
      });
      return { id, repository, event, priorEvent, prior, trusted };
    }

    it('hands the resolver the service\'s own source and counts verified hits', async () => {
      const f = await fixture();
      const seen: unknown[][] = [];
      const resolve = vi.fn(async (...args: [StoredReviewGate, unknown?, VerdictCacheVerificationInput?]) => {
        seen.push(args.slice(1));
        return f.trusted(true);
      });
      await expect(f.repository.recordWorkerResult(f.event, { workerTokenDigest: TOKEN_DIGEST }, resolve, RECEIVED_AT + 40_000))
        .resolves.toBe('recorded');
      expect(seen).toEqual([[undefined, {
        claim: f.event.result.verdictCache,
        source: expect.objectContaining({
          prior: expect.objectContaining({ runId: f.prior, completionDigest: workerReviewCompletionDigest(f.priorEvent), shipComplete: true }),
          entries: [ENTRY],
        }),
        maxAgeMs: 7_200_000,
        run: { runId: f.id, executionAttempt: 1, configDigest: CONFIG },
      }]]);
      const run = (await pool!.query('SELECT status FROM review_runs WHERE run_id = $1', [f.id])).rows[0];
      expect(run.status).toBe('succeeded');
    });

    it('fails the gate when the resolver could not verify the hits (negative proof)', async () => {
      const f = await fixture();
      const resolve = vi.fn(async () => f.trusted(false));
      await expect(f.repository.recordWorkerResult(f.event, { workerTokenDigest: TOKEN_DIGEST }, resolve, RECEIVED_AT + 40_000))
        .resolves.toBe('recorded');
      const run = (await pool!.query('SELECT status, error_text FROM review_runs WHERE run_id = $1', [f.id])).rows[0];
      expect(run).toEqual({ status: 'failed', error_text: 'review gate: invalid-evidence' });
    });

    it('reads no source and passes nothing for a record that only stores entries', async () => {
      const f = await fixture();
      const { hits: _hits, ...entriesOnly } = f.event.result.verdictCache!;
      const resolve = vi.fn(async () => f.trusted(undefined));
      await expect(f.repository.recordWorkerResult({ ...f.event, result: { ...f.event.result, verdictCache: entriesOnly } },
        { workerTokenDigest: TOKEN_DIGEST }, resolve, RECEIVED_AT + 40_000)).resolves.toBe('recorded');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect((resolve.mock.calls[0] as unknown[])).toHaveLength(1);
    });
  });
});
