import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRepoFileProvider } from '../../src/panel/repoFileProvider';
import { GitHubInstallationClient } from '../../src/github/installationClient';

// The only production implementation of RepoFileProvider. Every panelEngine test
// stubs the interface, so this is where the real control flow is proven.

function stubGitHub(impl: { getFileTree?: any; getFileContent?: any }) {
  return {
    getFileTree: vi.fn(impl.getFileTree || (async () => ({ paths: [], truncated: false }))),
    getFileContent: vi.fn(impl.getFileContent || (async () => null)),
  } as unknown as GitHubInstallationClient;
}

describe('createRepoFileProvider', () => {
  it('fetches the tree once and reuses it across tool calls', async () => {
    const github = stubGitHub({ getFileTree: async () => ({ paths: ['tools/a.mjs', 'src/b.ts'], truncated: false }) });
    const provider = createRepoFileProvider(github, 'o', 'r', 'deadbeef');
    expect(await provider.findFiles('a.mjs')).toEqual(['tools/a.mjs']);
    expect(await provider.findFiles('B.TS')).toEqual(['src/b.ts']);
    expect(await provider.findFiles('nope')).toEqual([]);
    expect((github.getFileTree as any).mock.calls.length).toBe(1);
  });

  it('retries the tree on the next call after a failed lookup, instead of caching the rejection', async () => {
    // A single transient 502 must not poison every later find_files/read_file
    // call for the rest of the review run.
    let calls = 0;
    const github = stubGitHub({
      getFileTree: async () => {
        calls += 1;
        if (calls === 1) throw new Error('tree 502');
        return { paths: ['tools/a.mjs'], truncated: false };
      },
    });
    const provider = createRepoFileProvider(github, 'o', 'r', 'deadbeef');
    await expect(provider.findFiles('a')).rejects.toThrow('tree 502');
    expect(await provider.findFiles('a')).toEqual(['tools/a.mjs']);
    expect(calls).toBe(2);
  });

  it('exposes tree truncation so the panel can refuse to claim absence', async () => {
    const github = stubGitHub({ getFileTree: async () => ({ paths: ['a'], truncated: true }) });
    const provider = createRepoFileProvider(github, 'o', 'r', 'deadbeef');
    expect(await provider.treeTruncated!()).toBe(true);
    expect(await provider.findFiles('zzz')).toEqual([]);
    // One fetch serves both calls.
    expect((github.getFileTree as any).mock.calls.length).toBe(1);
  });

  it('reads a single file through the not-found-is-null contract', async () => {
    const github = stubGitHub({ getFileContent: async (_o: string, _r: string, path: string) => (path === 'x.ts' ? 'body' : null) });
    const provider = createRepoFileProvider(github, 'o', 'r', 'deadbeef');
    expect(await provider.readFile('x.ts')).toBe('body');
    expect(await provider.readFile('missing.ts')).toBeNull();
    const args = (github.getFileContent as any).mock.calls[0];
    expect(args[3]).toBe('deadbeef');
    expect(args[4]).toEqual({ notFoundIsEmpty: true });
  });

  it('returns revision-pinned reverse-reference candidates but keeps a truncated scan non-exhaustive', async () => {
    const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
    const sources = new Map([
      ['src/caller.ts', "import { authorize } from './security';\nauthorize(request);\n"],
      ['src/other.ts', 'export const authorizeLater = true;\n'],
    ]);
    const github = {
      getFileTree: vi.fn(async (_owner: string, _repo: string, sha: string) => ({
        paths: sha === headSha ? ['src/caller.ts', 'src/other.ts'] : ['src/caller.ts'], truncated: sha === headSha,
      })),
      getFileContentEvidence: vi.fn(async (_owner: string, _repo: string, path: string) => ({
        presence: 'present' as const, content: sources.get(path) ?? null,
      })),
    } as unknown as GitHubInstallationClient;
    const provider = createRepoFileProvider(github, 'o', 'r', headSha, { baseSha, changedFiles: [] });

    const head = await provider.findReferences!('authorize', 'src/security.ts', 'head');
    expect(head).toMatchObject({ version: 'PinnedSourceReferenceSearch.v1', repository: 'o/r',
      sourcePath: 'src/security.ts', symbol: 'authorize', side: 'head', revisionSha: headSha,
      candidatePaths: ['src/caller.ts'], searchComplete: false, scannedFileCount: 2, reason: 'tree_truncated' });
    const base = await provider.findReferences!('authorize', 'src/security.ts', 'base');
    expect(base).toMatchObject({ revisionSha: baseSha, candidatePaths: ['src/caller.ts'], searchComplete: true,
      scannedFileCount: 1, scannedBytes: Buffer.byteLength(sources.get('src/caller.ts')!, 'utf8'), reason: null });
  });
});

