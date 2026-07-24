import { Persona, EffortLevel, CtReviewConfig } from '../config/schema';
import { OmniRouteAdapter } from '../router/omniRouteAdapter';
import { QuorumReviewContext, PersonaFinding, PRDiffFile } from './personas';
export { QuorumReviewContext, PersonaFinding, PRDiffFile };
export interface mefEngineOptions {
    config: CtReviewConfig;
    router: OmniRouteAdapter;
    personaEffortOverrides?: Partial<Record<Persona, EffortLevel>>;
    timeoutMsPerPersona?: number;
}
export interface PersonaExecutionResult {
    persona: Persona;
    success: boolean;
    findings: PersonaFinding[];
    rawResponse?: string;
    tokensUsed?: {
        prompt: number;
        completion: number;
        total: number;
    };
    providerUsed?: string;
    modelUsed?: string;
    executionTimeMs: number;
    error?: string;
}
export interface mefEngineResult {
    personaResults: Record<string, PersonaExecutionResult>;
    allFindings: PersonaFinding[];
    stats: {
        totalPersonasConfigured: number;
        personasExecuted: Persona[];
        personasFailed: Persona[];
        totalTokensUsed: number;
        totalExecutionTimeMs: number;
    };
}
export declare function executeQuorumFanOut(context: QuorumReviewContext, options: mefEngineOptions): Promise<mefEngineResult>;
