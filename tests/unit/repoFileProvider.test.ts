import { describe, it, expect, vi } from 'vitest';
import { createRepoFileProvider } from '../../src/app';
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

  it('reads a single file through the not-found-is-null contract', async () => {
    const github = stubGitHub({ getFileContent: async (_o: string, _r: string, path: string) => (path === 'x.ts' ? 'body' : null) });
    const provider = createRepoFileProvider(github, 'o', 'r', 'deadbeef');
    expect(await provider.readFile('x.ts')).toBe('body');
    expect(await provider.readFile('missing.ts')).toBeNull();
    const args = (github.getFileContent as any).mock.calls[0];
    expect(args[3]).toBe('deadbeef');
    expect(args[4]).toEqual({ notFoundIsEmpty: true });
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
