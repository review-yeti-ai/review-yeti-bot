export type FindingStatus = 'IDENTIFIED' | 'RESOLVED' | 'SUPPRESSED';
export interface TrackedFinding {
    id?: number;
    prStateId?: number;
    fingerprintHash: string;
    filePath: string;
    startLine: number;
    endLine: number;
    persona: string;
    severity: 'critical' | 'major' | 'minor' | 'nit';
    comment: string;
    status: FindingStatus;
    firstSeenCommit: string;
    lastSeenCommit: string;
    resolvedAtCommit: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface TrackedHunk {
    id?: number;
    prStateId?: number;
    filePath: string;
    hunkHash: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    commitSha: string;
    createdAt: string;
}
export interface PRDiffState {
    id?: number;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    updatedAt: string;
    hunks: TrackedHunk[];
    findings: TrackedFinding[];
}
export interface IDiffStateStorage {
    init(): Promise<void>;
    getPRState(owner: string, repo: string, prNumber: number): Promise<PRDiffState | null>;
    savePRState(state: PRDiffState): Promise<void>;
    getFindings(owner: string, repo: string, prNumber: number): Promise<TrackedFinding[]>;
    updateFindingStatus(owner: string, repo: string, prNumber: number, fingerprintHash: string, status: FindingStatus, commitSha: string): Promise<void>;
    close(): Promise<void>;
}
export declare class SqliteDiffStateStorage implements IDiffStateStorage {
    private db;
    private dbPath;
    constructor(dbPath?: string);
    init(): Promise<void>;
    getPRState(owner: string, repo: string, prNumber: number): Promise<PRDiffState | null>;
    savePRState(state: PRDiffState): Promise<void>;
    getFindings(owner: string, repo: string, prNumber: number): Promise<TrackedFinding[]>;
    updateFindingStatus(owner: string, repo: string, prNumber: number, fingerprintHash: string, status: FindingStatus, commitSha: string): Promise<void>;
    close(): Promise<void>;
}
export declare class JsonFileDiffStateStorage implements IDiffStateStorage {
    private jsonPath;
    private data;
    private lastMtimeMs;
    constructor(jsonPath?: string);
    private reloadIfDiskModified;
    init(): Promise<void>;
    private getKey;
    private flushToDisk;
    getPRState(owner: string, repo: string, prNumber: number): Promise<PRDiffState | null>;
    savePRState(state: PRDiffState): Promise<void>;
    getFindings(owner: string, repo: string, prNumber: number): Promise<TrackedFinding[]>;
    updateFindingStatus(owner: string, repo: string, prNumber: number, fingerprintHash: string, status: FindingStatus, commitSha: string): Promise<void>;
    close(): Promise<void>;
}
export declare function createDiffStateStorage(dbPath?: string, jsonPath?: string): Promise<IDiffStateStorage>;
