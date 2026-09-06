export type ClaimType = 'generic' | 'absence' | 'missing-tests';

export interface ClaimLike {
  path?: string | null;
  line?: number | null;
  title?: string | null;
  body?: string | null;
}

export interface ClaimComparison {
  duplicate: boolean;
  similarity: number;
  reason: string;
}

export interface CompareClaimsOptions {
  threshold?: number;
  strongThreshold?: number;
  lineWindow?: number;
}

export const NEAR_DUPLICATE_LINE_WINDOW: number;
export const NEAR_DUPLICATE_THRESHOLD: number;
export const STRONG_DUPLICATE_THRESHOLD: number;
export const TITLE_WEIGHT: number;

export function claimTokens(text?: string | null): Set<string>;
export function findingClaimTokens(finding: ClaimLike): Set<string>;
export function jaccard(a: Set<string>, b: Set<string>): number;
export function claimSimilarity(a: ClaimLike, b: ClaimLike): number;
export function claimKey(finding: ClaimLike): string;
export function claimType(finding: ClaimLike): ClaimType;
export function assertsAbsence(finding: ClaimLike): boolean;
export function compareClaims(a: ClaimLike, b: ClaimLike, options?: CompareClaimsOptions): ClaimComparison;
export function isNearDuplicate(a: ClaimLike, b: ClaimLike, options?: CompareClaimsOptions): boolean;
