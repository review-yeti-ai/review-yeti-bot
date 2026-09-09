import { randomUUID } from 'node:crypto';
import { deriveReviewGateExternalId, REVIEW_GATE_CHECK_NAME, type ReviewGateCheck, type ReviewGateCoordinates } from '../github/reviewGateClient';

interface Queryable { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Client extends Queryable { release(): void }
interface Pool extends Queryable { connect(): Promise<Client> }

export type GateDesiredState = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'timed_out';
export interface StoredReviewGate {
  coordinates: ReviewGateCoordinates;
  reviewGeneration: number;
  expectedAppId: number;
  externalId: string;
  checkId: number | null;
  creationState: 'reserved' | 'creating' | 'bound';
  desiredState: GateDesiredState;
  desiredVersion: number;
  publishedVersion: number;
  current: boolean;
}
export interface GatePublicationClaim extends StoredReviewGate {
  leaseOwner: string;
  /** Fences a stale claim even when the same process identity reacquires it. */
  leaseToken: string;
  /** True only on the committed reserved -> creating transition. A retry with
   * no check ID must reconcile; absence after an uncertain POST is not proof
   * that GitHub rejected the creation. */
  mayCreate: boolean;
}

export function gateAttemptId(runId: string, generation: number, executionAttempt: number): string {
  if (!/^run_[a-f0-9]{32}$/u.test(runId)
    || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isSafeInteger(executionAttempt) || executionAttempt <= 0) throw new Error('Invalid gate attempt identity');
  return `${runId}-g${generation}-e${executionAttempt}`;
}

function fromRow(row: any): StoredReviewGate {
  return {
    coordinates: typeof row.coordinates === 'string' ? JSON.parse(row.coordinates) : row.coordinates,
    reviewGeneration: Number(row.review_generation), expectedAppId: Number(row.expected_app_id),
    externalId: row.external_id, checkId: row.check_id == null ? null : Number(row.check_id),
    creationState: row.creation_state, desiredState: row.desired_state,
    desiredVersion: Number(row.desired_version), publishedVersion: Number(row.published_version),
    current: row.current_attempt === true,
  };
}

/** Persistence boundary only. The service supplies trusted current GitHub truth
 * and policy; workers cannot reserve, create or select authoritative checks. */
export class PostgresReviewGateRepository {
  constructor(private readonly pool: Pool) {}

  /** Reserve the current durable dispatch's gate before its worker is projected.
   * Reuses admission's repository/PR lock; stale claims cannot supersede a newer
   * run, and retries of one generation cannot allocate another external ID. */
  async reserve(runId: string, expectedAppId: number, now = Date.now()): Promise<StoredReviewGate | null> {
    if (!/^run_[a-f0-9]{32}$/u.test(runId) || !Number.isSafeInteger(expectedAppId) || expectedAppId <= 0) {
      throw new Error('Invalid gate reservation identity');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Discover only the lock key without a row lock. Admission takes the
      // advisory lock before locking rows; reversing that order can deadlock.
      const lookup = await client.query('SELECT repository_id, pr_number FROM review_runs WHERE run_id = $1', [runId]);
      const key = lookup.rows[0];
      if (!key) { await client.query('COMMIT'); return null; }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`review-dispatch:${key.repository_id}:${key.pr_number}`]);
      const result = await client.query(`
        SELECT runs.*, outbox.execution_attempt + 1 AS worker_execution_attempt
          FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
         WHERE runs.run_id = $1 AND runs.publication_mode = 'app-gate'
           AND runs.status IN ('queued', 'running')
           AND outbox.status IN ('pending', 'claimed', 'projected')
         FOR UPDATE OF runs, outbox`, [runId]);
      const run = result.rows[0];
      if (!run) { await client.query('COMMIT'); return null; }
      const generation = Number(run.attempt);
      const executionAttempt = Number(run.worker_execution_attempt);
      const coordinates: ReviewGateCoordinates = {
        owner: run.owner, repo: run.repo, repositoryId: Number(run.repository_id),
        prNumber: Number(run.pr_number), headSha: run.head_sha, baseSha: run.base_sha,
        policyDigest: run.effective_policy_digest, runId, executionAttempt,
        attemptId: gateAttemptId(runId, generation, executionAttempt),
      };
      const externalId = deriveReviewGateExternalId(coordinates);
      // Supersession is a durable publication intent, not a best-effort PATCH.
      await client.query(`UPDATE review_gate_attempts SET current_attempt = false,
        desired_state = 'cancelled', desired_version = desired_version + 1,
        -- No external create has been attempted while reserved. Tombstone
        -- that intent locally; a late cancelled check must not be created after
        -- the newer same-head gate. Creating/bound intents still reconcile.
        published_version = CASE WHEN creation_state = 'reserved'
          THEN desired_version + 1 ELSE published_version END,
        available_at = to_timestamp($4 / 1000.0), updated_at = to_timestamp($4 / 1000.0)
        WHERE repository_id = $1 AND pr_number = $2 AND current_attempt AND attempt_id <> $3`,
      [coordinates.repositoryId, coordinates.prNumber, coordinates.attemptId, now]);
      const saved = await client.query(`INSERT INTO review_gate_attempts
        (attempt_id, run_id, review_generation, execution_attempt, repository_id, pr_number,
         expected_app_id, coordinates, external_id, available_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0),to_timestamp($10/1000.0),to_timestamp($10/1000.0))
        ON CONFLICT (attempt_id) DO UPDATE SET updated_at = review_gate_attempts.updated_at
        WHERE review_gate_attempts.coordinates = EXCLUDED.coordinates
          AND review_gate_attempts.expected_app_id = EXCLUDED.expected_app_id
          AND review_gate_attempts.current_attempt
        RETURNING *`, [coordinates.attemptId, runId, generation, executionAttempt,
        coordinates.repositoryId, coordinates.prNumber, expectedAppId, JSON.stringify(coordinates), externalId, now]);
      if (saved.rows.length !== 1) throw new Error('Gate reservation conflicts with persisted identity');
      await client.query('COMMIT');
      return fromRow(saved.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async claimPublication(workerId: string, now: number, leaseMs = 60_000): Promise<GatePublicationClaim | null> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000) {
      throw new Error('Invalid gate publication lease');
    }
    const result = await this.pool.query(`WITH candidate AS (
      SELECT attempt_id, creation_state = 'reserved' AS may_create FROM review_gate_attempts
       WHERE published_version < desired_version AND available_at <= to_timestamp($2 / 1000.0)
         AND (lease_owner IS NULL OR lease_expires_at <= to_timestamp($2 / 1000.0))
       ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE review_gate_attempts gate SET
      creation_state = CASE WHEN gate.creation_state = 'reserved' THEN 'creating' ELSE gate.creation_state END,
      lease_owner = $1, lease_token = $4, lease_expires_at = to_timestamp(($2+$3)/1000.0), updated_at = to_timestamp($2/1000.0)
      FROM candidate WHERE gate.attempt_id = candidate.attempt_id
      RETURNING gate.*, candidate.may_create`, [workerId, now, leaseMs, randomUUID()]);
    const row = result.rows[0];
    return row ? { ...fromRow(row), leaseOwner: workerId, leaseToken: row.lease_token, mayCreate: row.may_create === true } : null;
  }

