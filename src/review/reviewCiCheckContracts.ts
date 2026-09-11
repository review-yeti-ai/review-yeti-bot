import type { ReviewGateCheck, ReviewCiCheckCoordinates } from '../github/reviewGateClient';
import type {
  ReviewCiExecution,
  ReviewCiQueryable,
  ReviewCiStateTransition,
  ReviewCiTerminalReceipt,
  StoredReviewCiRequest,
} from './reviewCi';

export type ReviewCiCheckDesiredState = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'timed_out';
export type ReviewCiCheckCreationState = 'reserved' | 'creating' | 'bound';
export type ReviewCiCheckError = 'transport' | 'unknown-create' | 'identity-conflict' | 'stale-claim';

export interface StoredReviewCiCheck {
  request: StoredReviewCiRequest;
  coordinates: ReviewCiCheckCoordinates;
  expectedAppId: number;
  immutableBindingDigest: string;
  externalId: string;
  currentEpoch: number;
  claimedExecution: ReviewCiExecution | null;
  desiredState: ReviewCiCheckDesiredState;
  desiredVersion: number;
  publishedVersion: number;
  checkId: number | null;
  creationState: ReviewCiCheckCreationState;
  terminalReceipt: ReviewCiTerminalReceipt | null;
}

export interface ReviewCiCheckPublicationClaim extends StoredReviewCiCheck {
  leaseOwner: string;
  leaseToken: string;
  /** True only for the committed reserved -> creating transition. */
  mayCreate: boolean;
}

export interface ReviewCiCheckPublicationNotStarted {
  kind: 'not-started';
  retryDelayMs: number;
}

export type ReviewCiCheckTransition = 'recorded' | 'duplicate' | 'stale' | 'conflict';

/** Narrow transport surface consumed by the service-owned publisher. */
export interface ReviewCiCheckClient {
  reconcile(coordinates: ReviewCiCheckCoordinates): Promise<ReviewGateCheck | null>;
  createPending(coordinates: ReviewCiCheckCoordinates, options?: { status?: 'queued' | 'in_progress' }): Promise<ReviewGateCheck>;
  updateExisting(input: { coordinates: ReviewCiCheckCoordinates; checkId: number; update: {
    status?: 'queued' | 'in_progress'; conclusion?: 'success' | 'failure' | 'cancelled' | 'timed_out';
  }}): Promise<ReviewGateCheck>;
}

/** Narrow structural port consumed by the publisher. */
export interface ReviewCiCheckPublisherRepository {
  claimPublication(workerId: string, now?: number, leaseMs?: number): Promise<ReviewCiCheckPublicationClaim | null>;
  retryPublication(claim: ReviewCiCheckPublicationClaim, now?: number, delayMs?: number,
    errorClass?: ReviewCiCheckError): Promise<boolean>;
  publishLocked(claim: ReviewCiCheckPublicationClaim,
    publish: (check: StoredReviewCiCheck, mayCreate: boolean) => Promise<ReviewGateCheck | ReviewCiCheckPublicationNotStarted>,
    now?: number): Promise<'published' | 'stale-claim' | 'retry'>;
}

/** Structural persistence port. The service hooks and publisher depend on
 * this contract, never on the PostgreSQL implementation or its private
 * helpers. */
export interface ReviewCiCheckRepository extends ReviewCiCheckPublisherRepository {
  transitionInTransaction(client: ReviewCiQueryable, request: StoredReviewCiRequest,
    transition: ReviewCiStateTransition, now?: number): Promise<StoredReviewCiCheck | null>;
  assertPendingPublishedInTransaction(client: ReviewCiQueryable, request: StoredReviewCiRequest, now?: number): Promise<void>;
  get(requestId: string): Promise<StoredReviewCiCheck | null>;
}
