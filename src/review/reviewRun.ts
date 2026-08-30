import type { PiStage } from './piWorkflow';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ReviewRunStatus = 'queued' | 'running' | 'publishing' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';

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
  status: ReviewRunStatus;
  stage: PiStage;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  artifacts: Partial<Record<PiStage, string>>;
  publicationFence?: string;
  resultDigest?: string;
  error?: string;
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
  identity: ReviewRunIdentity;
  effectivePolicyDigest?: string;
  indexEpoch?: number;
}

export interface ReviewAdmission {
  status: 'accepted' | 'duplicate';
  deliveryId: string;
  repositoryId: number;
  installationId: number;
  receivedAt: number;
  terminalDeadline: number;
  payloadDigest: string;
  run: ReviewRun;
}

export interface ReviewDispatchClaim {
  runId: string;
  deliveryId: string;
  repositoryId: number;
  installationId: number;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface ReviewStageContext {
  run: ReviewRun;
  artifacts: Readonly<Partial<Record<PiStage, JsonValue>>>;
  publicationFence?: string;
}
