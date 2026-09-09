import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '../review/reviewCore';
import { assertTerminalDeadlineWindow } from '../config/terminalDeadline';
import {
  ReviewAdmission,
  ReviewAdmissionInput,
  ReviewDispatchClaim,
  PublicationMode,
  ReviewRun,
} from '../review/reviewRun';
import type { WorkerCompletionProof, WorkerTerminalFailure } from '../review/workerCompletion';

interface QueryResult {
  rows: any[];
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

interface TransactionClient extends Queryable {
  release(): void;
}

interface ConnectionPool {
  connect(): Promise<TransactionClient>;
}

function constantTimeDigestEqual(expected: unknown, actual: string): boolean {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected) || !/^[a-f0-9]{64}$/u.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function milliseconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function publicationMode(value: unknown): PublicationMode {
  if (value === 'disabled' || value === 'app-gate') return value;
  throw new Error('persisted publication mode is invalid');
}

function fromRow(row: any): ReviewRun {
  return {
    runId: row.run_id,
    identity: typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity,
    identityDigest: row.identity_digest,
    effectivePolicyDigest: row.effective_policy_digest || row.config_digest,
    effectiveConfigDigest: row.effective_config_digest || row.config_digest,
    indexEpoch: Number(row.index_epoch || 0),
    repositoryId: row.repository_id === null || row.repository_id === undefined ? undefined : Number(row.repository_id),
    installationId: row.installation_id === null || row.installation_id === undefined ? undefined : Number(row.installation_id),
    deliveryId: row.delivery_id || undefined,
    receivedAt: milliseconds(row.received_at),
    terminalDeadline: milliseconds(row.terminal_deadline),
    publicationMode: publicationMode(row.publication_mode),
    status: row.status,
    stage: row.stage,
    attempt: Number(row.attempt || 0),
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: milliseconds(row.lease_expires_at),
    artifacts: typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : (row.artifacts || {}),
    publicationFence: row.publication_fence || undefined,
    resultDigest: row.result_digest || undefined,
    error: row.error_text || undefined,
    createdAt: milliseconds(row.created_at) || 0,
    updatedAt: milliseconds(row.updated_at) || 0,
  };
}

function validateAdmission(input: ReviewAdmissionInput): void {
  if (!input.deliveryId.trim()) throw new Error('delivery id is required');
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new Error('repository id must be positive');
  if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) throw new Error('installation id must be positive');
  if (!/^[a-f0-9]{64}$/u.test(input.payloadDigest)) throw new Error('payload digest must be 64 lowercase hex characters');
  if (input.publicationMode !== 'disabled' && input.publicationMode !== 'app-gate') {
    throw new Error('publication mode must be disabled or app-gate');
  }
  assertTerminalDeadlineWindow(input.receivedAt, input.terminalDeadline);
}

/**
 * A publishing run that reached its terminal deadline without a verdict.
 *
 * REL-586: the ONLY component that creates a check run is the worker. Any failure
 * before its pod starts -- token mint, RBAC, capacity, workspace contention, CR
 * conflict, deadline expiry -- therefore leaves the head with no check at all. On a
 * required gate that is a silent block: merges stop and nothing is red. These rows
 * are what the reaper publishes a fail-closed conclusion for.
 */
export interface AbandonedPublishingRun {
  runId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  deliveryId: string;
  executionAttempt: number;
  receivedAt: number;
  terminalDeadline: number;
}

