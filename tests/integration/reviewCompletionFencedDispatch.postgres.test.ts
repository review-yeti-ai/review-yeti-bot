import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresReviewCompletionRepository,
  ReviewCompletionDispatchInDoubtError,
} from '../../src/persistence/reviewCompletionRepository';
import {
  ReviewCompletionDeliveryEngine,
  type CIRequestClientFactory,
} from '../../src/k8s/reviewCompletionDeliveryEngine';
import type { ReviewCIRequestPayload } from '../../src/github/reviewCIRequest';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';

/**
 * REL-1053: the completion engine must send the CI-request repository_dispatch
 * exactly once per completion while two dispatcher replicas share the outbox.
 *
 * Every race is driven by gates rather than timing: replica A is parked
 * mid-send (or mid-token-mint) while replica B runs a full cycle against the
 * same row with a clock that already sees A's lease as expired. That is the
 * two-replica case the old send-then-markDispatched sequence could not fence.
 */

const TEST_SCHEMA = 'test_rel1053_fenced_dispatch';
const DATABASE_URL = process.env.REVIEW_YETI_TEST_DATABASE_URL || 'postgres://localhost/postgres';
const LEASE_MS = 1_000;

interface Gate {
  entered: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}

function gate(): Gate {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { markEntered(); await released; } };
}

