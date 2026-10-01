import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const ENTRYPOINT = 'dist/cli/runLiveReview.js';
const HASH = /^[a-f0-9]{64}$/u;
const READ_CHUNK_BYTES = 64 * 1024;

// Baseline staged closure: 5,902 files, 1.18 MB manifest, 40.1 MB total,
// largest file 9.12 MB, longest path 200 bytes / 11 components. These are
// deliberately generous resource bounds, not source/image provenance claims.
export const WORKER_RUNTIME_MANIFEST_LIMITS = Object.freeze({
  manifestBytes: 16 * 1024 * 1024,
  files: 65_536,
  fileBytes: 128 * 1024 * 1024,
  totalFileBytes: 1024 * 1024 * 1024,
  pathBytes: 4096,
  pathComponents: 64,
});

type ManifestFile = { path: string; sha256: string };

function invalid(): Error {
  return new Error('worker runtime manifest is invalid');
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseFiles(bytes: Buffer): ManifestFile[] {
  const manifest: unknown = JSON.parse(bytes.toString('utf8'));
  if (!hasKeys(manifest, ['version', 'entrypoint', 'files']) ||
      manifest.version !== 'ReviewYetiWorkerRuntime.v1' || manifest.entrypoint !== ENTRYPOINT ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 ||
      manifest.files.length > WORKER_RUNTIME_MANIFEST_LIMITS.files) throw invalid();

  const seen = new Set<string>();
  const files: ManifestFile[] = [];
  for (const file of manifest.files) {
    if (!hasKeys(file, ['path', 'sha256']) || typeof file.path !== 'string' ||
        typeof file.sha256 !== 'string' || !HASH.test(file.sha256)) throw invalid();
    const parts = file.path.split('/');
    if (Buffer.byteLength(file.path) > WORKER_RUNTIME_MANIFEST_LIMITS.pathBytes ||
        parts.length > WORKER_RUNTIME_MANIFEST_LIMITS.pathComponents ||
        /[\\\x00-\x1f\x7f]/u.test(file.path) || /^[A-Za-z]:/u.test(file.path) ||
        parts.some((part) => part === '' || part === '.' || part === '..') ||
        seen.has(file.path)) throw invalid();
    seen.add(file.path);
    files.push({ path: file.path, sha256: file.sha256 });
  }
  if (!seen.has(ENTRYPOINT)) throw invalid();
  return files;
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function openRegularFile(path: string, limit: number): Promise<{ handle: FileHandle; stat: Stats }> {
  const observed = await lstat(path);
  assertRegularFile(observed, limit);
  // NOFOLLOW rejects a final-component swap to a symlink; NONBLOCK prevents
  // a raced FIFO from waiting for a writer before fstat can reject its type.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !unchanged(observed, stat)) throw invalid();
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertRegularFile(stat: Stats, limit: number): void {
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) throw invalid();
}

async function readChunks(
  handle: FileHandle,
  stat: Stats,
  consume: (bytes: Buffer, offset: number) => void,
): Promise<void> {
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let offset = 0;
  while (offset < stat.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
    if (bytesRead === 0) throw invalid();
    consume(buffer.subarray(0, bytesRead), offset);
    offset += bytesRead;
  }
  // Growth is refused rather than allowing the read to extend beyond its bound.
  if ((await handle.read(buffer, 0, 1, offset)).bytesRead !== 0 ||
      !unchanged(stat, await handle.stat())) throw invalid();
}

async function verifyFilePath(root: string, path: string): Promise<string> {
  const parts = path.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    if (!(await lstat(directory)).isDirectory()) throw invalid();
  }
  const target = join(root, ...parts);
  if (await realpath(target) !== target) throw invalid();
  return target;
}

/**
 * Verify the producer's listed bytes before module loading. The selected root
 * must remain trusted/read-only through loading: Node's path-based filesystem
 * API cannot make this a same-UID sandbox or eliminate ancestor/in-place races.
 * This neither authenticates the manifest nor proves it lists a complete image.
 */
export async function verifyWorkerRuntimeManifest(manifestPath: string): Promise<string> {
  // Keep the existing missing-manifest public error, without exposing paths.
  try {
    await lstat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('worker runtime manifest is missing');
    }
    throw invalid();
  }
  try {
    const root = await realpath(dirname(resolve(manifestPath)));
    const canonicalManifest = join(root, basename(manifestPath));
    const manifestFile = await openRegularFile(canonicalManifest, WORKER_RUNTIME_MANIFEST_LIMITS.manifestBytes);
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(manifestFile.stat.size);
      await readChunks(manifestFile.handle, manifestFile.stat, (chunk, offset) => chunk.copy(bytes, offset));
    } finally {
      await manifestFile.handle.close();
    }
    const files = parseFiles(bytes);
    let totalBytes = 0;
    const planned: Array<{ file: ManifestFile; target: string; stat: Stats }> = [];
    // Refuse oversized combined closures before hashing any listed content.
    for (const file of files) {
      const target = await verifyFilePath(root, file.path);
      const stat = await lstat(target);
      assertRegularFile(stat, WORKER_RUNTIME_MANIFEST_LIMITS.fileBytes);
      totalBytes += stat.size;
      if (totalBytes > WORKER_RUNTIME_MANIFEST_LIMITS.totalFileBytes) throw invalid();
      planned.push({ file, target, stat });
    }
    for (const { file, target, stat } of planned) {
      const opened = await openRegularFile(target, WORKER_RUNTIME_MANIFEST_LIMITS.fileBytes);
      try {
        if (!unchanged(stat, opened.stat)) throw invalid();
        const digest = createHash('sha256');
        await readChunks(opened.handle, opened.stat, (chunk) => { digest.update(chunk); });
        if (digest.digest('hex') !== file.sha256) throw invalid();
      } finally {
        await opened.handle.close();
      }
    }
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    throw invalid();
  }
}
