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
export interface TrustedGateCompletionContext {
  current: ReviewGateCandidate & { open: boolean; draft: boolean };
  coverage: Omit<TrustedReviewCoverageContract, 'expectedCoordinates'>;
}
export type GateWorkerResultTransition = 'recorded' | 'duplicate' | 'ignored' | 'unauthorized' | 'conflict';
