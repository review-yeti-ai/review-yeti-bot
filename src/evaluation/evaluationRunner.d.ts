import type { EvaluationReceipt, EvaluationRequest } from './evaluationContracts';

export interface EvaluationComparison {
  status: 'PASS' | 'BLOCKED' | 'INCONCLUSIVE';
  failures: string[];
  metrics: Record<string, number | null>;
}

export interface EvaluationDependencies {
  readFile?: (path: string, encoding: string) => string;
  offlineEvaluator?: (matrix: unknown, request: EvaluationRequest) => Promise<unknown> | unknown;
  liveEvaluator?: (matrix: unknown, request: EvaluationRequest, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export function runEvaluation(input: Record<string, unknown>, dependencies?: EvaluationDependencies): Promise<EvaluationReceipt>;
export function runOfflineEvaluation(input: Record<string, unknown>, dependencies?: EvaluationDependencies): Promise<EvaluationReceipt>;
export function runLiveEvaluation(input: Record<string, unknown>, dependencies?: EvaluationDependencies): Promise<EvaluationReceipt>;
export function compareEvaluationReceipts(baseline: EvaluationReceipt, candidate: EvaluationReceipt): EvaluationComparison;
