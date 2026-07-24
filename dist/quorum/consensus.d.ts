import { Persona, CtReviewConfig } from '../config/schema';
import { mefEngineResult, PersonaFinding } from './mefEngine';
import { TicketValidationResult } from '../ticket/ticketValidator';
import { ConstitutionEvaluationResult, ParsedConstitution } from '../constitution/constitutionEngine';
import { DiffStateManager, IncomingHunkInput } from '../persistence/diffStateManager';
import { TrackedFinding } from '../persistence/db';
export type SeverityLevel = 'critical' | 'major' | 'minor' | 'nit';
export type QuorumDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export interface InlineReviewComment {
    path: string;
    line: number;
    start_line?: number;
    side: 'RIGHT';
    body: string;
}
export interface QuorumConsensusInput {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    config: CtReviewConfig;
    hunks?: IncomingHunkInput[];
    mefResult?: mefEngineResult;
    personaFindingsMap?: Record<Persona, PersonaFinding[]>;
    ticketResult?: TicketValidationResult;
    constitutionResult?: ConstitutionEvaluationResult;
    prTitle?: string;
    prBody?: string;
    changedFiles?: Array<{
        path: string;
        patch?: string;
        content?: string;
    }>;
    constitution?: ParsedConstitution;
}
export interface QuorumResult {
    summary: string;
    decision: QuorumDecision;
    findings: PersonaFinding[];
    activeFindings: PersonaFinding[];
    filteredNits: PersonaFinding[];
    resolvedFindings: TrackedFinding[];
    suppressedFindingHashes: string[];
    ticketValidation: TicketValidationResult;
    constitutionCompliance: ConstitutionEvaluationResult;
    formattedMarkdown: string;
    inlineComments: InlineReviewComment[];
    stats: {
        totalFindingsRaw: number;
        totalFindingsDeduplicated: number;
        activeFindingsCount: number;
        filteredNitsCount: number;
        resolvedFindingsCount: number;
        suppressedFindingsCount: number;
        personasExecuted: Persona[];
        approvingPersonas: Persona[];
        requestingChangesPersonas: Persona[];
        tokensUsed: number;
    };
}
export declare function deduplicateAcrossPersonas(findings: PersonaFinding[]): PersonaFinding[];
export declare function formatInlineComments(findings: PersonaFinding[]): InlineReviewComment[];
export declare function buildPRSummaryMarkdown(params: {
    decision: QuorumDecision;
    ticketResult: TicketValidationResult;
    constitutionResult: ConstitutionEvaluationResult;
    minApprovals: number;
    configuredPersonas: Persona[];
    executedPersonas: Persona[];
    failedPersonas: Persona[];
    approvingPersonas: Persona[];
    requestingChangesPersonas: Persona[];
    activeFindings: PersonaFinding[];
    filteredNits: PersonaFinding[];
    resolvedFindingsCount?: number;
    tokensUsed: number;
}): string;
export declare function aggregateQuorumConsensus(input: QuorumConsensusInput, diffStateManager?: DiffStateManager): Promise<QuorumResult>;
