export type ReviewResumeIdentity = {
  repository: string;
  prNumber: string | number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
};

export type ReviewPublicationChunk = { kind?: string; [key: string]: unknown };

export declare const SCHEMA_VERSION: 'durable-review-resume-v1';
export declare function artifactNameForReviewAttempt(identity: ReviewResumeIdentity, attempt: number): string;
export declare function identityDigest(identity: ReviewResumeIdentity): string;
export declare function canonicalJson(value: unknown): string;

export type DurableReviewResumeStore = {
  create(input: { identity: ReviewResumeIdentity; attempt: number; planDigest: string; chunks: ReviewPublicationChunk[] }): { filePath: string; manifest: Record<string, unknown> };
  read(filePath: string, expectedIdentity?: ReviewResumeIdentity): Record<string, unknown>;
  acquireLease(filePath: string, input: { owner: string; ttlMs?: number }): { owner: string; fence: number; generation: number; acquiredAt: string; expiresAt: string };
  update(filePath: string, lease: { owner: string; fence: number; generation: number }, updater: (payload: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown>;
};

export declare function createDurableReviewResumeStore(options?: { baseDir?: string; now?: () => Date }): DurableReviewResumeStore;
export declare function replayDurableReviewPublication(options: {
  store: DurableReviewResumeStore;
  filePath: string;
  expectedIdentity: ReviewResumeIdentity;
  owner: string;
  authorizeReplay: boolean | ((input: { identity: ReviewResumeIdentity; manifestDigest: string }) => boolean | Promise<boolean>);
  ledger: { getPublishedChunkIds(input: Record<string, unknown>): Promise<string[] | Set<string>> };
  publishChunk(input: Record<string, unknown>): Promise<{ publicationId?: string }>;
  signal?: AbortSignal;
  batchSize?: number;
  maxAttempts?: number;
  leaseTtlMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<{ status: 'accepted' | 'cancelled' | 'dead_letter'; filePath: string; published: number; skipped: number; deadLettered: number }>;
