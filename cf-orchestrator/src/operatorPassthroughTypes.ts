export interface OperatorPassthroughTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface OperatorPassthroughPolicySource {
  repositoryId: number;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export interface OperatorPassthroughPolicyIdentity extends OperatorPassthroughPolicySource {
  sha: string;
  contentDigest: string;
}

/** Resolved only from current GitHub state and service-owned policy. */
export interface OperatorPassthroughIdentity {
  version: 'OperatorPassthroughIdentity.v1';
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  appId: number;
  policyDigest: string;
  policySource: OperatorPassthroughPolicyIdentity;
}

export interface OperatorPassthroughCheckReceipt {
  id: number;
  appId: number;
  name: 'Review Yeti' | 'Review Yeti Gate';
  externalId: string;
  headSha: string;
  status: 'completed';
  conclusion: 'success';
  annotationsCount: 0;
  title: string;
  summary: string;
}

export interface OperatorPassthroughReceipt {
  version: 'OperatorPassthroughReceipt.v2';
  status: 'succeeded' | 'unavailable';
  reason: 'operator_global_passthrough';
  errorCode?: string;
  runId: string;
  publicationId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  appId: number;
  policyDigest: string;
  policySource: OperatorPassthroughPolicyIdentity;
  reviewStarted: false;
  expectedLanes: 0;
  completedLanes: 0;
  candidateState: 'current' | 'unavailable';
  verdict: 'SHIP' | 'unavailable';
  publicationState: 'published' | 'unavailable';
  publicationReceiptAvailable: boolean;
  publicationIdempotent: true;
  auditDigest: string | null;
  workerCheckId: number | null;
  gateCheckId: number | null;
  priorControlRunIds: string[];
  findingsCount: 0;
  checks?: {
    worker: OperatorPassthroughCheckReceipt;
    gate: OperatorPassthroughCheckReceipt;
  };
  mergeEligible: boolean;
  recordedAt: string;
}

export interface OperatorPassthroughUnavailableResult {
  version: 'OperatorPassthroughReceipt.v2';
  status: 'unavailable';
  reason: 'operator_global_passthrough';
  errorCode: string;
  runId: null;
  publicationId: null;
  repositoryId: null;
  owner: null;
  repo: null;
  prNumber: null;
  headSha: null;
  baseSha: null;
  baseRef: null;
  appId: number;
  policyDigest: null;
  policySource: null;
  reviewStarted: false;
  expectedLanes: 0;
  completedLanes: 0;
  candidateState: 'unavailable';
  verdict: 'unavailable';
  publicationState: 'unavailable';
  publicationReceiptAvailable: false;
  publicationIdempotent: true;
  auditDigest: null;
  workerCheckId: null;
  gateCheckId: null;
  priorControlRunIds: string[];
  findingsCount: 0;
  mergeEligible: false;
}

export type OperatorPassthroughResult = OperatorPassthroughReceipt | OperatorPassthroughUnavailableResult;

export interface OperatorPassthroughStageState {
  creationState: 'not_started' | 'creating' | 'created';
  checkId: number | null;
  patchState: 'not_started' | 'patching' | 'completed';
}

export interface OperatorPassthroughState {
  version: 'OperatorPassthroughState.v1';
  runId: string;
  publicationId: string;
  identity: OperatorPassthroughIdentity;
  createdAt: number;
  cancelRequested: boolean;
  priorOutcomeChecked: boolean;
  priorControlRunIds: string[];
  stages: {
    review: OperatorPassthroughStageState;
    gate: OperatorPassthroughStageState;
  };
  receipt: OperatorPassthroughReceipt | null;
}

export interface OperatorPassthroughStageMutation {
  version: 'OperatorPassthroughStageMutation.v1';
  publicationId: string;
  stage: 'review' | 'gate';
  action: 'create-start' | 'created' | 'patch-start' | 'patched';
  checkId?: number;
}
