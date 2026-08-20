import { describe, expect, it, vi } from 'vitest';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');
const { resolveZoektRegistry, withStaleZoektMatchTagging } = pipeline;

const identity = {
  repository: 'owner/repository',
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
};

function okRegistry(matches: Array<{ path: string; line: number }>) {
  const call = vi.fn(async () => ({ status: 'ok', matches, matchCount: matches.length }));
  return { capabilities: { enabled: true, tools: ['code_search_zoekt'] }, call };
}

describe('withStaleZoektMatchTagging', () => {
  it('tags only matches whose path is in the changed set, leaving everything else untouched', async () => {
    const registry = okRegistry([{ path: 'src/changed.js', line: 1 }, { path: 'src/unrelated.js', line: 2 }]);
    const wrapped = withStaleZoektMatchTagging(registry, ['src/changed.js']);
    const result = await wrapped.call('code_search_zoekt', { query: 'x' });
    expect(result.matches).toEqual([
      { path: 'src/changed.js', line: 1, stale: true },
      { path: 'src/unrelated.js', line: 2 },
    ]);
  });

  it('is a pure passthrough (same registry reference) when there is nothing to tag', () => {
    const registry = okRegistry([]);
    expect(withStaleZoektMatchTagging(registry, [])).toBe(registry);
    expect(withStaleZoektMatchTagging(registry, undefined as unknown as string[])).toBe(registry);
    expect(withStaleZoektMatchTagging(null as never, ['x'])).toBe(null);
  });

  it('passes a non-ok or matchless result through unchanged', async () => {
    const call = vi.fn(async () => ({ status: 'unavailable', reason: 'zoekt_index_unavailable' }));
    const registry = { capabilities: { enabled: true, tools: ['code_search_zoekt'] }, call };
    const wrapped = withStaleZoektMatchTagging(registry, ['src/changed.js']);
    expect(await wrapped.call('code_search_zoekt', { query: 'x' })).toEqual({ status: 'unavailable', reason: 'zoekt_index_unavailable' });
  });
});

describe('resolveZoektRegistry', () => {
  const changedPaths = ['src/changed.js'];
  const baseArgs = () => ({
    identity,
    changedPaths,
    scratchRoot: '/tmp/scratch',
    token: 'gh-token',
    fetchImplementation: vi.fn(),
    signal: undefined,
    log: vi.fn(),
    warn: vi.fn(),
  });

  it('restores a warm index, skips materialize/build entirely, and tags matches on this review\'s own changed files as stale', async () => {
    const restoreZoektIndex = vi.fn(async () => ({ status: 'ok', indexedSha: 'c'.repeat(40), elapsedMs: 12 }));
    const materialize = vi.fn();
    const build = vi.fn();
    const call = vi.fn(async () => ({ status: 'ok', matches: [{ path: 'src/changed.js', line: 1 }, { path: 'src/other.js', line: 2 }] }));
    const createSearchTool = vi.fn((opts: { identity: typeof identity & { indexedSha: string } }) => ({
      capabilities: { enabled: true, tools: ['code_search_zoekt'] },
      call,
      _identity: opts.identity,
    }));

    const registry = await resolveZoektRegistry({ ...baseArgs(), restoreZoektIndex, materialize, build, createSearchTool });

    expect(materialize).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(createSearchTool).toHaveBeenCalledWith(expect.objectContaining({
      identity: { ...identity, indexedSha: 'c'.repeat(40) },
      indexDir: expect.stringContaining('zoekt-index-'),
    }));
    const result = await registry.call('code_search_zoekt', { query: 'x' });
    expect(result.matches).toEqual([
      { path: 'src/changed.js', line: 1, stale: true },
      { path: 'src/other.js', line: 2 },
    ]);
  });

  it('does not tag anything when the restored index happens to already be pinned to this review\'s own head SHA', async () => {
    const restoreZoektIndex = vi.fn(async () => ({ status: 'ok', indexedSha: identity.headSha, elapsedMs: 5 }));
    const call = vi.fn(async () => ({ status: 'ok', matches: [{ path: 'src/changed.js', line: 1 }] }));
    const createSearchTool = vi.fn(() => ({ capabilities: { enabled: true, tools: ['code_search_zoekt'] }, call }));

    const registry = await resolveZoektRegistry({ ...baseArgs(), restoreZoektIndex, materialize: vi.fn(), build: vi.fn(), createSearchTool });
    const result = await registry.call('code_search_zoekt', { query: 'x' });
    expect(result.matches).toEqual([{ path: 'src/changed.js', line: 1 }]);
  });

  it('falls through to materialize+build on a cache miss, exactly like before the cache existed -- fresh index, no staleness', async () => {
    const restoreZoektIndex = vi.fn(async () => ({ status: 'unavailable', reason: 'cache_miss', elapsedMs: 1 }));
    const materialize = vi.fn(async () => ({ status: 'ok', workdir: '/tmp/scratch/zoekt-src' }));
    const build = vi.fn(async () => ({ status: 'ok', shardCount: 3, elapsedMs: 4692 }));
    const call = vi.fn(async () => ({ status: 'ok', matches: [{ path: 'src/changed.js', line: 1 }] }));
    const createSearchTool = vi.fn((opts: { identity: typeof identity & { indexedSha: string } }) => {
      expect(opts.identity.indexedSha).toBe(identity.headSha);
      return { capabilities: { enabled: true, tools: ['code_search_zoekt'] }, call };
    });

    const registry = await resolveZoektRegistry({ ...baseArgs(), restoreZoektIndex, materialize, build, createSearchTool });

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    const result = await registry.call('code_search_zoekt', { query: 'x' });
    // Fresh index: even though src/changed.js is in changedPaths, indexedSha === headSha means
    // there is no gap to tag at all.
    expect(result.matches).toEqual([{ path: 'src/changed.js', line: 1 }]);
  });

  it('resolves to null (no registry) when a cache miss is followed by a materialize failure', async () => {
    const restoreZoektIndex = vi.fn(async () => ({ status: 'unavailable', reason: 'cache_miss' }));
    const materialize = vi.fn(async () => ({ status: 'unavailable', reason: 'tarball_fetch_failed' }));
    const build = vi.fn();
    const createSearchTool = vi.fn();

    const registry = await resolveZoektRegistry({ ...baseArgs(), restoreZoektIndex, materialize, build, createSearchTool });

    expect(registry).toBeNull();
    expect(build).not.toHaveBeenCalled();
    expect(createSearchTool).not.toHaveBeenCalled();
  });

  it('resolves to null when materialize succeeds but the index build itself fails', async () => {
    const restoreZoektIndex = vi.fn(async () => ({ status: 'unavailable', reason: 'cache_miss' }));
    const materialize = vi.fn(async () => ({ status: 'ok', workdir: '/tmp/scratch/zoekt-src' }));
    const build = vi.fn(async () => ({ status: 'unavailable', reason: 'zoekt_index_build_failed' }));
    const createSearchTool = vi.fn();

    const registry = await resolveZoektRegistry({ ...baseArgs(), restoreZoektIndex, materialize, build, createSearchTool });

    expect(registry).toBeNull();
    expect(createSearchTool).not.toHaveBeenCalled();
  });
});
