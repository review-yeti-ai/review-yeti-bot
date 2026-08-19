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

  describe('code_search: repo-wide search (paths_required removed)', () => {
    it('searches every file for the ref when no paths are supplied', async () => {
      const { registry: tools, blobClient } = registry();

      const result = await tools.call('code_search', { query: 'matched' });

      expect(result).toMatchObject({ status: 'ok', tool: 'code_search', regex: false, requestedFiles: 2 });
      expect(result.matches).toEqual([{ path: 'src/app.js', line: 1, text: 'const matched = true;' }]);
      // Both snapshot files for `ref: head` were candidates; only the matching one needed a blob fetch call
      // for its content to be scanned -- but the README was scanned too and simply had no match.
      expect(blobClient.getBlob).toHaveBeenCalledTimes(2);
    });

    it('still honors an explicit paths list exactly as before (no regression)', async () => {
      const { registry: tools, blobClient } = registry();

      const result = await tools.call('code_search', { query: 'matched', paths: ['src/app.js'] });

      expect(result).toMatchObject({ status: 'ok', requestedFiles: 1, scannedFiles: 1 });
      expect(blobClient.getBlob).toHaveBeenCalledTimes(1);
    });

    it('bounds a repo-wide scan to maxScanFiles', async () => {
      const manyFiles = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.js`, blobSha: `${i}`.repeat(40), patch: '' }));
      const wideSnapshot = { ...snapshot, files: [...snapshot.files, ...manyFiles] };
      const blobClient = { getBlob: vi.fn(async ({ blobSha }: { blobSha: string }) => ({ sha: blobSha, content: 'no match here\n' })) };
      const tools = createReviewNavigationToolRegistry({
        identity,
        snapshot: wideSnapshot,
        config: { enabled: true, maxCalls: 4, maxReadBytes: 128, maxResultBytes: 256, maxFindResults: 50, maxScanFiles: 3, timeoutMs: 1000 },
        blobClient,
      });

      const result = await tools.call('code_search', { query: 'nothing-will-match' });

      expect(result.requestedFiles).toBe(3);
      expect(result.truncated).toBe(true);
      expect(blobClient.getBlob).toHaveBeenCalledTimes(3);
    });
  });

  describe('code_search: bounded regex mode', () => {
    it('matches a safe regex pattern across the whole ref', async () => {
      const { registry: tools } = registry();

      const result = await tools.call('code_search', { query: 'match(ed)?', regex: true });

      expect(result).toMatchObject({ status: 'ok', regex: true });
      expect(result.matches).toEqual([{ path: 'src/app.js', line: 1, text: 'const matched = true;' }]);
    });

    it('rejects an overlong regex pattern', async () => {
      const { registry: tools } = registry();

      const result = await tools.call('code_search', { query: `a${'*b'.repeat(150)}`, regex: true });

      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid code query' });
    });

    it('rejects a syntactically invalid regex without throwing', async () => {
      const { registry: tools } = registry();

      const result = await tools.call('code_search', { query: '(unterminated', regex: true });

      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid code query' });
    });

    // Negative security case (required): classic catastrophic-backtracking shapes are rejected
    // before a RegExp is ever constructed or executed against untrusted repository text.
    it('rejects classic catastrophic-backtracking (ReDoS) patterns', async () => {
      const { registry: tools } = registry({ config: { enabled: true, maxCalls: 20, maxReadBytes: 128, maxResultBytes: 256, maxFindResults: 2, timeoutMs: 1000 } });
      const evilPatterns = ['(a+)+', '(a|a)*', '(a|ab)*', '(.*)+', '([a-zA-Z]+)*'];

      for (const query of evilPatterns) {
        const result = await tools.call('code_search', { query, regex: true });
        expect(result, `pattern ${query} should be rejected`).toMatchObject({ status: 'invalid', reason: 'invalid code query' });
      }
    });

    it('rejects backreferences and lookaround', async () => {
      const { registry: tools } = registry();

      await expect(tools.call('code_search', { query: '(a)\\1', regex: true })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid code query' });
      await expect(tools.call('code_search', { query: '(?=abc)', regex: true })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid code query' });
      await expect(tools.call('code_search', { query: '(?<!abc)x', regex: true })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid code query' });
    });
  });

  describe('library_docs', () => {
    function contextResult(overrides: Record<string, unknown> = {}) {
      return { status: 'ok', library: 'react', topic: 'hooks', snippets: [{ title: 't', content: 'c' }], truncated: false, byteCount: 10, ...overrides };
    }

    it('is unavailable with context7_disabled when no Context7 client/key is configured', async () => {
      const fetchDocs = vi.fn(async () => ({ status: 'unavailable', reason: 'context7_disabled' }));
      const { registry: tools } = registry({ context7Client: { enabled: false, fetchDocs } });

      const result = await tools.call('library_docs', { library: 'react', topic: 'hooks' });

      expect(result).toMatchObject({ status: 'unavailable', reason: 'context7_disabled', tool: 'library_docs', identity });
    });

    it('delegates library and topic to the injected Context7 client and returns bounded snippets', async () => {
      const fetchDocs = vi.fn(async () => contextResult());
      const { registry: tools } = registry({ context7Client: { enabled: true, fetchDocs } });

      const result = await tools.call('library_docs', { library: 'react', topic: 'hooks' });

      expect(fetchDocs).toHaveBeenCalledWith(expect.objectContaining({ library: 'react', topic: 'hooks' }));
      expect(result).toMatchObject({ status: 'ok', tool: 'library_docs', library: 'react', topic: 'hooks', identity });
      expect(result.snippets).toEqual([{ title: 't', content: 'c' }]);
    });

    // Negative security case (required): the model-supplied args are the ONLY thing that
    // crosses into the client -- no URL/host/header field is ever accepted or forwarded.
    it('never forwards a model-supplied url/host/header field to the Context7 client', async () => {
      const fetchDocs = vi.fn(async () => contextResult());
      const { registry: tools } = registry({ context7Client: { enabled: true, fetchDocs } });

      await tools.call('library_docs', {
        library: 'react',
        topic: 'hooks',
        url: 'https://attacker.example/exfil',
        host: 'attacker.example',
        headers: { Authorization: 'Bearer stolen' },
        baseUrl: 'https://attacker.example',
      });

      const passedArgs = fetchDocs.mock.calls[0][0];
      expect(Object.keys(passedArgs).sort()).toEqual(['library', 'signal', 'topic'].sort());
      expect(passedArgs.url).toBeUndefined();
      expect(passedArgs.host).toBeUndefined();
      expect(passedArgs.headers).toBeUndefined();
      expect(passedArgs.baseUrl).toBeUndefined();
    });

    // Negative security case (required): a Context7 timeout degrades this call to unavailable,
    // never throws, and the whole registry keeps serving other tool calls afterward.
    it('degrades a Context7 timeout to unavailable and keeps the registry usable', async () => {
      const fetchDocs = vi.fn(async () => ({ status: 'unavailable', reason: 'context7_timeout' }));
      const { registry: tools, blobClient } = registry({ context7Client: { enabled: true, fetchDocs } });

      const docsResult = await tools.call('library_docs', { library: 'react', topic: 'hooks' });
      expect(docsResult).toMatchObject({ status: 'unavailable', reason: 'context7_timeout' });

      // The rest of the registry (a completely different tool) is unaffected.
      const readResult = await tools.call('file_read', { path: 'src/app.js', startLine: 1, endLine: 1 });
      expect(readResult).toMatchObject({ status: 'ok' });
      expect(blobClient.getBlob).toHaveBeenCalledTimes(1);
    });

    it('honors the shared call budget like every other tool', async () => {
      const fetchDocs = vi.fn(async () => contextResult());
      const { registry: tools } = registry({
        config: { enabled: true, maxCalls: 1, maxReadBytes: 128, maxResultBytes: 256, timeoutMs: 1000 },
        context7Client: { enabled: true, fetchDocs },
      });

      await tools.call('library_docs', { library: 'react', topic: 'hooks' });
      const second = await tools.call('library_docs', { library: 'react', topic: 'hooks' });

      expect(second).toMatchObject({ status: 'unavailable', reason: 'call_budget_exhausted' });
      expect(fetchDocs).toHaveBeenCalledTimes(1);
    });

    it('reports library_docs in the registry capabilities', () => {
      const { registry: tools } = registry();
      expect(tools.capabilities.tools).toContain('library_docs');
    });
  });
});
