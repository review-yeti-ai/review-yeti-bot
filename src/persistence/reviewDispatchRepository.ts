import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '../review/reviewCore';
import { deriveReviewRunId } from '../review/reviewAdmission';
import { assertTerminalDeadlineWindow } from '../config/terminalDeadline';
import {
  ReviewAdmission,
  ReviewAdmissionInput,
  ReviewDispatchClaim,
  PublicationMode,
  ReviewGenerationConflictError,
  ReviewRun,
} from '../review/reviewRun';
import {
  buildDurableWorkerFailureDiagnostics,
  type WorkerCompletionProof, type WorkerFailureDiagnostics, type WorkerTerminalFailure,
} from '../review/workerCompletion';
import { buildAuthoritativeReviewIdentity } from '../review/authoritativeReviewIdentity';
import { savePreparedPublishingPolicy } from './preparedReviewRepository';
import { PostgresReviewGateRepository } from './reviewGateRepository';
import { reviewDispatchPrLockKey } from './reviewCiPersistence';

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

export interface ReviewDispatchRepositoryOptions {
  /** Trusted service read/validation only; invoked under the candidate's PR lock before any admission writes. */
  validateAuthoritativeAdmission?: (input: ReviewAdmissionInput) => Promise<void>;
  /** Defaults to 30 seconds; safe integer values are clamped to 250–30,000 ms. */
  admissionValidationTimeoutMs?: number;
  /** Require central repository_dispatch app-gate callers to supply the exact generation. */
  requireExpectedGeneration?: boolean;
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
  const storedDiagnostics = typeof row.failure_diagnostics === 'string'
    ? JSON.parse(row.failure_diagnostics) : row.failure_diagnostics;
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
    authoritativeGateAppId: row.authoritative_gate_app_id == null ? undefined : Number(row.authoritative_gate_app_id),
    status: row.status,
    stage: row.stage,
    attempt: Number(row.attempt || 0),
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: milliseconds(row.lease_expires_at),
    artifacts: typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : (row.artifacts || {}),
    publicationFence: row.publication_fence || undefined,
    resultDigest: row.result_digest || undefined,
    error: row.error_text || undefined,
    failureDiagnostics: storedDiagnostics && typeof storedDiagnostics === 'object'
      && Object.keys(storedDiagnostics).length > 0 ? storedDiagnostics : undefined,
    createdAt: milliseconds(row.created_at) || 0,
    updatedAt: milliseconds(row.updated_at) || 0,
  };
}

function validateAdmission(input: ReviewAdmissionInput, requireExpectedGeneration: boolean): void {
  if (!input.deliveryId.trim()) throw new Error('delivery id is required');
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new Error('repository id must be positive');
  if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) throw new Error('installation id must be positive');
  if (!/^[a-f0-9]{64}$/u.test(input.payloadDigest)) throw new Error('payload digest must be 64 lowercase hex characters');
  if (input.publicationMode !== 'disabled' && input.publicationMode !== 'app-gate') {
    throw new Error('publication mode must be disabled or app-gate');
  }
  if (input.retryRequested !== undefined && typeof input.retryRequested !== 'boolean') {
    throw new Error('retry requested must be a boolean');
  }
  if (input.retryAfterExecutionAttempt !== undefined
    && (!Number.isSafeInteger(input.retryAfterExecutionAttempt) || input.retryAfterExecutionAttempt <= 0)) {
    throw new Error('retry-after execution attempt must be a positive integer');
  }
  if (input.retryRequested === true && input.retryAfterExecutionAttempt === undefined) {
    throw new Error('retry requested requires a retry-after execution attempt');
  }
  if (input.expectedGeneration !== undefined
    && (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration <= 0)) {
    throw new Error('expected generation must be a positive integer');
  }
  if (input.publicationMode === 'app-gate'
    && input.eventName === 'repository_dispatch'
    && requireExpectedGeneration
    && input.expectedGeneration === undefined) {
    throw new Error('expected generation is required for central app-gate admission');
  }
  assertTerminalDeadlineWindow(input.receivedAt, input.terminalDeadline);
  if (input.authoritativeGate) {
    const { expectedAppId, prepared } = input.authoritativeGate;
    if (input.publicationMode !== 'app-gate' || !Number.isSafeInteger(expectedAppId) || expectedAppId <= 0) {
      throw new Error('Authoritative gate admission requires a service App identity');
    }
    const candidate = { owner: input.identity.owner, repo: input.identity.repo,
      prNumber: input.identity.prNumber, headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId };
    const identity = buildAuthoritativeReviewIdentity({ requested: candidate,
      current: { ...candidate, open: true, draft: false }, policy: prepared.policy });
    if (sha256(identity) !== sha256(input.identity)
      || input.effectivePolicyDigest !== prepared.policy.effectivePolicyDigest) {
      throw new Error('Authoritative admission does not match its prepared identity');
    }
  }
}

