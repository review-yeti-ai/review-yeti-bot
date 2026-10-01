import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresStore, ADVISORY_LOCK_ID } from '../../src/persistence/postgresStore';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresComposedTaskLedgerRepository, COMPOSED_TASK_LEDGER_SCHEMA_SQL } from '../../src/persistence/composedTaskLedgerRepository';
import { createComposedTaskPlan, createComposedTaskOutcome, MAX_COMPOSED_LEDGER_BYTES } from '../../src/review/composedTaskLedger';
import { canonicalJson } from '../../src/review/reviewCore';
import { MAX_TASKS_HARD_CAP } from '../../src/reviewTaskContract';
import { SCHEMA_MIGRATIONS_TABLE, applySchemaOnce } from '../../src/persistence/schemaMigrationGate';
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

/** Both waits use bound parameters; the second provides the test's explicit
 * post-cutoff margin without mixing delay arithmetic into a SQL expression. */
async function waitPastDeadline(pool: Pool, deadline: string): Promise<void> {
  await pool.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))))', [deadline]);
  await pool.query('SELECT pg_sleep($1::double precision)', [0.03]);
}

function jsonAtByteLength(value: Record<string, unknown>, byteLength: number): string {
  const emptyPadding = JSON.stringify({ ...value, padding: '' });
  const paddingBytes = byteLength - Buffer.byteLength(emptyPadding, 'utf8');
  if (paddingBytes < 0) throw new Error('Fixture cannot fit the requested JSON byte length');
  const payload = JSON.stringify({ ...value, padding: 'x'.repeat(paddingBytes) });
  if (Buffer.byteLength(payload, 'utf8') !== byteLength) throw new Error('Fixture byte length is not exact');
  return payload;
}

