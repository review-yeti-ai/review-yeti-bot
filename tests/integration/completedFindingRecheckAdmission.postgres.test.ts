import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import { createRemoteMcpRouter } from '../../src/mcp/server/remoteMcpRouter';
import { getReviewFindingId } from '../../src/mcp/server/tools/findingIdentity';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { workerReviewCompletionDigest, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { REVIEW_GENERATION_RECOVERY_SCHEMA_SQL } from '../../src/persistence/reviewGenerationRecoverySchema';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import { createReviewExecutionCheckpointHandler } from '../../src/api/reviewExecutionCheckpointRoute';
import { REVIEW_GATE_CHECK_NAME } from '../../src/review/reviewCheckIdentity';
import { findingRecheckAdmission } from '../support/findingRecheckAdmission';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();
const identity = { runId: `run_${'9'.repeat(32)}`, repositoryId: 1450000002, owner: 'calltelemetry',
  repo: 'ct-review-actions', prNumber: 1266, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64) };
const now = Date.now();
const tasks = ['security', 'correctness', 'contracts'].map((id) => ({ id, dimension: 'security' as const,
  paths: [`src/${id}.ts`], question: `Is ${id} correct?`, rationale: 'This is a changed guarded path.' }));
const findings = tasks.map((task) => ({ severity: 'P2' as const, path: task.paths[0]!, line: 2,
  title: `${task.id} needs verification`, body: 'The changed boundary requires a current source proof.' }));
const source: WorkerReviewCompletion = { version: 'WorkerReviewCompletion.v1', ...identity, executionAttempt: 2,
  result: { version: 'WorkerReviewResult.v1', completedAt: '2026-10-01T12:00:00.000Z', taskPlan: tasks,
    personas: tasks.map((task, index) => ({ id: task.id, decision: 'FINDINGS', status: 'COMPLETE', findings: [findings[index]!] })),
    coverageComplete: true, quorumSatisfied: true, findingCount: 3, blockingFindingCount: 3 } };
const sourceDigest = workerReviewCompletionDigest(source);
const sourceGateId = `${identity.runId}-g1-e2`;
const context = { authenticatedByConfiguredAuthenticator: true, caller: { authType: 'static_token' as const,
  tokenDigest: 'offline-fixture', isAdmin: true, allowedRepositories: null, callerId: 'completed-recheck-sql-fixture' },
  authorizedRepository: { owner: identity.owner, repo: identity.repo } };
const input = (index: number) => ({ owner: identity.owner, repo: identity.repo, pr_number: identity.prNumber,
  finding_id: getReviewFindingId(identity.runId, tasks[index]!.id, findings[index]),
  counter_argument: `Current ${tasks[index]!.id} source and hosted checks prove the guard already handles this condition.` });

