import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';

describe('installationClient.ts — Comprehensive Unit Expansion Tests', () => {
  const token = 'ghs_test_installation_token_12345';
  let client: GitHubInstallationClient;

  beforeEach(() => {
    client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com' });
  });

  it('constructor throws error if token does not start with ghs_', () => {
    expect(() => new GitHubInstallationClient({ token: 'ghp_user_token' })).toThrow(
      'GitHubInstallationClient requires a ghs_ installation token'
    );
    expect(() => new GitHubInstallationClient({ token: 'invalid' })).toThrow(
      'GitHubInstallationClient requires a ghs_ installation token'
    );
  });

  it('getPullRequest returns parsed PR snapshot', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        head: { sha: 'head-sha-123' },
        base: { sha: 'base-sha-456' },
        title: 'Add new feature',
        body: 'PR description',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const snapshot = await client.getPullRequest('calltelemetry', 'repo-1', 42);

    expect(snapshot).toEqual({
      headSha: 'head-sha-123',
      baseSha: 'base-sha-456',
      title: 'Add new feature',
      body: 'PR description',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/repo-1/pulls/42',
      expect.anything()
    );

    vi.unstubAllGlobals();
  });

  it('uses the injected fetch boundary and preserves exact GitHub request headers', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      head: { sha: 'exact-head-sha' },
      base: { sha: 'exact-base-sha' },
      title: 'Exact head review',
      body: 'body',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const injectedClient = new GitHubInstallationClient({
      token,
      baseUrl: 'https://github.test',
      fetchImplementation,
      now: () => 1_700_000_000_000,
    });

    await expect(injectedClient.getPullRequest('calltelemetry', 'repo-1', 42)).resolves.toMatchObject({
      headSha: 'exact-head-sha',
      baseSha: 'exact-base-sha',
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://github.test/repos/calltelemetry/repo-1/pulls/42',
      expect.anything(),
    );
    const requestHeaders = new Headers(fetchImplementation.mock.calls[0][1].headers);
    expect(requestHeaders.get('accept')).toBe('application/vnd.github+json');
    expect(requestHeaders.get('authorization')).toBe(`Bearer ${token}`);
    expect(requestHeaders.get('x-github-api-version')).toBe('2022-11-28');
    expect(requestHeaders.get('user-agent')).toBe('ct-review-bot[bot]');
  });

  it('getBasePolicy fetches and decodes base64 .ct-review.yaml content', async () => {
    const yamlContent = 'version: 3\nprofile: balanced';
    const base64Content = Buffer.from(yamlContent).toString('base64');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        encoding: 'base64',
        content: base64Content,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const policy = await client.getBasePolicy('calltelemetry', 'repo-1', 'base-sha-456');

    expect(policy).toBe(yamlContent);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/repo-1/contents/.ct-review.yaml?ref=base-sha-456',
      expect.anything()
    );

    vi.unstubAllGlobals();
  });

  it('getBasePolicy throws error if response encoding is not base64', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        encoding: 'utf-8',
        content: 'plain text',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.getBasePolicy('calltelemetry', 'repo-1', 'base-sha-456')).rejects.toThrow(
      'base policy response is not base64 file content'
    );

    vi.unstubAllGlobals();
  });

  it('getChangedFiles handles multi-page pagination', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}.ts`, patch: '+ code' }));
    const page2 = [{ filename: 'file100.ts', patch: '+ code' }];

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page1),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page2),
      });
    vi.stubGlobal('fetch', mockFetch);

    const files = await client.getChangedFiles('calltelemetry', 'repo-1', 42);

    expect(files).toHaveLength(101);
    expect(files[0].path).toBe('file0.ts');
    expect(files[100].path).toBe('file100.ts');

    vi.unstubAllGlobals();
  });

  it('marks patch-only gitlink markers as an untrusted submodule candidate', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{
        filename: 'vendor/lib',
        patch: '-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }]),
    });
    vi.stubGlobal('fetch', mockFetch);

    const files = await client.getChangedFiles('calltelemetry', 'repo-1', 42);

    expect(files[0]).toMatchObject({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), submoduleCandidate: true });
    expect(files[0].isSubmodule).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('parses standard gitlink patches that include a unified hunk header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{
        filename: 'vendor/lib',
        mode: '160000',
        patch: 'diff --git a/vendor/lib b/vendor/lib\nold mode 160000\nnew mode 160000\n@@ -1 +1 @@\n-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }]),
    });
    vi.stubGlobal('fetch', mockFetch);

    const files = await client.getChangedFiles('calltelemetry', 'repo-1', 42);

    expect(files[0]).toMatchObject({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), isSubmodule: true });
    vi.unstubAllGlobals();
  });

  it('normalizes quoted .gitmodules paths and URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        encoding: 'utf-8',
        content: '[submodule "vendor/lib"]\n\tpath = "vendor/lib"\n\turl = "../ct-pr-operator.git"',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.getSubmoduleUrls('calltelemetry', 'repo-1', 'base-sha')).resolves.toEqual({
      'vendor/lib': 'https://github.com/calltelemetry/ct-pr-operator.git',
    });
    vi.unstubAllGlobals();
  });

  it('getIncrementalDiff fetches comparison diff files', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        files: [
          { filename: 'src/app.ts', patch: '+ diff' },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const files = await client.getIncrementalDiff('calltelemetry', 'repo-1', 'sha1', 'sha2');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/app.ts');

    vi.unstubAllGlobals();
  });

  it('getFileContent returns null when file is not found (404)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    vi.stubGlobal('fetch', mockFetch);

    const content = await client.getFileContent('calltelemetry', 'repo-1', 'nonexistent.txt');
    expect(content).toBeNull();

    vi.unstubAllGlobals();
  });

  it('createCheck posts check run payload and returns numeric check ID', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 887766 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const checkId = await client.createCheck('calltelemetry', 'repo-1', 'head-sha-123');

    expect(checkId).toBe(887766);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/repo-1/check-runs',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(body.name).toBe('Review Yeti / Gate');

    vi.unstubAllGlobals();
  });

  it('completeCheck sends PATCH request with conclusion and output summary', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 887766, status: 'completed' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await client.completeCheck({
      owner: 'calltelemetry',
      repo: 'repo-1',
      checkId: 887766,
      conclusion: 'success',
      title: 'Check Passed',
      summary: 'All checks passed cleanly.',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/repo-1/check-runs/887766',
      expect.objectContaining({ method: 'PATCH' })
    );

    vi.unstubAllGlobals();
  });

  it('postIssueComment sends POST request to issue comments endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 999 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await client.postIssueComment('calltelemetry', 'repo-1', 42, 'Hello comment!');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/repo-1/issues/42/comments',
      expect.objectContaining({ method: 'POST' })
    );

    vi.unstubAllGlobals();
  });

  it('replyToReviewComment sends POST request to pull comment replies endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 1000 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await client.replyToReviewComment('calltelemetry', 'repo-1', 42, 555, 'Replying to comment');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/repo-1/pulls/42/comments/555/replies',
      expect.objectContaining({ method: 'POST' })
    );

    vi.unstubAllGlobals();
  });
});
