import { timingSafeEqual } from 'node:crypto';
import type { WorkerReviewEvidence } from '../review/workerReviewCompletion';
import { sha256 } from '../review/reviewCore';
import { deriveReviewRunId } from '../review/reviewAdmission';
import { assertTerminalDeadlineWindow } from '../config/terminalDeadline';
import type { RunRetryContext } from '../review/recoverablePanelRetry';
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
  workerTerminalSuccessDigest,
  type DelegatedFailureReason,
  type WorkerCompletionProof, type WorkerFailureDiagnostics, type WorkerTerminalFailure, type WorkerTerminalSuccess,
} from '../review/workerCompletion';
import { buildAuthoritativeReviewIdentity } from '../review/authoritativeReviewIdentity';
import { savePreparedPublishingPolicy } from './preparedReviewRepository';
import { PostgresReviewGateRepository } from './reviewGateRepository';
import { reviewDispatchPrLockKey } from './reviewCiPersistence';
import {
  appendLifecycleEventForRun,
  requireLifecycleEventsMode,
  type ReviewEventQueryable,
  type ReviewLifecycleEventsOptions,
} from './reviewEventRepository';
import { getMetrics } from '../telemetry/metrics';
import { logger } from '../utils/logger';
import {
  ReviewGenerationRecoveryLedgerError,
  validateReviewGenerationRecoveryEvidence,
  type ReviewGenerationRecoveryEvidence,
  type ReviewGenerationRecoveryRequest,
} from '../review/reviewGenerationRecovery';

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
  query?(text: string, values?: unknown[]): Promise<QueryResult>;
}

/** Prefix for the bounded worker failure classification persisted in error_text. */
export const WORKER_TERMINAL_FAILURE_PREFIX = 'worker terminal failure: ';

/** Marker for a check create whose response was lost; recovery may only look up the exact attempt. */
export const RECOVERY_UNCONFIRMED_ERROR_TEXT =
  'publishing run reached its terminal deadline without a verdict; failure creation unconfirmed';

/** A legacy row with incoherent delivery identities cannot be published safely. */
export const DELIVERY_IDENTITY_MISMATCH_ERROR_TEXT =
  'publishing run delivery identity mismatch; quarantined by reaper';
export const DELIVERY_IDENTITY_MISMATCH_REASON = 'dispatch_delivery_identity_mismatch';

/** A completed newer App-owned same-head check makes this old attempt obsolete, not successful. */
export const SUPERSEDED_PUBLISHING_ERROR_TEXT =
  'publishing run superseded by a newer publisher-owned same-head check; retired by reaper';
export const SUPERSEDED_PUBLISHING_REASON = 'superseded_publisher_owned_check';

/**
 * The single source of truth for which publication modes have a worker
 * check to fail closed. claimAbandonedPublishingRuns claims exactly the
 * modes in this list; retireExpiredNonPublishableRuns retires exactly the
 * complement. Both queries filter against this one array (`= ANY` /
 * `<> ALL`) instead of two independently hand-maintained literals, so the
 * partition cannot silently diverge if a future publication mode is added.
 */
export const PUBLISHABLE_PUBLICATION_MODES = ['app-gate'] as const;

/**
 * A non-'app-gate' run (currently only 'disabled') has no App check to fail
 * closed: REL-586's publishing reaper exists to fail a check that a worker
 * never created, and a disabled-mode run never had one to begin with. Left
 * alone, a run that is never claimed before its deadline (token mint failure,
 * capacity, workspace contention, or simply no worker ever dispatched) stays
 * 'queued'/'running' forever -- unreachable by claimAbandonedPublishingRuns,
 * which only claims 'app-gate' rows. This is the terminal text for the
 * separate sweep that retires those rows without minting a token or calling
 * GitHub.
 */
export const NON_PUBLISHABLE_DEADLINE_ERROR_TEXT =
  'publication mode disabled: never claimed before its terminal deadline; retired by reaper';

/**
 * REL-896: a pull request that closes (merged or not) while its review run is
 * still queued/running has no further use for that run. Left alone it waits
 * for the ordinary terminal deadline and claimAbandonedPublishingRuns then
 * mints a fail-closed GitHub check on a PR that is no longer open. These two
 * error texts are deliberately distinct from every prefix or exact string
 * claimAbandonedPublishingRuns and retireExpiredNonPublishableRuns key on
 * (RECOVERY_UNCONFIRMED_ERROR_TEXT, the reapedPrefix, WORKER_TERMINAL_FAILURE_PREFIX),
 * and terminalizeRunsForClosedPullRequest always leaves the row in status
 * 'terminal' rather than 'queued'/'running'/'failed' -- both reapers'
 * candidate predicates require one of those other statuses (or a matching
 * text) before they touch a row, so a closed-PR row is invisible to both by
 * construction and never gets a check minted for it.
 */
export const PULL_REQUEST_CLOSED_ERROR_TEXT =
  'pull request closed before the review completed';
export const PULL_REQUEST_MERGED_ERROR_TEXT =
  'pull request merged before the review completed';

/** Lease cadence for lookup-only recovery after a check-create response is lost. */
export const ABANDONED_RECOVERY_LEASE_MS = 60_000;

