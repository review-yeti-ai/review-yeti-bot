import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresReviewEventSnapshotStore } from '../../src/events/reviewEventSnapshot';
import { PostgresStore } from '../../src/persistence/postgresStore';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const suite = databaseUrl ? describe : describe.skip;
const runId = `run_${'a'.repeat(32)}`;
const foreignRun = `run_${'b'.repeat(32)}`;

suite('snapshot through a real PostgreSQL SELECT-only role', () => {
  const suffix = randomBytes(8).toString('hex');
  const schema = `review_snapshot_${suffix}`;
  const readerRole = `review_snapshot_reader_${suffix}`;
  const readerPassword = randomBytes(24).toString('hex');
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
    // Only the test setup may initialize schema, using the real production
    // migrations. The snapshot implementation gets a separate SELECT-only pool.
    const migrationStore = new PostgresStore();
    const configured = vi.spyOn(migrationStore, 'isConfigured').mockReturnValue(true);
    const pool = vi.spyOn(migrationStore, 'getPool').mockReturnValue(admin);
    try { await migrationStore.initialize(); }
    finally { configured.mockRestore(); pool.mockRestore(); }
    // Generated hex password also exercises password-auth CI servers; the
    // loopback development fixture's trust mode is not a test prerequisite.
    await admin.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}';
      GRANT USAGE ON SCHEMA ${schema} TO ${readerRole};
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${readerRole};`);
    for (const [id, repositoryId] of [[runId, 123], [foreignRun, 999]]) {
      await admin.query(`INSERT INTO review_runs
        (run_id,repository_id,owner,repo,pr_number,base_sha,head_sha,status,stage,attempt,failure_diagnostics,error_text,
         identity_digest,snapshot_digest,config_digest,effective_policy_digest,effective_config_digest,identity)
        VALUES ($1,$2,'example','service',42,$3,$4,'failed','review',0,$5,'private-error',
          $6,repeat('e',64),repeat('e',64),repeat('e',64),repeat('e',64),'{}')`,
      [id, repositoryId, 'c'.repeat(40), 'd'.repeat(40), { failureClass: 'provider_error', logTail: 'private-log' },
        createHash('sha256').update(String(id)).digest('hex')]);
    }
    await admin.query('INSERT INTO review_event_sequence_counters (run_id,next_sequence) VALUES ($1, 9)', [runId]);
    await admin.query(`INSERT INTO review_gate_attempts
      (attempt_id,run_id,repository_id,pr_number,check_id,expected_app_id,desired_state,desired_version,
       published_version,decision,current_attempt,review_generation,execution_attempt,coordinates,external_id,creation_state)
      VALUES ($1,$2,123,42,456,4385771,'failure',2,1,$3,true,0,1,'{}','snapshot-gate','bound')`,
    [`${runId}-g0-e1`, runId, { reason: 'infrastructure-failure', private: 'hidden' }]);
    // A mismatched completion must not leak into the run snapshot.
    await admin.query(`INSERT INTO review_completion_outbox
      (completion_id,run_id,repository_id,pr_number,base_sha,head_sha,status,validation_request_id,
       repository,attempt_id,policy_digest)
      VALUES ('foreign-completion',$1,999,42,$2,$3,'completed','foreign-validation',
        'example/service','foreign-attempt',repeat('e',64))`,
    [runId, 'c'.repeat(40), 'd'.repeat(40)]);
    url.username = readerRole;
    url.password = readerPassword;
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

  it('projects the production dispatcher terminal state and supersession diagnostic through the read role', async () => {
    await admin.query(`UPDATE review_runs SET status='terminal', stage='terminal',
      failure_diagnostics=$2::jsonb WHERE run_id=$1`, [foreignRun,
      { failureClass: 'internal_error', reason: 'superseded_publisher_owned_check', logTail: 'private-diagnostic' }]);
    const snapshot = await store.getSnapshot(foreignRun, { repositoryIds: [999] });
    expect(snapshot).toMatchObject({ status: 'terminal', stage: 'terminal', terminalClass: 'superseded' });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|failure_diagnostics|logTail/);
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