describe('REL-1053 fenced CI-request dispatch across dispatcher replicas', () => {
  let pool: Pool;
  let repository: PostgresReviewCompletionRepository;

  async function query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
    await query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await query(`
      CREATE TABLE IF NOT EXISTS review_runs (
        run_id TEXT PRIMARY KEY,
        repository_id BIGINT,
        pr_number INTEGER,
        base_sha TEXT,
        head_sha TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        effective_policy_digest TEXT
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS review_dispatch_outbox (
        run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
        execution_attempt INTEGER NOT NULL DEFAULT 0
      )`);
    // Column-for-column copy of the production table in postgresStore.ts.
    await query(`
      CREATE TABLE IF NOT EXISTS review_completion_outbox (
        completion_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
        delivery_id TEXT,
        repository_id BIGINT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        validation_request_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'dispatched', 'completed', 'error', 'superseded', 'terminal')),
        draft_deferred BOOLEAN NOT NULL DEFAULT FALSE,
        verdict TEXT,
        conclusion TEXT,
        lease_owner TEXT,
        lease_expires_at TIMESTAMP WITH TIME ZONE,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error_text TEXT
      )`);
    await query(REVIEW_EVENT_SCHEMA_SQL);

    const schemaPool = {
      connect: async () => {
        const client = await pool.connect();
        await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
        return client;
      },
      query: (text: string, values?: unknown[]) => query(text, values),
    };
    // Production mode: the dispatcher constructs this repository with lifecycle events enabled.
    repository = new PostgresReviewCompletionRepository(schemaPool, { lifecycleEvents: 'enabled' });
  });

  afterAll(async () => {
    if (!pool) return;
    await query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await query(`TRUNCATE TABLE review_completion_outbox, review_event_outbox,
      review_event_sequence_counters, review_dispatch_outbox, review_runs CASCADE`);
  });

  async function seedShipCompletion(runId: string): Promise<string> {
    await query(`INSERT INTO review_runs
      (run_id, repository_id, pr_number, base_sha, head_sha, attempt, effective_policy_digest)
      VALUES ($1, 123, 42, $2, $3, 0, $4)`, [runId, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)]);
    const record = await repository.recordCompletion({
      runId,
      repositoryId: 123,
      repository: 'calltelemetry/dashboard',
      prNumber: 42,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      attemptId: `${runId}-g0-e1`,
      policyDigest: `sha256:${'c'.repeat(64)}`,
      validationRequestId: `validation-42-${runId}`,
      verdict: 'SHIP',
      conclusion: 'success',
      availableAt: 1_000,
    });
    return record.completionId;
  }

  function replica(
    name: string,
    clock: () => number,
    sent: Array<{ replica: string; payload: ReviewCIRequestPayload }>,
    hooks: { beforeMint?: () => Promise<void>; duringSend?: (signal?: AbortSignal) => Promise<void> } = {},
    sendTimeoutMs?: number,
  ): ReviewCompletionDeliveryEngine {
    const clientFactory: CIRequestClientFactory = async () => {
      await hooks.beforeMint?.();
      return {
        emitCIRequest: async (_owner, _repo, payload, signal) => {
          await hooks.duringSend?.(signal);
          sent.push({ replica: name, payload });
        },
      };
    };
    return new ReviewCompletionDeliveryEngine({
      repository,
      clientFactory,
      workerId: `review-job-dispatcher:${name}:completion`,
      now: clock,
      leaseMs: LEASE_MS,
      ...(sendTimeoutMs === undefined ? {} : { sendTimeoutMs }),
    });
  }

  async function dispatchedEventCount(runId: string): Promise<number> {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM review_event_outbox
        WHERE run_id = $1 AND event_kind = 'review.lifecycle.dispatched'`, [runId]);
    return rows[0].count;
  }

  it('does not let a second replica reclaim and resend while the first replica is mid-send', async () => {
    const runId = 'run_rel1053_mid_send';
    const completionId = await seedShipCompletion(runId);
    const sent: Array<{ replica: string; payload: ReviewCIRequestPayload }> = [];
    const aSend = gate();

    // Replica A claims at t=10s with a 1s lease and parks inside the GitHub send.
    const replicaA = replica('pod-a', () => 10_000, sent, { duringSend: aSend.wait });
    const aCycle = replicaA.runOnce();
    await aSend.entered;

    // Replica B's clock is 10s later, so A's lease looks expired to it.
    const replicaB = replica('pod-b', () => 20_000, sent);
    const bOutcome = await replicaB.runOnce();

    aSend.release();
    const aOutcome = await aCycle;

    expect(sent.map((entry) => entry.replica)).toEqual(['pod-a']);
    expect(bOutcome).toEqual({ status: 'idle' });
    expect(aOutcome).toMatchObject({ status: 'dispatched', completionId });
    const { rows } = await query('SELECT status, lease_owner, attempt FROM review_completion_outbox WHERE completion_id = $1', [completionId]);
    expect(rows[0]).toEqual({ status: 'dispatched', lease_owner: null, attempt: 1 });
    expect(await dispatchedEventCount(runId)).toBe(1);
  });

  it('never sends from a replica whose claim was superseded before it reached the send', async () => {
    const runId = 'run_rel1053_superseded_claim';
    const completionId = await seedShipCompletion(runId);
    const sent: Array<{ replica: string; payload: ReviewCIRequestPayload }> = [];
    const aMint = gate();

    // Replica A claims, then stalls minting its installation token past its lease.
    const replicaA = replica('pod-a', () => 10_000, sent, { beforeMint: aMint.wait });
    const aCycle = replicaA.runOnce();
    await aMint.entered;

    // Replica B reclaims the expired lease and delivers.
    const bOutcome = await replica('pod-b', () => 20_000, sent).runOnce();
    expect(bOutcome).toMatchObject({ status: 'dispatched', completionId });

    aMint.release();
    const aOutcome = await aCycle;

    expect(sent.map((entry) => entry.replica)).toEqual(['pod-b']);
    expect(aOutcome).toEqual({ status: 'lease-lost', completionId });
    expect(await dispatchedEventCount(runId)).toBe(1);
  });

  it('delivers exactly once when many replicas race the same completion', async () => {
    const runId = 'run_rel1053_many_replicas';
    await seedShipCompletion(runId);
    const sent: Array<{ replica: string; payload: ReviewCIRequestPayload }> = [];

    // Staggered clocks: every later replica sees every earlier lease as expired.
    const outcomes = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      replica(`pod-${index}`, () => 10_000 + index * 5_000, sent, {
        duringSend: () => new Promise((resolve) => setTimeout(resolve, 50)),
      }).runOnce()));

    expect(sent).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'dispatched')).toHaveLength(1);
    expect(await dispatchedEventCount(runId)).toBe(1);
  });

  it('bounds the row lock: a hung send is aborted, rolled back, and retried by the claimant', async () => {
    const runId = 'run_rel1053_hung_send';
    const completionId = await seedShipCompletion(runId);
    const sent: Array<{ replica: string; payload: ReviewCIRequestPayload }> = [];

    const outcome = await replica('pod-a', () => 10_000, sent, {
      duringSend: (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }, 300).runOnce();

    expect(sent).toHaveLength(0);
    expect(outcome).toMatchObject({ status: 'retry', completionId, attempt: 1 });
    const { rows } = await query('SELECT status, lease_owner FROM review_completion_outbox WHERE completion_id = $1', [completionId]);
    expect(rows[0]).toEqual({ status: 'pending', lease_owner: null });
    expect(await dispatchedEventCount(runId)).toBe(0);
  });

  it('fences on the claim attempt, not only the lease owner', async () => {
    const runId = 'run_rel1053_attempt_fence';
    const completionId = await seedShipCompletion(runId);
    const worker = 'review-job-dispatcher:pod-a:completion';

    const first = await repository.claimNext(worker, 10_000, LEASE_MS);
    const second = await repository.claimNext(worker, 20_000, LEASE_MS);
    expect(first?.attempt).toBe(1);
    expect(second?.attempt).toBe(2);

    let sends = 0;
    const stale = await repository.dispatchFenced(completionId, worker, 1, 20_500, async () => { sends += 1; });
    expect(stale).toBe('lease-lost');
    expect(sends).toBe(0);

    const current = await repository.dispatchFenced(completionId, worker, 2, 20_500, async () => { sends += 1; });
    expect(current).toBe('dispatched');
    expect(sends).toBe(1);
  });

  it('reports a timed-out send as in doubt and leaves the claim for its owner to settle', async () => {
    const runId = 'run_rel1053_in_doubt';
    const completionId = await seedShipCompletion(runId);
    const worker = 'review-job-dispatcher:pod-a:completion';
    expect(await repository.claimNext(worker, 10_000, LEASE_MS)).not.toBeNull();

    // An abort can land after GitHub accepted the request, so it is not a clean failure.
    const error = await repository.dispatchFenced(completionId, worker, 1, 10_100, (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }), { maxHoldMs: 250 }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReviewCompletionDispatchInDoubtError);
    const { rows } = await query('SELECT status, lease_owner, attempt FROM review_completion_outbox WHERE completion_id = $1', [completionId]);
    expect(rows[0]).toEqual({ status: 'claimed', lease_owner: worker, attempt: 1 });
    expect(await dispatchedEventCount(runId)).toBe(0);
  });
});
