import { canonicalJson, sha256 } from './reviewCore';
import {
  deriveReviewCheckExternalId,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
  type OperatorPassthroughCheckCoordinates,
  type ReviewGateCheck,
} from './reviewCheckIdentity';

export type OperatorPassthroughTransport = 'github-app' | 'github-actions-oidc' | 'mcp' | 'service-reconciler';
export type OperatorPassthroughCheckStage = 'review' | 'gate';
export type OperatorPassthroughCheckState = 'reserved' | 'creating' | 'bound' | 'not-created';

/** Default short deadline for status reads and non-MCP paused admissions. */
export const OPERATOR_PASSTHROUGH_RECEIPT_BUDGET_MS = 1_500;
/** One authenticated MCP call has a 30-second ceiling; reserve half for candidate resolution and transport overhead. */
export const OPERATOR_PASSTHROUGH_MCP_RECEIPT_BUDGET_MS = 15_000;
/** Time reserved inside the parent receipt budget for a confirmed pre-POST reset. */
export const OPERATOR_PASSTHROUGH_FINALIZE_RESERVE_MS = 300;

export type OperatorPassthroughFailureStage = 'record' | 'review' | 'gate' | 'receipt';
export type OperatorPassthroughFailureClass =
  | 'candidate_check'
  | 'client_preparation'
  | 'check_reconciliation'
  | 'check_creation'
  | 'check_update'
  | 'unknown_create'
  | 'preflight_timeout'
  | 'preflight_reset_unconfirmed'
  | 'receipt_deadline'
  | 'identity_mismatch'
  | 'transport'
  | 'stale_claim'
  | 'durable_record_unavailable'
  | 'receipt_readback';

/** Static, credential-free publication diagnostics. Never include an Error or response body. */
export interface OperatorPassthroughPublicationFailure {
  stage: OperatorPassthroughFailureStage;
  classification: OperatorPassthroughFailureClass;
}

export interface OperatorPassthroughOperationScope {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export class OperatorPassthroughOperationDeadlineExceededError extends Error {
  constructor() {
    super('Operator passthrough receipt budget expired');
    this.name = 'OperatorPassthroughOperationDeadlineExceededError';
  }
}

/** A preflight-only child deadline that leaves the parent time for safe cleanup. */
export class OperatorPassthroughPreflightDeadlineExceededError extends Error {
  constructor() {
    super('Operator passthrough preflight budget expired');
    this.name = 'OperatorPassthroughPreflightDeadlineExceededError';
  }
}

/** The child pre-POST timeout occurred, but persistence could not confirm reset-to-reserved. */
export class OperatorPassthroughPreflightResetUnconfirmedError extends Error {
  constructor() {
    super('Operator passthrough preflight reset could not be confirmed');
    this.name = 'OperatorPassthroughPreflightResetUnconfirmedError';
  }
}

export function operatorPassthroughOperationExpired(scope?: OperatorPassthroughOperationScope): boolean {
  return scope !== undefined && (scope.signal.aborted || performance.now() >= scope.deadlineAtMs);
}

export function operatorPassthroughOperationRemainingMs(scope: OperatorPassthroughOperationScope): number {
  return Math.max(0, scope.deadlineAtMs - performance.now());
}

export function assertOperatorPassthroughOperationActive(scope?: OperatorPassthroughOperationScope): void {
  if (operatorPassthroughOperationExpired(scope)) {
    throw new OperatorPassthroughOperationDeadlineExceededError();
  }
}

/** Await one step under the shared admission deadline; late completion is observed but never resumes its caller. */
export async function awaitOperatorPassthroughOperation<T>(
  operation: () => Promise<T>, scope?: OperatorPassthroughOperationScope,
): Promise<T> {
  assertOperatorPassthroughOperationActive(scope);
  const pending = Promise.resolve().then(() => {
    // The operation starts in a later microtask. Recheck at that boundary so
    // a deadline/abort after scheduling cannot launch a late query or request.
    assertOperatorPassthroughOperationActive(scope);
    return operation();
  });
  if (!scope) return pending;

  let removeAbortListener: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectDeadline = () => reject(new OperatorPassthroughOperationDeadlineExceededError());
    if (scope.signal.aborted) {
      rejectDeadline();
      return;
    }
    scope.signal.addEventListener('abort', rejectDeadline, { once: true });
    removeAbortListener = () => scope.signal.removeEventListener('abort', rejectDeadline);
  });
  try {
    const value = await Promise.race([pending, aborted]);
    assertOperatorPassthroughOperationActive(scope);
    return value;
  } finally {
    removeAbortListener();
  }
}

