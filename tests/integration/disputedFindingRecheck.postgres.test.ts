import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import { createReviewExecutionCheckpointHandler } from '../../src/api/reviewExecutionCheckpointRoute';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { getReviewFindingId } from '../../src/mcp/server/tools/findingIdentity';
import { workerReviewCompletionDigest, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { initializeOwnedReviewSchema } from '../support/ownedReviewSchema';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { reviewPrLockKey } from '../../src/persistence/reviewPrTransaction';
import { findingRecheckAdmission } from '../support/findingRecheckAdmission';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';
import { reservePrReview } from '../../src/persistence/reviewPrLifecycleRepository';
import { disputedFindingRecheckDigest, loadValidatedDisputedFindingRechecks } from '../../src/review/disputedFindingRecheck';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();
const OWNED_SCHEMA = /^review_dispute_test_[0-9a-f]{16}$/u;
const WORKER_TOKEN = 'ghs_rel1265_postgres_fixture';
const runId = `run_${'8'.repeat(32)}`;
const repositoryId = 1_450_000_001;
const owner = 'exampleorg';
const repo = 'example-review-actions';
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
    await initializeOwnedReviewSchema(pool, schemaName);
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
    const persistedIdentity = buildReviewRunIdentity({ owner, repo, prNumber, headSha, baseSha, configDigest });
    await pool!.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, head_sha, base_sha, effective_policy_digest, effective_config_digest,
       status, attempt, repository_id, authoritative_gate_app_id, identity_digest, snapshot_digest, config_digest, identity, publication_mode, stage)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', 1, $9, 4385771,$10,$11,$8,$12::jsonb,'app-gate','complete')`,
    [runId, owner, repo, prNumber, headSha, baseSha, policyDigest, configDigest, repositoryId,
      sha256(persistedIdentity), persistedIdentity.snapshotDigest, JSON.stringify(persistedIdentity)]);
    await pool!.query('UPDATE review_runs SET result_digest=$2 WHERE run_id=$1', [runId, completionDigest]);
    await pool!.query(`INSERT INTO github_deliveries (delivery_id,event_name,repository_id,installation_id,payload_digest,received_at)
      VALUES ('disputed-source','pull_request',$1,2001,$2,CURRENT_TIMESTAMP)`, [repositoryId, completionDigest]);
    // Accepted worker results may leave the dispatch outbox projected after Gate publication.
    await pool!.query(`INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, execution_attempt)
      VALUES ($1, 'disputed-source', 'projected', 1)`, [runId]);
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
    const lifecycleClient = await pool!.connect();
    try {
      await lifecycleClient.query('BEGIN');
      await reservePrReview(lifecycleClient, {
        repositoryId, owner, repo, prNumber, runId, executionAttempt: 2, deliveryId: 'disputed-source',
        headSha, baseSha, policyDigest, configDigest, contextDigest: persistedIdentity.snapshotDigest,
        at: Date.parse('2026-10-01T12:00:00.000Z'),
      });
      await lifecycleClient.query('COMMIT');
    } catch (error) {
      await lifecycleClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { lifecycleClient.release(); }
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
    const recheckAudit = (await pool!.query(`SELECT event_type, actor_digest, context_digest, evidence_digest
      FROM review_pr_lifecycle_events WHERE event_type = 'finding.recheck_requested'`)).rows[0];
    expect(recheckAudit).toMatchObject({ event_type: 'finding.recheck_requested',
      actor_digest: sha256(context.caller.callerId), context_digest: persistedIdentity.snapshotDigest,
      evidence_digest: disputedFindingRecheckDigest({
        requestId: first.request_id, runId, sourceExecutionAttempt: 2, sourceContentDigest: completionDigest,
        sourcePlanDigest: sha256(canonicalJson(completion.result.taskPlan)), sourceGateAttemptId: gateAttemptId,
        repositoryId, owner, repo, prNumber, headSha, baseSha, policyDigest, configDigest,
        findingId, personaId: task.id, taskId: task.id,
        finding: { severity: sourceFinding.severity, path: sourceFinding.path, line: sourceFinding.line,
          title: sourceFinding.title, body: sourceFinding.body },
        counterArgument: input.counter_argument, counterArgumentDigest: sha256(input.counter_argument),
      }) });

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

    // More than eight legitimate rechecks can happen over a PR's life. Each
    // exact source completion receives its own bounded batch, and the loader
    // returns only the batch admitted for that execution attempt.
    for (let sourceAttempt = 3; sourceAttempt <= 10; sourceAttempt += 1) {
      const sourceCompletion: WorkerReviewCompletion = { ...completion, executionAttempt: sourceAttempt };
      const sourceDigest = workerReviewCompletionDigest(sourceCompletion);
      await pool!.query(`INSERT INTO review_worker_completions
        (run_id, execution_attempt, content_digest, payload, byte_length)
        VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [runId, sourceAttempt, sourceDigest, JSON.stringify(sourceCompletion), Buffer.byteLength(JSON.stringify(sourceCompletion), 'utf8')]);
      const sourceGate = (await pool!.query(`UPDATE review_gate_attempts SET
          creation_state = 'bound', check_id = COALESCE(check_id, $3), worker_result_digest = $4,
          desired_state = 'failure', desired_version = GREATEST(desired_version, 2),
          published_version = GREATEST(published_version, 2), current_attempt = true
        WHERE run_id = $1 AND execution_attempt = $2
        RETURNING attempt_id`, [runId, sourceAttempt, 62000 + sourceAttempt, sourceDigest])).rows[0];
      expect(sourceGate).toBeTruthy();
      const recheckRequestId = randomUUID();
      const sourcePlanDigest = sha256(canonicalJson(sourceCompletion.result.taskPlan));
      const counterArgument = `Verify the changed authorization boundary again for source attempt ${sourceAttempt}.`;
      const recheck = {
        requestId: recheckRequestId, runId, sourceExecutionAttempt: sourceAttempt,
        sourceContentDigest: sourceDigest, sourcePlanDigest, sourceGateAttemptId: String(sourceGate.attempt_id),
        repositoryId, owner, repo, prNumber, headSha, baseSha, policyDigest, configDigest,
        findingId, personaId: task.id, taskId: task.id,
        finding: { severity: sourceFinding.severity, path: sourceFinding.path, line: sourceFinding.line,
          title: sourceFinding.title, body: sourceFinding.body },
        counterArgument, counterArgumentDigest: sha256(counterArgument),
      };
      const requestDigest = disputedFindingRecheckDigest(recheck);
      await pool!.query(`INSERT INTO review_finding_rechecks
        (request_id, run_id, source_execution_attempt, source_content_digest, source_plan_digest, source_gate_attempt_id,
         repository_id, owner, repo, pr_number, head_sha, base_sha, policy_digest, config_digest,
         finding_id, persona_id, task_id, finding, counter_argument, counter_argument_digest, request_digest, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22)`,
      [recheckRequestId, runId, sourceAttempt, sourceDigest, sourcePlanDigest, sourceGate.attempt_id,
        repositoryId, owner, repo, prNumber, headSha, baseSha, policyDigest, configDigest, findingId,
        task.id, task.id, JSON.stringify(recheck.finding), counterArgument, recheck.counterArgumentDigest,
        requestDigest, sha256('synthetic-authorized-reviewer')]);
      const nextGateId = `${runId}-g${sourceAttempt}-e${sourceAttempt + 1}`;
      await pool!.query(`UPDATE review_gate_attempts SET current_attempt = false WHERE run_id = $1 AND execution_attempt = $2`,
        [runId, sourceAttempt]);
      const nextCoordinates = { ...gateCoordinates, executionAttempt: sourceAttempt + 1,
        attemptId: nextGateId };
      await pool!.query(`INSERT INTO review_gate_attempts
        (attempt_id, run_id, review_generation, execution_attempt, repository_id, pr_number, expected_app_id,
         coordinates, external_id, creation_state, desired_state, desired_version, published_version, current_attempt)
        VALUES ($1,$2,$3,$4,$5,$6,4385771,$7::jsonb,$8,'reserved','queued',0,-1,true)`,
      [nextGateId, runId, sourceAttempt, sourceAttempt + 1, repositoryId, prNumber,
        JSON.stringify(nextCoordinates), `batch-history-${sourceAttempt}`]);
      const receivedAt = Date.parse('2026-10-02T12:00:00.000Z') + sourceAttempt;
      await pool!.query(`INSERT INTO review_finding_recheck_admissions
        (run_id, source_execution_attempt, trigger_request_id, execution_attempt, review_generation,
         gate_attempt_id, requested_by, received_at, terminal_deadline)
        VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp(($8+600000)/1000.0))`,
      [runId, sourceAttempt, recheckRequestId, sourceAttempt + 1, sourceAttempt, nextGateId,
        sha256('synthetic-authorized-reviewer'), receivedAt]);
      const currentBatch = await loadValidatedDisputedFindingRechecks(pool as never, {
        run_id: runId, repository_id: repositoryId, owner, repo, pr_number: prNumber,
        head_sha: headSha, base_sha: baseSha, effective_policy_digest: policyDigest,
        effective_config_digest: configDigest,
      }, sourceAttempt + 1);
      expect(currentBatch.map((item) => item.requestId)).toEqual([recheckRequestId]);
    }
    expect((await pool!.query('SELECT COUNT(*)::int AS count FROM review_finding_rechecks WHERE run_id=$1', [runId]))
      .rows[0].count).toBe(9);
  }, 30_000);
});
