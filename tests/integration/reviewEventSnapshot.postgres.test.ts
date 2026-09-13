import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresReviewEventSnapshotStore } from '../../src/events/reviewEventSnapshot';

const databaseUrl = process.env.REVIEW_YETI_SNAPSHOT_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const runId = `run_${'a'.repeat(32)}`;
const foreignRun = `run_${'b'.repeat(32)}`;

suite('snapshot through a real PostgreSQL SELECT-only role', () => {
  const suffix = randomBytes(8).toString('hex');
  const schema = `review_snapshot_${suffix}`;
  const readerRole = `review_snapshot_reader_${suffix}`;
  let admin: Pool;
  let reader: Pool;
  let store: PostgresReviewEventSnapshotStore;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Snapshot role fixture requires a loopback test database');
    }
    admin = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await admin.query(`CREATE SCHEMA ${schema}`);
    // Minimal projections of the production migrations, including real BIGINT,
    // JSONB and timestamp decoding. The application under test issues its actual
    // parameterized query through a role unable to mutate these tables.
    await admin.query(`CREATE TABLE review_runs (
      run_id text PRIMARY KEY, repository_id bigint NOT NULL, owner text, repo text, pr_number int,
      base_sha text, head_sha text, status text, stage text, attempt int, result_digest text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      failure_diagnostics jsonb DEFAULT '{}', error_text text);
      CREATE TABLE review_event_sequence_counters (run_id text PRIMARY KEY, next_sequence bigint);
      CREATE TABLE review_gate_attempts (attempt_id text PRIMARY KEY, run_id text, repository_id bigint,
        pr_number int, check_id bigint, expected_app_id bigint, desired_state text, desired_version bigint,
        published_version bigint, decision jsonb, current_attempt boolean, review_generation int);
      CREATE TABLE review_completion_outbox (completion_id text PRIMARY KEY, run_id text, repository_id bigint,
        pr_number int, base_sha text, head_sha text, status text, validation_request_id text, created_at timestamptz DEFAULT now());
      CREATE ROLE ${readerRole} LOGIN;
      GRANT USAGE ON SCHEMA ${schema} TO ${readerRole};
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${readerRole};`);
    for (const [id, repositoryId] of [[runId, 123], [foreignRun, 999]]) {
      await admin.query(`INSERT INTO review_runs
        (run_id,repository_id,owner,repo,pr_number,base_sha,head_sha,status,stage,attempt,failure_diagnostics,error_text)
        VALUES ($1,$2,'example','service',42,$3,$4,'failed','review',0,$5,'private-error')`,
      [id, repositoryId, 'c'.repeat(40), 'd'.repeat(40), { failureClass: 'provider_error', logTail: 'private-log' }]);
    }
    await admin.query('INSERT INTO review_event_sequence_counters VALUES ($1, 9)', [runId]);
    await admin.query(`INSERT INTO review_gate_attempts VALUES
      ($1,$2,123,42,456,4385771,'failure',2,1,$3,true,0)`,
    [`${runId}-g0-e1`, runId, { reason: 'infrastructure-failure', private: 'hidden' }]);
    // A mismatched completion must not leak into the run snapshot.
    await admin.query(`INSERT INTO review_completion_outbox
      (completion_id,run_id,repository_id,pr_number,base_sha,head_sha,status,validation_request_id)
      VALUES ('foreign-completion',$1,999,42,$2,$3,'completed','foreign-validation')`,
    [runId, 'c'.repeat(40), 'd'.repeat(40)]);
    url.username = readerRole;
    url.password = '';
    reader = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema},public`, max: 2 });
    store = new PostgresReviewEventSnapshotStore(reader);
  });

  afterAll(async () => {
    if (reader) await reader.end();
    if (!admin) return;
    try {
      if (!/^review_snapshot_[a-f0-9]{16}$/u.test(schema)
        || !/^review_snapshot_reader_[a-f0-9]{16}$/u.test(readerRole)) throw new Error('Unowned fixture');
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${readerRole}`);
    } finally { await admin.end(); }
  });

  it('returns the authoritative failure and independent unpublished gate state without private text', async () => {
    const snapshot = await store.getSnapshot(runId, { repositoryIds: [123] });
    expect(snapshot).toMatchObject({ runId, lifecycleSequenceDomain: 'legacy_run_v1',
      lifecycleSequence: 9, terminalClass: 'provider_failure',
      completion: null, gate: { state: 'failure', published: false, reason: 'infrastructure-failure' } });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|hidden|foreign-validation/);
  });

  it('hides a foreign run and a missing run identically at the SQL boundary', async () => {
    expect(await store.getSnapshot(foreignRun, { repositoryIds: [123] })).toBeNull();
    expect(await store.getSnapshot(`run_${'f'.repeat(32)}`, { repositoryIds: [123] })).toBeNull();
    expect(await store.getSnapshot(foreignRun, { repositoryIds: [999] })).toMatchObject({ repositoryId: 999 });
  });

  it('proves the actual reader role cannot update state, allocate sequences, or bootstrap DDL', async () => {
    for (const sql of ['UPDATE review_runs SET status=\'succeeded\'',
      'INSERT INTO review_event_sequence_counters VALUES (\'forged\',999)',
      'CREATE TABLE forged_authority (id text)']) {
      await expect(reader.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect((await store.getSnapshot(runId, { repositoryIds: [123] }))?.status).toBe('failed');
  });
});
