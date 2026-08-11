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
});
