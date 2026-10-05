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
}

export interface OperatorPassthroughReconcileAdmission extends Omit<OperatorPassthroughCandidate, 'policyDigest'> {
  runId: string;
  admittedPolicyDigest: string;
}

export interface OperatorPassthroughAdmissionReceipt {
  status: 'accepted' | 'duplicate';
  verdict: 'SHIP';
  expectedLanes: 0;
  completedLanes: 0;
  publicationId: string;
  auditDigest: string;
  publicationState: 'pending' | 'published' | 'retiring' | 'retired';
  reviewCheckId: number | null;
  gateCheckId: number | null;
  mergeEligible: boolean;
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
  record(input: OperatorPassthroughRecordInput, now?: number): Promise<OperatorPassthroughRecordResult>;
  getPublication(publicationId: string): Promise<OperatorPassthroughPublicationSnapshot | null>;
  requestRetirement(candidate: Pick<OperatorPassthroughCandidate, 'repositoryId' | 'prNumber' | 'headSha'>,
    reason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed', now?: number): Promise<number>;
  retireInTransaction(client: { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> },
    candidate: Pick<OperatorPassthroughCandidate, 'repositoryId' | 'prNumber' | 'headSha'>,
    reason: 'pause-disabled' | 'normal-review-admitted' | 'candidate-changed', now: number): Promise<number>;
  requestAllRetirements(reason: 'pause-disabled', now?: number): Promise<number>;
  claimPublication(workerId: string, now: number, leaseMs?: number, publicationId?: string): Promise<OperatorPassthroughPublicationClaim | null>;
  publishLocked(claim: OperatorPassthroughPublicationClaim,
    publish: (claim: OperatorPassthroughPublicationClaim) => Promise<ReviewGateCheck
      | OperatorPassthroughPublicationNotStarted | OperatorPassthroughReconcilePending | OperatorPassthroughRetireRequired>,
    now?: () => number): Promise<'published' | 'stale-claim' | 'retry'>;
  retryPublication(claim: OperatorPassthroughPublicationClaim, now: number, delayMs: number): Promise<boolean>;
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
  const externalTransport = ['github-app', 'github-actions-oidc', 'mcp'].includes(input.event.transport);
  const reconcilerTransport = input.event.transport === 'service-reconciler'
    && input.event.eventName === 'existing-admission'
    && input.event.deliveryId.startsWith('service-reconcile:');
  if ((!externalTransport && !reconcilerTransport)
    || !/^[A-Za-z0-9_.-]{1,64}$/u.test(input.event.eventName)
    || typeof input.event.deliveryId !== 'string' || input.event.deliveryId.length < 1 || input.event.deliveryId.length > 256
    || !/^[a-f0-9]{64}$/u.test(input.event.deliveryDigest)) {
    throw new Error('Operator passthrough source identity is invalid');
  }
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
  const check = stage === 'review' ? 'Review Yeti' : 'Review Yeti Gate';
  return {
    title: stage === 'review'
      ? 'Review Yeti: SHIP (passthrough: no review performed)'
      : 'Review Yeti Gate: SHIP (operator passthrough SHIP)',
    summary: [
      `${check} published an explicit operator-passthrough SHIP exemption because the operator-wide pause is enabled.`,
      'review-mode=passthrough',
      'Zero review lanes ran. No provider review, Action worker, or review generation was started or consumed.',
      '',
      `Exact candidate: ${owner}/${repo}#${prNumber} at ${headSha} (base ${baseSha}; policy ${policyDigest}).`,
      `Publication cycle: ${claim.coordinates.publicationSequence}. Auditable exemption digest: ${claim.auditDigest}.`,
  ].join(' '),
  };
}
