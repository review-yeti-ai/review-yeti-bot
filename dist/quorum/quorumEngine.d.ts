export interface PersonaFinding {
    persona: 'security' | 'architecture' | 'performance' | 'quality';
    severity: 'critical' | 'major' | 'minor' | 'nit';
    filePath: string;
    lineNumber: number;
    endLineNumber?: number;
    comment: string;
    codeSnippet?: string;
    suggestion?: string;
    ruleId?: string;
    coSponsoringPersonas?: Array<'security' | 'architecture' | 'performance' | 'quality'>;
}
export interface QuorumEvaluationInput {
    minApprovals: number;
    configuredPersonas: Array<'security' | 'architecture' | 'performance' | 'quality'>;
    personaFindings: Record<string, PersonaFinding[]>;
}
export interface QuorumEvaluationResult {
    decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    approvingPersonas: string[];
    requestingChangesPersonas: string[];
    activeFindings: PersonaFinding[];
    filteredNits: PersonaFinding[];
}
export declare function evaluateQuorum(input: QuorumEvaluationInput): QuorumEvaluationResult;
