import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresReviewRunRepository,
  type ReviewRunIdentity,
} from '../../src/persistence/reviewRunRepository';
import { reviewDispatchPrLockKey } from '../../src/persistence/reviewCiPersistence';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';
import { sha256 } from '../../src/review/reviewCore';

const databaseUrl = (process.env.REVIEW_YETI_TEST_DATABASE_URL ||
  'postgresql://review_test@127.0.0.1:55493/review_test').trim();
const LIFECYCLE_OPTIONS = { lifecycleEvents: 'enabled' as const };
const REPOSITORY_ID = 123;
const POLICY_DIGEST = 'd'.repeat(64);
const RECEIVED_AT = 1_000;

let pool: Pool;
let schema: string;

const baseIdentity: ReviewRunIdentity = {
  owner: 'calltelemetry',
  repo: 'review-yeti',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: POLICY_DIGEST,
};

function identity(overrides: Partial<ReviewRunIdentity> = {}): ReviewRunIdentity {
  return { ...baseIdentity, ...overrides };
}

function digestFor(stage: string): string {
  return `${stage}-${'a'.repeat(Math.max(1, 64 - stage.length - 1))}`;
}

async function lifecycleEvents(runId: string): Promise<Array<{
  eventKind: string;
  sequence: number;
  data: Record<string, unknown>;
}>> {
  const result = await pool.query(`SELECT event_kind, sequence, payload->'data' AS data
    FROM review_event_outbox WHERE run_id = $1 ORDER BY sequence`, [runId]);
  return result.rows.map((row) => ({
    eventKind: row.event_kind,
    sequence: Number(row.sequence),
    data: row.data,
  }));
}

async function runState(runId: string): Promise<Record<string, unknown>> {
  return (await pool.query(`SELECT status, stage, attempt, repository_id, lease_owner,
    lease_expires_at, error_text, result_digest FROM review_runs WHERE run_id = $1`, [runId])).rows[0];
}

