export type CoverageQuorum = 'two_thirds' | 'simple_majority' | 'unanimous';
export type CoverageStatus = 'complete' | 'partial' | 'incomplete';

export interface CoveragePolicy {
  quorum: CoverageQuorum;
  min_personas: number;
  mandatory_personas: string[];
  provider_diversity_min: number;
}

export interface CoverageLane {
  id?: string;
  personaId?: string;
  provider?: string;
  model?: string;
  decision?: string;
  status?: string;
  error?: string;
  partial?: number;
  findings?: unknown[];
  [key: string]: unknown;
}

export interface ClassifiedLane {
  id: string;
  status: 'verdict' | 'error' | 'timeout' | 'empty' | 'partial' | 'invalid';
  trustworthy: boolean;
  provider?: string;
  model?: string;
}

export interface CoverageEvaluation {
  status: CoverageStatus;
  coverageStatus: CoverageStatus;
  policy: CoveragePolicy;
  expectedPersonaIds: string[];
  expectedCount: number;
  required: number;
  trustworthyPersonaIds: string[];
  trustworthyCount: number;
  failedPersonaIds: string[];
  missingPersonaIds: string[];
  missingMandatoryPersonaIds: string[];
  mandatorySatisfied: boolean;
  minimumRosterSatisfied: boolean;
  numericQuorumSatisfied: boolean;
  providerDiversitySatisfied: boolean;
  distinctProviders: string[];
  classifications: ClassifiedLane[];
  mergeEligible: boolean;
}

export const DEFAULT_COVERAGE_POLICY: CoveragePolicy;
export function normalizeCoveragePolicy(input?: Partial<CoveragePolicy>): CoveragePolicy;
export function requiredCoverageCount(expectedCount: number, quorum?: CoverageQuorum): number;
export function classifyLane(lane: CoverageLane): ClassifiedLane;
export function evaluateCoverage(input: {
  expectedPersonaIds: string[];
  lanes?: CoverageLane[];
  policy?: Partial<CoveragePolicy>;
}): CoverageEvaluation;
