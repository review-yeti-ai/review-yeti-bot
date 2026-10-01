import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWorkerSelfTest } from '../../src/cli/runLiveReview';
import { WORKER_RUNTIME_MANIFEST_LIMITS } from '../../src/cli/workerRuntimeManifest';

const ENTRYPOINT = 'dist/cli/runLiveReview.js';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Manifest = { version: string; entrypoint: string; files: Array<{ path: string; sha256: string }> };

const ioCalls = vi.hoisted(() => ({ opens: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      ioCalls.opens.push(String(args[0]));
      return actual.open(...args);
    },
  };
});

describe('worker runtime manifest integrity through the production self-test', () => {
  let root: string;
  let manifestPath: string;
  let manifest: Manifest;
  const moduleLoader = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(join(process.env.CT_REVIEW_TEST_SCRATCH_ROOT!, 'manifest-integrity-'));
    manifestPath = join(root, 'runtime-manifest.json');
    const entryBytes = 'module.exports = {};\n';
    await mkdir(join(root, 'dist/cli'), { recursive: true });
    await writeFile(join(root, ENTRYPOINT), entryBytes);
    manifest = {
      version: 'ReviewYetiWorkerRuntime.v1',
      entrypoint: ENTRYPOINT,
      files: [{ path: ENTRYPOINT, sha256: sha256(entryBytes) }],
    };
    moduleLoader.mockReset();
    ioCalls.opens.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function save(value: unknown = manifest): Promise<Buffer> {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(manifestPath, bytes);
    return bytes;
  }

  function run() {
    return runWorkerSelfTest({ NODE_ENV: 'test', REVIEW_RUNTIME_MANIFEST_PATH: manifestPath }, moduleLoader);
  }

  async function refuses(value: unknown = manifest) {
    await save(value);
    await expect(run()).rejects.toThrow('worker runtime manifest is invalid');
    expect(moduleLoader).not.toHaveBeenCalled();
  }

  it('accepts real listed bytes before loading the unchanged six module IDs and returns the raw manifest digest', async () => {
    await mkdir(join(root, 'node_modules/@example/worker'), { recursive: true });
    const dependencyBytes = Buffer.from([0, 1, 127, 128, 255]);
    await writeFile(join(root, 'node_modules/@example/worker/data.bin'), dependencyBytes);
    manifest.files.push({ path: 'node_modules/@example/worker/data.bin', sha256: sha256(dependencyBytes) });
    const bytes = await save();
    const result = await run();
    expect(result).toEqual({
      ok: true,
      nodeVersion: process.versions.node,
      runtimeManifestDigest: sha256(bytes),
      loadedModuleIds: [
        '../gateway/openRouterClient', '../panel/panelEngine', '../github/qualificationReader',
        '../k8s/reviewJobProjection', '../k8s/reviewJobDispatchEngine', 'node:child_process',
      ],
    });
    expect(moduleLoader.mock.calls.flat()).toEqual(result.loadedModuleIds);
  });

  it('rejects the formerly accepted header-only empty closure before any module is loaded', async () => {
    manifest.files = [];
    await refuses();
  });

  it('rejects a listed file whose real bytes do not match its well-formed SHA256', async () => {
    manifest.files[0].sha256 = 'a'.repeat(64);
    await refuses();
  });

  it('checks every listed file, not only the required entrypoint', async () => {
    await writeFile(join(root, 'untrusted-provider-secret-marker.txt'), 'changed bytes');
    manifest.files.push({ path: 'untrusted-provider-secret-marker.txt', sha256: sha256('expected bytes') });
    await refuses();
  });

  it('rejects missing files even when the entrypoint is valid', async () => {
    manifest.files.push({ path: 'missing.js', sha256: sha256('missing') });
    await refuses();
  });

  it('rejects a closure with no listed entrypoint', async () => {
    await writeFile(join(root, 'helper.js'), 'helper');
    manifest.files = [{ path: 'helper.js', sha256: sha256('helper') }];
    await refuses();
  });

  it('rejects duplicate decoded paths', async () => {
    manifest.files.push({ ...manifest.files[0] });
    await refuses();
  });

  it.each([
    '../outside.js', '/absolute.js', 'dist/../outside.js', 'dist/./file.js',
    'dist//file.js', 'dist\\file.js', 'C:/outside.js', 'C:outside.js',
    'dist/file.js/', '', 'dist/null\0.js', 'dist/new\nline.js',
  ])('rejects unsafe/noncanonical listed paths (%j) before module loading', async (path) => {
    manifest.files.push({ path, sha256: sha256('outside') });
    await refuses();
  });

  it.each(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `sha256:${'a'.repeat(64)}`])(
    'rejects malformed hashes (%s)', async (digest) => {
      manifest.files[0].sha256 = digest;
      await refuses();
    },
  );

  it.each([
    null, [], 'manifest', {},
    { version: 'ReviewYetiWorkerRuntime.v0', entrypoint: ENTRYPOINT, files: [] },
    { version: 'ReviewYetiWorkerRuntime.v1', entrypoint: 'dist/other.js', files: [] },
    { version: 'ReviewYetiWorkerRuntime.v1', entrypoint: ENTRYPOINT },
    { version: 'ReviewYetiWorkerRuntime.v1', entrypoint: ENTRYPOINT, files: {} },
    { version: 'ReviewYetiWorkerRuntime.v1', entrypoint: ENTRYPOINT, files: [null] },
    { version: 'ReviewYetiWorkerRuntime.v1', entrypoint: ENTRYPOINT, files: ['file.js'] },
    { version: 'ReviewYetiWorkerRuntime.v1', entrypoint: ENTRYPOINT, files: [{ path: ENTRYPOINT, sha256: 123 }] },
  ])('rejects malformed headers/files (%j)', async (value) => {
    await refuses(value);
  });

  it('rejects unknown schema fields without leaking their content', async () => {
    const bytes = await save({ ...manifest, secret: 'untrusted-provider-secret-marker' });
    expect(bytes.length).toBeGreaterThan(0);
    await expect(run()).rejects.toThrow(/^worker runtime manifest is invalid$/);
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it('rejects unknown per-file fields', async () => {
    await refuses({ ...manifest, files: [{ ...manifest.files[0], authority: 'client-claim' }] });
  });

  it('rejects a symlink file even if its target has the expected hash', async () => {
    await writeFile(join(root, 'real.js'), 'linked bytes');
    await symlink('real.js', join(root, 'linked.js'));
    manifest.files.push({ path: 'linked.js', sha256: sha256('linked bytes') });
    await refuses();
  });

  it('rejects symlink directory components rather than following them inside or outside the root', async () => {
    await mkdir(join(root, 'real-directory'));
    await writeFile(join(root, 'real-directory/file.js'), 'linked bytes');
    await symlink('real-directory', join(root, 'linked-directory'));
    manifest.files.push({ path: 'linked-directory/file.js', sha256: sha256('linked bytes') });
    await refuses();
  });

  it('rejects directories as file targets', async () => {
    manifest.files.push({ path: 'dist/cli', sha256: sha256('') });
    await refuses();
  });

  it('rejects a FIFO without waiting for a writer', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    manifest.files.push({ path: 'pipe', sha256: sha256('') });
    await refuses();
  });

  it('rejects a symlink manifest before module loading', async () => {
    await save();
    const linkPath = join(root, 'linked-manifest.json');
    await symlink('runtime-manifest.json', linkPath);
    await expect(runWorkerSelfTest({ NODE_ENV: 'test', REVIEW_RUNTIME_MANIFEST_PATH: linkPath }, moduleLoader))
      .rejects.toThrow('worker runtime manifest is invalid');
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it('propagates module-loader failure only after successful integrity validation', async () => {
    await save();
    moduleLoader.mockImplementation(() => { throw new Error('module unavailable'); });
    await expect(run()).rejects.toThrow('module unavailable');
    expect(moduleLoader).toHaveBeenCalledOnce();
  });

  it('hashes binary files across multiple read chunks and permits an empty regular file', async () => {
    const bytes = Buffer.alloc(192 * 1024 + 1, 0xa5);
    await writeFile(join(root, 'multi-chunk.bin'), bytes);
    await writeFile(join(root, 'empty.bin'), '');
    manifest.files.push({ path: 'multi-chunk.bin', sha256: sha256(bytes) });
    manifest.files.push({ path: 'empty.bin', sha256: sha256('') });
    await save();
    expect((await run()).ok).toBe(true);
    expect(moduleLoader).toHaveBeenCalledTimes(6);
  });

  it('refuses corruption in the last partial read chunk before loading', async () => {
    const original = Buffer.alloc(128 * 1024 + 1, 0xa5);
    const changed = Buffer.from(original);
    changed[changed.length - 1] = 0;
    await writeFile(join(root, 'multi-chunk.bin'), changed);
    manifest.files.push({ path: 'multi-chunk.bin', sha256: sha256(original) });
    await refuses();
  });

  it('bounds manifest reads before parsing or loading', async () => {
    await save();
    await truncate(manifestPath, WORKER_RUNTIME_MANIFEST_LIMITS.manifestBytes + 1);
    await expect(run()).rejects.toThrow(/^worker runtime manifest is invalid$/);
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it('bounds listed file size before reading a sparse oversized file', async () => {
    await truncate(join(root, ENTRYPOINT), WORKER_RUNTIME_MANIFEST_LIMITS.fileBytes + 1);
    await refuses();
  });

  it('preflights the aggregate byte bound before hashing any listed file', async () => {
    for (let index = 0; index < 8; index += 1) {
      const path = `sparse-${index}.bin`;
      await writeFile(join(root, path), '');
      await truncate(join(root, path), WORKER_RUNTIME_MANIFEST_LIMITS.fileBytes);
      manifest.files.push({ path, sha256: 'a'.repeat(64) });
    }
    await refuses();
    // Only the bounded manifest itself may be opened. The sparse files are
    // real fixtures, but their oversized combined closure must never be read.
    expect(ioCalls.opens).toHaveLength(1);
  });

  it('bounds file count before examining listed paths', async () => {
    manifest.files = Array.from({ length: WORKER_RUNTIME_MANIFEST_LIMITS.files + 1 }, (_value, index) => ({
      path: `files/${index}.js`, sha256: sha256('file'),
    }));
    await refuses();
  });

  it.each([
    `${'x'.repeat(WORKER_RUNTIME_MANIFEST_LIMITS.pathBytes)}.js`,
    `${'directory/'.repeat(WORKER_RUNTIME_MANIFEST_LIMITS.pathComponents)}file.js`,
  ])('bounds path bytes/depth before traversal (%j)', async (path) => {
    manifest.files.push({ path, sha256: sha256('file') });
    await refuses();
  });

  it('rejects a FIFO manifest without waiting for a writer', async () => {
    execFileSync('mkfifo', [manifestPath]);
    await expect(run()).rejects.toThrow(/^worker runtime manifest is invalid$/);
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it('uses fixed missing/malformed manifest errors without echoing input paths or bytes', async () => {
    await expect(run()).rejects.toThrow(/^worker runtime manifest is missing$/);
    await writeFile(manifestPath, '{"untrusted-provider-secret-marker":');
    await expect(run()).rejects.toThrow(/^worker runtime manifest is invalid$/);
    expect(moduleLoader).not.toHaveBeenCalled();
  });
});
