import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { REVIEW_CI_SCHEMA_SQL } from '../../src/persistence/reviewCiSchema';
import { enqueueReviewCiCompletionInTransaction, PostgresReviewCiRepository, type ReviewCiRepositoryOptions } from '../../src/persistence/reviewCiRepository';
import {
  createReviewCiLanePlan, reviewCiRequestEvent, reviewCiRunName,
  type ReviewCiAbsentReconciliation, type ReviewCiCoordinates, type ReviewCiDeliveryClaim,
  type ReviewCiExecution, type ReviewCiTerminalReceipt, type ReviewCiValidationBinding, type StoredReviewCiRequest,
} from '../../src/review/reviewCi';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describePg = databaseUrl ? describe : describe.skip;
const OWNED_SCHEMA = /^review_ci_test_[a-f0-9]{16}$/u;
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const APP = 4385771;
const validCurrent = async () => undefined;
// Explicit trusted test seam. Real CI-check identity/publication SQL belongs
// to the independent check repository's integration tests.
const publicationReady: ReviewCiRepositoryOptions = { assertPendingPublished: async () => undefined };

function binding(): ReviewCiValidationBinding {
  return { candidateSha: 'd'.repeat(40), workflowId: 3211,
    workflowPath: '.github/workflows/review-yeti-candidate.yml', workflowRef: 'refs/tags/review-ci-v1',
    workflowSha: 'e'.repeat(40), lanePlan: createReviewCiLanePlan(['core', 'tools'], ['validate']) };
}
function execution(request: StoredReviewCiRequest, epoch = request.workflowEpoch, runId = 1001): ReviewCiExecution {
  return { requestId: request.requestId, epoch, repositoryId: request.review.repositoryId,
    workflowId: request.binding!.workflowId, workflowSha: request.binding!.workflowSha,
    candidateSha: request.binding!.candidateSha, runId, runAttempt: 1,
    event: 'workflow_dispatch', runName: reviewCiRunName(request.requestId, epoch) };
}
function absent(claim: ReviewCiDeliveryClaim, observedAt = NOW + 10): ReviewCiAbsentReconciliation {
  return { outcome: 'absent', requestId: claim.request.requestId, kind: claim.kind, epoch: claim.epoch, observedAt };
}
function receipt(run: ReviewCiExecution): ReviewCiTerminalReceipt {
  return { version: 'ReviewCiTerminalReceipt.v1', execution: run, conclusion: 'success', jobs: [
    { id: 11, runId: run.runId, runAttempt: run.runAttempt, name: 'validate', status: 'completed', conclusion: 'success' },
  ] };
}

