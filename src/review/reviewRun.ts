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

export interface ReviewStageContext {
  run: ReviewRun;
  artifacts: Readonly<Partial<Record<PiStage, JsonValue>>>;
  publicationFence?: string;
}
