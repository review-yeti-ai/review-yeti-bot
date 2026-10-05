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
import { reservePrReview, recordPrFindingRecheckRequest, reservePrFindingRecheckTarget,
  transitionPrReviewReservation } from '../../src/persistence/reviewPrLifecycleRepository';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { disputedFindingRecheckDigest, loadValidatedDisputedFindingRechecks } from '../../src/review/disputedFindingRecheck';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
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

  async function seedReviewSource(sourcePrNumber: number) {
    const sourceRunId = `run_${randomBytes(16).toString('hex')}`;
    const sourceCompletion: WorkerReviewCompletion = { ...completion, runId: sourceRunId, prNumber: sourcePrNumber };
    const sourceDigest = workerReviewCompletionDigest(sourceCompletion);
    const sourceBytes = canonicalJson(sourceCompletion);
    const sourceGateAttemptId = `${sourceRunId}-g1-e2`;
    const coordinates = { ...gateCoordinates, runId: sourceRunId, prNumber: sourcePrNumber,
      attemptId: sourceGateAttemptId };
    const identity = buildReviewRunIdentity({ owner, repo, prNumber: sourcePrNumber, headSha, baseSha, configDigest });
    const deliveryId = `dispute-source-${sourcePrNumber}`;
    await pool!.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, head_sha, base_sha, effective_policy_digest, effective_config_digest,
       status, attempt, repository_id, authoritative_gate_app_id, identity_digest, snapshot_digest, config_digest,
       identity, publication_mode, stage, delivery_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', 1, $9, 4385771, $10, $11, $8, $12::jsonb,
        'app-gate', 'complete', $13)`,
    [sourceRunId, owner, repo, sourcePrNumber, headSha, baseSha, policyDigest, configDigest, repositoryId,
      sha256(identity), identity.snapshotDigest, JSON.stringify(identity), deliveryId]);
    await pool!.query(`INSERT INTO github_deliveries (delivery_id, event_name, repository_id, installation_id,
        payload_digest, received_at)
      VALUES ($1, 'pull_request', $2, 2001, $3, CURRENT_TIMESTAMP)`, [deliveryId, repositoryId, sourceDigest]);
    await pool!.query(`UPDATE review_runs SET result_digest = $2 WHERE run_id = $1`, [sourceRunId, sourceDigest]);
    await pool!.query(`INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, execution_attempt)
      VALUES ($1, $2, 'projected', 1)`, [sourceRunId, deliveryId]);
    await pool!.query(`INSERT INTO review_gate_attempts
      (attempt_id, run_id, review_generation, execution_attempt, repository_id, pr_number, expected_app_id,
       coordinates, external_id, check_id, creation_state, desired_state, desired_version, published_version,
       current_attempt, worker_result_digest)
      VALUES ($1, $2, 1, 2, $3, $4, 4385771, $5::jsonb, $6, $7, 'bound', 'failure', 2, 2, true, $8)`,
    [sourceGateAttemptId, sourceRunId, repositoryId, sourcePrNumber, JSON.stringify(coordinates),
      `ws2-recheck-source-${sourcePrNumber}`, 70000 + sourcePrNumber, sourceDigest]);
    await pool!.query(`INSERT INTO review_worker_completions
      (run_id, execution_attempt, content_digest, payload, byte_length)
      VALUES ($1, 2, $2, $3::jsonb, $4)`,
    [sourceRunId, sourceDigest, JSON.stringify(sourceCompletion), Buffer.byteLength(sourceBytes, 'utf8')]);
    const checkpoint: ReviewExecutionCheckpoint = { ...sourceCheckpoint, runId: sourceRunId, prNumber: sourcePrNumber };
    await pool!.query(`INSERT INTO review_execution_checkpoints
      (run_id, execution_attempt, revision, head_sha, config_digest, payload, byte_length)
      VALUES ($1, 2, 4, $2, $3, $4::jsonb, $5)`,
    [sourceRunId, headSha, configDigest, JSON.stringify(checkpoint), Buffer.byteLength(JSON.stringify(checkpoint), 'utf8')]);
    const lifecycleClient = await pool!.connect();
    try {
      await lifecycleClient.query('BEGIN');
      await reservePrReview(lifecycleClient, {
        repositoryId, owner, repo, prNumber: sourcePrNumber, runId: sourceRunId, executionAttempt: 2,
        deliveryId, headSha, baseSha, policyDigest, configDigest, contextDigest: identity.snapshotDigest,
      });
      await transitionPrReviewReservation(lifecycleClient, {
        runId: sourceRunId, executionAttempt: 2, status: 'failed', completionDigest: sourceDigest,
        decisionReceipt: { gateDecision: { status: 'failure', eligible: false } },
      });
      await lifecycleClient.query('COMMIT');
    } catch (error) {
      await lifecycleClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { lifecycleClient.release(); }
    return { sourceRunId, sourcePrNumber, sourceCompletion, sourceDigest, sourceGateAttemptId,
      sourceContextDigest: identity.snapshotDigest, deliveryId };
  }

  const authenticatedContext = (targetPrNumber: number) => ({
    authenticatedByConfiguredAuthenticator: true,
    caller: { authType: 'static_token' as const, tokenDigest: 'test-digest', isAdmin: true,
      allowedRepositories: null, callerId: `ws2-lifecycle-test-${targetPrNumber}` },
    authorizedRepository: { owner, repo },
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
      await transitionPrReviewReservation(lifecycleClient, {
        runId, executionAttempt: 2, status: 'failed', completionDigest,
        decisionReceipt: { gateDecision: { status: 'failure', eligible: false } },
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
    const targetReservation = (await pool!.query(`SELECT reservation_id, status, run_id, execution_attempt,
        head_sha, base_sha, policy_digest, config_digest, context_digest, decision_receipt
      FROM review_pr_review_reservations WHERE run_id = $1 AND execution_attempt = 3`, [runId])).rows[0];
    expect(targetReservation).toMatchObject({ status: 'reserved', run_id: runId, execution_attempt: 3,
      head_sha: headSha, base_sha: baseSha, policy_digest: policyDigest, config_digest: configDigest,
      context_digest: persistedIdentity.snapshotDigest, decision_receipt: null });
    const targetAdmissionEvent = (await pool!.query(`SELECT event_type, reservation_id, run_id,
        execution_attempt, head_sha, base_sha, policy_digest, config_digest, context_digest,
        evidence_digest, actor_digest, payload
      FROM review_pr_lifecycle_events WHERE event_type = 'finding.recheck_target_admitted'`)).rows[0];
    expect(targetAdmissionEvent).toMatchObject({ event_type: 'finding.recheck_target_admitted',
      reservation_id: targetReservation.reservation_id, run_id: runId, execution_attempt: 3,
      head_sha: headSha, base_sha: baseSha, policy_digest: policyDigest, config_digest: configDigest,
      context_digest: persistedIdentity.snapshotDigest, evidence_digest: expect.any(String),
      actor_digest: sha256(context.caller.callerId),
      payload: { requestId: first.request_id, sourceExecutionAttempt: 2,
        sourceCompletionDigest: completionDigest, sourceContextDigest: persistedIdentity.snapshotDigest,
        targetExecutionAttempt: 3, candidate: { headSha, baseSha, policyDigest, configDigest,
          contextDigest: persistedIdentity.snapshotDigest } } });

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
      const actorDigest = sha256('synthetic-authorized-reviewer');
      const lifecycleClient = await pool!.connect();
      try {
        await lifecycleClient.query('BEGIN');
        await transitionPrReviewReservation(lifecycleClient, {
          runId, executionAttempt: sourceAttempt, status: 'failed', completionDigest: sourceDigest,
          decisionReceipt: { gateDecision: { status: 'failure', eligible: false } },
        });
        await recordPrFindingRecheckRequest(lifecycleClient, {
          runId, sourceExecutionAttempt: sourceAttempt, requestId: recheckRequestId, findingId,
          actorDigest, sourceContentDigest: sourceDigest, sourceContextDigest: persistedIdentity.snapshotDigest,
          requestDigest,
        });
        await reservePrFindingRecheckTarget(lifecycleClient, {
          repositoryId, owner, repo, prNumber, runId, deliveryId: `batch-history-${sourceAttempt}`,
          sourceExecutionAttempt: sourceAttempt, executionAttempt: sourceAttempt + 1,
          requestId: recheckRequestId, requestDigest, sourceContentDigest: sourceDigest,
          sourceContextDigest: persistedIdentity.snapshotDigest, headSha, baseSha, policyDigest, configDigest,
          candidateContextDigest: persistedIdentity.snapshotDigest, actorDigest,
        });
        await lifecycleClient.query('UPDATE review_runs SET attempt = $2 WHERE run_id = $1', [runId, sourceAttempt]);
        await lifecycleClient.query(`INSERT INTO review_finding_recheck_admissions
        (run_id, source_execution_attempt, trigger_request_id, execution_attempt, review_generation,
         gate_attempt_id, requested_by, received_at, terminal_deadline)
        VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp(($8+600000)/1000.0))`,
      [runId, sourceAttempt, recheckRequestId, sourceAttempt + 1, sourceAttempt, nextGateId,
        actorDigest, receivedAt]);
        await lifecycleClient.query('COMMIT');
      } catch (error) {
        await lifecycleClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { lifecycleClient.release(); }
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

  it.each([
    { fault: 'missing-admission-projection', pr: 1274 },
    { fault: 'forged-target-event', pr: 1275 },
    { fault: 'source-event-mismatch', pr: 1276 },
    { fault: 'lost-ledger-with-current-checkpoint-receipt', pr: 1277 },
  ] as const)('fails the Gate closed for $fault in the current admitted batch', async ({ fault, pr }) => {
    const source = await seedReviewSource(pr);
    const tool = createDisputeFindingTool({ transactionPool: pool as never,
      authoritativePublishing: findingRecheckAdmission(source.sourceCompletion) });
    const findingId = getReviewFindingId(source.sourceRunId, task.id, sourceFinding);
    const result = await tool.execute({ owner, repo, pr_number: pr, finding_id: findingId,
      counter_argument: `Recheck the exact source finding for PR ${pr}.` }, authenticatedContext(pr));
    const receipt = JSON.parse((result.content[0] as { text: string }).text);
    const admission = (await pool!.query(`SELECT gate_attempt_id FROM review_finding_recheck_admissions
      WHERE run_id = $1 AND source_execution_attempt = 2`, [source.sourceRunId])).rows[0];
    expect(admission).toBeTruthy();

    const workerToken = `ghs_ws2_gate_${pr}`;
    await pool!.query(`UPDATE review_runs SET status = 'running', attempt = 2 WHERE run_id = $1`, [source.sourceRunId]);
    await pool!.query(`UPDATE review_dispatch_outbox SET status = 'projected', execution_attempt = 2,
      worker_token_digest = $2 WHERE run_id = $1`, [source.sourceRunId, sha256(workerToken)]);
    await pool!.query(`UPDATE review_gate_attempts SET creation_state = 'bound', check_id = $2,
        desired_state = 'in_progress', desired_version = 2, published_version = 2
      WHERE attempt_id = $1`, [admission.gate_attempt_id, 72000 + pr]);

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.post('/checkpoint', createReviewExecutionCheckpointHandler(pool as never));
    const targetCheckpoint: ReviewExecutionCheckpoint = {
      ...sourceCheckpoint, runId: source.sourceRunId, prNumber: pr, executionAttempt: 3, revision: 5,
      completedTasks: [{ id: task.id, findings: [] }], satisfiedFindingRecheckIds: [receipt.request_id],
    };
    const checkpointWrite = await request(app).post('/checkpoint')
      .set('Authorization', `Bearer ${workerToken}`).send(targetCheckpoint);
    expect(checkpointWrite.status).toBe(200);

    if (fault === 'missing-admission-projection') {
      const deleted = await pool!.query(`DELETE FROM review_finding_recheck_admissions
        WHERE run_id = $1 AND source_execution_attempt = 2 RETURNING run_id`, [source.sourceRunId]);
      expect(deleted.rowCount).toBe(1);
    } else if (fault === 'lost-ledger-with-current-checkpoint-receipt') {
      await pool!.query(`DELETE FROM review_finding_recheck_admissions
        WHERE run_id = $1 AND source_execution_attempt = 2`, [source.sourceRunId]);
      await pool!.query(`DELETE FROM review_pr_lifecycle_events
        WHERE idempotency_key IN ($1, $2)`, [
        `${receipt.request_id}:recheck-requested`, `${receipt.request_id}:recheck-target-admitted`,
      ]);
      await pool!.query('DELETE FROM review_finding_rechecks WHERE request_id = $1', [receipt.request_id]);
    } else if (fault === 'forged-target-event') {
      await pool!.query(`UPDATE review_pr_lifecycle_events SET evidence_digest = $2
        WHERE idempotency_key = $1`, [`${receipt.request_id}:recheck-target-admitted`, '0'.repeat(64)]);
    } else {
      await pool!.query(`UPDATE review_pr_lifecycle_events SET evidence_digest = $2
        WHERE idempotency_key = $1`, [`${receipt.request_id}:recheck-requested`, '0'.repeat(64)]);
    }

    const identity = { run_id: source.sourceRunId, repository_id: repositoryId, owner, repo, pr_number: pr,
      head_sha: headSha, base_sha: baseSha, effective_policy_digest: policyDigest,
      effective_config_digest: configDigest };
    if (fault === 'lost-ledger-with-current-checkpoint-receipt') {
      await expect(loadValidatedDisputedFindingRechecks(pool as never, identity, 3)).resolves.toEqual([]);
    } else {
      await expect(loadValidatedDisputedFindingRechecks(pool as never, identity, 3)).rejects.toThrow();
    }

    const gateNow = Date.now() + 1_000;
    const targetCompletion: WorkerReviewCompletion = { ...source.sourceCompletion, executionAttempt: 3,
      result: { ...source.sourceCompletion.result, completedAt: new Date(gateNow - 500).toISOString(),
        personas: [{ id: task.id, decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
        findingCount: 0, blockingFindingCount: 0 } };
    const trusted = { current: { repositoryId, prNumber: pr, headSha, baseSha, policyDigest, open: true, draft: false },
      coverage: { expectedPersonaIds: [task.id], reviewEngine: 'composed' as const, composedChangedPaths: ['src/auth/guard.ts'],
        composedMaxTasks: 1, changedFiles: [{ path: 'src/auth/guard.ts',
          patch: '@@ -0,0 +1 @@\n+export const guard = true;\n' }], coverageComplete: true, quorumSatisfied: true } };
    const gateRepo = new PostgresReviewGateRepository(pool!, { lifecycleEvents: 'enabled' });
    await expect(gateRepo.recordWorkerResult(targetCompletion, { workerTokenDigest: sha256(workerToken) },
      async () => trusted, gateNow)).resolves.toBe('recorded');
    const gateDecision = (await pool!.query(`SELECT decision FROM review_gate_attempts WHERE attempt_id = $1`,
      [admission.gate_attempt_id])).rows[0].decision;
    const targetReservation = (await pool!.query(`SELECT status, decision_receipt->'gateDecision' AS gate_decision
      FROM review_pr_review_reservations WHERE run_id = $1 AND execution_attempt = 3`, [source.sourceRunId])).rows[0];
    expect(gateDecision).toMatchObject({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
    expect(targetReservation).toMatchObject({ status: 'failed',
      gate_decision: { status: 'failure', eligible: false, reason: 'invalid-evidence' } });
  }, 30_000);

  it.each([
    { outcome: 'dispatch-failure', pr: 1271 },
    { outcome: 'pull-request-close', pr: 1272 },
    { outcome: 'supersession', pr: 1273 },
  ] as const)('records the admitted target reservation and $outcome before any trusted completion', async ({ outcome, pr }) => {
    const source = await seedReviewSource(pr);
    const tool = createDisputeFindingTool({ transactionPool: pool as never,
      authoritativePublishing: findingRecheckAdmission(source.sourceCompletion) });
    const findingId = getReviewFindingId(source.sourceRunId, task.id, sourceFinding);
    const input = { owner, repo, pr_number: pr, finding_id: findingId,
      counter_argument: `Run a fresh verification of the exact source finding for PR ${pr}.` };
    const result = await tool.execute(input, authenticatedContext(pr));
    const receipt = JSON.parse((result.content[0] as { text: string }).text);
    const request = (await pool!.query(`SELECT request_digest, request_id FROM review_finding_rechecks
      WHERE run_id = $1 AND source_execution_attempt = 2`, [source.sourceRunId])).rows[0];
    const target = (await pool!.query(`SELECT reservation_id, status, head_sha, base_sha, policy_digest,
        config_digest, context_digest, decision_receipt
      FROM review_pr_review_reservations WHERE run_id = $1 AND execution_attempt = 3`, [source.sourceRunId])).rows[0];
    expect(target).toMatchObject({ status: 'reserved', head_sha: headSha, base_sha: baseSha,
      policy_digest: policyDigest, config_digest: configDigest,
      context_digest: source.sourceContextDigest, decision_receipt: null });
    const targetEvent = (await pool!.query(`SELECT event_type, reservation_id, run_id, execution_attempt,
        evidence_digest, actor_digest, context_digest, payload
      FROM review_pr_lifecycle_events WHERE idempotency_key = $1`, [`${receipt.request_id}:recheck-target-admitted`])).rows[0];
    expect(targetEvent).toMatchObject({ event_type: 'finding.recheck_target_admitted',
      reservation_id: target.reservation_id, run_id: source.sourceRunId, execution_attempt: 3,
      evidence_digest: request.request_digest, actor_digest: sha256(`ws2-lifecycle-test-${pr}`),
      context_digest: source.sourceContextDigest,
      payload: { requestId: receipt.request_id, requestDigest: request.request_digest,
        sourceRunId: source.sourceRunId, sourceExecutionAttempt: 2,
        sourceCompletionDigest: source.sourceDigest, sourceContextDigest: source.sourceContextDigest,
        targetExecutionAttempt: 3, candidate: { headSha, baseSha, policyDigest, configDigest,
          contextDigest: source.sourceContextDigest } } });
    await pool!.query(`UPDATE review_gate_attempts SET creation_state = 'bound', check_id = $2,
        desired_state = 'queued', desired_version = 1, published_version = 1
      WHERE run_id = $1 AND execution_attempt = 3`, [source.sourceRunId, 71000 + pr]);
    const sourceGateBefore = (await pool!.query(`SELECT worker_result_digest, desired_state, desired_version,
        published_version, current_attempt
      FROM review_gate_attempts WHERE attempt_id = $1`, [source.sourceGateAttemptId])).rows[0];
    expect(sourceGateBefore).toMatchObject({ worker_result_digest: source.sourceDigest,
      desired_state: 'failure', current_attempt: false });

    const dispatch = new PostgresReviewDispatchRepository(pool!, undefined, { lifecycleEvents: 'enabled' });
    const now = Date.now();
    if (outcome === 'pull-request-close') {
      const closed = await dispatch.terminalizeRunsForClosedPullRequest({
        repositoryId, owner, repo, prNumber: pr, merged: false, now, deliveryId: `close-${pr}`,
      });
      expect(closed.terminalizedRunIds).toContain(source.sourceRunId);
    } else {
      const claim = await dispatch.claimNext(`ws2-lifecycle-${pr}`, now + 1, 30_000);
      expect(claim).toMatchObject({ runId: source.sourceRunId, executionAttempt: 3 });
      if (outcome === 'dispatch-failure') {
        await expect(dispatch.markTerminal(source.sourceRunId, claim!.leaseOwner, claim!.claimAttempt,
          now + 2, 'synthetic dispatcher failure')).resolves.toBe(true);
      } else {
        await expect(dispatch.supersedeClaim(source.sourceRunId, claim!.leaseOwner, claim!.claimAttempt,
          now + 2)).resolves.toBe(true);
      }
    }

    const terminalReservation = (await pool!.query(`SELECT status, decision_receipt FROM review_pr_review_reservations
      WHERE run_id = $1 AND execution_attempt = 3`, [source.sourceRunId])).rows[0];
    expect(terminalReservation).toMatchObject({ status: outcome === 'dispatch-failure' ? 'failed' : 'superseded',
      decision_receipt: null });
    const sourceGateAfter = (await pool!.query(`SELECT worker_result_digest, desired_state, desired_version,
        published_version, current_attempt
      FROM review_gate_attempts WHERE attempt_id = $1`, [source.sourceGateAttemptId])).rows[0];
    expect(sourceGateAfter).toEqual(sourceGateBefore);
    const targetGate = (await pool!.query(`SELECT desired_state, worker_result_digest, decision
      FROM review_gate_attempts WHERE run_id = $1 AND execution_attempt = 3`, [source.sourceRunId])).rows[0];
    expect(targetGate.desired_state).not.toBe('success');
    expect(targetGate.worker_result_digest).toBeNull();
    expect((await pool!.query(`SELECT count(*)::int AS count FROM review_semantic_finding_events
      WHERE run_id = $1 AND execution_attempt = 3`, [source.sourceRunId])).rows[0].count).toBe(0);
    const targetTerminalEvent = (await pool!.query(`SELECT event_type, payload
      FROM review_pr_lifecycle_events WHERE reservation_id = $1
      AND event_type IN ('review.failed', 'review.cancelled', 'review.superseded')`, [target.reservation_id])).rows;
    expect(targetTerminalEvent.map((event) => event.event_type)).toContain(
      outcome === 'dispatch-failure' ? 'review.failed' : 'review.superseded');
    expect((await pool!.query(`SELECT status FROM review_runs WHERE run_id = $1`, [source.sourceRunId])).rows[0].status)
      .toBe(outcome === 'dispatch-failure' ? 'failed' : 'superseded');
  });
});
