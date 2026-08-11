import { describe, expect, it, vi } from 'vitest';

const {
  createGitHubBlobClient,
  createReviewNavigationToolRegistry,
} = require('../../src/mcp/reviewNavigationTools.js');

const identity = {
  repository: 'acme/widgets',
  prNumber: '17',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
};

const snapshot = {
  repository: identity.repository,
  headSha: identity.headSha,
  baseSha: identity.baseSha,
  files: [
    { path: 'src/app.js', blobSha: '1'.repeat(40), patch: '@@ -1 +1 @@\n-old\n+new' },
    { path: 'README.md', blobSha: '2'.repeat(40), patch: '@@ -1 +1 @@\n-old docs\n+new docs' },
  ],
};

function registry(overrides: Record<string, unknown> = {}) {
  const blobClient = { getBlob: vi.fn(async ({ blobSha }: { blobSha: string }) => ({
    sha: blobSha,
    content: blobSha === '1'.repeat(40) ? 'const matched = true;\nsecond line\n' : 'documentation only\n',
  })) };
  return {
    blobClient,
    registry: createReviewNavigationToolRegistry({
      identity,
      snapshot,
      config: { enabled: true, maxCalls: 4, maxReadBytes: 128, maxResultBytes: 256, maxFindResults: 2, timeoutMs: 1000 },
      blobClient,
      ...overrides,
    }),
  };
}