function assertExpectedGeneration(input: ReviewAdmissionInput, row: Record<string, unknown>): void {
  if (input.expectedGeneration === undefined) return;
  const persistedAttempt = Number(row.attempt);
  if (!Number.isSafeInteger(persistedAttempt) || persistedAttempt < 0) {
    throw new Error('persisted review generation is invalid');
  }
  const durableGeneration = persistedAttempt + 1;
  if (input.expectedGeneration !== durableGeneration) {
    throw new ReviewGenerationConflictError(input.expectedGeneration, durableGeneration);
  }
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
  heartbeat(runId: string, workerId: string, claimAttempt: number, now: number, leaseMs: number): Promise<boolean>;
  markProjected(runId: string, workerId: string, claimAttempt: number, projectionName: string, now: number, workerTokenDigest?: string): Promise<boolean>;
  bindWorkerTokenDigest(runId: string, workerId: string, claimAttempt: number, workerTokenDigest: string, now: number): Promise<boolean>;
  releaseForRetry(runId: string, workerId: string, claimAttempt: number, now: number, availableAt: number): Promise<boolean>;
  markTerminal(runId: string, workerId: string, claimAttempt: number, now: number, error: string,
    diagnostics?: WorkerFailureDiagnostics): Promise<boolean>;
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

function validateClaimAttempt(claimAttempt: number): void {
  if (!Number.isSafeInteger(claimAttempt) || claimAttempt <= 0) {
    throw new Error('dispatcher claim attempt must be a positive integer');
  }
}

export class PostgresReviewDispatchRepository implements ReviewDispatchRepository {
  private readonly queryable: Queryable;
  private readonly admissionValidationTimeoutMs: number;

  constructor(private readonly pool: ConnectionPool, queryable?: Queryable,
    private readonly options: ReviewDispatchRepositoryOptions = {}) {
    const timeoutMs = options.admissionValidationTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs)
      || (options.validateAuthoritativeAdmission !== undefined && typeof options.validateAuthoritativeAdmission !== 'function')) {
      throw new Error('Invalid authoritative admission validation configuration');
    }
    this.admissionValidationTimeoutMs = Math.min(30_000, Math.max(250, timeoutMs));
    const possiblePool = pool as unknown as Partial<Queryable>;
    this.queryable = queryable || (typeof possiblePool.query === 'function' ? possiblePool as Queryable : {
      query: async () => { throw new Error('direct PostgreSQL query interface is unavailable'); },
    });
  }

  private async validateAuthoritativeAdmission(input: ReviewAdmissionInput): Promise<void> {
    const validate = this.options.validateAuthoritativeAdmission;
    if (!validate) throw new Error('Authoritative admission validator is required');
    const deadline = performance.now() + this.admissionValidationTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => validate(input)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Authoritative admission validation unavailable')), this.admissionValidationTimeoutMs);
        }),
      ]);
      if (performance.now() >= deadline) throw new Error('Authoritative admission validation unavailable');
    } catch {
      // A late validator may finish its own reads, but no admission continuation
      // remains to write after this rejects and the transaction rolls back.
      throw new Error('Authoritative admission validation unavailable');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async admit(input: ReviewAdmissionInput): Promise<ReviewAdmission> {
    validateAdmission(input, this.options.requireExpectedGeneration === true);
    if (input.authoritativeGate && !this.options.validateAuthoritativeAdmission) {
      throw new Error('Authoritative admission validator is required');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.authoritativeGate) await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [reviewDispatchPrLockKey(input.repositoryId, input.identity.prNumber)],
      );
      if (input.authoritativeGate) {
        await this.validateAuthoritativeAdmission(input);
        await savePreparedPublishingPolicy(client, input.authoritativeGate.prepared);
      }
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
        if (input.authoritativeGate && (Number(row.authoritative_gate_app_id) !== input.authoritativeGate.expectedAppId
          || row.identity_digest !== sha256(input.identity))) {
          throw new Error('Duplicate delivery no longer matches current authoritative identity');
        }
        assertExpectedGeneration(input, row);
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
      const runId = deriveReviewRunId(input.identity);
      const inserted = await client.query(
         `WITH retry_eligibility AS (
           SELECT runs.run_id,
                  (runs.status IN ('failed', 'terminal') AND (
                    NOT $20::boolean OR (
                      $21::integer IS NOT NULL AND EXISTS (
                        SELECT 1 FROM review_dispatch_outbox AS retry_outbox
                         WHERE retry_outbox.run_id = runs.run_id
                           AND retry_outbox.execution_attempt + 1 = $21::integer
                           AND (retry_outbox.status = 'projected'
                             OR (retry_outbox.status = 'terminal'
                               AND (retry_outbox.worker_token_digest IS NOT NULL
                                 OR retry_outbox.projection_name IS NOT NULL)))
                      )
                    )
                  ))
                  OR ($20::boolean AND runs.status IN ('queued', 'running') AND $21::integer IS NOT NULL AND EXISTS (
                    SELECT 1 FROM review_dispatch_outbox AS retry_outbox
                     WHERE retry_outbox.run_id = runs.run_id
                       AND retry_outbox.execution_attempt + 1 = $21::integer
                       AND (retry_outbox.status = 'projected'
                         OR (retry_outbox.status = 'terminal'
                           AND (retry_outbox.worker_token_digest IS NOT NULL
                             OR retry_outbox.projection_name IS NOT NULL)))
                  )) AS should_retry
             FROM review_runs AS runs
            WHERE runs.run_id = $1
         )
         INSERT INTO review_runs
           (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
            snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
            index_epoch, identity, status, stage, attempt, artifacts, repository_id,
            installation_id, delivery_id, received_at, terminal_deadline, publication_mode, authoritative_gate_app_id,
            created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $11, $12,
            'queued', 'admission', 0, '{}'::jsonb, $13, $14, $15,
            to_timestamp($16 / 1000.0), to_timestamp($17 / 1000.0), $18, $19,
            to_timestamp($16 / 1000.0), to_timestamp($16 / 1000.0))
         ON CONFLICT (identity_digest) DO UPDATE
           SET updated_at = review_runs.updated_at,
               -- Retry only the same complete identity after a durable failure.
               -- Active duplicates remain unchanged unless the trusted App
               -- requested-action path (or its central signed handoff) carries
               -- an explicit retry. Even then, an active run must have a
               -- projected/worker-token outbox record: the persisted ledger,
               -- not a caller's desired attempt number, proves that an older
               -- worker existed and may safely be replaced.
               status = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN 'queued' ELSE review_runs.status END,
               attempt = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN review_runs.attempt + 1 ELSE review_runs.attempt END,
               error_text = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN NULL ELSE review_runs.error_text END,
               lease_owner = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN NULL ELSE review_runs.lease_owner END,
               lease_expires_at = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN NULL ELSE review_runs.lease_expires_at END,
               delivery_id = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN EXCLUDED.delivery_id ELSE review_runs.delivery_id END,
               received_at = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN EXCLUDED.received_at ELSE review_runs.received_at END,
               -- The old deadline is already in the past, so a retry would be
               -- swept by the abandoned-run reaper before it could start.
               terminal_deadline = CASE WHEN (SELECT should_retry FROM retry_eligibility WHERE run_id = review_runs.run_id)
                   THEN EXCLUDED.terminal_deadline ELSE review_runs.terminal_deadline END
         WHERE review_runs.publication_mode = EXCLUDED.publication_mode
           AND review_runs.authoritative_gate_app_id IS NOT DISTINCT FROM EXCLUDED.authoritative_gate_app_id
           AND review_runs.status <> 'superseded'
           -- Even a legitimate return to a historically superseded identity is
           -- rejected here. Supporting that later requires fresh live authority
           -- and an explicit new generation, not a guessed revival of this row.
           -- Older deployments could leave multiple same-head identities active
           -- or retryable. Fail closed on a later (or ambiguously simultaneous)
           -- persisted identity rather than letting that legacy row displace it.
           -- This rejection fence does not establish current GitHub truth.
           AND NOT EXISTS (
             SELECT 1 FROM review_runs AS other
              WHERE other.owner = review_runs.owner AND other.repo = review_runs.repo
                AND other.pr_number = review_runs.pr_number
                -- Shadow/legacy history is not authority over enrolled runs,
                -- and enrolled history must not break the legacy lifecycle.
                AND (other.authoritative_gate_app_id IS NOT NULL) = (review_runs.authoritative_gate_app_id IS NOT NULL)
                AND other.identity_digest <> review_runs.identity_digest
                AND other.status <> 'superseded'
                AND other.created_at >= review_runs.created_at
           )
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
          input.authoritativeGate?.expectedAppId ?? null,
          input.retryRequested === true,
          input.retryAfterExecutionAttempt ?? null,
        ],
      );
      const runRow = inserted.rows[0];
      if (!runRow) {
        throw new Error('review run identity conflict: identity is no longer current or publication mode differs');
      }
      // The central App ledger speaks in one-based generations (a1/a2/a3),
      // while review_runs.attempt is the durable zero-based generation. This
      // comparison runs under the candidate PR advisory lock and in the same
      // transaction as delivery, run, outbox, and gate allocation. Any mismatch
      // rolls the entire attempted admission back, so an identity drift cannot
      // silently allocate a fresh a1 after the central gate admitted a2 or a3.
      assertExpectedGeneration(input, runRow);

      // Resolve the incoming identity before retiring anything. A historical
      // completed duplicate must not supersede current work. For enrolled runs,
      // the trusted validator above establishes freshness under this same lock;
      // the persisted-history guard alone cannot identify an unseen stale run.
      if (['queued', 'running', 'publishing'].includes(runRow.status)) {
        await client.query(
          `WITH superseded AS (
             UPDATE review_runs
                SET status = 'superseded',
                    error_text = 'superseded by a newer review identity',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = to_timestamp($5 / 1000.0)
              WHERE owner = $1 AND repo = $2 AND pr_number = $3
                AND (authoritative_gate_app_id IS NOT NULL) = $6
                AND identity_digest <> $4
                AND status IN ('queued', 'running', 'publishing', 'failed', 'terminal')
            RETURNING run_id
           )
           UPDATE review_dispatch_outbox AS outbox
              SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($5 / 1000.0)
            WHERE outbox.run_id IN (SELECT run_id FROM superseded)`,
          [input.identity.owner, input.identity.repo, input.identity.prNumber, identityDigest, input.receivedAt,
            runRow.authoritative_gate_app_id != null],
        );
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
      if (input.authoritativeGate && ['queued', 'running'].includes(runRow.status)) {
        const gate = await PostgresReviewGateRepository.reserveInTransaction(
          client, runRow.run_id, input.authoritativeGate.expectedAppId, input.receivedAt);
        if (!gate) throw new Error('Authoritative dispatch has no durable gate reservation');
      }
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
         SELECT outbox.run_id, runs.publication_mode, runs.authoritative_gate_app_id, runs.owner, runs.repo,
                runs.pr_number, runs.head_sha, runs.base_sha, runs.received_at,
                runs.terminal_deadline, runs.effective_policy_digest,
                runs.effective_config_digest
           FROM review_dispatch_outbox AS outbox
           JOIN review_runs AS runs ON runs.run_id = outbox.run_id
          WHERE runs.status = 'queued'
            AND (runs.authoritative_gate_app_id IS NULL OR EXISTS (
              SELECT 1 FROM review_gate_attempts gate WHERE gate.run_id = runs.run_id
                AND gate.current_attempt AND gate.review_generation = runs.attempt
                AND gate.execution_attempt = outbox.execution_attempt + 1
                AND gate.expected_app_id = runs.authoritative_gate_app_id
                AND gate.creation_state = 'bound' AND gate.check_id IS NOT NULL
                AND gate.desired_state IN ('queued', 'in_progress')
                AND gate.published_version = gate.desired_version
            ))
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
                 deliveries.installation_id, candidate.publication_mode, candidate.authoritative_gate_app_id,
                 candidate.owner, candidate.repo, candidate.pr_number,
                 candidate.head_sha, candidate.base_sha, candidate.received_at,
                 candidate.terminal_deadline, candidate.effective_policy_digest,
                 candidate.effective_config_digest,
                 outbox.attempt AS claim_attempt,
                 outbox.execution_attempt + 1 AS execution_attempt,
                 outbox.worker_token_digest,
                 outbox.lease_owner, outbox.lease_expires_at`,
      [workerId, now, leaseMs],
    );
    const row = result.rows[0];
    return row ? {
      runId: row.run_id,
      deliveryId: row.delivery_id,
      claimAttempt: Number(row.claim_attempt),
      executionAttempt: Number(row.execution_attempt || 1),
      workerTokenDigest: row.worker_token_digest || undefined,
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      publicationMode: publicationMode(row.publication_mode),
      authoritativeGateAppId: row.authoritative_gate_app_id == null ? undefined : Number(row.authoritative_gate_app_id),
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
            AND authoritative_gate_app_id IS NULL
            AND terminal_deadline <= to_timestamp($2 / 1000.0)
            AND (runs.lease_expires_at IS NULL OR runs.lease_expires_at <= to_timestamp($2 / 1000.0))
          -- A historical failure-publication backlog must not delay recovery of
          -- a run that is still active in durable dispatch state. Sweep newly
          -- expired queued/running work first, then retain FIFO within each class.
          ORDER BY CASE WHEN runs.status IN ('queued', 'running') THEN 0 ELSE 1 END,
                   runs.terminal_deadline
          FOR UPDATE OF runs, outbox SKIP LOCKED
          LIMIT $3
       ), retired AS (
         UPDATE review_dispatch_outbox AS outbox
            SET status = CASE WHEN outbox.status = 'projected' OR outbox.worker_token_digest IS NOT NULL
                         THEN 'projected' ELSE 'terminal' END,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($2 / 1000.0)
           FROM candidate WHERE outbox.run_id = candidate.run_id
         RETURNING outbox.run_id, outbox.execution_attempt
       )
       UPDATE review_runs AS runs
          SET status = 'terminal', updated_at = to_timestamp($2 / 1000.0),
              lease_owner = $1::text, lease_expires_at = to_timestamp(($2 + 60000) / 1000.0),
              error_text = 'publishing run reached its terminal deadline without a verdict; reaped by ' || $1::text
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
            AND runs.authoritative_gate_app_id IS NULL
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

  async heartbeat(runId: string, workerId: string, claimAttempt: number, now: number, leaseMs: number): Promise<boolean> {
    validateClaimAttempt(claimAttempt);
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET lease_expires_at = to_timestamp(($3 + $4) / 1000.0), updated_at = to_timestamp($3 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND attempt = $5
          AND lease_expires_at > to_timestamp($3 / 1000.0)
          AND EXISTS (SELECT 1 FROM review_runs AS runs
            WHERE runs.run_id = review_dispatch_outbox.run_id
              AND runs.terminal_deadline > to_timestamp($3 / 1000.0))
      RETURNING run_id`,
      [runId, workerId, now, leaseMs, claimAttempt],
    );
    return result.rows.length > 0;
  }

  async markProjected(
    runId: string,
    workerId: string,
    claimAttempt: number,
    projectionName: string,
    now: number,
    workerTokenDigest?: string,
  ): Promise<boolean> {
    validateClaimAttempt(claimAttempt);
    if (workerTokenDigest !== undefined && !/^[a-f0-9]{64}$/u.test(workerTokenDigest)) {
      throw new Error('worker token digest must be 64 lowercase hex characters');
    }
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'projected', projection_name = $3, worker_token_digest = COALESCE($5, worker_token_digest),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = to_timestamp($4 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND attempt = $6
          AND lease_expires_at > to_timestamp($4 / 1000.0)
          AND EXISTS (SELECT 1 FROM review_runs AS runs
            WHERE runs.run_id = review_dispatch_outbox.run_id
              AND runs.terminal_deadline > to_timestamp($4 / 1000.0))
          AND ($5::text IS NULL OR worker_token_digest IS NULL OR worker_token_digest = $5)
      RETURNING run_id`,
      [runId, workerId, projectionName, now, workerTokenDigest || null, claimAttempt],
    );
    return result.rows.length > 0;
  }

  async bindWorkerTokenDigest(runId: string, workerId: string, claimAttempt: number, workerTokenDigest: string, now: number): Promise<boolean> {
    validateClaimAttempt(claimAttempt);
    if (!/^[a-f0-9]{64}$/u.test(workerTokenDigest)) {
      throw new Error('worker token digest must be 64 lowercase hex characters');
    }
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET worker_token_digest = COALESCE(worker_token_digest, $3),
              updated_at = to_timestamp($4 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND attempt = $5
          AND lease_expires_at > to_timestamp($4 / 1000.0)
          AND EXISTS (SELECT 1 FROM review_runs AS runs
            WHERE runs.run_id = review_dispatch_outbox.run_id
              AND runs.terminal_deadline > to_timestamp($4 / 1000.0))
          AND (worker_token_digest IS NULL OR worker_token_digest = $3)
      RETURNING run_id`,
      [runId, workerId, workerTokenDigest, now, claimAttempt],
    );
    return result.rows.length > 0;
  }

  async releaseForRetry(runId: string, workerId: string, claimAttempt: number, now: number, availableAt: number): Promise<boolean> {
    validateClaimAttempt(claimAttempt);
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              available_at = to_timestamp($4 / 1000.0), updated_at = to_timestamp($3 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND attempt = $5
          AND lease_expires_at > to_timestamp($3 / 1000.0)
          AND EXISTS (SELECT 1 FROM review_runs AS runs
            WHERE runs.run_id = review_dispatch_outbox.run_id
              AND runs.terminal_deadline > to_timestamp($3 / 1000.0))
      RETURNING run_id`,
      [runId, workerId, now, availableAt, claimAttempt],
    );
    return result.rows.length > 0;
  }

  async markTerminal(runId: string, workerId: string, claimAttempt: number, now: number, error: string,
    diagnostics?: WorkerFailureDiagnostics): Promise<boolean> {
    validateClaimAttempt(claimAttempt);
    const failureDiagnostics = diagnostics
      ? JSON.stringify(buildDurableWorkerFailureDiagnostics('internal_error', diagnostics)) : null;
    const result = await this.queryable.query(
      `WITH terminalized AS (
         UPDATE review_dispatch_outbox
            -- A bound token means the worker may exist despite a lost projection
            -- ACK. Retain that evidence so explicit admission rotates execution.
            SET status = CASE WHEN worker_token_digest IS NOT NULL THEN 'projected' ELSE 'terminal' END,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($3 / 1000.0)
          WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
            AND attempt = $5
            AND lease_expires_at > to_timestamp($3 / 1000.0)
            AND EXISTS (SELECT 1 FROM review_runs AS runs
              WHERE runs.run_id = review_dispatch_outbox.run_id
                AND runs.terminal_deadline > to_timestamp($3 / 1000.0))
        RETURNING run_id
       )
       UPDATE review_runs AS runs
          SET status = 'failed', error_text = $4, failure_diagnostics = COALESCE($6::jsonb, failure_diagnostics), lease_owner = NULL,
              lease_expires_at = NULL, updated_at = to_timestamp($3 / 1000.0)
         FROM terminalized
        WHERE runs.run_id = terminalized.run_id AND runs.status = 'queued'
      RETURNING runs.run_id`,
      [runId, workerId, now, error, claimAttempt, failureDiagnostics],
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
        reviewDispatchPrLockKey(input.repositoryId, input.prNumber),
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
    const safeDiagnostics = buildDurableWorkerFailureDiagnostics(
      input.failureClass, input.diagnostics, input.executionAttempt,
    );
    const current = await client.query(
      `SELECT runs.status, runs.repository_id, runs.owner, runs.repo, runs.pr_number,
              runs.head_sha, runs.base_sha, runs.effective_policy_digest,
              runs.effective_config_digest, runs.publication_mode, runs.authoritative_gate_app_id,
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
      && row.authoritative_gate_app_id == null
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
          SET status = 'failed', error_text = $2, failure_diagnostics = $3::jsonb, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = to_timestamp($4 / 1000.0)
        FROM review_dispatch_outbox AS outbox
        WHERE runs.run_id = $1
          AND outbox.run_id = runs.run_id
          AND runs.owner = $5
          AND runs.repo = $6
          AND runs.pr_number = $7
          AND runs.head_sha = $8
          AND runs.base_sha = $9
          AND runs.repository_id = $10
          AND runs.effective_policy_digest = $11
          AND runs.effective_config_digest = $12
          AND runs.publication_mode = 'app-gate'
          AND runs.status IN ('queued', 'running')
          AND outbox.status = 'projected'
          AND outbox.execution_attempt + 1 = $13
          AND outbox.worker_token_digest = $14
        RETURNING runs.run_id`,
      [
        input.runId,
        safeError,
        JSON.stringify(safeDiagnostics),
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
