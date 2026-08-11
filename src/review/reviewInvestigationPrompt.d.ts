import type { EvidenceTool } from './evidenceContracts';

export interface InvestigationMessagesInput { persona?: Record<string, unknown>; manifest?: string; diffText?: string; priorDecisionBlock?: string; optionalContextBlock?: string; remaining?: { calls?: number; turns?: number } }
export interface ParsedInvestigationResponse { reviewStatus: 'NEEDS_EVIDENCE' | 'COMPLETE'; riskPlan: Array<{ id: string; unitIds: string[]; statement: string; evidenceNeeded: string[]; allowedTools: EvidenceTool[] }>; evidenceRequests: Array<{ personaId?: string; riskId: string; tool: EvidenceTool; args: Record<string, unknown>; reason: string }>; riskDispositions: Array<{ riskId: string; status: 'confirmed' | 'rejected' | 'not_applicable' | 'incomplete'; reason: string }>; findings: Array<Record<string, unknown>> }
export function buildInvestigationMessages(input?: InvestigationMessagesInput): Array<{ role: 'system' | 'user'; content: string }>;
export function parseInvestigationResponse(content: string, limits?: Record<string, number>, options?: { personaId?: string }): ParsedInvestigationResponse;
