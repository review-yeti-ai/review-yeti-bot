export type CanonicalVerdict = 'SHIP' | 'FIX_FIRST' | 'BLOCK';
export type ReviewStatus = CanonicalVerdict | 'INCOMPLETE_REVIEW';

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

export interface ArbitrationOptions {
  changedFiles?: ReviewChangedFile[];
  coverageComplete?: boolean;
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
