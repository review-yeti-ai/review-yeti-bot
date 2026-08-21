import { canonicalJson, sha256 } from './reviewCore';

export interface PRSnapshotFile {
  path: string;
  patch?: string;
  status?: string;
  mode?: string;
  oldMode?: string;
  newMode?: string;
  old_mode?: string;
  new_mode?: string;
  oldSha?: string;
  newSha?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
  parentRepository?: string;
  oldSubmoduleUrl?: string;
  newSubmoduleUrl?: string;
  submoduleUrlChanged?: boolean;
}

export interface PRSnapshotInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  mergeBaseSha?: string;
  title?: string;
  configRef: string;
  configDigest: string;
  engineVersion: string;
  changedFiles: PRSnapshotFile[];
}

export interface PRSnapshot extends PRSnapshotInput {
  mergeBaseSha: string;
  title: string;
  snapshotDigest: string;
}

export class SnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotMismatchError';
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => freeze(child));
    Object.freeze(value);
  }
  return value;
}

export function snapshotDigest(snapshot: Omit<PRSnapshot, 'snapshotDigest'> | PRSnapshot): string {
  const { snapshotDigest: _ignored, ...identity } = snapshot as PRSnapshot;
  return sha256(canonicalJson(identity));
}

export function createPRSnapshot(input: PRSnapshotInput): PRSnapshot {
  const base = {
    ...input,
    mergeBaseSha: input.mergeBaseSha || input.baseSha,
    title: input.title || '',
    changedFiles: input.changedFiles.map((file) => ({ ...file })),
  };
  const snapshot = { ...base, snapshotDigest: snapshotDigest(base) } as PRSnapshot;
  return freeze(snapshot);
}

export function assertSnapshotCurrent(snapshot: PRSnapshot, current: { headSha: string; baseSha: string }): void {
  if (snapshot.headSha !== current.headSha) {
    throw new SnapshotMismatchError(`pull request head SHA changed from ${snapshot.headSha} to ${current.headSha}`);
  }
  if (snapshot.baseSha !== current.baseSha) {
    throw new SnapshotMismatchError(`pull request base SHA changed from ${snapshot.baseSha} to ${current.baseSha}`);
  }
  if (snapshotDigest(snapshot) !== snapshot.snapshotDigest) {
    throw new SnapshotMismatchError('pull request snapshot digest no longer matches its immutable contents');
  }
}
