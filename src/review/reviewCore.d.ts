export type CanonicalVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK';
export type ReviewStatus = CanonicalVerdict | 'PARTIAL_REVIEW' | 'INCOMPLETE_REVIEW';

export interface ReviewFinding {
  severity: 'P0' | 'P1' | 'P2';
  path: string;
  line: number;
  side?: 'RIGHT' | 'LEFT';
  title: string;
  body: string;
  suggestion?: string;
  replacementCode?: string;
  confidence?: number;
}

export interface ReviewChangedFile {
  path: string;
  patch?: string;
  mode?: string;
  oldMode?: string;
  newMode?: string;
  old_mode?: string;
  new_mode?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
}

export interface ReviewLane {
  id?: string;
  personaId?: string;
  required?: boolean;
  provider?: string;
  model?: string;
  effort?: string;
  decision?: string;
  status?: string;
  error?: string;
  partial?: number | boolean;
  findings?: ReviewFinding[];
}

export interface CanonicalArbitration {
  totalPersonas: number;
  completedPersonas: number;
  quorumSatisfied: boolean;
  coverageQuorumSatisfied?: boolean;
  coverageStatus?: 'complete' | 'partial' | 'incomplete';
  verdict: CanonicalVerdict;
  status: ReviewStatus;
  gateDecision?: 'PASS' | 'BLOCKED';
  mergeEligible?: boolean;
  rationale: string;
  thresholds: { blockP1: number; fixP2: number };
  metrics: { p0Count: number; p1Count: number; p2Count: number; totalFindings: number };
  findings: ReviewFinding[];
  coverage?: import('./coveragePolicy').CoverageEvaluation;
}

export interface ArbitrationOptions {
  changedFiles?: ReviewChangedFile[];
  coverageComplete?: boolean;
  expectedPersonaIds?: string[];
  coveragePolicy?: Partial<import('./coveragePolicy').CoveragePolicy>;
  candidateVerdict?: CanonicalVerdict;
  rationale?: string;
}

export function canonicalize(value: unknown): unknown;
export function canonicalJson(value: unknown): string;
export function sha256(value: unknown): string;
export function changedLineNumbers(patch?: string, side?: 'RIGHT' | 'LEFT'): Set<number> | null;
export function sanitizeFinding(raw: unknown, changedFiles?: ReviewChangedFile[]): ReviewFinding | null;
export function sanitizeFindings(raw: unknown, changedFiles?: ReviewChangedFile[]): ReviewFinding[];
export function computeArbitration(
  personaResults: ReviewLane[],
  expectedPersonas?: number,
  options?: ArbitrationOptions,
): CanonicalArbitration;
