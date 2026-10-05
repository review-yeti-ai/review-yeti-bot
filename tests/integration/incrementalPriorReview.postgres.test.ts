import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { REVIEW_GATE_CHECK_NAME } from '../../src/github/reviewGateClient';
import {
  PostgresIncrementalBaseLookup,
  selectPriorReviewRecord,
} from '../../src/persistence/incrementalPriorReview';
import {
  PostgresReviewGateRepository,
  type StoredReviewGate,
  type TrustedGateCompletionContext,
} from '../../src/persistence/reviewGateRepository';
import type { IncrementalVerificationInput } from '../../src/review/incrementalReview';
import { sha256 } from '../../src/review/reviewCore';
import { gateRecordFor, resolvedThreadsFor } from '../support/priorGateRecord';
import { initializeOwnedReviewSchema } from '../support/ownedReviewSchema';
import {
  workerReviewCompletionDigest,
  workerReviewEvidenceDigest,
  type WorkerReviewCompletion,
} from '../../src/review/workerReviewCompletion';

import { describeWithPostgres as describeWithPostgresShared, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

// REL-1069: skip locally, fail loudly in CI if the database URL is lost.
requireDatabaseUrlInCi();

/**
 * REL-1084: the one selection of the prior review a carry-forward rests on, in
 * real SQL, and the trusted completion transaction handing the service's OWN
 * record (never the worker's) to the resolver that verifies the claim.
 */
const databaseUrl = postgresDatabaseUrl();
const describeWithPostgres = describeWithPostgresShared;
const OWNED_SCHEMA = /^incremental_prior_test_[0-9a-f]{16}$/u;
const APP_ID = 7001;
const POLICY = 'c'.repeat(64);
const CONFIG = 'e'.repeat(64);
const TOKEN = 'ghs_incremental_test_token';
const TOKEN_DIGEST = sha256(TOKEN);
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PREV_HEAD = '1'.repeat(40);
const PREV_BASE = '2'.repeat(40);
const RECEIVED_AT = Date.parse('2026-09-24T12:00:00.000Z');

function runId(number: number): string {
  return `run_${number.toString(16).padStart(32, '0')}`;
}

function completionFor(id: string, headSha: string, baseSha: string, executionAttempt: number, prNumber = 42,
  findings: WorkerReviewCompletion['result']['personas'][number]['findings'] = []): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', runId: id, repositoryId: 3210, owner: 'exampleorg', repo: 'example-review-actions',
    prNumber, headSha, baseSha, policyDigest: POLICY, configDigest: CONFIG, executionAttempt,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-24T11:00:00.000Z',
      personas: [{ id: 'sec-lane', decision: findings.length > 0 ? 'FINDINGS' : 'APPROVE', status: 'COMPLETE', findings }],
      // No `verdict`: the authoritative worker never sets it (REL-1084).
      coverageComplete: true, quorumSatisfied: true,
    },
  };
}

/** The trusted changed files the gate saw for these fixtures (content-only, no hunks). */
const CHANGED = [{ path: 'src/changed.ts' }, { path: 'src/open.ts' }, { path: 'src/unchanged.ts' }];

