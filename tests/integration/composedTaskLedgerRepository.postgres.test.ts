import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresComposedTaskLedgerRepository, COMPOSED_TASK_LEDGER_SCHEMA_SQL } from '../../src/persistence/composedTaskLedgerRepository';
import { createComposedTaskPlan, createComposedTaskOutcome, MAX_COMPOSED_LEDGER_BYTES } from '../../src/review/composedTaskLedger';
import { canonicalJson } from '../../src/review/reviewCore';
import { ledgerFixture } from '../support/composedTaskLedgerFixture';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';
import type { ReviewPrTransactionPool } from '../../src/persistence/reviewPrTransaction';

requireDatabaseUrlInCi();
const databaseUrl = postgresDatabaseUrl();
const ownedSchema = /^composed_task_ledger_test_[a-f0-9]{16}$/u;

/** Pauses a REAL client after a chosen successful query, not an emulated database. */
function queryBarrier(pool: Pool, matches: (sql: string) => boolean, before = false) {
  let release!: () => void;
  let entered!: () => void;
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let held = false;
  const wrapped: ReviewPrTransactionPool = { async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql, values) {
      const pause = !held && matches(sql);
      if (pause) held = true;
      if (pause && before) { entered(); await resumed; }
      const result = await client.query(sql, values);
      if (pause && !before) { entered(); await resumed; }
      return { rows: result.rows, ...(result.rowCount !== null ? { rowCount: result.rowCount } : {}) };
    } };
  } };
  return { wrapped, reached, release };
}

