import type { PiStage } from './piWorkflow';
import type { PreparedPublishingPolicy } from './preparedPublishingPolicy';
import type { WorkerFailureDiagnostics } from './workerCompletion';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ReviewRunStatus = 'queued' | 'running' | 'publishing' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';
export type PublicationMode = 'disabled' | 'app-gate';

export interface ReviewRunIdentity {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  snapshotDigest: string;
  configDigest: string;
}

export interface ReviewRun {
  runId: string;
  identity: ReviewRunIdentity;
  identityDigest: string;
  effectivePolicyDigest: string;
  effectiveConfigDigest: string;
  indexEpoch: number;
  repositoryId?: number;
  installationId?: number;
  deliveryId?: string;
  receivedAt?: number;
  terminalDeadline?: number;
  publicationMode?: PublicationMode;
  authoritativeGateAppId?: number;
  status: ReviewRunStatus;
  stage: PiStage;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  artifacts: Partial<Record<PiStage, string>>;
  publicationFence?: string;
  resultDigest?: string;
  error?: string;
  /** Last terminal worker diagnostic; provider text is redacted and bounded. */
  failureDiagnostics?: WorkerFailureDiagnostics & { failureClass?: string; executionAttempt?: number };
  createdAt: number;
  updatedAt: number;
}

export interface ReviewAdmissionInput {
  deliveryId: string;
  eventName: string;
  repositoryId: number;
  installationId: number;
  receivedAt: number;
  terminalDeadline: number;
  payloadDigest: string;
  publicationMode: PublicationMode;
  identity: ReviewRunIdentity;
  effectivePolicyDigest?: string;
  indexEpoch?: number;
  /** Service-controlled same-head recovery; never decoded from an unverified request. */
  retryRequested?: boolean;
  /**
   * One-based worker execution generation that the trusted recovery request
   * is allowed to replace. The durable outbox must still be immediately before
   * this generation; replaying an older signed action is therefore a no-op.
   */
  retryAfterExecutionAttempt?: number;
  /** Service-resolved only; never decoded from an Action/worker request. */
  authoritativeGate?: { expectedAppId: number; prepared: PreparedPublishingPolicy };
}

export interface ReviewAdmission {
  status: 'accepted' | 'duplicate';
  deliveryId: string;
  repositoryId: number;
  installationId: number;
  publicationMode: PublicationMode;
  receivedAt: number;
  terminalDeadline: number;
  payloadDigest: string;
  run: ReviewRun;
}

export interface ReviewDispatchClaim {
  runId: string;
  deliveryId: string;
  /** Monotonic outbox claim generation; advances even when executionAttempt does not. */
  claimAttempt: number;
  /**
   * Monotonic execution attempt for the projected Job/Secret identity. This is
   * deliberately separate from the outbox claim count: a projection retry must
   * remain idempotent, while a new worker execution needs a fresh Kubernetes
   * object after the previous one reached a terminal state.
   */
  executionAttempt: number;
  /** Digest of the per-attempt worker bearer, if this execution was provisioned before a retry. */
  workerTokenDigest?: string;
  repositoryId: number;
  installationId: number;
  publicationMode: PublicationMode;
  authoritativeGateAppId?: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  receivedAt: number;
  terminalDeadline: number;
  policyDigest: string;
  configDigest: string;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface ReviewStageContext {
  run: ReviewRun;
  artifacts: Readonly<Partial<Record<PiStage, JsonValue>>>;
  publicationFence?: string;
}
