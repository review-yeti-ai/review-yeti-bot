import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCRATCH_OWNER_MANIFEST = '.ct-review-yeti-scratch-owner.json';

export class ScratchChildrenLiveError extends Error {}

export interface ScratchOwnerMetadata {
  schema: 'review-yeti-scratch-owner.v1';
  ownerId: string;
  kind: string;
  pid: number;
  parentPid: number;
  processStartId: string;
  processStartedAt: string;
  createdAt: string;
  rootName: string;
  runId: string;
  parentOwnerId?: string;
}

export interface ScratchOwner {
  readonly path: string;
  readonly manifestPath: string;
  readonly metadata: Readonly<ScratchOwnerMetadata>;
  cleanup(): void;
}

interface ScratchOwnerOptions {
  prefix: string;
  kind: string;
  parentDir?: string;
  runId?: string;
  parentOwnerId?: string;
}

interface ScratchOwnerState {
  root: string;
  parent: string;
  parentIdentity: FileIdentity;
  rootIdentity: FileIdentity;
  manifestIdentity: FileIdentity;
  manifestBytes: Buffer;
  metadata: Readonly<ScratchOwnerMetadata>;
  cleaned: boolean;
}

interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
}

const ownerState = new WeakMap<ScratchOwner, ScratchOwnerState>();
const processStartId = randomUUID();
const processStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();

function identity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid;
}

function readManifestBytes(ownerPath: string): { bytes: Buffer; stat: fs.Stats } {
  const manifestPath = path.join(ownerPath, SCRATCH_OWNER_MANIFEST);
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing scratch path with a non-regular ownership manifest: ${manifestPath}`);
  }
  return { bytes: fs.readFileSync(manifestPath), stat };
}

export function readScratchOwnerMetadata(ownerPath: string): ScratchOwnerMetadata {
  const { bytes } = readManifestBytes(ownerPath);
  const manifestPath = path.join(ownerPath, SCRATCH_OWNER_MANIFEST);
  const value = JSON.parse(bytes.toString('utf8')) as Partial<ScratchOwnerMetadata>;
  if (value.schema !== 'review-yeti-scratch-owner.v1'
    || typeof value.ownerId !== 'string'
    || typeof value.kind !== 'string'
    || typeof value.pid !== 'number'
    || typeof value.parentPid !== 'number'
    || typeof value.processStartId !== 'string'
    || typeof value.processStartedAt !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.rootName !== 'string'
    || typeof value.runId !== 'string') {
    throw new Error(`Invalid Review Yeti scratch ownership manifest: ${manifestPath}`);
  }
  return value as ScratchOwnerMetadata;
}

export function createScratchOwner(options: ScratchOwnerOptions): ScratchOwner {
  const { prefix, kind } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*-$/u.test(prefix)) {
    throw new Error(`Scratch prefix must be a simple directory prefix ending in '-': ${prefix}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(kind)) {
    throw new Error(`Scratch owner kind must be a simple label: ${kind}`);
  }

  const requestedParent = path.resolve(options.parentDir ?? os.tmpdir());
  const parent = fs.realpathSync(requestedParent);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Scratch parent is not a directory: ${parent}`);
  }
  const parentIdentity = identity(parentStat);

  let parentMetadata: ScratchOwnerMetadata | undefined;
  const parentManifest = path.join(parent, SCRATCH_OWNER_MANIFEST);
  if (fs.existsSync(parentManifest)) {
    parentMetadata = readScratchOwnerMetadata(parent);
  }

  const root = fs.mkdtempSync(path.join(parent, prefix));
  const manifestPath = path.join(root, SCRATCH_OWNER_MANIFEST);
  const ownerId = randomUUID();
  const metadata: ScratchOwnerMetadata = Object.freeze({
    schema: 'review-yeti-scratch-owner.v1',
    ownerId,
    kind,
    pid: process.pid,
    parentPid: process.ppid,
    processStartId,
    processStartedAt,
    createdAt: new Date().toISOString(),
    rootName: path.basename(root),
    runId: options.runId ?? parentMetadata?.runId ?? ownerId,
    ...(options.parentOwnerId ?? parentMetadata?.ownerId
      ? { parentOwnerId: options.parentOwnerId ?? parentMetadata?.ownerId }
      : {}),
  });

  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Initialization has not established the identity needed for retirement.
    // Preserve rather than recursively deleting a potentially changed path.
    throw new Error(`Scratch initialization failed; retaining ${root}`, { cause: error });
  }

  const currentParentStat = fs.lstatSync(parent);
  if (!currentParentStat.isDirectory() || currentParentStat.isSymbolicLink()
    || !sameIdentity(identity(currentParentStat), parentIdentity)) {
    throw new Error(`Scratch parent changed during owner creation: ${parent}`);
  }
  const rootStat = fs.lstatSync(root);
  const manifest = readManifestBytes(root);

  let owner!: ScratchOwner;
  owner = Object.freeze({
    path: root,
    manifestPath,
    metadata,
    cleanup: () => cleanupScratchOwner(owner),
  });
  ownerState.set(owner, {
    root,
    parent,
    parentIdentity,
    rootIdentity: identity(rootStat),
    manifestIdentity: identity(manifest.stat),
    manifestBytes: manifest.bytes,
    metadata,
    cleaned: false,
  });
  return owner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function assertNoLiveOwnedChildren(owner: ScratchOwner, state: ScratchOwnerState): void {
  if (state.metadata.kind !== 'vitest-run') return;

  for (const entry of fs.readdirSync(state.root, { withFileTypes: true })) {
    if (entry.name === SCRATCH_OWNER_MANIFEST) continue;
    const childPath = path.join(state.root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Refusing to remove run scratch with an unowned child entry: ${childPath}`);
    }
    const childMetadata = readScratchOwnerMetadata(childPath);
    if (childMetadata.parentOwnerId !== owner.metadata.ownerId || childMetadata.kind !== 'vitest-suite') {
      throw new Error(`Refusing to remove run scratch with an unowned child directory: ${childPath}`);
    }
    if (processIsAlive(childMetadata.pid)) {
      throw new ScratchChildrenLiveError(
        `Refusing to remove run scratch while suite process ${childMetadata.pid} `
        + `(started ${childMetadata.processStartedAt}) is still alive: ${childPath}`,
      );
    }
  }
}

