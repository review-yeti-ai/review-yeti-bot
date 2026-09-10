import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthoritativeReviewReader, MAX_AUTHORITATIVE_DIFF_BYTES } from '../../src/github/authoritativeReviewReader';

const TOKEN = 'ghs_authoritative-reader.header_segment.signature-with-dash';
const PRIVATE_BODY = 'private-server-response-marker';
const API = 'https://github.example.invalid/api/v3';
const TARGET = { repositoryId: 3210, owner: 'calltelemetry', repo: 'central-policy' };
const PR = { ...TARGET, prNumber: 42 };
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REVISION = 'c'.repeat(40);
const FILE_PATH = 'policy/review.json';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

function repositoryBody(overrides: Record<string, unknown> = {}) {
  return { id: TARGET.repositoryId, full_name: `${TARGET.owner}/${TARGET.repo}`, ...overrides };
}

function pullBody(overrides: Record<string, unknown> = {}) {
  return {
    number: PR.prNumber, state: 'open', draft: false, merged: false,
    head: { sha: HEAD }, base: { sha: BASE, repo: repositoryBody() }, ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function blobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function fileBody(bytes = Buffer.from('{"policy":"review café ☃"}\n'), overrides: Record<string, unknown> = {}) {
  return {
    type: 'file', path: FILE_PATH, sha: blobSha(bytes), encoding: 'base64',
    size: bytes.byteLength, content: bytes.toString('base64'), ...overrides,
  };
}

function fixture(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  fetcher.mockRejectedValue(new Error('unexpected extra fetch'));
  return { fetcher, reader: new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, timeoutMs: 250, fetchImplementation: fetcher }) };
}

async function rejected(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the reader to reject');
}

function expectRedacted(error: Error): void {
  const diagnostics = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  expect(diagnostics).not.toContain(TOKEN);
  expect(diagnostics).not.toContain(PRIVATE_BODY);
}

function streamed(bytes: Uint8Array, chunkBytes = 64 * 1024) {
  let offset = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) { controller.close(); return; }
      const chunk = bytes.subarray(offset, offset + chunkBytes);
      offset += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  return { body, cancel, response: new Response(body), bytesRead: () => offset };
}

