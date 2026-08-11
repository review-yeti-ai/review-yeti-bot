export interface NavigationSnapshotFile { ref: 'base' | 'head'; path: string; blobSha: string; patch?: string }
export interface NavigationSnapshot { schemaVersion: 'review-navigation-snapshot-v1'; repository: string; baseSha: string; headSha: string; files: ReadonlyArray<NavigationSnapshotFile>; complete: boolean; truncated: boolean }
export function fetchImmutableRepositorySnapshot(input: { identity: Record<string, unknown>; changedFiles?: Record<string, unknown>[]; token: string; fetchImplementation?: typeof fetch; apiBaseUrl?: string; signal?: AbortSignal }): Promise<NavigationSnapshot>;
