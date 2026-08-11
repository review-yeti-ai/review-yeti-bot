import { describe, expect, it, vi } from 'vitest';

const { fetchImmutableRepositorySnapshot } = require('../../src/mcp/reviewNavigationSnapshot.js');

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

  it('caps base+head monorepo trees at MAX_FILES and keeps changed paths', async () => {
    const { MAX_FILES, boundSnapshotFiles } = require('../../src/mcp/reviewNavigationSnapshot.js');
    // Each tree contributes MAX_FILES blobs → combined overlay would exceed the registry bound.
    const baseTree = Array.from({ length: MAX_FILES }, (_, i) => ({
      type: 'blob',
      path: `lib/base-${String(i).padStart(5, '0')}.js`,
      sha: '1'.repeat(40),
    }));
    const headTree = Array.from({ length: MAX_FILES }, (_, i) => ({
      type: 'blob',
      path: `lib/head-${String(i).padStart(5, '0')}.js`,
      sha: '2'.repeat(40),
    }));
    // Put the PR change outside the early alphabetical slice so only overlay can keep it.
    headTree[MAX_FILES - 1] = { type: 'blob', path: 'zzz/important.js', sha: '3'.repeat(40) };

    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(response({ truncated: false, tree: baseTree }))
      .mockResolvedValueOnce(response({ truncated: false, tree: headTree }));

    const snapshot = await fetchImmutableRepositorySnapshot({
      identity,
      changedFiles: [{ path: 'zzz/important.js', patch: '@@ -1 +1 @@\n-a\n+b', newSha: '3'.repeat(40) }],
      token: 'test-token',
      fetchImplementation,
    });

    expect(snapshot.files.length).toBeLessThanOrEqual(MAX_FILES);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'head', path: 'zzz/important.js', blobSha: '3'.repeat(40), patch: expect.stringContaining('@@') }),
    ]));

    // pure helper: changed path wins over filler when over budget
    const oversized = [
      ...Array.from({ length: MAX_FILES }, (_, i) => ({ ref: 'head' as const, path: `a/${i}.js`, blobSha: '4'.repeat(40) })),
      { ref: 'head' as const, path: 'zzz/keep.js', blobSha: '5'.repeat(40), patch: 'p' },
    ];
    const bounded = boundSnapshotFiles(oversized, [{ path: 'zzz/keep.js' }], MAX_FILES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.files.length).toBe(MAX_FILES);
    expect(bounded.files.some((f: { path: string }) => f.path === 'zzz/keep.js')).toBe(true);
  });
});
