import type { EvaluationReceipt } from './evaluationContracts';

export interface EvaluationReceiptSummary {
  filePath: string;
  runId: string;
  status: string;
  mode: string;
  fixtureId: string;
  sourceSha: string;
  completedAt: string;
}

export function defaultDirectory(): string;
export function writeEvaluationReceipt(receipt: EvaluationReceipt, options?: { directory?: string }): { jsonPath: string; markdownPath: string };
export function readEvaluationReceipt(filePath: string): EvaluationReceipt;
export function listEvaluationReceipts(directory?: string): EvaluationReceiptSummary[];
export function renderEvaluationReport(receipt: EvaluationReceipt | Record<string, unknown>): string;
