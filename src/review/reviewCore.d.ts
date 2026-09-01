export type CanonicalVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK';
export type ReviewStatus = CanonicalVerdict | 'INCOMPLETE_REVIEW';

export interface ReviewFinding {
  severity: 'P0' | 'P1' | 'P2';
  path: string;
  line: number;
  title: string;
  body: string;
  suggestion?: string;
  confidence?: number;
}

export interface ReviewChangedFile {
  path: string;
  patch?: string;
}

export interface ReviewLane {
  id?: string;
  required?: boolean;
  decision?: string;
  status?: string;
  error?: string;
  findings?: ReviewFinding[];
}

export interface CanonicalArbitration {
  totalPersonas: number;
  completedPersonas: number;
  quorumSatisfied: boolean;
  verdict: CanonicalVerdict;
  status: ReviewStatus;
  rationale: string;
  thresholds: { blockP1: number; fixP2: number };
  metrics: { p0Count: number; p1Count: number; p2Count: number; totalFindings: number };
  findings: ReviewFinding[];
}

export interface CoverageGap {
  path?: string;
  reason?: string;
}

export interface ArbitrationOptions {
  changedFiles?: ReviewChangedFile[];
  coverageComplete?: boolean;
  /**
   * Named evidence/coverage artifacts that caused `coverageComplete` to be false (e.g. a
   * submodule policy decision or a failed `.gitmodules` fetch). When a clean persona panel is
   * forced BLOCK by coverage alone, computeArbitration names these in the rationale instead of
   * reusing the clean-panel "Quorum satisfied" sentence (REL-491).
   */
  coverageGaps?: Array<string | CoverageGap>;
  candidateVerdict?: CanonicalVerdict;
  rationale?: string;
}

export function canonicalize(value: unknown): unknown;
export function canonicalJson(value: unknown): string;
export function sha256(value: unknown): string;
export function changedLineNumbers(patch?: string): Set<number> | null;
export function sanitizeFinding(raw: unknown, changedFiles?: ReviewChangedFile[]): ReviewFinding | null;
export function sanitizeFindings(raw: unknown, changedFiles?: ReviewChangedFile[]): ReviewFinding[];
export interface ReviewFindingsValidation {
  valid: boolean;
  findings: ReviewFinding[];
  index?: number;
  error?: string;
}
export function validateReviewFindings(raw: unknown, changedFiles?: ReviewChangedFile[]): ReviewFindingsValidation;
export function describeCoverageGaps(coverageGaps?: Array<string | CoverageGap>): string[];
export function computeArbitration(
  personaResults: ReviewLane[],
  expectedPersonas?: number,
  options?: ArbitrationOptions,
): CanonicalArbitration;