describeWithPostgres('completed finding task admission (real SQL + native dispatch)', () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let dispatcher: PostgresReviewDispatchRepository;
  beforeAll(async () => {
    schema = `review_completed_recheck_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ connectionString: postgresDatabaseUrl(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: postgresDatabaseUrl(), max: 5, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY, owner TEXT, repo TEXT, pr_number INTEGER, repository_id BIGINT,
      head_sha TEXT, base_sha TEXT, effective_policy_digest TEXT, effective_config_digest TEXT,
      publication_mode TEXT DEFAULT 'app-gate', status TEXT, stage TEXT DEFAULT 'complete', attempt INTEGER,
      result_digest TEXT, received_at TIMESTAMPTZ, terminal_deadline TIMESTAMPTZ, publication_fence TEXT,
      error_text TEXT, artifacts JSONB DEFAULT '{}'::jsonb, failure_diagnostics JSONB DEFAULT '{}'::jsonb,
      lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE github_deliveries (delivery_id TEXT PRIMARY KEY, repository_id BIGINT, installation_id BIGINT);
      CREATE TABLE review_dispatch_outbox (run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
      delivery_id TEXT, status TEXT, execution_attempt INTEGER, worker_token_digest TEXT, projection_name TEXT,
      terminal_receipt_digest TEXT, lease_owner TEXT, lease_expires_at TIMESTAMPTZ, attempt INTEGER DEFAULT 0,
      dispatch_priority INTEGER DEFAULT 0, available_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      cancel_requested_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(REVIEW_GATE_SCHEMA_SQL);
    await pool.query(REVIEW_GENERATION_RECOVERY_SCHEMA_SQL);
    dispatcher = new PostgresReviewDispatchRepository(pool as never, undefined, { lifecycleEvents: 'disabled' });
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && /^review_completed_recheck_[a-f0-9]{16}$/u.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE review_runs, github_deliveries CASCADE');
    await pool.query(`INSERT INTO review_runs (run_id, owner, repo, pr_number, repository_id, head_sha, base_sha,
      effective_policy_digest, effective_config_digest, status, attempt, authoritative_gate_app_id,
      result_digest, received_at, terminal_deadline) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'succeeded',1,4385771,$10,
      to_timestamp(($11::double precision - 3600000)/1000.0),to_timestamp(($11::double precision - 1)/1000.0))`,
    [identity.runId, identity.owner, identity.repo, identity.prNumber, identity.repositoryId, identity.headSha,
      identity.baseSha, identity.policyDigest, identity.configDigest, sourceDigest, now]);
    await pool.query("INSERT INTO github_deliveries VALUES ('original-source', $1, 2001)", [identity.repositoryId]);
    await pool.query(`INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, execution_attempt,
      worker_token_digest, projection_name, terminal_receipt_digest) VALUES ($1,'original-source','projected',1,$2,
      'completed-original-worker',$3)`, [identity.runId, sha256('old-worker-token'), sourceDigest]);
    await pool.query(`INSERT INTO review_worker_completions (run_id,execution_attempt,content_digest,payload,byte_length)
      VALUES ($1,2,$2,$3::jsonb,$4)`, [identity.runId, sourceDigest, JSON.stringify(source), Buffer.byteLength(JSON.stringify(source))]);
    const coordinates = { ...identity, executionAttempt: 2, attemptId: sourceGateId };
    delete (coordinates as Partial<typeof identity>).configDigest;
    await pool.query(`INSERT INTO review_gate_attempts (attempt_id, run_id,review_generation,execution_attempt,
      repository_id,pr_number,expected_app_id,coordinates,external_id,check_id,creation_state,desired_state,
      desired_version,published_version,current_attempt,worker_result_digest)
      VALUES ($1,$2,1,2,$3,$4,4385771,$5::jsonb,'original-source-gate',60001,'bound','success',2,2,true,$6)`,
    [sourceGateId, identity.runId, identity.repositoryId, identity.prNumber, JSON.stringify(coordinates), sourceDigest]);
    const checkpoint = { version: 'ReviewExecutionCheckpoint.v1', ...identity, executionAttempt: 2, revision: 4,
      plan: tasks, completedTasks: tasks.map((task, index) => ({ id: task.id, findings: [findings[index]] })) };
    await pool.query(`INSERT INTO review_execution_checkpoints (run_id,execution_attempt,revision,head_sha,config_digest,
      payload,byte_length) VALUES ($1,2,4,$2,$3,$4::jsonb,$5)`, [identity.runId, identity.headSha, identity.configDigest,
      JSON.stringify(checkpoint), Buffer.byteLength(JSON.stringify(checkpoint))]);
  });
  const tool = () => createDisputeFindingTool({ transactionPool: pool as never,
    authoritativePublishing: findingRecheckAdmission(identity), now: () => now });
  const ledgerCounts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM review_finding_rechecks) AS requests,
    (SELECT count(*)::int FROM review_finding_recheck_admissions) AS admissions`)).rows[0];
  const publishFreshGate = async () => {
    const repository = new PostgresReviewGateRepository(pool, { lifecycleEvents: 'disabled' });
    const publication = await repository.claimPublication('offline-publisher', now);
    expect(publication).not.toBeNull();
    expect(await repository.publishLocked(publication!, async (gate) => ({
      id: 60000 + gate.reviewGeneration, name: REVIEW_GATE_CHECK_NAME, appId: gate.expectedAppId,
      headSha: gate.coordinates.headSha, externalId: gate.externalId,
      status: gate.desiredState === 'queued' ? 'queued' as const : 'completed' as const,
      conclusion: gate.desiredState === 'failure' ? 'failure' : null,
    }), () => now)).toBe('published');
  };

  it('admits an ordinary succeeded review, coalesces pending tasks, and dispatches exactly one fresh fenced execution', async () => {
    const originalCompletion = (await pool.query('SELECT * FROM review_worker_completions')).rows[0];
    const originalGate = (await pool.query('SELECT * FROM review_gate_attempts')).rows[0];
    const originalCheckpoint = (await pool.query('SELECT * FROM review_execution_checkpoints')).rows[0];
    const first = await tool().execute(input(0), context);
    const duplicate = await tool().execute(input(0), context);
    expect(duplicate).toEqual(first);
    await tool().execute(input(1), context);
    expect(await ledgerCounts()).toEqual({ requests: 2, admissions: 1 });
    const admitted = (await pool.query('SELECT * FROM review_finding_recheck_admissions')).rows[0];
    expect(admitted).toMatchObject({ source_execution_attempt: 2, execution_attempt: 3, review_generation: 2,
      requested_by: sha256(context.caller.callerId), gate_attempt_id: `${identity.runId}-g2-e3` });
    expect(admitted.terminal_deadline.getTime() - admitted.received_at.getTime()).toBe(1500000);
    expect(await dispatcher.claimNext('worker-a', now, 30000)).toBeNull();
    await publishFreshGate();
    const claim = await dispatcher.claimNext('worker-a', now, 30000);
    expect(claim).toMatchObject({ runId: identity.runId, executionAttempt: 3, headSha: identity.headSha,
      policyDigest: identity.policyDigest, configDigest: identity.configDigest, workerTokenDigest: undefined });
    expect(await dispatcher.claimNext('worker-b', now, 30000)).toBeNull();
    const workerBearer = 'ghs_fresh_worker_fixture';
    const newToken = sha256(workerBearer);
    expect(await dispatcher.bindWorkerTokenDigest(identity.runId, 'worker-a', claim!.claimAttempt, newToken, now)).toBe(true);
    expect(await dispatcher.bindWorkerTokenDigest(identity.runId, 'worker-a', claim!.claimAttempt,
      sha256('old-worker-token'), now)).toBe(false);
    expect(await tool().execute(input(0), context)).toEqual(first);
    await expect(tool().execute(input(2), context)).rejects.toThrow('wait for its fresh completion');
    expect(await ledgerCounts()).toEqual({ requests: 2, admissions: 1 });
    expect((await pool.query('SELECT * FROM review_worker_completions')).rows[0]).toEqual(originalCompletion);
    expect((await pool.query('SELECT * FROM review_execution_checkpoints')).rows[0]).toEqual(originalCheckpoint);
    expect((await pool.query('SELECT * FROM review_gate_attempts WHERE attempt_id=$1', [sourceGateId])).rows[0])
      .toEqual({ ...originalGate, current_attempt: false });

    // Normal authenticated completion accepts only the requested fresh task
    // receipts. The remaining P2 stays required, then becomes a new request
    // against the fresh accepted source, never the retired original Gate.
    expect(await dispatcher.markProjected(identity.runId, 'worker-a', claim!.claimAttempt,
      'fresh-worker', now, sha256(workerBearer))).toBe(true);
    const app = express();
    app.use(express.json());
    app.post('/checkpoint', createReviewExecutionCheckpointHandler(pool));
    const read = await request(app).post('/checkpoint').set('Authorization', `Bearer ${workerBearer}`)
      .send({ version: 'ReviewExecutionCheckpointRead.v1', runId: identity.runId, executionAttempt: 3 });
    expect(read.status).toBe(200);
    expect(read.body.disputedFindingRechecks).toHaveLength(2);
    const fresh = structuredClone(source);
    fresh.executionAttempt = 3;
    fresh.result.personas[0]!.findings = [];
    fresh.result.personas[1]!.findings = [];
    fresh.result.findingCount = 1;
    fresh.result.blockingFindingCount = 1;
    const written = await request(app).post('/checkpoint').set('Authorization', `Bearer ${workerBearer}`).send({
      ...read.body.checkpoint, executionAttempt: 3, revision: 5,
      completedTasks: fresh.result.personas.map((persona) => ({ id: persona.id, findings: persona.findings })),
      satisfiedFindingRecheckIds: read.body.disputedFindingRechecks.map((entry: { requestId: string }) => entry.requestId),
    });
    expect(written.status).toBe(200);
    const gates = new PostgresReviewGateRepository(pool, { lifecycleEvents: 'disabled' });
    expect(await gates.recordWorkerResult(fresh, { workerTokenDigest: sha256(workerBearer) }, async () => ({
      current: { repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
        prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha,
        policyDigest: identity.policyDigest, open: true, draft: false },
      coverage: { expectedPersonaIds: tasks.map((task) => task.id), reviewEngine: 'composed' as const,
        composedChangedPaths: tasks.flatMap((task) => task.paths),
        changedFiles: tasks.map((task) => ({ path: task.paths[0]!, patch: '@@ -1,0 +1,3 @@\n+one\n+two\n+three\n' })),
        coverageComplete: true, quorumSatisfied: true },
    }), now)).toBe('recorded');
    expect((await pool.query('SELECT status FROM review_runs')).rows[0].status).toBe('failed');
    await publishFreshGate();
    await tool().execute(input(2), context);
    expect(await ledgerCounts()).toEqual({ requests: 3, admissions: 2 });
    expect((await pool.query('SELECT execution_attempt,review_generation FROM review_finding_recheck_admissions ORDER BY execution_attempt')).rows)
      .toEqual([{ execution_attempt: 3, review_generation: 2 }, { execution_attempt: 4, review_generation: 3 }]);
    expect((await pool.query('SELECT * FROM review_worker_completions WHERE execution_attempt=2')).rows[0]).toEqual(originalCompletion);
    expect((await pool.query('SELECT * FROM review_gate_attempts WHERE attempt_id=$1', [sourceGateId])).rows[0])
      .toEqual({ ...originalGate, current_attempt: false });
  });

  it('rolls back a task arriving after a dispatcher wins the claim race', async () => {
    await tool().execute(input(0), context);
    await publishFreshGate();
    let announce!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { announce = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const authoritative = findingRecheckAdmission(identity);
    const originalResolve = authoritative.resolver.resolve;
    authoritative.resolver.resolve = async (...args) => { announce(); await wait; return originalResolve(...args); };
    const racing = createDisputeFindingTool({ transactionPool: pool as never, authoritativePublishing: authoritative,
      now: () => now }).execute(input(1), context);
    const rejected = expect(racing).rejects.toThrow('wait for its fresh completion');
    await entered;
    expect(await dispatcher.claimNext('race-winner', now, 30000)).toMatchObject({ executionAttempt: 3 });
    release();
    await rejected;
    expect(await ledgerCounts()).toEqual({ requests: 1, admissions: 1 });
    expect((await pool.query('SELECT status,execution_attempt FROM review_dispatch_outbox')).rows[0])
      .toEqual({ status: 'claimed', execution_attempt: 2 });
  });

  it.each(['headSha', 'baseSha', 'repositoryId', 'open', 'draft', 'policy', 'config'] as const)
  ('rejects changed current %s without recording a request or execution', async (field) => {
    const authoritative = findingRecheckAdmission(identity);
    const originalResolve = authoritative.resolver.resolve;
    authoritative.resolver.resolve = async (...args) => {
      const result = await originalResolve(...args);
      if (field === 'policy') result.prepared.policy.effectivePolicyDigest = 'f'.repeat(64);
      else if (field === 'config') result.prepared.policy.effectiveConfigDigest = 'f'.repeat(64);
      else if (field === 'open') result.current.open = false;
      else if (field === 'draft') result.current.draft = true;
      else if (field === 'repositoryId') result.current.repositoryId++;
      else result.current[field] = 'f'.repeat(40);
      return result;
    };
    await expect(createDisputeFindingTool({ transactionPool: pool as never, authoritativePublishing: authoritative })
      .execute(input(0), context)).rejects.toThrow('current candidate and trusted policy');
    expect(await ledgerCounts()).toEqual({ requests: 0, admissions: 0 });
  });

  it('rejects forged direct context before DB admission and fails closed on unavailable authoritative truth', async () => {
    const connect = vi.spyOn(pool, 'connect');
    await expect(tool().execute(input(0), { ...context, authenticatedByConfiguredAuthenticator: false })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
    const authoritative = findingRecheckAdmission(identity);
    authoritative.resolver.resolve = async () => { throw new Error('Current GitHub truth unavailable'); };
    await expect(createDisputeFindingTool({ transactionPool: pool as never, authoritativePublishing: authoritative })
      .execute(input(0), context)).rejects.toThrow('Current GitHub truth unavailable');
    expect(await ledgerCounts()).toEqual({ requests: 0, admissions: 0 });
  });

  it('reaches the same durable admission through configured MCP authentication and repository RBAC', async () => {
    const router = createRemoteMcpRouter({ db: pool,
      triggerDeps: { authoritativePublishing: findingRecheckAdmission(identity) },
      authenticator: { authenticate: async (req: unknown) => {
        const bearer = typeof req === 'string' ? req : (req as { header(name: string): string }).header('authorization');
        if (bearer !== 'Bearer verified-offline-fixture') throw new Error('Unauthorized fixture');
        return context.caller;
      }, checkRepositoryAccess: (_caller, owner, repo) => owner === identity.owner && repo === identity.repo },
    });
    const app = express();
    app.use(express.json());
    app.use('/mcp', router);
    try {
      const message = { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'dispute_finding', arguments: input(0) } };
      const unauthenticated = await request(app).post('/mcp').send(message);
      expect(unauthenticated.status).toBe(401);
      expect(await ledgerCounts()).toEqual({ requests: 0, admissions: 0 });
      const accepted = await request(app).post('/mcp').set('Authorization', 'Bearer verified-offline-fixture').send(message);
      expect(accepted.status).toBe(200);
      expect(accepted.body.error).toBeUndefined();
      expect(JSON.parse(accepted.body.result.content[0].text)).toMatchObject({ review_status: 'fresh_re_review_requested' });
      expect(await ledgerCounts()).toEqual({ requests: 1, admissions: 1 });
    } finally { router.destroy(); }
  });

  it('rolls back request insertion if the exact native dispatch/source fence was lost', async () => {
    await pool.query("UPDATE review_runs SET result_digest=$1", ['f'.repeat(64)]);
    await expect(tool().execute(input(0), context)).rejects.toThrow('accepted source');
    expect(await ledgerCounts()).toEqual({ requests: 0, admissions: 0 });
    expect((await pool.query('SELECT status,attempt FROM review_runs')).rows[0]).toEqual({ status: 'succeeded', attempt: 1 });
    expect((await pool.query('SELECT current_attempt FROM review_gate_attempts')).rows[0].current_attempt).toBe(true);
  });
});