describe('review navigation tools', () => {
  it('is disabled by default and never contacts GitHub', async () => {
    const blobClient = { getBlob: vi.fn() };
    const tools = createReviewNavigationToolRegistry({ identity, snapshot, blobClient });

    await expect(tools.call('file_read', { path: 'src/app.js' })).resolves.toMatchObject({ status: 'unavailable', reason: 'disabled' });
    expect(blobClient.getBlob).not.toHaveBeenCalled();
  });

  it('reads only a snapshot-listed immutable blob and binds its result to the review identity', async () => {
    const { registry: tools, blobClient } = registry();

    const result = await tools.call('file_read', { path: 'src/app.js', startLine: 1, endLine: 1 });

    expect(blobClient.getBlob).toHaveBeenCalledWith(expect.objectContaining({
      repository: 'acme/widgets', blobSha: '1'.repeat(40), headSha: identity.headSha,
    }));
    expect(result).toMatchObject({ status: 'ok', tool: 'file_read', path: 'src/app.js', blobSha: '1'.repeat(40), identity });
    expect(result.content).toBe('const matched = true;\n');
  });

  it('refuses traversal and paths that are absent from the immutable snapshot', async () => {
    const { registry: tools, blobClient } = registry();

    await expect(tools.call('file_read', { path: '../.git/config' })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid file path' });
    await expect(tools.call('file_read', { path: 'src/not-in-pr.js' })).resolves.toMatchObject({ status: 'unavailable', reason: 'file_not_in_snapshot' });
    expect(blobClient.getBlob).not.toHaveBeenCalled();
  });

  it('finds paths and searches only the identity-bound snapshot, with bounded results', async () => {
    const { registry: tools, blobClient } = registry();

    const found = await tools.call('file_find', { query: 'src' });
    const matches = await tools.call('code_search', { query: 'matched', paths: ['src/app.js'] });

    expect(found).toMatchObject({ status: 'ok', tool: 'file_find', paths: ['src/app.js'], identity });
    expect(matches).toMatchObject({ status: 'ok', tool: 'code_search', identity });
    expect(matches.matches).toEqual([{ path: 'src/app.js', line: 1, text: 'const matched = true;' }]);
    expect(blobClient.getBlob).toHaveBeenCalledTimes(1);
    expect(blobClient.getBlob).toHaveBeenNthCalledWith(1, expect.objectContaining({ blobSha: '1'.repeat(40) }));
  });

  it('serves an immutable API patch without shelling out or calling a mutable diff endpoint', async () => {
    const { registry: tools, blobClient } = registry();

    const result = await tools.call('file_read_diff', { path: 'src/app.js' });

    expect(result).toMatchObject({ status: 'ok', tool: 'file_read_diff', path: 'src/app.js', baseSha: identity.baseSha, headSha: identity.headSha, patch: '@@ -1 +1 @@\n-old\n+new' });
    expect(blobClient.getBlob).not.toHaveBeenCalled();
  });

  it('honors cancellation and the hard tool-call budget before any extra blob requests', async () => {
    const { registry: tools, blobClient } = registry({ config: { enabled: true, maxCalls: 1, maxReadBytes: 128, maxResultBytes: 256, timeoutMs: 1000 } });
    const controller = new AbortController();
    controller.abort();

    await expect(tools.call('file_read', { path: 'src/app.js' }, { signal: controller.signal })).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tools.call('file_find', { query: 'src' })).resolves.toMatchObject({ status: 'ok' });
    await expect(tools.call('file_read_diff', { path: 'src/app.js' })).resolves.toMatchObject({ status: 'unavailable', reason: 'call_budget_exhausted' });
    expect(blobClient.getBlob).not.toHaveBeenCalled();
  });

  it('allows the GitHub blob client to use only an authenticated HTTPS GitHub API origin', async () => {
    expect(() => createGitHubBlobClient({ token: 'secret', apiBaseUrl: 'http://api.github.com' })).toThrow('must use HTTPS');
    expect(() => createGitHubBlobClient({ token: 'secret', apiBaseUrl: 'https://127.0.0.1' })).toThrow('not allowlisted');
    const raw = JSON.stringify({ sha: 'c'.repeat(40), content: Buffer.from('safe').toString('base64'), encoding: 'base64' });
    const fetchImplementation = vi.fn(async () => ({ ok: true, status: 200, headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(raw)) : null }, text: async () => raw }));
    const client = createGitHubBlobClient({ token: 'secret', fetchImplementation });

    await expect(client.getBlob({ repository: identity.repository, blobSha: 'c'.repeat(40), headSha: identity.headSha })).resolves.toMatchObject({ sha: 'c'.repeat(40), content: 'safe' });
    const [url, request] = fetchImplementation.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/acme/widgets/git/blobs/${'c'.repeat(40)}`);
    expect(request.headers.Authorization).toBe('Bearer secret');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects oversized GitHub blob responses before allocating or parsing the body', async () => {
    const text = vi.fn(async () => { throw new Error('must not read unbounded text'); });
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '999999' : null },
      text,
      body: { async *[Symbol.asyncIterator]() { yield Buffer.from('{"sha":"'); yield Buffer.alloc(10_000, 'x'); } },
    }));
    const client = createGitHubBlobClient({ token: 'secret', fetchImplementation });

    await expect(client.getBlob({ repository: identity.repository, blobSha: 'c'.repeat(40), headSha: identity.headSha, maxBytes: 4 })).rejects.toThrow('blob_response_too_large');
    expect(text).not.toHaveBeenCalled();
  });

  it('incrementally decodes an in-cap response without allocating a decoded payload over maxBytes', async () => {
    const encoded = Buffer.alloc(24, 'x').toString('base64');
    const raw = JSON.stringify({ sha: 'c'.repeat(40), content: encoded, encoding: 'base64' });
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(raw)) : null },
      text: async () => raw,
    }));
    const client = createGitHubBlobClient({ token: 'secret', fetchImplementation });
    const bufferFrom = vi.spyOn(Buffer, 'from');
    try {
      const result = await client.getBlob({ repository: identity.repository, blobSha: 'c'.repeat(40), headSha: identity.headSha, maxBytes: 4 });
      expect(result).toMatchObject({ content: 'xxxx', byteCount: 4, truncated: true });
      expect(bufferFrom.mock.calls.filter((call) => call[1] === 'base64').every((call) => String(call[0]).length <= 8)).toBe(true);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it('returns allowlisted failure reasons without leaking upstream errors, URLs, or tokens', async () => {
    const blobClient = { getBlob: vi.fn(async () => { throw new Error('Bearer top-secret failed at https://evil.invalid/leak'); }) };
    const tools = createReviewNavigationToolRegistry({ identity, snapshot, config: { enabled: true }, blobClient });

    const result = await tools.call('file_read', { path: 'src/app.js' });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'blob_fetch_failed' });
    expect(JSON.stringify(result)).not.toContain('top-secret');
    expect(JSON.stringify(result)).not.toContain('evil.invalid');
  });

  // Regression coverage for a plausible cause of the cisco-cdr false-BLOCK/false-SHIP incidents
  // (2026-08-11): a single malformed record anywhere in a large real-world monorepo tree
  // (generated assets, deeply nested vendored dependencies, build output -- all realistic at
  // cisco-cdr's ~17k-blob scale) used to throw and disable bounded evidence tooling for the
  // *entire* review, for every other otherwise-valid file. That silently drops evidence tooling
  // repo-wide, which (via reviewInvestigation.js candidateFindings) can turn a real defect into a
  // manufactured APPROVE.
  describe('a single malformed snapshot record does not disable the whole registry', () => {
    it('constructs a working registry and simply excludes an overlong path, keeping every valid file reachable', async () => {
      const overlongPath = `src/${'x'.repeat(600)}.js`;
      const { registry: tools, blobClient } = registry({
        snapshot: {
          ...snapshot,
          files: [
            ...snapshot.files,
            { path: overlongPath, blobSha: '3'.repeat(40), patch: '@@ -1 +1 @@\n-old\n+new' },
          ],
        },
      });

      await expect(tools.call('file_read', { path: 'src/app.js', startLine: 1, endLine: 1 })).resolves.toMatchObject({ status: 'ok', content: 'const matched = true;\n' });
      // The overlong path is rejected by the same call-time validPath() check any caller would
      // hit for a path that was never in the snapshot -- the point is it does not crash
      // registry construction and does not affect any other (valid) file.
      await expect(tools.call('file_read', { path: overlongPath })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid file path' });
      expect(blobClient.getBlob).toHaveBeenCalledTimes(1);
    });

    it('excludes a record with an invalid blob SHA and a duplicate ref:path record, keeping the rest of the snapshot usable', async () => {
      const { registry: tools } = registry({
        snapshot: {
          ...snapshot,
          files: [
            ...snapshot.files,
            { path: 'src/app.js', blobSha: 'not-a-sha', patch: '' }, // invalid SHA, different path collision-adjacent record
            { path: 'src/app.js', blobSha: '9'.repeat(40), patch: '' }, // duplicate key (first occurrence wins)
          ],
        },
      });

      const found = await tools.call('file_find', { query: 'app' });
      expect(found).toMatchObject({ status: 'ok', paths: ['src/app.js'] });
      const read = await tools.call('file_read', { path: 'src/app.js' });
      // The duplicate/invalid records must not have overwritten the original valid blob SHA.
      expect(read).toMatchObject({ status: 'ok', blobSha: '1'.repeat(40) });
    });

    it('still throws for a snapshot whose file count exceeds the hard 5,000-file bound (unchanged -- not weakened by this fix)', () => {
      const oversized = { ...snapshot, files: Array.from({ length: 5_001 }, (_, index) => ({ path: `src/f${index}.js`, blobSha: '1'.repeat(40), patch: '' })) };
      expect(() => createReviewNavigationToolRegistry({ identity, snapshot: oversized, config: { enabled: true }, blobClient: { getBlob: vi.fn() } }))
        .toThrow('review navigation snapshot must contain a bounded file list');
    });
  });
});