describePg('Review CI durable admission — real scoped PostgreSQL', () => {
  let pool: Pool;
  let schema: string;
  let repository: PostgresReviewCiRepository;
  beforeAll(async () => {
    schema = `review_ci_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schema)) throw new Error('Invalid owned test schema');
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, repository_id BIGINT NOT NULL,
      pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL,
      effective_policy_digest TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL
    ); CREATE TABLE review_dispatch_outbox (
      run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id), status TEXT NOT NULL, execution_attempt INTEGER NOT NULL
    );`);
    await pool.query(REVIEW_GATE_SCHEMA_SQL);
    await pool.query(REVIEW_CI_SCHEMA_SQL);
    await pool.query('CREATE TABLE review_ci_hook_test_events(request_id UUID, transition TEXT, snapshot JSONB, clock BIGINT)');
    repository = new PostgresReviewCiRepository(pool, publicationReady);
  });
  afterEach(async () => {
    if (pool) await pool.query('TRUNCATE review_ci_hook_test_events,review_ci_deliveries,review_ci_requests,review_gate_attempts,review_dispatch_outbox,review_runs');
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      if (!OWNED_SCHEMA.test(schema)) throw new Error('Refusing to drop unowned test schema');
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await pool.end(); }
  });

  async function fixture(sequence = 1, prNumber = 42): Promise<ReviewCiCoordinates> {
    const runId = `run_${sequence.toString(16).padStart(32, '0')}`;
    const review: ReviewCiCoordinates = { repositoryId: 1232078607, owner: 'calltelemetry', repo: 'ct-meta', prNumber,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64),
      runId, reviewGeneration: 0, executionAttempt: 1, attemptId: `${runId}-g0-e1` };
    await pool.query(`INSERT INTO review_runs VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',0,$9)`,
      [runId, review.owner, review.repo, review.repositoryId, prNumber, review.headSha, review.baseSha, review.policyDigest, APP]);
    await pool.query("INSERT INTO review_dispatch_outbox VALUES($1,'projected',0)", [runId]);
    await insertGate(review);
    return review;
  }
  async function insertGate(review: ReviewCiCoordinates): Promise<void> {
    const { reviewGeneration, ...coordinates } = review;
    await pool.query(`INSERT INTO review_gate_attempts(attempt_id,run_id,review_generation,execution_attempt,
      repository_id,pr_number,expected_app_id,coordinates,external_id,check_id,creation_state,desired_state,published_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,'bound','in_progress',0)`,
    [review.attemptId, review.runId, reviewGeneration, review.executionAttempt, review.repositoryId, review.prNumber, APP,
      JSON.stringify(coordinates), 100_000 + review.prNumber + reviewGeneration]);
  }
  async function terminalUpdates(client: PoolClient, review: ReviewCiCoordinates): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`review-dispatch:${review.repositoryId}:${review.prNumber}`]);
    await client.query(`UPDATE review_gate_attempts SET desired_state='success',desired_version=1,
      decision='{"status":"success","eligible":true,"reason":"clean-review"}' WHERE attempt_id=$1`, [review.attemptId]);
    await client.query("UPDATE review_runs SET status='succeeded' WHERE run_id=$1", [review.runId]);
  }
  async function complete(review: ReviewCiCoordinates): Promise<StoredReviewCiRequest> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await terminalUpdates(client, review);
      const request = await enqueueReviewCiCompletionInTransaction(client, review.attemptId, NOW);
      await client.query('COMMIT');
      return request!;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function published(review: ReviewCiCoordinates): Promise<void> {
    await pool.query('UPDATE review_gate_attempts SET published_version=desired_version WHERE attempt_id=$1', [review.attemptId]);
  }
  async function repositoryIntent(requestId: string): Promise<ReviewCiDeliveryClaim> {
    // Use the actual committed lease transition, not a fixture-only SQL state.
    // A generation-history test may also have an older pending request ahead.
    for (let count = 0; count < 32; count++) {
      const claim = await repository.claimDelivery('repository', 'first-hop-worker', NOW, 1000);
      if (!claim) break;
      if (claim.request.requestId === requestId) return claim;
    }
    throw new Error('Expected repository-dispatch intent was not claimable');
  }
  async function admitted(sequence = 1, pr = 42): Promise<StoredReviewCiRequest> {
    const review = await fixture(sequence, pr);
    const request = await complete(review);
    await published(review);
    await repositoryIntent(request.requestId);
    expect(await repository.admit(request.requestId, binding(), validCurrent, NOW)).toBe('recorded');
    return (await repository.get(request.requestId))!;
  }
  async function delivery(request?: StoredReviewCiRequest): Promise<ReviewCiDeliveryClaim> {
    if (!request) await admitted();
    return (await repository.claimDelivery('workflow', 'worker', NOW, 1000))!;
  }
  async function uncertain(claim: ReviewCiDeliveryClaim): Promise<ReviewCiDeliveryClaim> {
    expect(await repository.markDeliveryUncertain(claim, 'timeout', NOW + 1, 0)).toBe('recorded');
    return (await repository.claimDelivery(claim.kind, 'reconciler', NOW + 2, 1000))!;
  }

  it('installs additively/idempotently and constructor never queries', async () => {
    await pool.query(REVIEW_CI_SCHEMA_SQL);
    const fake = { query: vi.fn(), connect: vi.fn() };
    new PostgresReviewCiRepository(fake);
    expect(fake.query).not.toHaveBeenCalled(); expect(fake.connect).not.toHaveBeenCalled();
    expect((await pool.query('SHOW search_path')).rows[0].search_path).toBe(schema);
  });
  it('commits terminal source state and repository-dispatch intent atomically, without a nested commit', async () => {
    const review = await fixture();
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await terminalUpdates(client, review);
      const request = (await enqueueReviewCiCompletionInTransaction(client, review.attemptId, NOW))!;
      expect(request.state).toBe('pending'); expect(request.binding).toBeNull();
      expect((await pool.query('SELECT * FROM review_ci_requests')).rows).toEqual([]);
      expect((await pool.query('SELECT status FROM review_runs')).rows[0].status).toBe('running');
      await client.query('ROLLBACK');
      expect(await repository.get(request.requestId)).toBeNull();
      expect((await pool.query('SELECT * FROM review_ci_deliveries')).rows).toEqual([]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    const committed = await complete(review);
    expect((await pool.query('SELECT status FROM review_runs')).rows[0].status).toBe('succeeded');
    expect((await pool.query('SELECT kind,state FROM review_ci_deliveries')).rows).toEqual([{ kind: 'repository', state: 'pending' }]);
    expect(reviewCiRequestEvent(committed)).toMatchObject({ policy_digest: 'c'.repeat(64), validation_request_id: committed.requestId });
  });
  it('an intent SQL failure rolls back the caller terminal update', async () => {
    const review = await fixture();
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await terminalUpdates(client, review);
      await client.query("ALTER TABLE review_ci_requests ADD CONSTRAINT test_reject CHECK (false) NOT VALID");
      await expect(enqueueReviewCiCompletionInTransaction(client, review.attemptId, NOW)).rejects.toThrow('could not be saved');
      await client.query('ROLLBACK');
      expect((await pool.query('SELECT status FROM review_runs')).rows[0].status).toBe('running');
      expect((await pool.query('SELECT * FROM review_ci_requests')).rows).toEqual([]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('concurrent repeated completion produces one stable request and one dispatch intent', async () => {
    const review = await fixture();
    const requests = await Promise.all(Array.from({ length: 6 }, () => complete(review)));
    expect(new Set(requests.map((r) => r.requestId)).size).toBe(1);
    expect((await pool.query('SELECT * FROM review_ci_requests')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM review_ci_deliveries')).rows).toHaveLength(1);
  });
  it.each([
    ["UPDATE review_gate_attempts SET desired_state='failure'", 'noneligible'],
    ["UPDATE review_gate_attempts SET decision='{}'", 'missing eligible evidence'],
    ['UPDATE review_gate_attempts SET current_attempt=false', 'superseded'],
    ['UPDATE review_runs SET attempt=1', 'old generation'],
    ['UPDATE review_dispatch_outbox SET execution_attempt=1', 'old execution'],
    ['UPDATE review_runs SET authoritative_gate_app_id=123', 'foreign App'],
    ["UPDATE review_runs SET status='failed'", 'failed source'],
  ])('does not enqueue %s (%s)', async (sql) => {
    const review = await fixture(); await complete(review);
    await pool.query('TRUNCATE review_ci_deliveries,review_ci_requests');
    await pool.query(sql);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await enqueueReviewCiCompletionInTransaction(client, review.attemptId, NOW)).toBeNull();
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await pool.query('SELECT * FROM review_ci_requests')).rows).toEqual([]);
  });
  it('same run ID with a new review generation and unchanged execution preserves independent request history', async () => {
    const review = await fixture(); const old = await complete(review);
    await repositoryIntent(old.requestId);
    await pool.query('UPDATE review_gate_attempts SET current_attempt=false');
    await pool.query('UPDATE review_runs SET attempt=1');
    const next = { ...review, reviewGeneration: 1, attemptId: `${review.runId}-g1-e1` };
    await insertGate(next);
    const current = await complete(next);
    expect(current.requestId).not.toBe(old.requestId);
    expect(current.review.executionAttempt).toBe(old.review.executionAttempt);
    expect((await repository.get(old.requestId))!.review).toEqual(review);
    expect((await repository.get(current.requestId))!.review).toEqual(next);
    await published(next);
    await repositoryIntent(current.requestId);
    expect(await repository.admit(old.requestId, binding(), validCurrent, NOW)).toBe('stale');
    expect(await repository.admit(current.requestId, binding(), validCurrent, NOW)).toBe('recorded');
  });
  it('requires published eligibility and successful fresh readiness before freezing C/W/lanes', async () => {
    const review = await fixture(); const request = await complete(review);
    await repositoryIntent(request.requestId);
    const validate = vi.fn(validCurrent);
    expect(await repository.admit(request.requestId, binding(), validate, NOW)).toBe('stale');
    expect(validate).not.toHaveBeenCalled();
    await published(review);
    await expect(repository.admit(request.requestId, binding(), async () => { throw new Error('draft/server-secret'); }, NOW)).rejects.toThrow('persistence operation failed');
    expect((await repository.get(request.requestId))!.binding).toBeNull();
    expect((await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow'")).rows).toEqual([]);
    expect(await repository.admit(request.requestId, binding(), validate, NOW)).toBe('recorded');
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId }), binding());
  });
  it('cannot admit a fully eligible request before a first-hop POST intent is committed', async () => {
    const review = await fixture(); const request = await complete(review); await published(review);
    const validate = vi.fn(validCurrent);
    const hook = vi.fn(async () => undefined);
    const guarded = new PostgresReviewCiRepository(pool, { ...publicationReady, onTransition: hook });
    expect(await guarded.admit(request.requestId, binding(), validate, NOW)).toBe('stale');
    expect(validate).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
    expect((await repository.get(request.requestId))!).toMatchObject({ state: 'pending', binding: null, workflowEpoch: 0 });
    expect((await pool.query('SELECT kind,state FROM review_ci_deliveries')).rows).toEqual([{ kind: 'repository', state: 'pending' }]);
    await repositoryIntent(request.requestId);
    expect(await guarded.admit(request.requestId, binding(), validate, NOW + 1)).toBe('recorded');
    expect(validate).toHaveBeenCalledTimes(1); expect(hook).toHaveBeenCalledTimes(1);
  });
  it.each(['dispatching', 'uncertain', 'dispatched'] as const)('admits after committed first-hop %s, including receiver-before-ACK recovery', async (state) => {
    const review = await fixture(); const request = await complete(review); await published(review);
    const claim = await repositoryIntent(request.requestId);
    if (state === 'uncertain') expect(await repository.markDeliveryUncertain(claim, 'timeout', NOW + 1, 1000)).toBe('recorded');
    if (state === 'dispatched') expect(await repository.acknowledgeRepositoryDispatch(claim, NOW + 1)).toBe('recorded');
    expect((await pool.query("SELECT state FROM review_ci_deliveries WHERE kind='repository'")).rows[0].state).toBe(state);
    expect(await repository.admit(request.requestId, binding(), validCurrent, NOW + 2)).toBe('recorded');
    // Admission acknowledges receipt durably and fences a late sender response.
    expect(await repository.acknowledgeRepositoryDispatch(claim, NOW + 3)).toBe('stale');
    expect((await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow'")).rows).toHaveLength(1);
  });
  it.each(['fenced', 'terminal_error', 'missing'])('rejects first-hop %s without creating a workflow intent', async (state) => {
    const review = await fixture(); const request = await complete(review); await published(review);
    if (state === 'missing') await pool.query("DELETE FROM review_ci_deliveries WHERE kind='repository'");
    else await pool.query("UPDATE review_ci_deliveries SET state=$1 WHERE kind='repository'", [state]);
    const validate = vi.fn(validCurrent);
    expect(await repository.admit(request.requestId, binding(), validate, NOW)).toBe('stale');
    expect(validate).not.toHaveBeenCalled();
    expect((await repository.get(request.requestId))!.binding).toBeNull();
    expect((await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow'")).rows).toEqual([]);
  });
  it('bounds a hung freshness read and releases the lock for a subsequent admission', async () => {
    const review = await fixture(); const request = await complete(review); await published(review);
    await repositoryIntent(request.requestId);
    const bounded = new PostgresReviewCiRepository(pool, { admissionTimeoutMs: 50 });
    await expect(bounded.admit(request.requestId, binding(), () => new Promise(() => undefined), NOW)).rejects.toThrow('persistence operation failed');
    expect(await repository.admit(request.requestId, binding(), validCurrent, NOW)).toBe('recorded');
  });
  it('callback mutation cannot replace persisted review coordinates or candidate binding', async () => {
    const review = await fixture(); const request = await complete(review); await published(review);
    await repositoryIntent(request.requestId);
    await repository.admit(request.requestId, binding(), async (r, b) => {
      r.review.headSha = 'f'.repeat(40); b.workflowSha = 'f'.repeat(40);
    }, NOW);
    const stored = (await repository.get(request.requestId))!;
    expect(stored.review).toEqual(review); expect(stored.binding).toEqual(binding());
  });
  it('concurrent admission is once-active and idempotent; immutable identity cannot be rebound', async () => {
    const review = await fixture(); const request = await complete(review); await published(review);
    await repositoryIntent(request.requestId);
    const validate = vi.fn(validCurrent);
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.admit(request.requestId, binding(), validate, NOW)));
    expect(results.filter((r) => r === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(5);
    expect(validate).toHaveBeenCalledTimes(1);
    for (const changed of [
      { ...binding(), candidateSha: 'f'.repeat(40) }, { ...binding(), workflowSha: 'f'.repeat(40) },
      { ...binding(), workflowRef: 'refs/heads/main' },
      { ...binding(), lanePlan: createReviewCiLanePlan(['core'], ['different-job']) },
    ]) expect(await repository.admit(request.requestId, changed, validCurrent, NOW)).toBe('conflict');
    expect((await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow'")).rows).toHaveLength(1);
  });
  it.each(['review', 'binding', 'identity_digest', 'request_id'])('database enforces immutable %s', async (column) => {
    await admitted();
    const replacements: Record<string, string> = { review: "jsonb_set(review,'{headSha}','\"ffffffffffffffffffffffffffffffffffffffff\"')",
      binding: "jsonb_set(binding,'{candidateSha}','\"ffffffffffffffffffffffffffffffffffffffff\"')",
      identity_digest: "repeat('f',64)", request_id: "'00000000-0000-4000-8000-000000000001'::uuid" };
    await expect(pool.query(`UPDATE review_ci_requests SET ${column}=${replacements[column]}`)).rejects.toThrow('immutable');
  });
  it('does not silently supersede an active validation when admitting a newer generation', async () => {
    const old = await admitted();
    await pool.query('UPDATE review_gate_attempts SET current_attempt=false');
    await pool.query('UPDATE review_runs SET attempt=1');
    const next = { ...old.review, reviewGeneration: 1, attemptId: `${old.review.runId}-g1-e1` };
    await insertGate(next); const request = await complete(next); await published(next);
    await repositoryIntent(request.requestId);
    expect(await repository.admit(request.requestId, binding(), validCurrent, NOW)).toBe('busy');
    expect(await repository.supersede(old.requestId, NOW)).toBe('recorded');
    expect(await repository.admit(request.requestId, binding(), validCurrent, NOW)).toBe('recorded');
  });
  it('one leased repository dispatch under concurrency; ACK is durable but does not admit execution', async () => {
    const request = await complete(await fixture());
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => repository.claimDelivery('repository', `worker-${n}`, NOW, 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const claim = results.find(Boolean)!;
    expect(claim.mode).toBe('dispatch');
    expect(await repository.acknowledgeRepositoryDispatch(claim, NOW + 1)).toBe('recorded');
    expect(await repository.claimDelivery('repository', 'worker', NOW + 2000)).toBeNull();
    expect((await repository.get(request.requestId))!.state).toBe('pending');
  });
  it('repository uncertain retry requires reconciliation and retains the stable wire request', async () => {
    await complete(await fixture());
    const claim = (await repository.claimDelivery('repository', 'worker', NOW, 1000))!;
    const retry = await uncertain(claim);
    expect(retry.mode).toBe('reconcile');
    expect(await repository.retryUncertainDelivery(retry, absent(retry), NOW + 10, 0)).toBe('recorded');
    const next = (await repository.claimDelivery('repository', 'worker', NOW + 11))!;
    expect(next.mode).toBe('dispatch');
    expect(reviewCiRequestEvent(next.request)).toEqual(reviewCiRequestEvent(claim.request));
  });
  it('one workflow dispatch lease under concurrency and expiry never grants another POST for the epoch', async () => {
    await admitted();
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => repository.claimDelivery('workflow', `worker-${n}`, NOW, 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const first = results.find(Boolean)!;
    const reclaimed = (await repository.claimDelivery('workflow', first.leaseOwner, NOW + 1000, 1000))!;
    expect(reclaimed.mode).toBe('reconcile'); expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    expect(await repository.markDeliveryUncertain(first, 'timeout', NOW + 1001, 0)).toBe('stale');
    expect(await repository.acknowledgeWorkflowDispatch(first, execution(first.request), NOW + 1001)).toBe('stale');
    expect(await repository.retryUncertainDelivery(first, absent(first, NOW + 1001), NOW + 1001, 0)).toBe('stale');
    const row = (await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow'")).rows[0];
    expect(row.lease_token).toBe(reclaimed.leaseToken); expect(row.dispatch_count).toBe(1);
  });
  it('defers workflow POST intent until the CI publisher has caught up', async () => {
    const request = await admitted();
    let pendingCheckPublished = false;
    const proof = vi.fn(async () => { if (!pendingCheckPublished) throw new Error('pending check not yet published'); });
    const guarded = new PostgresReviewCiRepository(pool, { assertPendingPublished: proof });
    expect(await guarded.claimDelivery('workflow', 'worker', NOW, 1000)).toBeNull();
    const pending = (await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow'")).rows[0];
    expect(pending).toMatchObject({ state: 'pending', epoch: 1, dispatch_count: 0,
      dispatch_started_at: null, lease_owner: null, lease_token: null, lease_expires_at: null, last_error_class: null });
    expect((await repository.get(request.requestId))!).toMatchObject({ state: 'admitted', workflowEpoch: 1, execution: null });
    pendingCheckPublished = true;
    expect(await guarded.claimDelivery('workflow', 'worker', NOW + 999, 1000)).toBeNull();
    const claim = (await guarded.claimDelivery('workflow', 'worker', NOW + 1000, 1000))!;
    expect(claim).toMatchObject({ mode: 'dispatch', epoch: 1, request: { requestId: request.requestId } });
    expect(proof).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT state,dispatch_count FROM review_ci_deliveries WHERE kind='workflow'")).rows[0])
      .toEqual({ state: 'dispatching', dispatch_count: 1 });
  });
  it('missing publication hook fails closed before first workflow POST but does not block uncertain reconciliation', async () => {
    const request = await admitted();
    const unconfigured = new PostgresReviewCiRepository(pool);
    expect(await unconfigured.claimDelivery('workflow', 'worker', NOW, 1000)).toBeNull();
    expect((await pool.query("SELECT state,dispatch_count,lease_token FROM review_ci_deliveries WHERE kind='workflow'")).rows[0])
      .toEqual({ state: 'pending', dispatch_count: 0, lease_token: null });
    const first = (await repository.claimDelivery('workflow', 'worker', NOW + 1000, 1000))!;
    expect(first.mode).toBe('dispatch');
    const recovered = (await unconfigured.claimDelivery('workflow', 'worker', NOW + 2000, 1000))!;
    expect(recovered).toMatchObject({ mode: 'reconcile', epoch: 1, request: { requestId: request.requestId } });
    expect((await pool.query("SELECT dispatch_count FROM review_ci_deliveries WHERE kind='workflow'")).rows[0].dispatch_count).toBe(1);
  });
  it.each(['not-ready', 'sql-failure', 'write-then-reject'])('continues other candidates after publication prerequisite %s', async (failure) => {
    const requests = [await admitted(1, 42), await admitted(2, 43)].sort((a, b) => a.requestId.localeCompare(b.requestId));
    const proof = vi.fn<NonNullable<ReviewCiRepositoryOptions['assertPendingPublished']>>(async (client, request) => {
      if (request.requestId !== requests[0].requestId) return;
      if (failure === 'sql-failure') await client.query('SELECT 1/0');
      if (failure === 'write-then-reject') {
        await client.query('INSERT INTO review_ci_hook_test_events VALUES($1,$2,$3,$4)',
          [request.requestId, 'rejected-predicate', JSON.stringify(request), NOW]);
      }
      throw new Error('not ready');
    });
    const guarded = new PostgresReviewCiRepository(pool, { assertPendingPublished: proof });
    const claim = (await guarded.claimDelivery('workflow', 'worker', NOW, 1000))!;
    expect(claim.request.requestId).toBe(requests[1].requestId); expect(claim.mode).toBe('dispatch');
    expect(proof).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT state,dispatch_count FROM review_ci_deliveries WHERE kind='workflow' AND request_id=$1", [requests[0].requestId])).rows[0])
      .toEqual({ state: 'pending', dispatch_count: 0 });
    expect((await pool.query('SELECT * FROM review_ci_hook_test_events')).rows).toEqual([]);
  });
  it('checks publication under PR lock before committing any workflow POST authority', async () => {
    const request = await admitted();
    const guarded = new PostgresReviewCiRepository(pool, { assertPendingPublished: async (client, current, now) => {
      expect(current).toEqual(request); expect(now).toBe(NOW);
      expect((await pool.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
        [`review-dispatch:${current.review.repositoryId}:${current.review.prNumber}`])).rows[0].acquired).toBe(false);
      expect((await client.query("SELECT state,dispatch_count,dispatch_started_at,lease_token FROM review_ci_deliveries WHERE kind='workflow'")).rows[0])
        .toEqual({ state: 'pending', dispatch_count: 0, dispatch_started_at: null, lease_token: null });
      current.review.headSha = 'f'.repeat(40);
    } });
    const claim = (await guarded.claimDelivery('workflow', 'worker', NOW, 1000))!;
    expect(claim.request.review).toEqual(request.review);
  });
  it('deferral rotates 25 unpublished checks behind other due candidates without dispatching any of them', async () => {
    for (let n = 1; n <= 26; n++) await admitted(n, 100 + n);
    const requests = await repository.listPending(100);
    const last = requests.at(-1)!;
    const guarded = new PostgresReviewCiRepository(pool, { assertPendingPublished: async (_client, request) => {
      if (request.requestId !== last.requestId) throw new Error('not ready');
    } });
    expect(await guarded.claimDelivery('workflow', 'worker', NOW, 1000)).toBeNull();
    const next = (await guarded.claimDelivery('workflow', 'worker', NOW + 5000, 1000))!;
    expect(next.request.requestId).toBe(last.requestId);
    expect((await pool.query("SELECT * FROM review_ci_deliveries WHERE kind='workflow' AND dispatch_count>0")).rows).toHaveLength(1);
  });
  it('ACK binds the exact run but does not confer execution; a different run cannot replace it', async () => {
    const claim = await delivery(); const run = execution(claim.request);
    expect(await repository.acknowledgeWorkflowDispatch(claim, run, NOW + 1, 0)).toBe('recorded');
    expect((await repository.get(run.requestId))!.execution).toBeNull();
    const observed = (await repository.claimDelivery('workflow', 'observer', NOW + 2))!;
    expect(observed.mode).toBe('reconcile');
    expect(await repository.retryUncertainDelivery(observed, absent(observed), NOW + 10, 0)).toBe('conflict');
    expect(await repository.claimExecution({ ...run, runId: run.runId + 1 }, validCurrent, NOW + 3)).toBe('conflict');
    expect(await repository.claimExecution(run, validCurrent, NOW + 3)).toBe('recorded');
  });
  it.each(['workflowSha', 'candidateSha', 'repositoryId', 'workflowId'])('rejects mismatched ACK %s without storing it', async (field) => {
    const claim = await delivery(); const run = execution(claim.request);
    const wrong = { ...run, [field]: field.endsWith('Sha') ? 'f'.repeat(40) : 555 };
    expect(await repository.acknowledgeWorkflowDispatch(claim, wrong, NOW + 1)).toBe('conflict');
    expect((await pool.query("SELECT acknowledged_run FROM review_ci_deliveries WHERE kind='workflow'")).rows[0].acknowledged_run).toBeNull();
  });
  it('reconciles unknown ACK before a new epoch; late old run cannot execute', async () => {
    const first = await delivery(); const retry = await uncertain(first);
    expect(await repository.retryUncertainDelivery(retry, absent(retry, NOW - 1), NOW + 10, 0)).toBe('conflict');
    expect(await repository.retryUncertainDelivery(retry, absent(retry, NOW + 11), NOW + 10, 0)).toBe('conflict');
    expect(await repository.retryUncertainDelivery(retry, absent(retry), NOW + 10, 50)).toBe('recorded');
    const stored = (await repository.get(first.request.requestId))!;
    expect(stored.workflowEpoch).toBe(2); expect(stored.identityDigest).toBe(first.request.identityDigest);
    expect(await repository.claimDelivery('workflow', 'worker', NOW + 59)).toBeNull();
    expect(await repository.claimExecution(execution(first.request), validCurrent, NOW + 20)).toBe('stale');
    const next = (await repository.claimDelivery('workflow', 'worker', NOW + 60))!;
    expect(next.mode).toBe('dispatch'); expect(next.epoch).toBe(2);
    expect(next.request.requestId).toBe(first.request.requestId);
    expect(await repository.claimExecution(execution(next.request), validCurrent, NOW + 61)).toBe('recorded');
    const history = (await pool.query("SELECT epoch,state,reconciliation FROM review_ci_deliveries WHERE kind='workflow' ORDER BY epoch")).rows;
    expect(history.map((r) => r.state)).toEqual(['fenced', 'claimed']);
    expect(history[0].reconciliation).toEqual(absent(retry));
  });
  it('cannot retry without first entering reconcile-only state', async () => {
    const first = await delivery();
    expect(await repository.retryUncertainDelivery(first, absent(first), NOW + 10, 0)).toBe('conflict');
    expect((await repository.get(first.request.requestId))!.workflowEpoch).toBe(1);
  });
  it('rejects a negative readback predating the current reconciliation lease', async () => {
    const first = await delivery();
    const reclaimed = (await repository.claimDelivery('workflow', 'reconciler', NOW + 1000, 1000))!;
    expect(await repository.retryUncertainDelivery(reclaimed, absent(reclaimed, NOW + 500), NOW + 1001, 0)).toBe('conflict');
    expect((await repository.get(first.request.requestId))!.workflowEpoch).toBe(1);
    expect(await repository.retryUncertainDelivery(reclaimed, absent(reclaimed, NOW + 1001), NOW + 1001, 0)).toBe('recorded');
  });
  it('execution accepted before ACK fences the publisher lease and every later retry', async () => {
    const claim = await delivery(); const run = execution(claim.request);
    expect(await repository.claimExecution(run, validCurrent, NOW + 1)).toBe('recorded');
    expect(await repository.markDeliveryUncertain(claim, 'timeout', NOW + 2, 0)).toBe('stale');
    expect(await repository.acknowledgeWorkflowDispatch(claim, run, NOW + 2)).toBe('stale');
    expect(await repository.claimDelivery('workflow', 'worker', NOW + 100_000)).toBeNull();
    expect(await repository.retryUncertainDelivery(claim, absent(claim), NOW + 100_000, 0)).toBe('stale');
  });
  it('execution claim racing an uncertain-ACK epoch retry permits exactly one route', async () => {
    const first = await delivery(); const retry = await uncertain(first);
    const [claimed, retried] = await Promise.all([
      repository.claimExecution(execution(first.request), validCurrent, NOW + 10),
      repository.retryUncertainDelivery(retry, absent(retry), NOW + 10, 0),
    ]);
    expect([claimed, retried].filter((r) => r === 'recorded')).toHaveLength(1);
    const stored = (await repository.get(first.request.requestId))!;
    expect(stored.execution !== null ? stored.workflowEpoch === 1 : stored.workflowEpoch === 2).toBe(true);
  });
  it('one execution across concurrent runs; same run duplicate and rerun attempt cannot authorize another execution', async () => {
    const claim = await delivery();
    const runs = Array.from({ length: 6 }, (_, n) => execution(claim.request, 1, 1001 + n));
    const results = await Promise.all(runs.map((run) => repository.claimExecution(run, validCurrent, NOW + 1)));
    expect(results.filter((r) => r === 'recorded')).toHaveLength(1);
    const winner = runs[results.indexOf('recorded')];
    expect(await repository.claimExecution(winner, validCurrent, NOW + 100_000)).toBe('duplicate');
    expect(await repository.claimExecution({ ...winner, runAttempt: 2 }, validCurrent, NOW + 100_000)).toBe('conflict');
  });
  it('one GitHub run ID cannot bind two concurrent requests across different PR locks', async () => {
    await admitted(1, 42); await admitted(2, 43);
    const first = (await repository.claimDelivery('workflow', 'worker-1', NOW, 1000))!;
    const second = (await repository.claimDelivery('workflow', 'worker-2', NOW, 1000))!;
    const results = await Promise.all([first, second].map((claim) => repository.claimExecution(execution(claim.request), validCurrent, NOW + 1)));
    expect(results.sort()).toEqual(['conflict', 'recorded']);
    expect((await pool.query("SELECT request_id FROM review_ci_requests WHERE state='running'")).rows).toHaveLength(1);
  });
  it('manual/pre-dispatch execution and superseded late execution cannot claim', async () => {
    const request = await admitted();
    expect(await repository.claimExecution(execution(request), validCurrent, NOW)).toBe('stale');
    const claim = await delivery(request);
    await repository.supersede(request.requestId, NOW + 1);
    expect(await repository.claimExecution(execution(request), validCurrent, NOW + 2)).toBe('stale');
    expect(await repository.acknowledgeWorkflowDispatch(claim, execution(request), NOW + 2)).toBe('stale');
    expect(await repository.claimDelivery('workflow', 'worker', NOW + 5000)).toBeNull();
  });
  it('bounded dispatch exhaustion remains non-success and rejects late execution', async () => {
    const first = await delivery(); const retry = await uncertain(first);
    const bounded = new PostgresReviewCiRepository(pool, { maxDispatchAttempts: 1 });
    expect(await bounded.retryUncertainDelivery(retry, absent(retry), NOW + 10, 0)).toBe('exhausted');
    expect((await repository.get(first.request.requestId))!.state).toBe('delivery_error');
    expect(await repository.claimExecution(execution(first.request), validCurrent, NOW + 11)).toBe('stale');
    expect(await repository.claimDelivery('workflow', 'worker', NOW + 1000)).toBeNull();
  });
  it('binds terminal jobs to the exact execution, consumes admission, and preserves idempotent receipt', async () => {
    const claim = await delivery(); const run = execution(claim.request);
    expect(await repository.claimExecution(run, validCurrent, NOW + 1)).toBe('recorded');
    const result = receipt(run);
    expect(await repository.recordTerminalReceipt(result, validCurrent, NOW + 2)).toBe('recorded');
    expect(await repository.recordTerminalReceipt(result, validCurrent, NOW + 3)).toBe('duplicate');
    expect(await repository.recordTerminalReceipt({ ...result, conclusion: 'failure' }, validCurrent, NOW + 3)).toBe('conflict');
    const stored = (await repository.get(run.requestId))!;
    expect(stored.state).toBe('completed'); expect(stored.terminalReceipt).toEqual(result);
    expect(await repository.admit(run.requestId, binding(), validCurrent, NOW + 4)).toBe('duplicate');
    expect(await repository.claimExecution(run, validCurrent, NOW + 4)).toBe('stale');
    expect(await repository.claimDelivery('workflow', 'worker', NOW + 100_000)).toBeNull();
  });
  it.each(['skipped', 'neutral', 'failure', 'cancelled', 'timed_out'])('overall green cannot hide required job %s', async (conclusion) => {
    const claim = await delivery(); const run = execution(claim.request); await repository.claimExecution(run, validCurrent, NOW + 1);
    const result = receipt(run); result.jobs[0].conclusion = conclusion as ReviewCiTerminalReceipt['conclusion'];
    expect(await repository.recordTerminalReceipt(result, validCurrent, NOW + 2)).toBe('conflict');
    expect((await repository.get(run.requestId))!.state).toBe('running');
  });
  it('rejects missing/ambiguous required jobs and accepts explicit terminal failure', async () => {
    const claim = await delivery(); const run = execution(claim.request); await repository.claimExecution(run, validCurrent, NOW + 1);
    const missing = receipt(run); missing.jobs[0].name = 'preflight';
    expect(await repository.recordTerminalReceipt(missing, validCurrent, NOW + 2)).toBe('conflict');
    const ambiguous = receipt(run); ambiguous.jobs.push({ ...ambiguous.jobs[0], id: 12 });
    expect(await repository.recordTerminalReceipt(ambiguous, validCurrent, NOW + 2)).toBe('conflict');
    expect(await repository.recordTerminalReceipt({ ...missing, conclusion: 'failure' }, validCurrent, NOW + 2)).toBe('recorded');
  });
  it('rejects wrong run/attempt/candidate/workflow receipts and never stores untrusted authority fields', async () => {
    const claim = await delivery(); const run = execution(claim.request); await repository.claimExecution(run, validCurrent, NOW + 1);
    for (const changed of [{ ...run, runId: 2000 }, { ...run, runAttempt: 2 },
      { ...run, candidateSha: 'f'.repeat(40) }, { ...run, workflowSha: 'f'.repeat(40) }]) {
      expect(await repository.recordTerminalReceipt(receipt(changed), validCurrent, NOW + 2)).toBe('conflict');
    }
    await expect(repository.recordTerminalReceipt({ ...receipt(run), checkId: 123, resultUrl: 'https://evil.invalid' }, validCurrent, NOW + 2)).rejects.toThrow();
    const wrongJobs = receipt(run); wrongJobs.jobs[0].runId++;
    await expect(repository.recordTerminalReceipt(wrongJobs, validCurrent, NOW + 2)).rejects.toThrow();
    expect((await repository.get(run.requestId))!.terminalReceipt).toBeNull();
  });
  it('supersession fences a running request and its late terminal receipt', async () => {
    const claim = await delivery(); const run = execution(claim.request); await repository.claimExecution(run, validCurrent, NOW + 1);
    await repository.supersede(run.requestId, NOW + 2);
    expect(await repository.recordTerminalReceipt(receipt(run), validCurrent, NOW + 3)).toBe('stale');
    expect((await repository.get(run.requestId))!.execution).toEqual(run);
  });

  describe.each(['execution', 'terminal'] as const)('%s freshness boundary', (stage) => {
    async function ready() {
      const claim = await delivery(); const run = execution(claim.request);
      if (stage === 'terminal') await repository.claimExecution(run, validCurrent, NOW + 1);
      return { claim, run, input: stage === 'execution' ? run : receipt(run),
        transition: stage === 'execution' ? repository.claimExecution.bind(repository) : repository.recordTerminalReceipt.bind(repository) };
    }
    it.each(['head', 'base', 'policy', 'draft', 'closed', 'candidate', 'app', 'published'])('fresh %s rejection cannot commit', async (changed) => {
      const { run, input, transition } = await ready();
      // These are trusted-reader observations, never fields from the callback wire.
      const current = { head: 'a'.repeat(40), base: 'b'.repeat(40), policy: 'c'.repeat(64), draft: false,
        closed: false, candidate: binding().candidateSha, app: APP, published: true };
      Object.assign(current, { [changed]: ['draft', 'closed'].includes(changed) ? true
        : changed === 'published' ? false : changed === 'app' ? 123 : 'f'.repeat(64) });
      const validate = vi.fn(async (request: StoredReviewCiRequest) => {
        if (current.head !== request.review.headSha || current.base !== request.review.baseSha
          || current.policy !== request.review.policyDigest || current.draft || current.closed
          || current.candidate !== request.binding!.candidateSha || current.app !== request.expectedAppId || !current.published) {
          throw new Error('synthetic stale provider-body credential');
        }
      });
      await expect(transition(input, validate, NOW + 2)).rejects.toThrow('Review CI persistence operation failed');
      expect(validate).toHaveBeenCalledTimes(1);
      const stored = (await repository.get(run.requestId))!;
      expect(stored.state).toBe(stage === 'execution' ? 'admitted' : 'running');
      expect(stored.terminalReceipt).toBeNull();
      if (stage === 'execution') expect(stored.execution).toBeNull();
    });
    it('requires a validator, bounds a hung validator, and has no delayed commit', async () => {
      const { run, input, transition } = await ready();
      await expect(transition(input, undefined as never, NOW + 2)).rejects.toThrow('validator is required');
      const bounded = new PostgresReviewCiRepository(pool, { ...publicationReady, admissionTimeoutMs: 50 });
      const boundedTransition = stage === 'execution' ? bounded.claimExecution.bind(bounded) : bounded.recordTerminalReceipt.bind(bounded);
      let release!: () => void;
      await expect(boundedTransition(input, () => new Promise<void>((resolve) => { release = resolve; }), NOW + 2)).rejects.toThrow('persistence operation failed');
      release();
      expect((await repository.get(run.requestId))!.state).toBe(stage === 'execution' ? 'admitted' : 'running');
      expect(await transition(input, validCurrent, NOW + 3)).toBe('recorded');
    });
    it('executes the fresh read while holding the actual shared PR advisory lock', async () => {
      const { claim, input, transition } = await ready();
      let entered!: () => void; let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const pending = transition(input, async (request) => {
        expect(request.requestId).toBe(claim.request.requestId); entered(); await wait;
      }, NOW + 2);
      const probe = await pool.connect();
      try {
        await started;
        await probe.query('BEGIN');
        const locked = await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          [`review-dispatch:${claim.request.review.repositoryId}:${claim.request.review.prNumber}`]);
        expect(locked.rows[0].acquired).toBe(false);
      } finally { await probe.query('ROLLBACK'); probe.release(); release(); }
      expect(await pending).toBe('recorded');
    });
  });
  it('read-only cursor paging reaches requests beyond 25 idle drafts and rejects invalid cursors', async () => {
    for (let i = 1; i <= 27; i++) await complete(await fixture(i, 100 + i));
    const initial = (await pool.query('SELECT request_id,updated_at FROM review_ci_requests ORDER BY request_id')).rows;
    const first = await repository.listPending(25);
    const second = await repository.listPending(25, first.at(-1)!.requestId);
    expect(first).toHaveLength(25); expect(second).toHaveLength(2);
    expect([...first, ...second].map((r) => r.requestId)).toEqual(initial.map((r) => r.request_id));
    expect(await repository.listPending(25, second.at(-1)!.requestId)).toEqual([]);
    expect((await repository.listPending(25))[0].requestId).toBe(first[0].requestId);
    expect((await pool.query('SELECT request_id,updated_at FROM review_ci_requests ORDER BY request_id')).rows).toEqual(initial);
    await expect(repository.listPending(25, 'invalid')).rejects.toThrow('identity');
  });

  describe('CI-check transaction hooks', () => {
    async function prepare(transition: 'admitted' | 'running' | 'completed' | 'superseded' | 'delivery_error') {
      if (transition === 'admitted') {
        const review = await fixture(); const request = await complete(review); await published(review);
        await repositoryIntent(request.requestId);
        return { requestId: request.requestId, invoke: (repo: PostgresReviewCiRepository) => repo.admit(request.requestId, binding(), validCurrent, NOW + 10) };
      }
      const request = await admitted();
      if (transition === 'superseded') return { requestId: request.requestId,
        invoke: (repo: PostgresReviewCiRepository) => repo.supersede(request.requestId, NOW + 10) };
      const claim = await delivery(request); const run = execution(request);
      if (transition === 'running') return { requestId: request.requestId,
        invoke: (repo: PostgresReviewCiRepository) => repo.claimExecution(run, validCurrent, NOW + 10) };
      if (transition === 'delivery_error') {
        const retry = await uncertain(claim);
        return { requestId: request.requestId,
          invoke: (repo: PostgresReviewCiRepository) => repo.retryUncertainDelivery(retry, absent(retry), NOW + 10, 0) };
      }
      await repository.claimExecution(run, validCurrent, NOW + 1);
      return { requestId: request.requestId,
        invoke: (repo: PostgresReviewCiRepository) => repo.recordTerminalReceipt(receipt(run), validCurrent, NOW + 10) };
    }
    it.each(['admitted', 'running', 'completed', 'superseded', 'delivery_error'] as const)('commits %s and its post-transition check intent together', async (transition) => {
      const { requestId, invoke } = await prepare(transition);
      const before = (await repository.get(requestId))!;
      const hook = vi.fn<NonNullable<ReviewCiRepositoryOptions['onTransition']>>(async (client, request, observed, now) => {
        expect(observed).toBe(transition); expect(now).toBe(NOW + 10);
        expect(request.requestId).toBe(requestId); expect(request.state).toBe(transition);
        expect(request.binding).toEqual(binding());
        // Another connection cannot see either the state transition or intent yet.
        expect((await repository.get(requestId))!.state).toBe(before.state);
        await client.query('INSERT INTO review_ci_hook_test_events VALUES($1,$2,$3,$4)',
          [requestId, observed, JSON.stringify(request), now]);
        expect((await pool.query('SELECT * FROM review_ci_hook_test_events')).rows).toEqual([]);
      });
      const hooked = new PostgresReviewCiRepository(pool, { ...publicationReady, maxDispatchAttempts: 1, onTransition: hook });
      expect(await invoke(hooked)).toBe(transition === 'delivery_error' ? 'exhausted' : 'recorded');
      expect(hook).toHaveBeenCalledTimes(1);
      const stored = (await repository.get(requestId))!;
      const events = (await pool.query('SELECT * FROM review_ci_hook_test_events')).rows;
      expect(events).toHaveLength(1); expect(events[0].snapshot).toEqual(stored);
      if (transition === 'running') expect(stored.execution).not.toBeNull();
      if (transition === 'completed') expect(stored.terminalReceipt?.jobs[0].name).toBe('validate');
    });
    it.each(['admitted', 'running', 'completed', 'superseded', 'delivery_error'] as const)('rolls back %s, outbox writes, and hook writes when the check hook fails', async (transition) => {
      const { requestId, invoke } = await prepare(transition);
      const before = await repository.get(requestId);
      const deliveries = (await pool.query('SELECT * FROM review_ci_deliveries ORDER BY kind,epoch')).rows;
      const hooked = new PostgresReviewCiRepository(pool, { ...publicationReady, maxDispatchAttempts: 1,
        onTransition: async (client, request, observed, now) => {
          await client.query('INSERT INTO review_ci_hook_test_events VALUES($1,$2,$3,$4)', [request.requestId, observed, JSON.stringify(request), now]);
          throw new Error('synthetic check persistence failure with private details');
        } });
      await expect(invoke(hooked)).rejects.toThrow('Review CI persistence operation failed');
      expect(await repository.get(requestId)).toEqual(before);
      expect((await pool.query('SELECT * FROM review_ci_deliveries ORDER BY kind,epoch')).rows).toEqual(deliveries);
      expect((await pool.query('SELECT * FROM review_ci_hook_test_events')).rows).toEqual([]);
    });
    it('requires a published-pending proof and rolls back a rejected proof before execution is consumed', async () => {
      const { requestId, invoke } = await prepare('running');
      const before = await repository.get(requestId);
      await expect(invoke(new PostgresReviewCiRepository(pool))).rejects.toThrow('persistence operation failed');
      const proof = vi.fn<NonNullable<ReviewCiRepositoryOptions['assertPendingPublished']>>(async (client, request, now) => {
        expect(request).toEqual(before); expect(now).toBe(NOW + 10);
        await client.query('INSERT INTO review_ci_hook_test_events VALUES($1,$2,$3,$4)', [requestId, 'predicate', JSON.stringify(request), now]);
        throw new Error('CI check unbound, unpublished, wrong identity or terminal');
      });
      await expect(invoke(new PostgresReviewCiRepository(pool, { assertPendingPublished: proof }))).rejects.toThrow('persistence operation failed');
      expect(proof).toHaveBeenCalledTimes(1);
      expect(await repository.get(requestId)).toEqual(before);
      expect((await pool.query('SELECT * FROM review_ci_hook_test_events')).rows).toEqual([]);
      expect(await invoke(repository)).toBe('recorded');
    });
    it('checks pending publication under the actual PR lock and emits hooks only on new transitions', async () => {
      const { requestId, invoke } = await prepare('running');
      const before = (await repository.get(requestId))!;
      const hook = vi.fn(async () => undefined);
      const proof = vi.fn(async (_client, request: StoredReviewCiRequest) => {
        const probe = await pool.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          [`review-dispatch:${request.review.repositoryId}:${request.review.prNumber}`]);
        expect(probe.rows[0].acquired).toBe(false);
        request.review.headSha = 'f'.repeat(40);
      });
      const hooked = new PostgresReviewCiRepository(pool, { assertPendingPublished: proof, onTransition: hook });
      expect(await invoke(hooked)).toBe('recorded');
      expect(await invoke(hooked)).toBe('duplicate');
      expect(proof).toHaveBeenCalledTimes(1); expect(hook).toHaveBeenCalledTimes(1);
      expect((await repository.get(requestId))!.review).toEqual(before.review);
    });
  });
});
