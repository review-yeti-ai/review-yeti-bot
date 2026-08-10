export type ReviewUnitStatus = 'selected' | 'completed' | 'reused' | 'failed' | 'waived' | 'excluded' | 'oversized' | 'unreviewable';

export interface ReviewUnitIdentity {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  configDigest: string;
  policyDigest: string;
  diffDigest: string;
}

export interface ReviewUnitManifest {
  schemaVersion: 'review-unit-manifest-v1';
  identity: ReviewUnitIdentity;
  policyDigest: string;
  createdAt?: string;
  units: ReadonlyArray<{ id: string; path: string; range: { side: 'LEFT' | 'RIGHT'; start: number; end: number }; contentDigest: string; blobDigest: string; status: ReviewUnitStatus; reason?: string; change?: string; diffChars?: number }>;
  coverage: { complete: boolean; shipEligible: boolean; uncoveredPaths: string[]; failedPaths: string[] };
  summary: Record<string, number | boolean>;
}

export function stableReviewUnitId(input: Record<string, unknown>): string;
export function classifyReviewUnitFile(file: Record<string, unknown>, trustedPolicy?: Record<string, unknown>): { status: ReviewUnitStatus; reason?: string; path: string; change?: string; diffChars?: number };
export function createReviewUnitManifest(input: { identity: ReviewUnitIdentity; files: Record<string, unknown>[]; trustedRules?: Record<string, unknown>; policy?: Record<string, unknown>; now?: number | (() => number) }): ReviewUnitManifest;