describeWithPostgres('composed task ledger — real PostgreSQL, retention only', () => {
  let pool: Pool;
  let schema = '';
  let scopedDatabaseUrl = '';
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
    scopedDatabaseUrl = scoped.toString();
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scopedDatabaseUrl;
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

  // Frozen base554 CREATE layout: retain inline multi-column byte checks so
  // PostgreSQL, not a synthetic named guard, supplies the historical names.
  const historicalLedgerSql = (bounds: { planBytes?: number; outcomeBytes?: number;
    planTasks?: number; outcomeIndex?: number } = {}) => `
    CREATE TABLE IF NOT EXISTS composed_task_plans (
      attempt_id TEXT PRIMARY KEY REFERENCES review_gate_attempts(attempt_id) ON DELETE CASCADE,
      content_digest VARCHAR(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
      payload TEXT NOT NULL CHECK (jsonb_typeof(payload::jsonb) = 'object'),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= ${bounds.planBytes ?? 1_000_000}
        AND byte_length = octet_length(payload)),
      task_count INTEGER NOT NULL CHECK (task_count BETWEEN 1 AND ${bounds.planTasks ?? 8}),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (attempt_id, content_digest),
      CHECK ((payload::jsonb->>'version' = 'ComposedTaskLedger.v1') IS TRUE),
      CHECK ((payload::jsonb->'identity'->>'attemptId' = attempt_id) IS TRUE),
      CHECK ((jsonb_array_length(payload::jsonb->'tasks') = task_count) IS TRUE)
    );
    CREATE TABLE IF NOT EXISTS composed_task_outcomes (
      attempt_id TEXT NOT NULL,
      plan_digest VARCHAR(64) NOT NULL,
      task_id TEXT NOT NULL CHECK (task_id ~ '^[a-z][a-z0-9_-]{0,127}$'),
      task_index INTEGER NOT NULL CHECK (task_index BETWEEN 0 AND ${bounds.outcomeIndex ?? 7}),
      status TEXT NOT NULL CHECK (status IN ('complete', 'blocked', 'exhausted')),
      content_digest VARCHAR(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
      payload TEXT NOT NULL CHECK (jsonb_typeof(payload::jsonb) = 'object'),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= ${bounds.outcomeBytes ?? 1_000_000}
        AND byte_length = octet_length(payload)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (attempt_id, task_id), UNIQUE (attempt_id, task_index),
      FOREIGN KEY (attempt_id, plan_digest) REFERENCES composed_task_plans(attempt_id, content_digest) ON DELETE CASCADE,
      CHECK ((payload::jsonb->>'version' = 'ComposedTaskOutcome.v1') IS TRUE),
      CHECK ((payload::jsonb->>'planDigest' = plan_digest) IS TRUE),
      CHECK ((payload::jsonb->>'taskId' = task_id) IS TRUE), CHECK ((payload::jsonb->>'status' = status) IS TRUE)
    );
  ` + COMPOSED_TASK_LEDGER_SCHEMA_SQL.slice(
    COMPOSED_TASK_LEDGER_SCHEMA_SQL.indexOf('CREATE OR REPLACE FUNCTION composed_task_ledger_reject_update()'));

  const initializeStore = async () => {
    if (!store || !scopedDatabaseUrl) throw new Error('PostgresStore bootstrap fixture was not initialized');
    const [testSchema, storeSchema] = await Promise.all([
      pool.query('SELECT current_schema() AS name'),
      store.getPool().query('SELECT current_schema() AS name'),
    ]);
    expect(testSchema.rows[0]?.name).toBe(schema);
    expect(storeSchema.rows[0]?.name).toBe(schema);
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scopedDatabaseUrl;
    try { await store.initialize(); }
    finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  };
  const readChecks = async () => (await pool.query(`SELECT conrelid::regclass::text AS relation,
    conname, oid::text AS oid, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid IN ('composed_task_plans'::regclass, 'composed_task_outcomes'::regclass)
      AND contype='c' ORDER BY relation,conname`)).rows;
  const readMarkers = async () => (await pool.query(`SELECT fingerprint, applied_at
    FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY fingerprint`)).rows;
  const readEvidence = async () => Promise.all([
    pool.query('SELECT * FROM composed_task_plans WHERE attempt_id=$1', [fixture.trusted.identity.attemptId]),
    pool.query('SELECT * FROM composed_task_outcomes WHERE attempt_id=$1 ORDER BY task_id', [fixture.trusted.identity.attemptId]),
  ]);
  const expectUnchangedEvidence = async (before: Awaited<ReturnType<typeof readEvidence>>) => {
    const after = await readEvidence();
    for (const [index, result] of after.entries()) {
      expect(result.rows).toHaveLength(before[index].rows.length);
      for (const [rowIndex, row] of result.rows.entries()) {
        const { payload: beforePayload, ...beforeMetadata } = before[index].rows[rowIndex];
        const { payload: afterPayload, ...afterMetadata } = row;
        expect(Buffer.from(afterPayload, 'utf8').equals(Buffer.from(beforePayload, 'utf8'))).toBe(true);
        expect(afterMetadata).toEqual(beforeMetadata);
      }
    }
  };
  const installHistoricalSchema = async (bounds: Parameters<typeof historicalLedgerSql>[0] = {}) => {
    if (!ownedSchema.test(schema)) throw new Error('Historical fixture schema ownership invalid');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_ID]);
      await client.query('DROP TABLE composed_task_outcomes; DROP TABLE composed_task_plans');
      await client.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`);
      // A real schema gate records the exact installed historical fixture DDL;
      // this is not a fabricated marker or a claim of a full old-image receipt.
      await applySchemaOnce(client, [historicalLedgerSql(bounds)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    const checks = await readChecks();
    expect(checks.filter(check => check.conname.endsWith('_byte_length_check'))).toHaveLength(0);
    expect(checks.filter(check => check.definition.includes('octet_length(payload)'))
      .map(check => check.conname).sort()).toEqual(['composed_task_outcomes_check', 'composed_task_plans_check']);
    expect(await readMarkers()).toHaveLength(1);
  };
  const removeOwnedEvidence = () => pool.query('DELETE FROM composed_task_plans WHERE attempt_id=$1',
    [fixture.trusted.identity.attemptId]);
  const insertPlanBytes = async (bytes?: number, taskCount = 1) => {
    const body = { version: 'ComposedTaskLedger.v1', identity: { attemptId: fixture.trusted.identity.attemptId },
      tasks: Array.from({ length: taskCount }, (_, index) => ({ id: `task-${index}` })) };
    const payload = bytes ? jsonAtByteLength(body, bytes) : JSON.stringify(body);
    return pool.query(`INSERT INTO composed_task_plans (attempt_id,content_digest,payload,byte_length,task_count)
      VALUES ($1,$2,$3,$4,$5)`, [fixture.trusted.identity.attemptId, 'a'.repeat(64), payload,
      Buffer.byteLength(payload, 'utf8'), taskCount]);
  };
  const insertOutcomeBytes = async (bytes?: number, index = 0) => {
    const body = { version: 'ComposedTaskOutcome.v1', planDigest: 'a'.repeat(64), taskId: 'task-0', status: 'blocked' };
    const payload = bytes ? jsonAtByteLength(body, bytes) : JSON.stringify(body);
    return pool.query(`INSERT INTO composed_task_outcomes
      (attempt_id,plan_digest,task_id,task_index,status,content_digest,payload,byte_length)
      VALUES ($1,$2,'task-0',$3,'blocked',$4,$5,$6)`, [fixture.trusted.identity.attemptId, 'a'.repeat(64),
      index, 'b'.repeat(64), payload, Buffer.byteLength(payload, 'utf8')]);
  };
  const replacedBoundNames = new Set(['composed_task_plans_check', 'composed_task_outcomes_check',
    'composed_task_plans_byte_length_check', 'composed_task_outcomes_byte_length_check',
    'composed_task_plans_task_count_check', 'composed_task_outcomes_task_index_check']);
  const unrelatedChecks = (checks: Awaited<ReturnType<typeof readChecks>>) =>
    checks.filter(check => !replacedBoundNames.has(check.conname));

  it('upgrades the historical inline schema through actual bootstrap without changing unrelated CHECKs', async () => {
    try {
      await installHistoricalSchema();
      await insertPlanBytes(); await insertOutcomeBytes();
      const before = await readChecks();
      const evidence = await readEvidence();
      await initializeStore();
      const after = await readChecks();
      expect(after.filter(check => ['composed_task_plans_check', 'composed_task_outcomes_check']
        .includes(check.conname))).toHaveLength(0);
      expect(after.filter(check => check.conname.endsWith('_byte_length_check'))).toHaveLength(2);
      expect(unrelatedChecks(after)).toEqual(unrelatedChecks(before));
      await expectUnchangedEvidence(evidence);
      const markers = await readMarkers();
      expect(markers).toHaveLength(2);
      await initializeStore();
      expect(await readChecks()).toEqual(after);
      expect(await readMarkers()).toEqual(markers);
      // Preserve the original positive SQL boundaries as well as the new
      // rollback proofs; these are not normalized aggregate-ledger positives.
      await removeOwnedEvidence();
      await expect(insertPlanBytes(MAX_COMPOSED_LEDGER_BYTES, MAX_TASKS_HARD_CAP)).resolves.toMatchObject({ rowCount: 1 });
      await expect(insertOutcomeBytes(MAX_COMPOSED_LEDGER_BYTES, MAX_TASKS_HARD_CAP - 1)).resolves.toMatchObject({ rowCount: 1 });
    } finally { await removeOwnedEvidence(); await initializeStore(); }
  });

  it.each(['plans', 'outcomes'] as const)('retires the narrower historical %s byte guard and accepts the current boundary', async table => {
    try {
      await installHistoricalSchema({ planBytes: MAX_COMPOSED_LEDGER_BYTES - 1,
        outcomeBytes: MAX_COMPOSED_LEDGER_BYTES - 1 });
      if (table === 'outcomes') await insertPlanBytes();
      const insertBoundary = () => table === 'plans'
        ? insertPlanBytes(MAX_COMPOSED_LEDGER_BYTES) : insertOutcomeBytes(MAX_COMPOSED_LEDGER_BYTES);
      await expect(insertBoundary()).rejects.toMatchObject({ code: '23514', constraint: `composed_task_${table}_check` });
      const before = await readChecks();
      await initializeStore();
      await expect(insertBoundary()).resolves.toMatchObject({ rowCount: 1 });
      const after = await readChecks();
      expect(after.filter(check => ['composed_task_plans_check', 'composed_task_outcomes_check']
        .includes(check.conname))).toHaveLength(0);
      expect(unrelatedChecks(after)).toEqual(unrelatedChecks(before));
      expect(await readMarkers()).toHaveLength(2);
    } finally { await removeOwnedEvidence(); await initializeStore(); }
  });

  it.each([
    ['plan bytes', 'composed_task_plans_byte_length_check'],
    ['plan task count', 'composed_task_plans_task_count_check'],
    ['outcome bytes', 'composed_task_outcomes_byte_length_check'],
    ['outcome task index', 'composed_task_outcomes_task_index_check'],
  ] as const)('rejects historical invalid %s with exact schema/marker/evidence rollback', async (shape, constraint) => {
    try {
      await installHistoricalSchema({ planBytes: MAX_COMPOSED_LEDGER_BYTES + 1,
        outcomeBytes: MAX_COMPOSED_LEDGER_BYTES + 1, planTasks: MAX_TASKS_HARD_CAP + 1,
        outcomeIndex: MAX_TASKS_HARD_CAP });
      await insertPlanBytes(shape === 'plan bytes' ? MAX_COMPOSED_LEDGER_BYTES + 1 : undefined,
        shape === 'plan task count' ? MAX_TASKS_HARD_CAP + 1 : 1);
      await insertOutcomeBytes(shape === 'outcome bytes' ? MAX_COMPOSED_LEDGER_BYTES + 1 : undefined,
        shape === 'outcome task index' ? MAX_TASKS_HARD_CAP : 0);
      const checks = await readChecks();
      const markers = await readMarkers();
      const evidence = await readEvidence();
      for (const result of evidence) expect(result.rows).toHaveLength(1);
      await expect(initializeStore()).rejects.toMatchObject({ code: '23514', constraint });
      // Exact OIDs/definitions prove earlier retirements and replacements also
      // roll back when the last outcome-index CHECK is the failing operation.
      expect(await readChecks()).toEqual(checks);
      expect(await readMarkers()).toEqual(markers);
      await expectUnchangedEvidence(evidence);
    } finally {
      await removeOwnedEvidence();
      await initializeStore();
      expect(await counts()).toEqual({ plans: 0, outcomes: 0 });
      expect(await readMarkers()).toHaveLength(2);
    }
  });

  it.each([
    ['plans', 'unrelated'],
    ['outcomes', 'unrelated'],
    ['plans', 'altered arithmetic'],
    ['outcomes', 'altered arithmetic'],
    ['plans', 'weakened OR'],
    ['outcomes', 'weakened OR'],
  ] as const)('fails closed on %s legacy byte name with %s shape', async (table, shape) => {
    const name = `composed_task_${table}_check`;
    const expression = shape === 'unrelated' ? "payload <> ''"
      : shape === 'altered arithmetic'
        ? `byte_length > 0 AND byte_length <= ${MAX_COMPOSED_LEDGER_BYTES} AND byte_length + 0 = octet_length(payload)`
        : `(byte_length > 0 AND byte_length <= ${MAX_COMPOSED_LEDGER_BYTES} AND byte_length = octet_length(payload)) OR byte_length = 1`;
    try {
      await installHistoricalSchema();
      await pool.query(`ALTER TABLE composed_task_${table} DROP CONSTRAINT ${name};
        ALTER TABLE composed_task_${table} ADD CONSTRAINT ${name} CHECK (${expression})`);
      await insertPlanBytes(); await insertOutcomeBytes();
      const checks = await readChecks();
      const markers = await readMarkers();
      const evidence = await readEvidence();
      await expect(initializeStore()).rejects.toMatchObject({ code: '23514', constraint: name });
      expect(await readChecks()).toEqual(checks);
      expect(await readMarkers()).toEqual(markers);
      await expectUnchangedEvidence(evidence);
    } finally {
      await removeOwnedEvidence();
      // Undo only the owned malformed fixture AFTER proving fail-closed rollback.
      await pool.query(`ALTER TABLE composed_task_${table} DROP CONSTRAINT ${name};
        ALTER TABLE composed_task_${table} ADD CONSTRAINT ${name} CHECK (byte_length > 0
          AND byte_length <= ${MAX_COMPOSED_LEDGER_BYTES} AND byte_length = octet_length(payload))`);
      await initializeStore();
    }
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
      await waitPastDeadline(pool, deadline);
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
      await waitPastDeadline(pool, deadline);
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
      await waitPastDeadline(pool, deadline);
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