/** Apply one finite budget to all storage and publication steps for one pause receipt. */
export async function withOperatorPassthroughReceiptBudget<T>(
  operation: (scope: OperatorPassthroughOperationScope) => Promise<T>,
  budgetMs = OPERATOR_PASSTHROUGH_RECEIPT_BUDGET_MS,
): Promise<T> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > OPERATOR_PASSTHROUGH_MCP_RECEIPT_BUDGET_MS) {
    throw new Error('Invalid operator passthrough receipt budget');
  }
  const controller = new AbortController();
  const scope: OperatorPassthroughOperationScope = {
    deadlineAtMs: performance.now() + budgetMs,
    signal: controller.signal,
  };
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await awaitOperatorPassthroughOperation(() => operation(scope), scope);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Run conclusively pre-POST work under a child deadline, preserving a small parent cleanup tail. */
export async function withOperatorPassthroughPreflightBudget<T>(
  operation: (scope: OperatorPassthroughOperationScope) => Promise<T>,
  parent: OperatorPassthroughOperationScope,
): Promise<T> {
  assertOperatorPassthroughOperationActive(parent);
  const available = Math.floor(operatorPassthroughOperationRemainingMs(parent));
  const childBudget = Math.max(1, available - OPERATOR_PASSTHROUGH_FINALIZE_RESERVE_MS);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  parent.signal.addEventListener('abort', abortFromParent, { once: true });
  const child: OperatorPassthroughOperationScope = {
    deadlineAtMs: Math.min(parent.deadlineAtMs, performance.now() + childBudget),
    signal: controller.signal,
  };
  const timer = setTimeout(() => controller.abort(), childBudget);
  try {
    return await awaitOperatorPassthroughOperation(() => operation(child), child);
  } catch (error) {
    if (operatorPassthroughOperationExpired(parent)) {
      throw new OperatorPassthroughOperationDeadlineExceededError();
    }
    if (operatorPassthroughOperationExpired(child)
      || error instanceof OperatorPassthroughOperationDeadlineExceededError) {
      throw new OperatorPassthroughPreflightDeadlineExceededError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent.signal.removeEventListener('abort', abortFromParent);
    controller.abort();
  }
}

export const OPERATOR_PASSTHROUGH_REVIEW_TITLE = `${REVIEW_WORKER_CHECK_NAME}: SHIP (passthrough: no review performed)`;
export const OPERATOR_PASSTHROUGH_GATE_TITLE = `${REVIEW_GATE_CHECK_NAME}: SHIP (operator passthrough SHIP)`;
export const OPERATOR_PASSTHROUGH_MODE_MARKER = 'review-mode=passthrough';
export const OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER = 'Zero review lanes ran.';

export interface OperatorPassthroughCandidate {
  owner: string;
  repo: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
}

export interface OperatorPassthroughEvent {
  transport: OperatorPassthroughTransport;
  eventName: string;
  deliveryId: string;
  /** Digest of the already-authenticated source event; raw payloads are never persisted. */
  deliveryDigest: string;
}

export interface OperatorPassthroughRecordInput {
  candidate: OperatorPassthroughCandidate;
  expectedAppId: number;
  event: OperatorPassthroughEvent;
}

export interface OperatorPassthroughAdmissionRequest {
  requested: Omit<OperatorPassthroughCandidate, 'policyDigest'>;
  event: OperatorPassthroughEvent;
  /** Internal shared MCP deadline; never supplied through the public tool arguments. */
  scope?: OperatorPassthroughOperationScope;
  reviewEngine?: 'composed' | 'panel';
}

/** Authenticated source identity for a no-current-coordinates SHIP response. */
export interface OperatorPassthroughUnavailableRequest {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  event: OperatorPassthroughEvent;
}

/** A reused transport delivery identity is an authority conflict, not a storage outage. */
export class OperatorPassthroughDeliveryIdentityConflictError extends Error {
  constructor() {
    super('Operator passthrough delivery identity conflict');
    this.name = 'OperatorPassthroughDeliveryIdentityConflictError';
  }
}

/** A storage read could not establish whether a source delivery was recorded. */
export class OperatorPassthroughPersistenceUnavailableError extends Error {
  constructor() {
    super('Operator passthrough persistence is unavailable');
    this.name = 'OperatorPassthroughPersistenceUnavailableError';
  }
}

export interface OperatorPassthroughReconcileAdmission extends Omit<OperatorPassthroughCandidate, 'policyDigest'> {
  runId: string;
  admittedPolicyDigest: string;
}

export interface OperatorPassthroughReconcileCursor {
  repositoryId: number;
  prNumber: number;
}

export interface OperatorPassthroughAdmissionReceipt {
  status: 'accepted' | 'duplicate' | 'unavailable';
  /** Whether an exact current candidate was validated before this response. */
  candidateState: 'current' | 'unavailable';
  verdict: 'SHIP';
  expectedLanes: 0;
  completedLanes: 0;
  publicationId: string | null;
  auditDigest: string | null;
  publicationState: 'pending' | 'published' | 'retiring' | 'retired' | 'unavailable';
  /** Whether an active durable receipt was observed; null means storage could not confirm it. */
  publicationReceiptAvailable: boolean | null;
  reviewCheckId: number | null;
  gateCheckId: number | null;
  mergeEligible: boolean;
  publicationFailure?: OperatorPassthroughPublicationFailure;
  message: string;
}

export interface StoredOperatorPassthroughPublication {
  publicationId: string;
  publicationSequence: number;
  coordinates: OperatorPassthroughCheckCoordinates;
  expectedAppId: number;
  auditDigest: string;
  reviewExternalId: string;
  gateExternalId: string;
  reviewCheckId: number | null;
  reviewCreationState: OperatorPassthroughCheckState;
  gateCheckId: number | null;
  gateCreationState: OperatorPassthroughCheckState;
  retirementRequestedAt: number | null;
  retirementReason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed' | null;
  retiredAt: number | null;
}

export interface OperatorPassthroughReadinessInput {
  reviewCreationState: unknown;
  reviewCheckId: unknown;
  gateCreationState: unknown;
  gateCheckId: unknown;
  retirementRequestedAt: unknown;
  retiredAt: unknown;
}

/** The single domain rule for when an operator-passthrough publication is ready to satisfy SHIP. */
export function operatorPassthroughReadyForShip(publication: OperatorPassthroughReadinessInput): boolean {
  const hasCheckId = (value: unknown): boolean => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return false;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
  };
  return publication.retirementRequestedAt === null && publication.retiredAt === null
    && publication.reviewCreationState === 'bound' && hasCheckId(publication.reviewCheckId)
    && publication.gateCreationState === 'bound' && hasCheckId(publication.gateCheckId);
}