describeWithPostgres('composed task ledger — real PostgreSQL, retention only', () => {
  let pool: Pool;
  let schema = '';
  let store: PostgresStore | undefined;
  let fixture: ReturnType<typeof ledgerFixture>;
  let repository: PostgresComposedTaskLedgerRepository;
  const repositoryId = 1_000_000_000 + randomInt(900_000_000);

  beforeAll(async () => {
    schema = `composed_task_ledger_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schema)) throw new Error('Test schema ownership invalid');
    pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // The production bootstrap, including its existing migration/locking gate.
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scoped.toString();
    store = new PostgresStore();
    try { await store.initialize(); }
    finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    repository = new PostgresComposedTaskLedgerRepository(pool);
  });

  afterAll(async () => {
    await store?.close();
    if (pool) {
      if (schema && ownedSchema.test(schema)) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  });

  beforeEach(async () => {
    // All rows in this random schema are this test's; cascade also proves new
    // immutable UPDATE guards do not break the existing run retention deletion.
    await pool.query('DELETE FROM review_runs');
    await pool.query('DELETE FROM github_deliveries');
    fixture = ledgerFixture(repositoryId, `run_${randomBytes(16).toString('hex')}`);
    const i = fixture.trusted.identity;
    await pool.query(`INSERT INTO review_runs (run_id, identity_digest, owner, repo, pr_number, head_sha,
      base_sha, snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
      identity, publication_mode, status, stage, attempt, repository_id, received_at, terminal_deadline,
      authoritative_gate_app_id, artifacts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11,'app-gate','running','review',0,$12,$13,$14,$15,$16)`,
    [i.runId, randomBytes(32).toString('hex'), i.owner, i.repo, i.prNumber, i.headSha, i.baseSha,
      i.snapshotDigest, i.configDigest, i.policyDigest, JSON.stringify({ owner: i.owner, repo: i.repo,
        prNumber: i.prNumber, headSha: i.headSha, baseSha: i.baseSha, snapshotDigest: i.snapshotDigest,
        configDigest: i.configDigest, reviewPolicy: { version: 'ReviewPolicyIdentity.v1',
          repositoryId: i.repositoryId, effectivePolicyDigest: i.policyDigest, sources: i.policySources } }),
      i.repositoryId, i.receivedAt, i.terminalDeadline, i.expectedAppId, JSON.stringify({ review_engine: 'composed' })]);
    await pool.query(`INSERT INTO github_deliveries (delivery_id,event_name,repository_id,installation_id,
      payload_digest,run_id,received_at) VALUES ($1,'pull_request',$2,1,$3,$1,$4)`,
    [i.runId, i.repositoryId, '8'.repeat(64), i.receivedAt]);
    await pool.query(`INSERT INTO review_dispatch_outbox (run_id,delivery_id,status,execution_attempt,
      worker_token_digest,projection_name) VALUES ($1,$1,'projected',0,$2,'owned-fixture-worker')`,
    [i.runId, fixture.proof.workerTokenDigest]);
    const coordinates = { runId: i.runId, repositoryId: i.repositoryId, owner: i.owner, repo: i.repo,
      prNumber: i.prNumber, headSha: i.headSha, baseSha: i.baseSha, policyDigest: i.policyDigest,
      executionAttempt: i.executionAttempt, attemptId: i.attemptId };
    await pool.query(`INSERT INTO review_gate_attempts (attempt_id,run_id,review_generation,execution_attempt,
      repository_id,pr_number,expected_app_id,coordinates,external_id,check_id,creation_state,desired_state)
      VALUES ($1,$2,0,1,$3,$4,$5,$6,$1,1001,'bound','in_progress')`,
    [i.attemptId, i.runId, i.repositoryId, i.prNumber, i.expectedAppId, JSON.stringify(coordinates)]);
  });

  const planOf = () => createComposedTaskPlan(fixture.trusted, fixture.tasks);
  const resultOf = (planDigest: string, delta: Record<string, unknown> = {}) => ({
    planDigest, taskId: fixture.tasks[0].id, status: 'complete', findings: [fixture.finding],
    usage: fixture.usage, ...delta,
  });
  const recordPlan = () => repository.recordPlan(fixture.trusted, fixture.tasks, fixture.proof);
  const recordTask = (input: unknown = resultOf(planOf().digest)) => repository.recordTask(fixture.trusted, input, fixture.proof);
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM composed_task_plans) AS plans,
    (SELECT count(*)::int FROM composed_task_outcomes) AS outcomes`)).rows[0];
  const closePr = (p: ReviewPrTransactionPool = pool) => new PostgresReviewDispatchRepository(p, undefined,
    { lifecycleEvents: 'disabled' }).terminalizeRunsForClosedPullRequest({
      ...fixture.trusted.identity, merged: false, now: Date.now(), deliveryId: 'owned-close-fixture',
    });

  it('installs additive schema through the actual bootstrap, and repeated schema is harmless', async () => {
    expect((await pool.query(`SELECT to_regclass('composed_task_plans')::text AS plans,
      to_regclass('composed_task_outcomes')::text AS outcomes`)).rows[0]).toEqual({
      plans: 'composed_task_plans', outcomes: 'composed_task_outcomes',
    });
    await pool.query(COMPOSED_TASK_LEDGER_SCHEMA_SQL);
  });

  it('persists an immutable plan and one outcome, then reloads through a new repository without granting Gate success', async () => {
    expect((await recordPlan()).status).toBe('recorded');
    expect((await recordTask()).status).toBe('recorded');
    const retained = await new PostgresComposedTaskLedgerRepository(pool).readRetained(fixture.trusted);
    expect(retained?.plan.payload.tasks).toEqual(fixture.tasks);
    expect(retained?.outcomes).toHaveLength(1);
    expect(retained?.outcomes[0].payload).toMatchObject({ status: 'complete', findings: [fixture.finding] });
    const native = (await pool.query(`SELECT runs.status,gate.desired_state,gate.worker_result_digest
      FROM review_runs runs JOIN review_gate_attempts gate USING(run_id)`)).rows[0];
    expect(native).toEqual({ status: 'running', desired_state: 'in_progress', worker_result_digest: null });
    expect(await counts()).toEqual({ plans: 1, outcomes: 1 });
  });

  it('serializes concurrent same-digest replay and refuses different plan/outcome digests', async () => {
    const plans = await Promise.all([recordPlan(), recordPlan()]);
    expect(plans.map(result => result.status).sort()).toEqual(['duplicate', 'recorded']);
    const changed = fixture.tasks.map((task, index) => index ? task : { ...task, question: 'Different valid task' });
    expect((await repository.recordPlan(fixture.trusted, changed, fixture.proof)).status).toBe('conflict');
    const outcomes = await Promise.all([recordTask(), recordTask()]);
    expect(outcomes.map(result => result.status).sort()).toEqual(['duplicate', 'recorded']);
    expect((await recordTask(resultOf(planOf().digest, { findings: [] }))).status).toBe('conflict');
    expect(await counts()).toEqual({ plans: 1, outcomes: 1 });
  });

  it('concurrent different results have one winner, not last-writer-wins', async () => {
    await recordPlan();
    const results = await Promise.all([recordTask(), recordTask(resultOf(planOf().digest, { findings: [] }))]);
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'recorded']);
    expect((await counts()).outcomes).toBe(1);
  });

  it.each(['image', 'source', 'manifest'])('immutable engine provenance %s cannot be replaced or reused by another context', async field => {
    await recordPlan();
    const engine = { ...fixture.trusted.identity.engine,
      ...(field === 'image' ? { imageDigest: `sha256:${'0'.repeat(64)}` } : {}),
      ...(field === 'source' ? { sourceSha: '0'.repeat(40) } : {}),
      ...(field === 'manifest' ? { buildManifestDigest: '0'.repeat(64) } : {}),
    };
    const changed = { ...fixture.trusted, identity: { ...fixture.trusted.identity, engine } };
    expect((await repository.recordPlan(changed, fixture.tasks, fixture.proof)).status).toBe('conflict');
    expect((await repository.recordTask(changed, resultOf(planOf().digest), fixture.proof)).status).toBe('conflict');
    await expect(repository.readRetained(changed)).rejects.toMatchObject({ code: 'identity-mismatch' });
    expect(await counts()).toEqual({ plans: 1, outcomes: 0 });
  });

  it('corrupt retained plan digest cannot become a duplicate acknowledgement or readable evidence', async () => {
    const plan = planOf();
    await pool.query(`INSERT INTO composed_task_plans (attempt_id,content_digest,payload,byte_length,task_count)
      VALUES ($1,$2,$3,$4,$5)`, [fixture.trusted.identity.attemptId, '0'.repeat(64),
      canonicalJson(plan.payload), plan.byteLength, fixture.tasks.length]);
    await expect(recordPlan()).rejects.toMatchObject({ code: 'integrity' });
    await expect(recordTask()).rejects.toMatchObject({ code: 'integrity' });
    await expect(repository.readRetained(fixture.trusted)).rejects.toMatchObject({ code: 'integrity' });
  });

  it.each(['digest', 'index'])('corrupt retained outcome %s fails closed on read and replay', async field => {
    await recordPlan();
    const outcome = createComposedTaskOutcome(planOf(), resultOf(planOf().digest), fixture.trusted.changedFiles);
    await pool.query(`INSERT INTO composed_task_outcomes (attempt_id,plan_digest,task_id,task_index,status,
      content_digest,payload,byte_length) VALUES ($1,$2,$3,$4,'complete',$5,$6,$7)`,
    [fixture.trusted.identity.attemptId, planOf().digest, fixture.tasks[0].id, field === 'index' ? 1 : 0,
      field === 'digest' ? '0'.repeat(64) : outcome.digest, canonicalJson(outcome.payload), outcome.byteLength]);
    await expect(repository.readRetained(fixture.trusted)).rejects.toMatchObject({ code: 'integrity' });
    await expect(recordTask()).rejects.toMatchObject({ code: 'integrity' });
  });

  it('missing ledger is null, wrong plan digest and unknown task never create evidence', async () => {
    expect(await repository.readRetained(fixture.trusted)).toBeNull();
    expect((await recordTask()).status).toBe('missing-plan');
    await recordPlan();
    expect((await recordTask(resultOf('8'.repeat(64)))).status).toBe('conflict');
    await expect(recordTask(resultOf(planOf().digest, { taskId: 'unknown' }))).rejects.toMatchObject({ code: 'invalid-outcome' });
    expect((await counts()).outcomes).toBe(0);
  });

  it.each(['token', 'generation', 'execution', 'head', 'policy', 'config', 'source', 'snapshot', 'app', 'identity'])
    ('rejects changed current fence %s before plan or task retention', async field => {
      await recordPlan();
      const updates: Record<string, string> = {
        token: `UPDATE review_dispatch_outbox SET worker_token_digest=repeat('0',64)`,
        generation: 'UPDATE review_runs SET attempt=1', execution: 'UPDATE review_dispatch_outbox SET execution_attempt=1',
        head: `UPDATE review_runs SET head_sha=repeat('0',40)`,
        policy: `UPDATE review_runs SET effective_policy_digest=repeat('0',64)`,
        config: `UPDATE review_runs SET effective_config_digest=repeat('0',64)`,
        source: `UPDATE review_runs SET identity=jsonb_set(identity,'{reviewPolicy,sources,0,sha}',to_jsonb(repeat('0',40)))`,
        snapshot: `UPDATE review_runs SET snapshot_digest=repeat('0',64)`,
        app: 'UPDATE review_runs SET authoritative_gate_app_id=1',
        identity: `UPDATE review_runs SET identity=jsonb_set(identity,'{headSha}',to_jsonb(repeat('0',40)))`,
      };
      await pool.query(updates[field]);
      expect((await recordTask()).status).toBe('unauthorized');
      expect((await recordPlan()).status).toBe('unauthorized');
      expect((await counts()).outcomes).toBe(0);
    });

  it.each([
    "UPDATE review_runs SET status='cancelled'", "UPDATE review_runs SET status='superseded'",
    "UPDATE review_runs SET cancel_requested_at=clock_timestamp()",
    "UPDATE review_dispatch_outbox SET cancel_requested_at=clock_timestamp()",
    "UPDATE review_dispatch_outbox SET status='terminal'",
    "UPDATE review_gate_attempts SET current_attempt=false",
    "UPDATE review_gate_attempts SET desired_state='success'",
    "UPDATE review_gate_attempts SET creation_state='reserved',check_id=NULL",
    "UPDATE review_runs SET terminal_deadline=clock_timestamp()-interval '1 second'",
  ])('revoked/terminal/expired worker cannot commit or receive a duplicate ACK: %s', async sql => {
    await recordPlan(); await recordTask();
    await pool.query(sql);
    expect((await recordPlan()).status).toBe('stale');
    expect((await recordTask()).status).toBe('stale');
    expect((await counts()).outcomes).toBe(1);
  });

  it('cancel wins under the actual PR-lock order and late outcome is rejected', async () => {
    await recordPlan();
    const barrier = queryBarrier(pool, sql => sql.includes('pg_advisory_xact_lock(hashtextextended'));
    const cancelled = closePr(barrier.wrapped);
    try {
      await barrier.reached;
      const late = recordTask();
      barrier.release();
      expect((await cancelled).terminalizedRunIds).toEqual([fixture.trusted.identity.runId]);
      expect((await late).status).toBe('stale');
      expect((await counts()).outcomes).toBe(0);
    } finally { barrier.release(); await cancelled; }
  });

  it('outcome wins before cancel: immutable historical evidence survives, but native Gate cancels', async () => {
    await recordPlan();
    const barrier = queryBarrier(pool, sql => sql.includes('INSERT INTO composed_task_outcomes'));
    const writer = new PostgresComposedTaskLedgerRepository(barrier.wrapped).recordTask(fixture.trusted,
      resultOf(planOf().digest), fixture.proof);
    try {
      await barrier.reached;
      const cancelled = closePr();
      barrier.release();
      expect((await writer).status).toBe('recorded');
      await cancelled;
      expect((await repository.readRetained(fixture.trusted))?.outcomes).toHaveLength(1);
      expect((await pool.query('SELECT desired_state FROM review_gate_attempts')).rows[0].desired_state).toBe('cancelled');
    } finally { barrier.release(); await writer; }
  });

  it('uses DB wall clock after waiting/writing, not a caller clock or transaction-start time', async () => {
    const deadline = new Date(Date.now() + 2000).toISOString();
    fixture.trusted.identity.terminalDeadline = deadline;
    await pool.query('UPDATE review_runs SET terminal_deadline=$1', [deadline]);
    await recordPlan();
    const barrier = queryBarrier(pool, sql => sql.includes('INSERT INTO composed_task_outcomes'));
    const writer = new PostgresComposedTaskLedgerRepository(barrier.wrapped).recordTask(fixture.trusted,
      resultOf(planOf().digest), fixture.proof);
    try {
      await barrier.reached;
      await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.03)`, [deadline]);
      barrier.release();
      await expect(writer).rejects.toMatchObject({ code: 'fence-expired' });
      expect((await counts()).outcomes).toBe(0);
    } finally { barrier.release(); await writer.catch(() => undefined); }
  });

  it('expired duplicate does not get a current-worker ACK after a slow storage read', async () => {
    const deadline = new Date(Date.now() + 2000).toISOString();
    fixture.trusted.identity.terminalDeadline = deadline;
    await pool.query('UPDATE review_runs SET terminal_deadline=$1', [deadline]);
    await recordPlan(); await recordTask();
    const barrier = queryBarrier(pool, sql => sql.includes('SELECT * FROM composed_task_outcomes'));
    const writer = new PostgresComposedTaskLedgerRepository(barrier.wrapped).recordTask(fixture.trusted,
      resultOf(planOf().digest), fixture.proof);
    try {
      await barrier.reached;
      await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.03)`, [deadline]);
      barrier.release();
      expect((await writer).status).toBe('stale');
      expect((await counts()).outcomes).toBe(1);
    } finally { barrier.release(); await writer; }
  });

  it('deadline between the last fence read and COMMIT still rolls back at the real DB boundary', async () => {
    const deadline = new Date(Date.now() + 2000).toISOString();
    fixture.trusted.identity.terminalDeadline = deadline;
    await pool.query('UPDATE review_runs SET terminal_deadline=$1', [deadline]);
    await recordPlan();
    const barrier = queryBarrier(pool, sql => sql === 'COMMIT', true);
    const writer = new PostgresComposedTaskLedgerRepository(barrier.wrapped).recordTask(fixture.trusted,
      resultOf(planOf().digest), fixture.proof);
    try {
      await barrier.reached;
      await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.03)`, [deadline]);
      barrier.release();
      await expect(writer).rejects.toMatchObject({ code: 'fence-expired' });
      expect((await counts()).outcomes).toBe(0);
    } finally { barrier.release(); await writer.catch(() => undefined); }
  });

  it('rolls back real insert failure and sanitizes SQL/body diagnostics', async () => {
    await recordPlan();
    await pool.query(`CREATE FUNCTION fixture_reject_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'PRIVATE_SQL_BODY_NOT_FOR_LOGS'; END $$;
      CREATE TRIGGER fixture_reject_outcome AFTER INSERT ON composed_task_outcomes
      FOR EACH ROW EXECUTE FUNCTION fixture_reject_outcome()`);
    try {
      await expect(recordTask()).rejects.toMatchObject({ code: 'storage-unavailable' });
      try { await recordTask(); } catch (error) { expect(String(error)).not.toContain('PRIVATE_SQL_BODY_NOT_FOR_LOGS'); }
      expect(await counts()).toEqual({ plans: 1, outcomes: 0 });
    } finally {
      await pool.query('DROP TRIGGER fixture_reject_outcome ON composed_task_outcomes; DROP FUNCTION fixture_reject_outcome()');
    }
  });

  it('actual storage outage is unavailable, not corrupt evidence or an empty successful ledger', async () => {
    await recordPlan();
    await pool.query('ALTER TABLE composed_task_outcomes RENAME TO composed_task_outcomes_unavailable');
    try {
      await expect(recordTask()).rejects.toMatchObject({ code: 'storage-unavailable' });
      await expect(repository.readRetained(fixture.trusted)).rejects.toMatchObject({ code: 'storage-unavailable' });
    } finally { await pool.query('ALTER TABLE composed_task_outcomes_unavailable RENAME TO composed_task_outcomes'); }
    expect((await counts()).outcomes).toBe(0);
  });

  it('snapshots the candidate before awaiting the PR lock, not after caller mutation', async () => {
    await recordPlan();
    const barrier = queryBarrier(pool, sql => sql.includes('pg_advisory_xact_lock(hashtextextended'));
    const candidate = resultOf(planOf().digest);
    const writer = new PostgresComposedTaskLedgerRepository(barrier.wrapped).recordTask(fixture.trusted,
      candidate, fixture.proof);
    try {
      await barrier.reached;
      candidate.findings = [];
      barrier.release();
      expect((await writer).status).toBe('recorded');
      expect((await repository.readRetained(fixture.trusted))?.outcomes[0].payload).toMatchObject({ findings: [fixture.finding] });
    } finally { barrier.release(); await writer; }
  });

  it('lost acknowledgement after COMMIT replays as duplicate, not another insertion', async () => {
    await recordPlan();
    const ackLoss: ReviewPrTransactionPool = { async connect() {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        return { rows: result.rows, ...(result.rowCount !== null ? { rowCount: result.rowCount } : {}) };
      }, release: () => {
        client.release(); throw new Error('PRIVATE_ACK_LOSS');
      } };
    } };
    await expect(new PostgresComposedTaskLedgerRepository(ackLoss).recordTask(fixture.trusted,
      resultOf(planOf().digest), fixture.proof)).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect((await recordTask()).status).toBe('duplicate');
    expect((await counts()).outcomes).toBe(1);
  });

  it('rejects in-place SQL mutation, and aggregate bytes cannot exceed the existing evidence bound', async () => {
    await recordPlan(); await recordTask();
    await expect(pool.query(`UPDATE composed_task_plans SET content_digest=repeat('0',64)`)).rejects.toThrow();
    await expect(pool.query(`UPDATE composed_task_outcomes SET payload='{}'`)).rejects.toThrow();
    const oversized = '界'.repeat(MAX_COMPOSED_LEDGER_BYTES);
    await expect(pool.query(`INSERT INTO composed_task_outcomes (attempt_id,plan_digest,task_id,task_index,
      status,content_digest,payload,byte_length) VALUES ($1,$2,'security',1,'blocked',$3,$4,$5)`,
    [fixture.trusted.identity.attemptId, planOf().digest, '8'.repeat(64), oversized, Buffer.byteLength(oversized)])).rejects.toThrow();
    await expect(pool.query(`INSERT INTO composed_task_outcomes (attempt_id,plan_digest,task_id,task_index,
      status,content_digest,payload,byte_length) VALUES ($1,$2,'security',1,'blocked',$3,'{}',2)`,
    [fixture.trusted.identity.attemptId, planOf().digest, '8'.repeat(64)])).rejects.toThrow();
  });

  it('bounds the sum of individually valid retained receipts and rolls back only the rejected one', async () => {
    await recordPlan();
    const findings = Array.from({ length: 35 }, () => ({ ...fixture.finding, body: 'x'.repeat(16_000) }));
    expect((await recordTask(resultOf(planOf().digest, { findings }))).status).toBe('recorded');
    await expect(recordTask(resultOf(planOf().digest, { taskId: 'security',
      findings: findings.map(finding => ({ ...finding, path: 'src/auth.ts' })) }))).rejects.toMatchObject({ code: 'byte-bound' });
    expect((await counts()).outcomes).toBe(1);
  });

  it('retains blocked/exhausted without manufacturing coverage or terminal publication', async () => {
    await recordPlan();
    expect((await recordTask({ planDigest: planOf().digest, taskId: fixture.tasks[0].id,
      status: 'blocked', usage: fixture.usage })).status).toBe('recorded');
    expect((await recordTask({ planDigest: planOf().digest, taskId: fixture.tasks[1].id,
      status: 'exhausted', usage: fixture.usage, diagnostics: fixture.diagnostics })).status).toBe('recorded');
    expect((await repository.readRetained(fixture.trusted))?.outcomes.map(outcome => outcome.payload.status)).toEqual(['blocked', 'exhausted']);
    expect((await pool.query('SELECT desired_state FROM review_gate_attempts')).rows[0].desired_state).toBe('in_progress');
  });
});
