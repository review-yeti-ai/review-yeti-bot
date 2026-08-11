export type ReviewDispatchVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK' | 'NO_VERDICT';
export type ReviewDispatchStatus = 'SHIP' | 'FIX_FIRST' | 'BLOCK' | 'PARTIAL_REVIEW' | 'INCOMPLETE_REVIEW';
export type ReviewDispatchCoverageStatus = 'complete' | 'partial' | 'incomplete' | 'unknown';
export type ReviewDispatchGateDecision = 'PASS' | 'BLOCKED';
export type ReviewDispatchStageStatus = 'not_run' | 'completed' | 'partial' | 'failed';

export interface ReviewDispatchIdentity {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  configDigest: string;
  policyDigest: string;
  diffDigest: string;
}

export interface ReviewDispatchUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
}

export interface ReviewDispatchStages {
  dispatch?: ReviewDispatchStageStatus;
  investigation?: ReviewDispatchStageStatus;
  arbitration?: ReviewDispatchStageStatus;
}

export interface ReviewDispatchInvestigationSummary {
  schemaVersion: 'review-investigation-summary-v1';
  laneCount: number;
  evidenceReceipts: number;
  complete: boolean;
}

export interface ReviewDispatchManifestUnit {
  id: string;
  path: string;
  range: { side: 'LEFT' | 'RIGHT'; start: number; end: number };
  contentDigest: string;
  blobDigest: string;
  status: 'selected' | 'completed' | 'reused' | 'failed' | 'waived' | 'excluded' | 'oversized' | 'unreviewable';
  reason?: string;
  change?: string;
  diffChars?: number;
}

export interface ReviewDispatchManifest {
  schemaVersion: 'review-unit-manifest-v1';
  identity: ReviewDispatchIdentity;
  policyDigest: string;
  createdAt?: string;
  units: ReviewDispatchManifestUnit[];
  coverage: {
    complete: boolean;
    shipEligible: boolean;
    uncoveredPaths: string[];
    failedPaths: string[];
    uncovered: number;
  };
  summary: {
    total: number;
    selected?: number;
    completed?: number;
    reused?: number;
    failed?: number;
    waived?: number;
    excluded?: number;
    oversized?: number;
    unreviewable?: number;
    uncovered: number;
    shipEligible: boolean;
  };
  unitsTotal: number;
  unitsEmitted: number;
  unitsOmitted: number;
  digest: string;
}

export interface ReviewDispatchProviderReceipts {
  count: number;
  ids: string[];
  digest?: string;
}

export interface ReviewDispatchReceipt {
  schemaVersion: 'review-dispatch-run.v1';
  identity: ReviewDispatchIdentity;
  verdict: ReviewDispatchVerdict;
  reviewStatus: ReviewDispatchStatus;
  coverageStatus: ReviewDispatchCoverageStatus;
  gateDecision: ReviewDispatchGateDecision;
  mergeEligible: boolean;
  findings: { total: number; p0: number; p1: number; p2: number };
  personas: { completed: number; total: number };
  investigation: ReviewDispatchInvestigationSummary;
  manifest: ReviewDispatchManifest;
  providerReceipts: ReviewDispatchProviderReceipts;
  stages?: ReviewDispatchStages;
  usage?: ReviewDispatchUsage;
  latencyMs?: number;
  receiptDigest: string;
}

export const REVIEW_DISPATCH_SCHEMA_VERSION: 'review-dispatch-run.v1';
export const INVESTIGATION_SCHEMA_VERSION: 'review-investigation-summary-v1';
export function buildReviewDispatchReceipt(input: {
  identity: ReviewDispatchIdentity;
  manifest: import('./reviewUnitManifest').ReviewUnitManifest | Record<string, unknown>;
  verdict: ReviewDispatchVerdict;
  reviewStatus: ReviewDispatchStatus;
  coverageStatus: ReviewDispatchCoverageStatus;
  gateDecision: ReviewDispatchGateDecision;
  mergeEligible: boolean;
  metrics: { totalFindings: number; p0Count: number; p1Count: number; p2Count: number };
  personasCompleted: number;
  personasTotal: number;
  investigationSummary: ReviewDispatchInvestigationSummary;
  providerReceiptIds?: string[];
  stages?: ReviewDispatchStages;
  usage?: Partial<ReviewDispatchUsage>;
  latencyMs?: number;
}): ReviewDispatchReceipt;
export function validateReviewDispatchReceipt(receipt: unknown, expectedIdentity?: ReviewDispatchIdentity): { valid: boolean; errors: string[] };
