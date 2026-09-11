import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REVIEW_CI_CHECK_SCHEMA_SQL } from '../../src/persistence/reviewCiCheckSchema';
import { REVIEW_CI_SCHEMA_SQL } from '../../src/persistence/reviewCiSchema';
import { PostgresReviewCiCheckRepository } from '../../src/persistence/reviewCiCheckRepository';
import { sha256 } from '../../src/review/reviewCore';
import {
  createReviewCiLanePlan, reviewCiIdentityDigest, reviewCiRunName,
  type ReviewCiExecution, type ReviewCiValidationBinding, type StoredReviewCiRequest,
} from '../../src/review/reviewCi';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describePg = databaseUrl ? describe : describe.skip;
const OWNED_SCHEMA = /^review_ci_check_test_[a-f0-9]{16}$/u;
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const APP = 4385771;
let fixtureCounter = 0;

function binding(candidateSha = 'd'.repeat(40), workflowSha = 'e'.repeat(40), requiredJobs = ['validate']): ReviewCiValidationBinding {
  return {
    candidateSha, workflowId: 3211,
    workflowPath: '.github/workflows/review-yeti-candidate.yml', workflowRef: 'refs/tags/review-ci-v1', workflowSha,
    lanePlan: createReviewCiLanePlan(['core', 'tools'], requiredJobs),
  };
}

function admittedRequest(overrides: Partial<StoredReviewCiRequest> = {}): StoredReviewCiRequest {
  const requestId = overrides.requestId ?? randomUUID();
  const sequence = ++fixtureCounter;
  const runSuffix = sequence.toString(16).padStart(32, '0');
  const review = overrides.review ?? {
    repositoryId: 1_500_000_000 + sequence, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 400 + sequence,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64),
    runId: `run_${runSuffix}`, reviewGeneration: 0, executionAttempt: 1,
    attemptId: `run_${runSuffix}-g0-e1`,
  };
  const selectedBinding = overrides.binding ?? binding();
  return {
    requestId, review, expectedAppId: APP, state: 'admitted', binding: selectedBinding,
    identityDigest: reviewCiIdentityDigest({ requestId, review, expectedAppId: APP, binding: selectedBinding }),
    workflowEpoch: 1, execution: null, terminalReceipt: null, ...overrides,
  };
}