describeWithPostgres('incremental prior review selection (real SQL)', () => {
  let pool: Pool | undefined;
  let schemaName: string | undefined;

  async function insertRun(id: string, options: { status?: string; headSha?: string; baseSha?: string; prNumber?: number;
    receivedAt?: number; generation?: number; executionAttempt?: number; appId?: number | null } = {}): Promise<void> {
    const receivedAt = options.receivedAt ?? RECEIVED_AT;
    const headSha = options.headSha ?? HEAD;
    const baseSha = options.baseSha ?? BASE;
    const prNumber = options.prNumber ?? 42;
    const snapshotDigest = sha256(`${id}:${headSha}:${baseSha}`);
    const deliveryId = `incremental-${id}`;
    const identity = { runId: id, owner: 'exampleorg', repo: 'example-review-actions', prNumber,
      headSha, baseSha, snapshotDigest, configDigest: CONFIG };
    await pool!.query(`
      INSERT INTO review_runs (
        run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha, snapshot_digest, config_digest,
        effective_policy_digest, effective_config_digest, identity, publication_mode, status, stage, attempt,
        repository_id, delivery_id, received_at, terminal_deadline, authoritative_gate_app_id
      ) VALUES ($1, $2, 'exampleorg', 'example-review-actions', $3, $4, $5, $6, $7, $8, $7, $9::jsonb,
        'app-gate', $10, 'complete', $11, 3210, $12, to_timestamp($13/1000.0),
        to_timestamp(($13+900000)/1000.0), $14)
    `, [id, sha256(id), prNumber, headSha, baseSha, snapshotDigest, CONFIG, POLICY, JSON.stringify(identity),
      options.status ?? 'queued', options.generation ?? 0, deliveryId, receivedAt,
      options.appId === undefined ? APP_ID : options.appId]);
    await pool!.query(`
      INSERT INTO github_deliveries (delivery_id, event_name, repository_id, installation_id, payload_digest, run_id, received_at)
      VALUES ($1, 'pull_request', 3210, 7002, $2, $3, to_timestamp($4/1000.0))
    `, [deliveryId, sha256(deliveryId), id, receivedAt]);
    await pool!.query(`
      INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, execution_attempt, worker_token_digest)
      VALUES ($1, $2, 'pending', $3, $4)
    `, [id, deliveryId, options.executionAttempt ?? 0, TOKEN_DIGEST]);
  }

  async function insertCompletion(event: WorkerReviewCompletion, createdAt: number,
    options: { gate?: boolean; findingThreads?: ReturnType<typeof resolvedThreadsFor> } = {}): Promise<void> {
    const json = JSON.stringify(event);
    await pool!.query(`
      INSERT INTO review_worker_completions (run_id, execution_attempt, content_digest, payload, byte_length, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, to_timestamp($6/1000.0))
    `, [event.runId, event.executionAttempt, workerReviewCompletionDigest(event), json, Buffer.byteLength(json, 'utf8'), createdAt]);
    if (options.gate !== false) {
      await insertGate(event, options.findingThreads ? { recorded: gateRecordFor(event, {
        expectedPersonaIds: ['sec-lane'], changedFiles: CHANGED, findingThreads: options.findingThreads }) } : {});
    }
  }

  /** The gate attempt row the trusted transaction writes for this completion (`gateRecordFor`). */
  async function insertGate(event: WorkerReviewCompletion,
    options: { generation?: number; recorded?: ReturnType<typeof gateRecordFor> } = {}): Promise<void> {
    const recorded = options.recorded ?? gateRecordFor(event, { expectedPersonaIds: ['sec-lane'], changedFiles: CHANGED });
    const generation = options.generation ?? 0;
    await pool!.query(`
      INSERT INTO review_gate_attempts (attempt_id, run_id, review_generation, execution_attempt, repository_id, pr_number,
        expected_app_id, coordinates, external_id, current_attempt, desired_state, evidence, decision, worker_result_digest)
      VALUES ($1, $2, $12, $3, $4, $5, $6, '{}'::jsonb, $7, false, $8, $9::jsonb, $10::jsonb, $11)
    `, [`gate_${event.runId}_${event.executionAttempt}_${generation}`, event.runId, event.executionAttempt, event.repositoryId,
      event.prNumber, APP_ID, `external_${event.runId}_${event.executionAttempt}_${generation}`, recorded.decision.status,
      recorded.gate.evidence, recorded.gate.decision, recorded.gate.worker_result_digest, generation]);
  }

  beforeAll(async () => {
    schemaName = `incremental_prior_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schemaName}` });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      client.release();
    }
    await initializeOwnedReviewSchema(pool, schemaName);
  });

  afterEach(async () => {
    await pool?.query(`TRUNCATE review_pr_lifecycles, review_event_outbox, review_event_sequence_counters,
      review_gate_attempts, review_worker_completions, review_dispatch_outbox, review_runs CASCADE`);
  });

  afterAll(async () => {
    if (!schemaName) return;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error(`Refusing to drop unowned schema: ${schemaName}`);
    try { await pool?.query(`DROP SCHEMA "${schemaName}" CASCADE`); } finally { await pool?.end(); pool = undefined; }
  });

  it('selects the latest terminal completion and preserves the path of its satisfied P2 (ADR 0002)', async () => {
    const current = runId(100);
    await insertRun(current);
    const older = runId(1);
    const newest = runId(2);
    await insertRun(older, { status: 'succeeded', headSha: '5'.repeat(40), baseSha: PREV_BASE });
    await insertCompletion(completionFor(older, '5'.repeat(40), PREV_BASE, 1), RECEIVED_AT - 7_200_000);
    await insertRun(newest, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    await insertCompletion(completionFor(newest, PREV_HEAD, PREV_BASE, 1, 42,
      [{ severity: 'P2', path: 'src/open.ts', line: 3, title: 't', body: 'b' }]), RECEIVED_AT - 3_600_000,
    { findingThreads: resolvedThreadsFor([{ path: 'src/open.ts', line: 3, title: 't' }]) });
    // Ignored: another PR, and a record stored after this run's admission.
    const otherPr = runId(3);
    await insertRun(otherPr, { status: 'succeeded', prNumber: 43 });
    await insertCompletion(completionFor(otherPr, HEAD, BASE, 1, 43), RECEIVED_AT - 60_000);
    const late = runId(5);
    await insertRun(late, { status: 'succeeded', headSha: '7'.repeat(40) });
    await insertCompletion(completionFor(late, '7'.repeat(40), BASE, 1), RECEIVED_AT + 60_000);

    expect(await selectPriorReviewRecord(pool!, current)).toEqual({
      runId: newest, executionAttempt: 1, repositoryId: 3210, prNumber: 42, headSha: PREV_HEAD, baseSha: PREV_BASE,
      policyDigest: POLICY, configDigest: CONFIG,
      completionDigest: workerReviewCompletionDigest(completionFor(newest, PREV_HEAD, PREV_BASE, 1, 42,
        [{ severity: 'P2', path: 'src/open.ts', line: 3, title: 't', body: 'b' }])),
      ageMs: 3_600_000, shipComplete: true, findingPaths: ['src/open.ts'],
    });
  });

  it.each(['failed', 'superseded', 'running'])('never skips a newer %s review back to an older SHIP', async (status) => {
    const current = runId(100);
    await insertRun(current);
    const ship = runId(1);
    await insertRun(ship, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    await insertCompletion(completionFor(ship, PREV_HEAD, PREV_BASE, 1), RECEIVED_AT - 7_200_000);
    const newer = runId(2);
    await insertRun(newer, { status, headSha: '8'.repeat(40), baseSha: PREV_BASE });
    await insertCompletion(completionFor(newer, '8'.repeat(40), PREV_BASE, 1), RECEIVED_AT - 3_600_000);
    expect(await selectPriorReviewRecord(pool!, current)).toMatchObject({ runId: newer, shipComplete: false });
  });

  it('is not SHIP-complete without the gate\'s record of the completion, whatever the run row says (REL-1084)', async () => {
    const current = runId(100);
    await insertRun(current);
    const prior = runId(1);
    await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    await insertCompletion(completionFor(prior, PREV_HEAD, PREV_BASE, 1), RECEIVED_AT - 3_600_000, { gate: false });
    expect(await selectPriorReviewRecord(pool!, current)).toMatchObject({ runId: prior, shipComplete: false });
    // The gate row for this exact completion makes it SHIP-complete.
    await insertGate(completionFor(prior, PREV_HEAD, PREV_BASE, 1));
    expect(await selectPriorReviewRecord(pool!, current)).toMatchObject({ runId: prior, shipComplete: true });
  });

  it.each([
    ['an older failure then a newer clean SHIP', 'failed-first', true],
    ['an older clean SHIP then a newer failure', 'ship-first', false],
  ] as const)('decides from the latest gate attempt for the same completion: %s', async (_name, order, expected) => {
    const current = runId(100);
    await insertRun(current);
    const prior = runId(1);
    await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    const event = completionFor(prior, PREV_HEAD, PREV_BASE, 1);
    await insertCompletion(event, RECEIVED_AT - 3_600_000, { gate: false });
    const ship = gateRecordFor(event, { expectedPersonaIds: ['sec-lane'], changedFiles: CHANGED });
    const failed = gateRecordFor(event, { expectedPersonaIds: ['sec-lane'], changedFiles: CHANGED, coverageComplete: false });
    expect([ship.decision.status, failed.decision.status]).toEqual(['success', 'failure']);
    await insertGate(event, { generation: 0, recorded: order === 'failed-first' ? failed : ship });
    await insertGate(event, { generation: 1, recorded: order === 'failed-first' ? ship : failed });
    expect(await selectPriorReviewRecord(pool!, current)).toMatchObject({ runId: prior, shipComplete: expected });
  });

  it('is not SHIP-complete when the gate recorded a P1 review as failed', async () => {
    const current = runId(100);
    await insertRun(current);
    const prior = runId(1);
    await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
    await insertCompletion(completionFor(prior, PREV_HEAD, PREV_BASE, 1, 42,
      [{ severity: 'P1', path: 'src/open.ts', line: 3, title: 'Unchecked input reaches the query', body: 'b' }]), RECEIVED_AT - 3_600_000);
    const gate = (await pool!.query('SELECT decision FROM review_gate_attempts WHERE run_id = $1', [prior])).rows[0];
    expect(gate.decision).toMatchObject({ status: 'failure', reason: 'blocking-findings' });
    expect(await selectPriorReviewRecord(pool!, current)).toMatchObject({ runId: prior, shipComplete: false });
  });

  it('lets only a non-authoritative run rest on a non-authoritative WorkerReviewEvidence prior (REL-1084)', async () => {
    const prior = runId(1);
    await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE, appId: null });
    const base = completionFor(prior, PREV_HEAD, PREV_BASE, 1);
    const evidence = { ...base, version: 'WorkerReviewEvidence.v1' as const, checkId: 99, conclusion: 'success' as const,
      result: { ...base.result, roster: ['sec-lane'] } };
    const json = JSON.stringify(evidence);
    await pool!.query(`
      INSERT INTO review_worker_completions (run_id, execution_attempt, content_digest, payload, byte_length, created_at)
      VALUES ($1, 1, $2, $3::jsonb, $4, to_timestamp($5/1000.0))
    `, [prior, workerReviewEvidenceDigest(evidence), json, Buffer.byteLength(json, 'utf8'), RECEIVED_AT - 3_600_000]);
    const nonAuthoritative = runId(100);
    await insertRun(nonAuthoritative, { appId: null });
    expect(await selectPriorReviewRecord(pool!, nonAuthoritative)).toMatchObject({ runId: prior, shipComplete: true });
    const authoritative = runId(101);
    await insertRun(authoritative);
    expect(await selectPriorReviewRecord(pool!, authoritative)).toMatchObject({
      runId: prior, shipComplete: false, shipIncompleteReason: 'no-gate-evidence-record' });
  });

  it('returns null when there is no prior record or the current run is unknown', async () => {
    const current = runId(100);
    await insertRun(current);
    expect(await selectPriorReviewRecord(pool!, current)).toBeNull();
    expect(await selectPriorReviewRecord(pool!, runId(999))).toBeNull();
  });

  it('answers the worker only for its own live execution and bearer', async () => {
    const current = runId(100);
    await insertRun(current, { executionAttempt: 0 });
    const lookup = new PostgresIncrementalBaseLookup(pool!, { maxAgeMs: 3_600_000 });
    expect(await lookup.read({ runId: current, executionAttempt: 1, workerTokenDigest: TOKEN_DIGEST }))
      .toEqual({ status: 'ok', prior: null, maxAgeMs: 3_600_000 });
    expect(await lookup.read({ runId: current, executionAttempt: 1, workerTokenDigest: 'f'.repeat(64) }))
      .toEqual({ status: 'unauthorized' });
    expect(await lookup.read({ runId: current, executionAttempt: 2, workerTokenDigest: TOKEN_DIGEST }))
      .toEqual({ status: 'unauthorized' });
    await pool!.query("UPDATE review_runs SET status = 'succeeded' WHERE run_id = $1", [current]);
    expect(await lookup.read({ runId: current, executionAttempt: 1, workerTokenDigest: TOKEN_DIGEST }))
      .toEqual({ status: 'unauthorized' });
  });

  describe('trusted completion transaction', () => {
    async function fixture() {
      const prior = runId(1);
      await insertRun(prior, { status: 'succeeded', headSha: PREV_HEAD, baseSha: PREV_BASE });
      const priorEvent = completionFor(prior, PREV_HEAD, PREV_BASE, 1);
      await insertCompletion(priorEvent, RECEIVED_AT - 3_600_000);
      const id = runId(100);
      await insertRun(id, { generation: 2, executionAttempt: 0 });
      const repository = new PostgresReviewGateRepository(pool!, { lifecycleEvents: 'enabled', incrementalMaxAgeMs: 7_200_000 });
      const gate = (await repository.reserve(id, APP_ID, RECEIVED_AT + 1_000))!;
      const claimed = (await repository.claimPublication('test-publisher', RECEIVED_AT + 2_000, 5_000))!;
      await repository.publishLocked(claimed, async () => ({
        id: 8080, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID, headSha: gate.coordinates.headSha,
        externalId: gate.externalId, status: 'queued', conclusion: null,
      }), () => RECEIVED_AT + 3_000);
      await pool!.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [id]);
      await pool!.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [id]);
      const event: WorkerReviewCompletion = {
        ...completionFor(id, HEAD, BASE, 1),
        result: {
          ...completionFor(id, HEAD, BASE, 1).result,
          completedAt: new Date(RECEIVED_AT + 30_000).toISOString(),
          incremental: {
            version: 'IncrementalReview.v1', previousRunId: prior, previousExecutionAttempt: 1,
            previousHeadSha: PREV_HEAD, previousBaseSha: PREV_BASE,
            previousCompletionDigest: workerReviewCompletionDigest(priorEvent),
            carriedForwardPaths: ['src/unchanged.ts'],
          },
        },
      };
      const trusted = (incrementalVerified: boolean | undefined): TrustedGateCompletionContext => ({
        current: { repositoryId: 3210, prNumber: 42, headSha: HEAD, baseSha: BASE, policyDigest: POLICY, open: true, draft: false },
        coverage: {
          expectedPersonaIds: ['sec-lane'],
          changedFiles: [
            { path: 'src/changed.ts', patch: '@@ -0,0 +1 @@\n+const changed = 1;\n' },
            { path: 'src/unchanged.ts', patch: '@@ -0,0 +1 @@\n+const unchanged = 1;\n' },
          ],
          coverageComplete: true, quorumSatisfied: true,
          ...(incrementalVerified === undefined ? {} : { incrementalVerified }),
        },
      });
      return { id, repository, event, priorEvent, prior, trusted };
    }

    it('hands the resolver the service\'s own prior record and counts a verified carry-forward', async () => {
      const f = await fixture();
      const seen: Array<IncrementalVerificationInput | undefined> = [];
      const resolve = vi.fn(async (_gate: StoredReviewGate, incremental?: IncrementalVerificationInput) => {
        seen.push(incremental);
        return f.trusted(true);
      });
      await expect(f.repository.recordWorkerResult(f.event, { workerTokenDigest: TOKEN_DIGEST }, resolve, RECEIVED_AT + 40_000))
        .resolves.toBe('recorded');
      expect(seen).toEqual([{
        claim: f.event.result.incremental,
        prior: expect.objectContaining({ runId: f.prior, headSha: PREV_HEAD, completionDigest: workerReviewCompletionDigest(f.priorEvent),
          shipComplete: true, ageMs: 3_600_000 }),
        maxAgeMs: 7_200_000,
        run: { runId: f.id, executionAttempt: 1, configDigest: CONFIG },
      }]);
      const run = (await pool!.query('SELECT status FROM review_runs WHERE run_id = $1', [f.id])).rows[0];
      expect(run.status).toBe('succeeded');
    });

    it('fails the gate when the resolver could not verify the carry-forward (negative proof)', async () => {
      const f = await fixture();
      const resolve = vi.fn(async () => f.trusted(false));
      await expect(f.repository.recordWorkerResult(f.event, { workerTokenDigest: TOKEN_DIGEST }, resolve, RECEIVED_AT + 40_000))
        .resolves.toBe('recorded');
      const run = (await pool!.query('SELECT status, error_text FROM review_runs WHERE run_id = $1', [f.id])).rows[0];
      expect(run).toEqual({ status: 'failed', error_text: 'review gate: invalid-evidence' });
    });

    it('makes a completion recorded by the real trusted transaction a SHIP-complete prior for the next head (REL-1084)', async () => {
      const f = await fixture();
      const { incremental: _claim, ...result } = f.event.result;
      expect(result).not.toHaveProperty('verdict');
      await expect(f.repository.recordWorkerResult({ ...f.event, result }, { workerTokenDigest: TOKEN_DIGEST },
        vi.fn(async () => f.trusted(undefined)), RECEIVED_AT + 40_000)).resolves.toBe('recorded');
      const gate = (await pool!.query('SELECT decision FROM review_gate_attempts WHERE run_id = $1', [f.id])).rows[0];
      expect(gate.decision).toMatchObject({ status: 'success', reason: 'clean-review' });
      // The next head is admitted after the completion row was stored (its created_at is the DB clock).
      const next = runId(200);
      await insertRun(next, { headSha: '9'.repeat(40), receivedAt: Date.now() + 60_000 });
      expect(await selectPriorReviewRecord(pool!, next)).toMatchObject({
        runId: f.id, headSha: HEAD, completionDigest: workerReviewCompletionDigest({ ...f.event, result }), shipComplete: true,
      });
    });

    it('does not read a prior record for a completion without a claim', async () => {
      const f = await fixture();
      const { incremental: _claim, ...result } = f.event.result;
      const resolve = vi.fn(async (_gate: StoredReviewGate, incremental?: IncrementalVerificationInput) => {
        expect(incremental).toBeUndefined();
        return f.trusted(undefined);
      });
      await expect(f.repository.recordWorkerResult({ ...f.event, result }, { workerTokenDigest: TOKEN_DIGEST }, resolve, RECEIVED_AT + 40_000))
        .resolves.toBe('recorded');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve.mock.calls[0]).toHaveLength(1);
    });
  });
});