describe('GitHubInstallationClient.getFileTree', () => {
  function clientWithResponse(data: unknown) {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    (client as any).request = vi.fn(async () => data);
    return client;
  }

  it('keeps blob paths and drops trees, submodules and malformed entries', async () => {
    const client = clientWithResponse({
      tree: [
        { path: 'src', type: 'tree' },
        { path: 'src/a.ts', type: 'blob' },
        { path: 'vendor', type: 'commit' },
        { path: 42, type: 'blob' },
        null,
        { path: 'docs/b.md', type: 'blob' },
      ],
      truncated: false,
    });
    expect(await client.getFileTree('o', 'r', 'ref')).toEqual({ paths: ['src/a.ts', 'docs/b.md'], truncated: false });
  });

  it('surfaces the truncated flag so callers can say results may be incomplete', async () => {
    const client = clientWithResponse({ tree: [{ path: 'a', type: 'blob' }], truncated: true });
    expect((await client.getFileTree('o', 'r', 'ref')).truncated).toBe(true);
  });

  it('rejects a response whose tree is not an array', async () => {
    const client = clientWithResponse({ message: 'Not Found' });
    await expect(client.getFileTree('o', 'r', 'ref')).rejects.toThrow('git tree response is not an array');
  });
});

describe('GitHubInstallationClient.getFileContentEvidence', () => {
  it('returns absent only for an exact contents 404 and unavailable for oversized bytes', async () => {
    const missing = new GitHubInstallationClient({ token: 'ghs_test', baseUrl: 'https://api.example.test',
      fetchImplementation: async () => new Response('not found', { status: 404 }) });
    expect(await missing.getFileContentEvidence('o', 'r', 'gone.ts', 'a'.repeat(40)))
      .toEqual({ presence: 'absent', content: null });
    const oversized = new GitHubInstallationClient({ token: 'ghs_test', baseUrl: 'https://api.example.test',
      fetchImplementation: async () => new Response(JSON.stringify({ sha: 'a'.repeat(40), encoding: 'none',
        size: 8_000_001, content: '' }), { status: 200 }) });
    expect(await oversized.getFileContentEvidence('o', 'r', 'large.ts', 'a'.repeat(40)))
      .toEqual({ presence: 'unavailable', content: null });
  });
});


