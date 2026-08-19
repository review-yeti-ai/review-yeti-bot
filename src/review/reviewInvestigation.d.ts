import type { EvidenceReceipt, InvestigationLimits, LaneExecutionReceipt, RiskPlan } from './evidenceContracts';

export interface PersonaInvestigationResult {
  personaResult: { personaId: string; decision: 'APPROVE' | 'FINDINGS' | 'ERROR'; findings: unknown[]; partial: number; failure?: { class: string; reason: string; route: Record<string, unknown> }; [key: string]: unknown };
  executionReceipt: LaneExecutionReceipt;
  evidenceReceipts: readonly EvidenceReceipt[];
  riskPlan: RiskPlan;
}

export function runPersonaInvestigation(input: {
  identity: Record<string, unknown>;
  persona: { id: string; name?: string; charter?: string };
  manifest?: string;
  diffText?: string;
  diffFiles?: Array<{ path?: string; patch?: string }> | null;
  priorDecisionBlock?: string;
  optionalContextBlock?: string;
  limits?: Partial<InvestigationLimits>;
  evidenceRegistry: { call(tool: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> };
  requireEvidenceBoundary?: boolean;
  modelTurn(input: { messages: Array<{ role: string; content: string }>; turn: number; finalOnly: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  signal?: AbortSignal;
  clock?: () => number;
}): Promise<PersonaInvestigationResult>;

export const MAX_LANE_PROVIDER_RETRIES: number;