export interface ReviewDispatchRepository {
  admit(input: ReviewAdmissionInput): Promise<ReviewAdmission>;
  claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewDispatchClaim | null>;
  heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean>;
  markProjected(runId: string, workerId: string, projectionName: string, now: number, workerTokenDigest?: string): Promise<boolean>;
  bindWorkerTokenDigest(runId: string, workerId: string, workerTokenDigest: string, now: number): Promise<boolean>;
  releaseForRetry(runId: string, workerId: string, now: number, availableAt: number): Promise<boolean>;
  markTerminal(runId: string, workerId: string, now: number, error: string): Promise<boolean>;
  /** Persist a worker's fail-closed terminal outcome without approving the head. */
  markWorkerFailure(input: WorkerTerminalFailure, proof: WorkerCompletionProof, now?: number): Promise<WorkerFailureTransition>;
  /** REL-586: sweep publishing runs whose deadline passed without ever publishing. */
  claimAbandonedPublishingRuns(workerId: string, now: number, limit: number): Promise<AbandonedPublishingRun[]>;
  reconcileAbandonedPublishingRun(run: AbandonedPublishingRun, workerId: string, now: number,
    publish: () => Promise<void>): Promise<boolean>;
}

export interface WorkerFailureTransition {
  runId: string;
  status: 'failed' | 'already_failed' | 'ignored' | 'unauthorized';
}

export class PostgresReviewDispatchRepository implements ReviewDispatchRepository {
  private readonly queryable: Queryable;

  constructor(private readonly pool: ConnectionPool, queryable?: Queryable) {
    const possiblePool = pool as unknown as Partial<Queryable>;
    this.queryable = queryable || (typeof possiblePool.query === 'function' ? possiblePool as Queryable : {
      query: async () => { throw new Error('direct PostgreSQL query interface is unavailable'); },
    });
  }

