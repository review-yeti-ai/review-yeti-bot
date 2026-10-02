import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZoektGroundingStage } from '../../src/mcp/zoektGrounding';

// REL-677 / ADR 0329: the production grounding implementation, exercised
// directly with injected materialize/build/filesystem seams. Covers the guard,
// both failure mappings, the success shape, and catch-path scratch cleanup.

function fakeFs() {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    fs: {
      mkdtempSync: (prefix: string) => { const dir = `${prefix}${created.length}`; created.push(dir); return dir; },
      rmSync: (dir: string) => { removed.push(dir); },
    },
  };
}

describe('createZoektGroundingStage (REL-677)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('is disabled without a token or enabled flag — no scratch, no network', async () => {
    const { fs } = fakeFs();
    const materialize = vi.fn();
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: vi.fn() });

    const unauthenticated = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: undefined });
    expect(unauthenticated.indexDir).toBeUndefined();
    expect(unauthenticated.reason).toBe('disabled_or_unauthenticated');

    const disabled = await stage({ enabled: false, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' });
    expect(disabled.reason).toBe('disabled_or_unauthenticated');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('maps a materializer failure to materialize_<status> and keeps the scratch for cleanup by the caller', async () => {
    const { fs, removed } = fakeFs();
    const materialize = vi.fn(async () => ({ status: 'fetch_failed' }));
    const build = vi.fn();
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: build });

    const abortSignal = new AbortController().signal;
    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't', signal: abortSignal });
    expect(result).toEqual({ indexDir: undefined, scratchDir: expect.any(String), reason: 'materialize_fetch_failed' });
    expect(build).not.toHaveBeenCalled();
    // Cancellation seam: the stage forwards its signal to the materializer.
    expect((materialize.mock.calls[0] as unknown as unknown[])[0]).toMatchObject({ signal: abortSignal });
    // No index was produced: the caller's finally owns scratch removal; the
    // stage must NOT remove the scratch on mapped failure paths because the
    // receipt references it.
    expect(removed).toHaveLength(0);
  });

  describe('memory budget (REL-1282)', () => {
    const MiB = 1024 * 1024;
    const input = { enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' };

    it('skips with an explicit reason, before any scratch or network work, when the container is below the floor', async () => {
      const { fs, created } = fakeFs();
      const materialize = vi.fn();
      const build = vi.fn();
      const stage = createZoektGroundingStage({
        fs, materializeReviewWorkdir: materialize, buildZoektIndex: build, readMemoryLimitBytes: () => 256 * MiB,
      });
      const result = await stage(input);
      expect(result).toMatchObject({ indexDir: undefined, reason: 'grounding_skipped:memory_limit_below_floor',
        memory: { limitBytes: 256 * MiB, floorBytes: 512 * MiB } });
      expect(created).toHaveLength(0);
      expect(materialize).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    });

    it('runs when the container is at the floor and reports the observed peak', async () => {
      const { fs } = fakeFs();
      const stage = createZoektGroundingStage({
        fs, materializeReviewWorkdir: vi.fn(async () => ({ status: 'ok' })),
        buildZoektIndex: vi.fn(async () => ({ status: 'ok', indexScope: {} })),
        readMemoryLimitBytes: () => 512 * MiB, readMemoryPeakBytes: () => 300 * MiB,
      });
      const result = await stage(input);
      expect(result.indexDir).toEqual(expect.any(String));
      expect(result.memory).toEqual({ limitBytes: 512 * MiB, peakBytesAfterBuild: 300 * MiB });
    });

    it('runs when the limit cannot be determined (unverified, never a silent skip)', async () => {
      const { fs } = fakeFs();
      const build = vi.fn(async () => ({ status: 'ok', indexScope: {} }));
      const stage = createZoektGroundingStage({
        fs, materializeReviewWorkdir: vi.fn(async () => ({ status: 'ok' })), buildZoektIndex: build,
        readMemoryLimitBytes: () => undefined, readMemoryPeakBytes: () => undefined,
      });
      const result = await stage(input);
      expect(build).toHaveBeenCalledTimes(1);
      expect(result.memory).toBeUndefined();
    });

    it('reports an oversized archive as a deliberate grounding_skipped, not a materialize failure', async () => {
      const { fs } = fakeFs();
      const build = vi.fn();
      const stage = createZoektGroundingStage({
        fs, materializeReviewWorkdir: vi.fn(async () => ({ status: 'unavailable', reason: 'archive_too_large' })),
        buildZoektIndex: build, readMemoryLimitBytes: () => 1024 * MiB,
      });
      const result = await stage(input);
      expect(result.reason).toBe('grounding_skipped:archive_too_large');
      expect(build).not.toHaveBeenCalled();
    });
  });

  it('maps an indexer failure to build_<status>', async () => {
    const { fs } = fakeFs();
    const materialize = vi.fn(async () => ({ status: 'ok' }));
    const build = vi.fn(async () => ({ status: 'index_dir_uncreatable' }));
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: build });

    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' });
    expect(result.reason).toBe('build_index_dir_uncreatable');
    expect(result.indexDir).toBeUndefined();
  });

  it('does not start indexing when materialization resolves after lifecycle cancellation', async () => {
    const { fs } = fakeFs();
    const controller = new AbortController();
    let releaseMaterialization!: (result: { status: string }) => void;
    const materialize = vi.fn((input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(controller.signal);
      return new Promise<{ status: string }>((resolve) => { releaseMaterialization = resolve; });
    });
    const build = vi.fn();
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: build });
    const pending = stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't', signal: controller.signal });

    controller.abort();
    releaseMaterialization({ status: 'ok' });
    const result = await pending;
    expect(result).toMatchObject({ indexDir: undefined, scratchDir: expect.any(String), reason: 'cancelled' });
    expect(build).not.toHaveBeenCalled();
  });

  it('forwards cancellation to indexing and discards a late successful index receipt', async () => {
    const { fs } = fakeFs();
    const controller = new AbortController();
    let releaseBuild!: (result: { status: string; shardCount: number }) => void;
    let buildSignal: AbortSignal | undefined;
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => { buildStarted = resolve; });
    const materialize = vi.fn(async () => ({ status: 'ok' }));
    const build = vi.fn((input: { signal?: AbortSignal }) => {
      buildSignal = input.signal;
      buildStarted();
      return new Promise<{ status: string; shardCount: number }>((resolve) => { releaseBuild = resolve; });
    });
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: build });
    const pending = stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't', signal: controller.signal });

    try {
      await started;
      expect(buildSignal).toBe(controller.signal);
      controller.abort();
      releaseBuild({ status: 'ok', shardCount: 1 });
      const result = await pending;
      expect(result).toMatchObject({ indexDir: undefined, scratchDir: expect.any(String), reason: 'cancelled' });
    } finally {
      controller.abort();
      releaseBuild?.({ status: 'ok', shardCount: 1 });
      await pending;
    }
  });

  it('retains scratchDir on the build-failure receipt so the caller can clean it up', async () => {
    const { fs } = fakeFs();
    const materialize = vi.fn(async () => ({ status: 'ok' }));
    const build = vi.fn(async () => ({ status: 'index_dir_uncreatable' }));
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: build });

    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' });
    // Mirrors the materialize-failure sibling: the receipt carries scratchDir
    // so the caller's finally owns removal — omitting it would leak the tree.
    expect(result.scratchDir).toEqual(expect.any(String));
    expect(result.indexDir).toBeUndefined();
    expect(result.reason).toBe('build_index_dir_uncreatable');
  });

  it('returns the indexDir on success and passes bounded args through', async () => {
    const { fs, created } = fakeFs();
    const indexScope = { complete: false, excludedDirectories: ['build'], fileLimitBytes: 2097152,
      limitations: ['directory_exclusions'], repository: 'untrusted/builder', headSha: 'b'.repeat(40) };
    const materialize = vi.fn(async (args: any) => { expect(args.destDir.endsWith('/src')).toBe(true); return { status: 'ok' }; });
    const build = vi.fn(async (args: any) => {
      expect(args.indexDir.endsWith('/index')).toBe(true);
      // Binary path is caller-resolved input, never process.env (seams contract).
      expect(args.config.zoektIndexBinaryPath).toBe('/opt/zoekt/zoekt-index');
      return { status: 'ok', shardCount: 2, indexScope };
    });
    const stage = createZoektGroundingStage({ fs, materializeReviewWorkdir: materialize, buildZoektIndex: build });

    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't', zoektIndexBinaryPath: '/opt/zoekt/zoekt-index' });
    expect(result.indexDir).toBe(result.scratchDir && `${result.scratchDir}/index`);
    expect(result.indexScope).toEqual({ ...indexScope, repository: 'o/r', headSha: 'a'.repeat(40) });
    expect(created).toHaveLength(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('catch path prefers the injected fsPromises.rm branch (async deletion observable)', async () => {
    const { fs, created } = fakeFs();
    const promiseRemovals: string[] = [];
    const syncRemovals: string[] = [];
    const fsWithSyncOnly = { ...fs, rmSync: (dir: string) => { syncRemovals.push(dir); } };
    const materialize = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const stage = createZoektGroundingStage({
      fs: fsWithSyncOnly,
      fsPromises: { rm: async (dir: string) => { promiseRemovals.push(dir); } },
      materializeReviewWorkdir: materialize,
      buildZoektIndex: vi.fn(),
    });

    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' });
    expect(result.indexDir).toBeUndefined();
    expect(result.reason).toBe('ECONNRESET');
    // The explicit fsPromises override is authoritative: async rm ran, sync rm did not.
    expect(promiseRemovals).toEqual(created);
    expect(syncRemovals).toHaveLength(0);
  });

  it('catch path uses an injected fs that carries its own promises.rm', async () => {
    const { created } = fakeFs();
    const promiseRemovals: string[] = [];
    const syncRemovals: string[] = [];
    const fsWithPromises = {
      mkdtempSync: (prefix: string) => `${prefix}${created.length}`,
      promises: { rm: async (dir: string) => { promiseRemovals.push(dir); } },
      rmSync: (dir: string) => { syncRemovals.push(dir); },
    };
    const materialize = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const stage = createZoektGroundingStage({
      fs: fsWithPromises,
      materializeReviewWorkdir: materialize,
      buildZoektIndex: vi.fn(),
    });

    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' });
    expect(result.reason).toBe('ECONNRESET');
    // The injected fs's own promises API is preferred over its rmSync.
    expect(promiseRemovals).toHaveLength(1);
    expect(syncRemovals).toHaveLength(0);
  });

  it('catch path falls back to the injected fs rmSync when no fsPromises override exists', async () => {
    const { fs, created } = fakeFs();
    const syncRemovals: string[] = [];
    const fsWithSyncOnly = { ...fs, rmSync: (dir: string) => { syncRemovals.push(dir); } };
    const materialize = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const stage = createZoektGroundingStage({
      fs: fsWithSyncOnly,
      materializeReviewWorkdir: materialize,
      buildZoektIndex: vi.fn(),
    });

    const result = await stage({ enabled: true, repository: 'o/r', headSha: 'a'.repeat(40), token: 't' });
    expect(result.reason).toBe('ECONNRESET');
    expect(syncRemovals).toEqual(created);
  });
});