describe('AuthoritativeReviewReader', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); }
  });

  describe('configuration and local input guards', () => {
    it.each(['', 'ghs_', 'ghp_personal', 'ghs_bad token', 'ghs_bad\n', 'ghs_bad-token',
      'ghs_one.two', 'ghs_one.two.three.four', 'ghs_one.two.bad/slash', 'ghs_é'])(
      'rejects invalid installation token %j before fetch', (token) => {
        const fetcher = vi.fn<typeof fetch>();
        expect(() => new AuthoritativeReviewReader({ token, baseUrl: API, timeoutMs: 250, fetchImplementation: fetcher }))
          .toThrow(/requires an installation credential/u);
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it.each([
      'http://github.example.invalid', 'ftp://github.example.invalid',
      'https://user@github.example.invalid', 'https://:password@github.example.invalid',
      'https://github.example.invalid?token=private', 'https://github.example.invalid#fragment',
    ])('rejects unsafe API base %s', (baseUrl) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(() => new AuthoritativeReviewReader({ token: TOKEN, baseUrl, timeoutMs: 250, fetchImplementation: fetcher }))
        .toThrow(/credential-free HTTPS/u);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects a malformed API URL without exposing embedded credentials', () => {
      let error: unknown;
      try {
        new AuthoritativeReviewReader({ token: TOKEN, baseUrl: `not-a-url-${TOKEN}`, fetchImplementation: vi.fn<typeof fetch>() });
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expectRedacted(error as Error);
    });

    it.each([249, 30_001, 250.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects timeout %s', (timeoutMs) => {
      expect(() => new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, timeoutMs, fetchImplementation: vi.fn<typeof fetch>() }))
        .toThrow(/timeout is outside its bound/u);
    });

    it.each([250, 30_000])('accepts timeout boundary %s and normalizes trailing slashes', async (timeoutMs) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(pullBody()));
      const reader = new AuthoritativeReviewReader({ token: TOKEN, baseUrl: `${API}///`, timeoutMs, fetchImplementation: fetcher });
      await reader.currentCandidate(PR);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${API}/repos/calltelemetry/central-policy/pulls/42`, expect.any(Object));
    });

    it.each([
      { repositoryId: 0 }, { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
      { owner: '..' }, { owner: 'owner/repo' }, { repo: '.' }, { repo: 'white space' }, { repo: 'a'.repeat(101) },
      { prNumber: 0 }, { prNumber: -1 }, { prNumber: 1.5 }, { prNumber: Number.MAX_SAFE_INTEGER + 1 },
      { candidatePolicy: 'untrusted extra input' },
    ])('rejects invalid candidate request %j without I/O', async (change) => {
      const { reader, fetcher } = fixture();
      await expect(reader.currentCandidate({ ...PR, ...change })).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('currentCandidate', () => {
    it.each([
      { state: 'open', merged: false, draft: false, open: true },
      { state: 'open', merged: false, draft: true, open: true },
      { state: 'closed', merged: false, draft: false, open: false },
      { state: 'closed', merged: true, draft: false, open: false },
    ])('returns authoritative PR coordinates and readiness for %j', async ({ open, ...state }) => {
      const { reader, fetcher } = fixture(jsonResponse(pullBody(state)));
      await expect(reader.currentCandidate(PR)).resolves.toEqual({ ...PR, headSha: HEAD, baseSha: BASE, open, draft: state.draft });
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${API}/repos/calltelemetry/central-policy/pulls/42`, {
        method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'review-yeti-authoritative-reader',
        },
      });
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    });

    it('accepts repository name casing without confusing the fork head repository with the base', async () => {
      const { reader } = fixture(jsonResponse(pullBody({
        head: { sha: HEAD, repo: { id: 12345, full_name: 'fork/elsewhere' } },
        base: { sha: BASE, repo: repositoryBody({ full_name: 'CallTelemetry/Central-Policy' }) },
      })));
      await expect(reader.currentCandidate(PR)).resolves.toMatchObject({ repositoryId: TARGET.repositoryId, headSha: HEAD });
    });

    it.each([
      { number: 43 }, { state: 'open', merged: true },
      { base: { sha: BASE, repo: repositoryBody({ id: 3211 }) } },
      { base: { sha: BASE, repo: repositoryBody({ full_name: 'another/central-policy' }) } },
      { head: { sha: 'A'.repeat(40) } }, { base: { sha: 'b'.repeat(39), repo: repositoryBody() } },
      { draft: undefined }, { draft: 'false' }, { merged: undefined }, { state: 'unknown' },
    ])('rejects inconsistent or malformed upstream PR %j', async (change) => {
      const { reader, fetcher } = fixture(jsonResponse(pullBody(change)));
      await expect(reader.currentCandidate(PR)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe('bounded exact-current diff evidence', () => {
    const request = { ...PR, headSha: HEAD, baseSha: BASE };
    const diff = 'diff --git a/café.ts b/café.ts\n--- a/café.ts\n+++ b/café.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const before = () => jsonResponse(pullBody({ changed_files: 1 }));

    it('binds both metadata reads and returns the exact UTF-8 PR diff and stable file count', async () => {
      const wire = streamed(Buffer.from(diff), 1);
      const { reader, fetcher } = fixture(before(), wire.response, jsonResponse(pullBody({ changed_files: 1, draft: true })));
      await expect(reader.exactCurrentDiff(request)).resolves.toEqual({
        current: { ...request, open: true, draft: true }, diff, expectedFileCount: 1,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array(3).fill(`${API}/repos/calltelemetry/central-policy/pulls/42`));
      expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'GET', redirect: 'error',
        headers: { Accept: 'application/vnd.github.v3.diff', Authorization: `Bearer ${TOKEN}` } });
      expect(wire.body.locked).toBe(false);
    });

    it.each(['before', 'after'] as const)('discards evidence for a %s-read head/base/closed race', async (stage) => {
      for (const change of [
        { head: { sha: 'd'.repeat(40) } }, { base: { sha: 'e'.repeat(40), repo: repositoryBody() } }, { state: 'closed' },
      ]) {
        const changed = jsonResponse(pullBody({ changed_files: 1, ...change }));
        const f = stage === 'before' ? fixture(changed) : fixture(before(), new Response(diff), changed);
        const source = await f.reader.exactCurrentDiff(request);
        expect(source.diff).toBe(''); expect(source.expectedFileCount).toBeUndefined();
        expect(f.fetcher).toHaveBeenCalledTimes(stage === 'before' ? 1 : 3);
      }
    });

    it.each(['before', 'after'] as const)('rejects a wrong numeric repository on the %s read', async (stage) => {
      const wrong = jsonResponse(pullBody({ base: { sha: BASE, repo: repositoryBody({ id: 999 }) } }));
      const f = stage === 'before' ? fixture(wrong) : fixture(before(), new Response(diff), wrong);
      await expect(f.reader.exactCurrentDiff(request)).rejects.toThrow(/repository identity mismatch/u);
    });

    it.each([[undefined, 1], [1, undefined], [1, 2], [undefined, undefined]])(
      'does not claim a file count for missing/unstable metadata %s/%s', async (first, last) => {
        const f = fixture(jsonResponse(pullBody({ changed_files: first })), new Response(diff), jsonResponse(pullBody({ changed_files: last })));
        const source = await f.reader.exactCurrentDiff(request);
        expect(source.diff).toBe(diff); expect(source).not.toHaveProperty('expectedFileCount');
      },
    );

    it.each([-1, 1.5, '1', null])('rejects malformed GitHub changed_files=%s', async (changed_files) => {
      const f = fixture(jsonResponse(pullBody({ changed_files })));
      await expect(f.reader.exactCurrentDiff(request)).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledOnce();
    });

    it.each([{ headSha: 'main' }, { baseSha: 'B'.repeat(40) }, { prNumber: 0 }, { token: TOKEN }])(
      'rejects invalid or extra requested diff coordinates before I/O %j', async (change) => {
        const f = fixture(); await expect(f.reader.exactCurrentDiff({ ...request, ...change })).rejects.toThrow();
        expect(f.fetcher).not.toHaveBeenCalled();
      },
    );

    it('accepts exactly the 2 MB UTF-8 limit without truncating', async () => {
      const exact = diff + ' '.repeat(MAX_AUTHORITATIVE_DIFF_BYTES - Buffer.byteLength(diff));
      const f = fixture(before(), streamed(Buffer.from(exact)).response, before());
      expect((await f.reader.exactCurrentDiff(request)).diff).toBe(exact);
    });

    it('stops an oversized multibyte stream and never performs the final metadata read', async () => {
      const wire = streamed(Buffer.from('é'.repeat(MAX_AUTHORITATIVE_DIFF_BYTES)), 50_000);
      const f = fixture(before(), wire.response, before());
      expectRedacted(await rejected(f.reader.exactCurrentDiff(request)));
      expect(wire.bytesRead()).toBe(MAX_AUTHORITATIVE_DIFF_BYTES + 50_000);
      expect(wire.cancel).toHaveBeenCalledOnce(); expect(wire.body.locked).toBe(false);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([206, 302, 403, 500])('rejects partial/error diff HTTP %i without reading further', async (status) => {
      const f = fixture(before(), new Response(`${PRIVATE_BODY} ${TOKEN}`, { status }));
      expectRedacted(await rejected(f.reader.exactCurrentDiff(request))); expect(f.fetcher).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid UTF-8 in diff bytes without leaking response data', async () => {
      const f = fixture(before(), new Response(new Uint8Array([0xff])));
      expectRedacted(await rejected(f.reader.exactCurrentDiff(request))); expect(f.fetcher).toHaveBeenCalledTimes(2);
    });

    it.each(['fetch', 'body'] as const)('bounds an uncooperative diff %s and prevents later reads', async (stage) => {
      const f = fixture(before()); let finish: (() => void) | undefined;
      const cancel = vi.fn();
      if (stage === 'fetch') f.fetcher.mockImplementationOnce(() =>
        new Promise<Response>((resolve) => { finish = () => resolve(new Response(diff)); }));
      else f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
      const pending = rejected(f.reader.exactCurrentDiff(request));
      await vi.advanceTimersByTimeAsync(250); expectRedacted(await pending);
      expect(f.fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
      if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
      finish?.(); await vi.advanceTimersByTimeAsync(0); expect(f.fetcher).toHaveBeenCalledTimes(2);
    });

    it('honors the whole-operation abort while a diff body is stalled', async () => {
      const abort = new AbortController(); const cancel = vi.fn();
      const f = fixture(before(), new Response(new ReadableStream<Uint8Array>({ cancel })));
      const pending = rejected(f.reader.exactCurrentDiff(request, abort.signal));
      await vi.advanceTimersByTimeAsync(1); abort.abort();
      expectRedacted(await pending); expect(cancel).toHaveBeenCalledOnce();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    });

    it('does no network I/O with an already-aborted operation signal', async () => {
      const f = fixture(); const abort = new AbortController(); abort.abort();
      await expect(f.reader.exactCurrentDiff(request, abort.signal)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    });
  });

  describe('service-configured policy provenance', () => {
    it('resolves the configured ref once, then fetches the exact SHA and verifies the Git blob and content digest', async () => {
      const trustedRef = 'refs/heads/service-policy';
      const bytes = Buffer.from('{"title":"café ☃"}\n');
      const { reader, fetcher } = fixture(
        jsonResponse(repositoryBody()), jsonResponse({ sha: REVISION }),
        jsonResponse(repositoryBody()), jsonResponse(fileBody(bytes)),
      );
      const resolved = await reader.resolvePolicyRevision(TARGET, trustedRef);
      expect(resolved).toBe(REVISION);
      await expect(reader.immutablePolicyFile(TARGET, resolved, FILE_PATH)).resolves.toEqual({
        content: bytes.toString('utf8'),
        source: {
          repositoryId: TARGET.repositoryId, repository: 'calltelemetry/central-policy', sha: REVISION,
          path: FILE_PATH, contentDigest: createHash('sha256').update(bytes).digest('hex'),
        },
      });
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        `${API}/repos/calltelemetry/central-policy`,
        `${API}/repos/calltelemetry/central-policy/commits/refs%2Fheads%2Fservice-policy`,
        `${API}/repos/calltelemetry/central-policy`,
        `${API}/repos/calltelemetry/central-policy/contents/policy/review.json?ref=${REVISION}`,
      ]);
      for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    });

    it('encodes reserved characters in configured refs and file path segments', async () => {
      const path = 'policy/café #?%.json';
      const { reader, fetcher } = fixture(
        jsonResponse(repositoryBody()), jsonResponse({ sha: REVISION }),
        jsonResponse(repositoryBody()), jsonResponse(fileBody(undefined, { path })),
      );
      await reader.resolvePolicyRevision(TARGET, 'service/topic#?ref=other');
      await reader.immutablePolicyFile(TARGET, REVISION, path);
      expect(fetcher.mock.calls[1][0]).toBe(`${API}/repos/calltelemetry/central-policy/commits/service%2Ftopic%23%3Fref%3Dother`);
      expect(fetcher.mock.calls[3][0]).toBe(`${API}/repos/calltelemetry/central-policy/contents/policy/caf%C3%A9%20%23%3F%25.json?ref=${REVISION}`);
    });

    it.each(['', 'x'.repeat(257), 'ref\nother', 'ref\0other', 'ref\u007f'])(
      'rejects invalid configured ref %j before network reads', async (ref) => {
        const { reader, fetcher } = fixture();
        await expect(reader.resolvePolicyRevision(TARGET, ref)).rejects.toThrow(/policy reference invalid/u);
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it.each(['main', 'v1', 'A'.repeat(40), 'a'.repeat(39)])('rejects a mutable/invalid immutable file revision %s', async (revision) => {
      const { reader, fetcher } = fixture();
      await expect(reader.immutablePolicyFile(TARGET, revision, FILE_PATH)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(['', '/policy.json', '../policy.json', './policy.json', 'policy/../file', 'policy//file', 'policy/', 'policy\\file', 'policy/\0file', 'policy/\u007ffile', 'x'.repeat(513)])(
      'rejects unsafe file path %j before network reads', async (path) => {
        const { reader, fetcher } = fixture();
        await expect(reader.immutablePolicyFile(TARGET, REVISION, path)).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it.each(['ref', 'file'] as const)('verifies repository identity before reading a %s', async (operation) => {
      for (const badRepository of [repositoryBody({ id: 999 }), repositoryBody({ full_name: 'elsewhere/repo' })]) {
        const { reader, fetcher } = fixture(jsonResponse(badRepository));
        const pending = operation === 'ref' ? reader.resolvePolicyRevision(TARGET, 'main') : reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH);
        await expect(pending).rejects.toThrow(/repository identity mismatch/u);
        expect(fetcher).toHaveBeenCalledOnce();
      }
    });

    it.each([{ sha: 'main' }, { sha: 'C'.repeat(40) }, {}])('rejects invalid resolved commit identity %j', async (commit) => {
      const { reader, fetcher } = fixture(jsonResponse(repositoryBody()), jsonResponse(commit));
      await expect(reader.resolvePolicyRevision(TARGET, 'main')).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([
      { type: 'dir' }, { type: 'symlink' }, { encoding: 'utf-8' }, { path: 'policy/another.json' },
      { sha: 'd'.repeat(40) }, { sha: 'not-a-blob-sha' }, { size: -1 }, { size: 0.5 }, { size: MAX_FILE_BYTES + 1 },
      { size: 1 }, { content: '!!!!' }, { content: 'YWJjZA' },
    ])('rejects an independently invalid immutable file field %j', async (change) => {
      const { reader, fetcher } = fixture(jsonResponse(repositoryBody()), jsonResponse(fileBody(undefined, change)));
      await expect(reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('rejects noncanonical base64 even when decoded size and blob SHA match', async () => {
      const bytes = Buffer.from('f');
      // Zh== decodes to f, but the unused pad bits make it noncanonical (Zg==).
      const { reader } = fixture(jsonResponse(repositoryBody()), jsonResponse(fileBody(bytes, { content: 'Zh==' })));
      await expect(reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH)).rejects.toThrow(/immutable file identity mismatch/u);
    });

    it('accepts GitHub base64 line wrapping and hashes decoded bytes', async () => {
      const bytes = Buffer.from('line-wrapped policy café\n'.repeat(12));
      const content = bytes.toString('base64').match(/.{1,60}/gu)!.join('\r\n') + '\n';
      const { reader } = fixture(jsonResponse(repositoryBody()), jsonResponse(fileBody(bytes, { content })));
      await expect(reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH)).resolves.toMatchObject({ content: bytes.toString('utf8') });
    });

    it('rejects invalid UTF-8 with otherwise exact blob SHA, base64 and size', async () => {
      const bytes = Buffer.from([0xc3, 0x28]);
      const { reader } = fixture(jsonResponse(repositoryBody()), jsonResponse(fileBody(bytes)));
      const error = await rejected(reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH));
      expect(error.message).toMatch(/encoded data|UTF-8|unavailable/u);
      expectRedacted(error);
    });

    it.each([0, MAX_FILE_BYTES])('accepts file size boundary %s', async (size) => {
      const bytes = Buffer.alloc(size, 0x61);
      const { reader } = fixture(jsonResponse(repositoryBody()), jsonResponse(fileBody(bytes)));
      await expect(reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH)).resolves.toMatchObject({ content: bytes.toString('utf8') });
    });
  });

  describe('transport bounds, redaction and cleanup', () => {
    it.each([301, 401, 403, 404, 429, 500])('rejects HTTP %s without retries or leaking the response', async (status) => {
      const { reader, fetcher } = fixture(new Response(`${PRIVATE_BODY} ${TOKEN}`, { status, headers: { Location: 'https://other.example.invalid' } }));
      const error = await rejected(reader.currentCandidate(PR));
      expect(error.message).toBe('Review reader request unavailable');
      expectRedacted(error);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('redacts thrown transport details and never retries', async () => {
      const { reader, fetcher } = fixture();
      fetcher.mockRejectedValue(new Error(`${PRIVATE_BODY} token=${TOKEN}`));
      const error = await rejected(reader.currentCandidate(PR));
      expect(error.message).toBe('Review reader request unavailable');
      expectRedacted(error);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([
      () => new Response(null, { status: 204 }),
      () => new Response(`${PRIVATE_BODY} ${TOKEN} not JSON`),
      () => new Response(new Uint8Array([0xff, 0xfe])),
    ])('rejects empty, malformed JSON or malformed UTF-8 responses without exposing data', async (makeResponse) => {
      const { reader, fetcher } = fixture(makeResponse());
      const error = await rejected(reader.currentCandidate(PR));
      expect(error.message).toBe('Review reader request unavailable');
      expectRedacted(error);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each(['candidate', 'file'] as const)('does not leak server strings from %s schema validation errors', async (operation) => {
      const { reader } = operation === 'candidate'
        ? fixture(jsonResponse(pullBody({ state: `${PRIVATE_BODY} ${TOKEN}` })))
        : fixture(jsonResponse(repositoryBody()), jsonResponse(fileBody(undefined, { encoding: `${PRIVATE_BODY} ${TOKEN}` })));
      const error = await rejected(operation === 'candidate' ? reader.currentCandidate(PR) : reader.immutablePolicyFile(TARGET, REVISION, FILE_PATH));
      expectRedacted(error);
    });

    it('decodes JSON when a multibyte UTF-8 character is split between stream chunks', async () => {
      const wire = streamed(Buffer.from(JSON.stringify({ ...pullBody(), ignored: 'café ☃' })), 1);
      const { reader } = fixture(wire.response);
      await expect(reader.currentCandidate(PR)).resolves.toMatchObject({ headSha: HEAD, baseSha: BASE });
      expect(wire.body.locked).toBe(false);
    });

    it('accepts a response of exactly 512 KiB', async () => {
      const json = JSON.stringify(pullBody());
      const bytes = Buffer.from(json + ' '.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(json)));
      const wire = streamed(bytes);
      const { reader } = fixture(wire.response);
      await expect(reader.currentCandidate(PR)).resolves.toMatchObject({ headSha: HEAD });
      expect(wire.bytesRead()).toBe(MAX_RESPONSE_BYTES);
      expect(wire.body.locked).toBe(false);
    });

    it('cancels an oversized stream without buffering the remaining body', async () => {
      const wire = streamed(Buffer.alloc(MAX_RESPONSE_BYTES * 3, 0x61));
      const { reader, fetcher } = fixture(wire.response);
      const error = await rejected(reader.currentCandidate(PR));
      expect(error.message).toBe('Review reader request unavailable');
      expect(wire.bytesRead()).toBe(MAX_RESPONSE_BYTES + 64 * 1024);
      expect(wire.cancel).toHaveBeenCalledOnce();
      expect(wire.body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('redacts a stream read failure and releases the body lock', async () => {
      const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(`${PRIVATE_BODY} ${TOKEN}`)); } });
      const { reader, fetcher } = fixture(new Response(body));
      const error = await rejected(reader.currentCandidate(PR));
      expectRedacted(error);
      expect(body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('bounds a hung fetch even if the fetcher ignores abort', async () => {
      const { reader, fetcher } = fixture();
      let finishFetch!: (response: Response) => void;
      fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFetch = resolve; }));
      const result = rejected(reader.currentCandidate(PR));
      await vi.advanceTimersByTimeAsync(249);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error.message).toBe('Review reader request unavailable');
      expectRedacted(error);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      finishFetch(jsonResponse(pullBody()));
      await vi.advanceTimersByTimeAsync(0);
    });

    it('bounds and cancels a hung response body even if it ignores abort', async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
      const { reader, fetcher } = fixture(new Response(body));
      const result = rejected(reader.currentCandidate(PR));
      try {
        await vi.advanceTimersByTimeAsync(249);
        expect(body.locked).toBe(true);
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const error = await result;
        expect(error.message).toBe('Review reader request unavailable');
        expectRedacted(error);
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
      } finally {
        // A regression must not leave our synthetic stream pending after the test.
        if (!cancel.mock.calls.length) controller.close();
        await vi.advanceTimersByTimeAsync(0);
      }
    });
  });
});