async function insertExpiredRuns(runs: Array<{
  runId: string;
  prNumber: number;
  status?: 'running' | 'publishing';
  leaseExpiresAt?: number;
}>): Promise<void> {
  const values: unknown[] = [];
  const placeholders = runs.map((run, index) => {
    const offset = index * 20;
    const runIdentity = identity({ prNumber: run.prNumber });
    values.push(
      run.runId, sha256(runIdentity), runIdentity.owner, runIdentity.repo, run.prNumber,
      runIdentity.headSha, runIdentity.baseSha, runIdentity.snapshotDigest, runIdentity.configDigest,
      POLICY_DIGEST, POLICY_DIGEST, JSON.stringify(runIdentity), REPOSITORY_ID,
      run.status || 'running', 'admission', 0, '{}',
      new Date(run.leaseExpiresAt ?? 0), new Date(RECEIVED_AT), new Date(RECEIVED_AT),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5},
      $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10},
      $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15},
      $${offset + 16}, $${offset + 17}::jsonb, $${offset + 18}, $${offset + 19}, $${offset + 20})`;
  });
  await pool.query(`INSERT INTO review_runs
    (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha, snapshot_digest,
     config_digest, effective_policy_digest, effective_config_digest, identity, repository_id,
     status, stage, attempt, artifacts, lease_expires_at, created_at, updated_at)
    VALUES ${placeholders.join(',')}`, values);
}

async function advanceToPublish(
  repository: PostgresReviewRunRepository,
  runId: string,
  workerId: string,
  now: number,
): Promise<void> {
  const transitions = [
    ['admission', 'snapshot'],
    ['snapshot', 'config'],
    ['config', 'submodules'],
    ['submodules', 'review'],
    ['review', 'arbiter'],
    ['arbiter', 'publish'],
  ] as const;
  for (const [stage, nextStage] of transitions) {
    await repository.recordArtifact(runId, stage, digestFor(stage), workerId, now);
    await repository.transition(runId, nextStage, workerId, now);
  }
  await repository.recordArtifact(runId, 'publish', 'f'.repeat(64), workerId, now);
}

describe('PostgresReviewRunRepository legacy lifecycle events', () => {
  beforeAll(async () => {
    schema = `review_run_lifecycle_test_${randomBytes(8).toString('hex')}`;
    if (!/^review_run_lifecycle_test_[a-f0-9]{16}$/u.test(schema)) {
      throw new Error('Generated schema is not owned by this test');
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id VARCHAR(255) PRIMARY KEY,
      identity_digest VARCHAR(64) UNIQUE NOT NULL,
      owner VARCHAR(255) NOT NULL,
      repo VARCHAR(255) NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha VARCHAR(40) NOT NULL,
      base_sha VARCHAR(40) NOT NULL,
      snapshot_digest VARCHAR(64) NOT NULL,
      config_digest VARCHAR(64) NOT NULL,
      effective_policy_digest VARCHAR(64) NOT NULL,
      effective_config_digest VARCHAR(64) NOT NULL,
      index_epoch BIGINT NOT NULL DEFAULT 0,
      identity JSONB NOT NULL,
      repository_id BIGINT,
      status VARCHAR(32) NOT NULL,
      stage VARCHAR(32) NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner VARCHAR(255),
      lease_expires_at TIMESTAMPTZ,
      publication_fence VARCHAR(64),
      result_digest VARCHAR(64),
      artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE review_dispatch_outbox (
      run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
      execution_attempt INTEGER NOT NULL DEFAULT 0
    )`);
    await pool.query(REVIEW_EVENT_SCHEMA_SQL);
    await pool.query(REVIEW_EVENT_SCHEMA_SQL);
  });

  afterEach(async () => {
    await pool.query('TRUNCATE review_event_outbox, review_event_sequence_counters, review_dispatch_outbox, review_runs CASCADE');
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (!/^review_run_lifecycle_test_[a-f0-9]{16}$/u.test(schema)) {
        throw new Error(`Refusing to drop unowned schema: ${schema}`);
      }
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('records admission and queue exactly once for an enabled create and exact redelivery', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const first = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    const duplicate = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT + 1_000 });
    await expect(repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID + 1, now: RECEIVED_AT + 2_000 }))
      .rejects.toThrow(/conflicting.*repository binding/i);

    expect(duplicate.runId).toBe(first.runId);
    expect(duplicate.repositoryId).toBe(REPOSITORY_ID);
    expect(await lifecycleEvents(first.runId)).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: POLICY_DIGEST, stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: POLICY_DIGEST, stage: 'queued' } },
    ]);
    expect((await pool.query('SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [first.runId])).rows[0])
      .toEqual({ next_sequence: '2' });
  });

  it('requires the trusted repository binding and never invents a historical one', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    await expect(repository.createOrGet({ identity: identity(), now: RECEIVED_AT })).rejects.toThrow(/repository id/i);

    const historicalId = 'run_historical_without_repository_id';
    await pool.query(`INSERT INTO review_runs (run_id, identity_digest, owner, repo, pr_number,
      head_sha, base_sha, snapshot_digest, config_digest, effective_policy_digest,
      effective_config_digest, identity, status, stage, attempt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9, $10, 'queued', 'admission', 0)`, [
      historicalId, sha256(baseIdentity), baseIdentity.owner, baseIdentity.repo, baseIdentity.prNumber,
      baseIdentity.headSha, baseIdentity.baseSha, baseIdentity.snapshotDigest, POLICY_DIGEST,
      JSON.stringify(baseIdentity),
    ]);
    const historical = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    expect(historical.runId).toBe(historicalId);
    expect(historical.repositoryId).toBeUndefined();
    expect(await lifecycleEvents(historicalId)).toEqual([]);
    await expect(repository.claim(historicalId, 'worker-a', RECEIVED_AT + 1_000, 10_000))
      .rejects.toThrow(/metadata is incomplete/i);
    expect(await lifecycleEvents(historicalId)).toEqual([]);
  });

  it('supersedes an old head before recording the new head admission, without letting old redelivery supersede the newer run', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const oldRun = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    const newRun = await repository.createOrGet({
      identity: identity({ headSha: 'e'.repeat(40), snapshotDigest: 'f'.repeat(64) }),
      repositoryId: REPOSITORY_ID,
      now: RECEIVED_AT + 1_000,
    });
    const redelivery = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT + 2_000 });

    expect(redelivery.runId).toBe(oldRun.runId);
    expect((await runState(oldRun.runId)).status).toBe('superseded');
    expect((await runState(newRun.runId)).status).toBe('queued');
    expect(await lifecycleEvents(oldRun.runId)).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: POLICY_DIGEST, stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: POLICY_DIGEST, stage: 'queued' } },
      { eventKind: 'review.lifecycle.superseded', sequence: 3,
        data: { policy_digest: POLICY_DIGEST, stage: 'superseded', terminal_class: 'candidate_superseded' } },
    ]);
    expect(await lifecycleEvents(newRun.runId)).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: POLICY_DIGEST, stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: POLICY_DIGEST, stage: 'queued' } },
    ]);
  });

  it('records a real claim and stage transition but not a heartbeat or artifact write', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const run = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });

    await expect(repository.claim(run.runId, 'worker-a', RECEIVED_AT + 1_000, 10_000)).resolves.toMatchObject({
      status: 'running', attempt: 1, leaseOwner: 'worker-a',
    });
    await expect(repository.claim(run.runId, 'worker-a', RECEIVED_AT + 2_000, 10_000)).resolves.toMatchObject({
      status: 'running', attempt: 1, leaseOwner: 'worker-a',
    });
    await expect(repository.heartbeat(run.runId, 'worker-a', RECEIVED_AT + 3_000, 10_000)).resolves.toBe(true);
    await repository.recordArtifact(run.runId, 'admission', digestFor('admission'), 'worker-a', RECEIVED_AT + 4_000);
    await repository.transition(run.runId, 'snapshot', 'worker-a', RECEIVED_AT + 5_000);

    expect(await lifecycleEvents(run.runId)).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: POLICY_DIGEST, stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: POLICY_DIGEST, stage: 'queued' } },
      { eventKind: 'review.lifecycle.started', sequence: 3,
        data: { policy_digest: POLICY_DIGEST, stage: 'started' } },
      { eventKind: 'review.lifecycle.started', sequence: 4,
        data: { policy_digest: POLICY_DIGEST, stage: 'snapshot' } },
    ]);
  });

  it('records publication claim and success with a stable success terminal class', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const run = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await repository.claim(run.runId, 'worker-a', RECEIVED_AT + 1_000, 30_000);
    await advanceToPublish(repository, run.runId, 'worker-a', RECEIVED_AT + 2_000);

    const publication = await repository.claimPublication(run.runId, 'worker-a', RECEIVED_AT + 3_000);
    expect(publication).toMatchObject({ status: 'publishing', publicationFence: expect.any(String) });
    const duplicatePublication = await repository.claimPublication(run.runId, 'worker-a', RECEIVED_AT + 3_500);
    expect(duplicatePublication?.publicationFence).toBe(publication?.publicationFence);
    await repository.succeed(run.runId, 'worker-a', RECEIVED_AT + 4_000, 'f'.repeat(64));

    const events = await lifecycleEvents(run.runId);
    expect(events.at(-2)).toEqual({ eventKind: 'review.lifecycle.gate_publication', sequence: events.length - 1,
      data: { policy_digest: POLICY_DIGEST, stage: 'gate_publication', terminal_class: 'claimed' } });
    expect(events.at(-1)).toEqual({ eventKind: 'review.lifecycle.terminal', sequence: events.length,
      data: { policy_digest: POLICY_DIGEST, stage: 'complete', terminal_class: 'success', result_digest: 'f'.repeat(64) } });
    expect(events.filter((event) => event.eventKind === 'review.lifecycle.started').map((event) => event.data.stage))
      .toEqual(['started', 'snapshot', 'config', 'submodules', 'review', 'arbiter', 'publish']);
    expect(events.some((event) => JSON.stringify(event.data).includes('worker-a'))).toBe(false);
    expect(events.some((event) => JSON.stringify(event.data).includes('artifact'))).toBe(false);
    await expect(repository.succeed(run.runId, 'worker-a', RECEIVED_AT + 5_000, 'f'.repeat(64)))
      .rejects.toThrow(/cannot succeed/i);
    expect(await lifecycleEvents(run.runId)).toEqual(events);
  });

  it('records failure, requeue, cancellation, and stale callbacks without raw diagnostics or extra events', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const failed = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await repository.claim(failed.runId, 'worker-a', RECEIVED_AT + 1_000, 30_000);
    await repository.fail(failed.runId, 'worker-a', RECEIVED_AT + 2_000, 'raw provider response must stay out of events');
    const failureEvents = await lifecycleEvents(failed.runId);
    expect(failureEvents.at(-1)).toEqual({ eventKind: 'review.lifecycle.terminal', sequence: 4,
      data: { policy_digest: POLICY_DIGEST, stage: 'terminal', terminal_class: 'failure' } });
    expect(JSON.stringify(failureEvents)).not.toContain('raw provider');

    const requeued = await repository.createOrGet({ identity: identity({ prNumber: 43, headSha: 'c'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await repository.claim(requeued.runId, 'worker-a', RECEIVED_AT + 1_000, 30_000);
    await repository.requeue(requeued.runId, 'worker-a', RECEIVED_AT + 2_000, 'transient raw error');
    await repository.claim(requeued.runId, 'worker-b', RECEIVED_AT + 3_000, 30_000);
    const requeueEvents = await lifecycleEvents(requeued.runId);
    expect(requeueEvents.map((event) => event.eventKind)).toEqual([
      'review.lifecycle.admission', 'review.lifecycle.queued', 'review.lifecycle.started',
      'review.lifecycle.retrying', 'review.lifecycle.started',
    ]);
    expect(JSON.stringify(requeueEvents)).not.toContain('transient raw error');

    const cancelled = await repository.createOrGet({ identity: identity({ prNumber: 44, headSha: 'f'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await expect(repository.cancel(cancelled.runId, RECEIVED_AT + 1_000, 'raw cancellation reason')).resolves.toMatchObject({ status: 'cancelled' });
    expect((await lifecycleEvents(cancelled.runId)).at(-1)).toEqual({ eventKind: 'review.lifecycle.terminal', sequence: 3,
      data: { policy_digest: POLICY_DIGEST, stage: 'terminal', terminal_class: 'cancelled' } });

    const beforeStale = await lifecycleEvents(failed.runId);
    await expect(repository.fail(failed.runId, 'late-worker', RECEIVED_AT + 3_000, 'stale raw error')).rejects.toThrow(/cannot fail/i);
    await expect(repository.cancel(failed.runId, RECEIVED_AT + 3_000, 'stale cancellation')).resolves.toBeNull();
    expect(await lifecycleEvents(failed.runId)).toEqual(beforeStale);

    const staleLease = await repository.createOrGet({ identity: identity({ prNumber: 45, headSha: 'e'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await repository.claim(staleLease.runId, 'worker-a', RECEIVED_AT, 100);
    const beforeLeaseExpiry = await lifecycleEvents(staleLease.runId);
    await expect(repository.heartbeat(staleLease.runId, 'worker-a', RECEIVED_AT + 1_000, 10_000)).resolves.toBe(false);
    expect(await lifecycleEvents(staleLease.runId)).toEqual(beforeLeaseExpiry);
  });

  it('reaps a bounded set, retries running leases, and marks publication expiry as unknown', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const running = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await repository.claim(running.runId, 'worker-a', RECEIVED_AT, 100);

    const publishing = await repository.createOrGet({ identity: identity({ prNumber: 43, headSha: 'c'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await repository.claim(publishing.runId, 'worker-a', RECEIVED_AT + 1_000, 30_000);
    await advanceToPublish(repository, publishing.runId, 'worker-a', RECEIVED_AT + 2_000);
    await repository.claimPublication(publishing.runId, 'worker-a', RECEIVED_AT + 3_000);
    await pool.query(`UPDATE review_runs SET lease_expires_at = to_timestamp($2 / 1000.0)
      WHERE run_id = $1`, [publishing.runId, RECEIVED_AT + 50]);

    expect(await repository.reapExpiredLeases(RECEIVED_AT + 1_000)).toBe(2);
    expect(await runState(running.runId)).toMatchObject({ status: 'queued', lease_owner: null });
    expect(await runState(publishing.runId)).toMatchObject({ status: 'failed', lease_owner: null });
    expect((await lifecycleEvents(running.runId)).at(-1)).toEqual({ eventKind: 'review.lifecycle.retrying', sequence: 4,
      data: { policy_digest: POLICY_DIGEST, stage: 'admission', retry_class: 'lease_reaper' } });
    expect((await lifecycleEvents(publishing.runId)).at(-1)).toEqual({ eventKind: 'review.lifecycle.terminal', sequence: 11,
      data: { policy_digest: POLICY_DIGEST, stage: 'terminal', terminal_class: 'unknown', retry_class: 'lease_reaper' } });
  });

  it('caps one reaper transaction at its bounded batch size', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const runs = Array.from({ length: 101 }, (_, index) => ({
      runId: `bounded-reaper-${index}`,
      prNumber: 1_000 + index,
    }));
    await insertExpiredRuns(runs);

    expect(await repository.reapExpiredLeases(RECEIVED_AT + 1_000)).toBe(100);
    expect((await pool.query(`SELECT status, COUNT(*)::int AS count FROM review_runs
      WHERE owner = $1 GROUP BY status ORDER BY status`, [baseIdentity.owner])).rows)
      .toEqual(expect.arrayContaining([{ status: 'queued', count: 100 }, { status: 'running', count: 1 }]));
  });

  it('uses a nonblocking PR try-lock and revalidates after contention clears', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const runId = 'busy-reaper-run';
    const prNumber = 60;
    await insertExpiredRuns([{ runId, prNumber }]);

    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [reviewDispatchPrLockKey(REPOSITORY_ID, prNumber)]);
      expect(await repository.reapExpiredLeases(RECEIVED_AT + 1_000)).toBe(0);
      expect((await runState(runId)).status).toBe('running');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    expect(await repository.reapExpiredLeases(RECEIVED_AT + 1_000)).toBe(1);
    expect((await runState(runId)).status).toBe('queued');
  });

  it('rolls back the run mutation and event counter when the lifecycle append fails', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const run = await repository.createOrGet({ identity: identity(), repositoryId: REPOSITORY_ID, now: RECEIVED_AT });
    await pool.query(`ALTER TABLE review_event_outbox ADD CONSTRAINT reject_started_event
      CHECK (COALESCE(payload->'data'->>'stage', '') <> 'started')`);
    try {
      await expect(repository.claim(run.runId, 'worker-a', RECEIVED_AT + 1_000, 30_000)).rejects.toThrow(/reject_started_event/i);
      expect(await runState(run.runId)).toMatchObject({ status: 'queued', attempt: 0, lease_owner: null });
      expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_outbox WHERE run_id = $1', [run.runId])).rows[0].count)
        .toBe(2);
      expect((await pool.query('SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [run.runId])).rows[0].next_sequence)
        .toBe('2');
    } finally {
      await pool.query('ALTER TABLE review_event_outbox DROP CONSTRAINT reject_started_event');
    }
  });

  it('serializes concurrent admissions by PR while allowing independent PRs to complete', async () => {
    const repository = new PostgresReviewRunRepository(pool, LIFECYCLE_OPTIONS);
    const admissions = await Promise.all([
      repository.createOrGet({ identity: identity({ headSha: '1'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT }),
      repository.createOrGet({ identity: identity({ headSha: '2'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT + 1 }),
      repository.createOrGet({ identity: identity({ prNumber: 43, headSha: '3'.repeat(40) }), repositoryId: REPOSITORY_ID, now: RECEIVED_AT + 2 }),
    ]);
    const samePr = admissions.filter((run) => run.identity.prNumber === 42);
    expect(samePr).toHaveLength(2);
    expect((await pool.query(`SELECT status, COUNT(*)::int AS count FROM review_runs
      WHERE repository_id = $1 AND pr_number = 42 GROUP BY status ORDER BY status`, [REPOSITORY_ID])).rows)
      .toEqual(expect.arrayContaining([{ status: 'queued', count: 1 }, { status: 'superseded', count: 1 }]));
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM review_event_outbox
      WHERE repository_id = $1 AND pr_number = 43`, [REPOSITORY_ID])).rows[0].count).toBe(2);
  });
});