describe('pinned source identities', () => {
  it('returns a digest for the complete revision-pinned UTF-8 bytes without normalizing line endings', async () => {
    const content = 'one 🧪\r\nold café\r\n';
    const github = { getFileContentEvidence: vi.fn(async () => ({ presence: 'present' as const, content })) } as unknown as GitHubInstallationClient;
    const provider = createRepoFileProvider(github, 'o', 'r', 'a'.repeat(40), { baseSha: 'b'.repeat(40), changedFiles: [] });

    expect(await provider.readFileAt!('src/utf8.ts', 'head')).toEqual({
      sha: 'a'.repeat(40), content, presence: 'present',
      contentSha256: createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
      source: { repository: 'o/r', path: 'src/utf8.ts', side: 'head' },
    });
  });

  it('preserves pinned absent versus unavailable outcomes and path-side identity', async () => {
    const baseSha = 'b'.repeat(40), headSha = 'a'.repeat(40);
    const github = { getFileContentEvidence: vi.fn(async (_owner: string, _repo: string, path: string) => path === 'missing.ts'
      ? { presence: 'absent' as const, content: null }
      : { presence: 'unavailable' as const, content: null }) } as unknown as GitHubInstallationClient;
    const provider = createRepoFileProvider(github, 'o', 'r', headSha, { baseSha, changedFiles: [] });
    expect(await provider.readFileAt!('missing.ts', 'base')).toEqual({ sha: baseSha, content: null, presence: 'absent',
      source: { repository: 'o/r', path: 'missing.ts', side: 'base' } });
    expect(await provider.readFileAt!('large.ts', 'head')).toEqual({ sha: headSha, content: null, presence: 'unavailable',
      source: { repository: 'o/r', path: 'large.ts', side: 'head' } });
  });
  it('reads the admitted base revision directly without substituting the Git merge base', async () => {
    const getMergeBase = vi.fn(async () => 'd'.repeat(40));
    const getFileContent = vi.fn(async () => 'admitted base source');
    const baseSha = 'c'.repeat(40);
    const provider = createRepoFileProvider({ getMergeBase, getFileContent } as unknown as GitHubInstallationClient,
      'o', 'r', 'a'.repeat(40), { baseSha, changedFiles: [] });

    expect(await provider.readFileAt!('src/a.ts', 'base')).toEqual({ sha: baseSha, content: 'admitted base source', presence: 'present',
      contentSha256: createHash('sha256').update('admitted base source').digest('hex'),
      source: { repository: 'o/r', path: 'src/a.ts', side: 'base' } });
    expect(getFileContent).toHaveBeenCalledExactlyOnceWith('o', 'r', 'src/a.ts', baseSha, { notFoundIsEmpty: true });
    expect(getMergeBase).not.toHaveBeenCalled();
  });

  it('retries failed merge-base and source lookups instead of caching rejected promises', async () => {
    const getMergeBase = vi.fn().mockRejectedValueOnce(new Error('compare 503')).mockResolvedValue('b'.repeat(40));
    const getFileContent = vi.fn().mockResolvedValue('verified old source');
    const provider = createRepoFileProvider({ getMergeBase, getFileContent } as unknown as GitHubInstallationClient,
      'o', 'r', 'a'.repeat(40), { baseSha: 'c'.repeat(40), changedFiles: [] });
    await expect(provider.readFileAt!('x', 'merge-base')).rejects.toThrow('compare 503');
    expect(await provider.readFileAt!('x', 'merge-base')).toEqual({ sha: 'b'.repeat(40), content: 'verified old source', presence: 'present',
      contentSha256: createHash('sha256').update('verified old source').digest('hex'),
      source: { repository: 'o/r', path: 'x', side: 'merge-base' } });
    expect(getMergeBase).toHaveBeenCalledTimes(2); expect(getFileContent).toHaveBeenCalledTimes(1);
    const getHead = vi.fn().mockRejectedValueOnce(new Error('contents 503')).mockResolvedValue('verified head');
    const headProvider = createRepoFileProvider({ getFileContent: getHead } as unknown as GitHubInstallationClient, 'o', 'r', 'a'.repeat(40));
    await expect(headProvider.readFileAt!('x', 'head')).rejects.toThrow('contents 503');
    expect(await headProvider.readFileAt!('x', 'head')).toEqual({ sha: 'a'.repeat(40), content: 'verified head', presence: 'present',
      contentSha256: createHash('sha256').update('verified head').digest('hex'),
      source: { repository: 'o/r', path: 'x', side: 'head' } });
    expect(getHead).toHaveBeenCalledTimes(2);
  });

  it('encodes filename query characters without allowing them to override the pinned ref', async () => {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    (client as any).request = vi.fn(async () => ({ encoding: 'base64', content: 'eA==' }));
    expect(await client.getFileContent('o', 'r', 'src/name ?ref=main&#%.ts', 'a'.repeat(40))).toBe('x');
    expect((client as any).request).toHaveBeenCalledExactlyOnceWith(
      '/repos/o/r/contents/src/name%20%3Fref%3Dmain%26%23%25.ts?ref=' + 'a'.repeat(40));
  });

  it('returns the verified distinct merge base and rejects malformed commit identities before I/O', async () => {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    const base = 'a'.repeat(40), head = 'b'.repeat(40), old = 'c'.repeat(40);
    (client as any).request = vi.fn(async () => ({ base_commit: { sha: base }, merge_base_commit: { sha: old } }));
    expect(await client.getMergeBase('o', 'r', base, head)).toBe(old);
    expect((client as any).request).toHaveBeenCalledExactlyOnceWith(`/repos/o/r/compare/${base}...${head}?per_page=1`);
    for (const pair of [['short', head], [base, 'short']]) {
      await expect(client.getMergeBase('o', 'r', pair[0], pair[1])).rejects.toThrow('Invalid source identity');
    }
    expect((client as any).request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sha: 'c'.repeat(40), encoding: 'base64', content: 'eA==' },
    { sha: 'a'.repeat(40), encoding: 'none', content: 'x' },
    { sha: 'a'.repeat(40), encoding: 'base64', content: 42 },
    { sha: 'a'.repeat(40), encoding: 'base64', content: 'eHg=' },
  ])('rejects unverified large blob bytes: %j', async (blob) => {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    (client as any).request = vi.fn(async (url: string) => url.includes('/git/blobs/') ? blob
      : { sha: 'a'.repeat(40), encoding: 'none', content: '', size: 1 });
    await expect(client.getFileContent('o', 'r', 'x', 'b'.repeat(40), { notFoundIsEmpty: true }))
      .rejects.toThrow(/Source blob (identity|size) mismatch/);
  });

  it('does not fetch a contents placeholder above the admitted byte limit', async () => {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    (client as any).request = vi.fn(async () => ({ sha: 'a'.repeat(40), encoding: 'none', size: 8_000_001 }));
    expect(await client.getFileContent('o', 'r', 'x', 'b'.repeat(40))).toBeNull();
    expect((client as any).request).toHaveBeenCalledTimes(1);
  });

  it('bounds pinned source cache entries and bytes without changing revisions', async () => {
    const github = stubGitHub({ getFileContent: async () => 'x' });
    const provider = createRepoFileProvider(github, 'o', 'r', 'a'.repeat(40));
    for (let i = 0; i < 33; i++) await provider.readFileAt!(`p${i}`, 'head');
    await provider.readFileAt!('p32', 'head');
    expect(github.getFileContent).toHaveBeenCalledTimes(33);
    await provider.readFileAt!('p0', 'head');
    expect(github.getFileContent).toHaveBeenCalledTimes(34);
    const large = stubGitHub({ getFileContent: async () => 'x'.repeat(6_000_000) });
    const bounded = createRepoFileProvider(large, 'o', 'r', 'a'.repeat(40));
    for (const path of ['a', 'b', 'c']) await bounded.readFileAt!(path, 'head');
    await bounded.readFileAt!('c', 'head');
    expect(large.getFileContent).toHaveBeenCalledTimes(3);
    await bounded.readFileAt!('a', 'head');
    expect(large.getFileContent).toHaveBeenCalledTimes(4);
    const oversized = createRepoFileProvider(stubGitHub({ getFileContent: async () => 'x'.repeat(8_000_001) }), 'o', 'r', 'a'.repeat(40));
    expect(await oversized.readFileAt!('huge', 'head')).toEqual({ sha: 'a'.repeat(40), content: null,
      presence: 'unavailable', source: { repository: 'o/r', path: 'huge', side: 'head' } });
  });

  it('rejects a compare response for the wrong admitted base', async () => {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    (client as any).request = vi.fn(async () => ({ base_commit: { sha: 'c'.repeat(40) }, merge_base_commit: { sha: 'd'.repeat(40) } }));
    await expect(client.getMergeBase('o', 'r', 'a'.repeat(40), 'b'.repeat(40))).rejects.toThrow('identity mismatch');
  });

  it('loads the exact large-file blob instead of treating an empty contents placeholder as source', async () => {
    const client = Object.create(GitHubInstallationClient.prototype) as GitHubInstallationClient;
    const sha = 'a'.repeat(40), content = 'old tenant guard';
    (client as any).request = vi.fn(async (url: string) => url.includes('/git/blobs/')
      ? { sha, encoding: 'base64', content: Buffer.from(content).toString('base64') }
      : { sha, encoding: 'none', content: '', size: Buffer.byteLength(content) });
    expect(await client.getFileContent('o', 'r', 'old.sh', 'b'.repeat(40), { notFoundIsEmpty: true })).toBe(content);
    expect((client as any).request).toHaveBeenLastCalledWith('/repos/o/r/git/blobs/' + sha);
  });
});