export interface ReviewDispatchRepositoryOptions extends ReviewLifecycleEventsOptions {
  /** Trusted service read/validation only; invoked under the candidate's PR lock before any admission writes. */
  validateAuthoritativeAdmission?: (input: ReviewAdmissionInput) => Promise<void>;
  /** Defaults to 30 seconds; safe integer values are clamped to 250–30,000 ms. */
  admissionValidationTimeoutMs?: number;
  /** Require central app-gate callers to supply the exact generation. */
  requireExpectedGeneration?: boolean;
  /** Re-reads the App-owned GitHub worker ledger before the admission transaction after proven service-state loss. */
  resolveGenerationRecovery?: (input: ReviewAdmissionInput) => Promise<ReviewGenerationRecoveryEvidence[]>;
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
    burstStartedAt: row.burst_started_at ? milliseconds(row.burst_started_at) : undefined,
    cancelRequestedAt: row.cancel_requested_at ? milliseconds(row.cancel_requested_at) : undefined,
    cancelReason: row.cancel_reason || undefined,
    cancelPropagatedAt: row.cancel_propagated_at ? milliseconds(row.cancel_propagated_at) : undefined,
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
  if (typeof input.centralActionDispatch !== 'boolean'
    || (input.centralActionDispatch && !['repository_dispatch', 'workflow_dispatch'].includes(input.eventName))) {
    throw new Error('central Action dispatch classification is invalid');
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
  if (input.availableAt !== undefined
    && (!Number.isSafeInteger(input.availableAt) || input.availableAt < input.receivedAt)) {
    throw new Error('available-at must be a safe integer at or after receivedAt');
  }
  if (input.expectedGeneration !== undefined
    && (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration <= 0)) {
    throw new Error('expected generation must be a positive integer');
  }
  if (input.publicationMode === 'app-gate'
    && input.centralActionDispatch
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

function generationRecoveryRequest(
  input: ReviewAdmissionInput,
  runId: string,
): ReviewGenerationRecoveryRequest {
  const expected = input.expectedGeneration;
  if (!input.centralActionDispatch || input.publicationMode !== 'app-gate'
    || !input.authoritativeGate || input.retryRequested !== true
    || expected === undefined || expected < 2
    || input.retryAfterExecutionAttempt !== expected - 1) {
    throw new ReviewGenerationConflictError(expected ?? 1, 1);
  }
  return {
    owner: input.identity.owner,
    repo: input.identity.repo,
    headSha: input.identity.headSha,
    runId,
    expectedGeneration: expected,
    expectedAppId: input.authoritativeGate.expectedAppId,
  };
}

function validateGenerationRecovery(
  input: ReviewAdmissionInput,
  runId: string,
  evidence: ReviewGenerationRecoveryEvidence[],
): void {
  const request = generationRecoveryRequest(input, runId);
  try {
    validateReviewGenerationRecoveryEvidence(request, evidence);
  } catch (error) {
    if (error instanceof ReviewGenerationRecoveryLedgerError) {
      throw new ReviewGenerationConflictError(request.expectedGeneration, 1);
    }
    throw error;
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
  /** The run-side delivery identity. Legacy rows may have no run-side binding. */
  deliveryId?: string;
  executionAttempt: number;
  receivedAt: number;
  terminalDeadline: number;
  /** A prior create response was lost. Recovery may observe, but never recreate, that exact attempt. */
  recoveryOnly?: boolean;
  /** Claim-time evidence that the run and outbox point at different deliveries. */
  deliveryIdentityMismatch?: boolean;
  /**
   * REL-896: set only when this claim matched a candidate from the Go
   * operator's delegated-failure signal (see
   * `src/k8s/delegatedFailureReader.ts`) rather than an expired
   * `terminal_deadline`. Carries the operator's exact classification so the
   * published check and persisted diagnostics can report it instead of the
   * generic deadline text.
   */
  delegatedReason?: DelegatedFailureReason;
}

/** A run the Go operator has already observed failing, killed, missing, or
 * past deadline -- see `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go`
 * `reconcileFailurePublication` -- offered to `claimAbandonedPublishingRuns`
 * so it may claim the exact attempt before `terminal_deadline` elapses. */
export interface DelegatedFailureCandidateInput {
  runId: string;
  executionAttempt: number;
  reason: DelegatedFailureReason;
}

const ABANDONED_CHECK_RECOVERY_OUTCOMES = [
  'authoritative-success',
  'failure-existing',
  'failure-published',
  'creation-unconfirmed',
  'superseded',
] as const;

export type AbandonedCheckRecoveryOutcome = typeof ABANDONED_CHECK_RECOVERY_OUTCOMES[number];

const ABANDONED_PUBLISHING_ERROR_TEXT = {
  reapedPrefix: 'publishing run reached its terminal deadline without a verdict; reaped by ',
  failureReconciled: 'publishing run reached its terminal deadline without a verdict; failure reconciled',
} as const;

const ABANDONED_CHECK_RECOVERY_OUTCOME_SET: ReadonlySet<string> = new Set(ABANDONED_CHECK_RECOVERY_OUTCOMES);

function isAbandonedCheckRecoveryOutcome(value: unknown): value is AbandonedCheckRecoveryOutcome {
  return typeof value === 'string'
    && ABANDONED_CHECK_RECOVERY_OUTCOME_SET.has(value);
}

export type AbandonedRunReconciliationOutcome = AbandonedCheckRecoveryOutcome | 'quarantined';

/**
 * Explicit result of reconciling one claimed abandoned attempt. A stale claim
 * is not acknowledged; a reconciled claim reports whether it published a
 * recovery outcome or was quarantined without publication.
 */
export type AbandonedRunReconciliation =
  | { reconciled: false }
  | { reconciled: true; outcome: AbandonedRunReconciliationOutcome };

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
  /** Read-only run metadata the recoverable-panel-retry service needs to
   * decide whether a fresh execution attempt may be re-admitted. Returns
   * `null` when the run no longer exists. Never transitions the run. */
  readRunRetryContext(runId: string): Promise<RunRetryContext | null>;
  /** Terminalize a legacy run only after its worker published a green check. */
  markWorkerSuccess(input: WorkerTerminalSuccess, proof: WorkerCompletionProof, now?: number): Promise<WorkerSuccessTransition>;
  /** Whether a WorkerReviewEvidence.v1 is bound to this run's current worker
   * execution: same token digest and coordinates a terminal callback must
   * present. Read-only; it never transitions the run. */
  authorizeWorkerEvidence(input: WorkerReviewEvidence, proof: WorkerCompletionProof): Promise<WorkerEvidenceAuthorization>;
  /**
   * REL-586: reconcile owned publishing failures immediately, then expired
   * runs. REL-896: an optional bounded list of operator-delegated candidates
   * (runId + the exact executionAttempt the CR observed) makes a queued or
   * running run eligible even before its terminal_deadline elapses -- but
   * only for that exact attempt; a stale candidate from a superseded attempt
   * never matches.
   */
  claimAbandonedPublishingRuns(workerId: string, now: number, limit: number,
    delegated?: DelegatedFailureCandidateInput[]): Promise<AbandonedPublishingRun[]>;
  reconcileAbandonedPublishingRun(run: AbandonedPublishingRun, workerId: string, now: number,
    publish: () => Promise<AbandonedCheckRecoveryOutcome>): Promise<AbandonedRunReconciliation>;
  /**
   * Retire queued/running runs whose publication mode is not 'app-gate' and
   * whose terminal deadline has passed. There is no App check to fail closed
   * for these rows, so this never mints a token or calls GitHub -- it only
   * terminalizes the run and its outbox row. Returns the number retired.
   */
  retireExpiredNonPublishableRuns(now: number, limit: number): Promise<number>;
  /**
   * REL-896: terminalize every queued/running run for this exact repository
   * + pull request when the pull request closes (merged or not). Excludes
   * authoritative-gate rows (`authoritative_gate_app_id IS NOT NULL`), which
   * have their own reaper and publication lifecycle in reviewGateRepository.
   * Never mints or fails a GitHub check -- a closed PR needs no check at
   * all, unlike claimAbandonedPublishingRuns. Idempotent: a redelivered
   * close, or a PR with no matching in-flight run, matches zero rows and
   * returns an empty list rather than throwing.
   */
  terminalizeRunsForClosedPullRequest(input: {
    repositoryId: number;
    owner: string;
    repo: string;
    prNumber: number;
    merged: boolean;
    now: number;
    /** The webhook delivery that triggered this closure; accepted for the
     * caller's audit trail but not persisted -- idempotency here is
     * structural (only 'queued'/'running' rows ever match), not delivery-keyed. */
    deliveryId: string;
  }): Promise<{ terminalizedRunIds: string[] }>;
  /**
   * Advance a debounced outbox row's available_at to now for on-demand triggers.
   */
  advanceDebounceAvailableAt(
    repositoryIdOrInput: number | { repositoryId: number; prNumber: number; headSha?: string; now?: number },
    prNumber?: number,
    headSha?: string,
    now?: number,
  ): Promise<{ advanced: boolean; runId?: string }>;
  /**
   * Cancel in-flight reviews for a pull request (e.g. converted to draft or opt-out label added).
   */
  cancelRunsForPullRequest(
    repositoryIdOrInput: number | { repositoryId: number; prNumber: number; cancelReason: string; now?: number },
    prNumber?: number,
    cancelReason?: string,
    now?: number,
  ): Promise<{ cancelledRunIds: string[] }>;
  /**
   * Mark cancellation as propagated to Kubernetes / worker pod for a specific execution attempt.
   */
  markCancelPropagated(runId: string, executionAttempt: number, now?: number): Promise<boolean>;
  /**
   * Find outbox rows with cancel requested that have not yet been propagated to Kubernetes.
   */
  findPendingCancellations(limit?: number): Promise<PendingCancellation[]>;
  /**
   * Get authenticated status for an execution attempt of a run.
   */
  getRunStatus(runId: string, executionAttempt: number): Promise<RunStatusResult | null>;
}

export interface PendingCancellation {
  runId: string;
  executionAttempt: number;
  projectionName: string;
  cancelReason?: string;
}

export interface RunStatusResult {
  current: boolean;
  status: string;
  cancelRequested: boolean;
  cancelReason?: string;
  currentHeadSha?: string;
  isCurrentHead: boolean;
  workerTokenDigest?: string;
}

export interface WorkerFailureTransition {
  runId: string;
  status: 'failed' | 'already_failed' | 'ignored' | 'unauthorized';
}

export interface WorkerSuccessTransition {
  runId: string;
  status: 'succeeded' | 'already_succeeded' | 'conflict' | 'ignored' | 'unauthorized';
}

export interface WorkerEvidenceAuthorization {
  runId: string;
  status: 'authorized' | 'unauthorized' | 'ignored';
}

function validateClaimAttempt(claimAttempt: number): void {
  if (!Number.isSafeInteger(claimAttempt) || claimAttempt <= 0) {
    throw new Error('dispatcher claim attempt must be a positive integer');
  }
}

function dispatchClaimPredicate(timeParameter: string): string {
  return `runs.status = 'queued'
              AND (runs.authoritative_gate_app_id IS NULL OR EXISTS (
                SELECT 1 FROM review_gate_attempts gate WHERE gate.run_id = runs.run_id
                  AND gate.current_attempt AND gate.review_generation = runs.attempt
                  AND gate.execution_attempt = outbox.execution_attempt + 1
                  AND gate.expected_app_id = runs.authoritative_gate_app_id
                  AND gate.creation_state = 'bound' AND gate.check_id IS NOT NULL
                  AND gate.desired_state IN ('queued', 'in_progress')
                  AND gate.published_version = gate.desired_version
              ))
              AND runs.terminal_deadline > to_timestamp(${timeParameter} / 1000.0)
              AND outbox.available_at <= to_timestamp(${timeParameter} / 1000.0)
              AND (outbox.status = 'pending'
                OR (outbox.status = 'claimed' AND outbox.lease_expires_at <= to_timestamp(${timeParameter} / 1000.0)))`;
}

export class PostgresReviewDispatchRepository implements ReviewDispatchRepository {
  private readonly queryable: Queryable;
  private readonly admissionValidationTimeoutMs: number;
  private readonly explicitQueryable: boolean;
  private readonly lifecycleEventsEnabled: boolean;

  constructor(private readonly pool: ConnectionPool, queryable: Queryable | undefined,
    private readonly options: ReviewDispatchRepositoryOptions) {
    this.lifecycleEventsEnabled = requireLifecycleEventsMode(options, 'Review dispatch repository');
    const timeoutMs = options.admissionValidationTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs)
      || (options.validateAuthoritativeAdmission !== undefined && typeof options.validateAuthoritativeAdmission !== 'function')
      || (options.resolveGenerationRecovery !== undefined && typeof options.resolveGenerationRecovery !== 'function')) {
      throw new Error('Invalid authoritative admission validation configuration');
    }
    this.admissionValidationTimeoutMs = Math.min(30_000, Math.max(250, timeoutMs));
    const possiblePool = pool as unknown as Partial<Queryable>;
    this.explicitQueryable = queryable !== undefined;
    if (this.lifecycleEventsEnabled && this.explicitQueryable) {
      throw new Error('Review dispatch lifecycle events require the pool transaction client');
    }
    this.queryable = queryable || (typeof possiblePool.query === 'function' ? possiblePool as Queryable : {
      query: async () => { throw new Error('direct PostgreSQL query interface is unavailable'); },
    });
  }

  private async inTransaction<T>(operation: (client: TransactionClient) => Promise<T>): Promise<T> {
    if (!this.lifecycleEventsEnabled) return operation(this.queryable as TransactionClient);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async appendLifecycle(
    client: ReviewEventQueryable,
    runId: string,
    eventKind: string,
    now: number,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.lifecycleEventsEnabled) return;
    await appendLifecycleEventForRun(client, { runId, eventKind, occurredAt: now, data });
  }

  private async hasClaimableDispatch(now: number): Promise<boolean> {
    const query = (this.pool as unknown as Partial<Queryable>).query;
    if (typeof query !== 'function') {
      throw new Error('Review dispatch lifecycle candidate probe requires the pool query interface');
    }
    const result = await query.call(this.pool,
      `SELECT 1
         FROM review_dispatch_outbox AS outbox
         JOIN review_runs AS runs ON runs.run_id = outbox.run_id
        WHERE ${dispatchClaimPredicate('$1')}
        LIMIT 1`,
      [now],
    );
    return result.rows.length > 0;
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

  private async resolveGenerationRecovery(
    input: ReviewAdmissionInput,
  ): Promise<ReviewGenerationRecoveryEvidence[]> {
    const resolve = this.options.resolveGenerationRecovery;
    if (!resolve) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => resolve(input)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Review generation recovery evidence is unavailable')),
            this.admissionValidationTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof ReviewGenerationRecoveryLedgerError) {
        throw new ReviewGenerationConflictError(input.expectedGeneration ?? 1, 1);
      }
      throw new Error('Review generation recovery evidence is unavailable');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async hasDurableIdentity(identityDigest: string): Promise<boolean> {
    const query = (this.pool as unknown as Partial<Queryable>).query;
    if (typeof query === 'function') {
      const result = await query.call(
        this.pool,
        'SELECT 1 FROM review_runs WHERE identity_digest = $1 LIMIT 1',
        [identityDigest],
      );
      return result.rows.length > 0;
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT 1 FROM review_runs WHERE identity_digest = $1 LIMIT 1',
        [identityDigest],
      );
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  async admit(input: ReviewAdmissionInput): Promise<ReviewAdmission> {
    validateAdmission(input, this.options.requireExpectedGeneration === true);
    if (input.authoritativeGate && !this.options.validateAuthoritativeAdmission) {
      throw new Error('Authoritative admission validator is required');
    }
    const identityDigest = sha256(input.identity);
    const runId = deriveReviewRunId(input.identity);
    let preparedGenerationRecovery: ReviewGenerationRecoveryEvidence[] = [];
    if ((input.expectedGeneration ?? 1) > 1
      && input.retryRequested === true
      && this.options.resolveGenerationRecovery) {
      generationRecoveryRequest(input, runId);
      if (!(await this.hasDurableIdentity(identityDigest))) {
        // This validation is repeated under the PR transaction lock below for
        // atomic admission. The early pass prevents an unauthenticated caller
        // from driving installation-token minting and paginated GitHub reads.
        await this.validateAuthoritativeAdmission(input);
        preparedGenerationRecovery = await this.resolveGenerationRecovery(input);
        validateGenerationRecovery(input, runId, preparedGenerationRecovery);
      }
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
      let generationRecovery: ReviewGenerationRecoveryEvidence[] = [];
      if ((input.expectedGeneration ?? 1) > 1 && input.retryRequested === true) {
        const existingIdentity = await client.query(
          'SELECT attempt FROM review_runs WHERE identity_digest = $1 FOR UPDATE',
          [identityDigest],
        );
        if (existingIdentity.rows.length === 0) {
          if (preparedGenerationRecovery.length > 0) {
            generationRecovery = preparedGenerationRecovery;
          } else if (this.options.resolveGenerationRecovery) {
            throw new ReviewGenerationConflictError(input.expectedGeneration ?? 1, 1);
          }
        }
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

      let burstStartedAt = input.receivedAt;
      let availableAt = input.availableAt ?? input.receivedAt;

      if (input.debounce === true) {
        const priorRun = await client.query(
          `SELECT burst_started_at, received_at
             FROM review_runs
            WHERE owner = $1 AND repo = $2 AND pr_number = $3
            ORDER BY received_at DESC NULLS LAST, created_at DESC
            LIMIT 1`,
          [input.identity.owner, input.identity.repo, input.identity.prNumber],
        );
        const priorRow = priorRun.rows[0];
        if (priorRow) {
          const priorBurst = priorRow.burst_started_at
            ? milliseconds(priorRow.burst_started_at)
            : milliseconds(priorRow.received_at);
          if (priorBurst !== undefined && (input.receivedAt - priorBurst) <= 300_000 && (input.receivedAt - priorBurst) >= 0) {
            burstStartedAt = priorBurst;
          }
        }
        availableAt = Math.min(input.receivedAt + 60_000, burstStartedAt + 300_000);
      } else if (input.debounce === false) {
        availableAt = input.receivedAt;
      }

      const inserted = await client.query(
         `WITH retry_eligibility AS (
           SELECT runs.run_id,
                  (runs.status = 'terminal' AND runs.error_text = $22::text)
                    AS retry_from_reaper_failure,
                  (runs.status IN ('failed', 'terminal') AND (
                    NOT $20::boolean OR (
                      $21::integer IS NOT NULL AND EXISTS (
                        SELECT 1 FROM review_dispatch_outbox AS retry_outbox
                         WHERE retry_outbox.run_id = runs.run_id
                           AND retry_outbox.execution_attempt + 1 = $21::integer
                           AND (retry_outbox.status = 'projected'
                             OR (retry_outbox.status = 'terminal'
                               AND (retry_outbox.worker_token_digest IS NOT NULL
                                 OR retry_outbox.projection_name IS NOT NULL
                                 OR runs.error_text = $22::text)))
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
            burst_started_at, created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $11, $12,
            'queued', 'admission', $24, '{}'::jsonb, $13, $14, $15,
            to_timestamp($16 / 1000.0), to_timestamp($17 / 1000.0), $18, $19,
            to_timestamp($23 / 1000.0), to_timestamp($16 / 1000.0), to_timestamp($16 / 1000.0))
         ON CONFLICT (identity_digest) DO UPDATE
           SET updated_at = review_runs.updated_at,
               burst_started_at = COALESCE(review_runs.burst_started_at, EXCLUDED.burst_started_at),
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
         RETURNING *, (SELECT retry_from_reaper_failure FROM retry_eligibility
           WHERE run_id = review_runs.run_id) AS retry_from_reaper_failure`,
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
          ABANDONED_PUBLISHING_ERROR_TEXT.failureReconciled,
          burstStartedAt,
          generationRecovery.length,
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
        const superseded = await client.query(
          `WITH superseded AS (
             UPDATE review_runs
                SET status = 'superseded',
                    error_text = 'superseded by a newer review identity',
                    cancel_requested_at = to_timestamp($5 / 1000.0),
                    cancel_reason = 'superseded_by_new_head',
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
              SET status = 'terminal',
                  cancel_requested_at = to_timestamp($5 / 1000.0),
                  cancel_reason = 'superseded_by_new_head',
                  cancel_propagated_at = CASE WHEN outbox.projection_name IS NULL THEN to_timestamp($5 / 1000.0) ELSE NULL END,
                  lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($5 / 1000.0)
            WHERE outbox.run_id IN (SELECT run_id FROM superseded)
           RETURNING outbox.run_id, outbox.cancel_propagated_at`,
          [input.identity.owner, input.identity.repo, input.identity.prNumber, identityDigest, input.receivedAt,
            runRow.authoritative_gate_app_id != null],
        );
        for (const supersededRow of superseded.rows) {
          if (supersededRow.cancel_propagated_at) {
            await client.query(
              `UPDATE review_runs SET cancel_propagated_at = to_timestamp($2 / 1000.0) WHERE run_id = $1`,
              [supersededRow.run_id, input.receivedAt],
            );
          }
          await this.appendLifecycle(client, String(supersededRow.run_id), 'review.lifecycle.superseded', input.receivedAt,
            { stage: 'superseded', terminal_class: 'candidate_superseded' });
        }
      }

      await client.query(
        'UPDATE github_deliveries SET run_id = $2 WHERE delivery_id = $1',
        [input.deliveryId, runRow.run_id],
      );
      await client.query(
        `INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, execution_attempt, available_at, created_at, updated_at)
         VALUES ($1, $2, 'pending', $6, to_timestamp($5 / 1000.0), to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))
         ON CONFLICT (run_id) DO UPDATE
           SET status = 'pending', delivery_id = EXCLUDED.delivery_id,
               available_at = EXCLUDED.available_at, lease_owner = NULL,
               lease_expires_at = NULL, projection_name = NULL,
         -- Re-arm only alongside a run the statement above just returned to
         -- 'queued'. A worker provider failure leaves the outbox 'projected'
         -- and needs a new execution attempt. A terminal dispatch with token or
         -- projection evidence may also have created a worker before losing its
         -- acknowledgement. An exact reaper-failure marker proves the App check
         -- already consumed that otherwise pre-worker attempt. Guarding on the
         -- run's status keeps a superseded run's terminal outbox row untouched.
               execution_attempt = CASE WHEN review_dispatch_outbox.status = 'projected'
                 OR review_dispatch_outbox.worker_token_digest IS NOT NULL
                 OR review_dispatch_outbox.projection_name IS NOT NULL
                 OR ($4::boolean AND review_dispatch_outbox.status = 'terminal')
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
        [runRow.run_id, input.deliveryId, input.receivedAt, runRow.retry_from_reaper_failure === true,
          availableAt, generationRecovery.length],
      );
      for (const evidence of generationRecovery) {
        await client.query(
          `INSERT INTO review_generation_recoveries
             (run_id, recovered_generation, worker_check_id, external_id, conclusion, title, evidence, recovered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, to_timestamp($8 / 1000.0))`,
          [runRow.run_id, evidence.generation, evidence.checkId, evidence.externalId,
            evidence.conclusion, evidence.title, JSON.stringify(evidence), input.receivedAt],
        );
      }
      if (input.authoritativeGate && ['queued', 'running'].includes(runRow.status)) {
        const gate = await PostgresReviewGateRepository.reserveInTransaction(
          client, runRow.run_id, input.authoritativeGate.expectedAppId, input.receivedAt);
        if (!gate) throw new Error('Authoritative dispatch has no durable gate reservation');
      }
      await this.appendLifecycle(client, String(runRow.run_id), 'review.lifecycle.admission', input.receivedAt,
        { stage: 'admission', policy_digest: input.effectivePolicyDigest || input.identity.configDigest });
      if (generationRecovery.length > 0) {
        await this.appendLifecycle(client, String(runRow.run_id), 'review.lifecycle.generation_reconciled', input.receivedAt,
          { stage: 'admission', retry_class: 'service_state_loss_reconciled',
            evidence_pointers: generationRecovery.map((entry) => `github-check-run:${entry.checkId}:a${entry.generation}`) });
      }
      await this.appendLifecycle(client, String(runRow.run_id), 'review.lifecycle.queued', input.receivedAt,
        { stage: 'queued', policy_digest: input.effectivePolicyDigest || input.identity.configDigest });
      if (Number(runRow.attempt || 0) > 0) {
        await this.appendLifecycle(client, String(runRow.run_id), 'review.lifecycle.retrying', input.receivedAt,
          { stage: 'admission', retry_class: 'same_identity_redelivery' });
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
    if (this.lifecycleEventsEnabled && !(await this.hasClaimableDispatch(now))) return null;
    const claim = async (client: Queryable): Promise<ReviewDispatchClaim | null> => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT outbox.run_id, runs.publication_mode, runs.authoritative_gate_app_id, runs.owner, runs.repo,
                  runs.pr_number, runs.head_sha, runs.base_sha, runs.received_at,
                  runs.terminal_deadline, runs.effective_policy_digest,
                  runs.effective_config_digest
             FROM review_dispatch_outbox AS outbox
             JOIN review_runs AS runs ON runs.run_id = outbox.run_id
            WHERE ${dispatchClaimPredicate('$2')}
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
      if (!row) return null;
      await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.dispatched', now,
        { stage: 'dispatch' });
      return {
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
      };
    };
    if (!this.lifecycleEventsEnabled) return claim(this.queryable);
    return this.inTransaction((client) => claim(client));
  }

  async claimAbandonedPublishingRuns(
    workerId: string,
    now: number,
    limit: number,
    delegated?: DelegatedFailureCandidateInput[],
  ): Promise<AbandonedPublishingRun[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('reaper limit must be a positive integer');
    const delegatedRunIds: string[] = [];
    const delegatedExecutionAttempts: number[] = [];
    const delegatedReasons: string[] = [];
    for (const candidate of delegated || []) {
      delegatedRunIds.push(candidate.runId);
      delegatedExecutionAttempts.push(candidate.executionAttempt);
      delegatedReasons.push(candidate.reason);
    }
    // A failure to reach GitHub must remain retryable. Claim with a short lease;
    // only successful reconciliation removes the pending-publication marker.
    return this.inTransaction(async (client) => {
      const result = await client.query(
        `WITH delegated_candidate AS (
         -- DISTINCT ON collapses a duplicate (run_id, execution_attempt) pair
         -- in the caller's candidate list (e.g. two DelegatedFailureReader
         -- poll pages observing the same resource) down to one row before
         -- the LEFT JOIN below. Note this is about *which reason* is
         -- attached to the claim, not about claiming the run twice: even
         -- without DISTINCT ON, Postgres's UPDATE ... FROM only applies one
         -- (unspecified) matching FROM row per target row, so a duplicate
         -- input never fans out into two claimed rows -- it just makes the
         -- surviving reason arbitrary and unpredictable. WITH ORDINALITY +
         -- the explicit ORDER BY replace that arbitrary pick with a
         -- deterministic one: the candidate earliest in the caller-supplied
         -- array order (i.e. the one DelegatedFailureReader.listCandidates()
         -- paged in first) wins.
         SELECT DISTINCT ON (run_id, execution_attempt) run_id, execution_attempt, reason
           FROM unnest($7::text[], $8::integer[], $9::text[])
             WITH ORDINALITY AS delegated_candidate(run_id, execution_attempt, reason, ordinal)
          ORDER BY run_id, execution_attempt, ordinal
       ), candidate AS (
         SELECT runs.run_id,
                runs.error_text = $4::text
                  AS recovery_only,
                runs.delivery_id IS DISTINCT FROM outbox.delivery_id
                  AS delivery_identity_mismatch,
                delegated_candidate.reason AS delegated_reason
           FROM review_runs runs
           JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
           LEFT JOIN delegated_candidate ON delegated_candidate.run_id = runs.run_id
             AND delegated_candidate.execution_attempt = outbox.execution_attempt + 1
          WHERE (
            -- A worker callback or token-bound dispatcher terminalization is
            -- already a durable fail-closed outcome. Publish its required check now;
            -- waiting for the original deadline would strand the head until
            -- the same-head retry path is invoked.
            (runs.status = 'failed' AND (
              (outbox.status = 'projected' OR outbox.worker_token_digest IS NOT NULL)
              OR runs.terminal_deadline <= to_timestamp($2 / 1000.0)
            ))
            OR (runs.status IN ('queued', 'running')
              AND runs.terminal_deadline <= to_timestamp($2 / 1000.0))
            -- REL-896: the Go operator has already observed the publishing
            -- worker fail, get killed, disappear, or outlive its deadline and
            -- delegated fail-closed publication to this reaper (see
            -- k8s-operator/controllers/prreviewjob_v1alpha2_controller.go
            -- reconcileFailurePublication). Claiming here -- gated to the
            -- exact executionAttempt the operator observed -- is strictly
            -- additive: every other predicate in this WHERE clause (mode,
            -- result digest, authoritative gate, lease) still applies, and a
            -- stale signal from a superseded attempt can never match because
            -- the join above requires the current outbox execution_attempt.
            OR (runs.status IN ('queued', 'running') AND delegated_candidate.reason IS NOT NULL)
            OR (runs.status = 'terminal' AND runs.error_text LIKE
              $5::text || '%'
              AND runs.terminal_deadline <= to_timestamp($2 / 1000.0))
            OR (runs.status = 'terminal' AND runs.error_text = $4::text)
            -- A preserved worker failure is retryable only while a prior
            -- reaper claim still owns its publication lease. Successful
            -- reconciliation clears that owner without erasing the bounded
            -- worker classification, making the terminal row one-shot.
            OR (runs.status = 'terminal' AND runs.error_text LIKE '${WORKER_TERMINAL_FAILURE_PREFIX}%'
              AND outbox.status = 'projected' AND runs.lease_owner IS NOT NULL)
          )
            AND publication_mode = ANY($6::text[])
            AND result_digest IS NULL
            AND authoritative_gate_app_id IS NULL
            AND (runs.lease_expires_at IS NULL OR runs.lease_expires_at <= to_timestamp($2 / 1000.0))
          -- A durable worker failure is actionable immediately. Keep it ahead of
          -- deadline sweeps so a failed head is not hidden behind old backlog.
          -- Within each class, retain FIFO by the original terminal deadline.
          ORDER BY CASE
                     WHEN runs.status = 'failed' THEN 0
                     WHEN runs.status IN ('queued', 'running') THEN 1
                     ELSE 2
                   END,
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
         RETURNING outbox.run_id, outbox.execution_attempt, candidate.recovery_only,
                   candidate.delivery_identity_mismatch, candidate.delegated_reason
       )
       UPDATE review_runs AS runs
          SET status = 'terminal', updated_at = to_timestamp($2 / 1000.0),
              lease_owner = $1::text, lease_expires_at = to_timestamp(($2 + ${ABANDONED_RECOVERY_LEASE_MS}) / 1000.0),
              error_text = CASE
                WHEN retired.recovery_only
                  THEN $4::text
                WHEN runs.error_text LIKE '${WORKER_TERMINAL_FAILURE_PREFIX}%'
                  THEN runs.error_text
                ELSE $5::text || $1::text
              END
         FROM retired
        WHERE runs.run_id = retired.run_id
       RETURNING runs.run_id, runs.owner, runs.repo, runs.pr_number, runs.head_sha,
                 runs.delivery_id, runs.received_at, runs.terminal_deadline,
                 retired.execution_attempt + 1 AS execution_attempt, retired.recovery_only,
                 retired.delivery_identity_mismatch, retired.delegated_reason`,
      [workerId, now, limit, RECOVERY_UNCONFIRMED_ERROR_TEXT,
        ABANDONED_PUBLISHING_ERROR_TEXT.reapedPrefix, PUBLISHABLE_PUBLICATION_MODES as unknown as string[],
        delegatedRunIds, delegatedExecutionAttempts, delegatedReasons],
    );
      for (const row of result.rows as Record<string, unknown>[]) {
        await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'publishing_deadline', retry_class: 'reaper' });
      }
      return result.rows.map((row: Record<string, unknown>) => ({
        runId: String(row.run_id),
        owner: String(row.owner),
        repo: String(row.repo),
        prNumber: Number(row.pr_number),
        headSha: String(row.head_sha),
        ...(row.delivery_id == null ? {} : { deliveryId: String(row.delivery_id) }),
        executionAttempt: Number(row.execution_attempt),
        receivedAt: milliseconds(row.received_at) || 0,
        terminalDeadline: milliseconds(row.terminal_deadline) || 0,
        recoveryOnly: row.recovery_only === true,
        ...(row.delivery_identity_mismatch === true ? { deliveryIdentityMismatch: true } : {}),
        ...(typeof row.delegated_reason === 'string'
          ? { delegatedReason: row.delegated_reason as DelegatedFailureReason } : {}),
      }));
    });
  }

  /**
   * Sweep queued/running runs that can never be published: their mode is not
   * 'app-gate', so no worker check exists (or ever will) for this reaper to
   * fail closed. Distinct from claimAbandonedPublishingRuns, which requires
   * publication_mode = 'app-gate' and mints a fail-closed GitHub check --
   * widening that query to include non-publishable rows would either skip
   * publication for them (wrong: they need none) or attempt to publish a
   * check that can never exist. This method only terminalizes; it never
   * touches GitHub or a worker token. An unowned OR expired lease
   * (lease_owner IS NULL, or lease_expires_at has already passed) keeps
   * this from racing an active dispatcher claim on the same row, while
   * still reclaiming a row whose claimant died without releasing it --
   * mirroring the same expired-lease-is-unowned treatment
   * claimAbandonedPublishingRuns applies to review_runs.lease_expires_at
   * and dispatchClaimPredicate applies to the outbox lease.
   */
  async retireExpiredNonPublishableRuns(now: number, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('reaper limit must be a positive integer');
    return this.inTransaction(async (client) => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT runs.run_id
             FROM review_runs runs
             JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
            WHERE runs.status IN ('queued', 'running')
              AND runs.publication_mode <> ALL($4::text[])
              AND runs.terminal_deadline <= to_timestamp($1 / 1000.0)
              AND (runs.lease_owner IS NULL OR runs.lease_expires_at <= to_timestamp($1 / 1000.0))
              AND runs.authoritative_gate_app_id IS NULL
              AND runs.result_digest IS NULL
            ORDER BY runs.terminal_deadline
            FOR UPDATE OF runs, outbox SKIP LOCKED
            LIMIT $2
         ), retired_outbox AS (
           UPDATE review_dispatch_outbox AS outbox
              SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($1 / 1000.0)
             FROM candidate WHERE outbox.run_id = candidate.run_id
           RETURNING outbox.run_id
         )
         UPDATE review_runs AS runs
            SET status = 'terminal', stage = 'terminal',
                error_text = $3::text, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($1 / 1000.0)
           FROM retired_outbox
          WHERE runs.run_id = retired_outbox.run_id
         RETURNING runs.run_id`,
        [now, limit, NON_PUBLISHABLE_DEADLINE_ERROR_TEXT, PUBLISHABLE_PUBLICATION_MODES as unknown as string[]],
      );
      for (const row of result.rows as Record<string, unknown>[]) {
        await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'non_publishable_deadline', retry_class: 'reaper' });
      }
      return result.rows.length;
    });
  }