export function cleanupScratchOwner(owner: ScratchOwner): void {
  const state = ownerState.get(owner);
  if (!state) throw new Error('Scratch cleanup requires an owner returned by createScratchOwner');
  if (state.cleaned) return;

  const parentStat = fs.lstatSync(state.parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || !sameIdentity(identity(parentStat), state.parentIdentity)) {
    throw new Error(`Refusing to remove scratch after its parent identity changed: ${state.parent}`);
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(state.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      state.cleaned = true;
      return;
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !sameIdentity(identity(rootStat), state.rootIdentity)) {
    throw new Error(`Refusing to remove scratch path that is no longer its owned directory: ${state.root}`);
  }
  if (fs.realpathSync(path.dirname(state.root)) !== state.parent) {
    throw new Error(`Refusing to remove scratch path outside its original parent: ${state.root}`);
  }

  const actualManifest = readManifestBytes(state.root);
  if (!sameIdentity(identity(actualManifest.stat), state.manifestIdentity)
    || !actualManifest.bytes.equals(state.manifestBytes)) {
    throw new Error(`Refusing to remove scratch path with a replaced ownership manifest: ${state.root}`);
  }
  const actualMetadata = readScratchOwnerMetadata(state.root);
  if (actualMetadata.ownerId !== owner.metadata.ownerId
    || actualMetadata.rootName !== path.basename(state.root)
    || actualMetadata.kind !== owner.metadata.kind
    || actualMetadata.processStartedAt !== owner.metadata.processStartedAt) {
    throw new Error(`Refusing to remove scratch path with mismatched ownership metadata: ${state.root}`);
  }

  assertNoLiveOwnedChildren(owner, state);
  // fs.rm unlinks symlinks inside the owned directory; it does not traverse their targets.
  fs.rmSync(state.root, { recursive: true, force: false });
  state.cleaned = true;
}

export async function closeResourcesAndCleanupScratch(
  owner: ScratchOwner,
  closeResources: readonly (() => void | PromiseLike<void>)[] = [],
): Promise<void> {
  const errors: unknown[] = [];
  for (const closeResource of closeResources) {
    try {
      await closeResource();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Resource close failed; retaining owned scratch ${owner.path}`);
  }

  owner.cleanup();
}