  /** Release with bounded service backoff. Never revert creating to reserved:
   * losing an HTTP acknowledgement must not buy another create attempt. */
  async retryPublication(claim: GatePublicationClaim, now: number, delayMs: number,
    errorClass: 'transport' | 'unknown-create' | 'identity-conflict' | 'stale-claim'): Promise<boolean> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1_000 || delayMs > 300_000
      || !['transport', 'unknown-create', 'identity-conflict', 'stale-claim'].includes(errorClass)) {
      throw new Error('Invalid gate publication retry');
    }
    const result = await this.pool.query(`UPDATE review_gate_attempts
      SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, available_at = to_timestamp(($3+$4)/1000.0),
          last_error_class = $5, updated_at = to_timestamp($3/1000.0)
      WHERE attempt_id = $1 AND lease_owner = $2 AND lease_token = $6 AND lease_expires_at > to_timestamp($3/1000.0)
      RETURNING attempt_id`, [claim.coordinates.attemptId, claim.leaseOwner, now, delayMs, errorClass, claim.leaseToken]);
    return result.rows.length === 1;
  }

  /** Hold admission's lock through the bounded external publication. Without
   * this serialization, a publisher can validate an old attempt, race a same-
   * head re-admission, then PATCH that old success after the new generation.
   * The creation intent was committed by claimPublication before entering here;
   * a database rollback after an accepted POST therefore remains reconcile-only. */
  async publishLocked(
    claim: GatePublicationClaim,
    publish: (gate: StoredReviewGate, mayCreate: boolean) => Promise<ReviewGateCheck>,
    clock: () => number = Date.now,
  ): Promise<'published' | 'stale-claim'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `review-dispatch:${claim.coordinates.repositoryId}:${claim.coordinates.prNumber}`,
      ]);
      const result = await client.query(`SELECT * FROM review_gate_attempts
        WHERE attempt_id = $1 AND lease_owner = $2 AND lease_token = $4
          AND lease_expires_at > to_timestamp($3/1000.0) FOR UPDATE`,
      [claim.coordinates.attemptId, claim.leaseOwner, clock(), claim.leaseToken]);
      if (result.rows.length !== 1) { await client.query('COMMIT'); return 'stale-claim'; }
      const gate = fromRow(result.rows[0]);
      if (gate.externalId !== claim.externalId || gate.expectedAppId !== claim.expectedAppId
        || gate.desiredVersion !== claim.desiredVersion) {
        await client.query('COMMIT');
        return 'stale-claim';
      }
      const check = await publish(gate, claim.mayCreate && gate.creationState === 'creating' && gate.checkId === null);
      const terminal = !['queued', 'in_progress'].includes(gate.desiredState);
      if (!Number.isSafeInteger(check.id) || check.id <= 0
        || check.name !== REVIEW_GATE_CHECK_NAME || check.appId !== gate.expectedAppId
        || check.headSha !== gate.coordinates.headSha || check.externalId !== gate.externalId
        || (gate.checkId !== null && check.id !== gate.checkId)
        || check.status !== (terminal ? 'completed' : gate.desiredState)
        || check.conclusion !== (terminal ? gate.desiredState : null)) {
        throw new Error('Published gate did not match the locked attempt and desired state');
      }
      const saved = await client.query(`UPDATE review_gate_attempts
        SET check_id = $3, creation_state = 'bound', published_version = desired_version,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error_class = NULL,
            updated_at = to_timestamp($4/1000.0)
        WHERE attempt_id = $1 AND lease_owner = $2 AND lease_token = $5
          AND lease_expires_at > to_timestamp($4/1000.0) RETURNING attempt_id`,
      [gate.coordinates.attemptId, claim.leaseOwner, check.id, clock(), claim.leaseToken]);
      if (saved.rows.length !== 1) throw new Error('Gate publication lease expired before durable acknowledgement');
      await client.query('COMMIT');
      return 'published';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