  async admit(input: ReviewAdmissionInput): Promise<ReviewAdmission> {
    validateAdmission(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-dispatch:${input.repositoryId}:${input.identity.prNumber}`],
      );
      const delivery = await client.query(
        `INSERT INTO github_deliveries
           (delivery_id, event_name, repository_id, installation_id, payload_digest, received_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING delivery_id`,
        [input.deliveryId, input.eventName, input.repositoryId, input.installationId, input.payloadDigest, input.receivedAt],
      );

      if (delivery.rows.length === 0) {
        const existing = await client.query(
          `SELECT runs.*, deliveries.payload_digest, deliveries.repository_id
             FROM github_deliveries AS deliveries
             JOIN review_runs AS runs ON runs.run_id = deliveries.run_id
            WHERE deliveries.delivery_id = $1`,
          [input.deliveryId],
        );
        const row = existing.rows[0];
        if (!row || row.payload_digest !== input.payloadDigest || Number(row.repository_id) !== input.repositoryId) {
          throw new Error('delivery identity conflict: delivery id was already used for another payload or repository');
        }
        if (row.publication_mode !== input.publicationMode) {
          throw new Error('delivery publication mode conflict: delivery id was already used with another publication mode');
        }
        await client.query('COMMIT');
        return {
          status: 'duplicate',
          deliveryId: input.deliveryId,
          repositoryId: input.repositoryId,
          installationId: input.installationId,
          publicationMode: input.publicationMode,
          receivedAt: input.receivedAt,
          terminalDeadline: input.terminalDeadline,
          payloadDigest: input.payloadDigest,
          run: fromRow(row),
        };
      }

      const identityDigest = sha256(input.identity);
      const runId = `run_${identityDigest.slice(0, 32)}`;
      await client.query(
        `WITH superseded AS (
           UPDATE review_runs
              SET status = 'superseded',
                  error_text = 'superseded by a newer pull request head',
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = to_timestamp($5 / 1000.0)
            WHERE owner = $1 AND repo = $2 AND pr_number = $3
              AND head_sha <> $4 AND status IN ('queued', 'running')
          RETURNING run_id
         )
         UPDATE review_dispatch_outbox AS outbox
            SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($5 / 1000.0)
          WHERE outbox.run_id IN (SELECT run_id FROM superseded)`,
        [input.identity.owner, input.identity.repo, input.identity.prNumber, input.identity.headSha, input.receivedAt],
      );

      const inserted = await client.query(
        `INSERT INTO review_runs
           (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
            snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
            index_epoch, identity, status, stage, attempt, artifacts, repository_id,
            installation_id, delivery_id, received_at, terminal_deadline, publication_mode,
            created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $11, $12,
            'queued', 'admission', 0, '{}'::jsonb, $13, $14, $15,
            to_timestamp($16 / 1000.0), to_timestamp($17 / 1000.0), $18,
            to_timestamp($16 / 1000.0), to_timestamp($16 / 1000.0))
         ON CONFLICT (identity_digest) DO UPDATE
           SET updated_at = review_runs.updated_at,
               -- A run that terminally FAILED on this exact head is retryable.
               -- The run id is derived from the identity digest, so every
               -- re-dispatch of the same head lands on the same row; without this
               -- the row stays 'failed' forever, the outbox stays 'terminal', and
               -- the head can never be reviewed again by any means short of a
               -- force-push. Only 'failed' is re-armed: 'queued'/'running' are
               -- in flight and must stay idempotent, and 'superseded' belongs to
               -- an older head.
               status = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN 'queued' ELSE review_runs.status END,
               attempt = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN review_runs.attempt + 1 ELSE review_runs.attempt END,
               error_text = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN NULL ELSE review_runs.error_text END,
               lease_owner = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN NULL ELSE review_runs.lease_owner END,
               lease_expires_at = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN NULL ELSE review_runs.lease_expires_at END,
               delivery_id = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN EXCLUDED.delivery_id ELSE review_runs.delivery_id END,
               received_at = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN EXCLUDED.received_at ELSE review_runs.received_at END,
               -- The old deadline is already in the past, so a retry would be
               -- swept by the abandoned-run reaper before it could start.
               terminal_deadline = CASE WHEN review_runs.status IN ('failed', 'terminal') THEN EXCLUDED.terminal_deadline ELSE review_runs.terminal_deadline END
         WHERE review_runs.publication_mode = EXCLUDED.publication_mode
         RETURNING *`,
        [
          runId,
          identityDigest,
          input.identity.owner,
          input.identity.repo,
          input.identity.prNumber,
          input.identity.headSha,
          input.identity.baseSha,
          input.identity.snapshotDigest,
          input.identity.configDigest,
          input.effectivePolicyDigest || input.identity.configDigest,
          input.indexEpoch || 0,
          JSON.stringify(input.identity),
          input.repositoryId,
          input.installationId,
          input.deliveryId,
          input.receivedAt,
          input.terminalDeadline,
          input.publicationMode,
        ],
      );
      const runRow = inserted.rows[0];
      if (!runRow) {
        throw new Error('review run publication mode conflict: the admitted identity already uses another publication mode');
      }

      await client.query(
        'UPDATE github_deliveries SET run_id = $2 WHERE delivery_id = $1',
        [input.deliveryId, runRow.run_id],
      );
      await client.query(
        `INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, available_at, created_at, updated_at)
         VALUES ($1, $2, 'pending', to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))
         ON CONFLICT (run_id) DO UPDATE
           SET status = 'pending', delivery_id = EXCLUDED.delivery_id,
               available_at = EXCLUDED.available_at, lease_owner = NULL,
               lease_expires_at = NULL, projection_name = NULL,
         -- Re-arm only alongside a run the statement above just returned to
         -- 'queued'. A worker provider failure leaves the outbox 'projected'
         -- and needs a new execution attempt. A terminal dispatch with token
         -- or projection evidence may also have created a worker before losing
         -- its acknowledgement, so it too needs a fresh identity. Guarding on the
         -- run's status keeps a superseded run's terminal outbox row untouched,
         -- and an in-flight row is never disturbed.
               execution_attempt = CASE WHEN review_dispatch_outbox.status = 'projected'
                 OR review_dispatch_outbox.worker_token_digest IS NOT NULL
                 OR review_dispatch_outbox.projection_name IS NOT NULL
                 THEN review_dispatch_outbox.execution_attempt + 1
                 ELSE review_dispatch_outbox.execution_attempt END,
               worker_token_digest = CASE WHEN review_dispatch_outbox.status IN ('projected', 'terminal')
                 THEN NULL ELSE review_dispatch_outbox.worker_token_digest END,
               updated_at = EXCLUDED.updated_at
         WHERE review_dispatch_outbox.status IN ('projected', 'terminal')
           AND EXISTS (
             SELECT 1 FROM review_runs r
              WHERE r.run_id = review_dispatch_outbox.run_id
                AND r.status = 'queued'
                -- Only the failed/terminal branch above replaces the run's delivery_id.
                -- Requiring the same new delivery binds this re-arm to that durable
                -- transition; a queued or running run with a projected outbox must stay
                -- untouched even when a new delivery arrives while its worker starts.
                AND r.delivery_id = EXCLUDED.delivery_id
           )`,
        [runRow.run_id, input.deliveryId, input.receivedAt],
      );
      await client.query('COMMIT');
      return {
        status: 'accepted',
        deliveryId: input.deliveryId,
        repositoryId: input.repositoryId,
        installationId: input.installationId,
        publicationMode: input.publicationMode,
        receivedAt: input.receivedAt,
        terminalDeadline: input.terminalDeadline,
        payloadDigest: input.payloadDigest,
        run: fromRow(runRow),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewDispatchClaim | null> {
    const result = await this.queryable.query(
      `WITH candidate AS (
         SELECT outbox.run_id, runs.publication_mode, runs.owner, runs.repo,
                runs.pr_number, runs.head_sha, runs.base_sha, runs.received_at,
                runs.terminal_deadline, runs.effective_policy_digest,
                runs.effective_config_digest
           FROM review_dispatch_outbox AS outbox
           JOIN review_runs AS runs ON runs.run_id = outbox.run_id
          WHERE runs.status = 'queued'
            AND runs.terminal_deadline > to_timestamp($2 / 1000.0)
            AND outbox.available_at <= to_timestamp($2 / 1000.0)
            AND (outbox.status = 'pending'
              OR (outbox.status = 'claimed' AND outbox.lease_expires_at <= to_timestamp($2 / 1000.0)))
          ORDER BY outbox.available_at, outbox.created_at
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT 1
       )
       UPDATE review_dispatch_outbox AS outbox
          SET status = 'claimed', lease_owner = $1,
              lease_expires_at = to_timestamp(($2 + $3) / 1000.0),
              attempt = attempt + 1, updated_at = to_timestamp($2 / 1000.0)
         FROM candidate, github_deliveries AS deliveries
        WHERE outbox.run_id = candidate.run_id
          AND deliveries.delivery_id = outbox.delivery_id
       RETURNING outbox.run_id, outbox.delivery_id, deliveries.repository_id,
                 deliveries.installation_id, candidate.publication_mode,
                 candidate.owner, candidate.repo, candidate.pr_number,
                 candidate.head_sha, candidate.base_sha, candidate.received_at,
                 candidate.terminal_deadline, candidate.effective_policy_digest,
                 candidate.effective_config_digest,
                 outbox.execution_attempt + 1 AS execution_attempt,
                 outbox.worker_token_digest,
                 outbox.lease_owner, outbox.lease_expires_at`,
      [workerId, now, leaseMs],
    );
    const row = result.rows[0];
    return row ? {
      runId: row.run_id,
      deliveryId: row.delivery_id,
      executionAttempt: Number(row.execution_attempt || 1),
      workerTokenDigest: row.worker_token_digest || undefined,
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      publicationMode: publicationMode(row.publication_mode),
      repo: `${row.owner}/${row.repo}`,
      prNumber: Number(row.pr_number),
      headSha: row.head_sha,
      baseSha: row.base_sha,
      receivedAt: milliseconds(row.received_at) || 0,
      terminalDeadline: milliseconds(row.terminal_deadline) || 0,
      policyDigest: row.effective_policy_digest,
      configDigest: row.effective_config_digest,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: milliseconds(row.lease_expires_at) || 0,
    } : null;
  }

  async claimAbandonedPublishingRuns(
    workerId: string,
    now: number,
    limit: number,
  ): Promise<AbandonedPublishingRun[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('reaper limit must be a positive integer');
    // A failure to reach GitHub must remain retryable. Claim with a short lease;
    // only successful reconciliation removes the pending-publication marker.
    const result = await this.queryable.query(
      `WITH candidate AS (
         SELECT runs.run_id
           FROM review_runs runs
           JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
          WHERE (runs.status IN ('queued', 'running') OR
            (runs.status = 'terminal' AND runs.error_text LIKE
              'publishing run reached its terminal deadline without a verdict; reaped by %'))
            AND publication_mode = 'app-gate'
            AND result_digest IS NULL
            AND terminal_deadline <= to_timestamp($2 / 1000.0)
            AND (runs.lease_expires_at IS NULL OR runs.lease_expires_at <= to_timestamp($2 / 1000.0))
          ORDER BY terminal_deadline
          FOR UPDATE OF runs, outbox SKIP LOCKED
          LIMIT $3
       ), retired AS (
         UPDATE review_dispatch_outbox outbox
            SET status = CASE WHEN outbox.status = 'projected' OR outbox.worker_token_digest IS NOT NULL
                         THEN 'projected' ELSE 'terminal' END,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($2 / 1000.0)
           FROM candidate WHERE outbox.run_id = candidate.run_id
         RETURNING outbox.run_id, outbox.execution_attempt
       )
       UPDATE review_runs AS runs
          SET status = 'terminal', updated_at = to_timestamp($2 / 1000.0),
              lease_owner = $1, lease_expires_at = to_timestamp(($2 + 60000) / 1000.0),
              error_text = 'publishing run reached its terminal deadline without a verdict; reaped by ' || $1
         FROM retired
        WHERE runs.run_id = retired.run_id
       RETURNING runs.run_id, runs.owner, runs.repo, runs.pr_number, runs.head_sha,
                 runs.delivery_id, runs.received_at, runs.terminal_deadline,
                 retired.execution_attempt + 1 AS execution_attempt`,
      [workerId, now, limit],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      runId: String(row.run_id),
      owner: String(row.owner),
      repo: String(row.repo),
      prNumber: Number(row.pr_number),
      headSha: String(row.head_sha),
      deliveryId: String(row.delivery_id),
      executionAttempt: Number(row.execution_attempt),
      receivedAt: milliseconds(row.received_at) || 0,
      terminalDeadline: milliseconds(row.terminal_deadline) || 0,
    }));
  }

  /** Hold the exact attempt's row locks through bounded GitHub publication.
   * Same-head admission cannot advance the delivery while its check is patched.
   * A crash/HTTP error rolls back the acknowledgement, not the failure itself.
   */
  async reconcileAbandonedPublishingRun(run: AbandonedPublishingRun, workerId: string, now: number,
    publish: () => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT runs.run_id FROM review_runs runs
           JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
          WHERE runs.run_id = $1 AND runs.delivery_id = $2
            AND outbox.delivery_id = $2
            AND runs.status = 'terminal' AND runs.publication_mode = 'app-gate'
            AND runs.result_digest IS NULL AND runs.lease_owner = $3
            AND runs.lease_expires_at > to_timestamp($4 / 1000.0)
            AND outbox.execution_attempt + 1 = $5
            AND runs.owner = $6 AND runs.repo = $7 AND runs.pr_number = $8 AND runs.head_sha = $9
            AND runs.received_at = to_timestamp($10 / 1000.0)
            AND runs.terminal_deadline = to_timestamp($11 / 1000.0)
          FOR UPDATE OF runs, outbox`,
        [run.runId, run.deliveryId, workerId, now, run.executionAttempt,
          run.owner, run.repo, run.prNumber, run.headSha, run.receivedAt, run.terminalDeadline],
      );
      if (current.rows.length === 0) {
        await client.query('COMMIT');
        return false;
      }
      await publish();
      await client.query(
        `UPDATE review_runs SET lease_owner = NULL, lease_expires_at = NULL,
           error_text = 'publishing run reached its terminal deadline without a verdict; failure reconciled',
           updated_at = to_timestamp($2 / 1000.0) WHERE run_id = $1`, [run.runId, now],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET lease_expires_at = to_timestamp(($3 + $4) / 1000.0), updated_at = to_timestamp($3 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND lease_expires_at > to_timestamp($3 / 1000.0)
      RETURNING run_id`,
      [runId, workerId, now, leaseMs],
    );
    return result.rows.length > 0;
  }

  async markProjected(
    runId: string,
    workerId: string,
    projectionName: string,
    now: number,
    workerTokenDigest?: string,
  ): Promise<boolean> {
    if (workerTokenDigest !== undefined && !/^[a-f0-9]{64}$/u.test(workerTokenDigest)) {
      throw new Error('worker token digest must be 64 lowercase hex characters');
    }
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'projected', projection_name = $3, worker_token_digest = COALESCE($5, worker_token_digest),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = to_timestamp($4 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND ($5::text IS NULL OR worker_token_digest IS NULL OR worker_token_digest = $5)
      RETURNING run_id`,
      [runId, workerId, projectionName, now, workerTokenDigest || null],
    );
    return result.rows.length > 0;
  }

