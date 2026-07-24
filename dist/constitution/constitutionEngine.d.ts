export type RuleType = 'directive' | 'forbidden_pattern' | 'mandatory_guideline';
export interface ConstitutionRule {
    id: string;
    type: RuleType;
    description: string;
    rawText: string;
    pattern?: RegExp;
}
export interface ParsedConstitution {
    title?: string;
    rules: ConstitutionRule[];
    rawContent: string;
}
export interface ConstitutionEvaluationInput {
    constitution: ParsedConstitution;
    config?: {
        enabled?: boolean;
        path?: string;
    };
    prTitle?: string;
    prBody?: string;
    changedFiles?: Array<{
        path: string;
        patch?: string;
        content?: string;
    }>;
}
export interface ConstitutionEvaluationResult {
    compliant: boolean;
    violations: string[];
    bypassed?: boolean;
}
export declare function parseConstitution(rawMarkdown: string): ParsedConstitution;
export declare function evaluateConstitution(input: ConstitutionEvaluationInput): ConstitutionEvaluationResult;