  /**
   * REL-896: a closed (merged or not) pull request has no further use for an
   * in-flight review run. This mirrors admit()'s own supersede CTE -- same
   * per-repository/PR advisory lock (so a concurrent admit()/markWorkerFailure/
   * markWorkerSuccess for this PR cannot interleave with this transition),
   * same unconditional outbox terminalization regardless of the outbox's
   * current lease/claim state. A worker still executing when the PR closes
   * is not interrupted mid-request; its eventual markWorkerSuccess/
   * markWorkerFailure/evidence callback simply finds the run already
   * 'terminal' and is rejected as already_failed/conflict/unauthorized by
   * those methods' own status guards, never resurrecting it.
   *
   * Joining review_dispatch_outbox scopes this to rows the outbox-based
   * dispatch flow created via admit(); the separate legacy in-process path
   * (src/app.ts / PostgresReviewRunRepository) never inserts an outbox row,
   * so a legacy row for the same owner/repo/pr_number (out of scope per
   * REL-896) can never match here.
   */
  async terminalizeRunsForClosedPullRequest(input: {
    repositoryId: number;
    owner: string;
    repo: string;
    prNumber: number;
    merged: boolean;
    now: number;
    deliveryId: string;
  }): Promise<{ terminalizedRunIds: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        reviewDispatchPrLockKey(input.repositoryId, input.prNumber),
      ]);
      const errorText = input.merged ? PULL_REQUEST_MERGED_ERROR_TEXT : PULL_REQUEST_CLOSED_ERROR_TEXT;
      const result = await client.query(
        `WITH candidate AS (
           SELECT runs.run_id
             FROM review_runs runs
             JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
            WHERE runs.owner = $1 AND runs.repo = $2 AND runs.pr_number = $3
              AND runs.repository_id = $4
              AND runs.status IN ('queued', 'running')
              -- Authoritative-gate rows have their own reaper and
              -- publication lifecycle (reviewGateRepository); a closed PR
              -- does not terminalize them here.
              AND runs.authoritative_gate_app_id IS NULL
         ), closed AS (
           UPDATE review_runs AS runs
              SET status = 'terminal', stage = 'terminal',
                  error_text = $6::text, lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($5 / 1000.0)
             FROM candidate
            WHERE runs.run_id = candidate.run_id
           RETURNING runs.run_id
         )
         UPDATE review_dispatch_outbox AS outbox
            SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($5 / 1000.0)
           FROM closed
          WHERE outbox.run_id = closed.run_id
         RETURNING outbox.run_id`,
        [input.owner, input.repo, input.prNumber, input.repositoryId, input.now, errorText],
      );
      for (const row of result.rows as Record<string, unknown>[]) {
        await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.terminal', input.now, {
          stage: 'terminal',
          terminal_class: input.merged ? 'pull_request_merged' : 'pull_request_closed',
          retry_class: 'pull_request_closed',
        });
      }
      await client.query('COMMIT');
      return { terminalizedRunIds: result.rows.map((row: Record<string, unknown>) => String(row.run_id)) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async advanceDebounceAvailableAt(
    repositoryIdOrInput: number | { repositoryId: number; prNumber: number; headSha?: string; now?: number },
    prNumberArg?: number,
    headShaArg?: string,
    nowArg?: number,
  ): Promise<{ advanced: boolean; runId?: string }> {
    let repositoryId: number;
    let prNumber: number;
    let headSha: string | undefined;
    let now: number;
    if (typeof repositoryIdOrInput === 'object') {
      repositoryId = repositoryIdOrInput.repositoryId;
      prNumber = repositoryIdOrInput.prNumber;
      headSha = repositoryIdOrInput.headSha;
      now = repositoryIdOrInput.now ?? Date.now();
    } else {
      repositoryId = repositoryIdOrInput;
      prNumber = prNumberArg!;
      headSha = headShaArg;
      now = nowArg ?? Date.now();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        reviewDispatchPrLockKey(repositoryId, prNumber),
      ]);
      const result = await client.query(
        `SELECT outbox.run_id
           FROM review_dispatch_outbox AS outbox
           JOIN review_runs AS runs ON runs.run_id = outbox.run_id
          WHERE runs.repository_id = $1
            AND runs.pr_number = $2
            AND ($3::text IS NULL OR runs.head_sha = $3)
            AND outbox.status = 'pending'
            AND runs.status = 'queued'
          ORDER BY outbox.created_at DESC
          LIMIT 1
          FOR UPDATE OF outbox`,
        [repositoryId, prNumber, headSha ?? null],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { advanced: false };
      }
      await client.query(
        `UPDATE review_dispatch_outbox
            SET available_at = to_timestamp($2 / 1000.0),
                updated_at = to_timestamp($2 / 1000.0)
          WHERE run_id = $1`,
        [row.run_id, now],
      );
      await client.query('COMMIT');
      return { advanced: true, runId: String(row.run_id) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelRunsForPullRequest(
    repositoryIdOrInput: number | { repositoryId: number; prNumber: number; cancelReason: string; now?: number },
    prNumberArg?: number,
    cancelReasonArg?: string,
    nowArg?: number,
  ): Promise<{ cancelledRunIds: string[] }> {
    let repositoryId: number;
    let prNumber: number;
    let cancelReason: string;
    let now: number;
    if (typeof repositoryIdOrInput === 'object') {
      repositoryId = repositoryIdOrInput.repositoryId;
      prNumber = repositoryIdOrInput.prNumber;
      cancelReason = repositoryIdOrInput.cancelReason;
      now = repositoryIdOrInput.now ?? Date.now();
    } else {
      repositoryId = repositoryIdOrInput;
      prNumber = prNumberArg!;
      cancelReason = cancelReasonArg!;
      now = nowArg ?? Date.now();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        reviewDispatchPrLockKey(repositoryId, prNumber),
      ]);
      const result = await client.query(
        `WITH candidate AS (
           SELECT runs.run_id
             FROM review_runs runs
             JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
            WHERE runs.repository_id = $1 AND runs.pr_number = $2
              AND runs.status IN ('queued', 'running', 'publishing')
         ), cancelled AS (
           UPDATE review_runs AS runs
              SET status = 'cancelled', stage = 'complete',
                  error_text = $4::text, lease_owner = NULL, lease_expires_at = NULL,
                  cancel_requested_at = to_timestamp($3 / 1000.0),
                  cancel_reason = $4::text,
                  updated_at = to_timestamp($3 / 1000.0)
             FROM candidate
            WHERE runs.run_id = candidate.run_id
           RETURNING runs.run_id
         )
         UPDATE review_dispatch_outbox AS outbox
            SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                cancel_requested_at = to_timestamp($3 / 1000.0),
                cancel_reason = $4::text,
                cancel_propagated_at = CASE WHEN outbox.projection_name IS NULL THEN to_timestamp($3 / 1000.0) ELSE NULL END,
                updated_at = to_timestamp($3 / 1000.0)
           FROM cancelled
          WHERE outbox.run_id = cancelled.run_id
         RETURNING outbox.run_id, outbox.cancel_propagated_at`,
        [repositoryId, prNumber, now, cancelReason],
      );
      for (const row of result.rows as Record<string, unknown>[]) {
        if (row.cancel_propagated_at) {
          await client.query(
            `UPDATE review_runs SET cancel_propagated_at = to_timestamp($2 / 1000.0) WHERE run_id = $1`,
            [row.run_id, now],
          );
        }
        await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.cancelled', now, {
          stage: 'cancelled',
          terminal_class: 'cancelled',
          cancel_reason: cancelReason,
        });
      }
      await client.query('COMMIT');
      return { cancelledRunIds: result.rows.map((row: Record<string, unknown>) => String(row.run_id)) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Hold the exact attempt's row locks through bounded GitHub publication.
   * Same-head admission cannot advance the delivery while its check is patched.
   * A crash/HTTP error rolls back the acknowledgement, not the failure itself.
   * The result explicitly distinguishes a stale claim, published recovery, and
   * a delivery-identity quarantine.
   */
  async reconcileAbandonedPublishingRun(run: AbandonedPublishingRun, workerId: string, now: number,
    publish: () => Promise<AbandonedCheckRecoveryOutcome>): Promise<AbandonedRunReconciliation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT runs.run_id, runs.delivery_id AS run_delivery_id,
                outbox.delivery_id AS outbox_delivery_id
           FROM review_runs runs
           JOIN review_dispatch_outbox outbox ON outbox.run_id = runs.run_id
          WHERE runs.run_id = $1 AND runs.delivery_id IS NOT DISTINCT FROM $2::text
            AND runs.status = 'terminal' AND runs.publication_mode = 'app-gate'
            AND runs.authoritative_gate_app_id IS NULL
            AND runs.result_digest IS NULL AND runs.lease_owner = $3
            AND runs.lease_expires_at > to_timestamp($4 / 1000.0)
            AND outbox.execution_attempt + 1 = $5
            AND runs.owner = $6 AND runs.repo = $7 AND runs.pr_number = $8 AND runs.head_sha = $9
            -- PostgreSQL retains microseconds while the reaper contract carries
            -- millisecond timestamps. Fence each value to the exact claimed
            -- millisecond bucket; using a one-sided equality would strand a
            -- legitimate row whose stored timestamp has sub-ms precision.
            AND runs.received_at >= to_timestamp($10 / 1000.0)
            AND runs.received_at < to_timestamp(($10::double precision + 1) / 1000.0)
            AND runs.terminal_deadline >= to_timestamp($11 / 1000.0)
            AND runs.terminal_deadline < to_timestamp(($11::double precision + 1) / 1000.0)
          FOR UPDATE OF runs, outbox`,
        [run.runId, run.deliveryId, workerId, now, run.executionAttempt,
          run.owner, run.repo, run.prNumber, run.headSha, run.receivedAt, run.terminalDeadline],
      );
      if (current.rows.length === 0) {
        await client.query('COMMIT');
        return { reconciled: false };
      }
      const currentRow = current.rows[0] as Record<string, unknown>;
      const runDeliveryId = currentRow.run_delivery_id == null ? null : String(currentRow.run_delivery_id);
      const outboxDeliveryId = currentRow.outbox_delivery_id == null ? null : String(currentRow.outbox_delivery_id);
      if (runDeliveryId !== outboxDeliveryId) {
        // A legacy row can retain a run-side delivery binding that no longer
        // agrees with the outbox delivery. Publishing against either side
        // would lose the exact-attempt fence, so retire both records without
        // creating or inferring a GitHub check. Digests make the incident
        // diagnosable without persisting or logging raw delivery identifiers.
        const runDeliveryDigest = sha256(runDeliveryId || '');
        const outboxDeliveryDigest = sha256(outboxDeliveryId || '');
        const diagnostics = buildDurableWorkerFailureDiagnostics('internal_error', {
          reason: DELIVERY_IDENTITY_MISMATCH_REASON,
          logTail: 'run and outbox delivery identities differ; publication quarantined',
        }, run.executionAttempt);
        const durableDiagnostics = {
          ...diagnostics,
          runDeliveryDigest,
          outboxDeliveryDigest,
        };
        const retiredOutbox = await client.query(
          `UPDATE review_dispatch_outbox
              SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($2 / 1000.0)
            WHERE run_id = $1 AND delivery_id = $3::text
              AND execution_attempt + 1 = $4
          RETURNING run_id`,
          [run.runId, now, outboxDeliveryId, run.executionAttempt],
        );
        if (retiredOutbox.rows.length !== 1) {
          throw new Error('delivery identity mismatch outbox retirement lost its exact attempt');
        }
        const retiredRun = await client.query(
          `UPDATE review_runs
              SET status = 'terminal', stage = 'terminal',
                  error_text = $2::text, failure_diagnostics = $3::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($6 / 1000.0)
            WHERE run_id = $1
              AND delivery_id IS NOT DISTINCT FROM $4::text
              AND status = 'terminal' AND publication_mode = 'app-gate'
              AND authoritative_gate_app_id IS NULL AND result_digest IS NULL
              AND lease_owner = $5::text
              AND lease_expires_at > to_timestamp($6 / 1000.0)
          RETURNING run_id`,
          [run.runId, DELIVERY_IDENTITY_MISMATCH_ERROR_TEXT, JSON.stringify(durableDiagnostics),
            runDeliveryId, workerId, now],
        );
        if (retiredRun.rows.length !== 1) {
          throw new Error('delivery identity mismatch run retirement lost its lease');
        }
        await this.appendLifecycle(client, run.runId, 'review.lifecycle.terminal', now, {
          stage: 'terminal',
          terminal_class: 'delivery_identity_mismatch',
          retry_class: 'reaper_quarantine',
          evidence_pointers: [
            `run_delivery_sha256:${runDeliveryDigest}`,
            `outbox_delivery_sha256:${outboxDeliveryDigest}`,
          ],
        });
        await client.query('COMMIT');
        getMetrics().reviewReaperDeliveryIdentityMismatches.add(1);
        logger.warn('Quarantined abandoned review with mismatched delivery identity', {
          runId: run.runId,
          repo: `${run.owner}/${run.repo}`,
          headSha: run.headSha,
          executionAttempt: run.executionAttempt,
          deliveryIdentityMismatch: true,
          runDeliveryDigest,
          outboxDeliveryDigest,
        });
        return { reconciled: true, outcome: 'quarantined' };
      }
      const outcome: unknown = await publish();
      if (!isAbandonedCheckRecoveryOutcome(outcome)) {
        throw new Error('invalid abandoned check recovery outcome');
      }
      if (outcome === 'superseded') {
        // A newer exact Review Yeti App identity on this head proves only that
        // this abandoned attempt is obsolete. It does not prove this run's
        // verdict, so retire both durable records without touching GitHub or
        // synthesizing success.
        const diagnostics = buildDurableWorkerFailureDiagnostics('internal_error', {
          reason: SUPERSEDED_PUBLISHING_REASON,
          logTail: 'newer publisher-owned same-head check exists; abandoned attempt retired',
        }, run.executionAttempt);
        const retiredOutbox = await client.query(
          `UPDATE review_dispatch_outbox
              SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($2 / 1000.0)
            WHERE run_id = $1 AND delivery_id IS NOT DISTINCT FROM $3::text
              AND execution_attempt + 1 = $4
          RETURNING run_id`,
          [run.runId, now, run.deliveryId ?? null, run.executionAttempt],
        );
        if (retiredOutbox.rows.length !== 1) {
          throw new Error('superseded outbox retirement lost its exact attempt');
        }
        const retiredRun = await client.query(
          `UPDATE review_runs
              SET status = 'terminal', stage = 'terminal',
                  error_text = $2::text, failure_diagnostics = $3::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($6 / 1000.0)
            WHERE run_id = $1
              AND delivery_id IS NOT DISTINCT FROM $4::text
              AND status = 'terminal' AND publication_mode = 'app-gate'
              AND authoritative_gate_app_id IS NULL AND result_digest IS NULL
              AND lease_owner = $5::text
              AND lease_expires_at > to_timestamp($6 / 1000.0)
              AND EXISTS (SELECT 1 FROM review_dispatch_outbox outbox
                WHERE outbox.run_id = review_runs.run_id
                  AND outbox.execution_attempt + 1 = $7)
          RETURNING run_id`,
          [run.runId, SUPERSEDED_PUBLISHING_ERROR_TEXT, JSON.stringify(diagnostics),
            run.deliveryId ?? null, workerId, now, run.executionAttempt],
        );
        if (retiredRun.rows.length !== 1) {
          throw new Error('superseded run retirement lost its lease');
        }
        await this.appendLifecycle(client, run.runId, 'review.lifecycle.terminal', now, {
          stage: 'terminal',
          terminal_class: 'superseded_by_newer_check',
          retry_class: 'reaper_retired',
        });
        await client.query('COMMIT');
        getMetrics().reviewReaperSupersededAttempts.add(1);
        logger.warn('Retired abandoned review superseded by a newer App check', {
          runId: run.runId,
          repo: `${run.owner}/${run.repo}`,
          headSha: run.headSha,
          executionAttempt: run.executionAttempt,
        });
        return { reconciled: true, outcome };
      }
      // Successful publication consumes this outbox delivery. Retain the
      // worker token as durable evidence for an explicit same-head retry, but
      // move the row out of the reaper's projected-publication state so the
      // preserved worker classification is not claimed repeatedly.
      if (outcome !== 'creation-unconfirmed') {
        await client.query(
          `UPDATE review_dispatch_outbox
              SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = to_timestamp($2 / 1000.0)
            WHERE run_id = $1 AND delivery_id = $3 AND execution_attempt + 1 = $4`,
          [run.runId, now, run.deliveryId, run.executionAttempt],
        );
      }
      // REL-896: a run claimed via the operator's delegated-failure signal
      // (see claimAbandonedPublishingRuns) carries the operator's exact
      // WorkerFailed/DeadlineExpired/WorkerJobMissing classification instead
      // of the generic deadline text. Persist it as a structured reason so
      // operators can tell these apart, but never overwrite the diagnostics
      // of a run that actually succeeded.
      const delegatedDiagnostics = run.delegatedReason && outcome !== 'authoritative-success'
        ? JSON.stringify(buildDurableWorkerFailureDiagnostics('internal_error', {
          reason: run.delegatedReason,
          logTail: `operator-delegated failure: ${run.delegatedReason}`,
        }, run.executionAttempt))
        : null;
      await client.query(
        `UPDATE review_runs SET lease_owner = NULL,
           lease_expires_at = CASE WHEN $3 = 'creation-unconfirmed'
             THEN to_timestamp(($2::double precision + ${ABANDONED_RECOVERY_LEASE_MS}) / 1000.0) ELSE NULL END,
           status = CASE WHEN $3 = 'authoritative-success' THEN 'succeeded' ELSE status END,
           stage = CASE WHEN $3 = 'authoritative-success' THEN 'complete' ELSE stage END,
           error_text = CASE
             WHEN $3 = 'creation-unconfirmed'
               THEN $4::text
             WHEN $3 = 'authoritative-success' THEN NULL
             WHEN error_text LIKE '${WORKER_TERMINAL_FAILURE_PREFIX}%' THEN error_text
             ELSE $5::text
           END,
           failure_diagnostics = CASE WHEN $6::jsonb IS NOT NULL THEN $6::jsonb ELSE failure_diagnostics END,
           updated_at = to_timestamp($2 / 1000.0) WHERE run_id = $1`,
        [run.runId, now, outcome, RECOVERY_UNCONFIRMED_ERROR_TEXT,
          ABANDONED_PUBLISHING_ERROR_TEXT.failureReconciled, delegatedDiagnostics],
      );
      if (outcome === 'authoritative-success') {
        await this.appendLifecycle(client, run.runId, 'review.lifecycle.terminal', now,
          { stage: 'complete', terminal_class: 'authoritative_success' });
      } else if (outcome === 'failure-existing') {
        await this.appendLifecycle(client, run.runId, 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'failure_existing' });
      } else if (outcome === 'failure-published') {
        await this.appendLifecycle(client, run.runId, 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'failure_published' });
      } else {
        await this.appendLifecycle(client, run.runId, 'review.lifecycle.retrying', now,
          { stage: 'gate_publication', retry_class: 'creation_unconfirmed' });
      }
      await client.query('COMMIT');
      return { reconciled: true, outcome };
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
    return this.inTransaction(async (client) => {
      const result = await client.query(
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
      if (result.rows.length > 0) {
        await this.appendLifecycle(client, runId, 'review.lifecycle.started', now, { stage: 'started' });
      }
      return result.rows.length > 0;
    });
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
    return this.inTransaction(async (client) => {
      const result = await client.query(
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
      if (result.rows.length > 0) {
        await this.appendLifecycle(client, runId, 'review.lifecycle.retrying', now,
          { stage: 'dispatch', retry_class: 'projection_retry' });
      }
      return result.rows.length > 0;
    });
  }

  async markTerminal(runId: string, workerId: string, claimAttempt: number, now: number, error: string,
    diagnostics?: WorkerFailureDiagnostics): Promise<boolean> {
    validateClaimAttempt(claimAttempt);
    const failureDiagnostics = diagnostics
      ? JSON.stringify(buildDurableWorkerFailureDiagnostics('internal_error', diagnostics)) : null;
    return this.inTransaction(async (client) => {
      const result = await client.query(
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
      if (result.rows.length > 0) {
        await this.appendLifecycle(client, runId, 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'dispatch_failure' });
      }
      return result.rows.length > 0;
    });
  }

  async markWorkerFailure(input: WorkerTerminalFailure, proof: WorkerCompletionProof, now = Date.now()): Promise<WorkerFailureTransition> {
    const client = await this.pool.connect();
    let result: WorkerFailureTransition;
    try {
      await client.query('BEGIN');
      // Use admission's repository/PR lock so a same-head rerequest cannot
      // interleave the run transition with the execution's outbox transition.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        reviewDispatchPrLockKey(input.repositoryId, input.prNumber),
      ]);
      result = await this.persistWorkerFailure(client, input, proof, now);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    // The bounded automatic recoverable-panel retry (REL-620) is a
    // review/dispatch service decision, not a persistence-layer one: the
    // caller that owns `markWorkerFailure` orchestration decides whether and
    // how to re-admit a fresh execution attempt once this transition commits
    // (see `../review/recoverablePanelRetry`). This method's only
    // responsibility is the durable failure transition itself.
    return result;
  }

  /** Read-only run metadata the recoverable-panel-retry service needs to
   * decide whether a fresh execution attempt may be re-admitted. */
  async readRunRetryContext(runId: string): Promise<RunRetryContext | null> {
    const current = await this.queryable.query(
      `SELECT repository_id, installation_id, identity, publication_mode, authoritative_gate_app_id
         FROM review_runs WHERE run_id = $1`,
      [runId],
    );
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const identity = typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity;
    return {
      publicationMode: row.publication_mode as RunRetryContext['publicationMode'],
      authoritativeGateAppId: row.authoritative_gate_app_id == null ? null : Number(row.authoritative_gate_app_id),
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      identity,
    };
  }

  async authorizeWorkerEvidence(input: WorkerReviewEvidence, proof: WorkerCompletionProof): Promise<WorkerEvidenceAuthorization> {
    const client = await this.pool.connect();
    try {
      const current = await client.query(
        `SELECT runs.repository_id, runs.owner, runs.repo, runs.pr_number, runs.head_sha, runs.base_sha,
                runs.effective_policy_digest, runs.effective_config_digest, runs.publication_mode,
                runs.authoritative_gate_app_id, outbox.execution_attempt, outbox.worker_token_digest
           FROM review_runs AS runs
           JOIN review_dispatch_outbox AS outbox ON outbox.run_id = runs.run_id
          WHERE runs.run_id = $1`,
        [input.runId],
      );
      const row = current.rows[0] as Record<string, unknown> | undefined;
      if (!row) return { runId: input.runId, status: 'ignored' };
      if (!constantTimeDigestEqual(row.worker_token_digest, proof.workerTokenDigest)) {
        return { runId: input.runId, status: 'unauthorized' };
      }
      // Evidence is sent before the terminal callback, while the outbox still
      // names the previous attempt; a late resend after the terminal callback
      // committed finds the current one. Both are this worker's execution.
      const attempt = Number(row.execution_attempt);
      const matches = Number(row.repository_id) === input.repositoryId
        && String(row.owner) === input.owner
        && String(row.repo) === input.repo
        && Number(row.pr_number) === input.prNumber
        && String(row.head_sha) === input.headSha
        && String(row.base_sha) === input.baseSha
        && String(row.effective_policy_digest) === input.policyDigest
        && String(row.effective_config_digest) === input.configDigest
        && String(row.publication_mode) === 'app-gate'
        && row.authoritative_gate_app_id == null
        && (attempt + 1 === input.executionAttempt || attempt === input.executionAttempt);
      return { runId: input.runId, status: matches ? 'authorized' : 'unauthorized' };
    } finally {
      client.release();
    }
  }

  async markWorkerSuccess(input: WorkerTerminalSuccess, proof: WorkerCompletionProof, now = Date.now()): Promise<WorkerSuccessTransition> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        reviewDispatchPrLockKey(input.repositoryId, input.prNumber),
      ]);
      const result = await this.persistWorkerSuccess(client, input, proof, now);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistWorkerSuccess(
    client: Queryable,
    input: WorkerTerminalSuccess,
    proof: WorkerCompletionProof,
    now: number,
  ): Promise<WorkerSuccessTransition> {
    const resultDigest = workerTerminalSuccessDigest(input);
    const current = await client.query(
      `SELECT runs.status, runs.result_digest, runs.repository_id, runs.owner, runs.repo, runs.pr_number,
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
    if (status === 'succeeded') {
      return { runId: input.runId, status: row.result_digest === resultDigest ? 'already_succeeded' : 'conflict' };
    }
    if (['failed', 'terminal', 'cancelled', 'superseded'].includes(status)) {
      return { runId: input.runId, status: 'conflict' };
    }
    if (!['queued', 'running'].includes(status)
      || !['pending', 'claimed', 'projected'].includes(String(row.outbox_status))) {
      return { runId: input.runId, status: 'ignored' };
    }

    const retired = await client.query(
      `UPDATE review_dispatch_outbox
          SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
              updated_at = to_timestamp($2 / 1000.0)
        WHERE run_id = $1
          AND status IN ('pending', 'claimed', 'projected')
          AND execution_attempt + 1 = $3
          AND worker_token_digest = $4
      RETURNING run_id`,
      [input.runId, now, input.executionAttempt, proof.workerTokenDigest],
    );
    if (retired.rows.length !== 1) throw new Error('worker success retirement lost its locked identity');
    const transitioned = await client.query(
      `UPDATE review_runs AS runs
          SET status = 'succeeded', stage = 'complete', result_digest = $2,
              error_text = NULL, failure_diagnostics = '{}'::jsonb,
              lease_owner = NULL, lease_expires_at = NULL,
              updated_at = to_timestamp($3 / 1000.0)
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
          AND runs.authoritative_gate_app_id IS NULL
          AND runs.status IN ('queued', 'running')
          AND outbox.status = 'terminal'
          AND outbox.execution_attempt + 1 = $12
          AND outbox.worker_token_digest = $13
        RETURNING runs.run_id`,
      [
        input.runId,
        resultDigest,
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
    if (transitioned.rows.length !== 1) throw new Error('worker success transition lost its locked identity');
    await this.appendLifecycle(client, input.runId, 'review.lifecycle.terminal', now,
      { stage: 'terminal', terminal_class: 'success', result_digest: resultDigest });
    return { runId: input.runId, status: 'succeeded' };
  }

  private async persistWorkerFailure(
    client: Queryable,
    input: WorkerTerminalFailure,
    proof: WorkerCompletionProof,
    now: number,
  ): Promise<WorkerFailureTransition> {
    const safeError = `${WORKER_TERMINAL_FAILURE_PREFIX}${input.failureClass}`;
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
    await this.appendLifecycle(client, input.runId, 'review.lifecycle.terminal', now,
      { stage: 'terminal', terminal_class: input.failureClass });
    return { runId: input.runId, status: 'failed' };
  }

  async markCancelPropagated(runId: string, executionAttempt: number, nowArg = Date.now()): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const outboxRes = await client.query(
        `UPDATE review_dispatch_outbox
            SET cancel_propagated_at = to_timestamp($3 / 1000.0),
                updated_at = to_timestamp($3 / 1000.0)
          WHERE run_id = $1
            AND execution_attempt + 1 = $2
            AND cancel_requested_at IS NOT NULL
            AND cancel_propagated_at IS NULL
        RETURNING run_id`,
        [runId, executionAttempt, nowArg],
      );
      if (outboxRes.rows.length === 0) {
        return false;
      }
      await client.query(
        `UPDATE review_runs
            SET cancel_propagated_at = to_timestamp($2 / 1000.0),
                updated_at = to_timestamp($2 / 1000.0)
          WHERE run_id = $1
            AND cancel_requested_at IS NOT NULL
            AND cancel_propagated_at IS NULL`,
        [runId, nowArg],
      );
      return true;
    });
  }

  async findPendingCancellations(limit = 10): Promise<PendingCancellation[]> {
    const res = await this.queryable.query(
      `SELECT outbox.run_id,
              outbox.execution_attempt + 1 AS execution_attempt,
              outbox.projection_name,
              outbox.cancel_reason
         FROM review_dispatch_outbox AS outbox
        WHERE outbox.cancel_requested_at IS NOT NULL
          AND outbox.cancel_propagated_at IS NULL
          AND outbox.projection_name IS NOT NULL
        ORDER BY outbox.cancel_requested_at ASC
        LIMIT $1`,
      [limit],
    );
    return res.rows.map((row: any) => ({
      runId: String(row.run_id),
      executionAttempt: Number(row.execution_attempt),
      projectionName: String(row.projection_name),
      cancelReason: row.cancel_reason ? String(row.cancel_reason) : undefined,
    }));
  }

  async getRunStatus(runId: string, executionAttempt: number): Promise<RunStatusResult | null> {
    const res = await this.queryable.query(
      `SELECT runs.run_id,
              runs.status,
              runs.head_sha,
              runs.owner,
              runs.repo,
              runs.pr_number,
              runs.cancel_requested_at,
              runs.cancel_reason,
              outbox.execution_attempt,
              outbox.worker_token_digest,
              outbox.cancel_requested_at AS outbox_cancel_requested_at,
              outbox.cancel_reason AS outbox_cancel_reason
         FROM review_runs AS runs
         LEFT JOIN review_dispatch_outbox AS outbox
           ON outbox.run_id = runs.run_id AND outbox.execution_attempt + 1 = $2
        WHERE runs.run_id = $1`,
      [runId, executionAttempt],
    );
    const row = res.rows[0];
    if (!row) return null;

    const cancelRequested = Boolean(
      row.cancel_requested_at != null
      || row.outbox_cancel_requested_at != null
      || ['superseded', 'cancelled'].includes(row.status),
    );
    const cancelReason = row.cancel_reason
      ? String(row.cancel_reason)
      : row.outbox_cancel_reason
      ? String(row.outbox_cancel_reason)
      : row.status === 'superseded'
      ? 'superseded_by_new_head'
      : undefined;

    let currentHeadSha: string | undefined = undefined;
    let isCurrentHead = true;
    if (row.owner && row.repo && row.pr_number != null) {
      const headRes = await this.queryable.query(
        `SELECT head_sha FROM review_runs
          WHERE owner = $1 AND repo = $2 AND pr_number = $3
          ORDER BY admitted_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [row.owner, row.repo, row.pr_number],
      );
      if (headRes.rows.length > 0 && headRes.rows[0].head_sha) {
        currentHeadSha = String(headRes.rows[0].head_sha);
        isCurrentHead = currentHeadSha === String(row.head_sha) && !['superseded', 'cancelled'].includes(row.status);
      } else {
        isCurrentHead = !['superseded', 'cancelled'].includes(row.status);
      }
    } else {
      isCurrentHead = !['superseded', 'cancelled'].includes(row.status);
    }

    const current = ['queued', 'running'].includes(row.status) && !cancelRequested;

    return {
      current,
      status: String(row.status),
      cancelRequested,
      cancelReason,
      currentHeadSha,
      isCurrentHead,
      workerTokenDigest: row.worker_token_digest ? String(row.worker_token_digest) : undefined,
    };
  }
}