async function inTransaction(pool: Pool, operation: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await operation(client); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function insertRequest(pool: Pool, request: StoredReviewCiRequest): Promise<void> {
  await pool.query(`INSERT INTO review_ci_requests(
    request_id,attempt_id,repository_id,pr_number,expected_app_id,review,state,binding,identity_digest,
    workflow_epoch,execution,execution_run_id,terminal_receipt,terminal_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
    request.requestId, request.review.attemptId, request.review.repositoryId, request.review.prNumber,
    request.expectedAppId, JSON.stringify(request.review), request.state, request.binding ? JSON.stringify(request.binding) : null,
    request.identityDigest, request.workflowEpoch, request.execution ? JSON.stringify(request.execution) : null,
    request.execution?.runId ?? null, request.terminalReceipt ? JSON.stringify(request.terminalReceipt) : null,
    request.terminalReceipt ? 'f'.repeat(64) : null,
  ]);
}

function execution(request: StoredReviewCiRequest, runId = 1001, epoch = request.workflowEpoch): ReviewCiExecution {
  return {
    requestId: request.requestId, epoch, repositoryId: request.review.repositoryId, workflowId: request.binding!.workflowId,
    workflowSha: request.binding!.workflowSha, candidateSha: request.binding!.candidateSha, runId, runAttempt: 1,
    event: 'workflow_dispatch', runName: reviewCiRunName(request.requestId, epoch),
  };
}

function checkFor(request: StoredReviewCiRequest, id: number, state: 'queued' | 'in_progress' | 'completed' = 'queued', conclusion: null | 'success' = null) {
  return { id, name: 'Review Yeti CI' as const, appId: request.expectedAppId, headSha: request.review.headSha,
    externalId: '', status: state, conclusion };
}

describePg('Review CI check persistence — real scoped PostgreSQL', () => {
  let pool: Pool;
  let schema: string;
  let repository: PostgresReviewCiCheckRepository;

  beforeAll(async () => {
    schema = `review_ci_check_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schema)) throw new Error('Invalid owned test schema');
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(REVIEW_CI_SCHEMA_SQL);
    await pool.query(REVIEW_CI_CHECK_SCHEMA_SQL);
    repository = new PostgresReviewCiCheckRepository(pool);
  });

  afterEach(async () => {
    await pool.query('TRUNCATE review_ci_check_outbox,review_ci_check_attempts,review_ci_deliveries,review_ci_requests');
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (!OWNED_SCHEMA.test(schema)) throw new Error('Refusing to drop unowned test schema');
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await pool.end(); }
  });

  async function admitted(): Promise<StoredReviewCiRequest> {
    const request = admittedRequest();
    await insertRequest(pool, request);
    await inTransaction(pool, async (client) => {
      await repository.transitionInTransaction(client, request, 'admitted', NOW);
    });
    return request;
  }

  async function pendingProof(request: StoredReviewCiRequest): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await repository.assertPendingPublishedInTransaction(client, request, NOW);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  it('creates one durable queued intent and requires bound checkId plus published_version before execution', async () => {
    const request = await admitted();
    const initial = await repository.get(request.requestId);
    expect(initial).toMatchObject({ desiredState: 'queued', desiredVersion: 1, publishedVersion: -1, checkId: null, creationState: 'reserved' });
    await expect(pendingProof(request)).rejects.toThrow('not externally published');

    const claim = (await repository.claimPublication('publisher-a', NOW))!;
    expect(claim.mayCreate).toBe(true);
    const first = checkFor(request, 7001);
    const stored = await repository.publishLocked(claim, async (check, mayCreate) => {
      expect(mayCreate).toBe(true);
      first.externalId = check.externalId;
      return first;
    }, NOW + 1);
    expect(stored).toBe('published');

    const published = (await repository.get(request.requestId))!;
    expect(published).toMatchObject({ checkId: 7001, creationState: 'bound', publishedVersion: published.desiredVersion });
    await pendingProof(published.request);
  });

  it('fences a lost create acknowledgement and never grants a second create claim', async () => {
    const request = await admitted();
    const claim = (await repository.claimPublication('publisher-a', NOW))!;
    const post = vi.fn(async () => { throw new Error('lost acknowledgement'); });
    await expect(repository.publishLocked(claim, post, NOW + 1)).rejects.toThrow();
    expect(await repository.retryPublication(claim, NOW + 2, 1_000, 'unknown-create')).toBe(true);

    const retry = (await repository.claimPublication('publisher-b', NOW + 1_003))!;
    expect(retry.mayCreate).toBe(false);
    expect(retry.checkId).toBeNull();
    expect(retry.creationState).toBe('creating');
  });

  it('resets only a proven pre-operation preparation failure to reserved', async () => {
    const request = await admitted();
    const claim = (await repository.claimPublication('publisher-a', NOW))!;
    await expect(repository.publishLocked(claim, async () => ({ kind: 'not-started', retryDelayMs: 1_000 }), NOW + 1))
      .resolves.toBe('retry');
    const recovered = (await repository.get(request.requestId))!;
    expect(recovered).toMatchObject({ checkId: null, creationState: 'reserved', publishedVersion: -1 });
    expect((await pool.query('SELECT state,last_error_class FROM review_ci_check_outbox WHERE request_id=$1', [request.requestId])).rows[0])
      .toMatchObject({ state: 'pending', last_error_class: 'transport' });
  });

  it('serializes concurrent publication claims and rejects stale lease identity', async () => {
    const request = await admitted();
    const claims = await Promise.all([
      repository.claimPublication('publisher-a', NOW), repository.claimPublication('publisher-b', NOW),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    const stale = { ...claim, leaseToken: randomUUID() };
    const post = vi.fn();
    await expect(repository.publishLocked(stale, async () => {
      post();
      return checkFor(request, 7002);
    }, NOW + 1)).resolves.toBe('stale-claim');
    expect(post).not.toHaveBeenCalled();
  });

  it('does not invert the PR-lock order when admission and publication claim concurrently', async () => {
    const request = await admitted();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`review-dispatch:${request.review.repositoryId}:${request.review.prNumber}`]);
      await holder.query('SELECT request_id FROM review_ci_requests WHERE request_id=$1 FOR UPDATE', [request.requestId]);
      const claim = await Promise.race([
        repository.claimPublication('blocked-by-admission', NOW),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('claim waited behind an inverted lock order')), 1_000)),
      ]);
      expect(claim).toBeNull();
      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await repository.claimPublication('after-admission', NOW)).not.toBeNull();
  });

  it('rejects a success terminal transition when a required lane job is missing', async () => {
    const request = await admitted();
    const run = execution(request);
    const running = { ...request, state: 'running' as const, execution: run };
    await pool.query(`UPDATE review_ci_requests SET state='running',execution=$2,execution_run_id=$3 WHERE request_id=$1`,
      [request.requestId, JSON.stringify(run), run.runId]);
    await inTransaction(pool, async (client) => {
      await repository.transitionInTransaction(client, running, 'running', NOW + 1);
    });
    const receipt = {
      version: 'ReviewCiTerminalReceipt.v1' as const, execution: run, conclusion: 'success' as const,
      jobs: [{ id: 9, runId: run.runId, runAttempt: run.runAttempt, name: 'other', status: 'completed' as const, conclusion: 'success' as const }],
    };
    const completed = { ...running, state: 'completed' as const, terminalReceipt: receipt };
    await pool.query(`UPDATE review_ci_requests SET state='completed',terminal_receipt=$2,terminal_digest=$3 WHERE request_id=$1`,
      [request.requestId, JSON.stringify(receipt), sha256(receipt)]);
    await expect(inTransaction(pool, async (client) => {
      await repository.transitionInTransaction(client, completed, 'completed', NOW + 2);
    })).rejects.toThrow('failed required jobs');
    expect((await repository.get(request.requestId))!).toMatchObject({ desiredState: 'in_progress', terminalReceipt: null });
  });

  it('preserves immutable C/W/lane metadata and changes external identity for a new validation request', async () => {
    const first = await admitted();
    const firstStored = (await repository.get(first.requestId))!;
    const secondReview = { ...first.review, runId: `run_${'2'.repeat(32)}`, attemptId: `run_${'2'.repeat(32)}-g0-e1`, prNumber: 43 };
    const second = admittedRequest({ requestId: randomUUID(), review: secondReview, binding: binding('f'.repeat(40), '1'.repeat(40), ['validate', 'smoke']) });
    await insertRequest(pool, second);
    await inTransaction(pool, async (client) => {
      await repository.transitionInTransaction(client, second, 'admitted', NOW);
    });
    const secondStored = (await repository.get(second.requestId))!;
    expect(firstStored.externalId).not.toBe(secondStored.externalId);
    expect(secondStored).toMatchObject({
      expectedAppId: APP, currentEpoch: 1, coordinates: { headSha: second.review.headSha, prNumber: 43 },
      request: { binding: { candidateSha: 'f'.repeat(40), workflowSha: '1'.repeat(40), lanePlan: { requiredJobs: ['smoke', 'validate'] } } },
    });
  });

  it('keeps the external identity stable when the delivery epoch advances', async () => {
    const request = await admitted();
    const first = (await repository.get(request.requestId))!;
    const next = { ...request, workflowEpoch: 2 };
    const run = execution(next, 1002, 2);
    const running = { ...next, state: 'running' as const, execution: run };
    await pool.query(`UPDATE review_ci_requests SET workflow_epoch=2,state='running',execution=$2,execution_run_id=$3 WHERE request_id=$1`,
      [request.requestId, JSON.stringify(run), run.runId]);
    await inTransaction(pool, async (client) => {
      await repository.transitionInTransaction(client, running, 'running', NOW + 1);
    });
    const second = (await repository.get(request.requestId))!;
    expect(second.currentEpoch).toBe(2);
    expect(second.externalId).toBe(first.externalId);
    expect(second.coordinates.epoch).toBe(2);
  });
});
