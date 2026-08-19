import { describe, expect, it, vi } from 'vitest';

const { fetchImmutableRepositorySnapshot, MAX_FILES } = require('../../src/mcp/reviewNavigationSnapshot.js');
const { createReviewNavigationToolRegistry } = require('../../src/mcp/reviewNavigationTools.js');

const identity = { repository: 'acme/widgets', prNumber: 17, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };

function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe('immutable review navigation snapshot', () => {
  it('indexes base and head trees and overlays changed patches', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ truncated: false, tree: [{ type: 'blob', path: 'src/deleted-caller.js', sha: '1'.repeat(40) }] }))
      .mockResolvedValueOnce(response({ truncated: false, tree: [{ type: 'blob', path: 'src/changed.js', sha: '2'.repeat(40) }, { type: 'blob', path: 'src/caller.js', sha: '3'.repeat(40) }] }));
    const snapshot = await fetchImmutableRepositorySnapshot({ identity, changedFiles: [{ path: 'src/changed.js', patch: '@@ -1 +1 @@\n-old\n+new', newSha: '2'.repeat(40) }], token: 'test-token', fetchImplementation });
    expect(snapshot).toMatchObject({ repository: identity.repository, complete: true, truncated: false });
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'base', path: 'src/deleted-caller.js', blobSha: '1'.repeat(40) }),
      expect.objectContaining({ ref: 'head', path: 'src/changed.js', patch: expect.stringContaining('@@') }),
      expect.objectContaining({ ref: 'head', path: 'src/caller.js', blobSha: '3'.repeat(40) }),
    ]));
    expect(fetchImplementation.mock.calls[0][0]).toContain(`/git/trees/${identity.baseSha}`);
    expect(fetchImplementation.mock.calls[1][0]).toContain(`/git/trees/${identity.headSha}`);
  });

  it('preserves an explicit truncated tree result', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ truncated: true, tree: [] }))
      .mockResolvedValueOnce(response({ truncated: false, tree: [] }));
    await expect(fetchImmutableRepositorySnapshot({ identity, token: 'test-token', fetchImplementation })).resolves.toMatchObject({ complete: false, truncated: true });
  });

  it('caps base+head monorepo trees at the runaway backstop and keeps changed paths', async () => {
    const { boundSnapshotFiles } = require('../../src/mcp/reviewNavigationSnapshot.js');
    // The backstop is now 400,000 entries: far above any real repository, and far too large to
    // allocate in a unit test to no purpose. The behaviour under test is what happens AT the
    // cap, which an injected small cap exercises identically and 2,000x more cheaply.
    const CAP = 200;
    // Each tree contributes CAP blobs → combined overlay would exceed the registry bound.
    const baseTree = Array.from({ length: CAP }, (_, i) => ({
      type: 'blob',
      path: `lib/base-${String(i).padStart(5, '0')}.js`,
      sha: '1'.repeat(40),
    }));
    const headTree = Array.from({ length: CAP }, (_, i) => ({
      type: 'blob',
      path: `lib/head-${String(i).padStart(5, '0')}.js`,
      sha: '2'.repeat(40),
    }));
    // Put the PR change outside the early alphabetical slice so only overlay can keep it.
    headTree[CAP - 1] = { type: 'blob', path: 'zzz/important.js', sha: '3'.repeat(40) };

    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ truncated: false, tree: baseTree }))
      .mockResolvedValueOnce(response({ truncated: false, tree: headTree }));

    const snapshot = await fetchImmutableRepositorySnapshot({
      identity,
      changedFiles: [{ path: 'zzz/important.js', patch: '@@ -1 +1 @@\n-a\n+b', newSha: '3'.repeat(40) }],
      token: 'test-token',
      fetchImplementation,
      maxFiles: CAP,
    });

    expect(snapshot.files.length).toBeLessThanOrEqual(CAP);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'head', path: 'zzz/important.js', blobSha: '3'.repeat(40), patch: expect.stringContaining('@@') }),
    ]));

    // pure helper: changed path wins over filler when over budget
    const oversized = [
      ...Array.from({ length: CAP }, (_, i) => ({ ref: 'head' as const, path: `a/${i}.js`, blobSha: '4'.repeat(40) })),
      { ref: 'head' as const, path: 'zzz/keep.js', blobSha: '5'.repeat(40), patch: 'p' },
    ];
    const bounded = boundSnapshotFiles(oversized, [{ path: 'zzz/keep.js' }], CAP);
    expect(bounded.truncated).toBe(true);
    expect(bounded.files.length).toBe(CAP);
    expect(bounded.files.some((f: { path: string }) => f.path === 'zzz/keep.js')).toBe(true);
  });

  it('keeps every exact diff path navigable when a complete monorepo tree exceeds the source cap', async () => {
    const changedFiles = Array.from({ length: 24 }, (_, index) => ({
      path: `zzz/exact-${String(index).padStart(2, '0')}.js`,
      patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
    }));
    const CAP = 200;
    const filler = (label: string, sha: string) => Array.from({ length: CAP }, (_, index) => ({
      type: 'blob',
      path: `lib/${label}-${String(index).padStart(5, '0')}.js`,
      sha,
    }));
    const baseTree = [...filler('base', '4'.repeat(40)), ...changedFiles.map((file) => ({ type: 'blob', path: file.path, sha: '5'.repeat(40) }))];
    const headTree = [...filler('head', '6'.repeat(40)), ...changedFiles.map((file) => ({ type: 'blob', path: file.path, sha: '7'.repeat(40) }))];
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ truncated: false, tree: baseTree }))
      .mockResolvedValueOnce(response({ truncated: false, tree: headTree }));

    const snapshot = await fetchImmutableRepositorySnapshot({ identity, changedFiles, token: 'test-token', fetchImplementation, maxFiles: CAP });
    const registry = createReviewNavigationToolRegistry({
      identity,
      snapshot,
      blobClient: { getBlob: vi.fn() },
      config: { enabled: true, maxFindResults: 50 },
    });

    expect(snapshot).toMatchObject({ complete: false, truncated: true });
    await expect(registry.call('file_find', { ref: 'head', query: 'zzz/exact-' })).resolves.toMatchObject({
      status: 'ok',
      paths: changedFiles.map((file) => file.path),
    });
  });

  it('indexes a 16,000-file repository completely, within a runner-sized memory and time budget', async () => {
    // cisco-cdr's real tracked-file count. Under the retired 5,000-entry cap this snapshot came
    // back truncated with >84% of the repository missing, and every evidence read outside the
    // surviving slice answered `file_not_in_snapshot` — indistinguishable, to the reviewer, from
    // "that file does not exist". This asserts the whole tree is now reachable, and pins the two
    // costs that made the cap look justified so a future regression has to argue with a number.
    const TRACKED_FILES = 16_000;
    const tree = Array.from({ length: TRACKED_FILES }, (_, index) => ({
      type: 'blob',
      path: `lib/cdrcisco/module_${String(index).padStart(5, '0')}/implementation.ex`,
      sha: '8'.repeat(40),
    }));
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ truncated: false, tree }))
      .mockResolvedValueOnce(response({ truncated: false, tree }));

    const before = process.memoryUsage().heapUsed;
    const startedAt = Date.now();
    const snapshot = await fetchImmutableRepositorySnapshot({ identity, changedFiles: [], token: 'test-token', fetchImplementation });
    const elapsedMs = Date.now() - startedAt;
    const heapGrowthBytes = process.memoryUsage().heapUsed - before;

    expect(snapshot.files.length).toBe(TRACKED_FILES * 2);
    expect(snapshot).toMatchObject({ complete: true, truncated: false });
    // One `git/trees?recursive=1` request per ref, exactly as before. Removing the cap did not
    // add a single API call: GitHub already sent every entry, the cap only discarded them.
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    // Path index only — no file contents. Generous ceilings so this pins the order of magnitude
    // (single-digit MB, sub-second) without flaking on a loaded CI runner.
    expect(heapGrowthBytes).toBeLessThan(96 * 1024 * 1024);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('keeps the runaway backstop far above any real repository', () => {
    expect(MAX_FILES).toBeGreaterThan(100_000);
  });
});
