import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import { createReviewExecutionCheckpointHandler } from '../../src/api/reviewExecutionCheckpointRoute';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { getReviewFindingId } from '../../src/mcp/server/tools/findingIdentity';
import { workerReviewCompletionDigest, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { reviewPrLockKey } from '../../src/persistence/reviewPrTransaction';
import { findingRecheckAdmission } from '../support/findingRecheckAdmission';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();
const OWNED_SCHEMA = /^review_dispute_test_[0-9a-f]{16}$/u;
const WORKER_TOKEN = 'ghs_rel1265_postgres_fixture';
const runId = `run_${'8'.repeat(32)}`;
const repositoryId = 1_450_000_001;
const owner = 'calltelemetry';
const repo = 'ct-review-actions';
const prNumber = 1265;
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const policyDigest = 'c'.repeat(64);
const configDigest = 'd'.repeat(64);
const task = {
  id: 'security-auth', dimension: 'security' as const, paths: ['src/auth/guard.ts'],
  question: 'Does the changed guard fail closed?', rationale: 'The changed path is an authorization boundary.',
};
const sourceFinding = {
  severity: 'P1' as const, path: 'src/auth/guard.ts', line: 17,
  title: 'The guard trusts an unbound tenant',
  body: 'The caller can select another tenant because the request identity is not checked.',
};
const completion: WorkerReviewCompletion = {
  version: 'WorkerReviewCompletion.v1', runId, repositoryId, owner, repo, prNumber, headSha, baseSha,
  policyDigest, configDigest, executionAttempt: 2,
  result: {
    version: 'WorkerReviewResult.v1', completedAt: '2026-10-01T12:00:00.000Z',
    personas: [{ id: task.id, decision: 'FINDINGS', status: 'COMPLETE', findings: [sourceFinding] }],
    taskPlan: [task], coverageComplete: true, quorumSatisfied: true,
    findingCount: 1, blockingFindingCount: 1,
  },
};
const completionDigest = workerReviewCompletionDigest(completion);
const gateAttemptId = `${runId}-g1-e2`;
const gateCoordinates = { runId, repositoryId, owner, repo, prNumber, headSha, baseSha, policyDigest,
  executionAttempt: 2, attemptId: gateAttemptId };
const sourceCheckpoint: ReviewExecutionCheckpoint = {
  version: 'ReviewExecutionCheckpoint.v1', runId, repositoryId, owner, repo, prNumber, headSha, baseSha,
  policyDigest, configDigest, executionAttempt: 2, revision: 4, plan: [task],
  completedTasks: [{ id: task.id, findings: [sourceFinding] }],
};

describeWithPostgres('REL-1265 append-only dispute re-review flow (real SQL)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let schemaName: string | undefined;

  beforeAll(async () => {
    schemaName = `review_dispute_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Generated schema is not owned by this test');
    admin = new Pool({ connectionString: databaseUrl, max: 2 });
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      client.release();
    }
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schemaName}` });
    await pool.query(`
      CREATE TABLE review_runs (
        run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, effective_policy_digest TEXT NOT NULL,
        effective_config_digest VARCHAR(64) NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
        repository_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        publication_mode TEXT DEFAULT 'app-gate', stage TEXT DEFAULT 'complete', result_digest TEXT,
        received_at TIMESTAMPTZ, terminal_deadline TIMESTAMPTZ, error_text TEXT,
        failure_diagnostics JSONB DEFAULT '{}'::jsonb, publication_fence TEXT, lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ, cancel_requested_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE review_dispatch_outbox (
        run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
        status TEXT NOT NULL, execution_attempt INTEGER NOT NULL, worker_token_digest VARCHAR(64),
        projection_name TEXT, terminal_receipt_digest TEXT, lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
        available_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        cancel_requested_at TIMESTAMPTZ
      );
    `);
    await pool.query(REVIEW_GATE_SCHEMA_SQL);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && schemaName && OWNED_SCHEMA.test(schemaName)) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    await admin?.end();
  });

  it('enqueues once, reads the bound historical Gate, and records only an authenticated fresh-task receipt', async () => {
    const sourceBytes = canonicalJson(completion);
    await pool!.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, head_sha, base_sha, effective_policy_digest, effective_config_digest,
       status, attempt, repository_id, authoritative_gate_app_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', 1, $9, 4385771)`,
    [runId, owner, repo, prNumber, headSha, baseSha, policyDigest, configDigest, repositoryId]);
    await pool!.query('UPDATE review_runs SET result_digest=$2 WHERE run_id=$1', [runId, completionDigest]);
    // Accepted worker results may leave the dispatch outbox projected after Gate publication.
    await pool!.query(`INSERT INTO review_dispatch_outbox (run_id, status, execution_attempt)
      VALUES ($1, 'projected', 1)`, [runId]);
    await pool!.query(`INSERT INTO review_gate_attempts
      (attempt_id, run_id, review_generation, execution_attempt, repository_id, pr_number, expected_app_id,
       coordinates, external_id, check_id, creation_state, desired_state, desired_version, published_version,
       current_attempt, worker_result_digest)
      VALUES ($1, $2, 1, 2, $3, $4, 4385771, $5::jsonb, 'rel1265-dispute-test', 60001,
       'bound', 'failure', 2, 2, true, $6)`,
    [gateAttemptId, runId, repositoryId, prNumber, JSON.stringify(gateCoordinates), completionDigest]);
    await pool!.query(`INSERT INTO review_worker_completions
      (run_id, execution_attempt, content_digest, payload, byte_length)
      VALUES ($1, 2, $2, $3::jsonb, $4)`,
    [runId, completionDigest, JSON.stringify(completion), Buffer.byteLength(sourceBytes, 'utf8')]);
    await pool!.query(`INSERT INTO review_execution_checkpoints
      (run_id, execution_attempt, revision, head_sha, config_digest, payload, byte_length)
      VALUES ($1, 2, 4, $2, $3, $4::jsonb, $5)`,
    [runId, headSha, configDigest, JSON.stringify(sourceCheckpoint), Buffer.byteLength(JSON.stringify(sourceCheckpoint), 'utf8')]);

    const tool = createDisputeFindingTool({ transactionPool: pool as never, authoritativePublishing: findingRecheckAdmission(completion),
      adjudicateDispute: () => { throw new Error('Legacy adjudication must not run'); } });
    const findingId = getReviewFindingId(runId, task.id, sourceFinding);
    const input = { owner, repo, pr_number: prNumber, finding_id: findingId,
      counter_argument: 'The request router binds the authenticated repository before tenant data is loaded.' };
    const context = { authenticatedByConfiguredAuthenticator: true, caller: {
      authType: 'static_token' as const, tokenDigest: 'test-digest', isAdmin: true,
      allowedRepositories: null, callerId: 'rel1265-postgres-test',
    }, authorizedRepository: { owner, repo } };

    // Contention on the shared PR lock must fail within the transaction-local limit,
    // roll back, and leave the append-only request ledger empty.
    const blocker = await pool!.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [reviewPrLockKey(repositoryId, prNumber)]);
      await expect(tool.execute(input, context)).rejects.toThrow();
      expect((await pool!.query('SELECT count(*)::int AS count FROM review_finding_rechecks WHERE run_id = $1', [runId])).rows[0].count)
        .toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const firstResult = await tool.execute(input, context);
    const secondResult = await tool.execute(input, context);
    const first = JSON.parse((firstResult.content[0] as { text: string }).text);
    const second = JSON.parse((secondResult.content[0] as { text: string }).text);
    expect(second.request_id).toBe(first.request_id);
    expect(first).toMatchObject({ finding_id: findingId, review_status: 'fresh_re_review_requested', remaining_blockers: 1 });
    await expect(tool.execute({ ...input,
      counter_argument: 'A different counter-argument cannot replace the task request already queued.' }, context))
      .rejects.toThrow('A different dispute re-review is already queued for this task');
    expect((await pool!.query('SELECT count(*)::int AS count FROM review_finding_rechecks WHERE run_id = $1', [runId])).rows[0].count)
      .toBe(1);

    const storedSourceBefore = (await pool!.query(`SELECT content_digest, payload FROM review_worker_completions
      WHERE run_id = $1 AND execution_attempt = 2`, [runId])).rows[0];
    const storedGateBefore = (await pool!.query(`SELECT attempt_id, worker_result_digest, desired_state,
      desired_version, published_version, current_attempt FROM review_gate_attempts WHERE attempt_id = $1`, [gateAttemptId])).rows[0];
    expect(workerReviewCompletionDigest(storedSourceBefore.payload)).toBe(completionDigest);
    expect(storedSourceBefore.content_digest).toBe(completionDigest);
    expect(storedGateBefore).toMatchObject({ attempt_id: gateAttemptId, worker_result_digest: completionDigest,
      desired_state: 'failure', desired_version: '2', published_version: '2', current_attempt: false });
    expect((await pool!.query('SELECT count(*)::int AS count FROM review_finding_rechecks WHERE run_id = $1', [runId])).rows[0].count)
      .toBe(1);

    // Request admission already reserved g2-e3 and queued execution3. Fixture
    // only the later authenticated worker start for the checkpoint-route checks.
    expect((await pool!.query('SELECT status,attempt FROM review_runs WHERE run_id=$1', [runId])).rows[0])
      .toEqual({ status: 'queued', attempt: 2 });
    await pool!.query(`UPDATE review_runs SET status = 'running', attempt = 2 WHERE run_id = $1`, [runId]);
    await pool!.query(`UPDATE review_dispatch_outbox SET status = 'projected', execution_attempt = 2,
      worker_token_digest = $2 WHERE run_id = $1`, [runId, sha256(WORKER_TOKEN)]);

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.post('/checkpoint', createReviewExecutionCheckpointHandler(pool as never));
    const read = await request(app).post('/checkpoint').set('Authorization', `Bearer ${WORKER_TOKEN}`).send({
      version: 'ReviewExecutionCheckpointRead.v1', runId, executionAttempt: 3,
    });
    expect(read.status).toBe(200);
    expect(read.body.disputedFindingRechecks).toHaveLength(1);
    expect(read.body.disputedFindingRechecks[0]).toMatchObject({ requestId: first.request_id,
      findingId, sourceExecutionAttempt: 2, sourceContentDigest: completionDigest, sourceGateAttemptId: gateAttemptId });
    const wrongWorker = await request(app).post('/checkpoint').set('Authorization', 'Bearer ghs_wrong_worker').send({
      version: 'ReviewExecutionCheckpointRead.v1', runId, executionAttempt: 3,
    });
    expect(wrongWorker.status).toBe(403);

    const accepted = {
      ...sourceCheckpoint,
      executionAttempt: 3,
      revision: 5,
      completedTasks: [{ id: task.id, findings: [] }],
      satisfiedFindingRecheckIds: [first.request_id],
    };
    const written = await request(app).post('/checkpoint').set('Authorization', `Bearer ${WORKER_TOKEN}`).send(accepted);
    expect(written.status).toBe(200);

    const forged = await request(app).post('/checkpoint').set('Authorization', `Bearer ${WORKER_TOKEN}`).send({
      ...accepted, revision: 6, satisfiedFindingRecheckIds: ['00000000-0000-4000-8000-000000000001'],
    });
    expect(forged.status).toBe(503);
    const incomplete = await request(app).post('/checkpoint').set('Authorization', `Bearer ${WORKER_TOKEN}`).send({
      ...accepted, revision: 6, completedTasks: [],
    });
    expect(incomplete.status).toBe(503);

    const storedSourceAfter = (await pool!.query(`SELECT content_digest, payload FROM review_worker_completions
      WHERE run_id = $1 AND execution_attempt = 2`, [runId])).rows[0];
    const storedGateAfter = (await pool!.query(`SELECT attempt_id, worker_result_digest, desired_state,
      desired_version, published_version, current_attempt FROM review_gate_attempts WHERE attempt_id = $1`, [gateAttemptId])).rows[0];
    expect(workerReviewCompletionDigest(storedSourceAfter.payload)).toBe(completionDigest);
    expect(storedSourceAfter.content_digest).toBe(storedSourceBefore.content_digest);
    expect(storedGateAfter).toEqual({ ...storedGateBefore, current_attempt: false });
    const storedCheckpoint = (await pool!.query('SELECT payload FROM review_execution_checkpoints WHERE run_id = $1', [runId])).rows[0].payload;
    expect(storedCheckpoint).toMatchObject({ executionAttempt: 3, satisfiedFindingRecheckIds: [first.request_id],
      completedTasks: [{ id: task.id, findings: [] }] });
  }, 30_000);
});