  async bindWorkerTokenDigest(runId: string, workerId: string, workerTokenDigest: string, now: number): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/u.test(workerTokenDigest)) {
      throw new Error('worker token digest must be 64 lowercase hex characters');
    }
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET worker_token_digest = COALESCE(worker_token_digest, $3),
              updated_at = to_timestamp($4 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND (worker_token_digest IS NULL OR worker_token_digest = $3)
      RETURNING run_id`,
      [runId, workerId, workerTokenDigest, now],
    );
    return result.rows.length > 0;
  }

  async releaseForRetry(runId: string, workerId: string, now: number, availableAt: number): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              available_at = to_timestamp($4 / 1000.0), updated_at = to_timestamp($3 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
      RETURNING run_id`,
      [runId, workerId, now, availableAt],
    );
    return result.rows.length > 0;
  }

  async markTerminal(runId: string, workerId: string, now: number, error: string): Promise<boolean> {
    // Retain the non-secret digest as execution evidence until re-admission
    // advances the identity and clears it. The terminal status already prevents
    // any worker callback from changing the run; deleting this evidence here
    // would make an uncertain Kubernetes create reuse its old Secret/CR.
    const result = await this.queryable.query(
      `WITH terminalized AS (
         UPDATE review_dispatch_outbox
            SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($3 / 1000.0)
          WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
        RETURNING run_id
       )
       UPDATE review_runs AS runs
          SET status = 'failed', error_text = $4, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = to_timestamp($3 / 1000.0)
         FROM terminalized
        WHERE runs.run_id = terminalized.run_id AND runs.status = 'queued'
      RETURNING runs.run_id`,
      [runId, workerId, now, error],
    );
    return result.rows.length > 0;
  }

  async markWorkerFailure(input: WorkerTerminalFailure, proof: WorkerCompletionProof, now = Date.now()): Promise<WorkerFailureTransition> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Use admission's repository/PR lock so a same-head rerequest cannot
      // interleave the run transition with the execution's outbox transition.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `review-dispatch:${input.repositoryId}:${input.prNumber}`,
      ]);
      const result = await this.persistWorkerFailure(client, input, proof, now);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistWorkerFailure(
    client: Queryable,
    input: WorkerTerminalFailure,
    proof: WorkerCompletionProof,
    now: number,
  ): Promise<WorkerFailureTransition> {
    const safeError = `worker terminal failure: ${input.failureClass}`;
    const current = await client.query(
      `SELECT runs.status, runs.repository_id, runs.owner, runs.repo, runs.pr_number,
              runs.head_sha, runs.base_sha, runs.effective_policy_digest,
              runs.effective_config_digest, runs.publication_mode,
              outbox.status AS outbox_status, outbox.execution_attempt,
              outbox.worker_token_digest
         FROM review_runs AS runs
         JOIN review_dispatch_outbox AS outbox ON outbox.run_id = runs.run_id
        WHERE runs.run_id = $1
        FOR UPDATE OF runs, outbox`,
      [input.runId],
    );
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row) return { runId: input.runId, status: 'ignored' };

    // The bearer must be the exact token minted for this execution attempt. A
    // GitHub installation-token prefix or public check visibility is not proof
    // of provenance. Compare fixed-length digests with a constant-time primitive.
    if (!constantTimeDigestEqual(row.worker_token_digest, proof.workerTokenDigest)) {
      return { runId: input.runId, status: 'unauthorized' };
    }

    const metadataMatches = Number(row.repository_id) === input.repositoryId
      && String(row.owner) === input.owner
      && String(row.repo) === input.repo
      && Number(row.pr_number) === input.prNumber
      && String(row.head_sha) === input.headSha
      && String(row.base_sha) === input.baseSha
      && String(row.effective_policy_digest) === input.policyDigest
      && String(row.effective_config_digest) === input.configDigest
      && String(row.publication_mode) === 'app-gate'
      && Number(row.execution_attempt) + 1 === input.executionAttempt;
    if (!metadataMatches) return { runId: input.runId, status: 'unauthorized' };

    const status = String(row.status || '');
    if (status === 'failed' || status === 'terminal') return { runId: input.runId, status: 'already_failed' };
    if (!['queued', 'running'].includes(status)
      || !['pending', 'claimed', 'projected'].includes(String(row.outbox_status))) {
      return { runId: input.runId, status: 'ignored' };
    }

    // A valid per-execution callback proves the worker was projected, even if
    // Kubernetes accepted it before the dispatcher persisted its acknowledgement.
    // Retire that dispatch lease atomically with failure. An old dispatcher then
    // cannot resurrect/retry this execution; explicit re-admission advances the
    // existing projected-execution counter and allocates a fresh Job and Secret.
    await client.query(
      `UPDATE review_dispatch_outbox
          SET status = 'projected', lease_owner = NULL, lease_expires_at = NULL,
              updated_at = to_timestamp($2 / 1000.0)
        WHERE run_id = $1`,
      [input.runId, now],
    );
    const transitioned = await client.query(
      `UPDATE review_runs AS runs
          SET status = 'failed', error_text = $2, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = to_timestamp($3 / 1000.0)
        FROM review_dispatch_outbox AS outbox
        WHERE runs.run_id = $1
          AND outbox.run_id = runs.run_id
          AND runs.owner = $4
          AND runs.repo = $5
          AND runs.pr_number = $6
          AND runs.head_sha = $7
          AND runs.base_sha = $8
          AND runs.repository_id = $9
          AND runs.effective_policy_digest = $10
          AND runs.effective_config_digest = $11
          AND runs.publication_mode = 'app-gate'
          AND runs.status IN ('queued', 'running')
          AND outbox.status = 'projected'
          AND outbox.execution_attempt + 1 = $12
          AND outbox.worker_token_digest = $13
        RETURNING runs.run_id`,
      [
        input.runId,
        safeError,
        now,
        input.owner,
        input.repo,
        input.prNumber,
        input.headSha,
        input.baseSha,
        input.repositoryId,
        input.policyDigest,
        input.configDigest,
        input.executionAttempt,
        proof.workerTokenDigest,
      ],
    );
    if (transitioned.rows.length !== 1) throw new Error('worker failure transition lost its locked identity');
    return { runId: input.runId, status: 'failed' };
  }
}