export interface OperatorPassthroughPublicationSnapshot extends StoredOperatorPassthroughPublication {
  reviewRetiredAt: number | null;
  gateRetiredAt: number | null;
  readyForShip: boolean;
}

export interface OperatorPassthroughPublicationClaim extends StoredOperatorPassthroughPublication {
  leaseOwner: string;
  leaseToken: string;
  stage: OperatorPassthroughCheckStage;
  /** A committed reservation authorizes exactly one create. Unknown outcomes only reconcile. */
  mayCreate: boolean;
  retiring: boolean;
}

export interface OperatorPassthroughPublicationNotStarted {
  kind: 'not-started';
  retryDelayMs: number;
}

export interface OperatorPassthroughReconcilePending {
  kind: 'reconcile-pending';
  retryDelayMs: number;
}

export interface OperatorPassthroughRetireRequired {
  kind: 'retire-required';
  reason: 'candidate-changed';
  retryDelayMs: number;
}

export type OperatorPassthroughRecordResult = {
  status: 'accepted' | 'duplicate';
  publicationId: string;
  auditDigest: string;
  expectedLanes: 0;
  completedLanes: 0;
  verdict: 'SHIP';
};

export interface OperatorPassthroughPublicationRepository {
  /** Read-only conflict check used before a candidate-less outage response. */
  assertDeliveryIdentity(event: OperatorPassthroughEvent, scope?: OperatorPassthroughOperationScope): Promise<void>;
  record(input: OperatorPassthroughRecordInput, now?: number,
    scope?: OperatorPassthroughOperationScope): Promise<OperatorPassthroughRecordResult>;
  getPublication(publicationId: string, scope?: OperatorPassthroughOperationScope): Promise<OperatorPassthroughPublicationSnapshot | null>;
  requestRetirement(candidate: Pick<OperatorPassthroughCandidate, 'repositoryId' | 'prNumber' | 'headSha'>,
    reason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed', now?: number): Promise<number>;
  retireInTransaction(client: { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> },
    candidate: Pick<OperatorPassthroughCandidate, 'repositoryId' | 'prNumber' | 'headSha'>,
    reason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed', now: number): Promise<number>;
  requestAllRetirements(reason: 'pause-disabled', now?: number): Promise<number>;
  claimPublication(workerId: string, now: number, leaseMs?: number, publicationId?: string,
    scope?: OperatorPassthroughOperationScope): Promise<OperatorPassthroughPublicationClaim | null>;
  publishLocked(claim: OperatorPassthroughPublicationClaim,
    publish: (claim: OperatorPassthroughPublicationClaim) => Promise<ReviewGateCheck
      | OperatorPassthroughPublicationNotStarted | OperatorPassthroughReconcilePending | OperatorPassthroughRetireRequired>,
    now?: () => number, scope?: OperatorPassthroughOperationScope): Promise<'published' | 'stale-claim' | 'retry'>;
  retryPublication(claim: OperatorPassthroughPublicationClaim, now: number, delayMs: number,
    scope?: OperatorPassthroughOperationScope): Promise<boolean>;
}

export function validateOperatorPassthroughCandidate(candidate: OperatorPassthroughCandidate): void {
  const allowed = ['owner', 'repo', 'repositoryId', 'prNumber', 'headSha', 'baseSha', 'policyDigest'];
  if (Object.keys(candidate).length !== allowed.length || Object.keys(candidate).some((key) => !allowed.includes(key))
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(candidate.owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(candidate.repo)
    || !Number.isSafeInteger(candidate.repositoryId) || candidate.repositoryId <= 0
    || !Number.isSafeInteger(candidate.prNumber) || candidate.prNumber <= 0
    || !/^[a-f0-9]{40}$/u.test(candidate.headSha)
    || !/^[a-f0-9]{40}$/u.test(candidate.baseSha)
    || !/^[a-f0-9]{64}$/u.test(candidate.policyDigest)) {
    throw new Error('Operator passthrough candidate identity is invalid');
  }
}

export function validateOperatorPassthroughEvent(event: OperatorPassthroughEvent): void {
  const externalTransport = ['github-app', 'github-actions-oidc', 'mcp'].includes(event.transport);
  const reconcilerTransport = event.transport === 'service-reconciler'
    && event.eventName === 'existing-admission'
    && typeof event.deliveryId === 'string'
    && event.deliveryId.startsWith('service-reconcile:');
  if ((!externalTransport && !reconcilerTransport)
    || !/^[A-Za-z0-9_.-]{1,64}$/u.test(event.eventName)
    || typeof event.deliveryId !== 'string' || event.deliveryId.length < 1 || event.deliveryId.length > 256
    || !/^[a-f0-9]{64}$/u.test(event.deliveryDigest)) {
    throw new Error('Operator passthrough source identity is invalid');
  }
}

/**
 * Build the immutable, credential-free check identity in its own external-ID
 * namespace. It carries no run ID, attempt, or Action generation.
 */
export function operatorPassthroughIdentity(input: OperatorPassthroughRecordInput): {
  publicationId: string;
  coordinates: OperatorPassthroughCheckCoordinates;
  auditDigest: string;
  reviewExternalId: string;
  gateExternalId: string;
} {
  validateOperatorPassthroughCandidate(input.candidate);
  validateOperatorPassthroughEvent(input.event);
  return operatorPassthroughIdentityForCandidate(input.candidate, input.expectedAppId);
}

export function operatorPassthroughIdentityForCandidate(
  candidate: OperatorPassthroughCandidate,
  expectedAppId: number,
  publicationSequence = 1,
): {
  publicationId: string;
  coordinates: OperatorPassthroughCheckCoordinates;
  auditDigest: string;
  reviewExternalId: string;
  gateExternalId: string;
} {
  validateOperatorPassthroughCandidate(candidate);
  if (!Number.isSafeInteger(expectedAppId) || expectedAppId <= 0) {
    throw new Error('Operator passthrough App identity is invalid');
  }
  if (!Number.isSafeInteger(publicationSequence) || publicationSequence < 1) {
    throw new Error('Operator passthrough publication sequence is invalid');
  }
  const publicationId = sha256(canonicalJson({
    version: 'OperatorPassthroughPublication.v1',
    candidate,
    expectedAppId,
    publicationSequence,
  }));
  const auditDigest = sha256(canonicalJson({
    version: 'OperatorPassthroughExemption.v1',
    candidate,
    expectedAppId,
    publicationSequence,
    pauseEnabled: true,
    verdict: 'SHIP',
    expectedLanes: 0,
    completedLanes: 0,
    reviewStarted: false,
  }));
  const coordinates: OperatorPassthroughCheckCoordinates = {
    ...candidate, kind: 'operator-passthrough', publicationId, publicationSequence, auditDigest,
  };
  const reviewExternalId = deriveReviewCheckExternalId(coordinates, REVIEW_WORKER_CHECK_NAME);
  const gateExternalId = deriveReviewCheckExternalId(coordinates, REVIEW_GATE_CHECK_NAME);
  return { publicationId, coordinates, auditDigest, reviewExternalId, gateExternalId };
}

export function operatorPassthroughCheckMetadata(
  claim: Pick<OperatorPassthroughPublicationClaim, 'coordinates' | 'auditDigest'>,
  stage: OperatorPassthroughCheckStage,
): { title: string; summary: string } {
  const { owner, repo, prNumber, headSha, baseSha, policyDigest } = claim.coordinates;
  const check = stage === 'review' ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME;
  return {
    title: operatorPassthroughCheckTitle(stage),
    summary: [
      `${check} published an explicit operator-passthrough SHIP exemption because the operator-wide pause is enabled.`,
      OPERATOR_PASSTHROUGH_MODE_MARKER,
      `${OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER} No provider review, Action worker, or review generation was started or consumed.`,
      '',
      `Exact candidate: ${owner}/${repo}#${prNumber} at ${headSha} (base ${baseSha}; policy ${policyDigest}).`,
      `Publication cycle: ${claim.coordinates.publicationSequence}. Auditable exemption digest: ${claim.auditDigest}.`,
  ].join(' '),
  };
}

export function operatorPassthroughCheckTitle(stage: OperatorPassthroughCheckStage): string {
  return stage === 'review' ? OPERATOR_PASSTHROUGH_REVIEW_TITLE : OPERATOR_PASSTHROUGH_GATE_TITLE;
}

/** Verify the producer-owned SHIP/no-review markers before accepting a check as passthrough evidence. */
export function isOperatorPassthroughCheckOutput(value: unknown, stage: OperatorPassthroughCheckStage): boolean {
  if (!value || typeof value !== 'object') return false;
  const output = value as Record<string, unknown>;
  return output.title === operatorPassthroughCheckTitle(stage)
    && typeof output.summary === 'string'
    && output.summary.includes(OPERATOR_PASSTHROUGH_MODE_MARKER)
    && output.summary.includes(OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER);
}
