export type ReviewSourceKind = 'refs' | 'diff-file' | 'pull-request';
export interface ReviewSource {
  kind: ReviewSourceKind;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  diffText: string;
  title?: string;
  sourceDigest: string;
  changedFiles?: Array<Record<string, unknown>>;
}
export function selectSource(options: Record<string, unknown>): Record<string, unknown>;
export function resolveReviewSource(selection: Record<string, unknown>, dependencies?: Record<string, unknown>): Promise<ReviewSource>;
