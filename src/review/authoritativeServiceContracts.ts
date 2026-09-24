import type { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import type { GateWorkerResultTransition, StoredReviewGate, TrustedGateCompletionContext } from './reviewGateContracts';
import type { WorkerCompletionProof, WorkerTerminalFailure, WorkerTerminalSuccess } from './workerCompletion';
import type { WorkerReviewCompletion, WorkerReviewEvidence } from './workerReviewCompletion';
import { sha256 } from './reviewCore';
import type { IncrementalVerificationInput } from './incrementalReview';

export interface WorkerCompletionVerifier {
  verify(token: string, event: WorkerTerminalFailure | WorkerTerminalSuccess | WorkerReviewCompletion | WorkerReviewEvidence): Promise<WorkerCompletionProof>;
}
export interface AuthoritativeReviewAdmission {
  expectedAppId: number;
  acceptNewRequests?: boolean;
  repositoryIds: readonly number[];
  resolver: Pick<AuthoritativePublishingResolver, 'resolve'>;
}
export interface AuthoritativeReviewCompletion {
  verifier: WorkerCompletionVerifier;
  repository: {
    recordWorkerResult(input: unknown, proof: WorkerCompletionProof,
      resolve: (gate: StoredReviewGate, incremental?: IncrementalVerificationInput) => Promise<TrustedGateCompletionContext>,
      now?: number): Promise<GateWorkerResultTransition>;
  };
  /** REL-1084: `incremental` carries the service's own prior record for a carried-forward completion. */
  resolve(gate: StoredReviewGate, incremental?: IncrementalVerificationInput): Promise<TrustedGateCompletionContext>;
}
/** Bearer shape is only a transport check. Persistence compares this digest
 * with the exact dispatcher's token/execution/generation before trusting it. */
export function createWorkerCompletionVerifier(): WorkerCompletionVerifier {
  return { async verify(token) {
    if (!token.startsWith('ghs_')) throw new Error('worker completion requires a ghs_ installation token');
    return { workerTokenDigest: sha256(token) };
  } };
}
