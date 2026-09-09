import type { ReviewGateCandidate } from './reviewGatePolicy';
import type { TrustedReviewCoverageContract } from './workerReviewCompletion';

export interface ReviewGateCoordinates {
  owner: string; repo: string; repositoryId: number; prNumber: number;
  headSha: string; baseSha: string; policyDigest: string; runId: string;
  attemptId: string; executionAttempt: number;
}
export type GateDesiredState = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'timed_out';
export function isGateProgressState(state: GateDesiredState): state is 'queued' | 'in_progress' {
  return state === 'queued' || state === 'in_progress';
}
/** Domain projection of the service-owned check lifecycle, independent of its
 * PostgreSQL representation and GitHub HTTP client implementation. */
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
  /** True only on the committed reserved -> creating transition. After an
   * uncertain POST, no check ID still means reconcile-only. Only a proven
   * pre-create preparation failure may restore the reservation. */
  mayCreate: boolean;
}

/** Only the trusted publisher's client-preparation branch may return this.
 * Once createPending is invoked, even a synchronous throw is uncertain. */
export interface GatePublicationNotStarted {
  kind: 'not-started';
  retryDelayMs: number;
}

/** Structural transport readback, not authority by itself. Persistence must
 * validate exact identity, bound ID and desired status/conclusion before ACK. */
export interface GatePublicationObservation {
  id: number;
  name: string;
  appId: number;
  headSha: string;
  externalId: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}
export type GatePublicationCallback = (gate: StoredReviewGate, mayCreate: boolean) =>
  Promise<GatePublicationObservation | GatePublicationNotStarted>;
export type GatePublicationTransition = 'published' | 'stale-claim' | 'retry';
export type GatePublicationErrorClass = 'transport' | 'unknown-create' | 'identity-conflict' | 'stale-claim';

/** Publisher-facing storage port. Transaction/lock clients never escape the
 * implementation; the callback receives only its fenced gate and create right. */
export interface ReviewGateRepository {
  claimPublication(workerId: string, now: number, leaseMs?: number): Promise<GatePublicationClaim | null>;
  publishLocked(claim: GatePublicationClaim, publish: GatePublicationCallback,
    clock?: () => number): Promise<GatePublicationTransition>;
  retryPublication(claim: GatePublicationClaim, now: number, delayMs: number,
    errorClass: GatePublicationErrorClass): Promise<boolean>;
}
export interface TrustedGateCompletionContext {
  current: ReviewGateCandidate & { open: boolean; draft: boolean };
  coverage: Omit<TrustedReviewCoverageContract, 'expectedCoordinates'>;
}
export type GateWorkerResultTransition = 'recorded' | 'duplicate' | 'ignored' | 'unauthorized' | 'conflict';
