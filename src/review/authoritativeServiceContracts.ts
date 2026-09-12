import type { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import type { GateWorkerResultTransition, StoredReviewGate, TrustedGateCompletionContext } from './reviewGateContracts';
import type { WorkerCompletionProof, WorkerTerminalFailure, WorkerTerminalSuccess } from './workerCompletion';
import type { WorkerReviewCompletion } from './workerReviewCompletion';
import { sha256 } from './reviewCore';

export interface WorkerCompletionVerifier {
  verify(token: string, event: WorkerTerminalFailure | WorkerTerminalSuccess | WorkerReviewCompletion): Promise<WorkerCompletionProof>;
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
      resolve: (gate: StoredReviewGate) => Promise<TrustedGateCompletionContext>, now?: number): Promise<GateWorkerResultTransition>;
  };
  resolve(gate: StoredReviewGate): Promise<TrustedGateCompletionContext>;
}
/** Bearer shape is only a transport check. Persistence compares this digest
 * with the exact dispatcher's token/execution/generation before trusting it. */
export function createWorkerCompletionVerifier(): WorkerCompletionVerifier {
  return { async verify(token) {
    if (!token.startsWith('ghs_')) throw new Error('worker completion requires a ghs_ installation token');
    return { workerTokenDigest: sha256(token) };
  } };
}
