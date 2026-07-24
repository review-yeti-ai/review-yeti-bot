export interface HunkInput {
    filePath: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    hunkContent: string;
}
export interface FindingInput {
    filePath: string;
    persona: string;
    severity: 'critical' | 'major' | 'minor' | 'nit';
    codeSnippet: string;
    comment: string;
    ruleId?: string;
    findingId?: string;
    startLine?: number;
    endLine?: number;
    lineNumber?: number;
}
export interface DiffHashUtil {
    computeHunkHash(input: HunkInput): string;
    computeFindingHash(input: FindingInput): string;
    normalizeSnippet(snippet: string): string;
    normalizeComment(comment: string): string;
}
export declare function normalizeSnippet(snippet: string): string;
export declare function normalizeComment(comment: string): string;
export declare function computeHunkHash(input: HunkInput): string;
export declare function computeFindingHash(input: FindingInput): string;
export declare const diffHashUtil: DiffHashUtil;
