export type InvestigationTermination = 'completed' | 'reused' | 'budget_exhausted' | 'provider_failure' | 'timeout' | 'cancelled' | 'repeated_call' | 'malformed_response' | 'unresolved_evidence' | 'verification_incomplete';
export type EvidenceTool = 'file_read' | 'file_find' | 'code_search' | 'file_read_diff' | 'library_docs';
export interface InvestigationLimits { maxCalls: number; maxReadLines: number; maxSearchMatches: number; maxResultBytes: number; maxRepeatedCalls: number; maxCandidateFindings: number; maxVerifierCallsPerFinding: number; maxTurns: number }
export interface RiskPlan { schemaVersion: 'review-risk-plan-v1'; identityDigest: string; personaId: string; items: ReadonlyArray<{ id: string; unitIds: string[]; statement: string; evidenceNeeded: string[]; allowedTools: EvidenceTool[] }>; planDigest: string }
export interface EvidenceReceipt { schemaVersion: 'review-evidence-receipt-v1'; identityDigest: string; id: string; personaId: string; riskId: string; tool: EvidenceTool; argumentDigest: string; resultDigest: string; status: 'ok' | 'unavailable' | 'invalid' | 'cancelled'; truncated: boolean; byteCount: number; latencyMs: number; reason?: string }
export interface LaneExecutionReceipt { schemaVersion: 'review-lane-execution-v1'; identityDigest: string; personaId: string; planDigest: string; evidenceReceiptIds: string[]; findingKeys: string[]; completedUnitIds: string[]; termination: InvestigationTermination; turns: number; evidenceCalls: number; complete: boolean; receiptDigest: string }
export const DEFAULT_INVESTIGATION_LIMITS: InvestigationLimits;
export const HARD_INVESTIGATION_LIMITS: InvestigationLimits;
export function normalizeInvestigationLimits(input?: Record<string, unknown>): InvestigationLimits;
export function createRiskPlan(input: { identity: import('./reviewContracts').ReviewIdentity; personaId: string; items: unknown[] }): RiskPlan;
export function createEvidenceReceipt(input: { identity: import('./reviewContracts').ReviewIdentity; request: Record<string, unknown>; result: Record<string, unknown>; latencyMs?: number }): EvidenceReceipt;
export function createLaneExecutionReceipt(input: { identity: import('./reviewContracts').ReviewIdentity; personaId: string; plan: RiskPlan; evidence?: EvidenceReceipt[]; findings?: Record<string, unknown>[]; termination: InvestigationTermination; turns?: number; completedUnitIds?: string[] }): LaneExecutionReceipt;
export function validateLaneExecutionReceipt(receipt: unknown): { valid: boolean; reason?: string };
