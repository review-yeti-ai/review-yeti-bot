export interface ReviewIdentity {
  schemaVersion: 'review-identity-v1';
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  configDigest: string;
  policyDigest: string;
}

export interface ReviewSink {
  schemaVersion: string;
  emit(event: unknown): Promise<void>;
}

export function createReviewIdentity(input: {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  trustedConfig?: unknown;
  effectivePolicy?: unknown;
}): ReviewIdentity;
export function reviewIdentityDigest(identity: ReviewIdentity): string;
export function createNoopReviewEventSink(): ReviewSink;
export function createNoopReviewTelemetrySink(): ReviewSink;
