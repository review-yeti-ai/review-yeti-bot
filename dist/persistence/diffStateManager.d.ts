import { IDiffStateStorage, PRDiffState, TrackedFinding } from './db';
export interface IncomingHunkInput {
    filePath: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    hunkContent: string;
}
export interface IncomingFindingInput {
    filePath: string;
    startLine: number;
    endLine: number;
    persona: string;
    severity: 'critical' | 'major' | 'minor' | 'nit';
    comment: string;
    ruleId?: string;
    codeSnippet: string;
}
export interface ProcessPRUpdateInput {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    hunks: IncomingHunkInput[];
    quorumFindings?: IncomingFindingInput[];
}
export interface ProcessPRUpdateResult {
    previousState: PRDiffState | null;
    currentState: PRDiffState;
    hunksToReview: IncomingHunkInput[];
    activeFindings: TrackedFinding[];
    resolvedFindings: TrackedFinding[];
    suppressedFindingHashes: string[];
}
export declare class DiffStateManager {
    private storage;
    constructor(storage: IDiffStateStorage);
    processPRCommitUpdate(input: ProcessPRUpdateInput): Promise<ProcessPRUpdateResult>;
}
