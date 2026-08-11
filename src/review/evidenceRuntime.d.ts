import type { EvidenceReceipt, InvestigationLimits } from './evidenceContracts';

export interface EvidenceRuntimeOutput {
  receiptId: string;
  riskId: string;
  tool: string;
  result: Record<string, unknown>;
}

export interface EvidenceExecution {
  complete: boolean;
  termination: 'continue' | 'repeated_call' | 'budget_exhausted' | 'cancelled' | 'unresolved_evidence';
  outputs: EvidenceRuntimeOutput[];
}

export interface EvidenceRuntime {
  execute(requests: unknown[], options?: { signal?: AbortSignal }): Promise<EvidenceExecution>;
  remaining(): { calls: number; maxCalls: number };
  receipts(): readonly EvidenceReceipt[];
}

export function createEvidenceRuntime(options: {
  identity: Record<string, unknown>;
  registry: { call(tool: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> };
  limits?: Partial<InvestigationLimits>;
  clock?: () => number;
}): EvidenceRuntime;

export function boundUntrustedResult(result: unknown, maxBytes: number): Record<string, unknown>;
export function normalizedCallKey(request: { tool: string; args?: Record<string, unknown> }): string;
