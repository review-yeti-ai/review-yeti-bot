import type {
  ExactBlobSnapshot,
  FindingVerifierIdentity,
  FindingVerificationReceipt,
} from './findingVerifier';

export type FindingReflectionStatus = 'KEEP' | 'DOWNGRADE' | 'DROP' | 'NEEDS_REVIEW';
export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface FindingReflectionLimits {
  maxCandidates: number;
  maxCalls: number;
  maxTokens: number;
  concurrency: number;
  timeoutMs: number;
  trustedCostCeilingUSD?: number;
}

export interface FindingReflectionReceiptRow {
  schemaVersion: 'finding-reflection-v1';
  findingKey: string;
  status: FindingReflectionStatus;
  reasonCode: string;
  originalSeverity: FindingSeverity;
  severity?: FindingSeverity;
  path?: string;
  side?: 'RIGHT' | 'LEFT';
  line?: number;
}

export interface FindingReflectionTurnInput {
  candidate: Record<string, unknown> & { severity: FindingSeverity };
  verification: FindingVerificationReceipt;
  messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }>;
  maxTokens: number;
  timeoutMs: number;
  costCeilingUSD?: number;
  signal: AbortSignal;
}

export interface FindingReflectionTurnResponse {
  ok: boolean;
  content?: string;
  error?: string;
  usage?: {
    promptTokens?: number;
    prompt_tokens?: number;
    completionTokens?: number;
    completion_tokens?: number;
    totalTokens?: number;
    total_tokens?: number;
    costUSD?: number;
    cost?: number;
  };
}

export interface FindingReflectionReceipt {
  schemaVersion: 'finding-reflection-v1';
  limits: Readonly<FindingReflectionLimits>;
  reflections: ReadonlyArray<FindingReflectionReceiptRow>;
  summary: {
    candidates: number;
    kept: number;
    downgraded: number;
    dropped: number;
    needsReview: number;
    overflow: number;
    incomplete: boolean;
  };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUSD?: number };
}

export interface RunFindingReflectionInput {
  findings: Array<Record<string, unknown> & { severity: FindingSeverity }>;
  changedFiles: Array<Record<string, unknown>>;
  exactBlobSnapshot: ExactBlobSnapshot;
  identity: FindingVerifierIdentity;
  reflectTurn(input: FindingReflectionTurnInput): Promise<FindingReflectionTurnResponse>;
  limits?: Partial<Omit<FindingReflectionLimits, 'trustedCostCeilingUSD'>>;
  trustedCostCeilingUSD?: number;
  seenClaims?: Map<string, string> | Set<string>;
  signal?: AbortSignal;
}

export const SCHEMA_VERSION: 'finding-reflection-v1';
export const DEFAULT_REFLECTION_LIMITS: Readonly<Omit<FindingReflectionLimits, 'trustedCostCeilingUSD'>>;
export const HARD_REFLECTION_LIMITS: Readonly<Omit<FindingReflectionLimits, 'trustedCostCeilingUSD'>>;
export function normalizeReflectionLimits(
  input?: Partial<Omit<FindingReflectionLimits, 'trustedCostCeilingUSD'>>,
  trustedCostCeilingUSD?: number,
): Readonly<FindingReflectionLimits>;
export function runFindingReflection(input: RunFindingReflectionInput): Promise<{
  schemaVersion: 'finding-reflection-v1';
  findings: ReadonlyArray<Record<string, unknown> & { severity: FindingSeverity }>;
  verification: ReturnType<typeof import('./findingVerifier').verifyFindings>;
  receipt: FindingReflectionReceipt;
}>;
