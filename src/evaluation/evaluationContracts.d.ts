export type EvaluationMode = 'offline' | 'live';
export type EvaluationStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'BLOCKED';

export interface EvaluationRequest {
  schemaVersion: 'review-yeti-evaluation-v1';
  evaluatorVersion: string;
  mode: EvaluationMode;
  repository: string;
  sourceSha: string;
  fixtureId: string;
  fixtureDigest: string;
  fixturePath?: string;
  baselinePath?: string;
  repetitions: number;
  concurrency: number;
  outputDir?: string;
  requestedAt: string;
}

export interface EvaluationUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number | null;
}

export interface EvaluationScenarioResult {
  id: string;
  status: EvaluationStatus;
  expected?: EvaluationStatus;
  errorClass?: string;
  latencyMs?: number;
  usage: EvaluationUsage;
}

export interface EvaluationReceipt {
  schemaVersion: 'review-yeti-evaluation-v1';
  evaluatorVersion: string;
  runId: string;
  status: EvaluationStatus;
  request: EvaluationRequest;
  identity: Pick<EvaluationRequest, 'repository' | 'sourceSha' | 'fixtureId' | 'fixtureDigest'>;
  scenarioResults: EvaluationScenarioResult[];
  summary: Record<string, unknown>;
  usage: EvaluationUsage;
  provider?: string;
  model?: string;
  startedAt: string;
  completedAt: string;
  error?: string;
}

export const EVALUATION_SCHEMA_VERSION: 'review-yeti-evaluation-v1';
export const EVALUATOR_VERSION: string;
export function createEvaluationRequest(input: Record<string, unknown>): EvaluationRequest;
export function createEvaluationReceipt(input: Record<string, unknown>): EvaluationReceipt;
export function normalizeEvaluationStatus(value: unknown): EvaluationStatus;
export function normalizeUsage(value: unknown): EvaluationUsage;
