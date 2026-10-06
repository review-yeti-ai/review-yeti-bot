import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as appAuth from '../../src/github/appAuth';
import { getBoundedRepositoryToken, MAX_APP_TOKEN_RESPONSE_BYTES } from '../../src/github/boundedAppToken';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const config = { appId: '4385771', privateKey, owner: 'exampleorg', repo: 'example-meta', baseUrl: 'https://api.example.invalid/api/v3' };
const lookupUrl = `${config.baseUrl}/repos/exampleorg/example-meta/installation`;
const tokenUrl = `${config.baseUrl}/app/installations/987/access_tokens`;
const marker = 'SYNTHETIC_PRIVATE_TOKEN_DIAGNOSTIC';
const token = 'ghs_modern-header.payload_segment.signature-with-dash';
const expiresAt = '2099-01-01T00:00:00.000Z';
const failureMessage = 'Repository App token is unavailable';

type Mode = 'read' | 'publish' | 'merge-group' | 'review-threads';
function tokenBody(mode: Mode = 'read') {
  return { token, expires_at: expiresAt, permissions: mode === 'read'
    ? { contents: 'read', pull_requests: 'read', metadata: 'read' }
    : mode === 'publish' ? { checks: 'write', metadata: 'read' }
      : mode === 'review-threads' ? { pull_requests: 'write', metadata: 'read' }
        : { checks: 'write', contents: 'read', pull_requests: 'read', merge_queues: 'read', metadata: 'read' } };
}

function fetchStub(mode: Mode = 'read') {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify(String(input).endsWith('/installation') ? { id: 987 } : tokenBody(mode)), { status: 200 }));
}

function wire(bytes: Uint8Array, close = true) {
  let sent = false;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!sent) { sent = true; controller.enqueue(bytes); }
    else if (close) controller.close();
  });
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  return { response: new Response(body), cancel, pull };
}

async function redacted(pending: Promise<unknown>) {
  const error = await pending.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(failureMessage);
  expect((error as Error).cause).toBeUndefined();
  const text = `${(error as Error).stack}\n${JSON.stringify(error)}`;
  expect(text).not.toContain(marker);
  expect(text).not.toContain(privateKey);
  expect(text).not.toContain(token);
}

async function transient(pending: Promise<unknown>, kind: string) {
  const error = await pending.then(() => undefined, (reason: unknown) => reason);
  expect(error).toMatchObject({ name: 'TransientAuthoritativeReadError', kind,
    message: 'Authoritative source read is temporarily unavailable' });
  expect((error as Error).cause).toBeUndefined();
  const text = `${(error as Error).stack}\n${JSON.stringify(error)}`;
  expect(text).not.toContain(marker);
  expect(text).not.toContain(privateKey);
  expect(text).not.toContain(token);
}

describe('getBoundedRepositoryToken', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it.each(['read', 'publish', 'merge-group', 'review-threads'] as const)('reuses actual %s minter with exact repo grants and bounded HTTPS requests', async (mode) => {
    const fetchImplementation = fetchStub(mode);
    const before = { ...config };
    const result = await getBoundedRepositoryToken(Object.freeze({ ...config }), mode, { fetchImplementation });
    expect(result).toEqual({ token, expiresAt, permissions: tokenBody(mode).permissions });
    expect(config).toEqual(before);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([lookupUrl, tokenUrl]);
    for (const [url, init] of fetchImplementation.mock.calls) {
      expect(String(url)).not.toContain(token);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(true);
      const bearer = new Headers(init?.headers).get('authorization')!;
      expect(bearer).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
      expect(JSON.parse(Buffer.from(bearer.slice(7).split('.')[1], 'base64url').toString()).iss).toBe(config.appId);
    }
    expect(fetchImplementation.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImplementation.mock.calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body))).toEqual({ repositories: [config.repo],
      permissions: mode === 'read' ? { contents: 'read', pull_requests: 'read' }
        : mode === 'publish' ? { checks: 'write' }
          : mode === 'review-threads' ? { pull_requests: 'write' }
            : { checks: 'write', contents: 'read', pull_requests: 'read', merge_queues: 'read' } });
  });

  it('refuses a review-thread token broader than pull_requests: write (ADR 0002)', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      new Response(JSON.stringify(String(input).endsWith('/installation') ? { id: 987 }
        : { token, expires_at: expiresAt, permissions: { pull_requests: 'write', contents: 'write', metadata: 'read' } }), { status: 200 }));
    await redacted(getBoundedRepositoryToken({ ...config }, 'review-threads', { fetchImplementation }));
  });

  it('retains the explicit standard GitHub default without caching across calls', async () => {
    const fetchImplementation = fetchStub();
    for (let attempt = 0; attempt < 2; attempt++) {
      await getBoundedRepositoryToken({ ...config, baseUrl: undefined }, 'read', { fetchImplementation });
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(fetchImplementation.mock.calls[0][0]).toBe('https://api.github.com/repos/exampleorg/example-meta/installation');
  });

  it.each(['', 'http://api.example.invalid', `https://user:${marker}@api.example.invalid`,
    `https://${marker}@api.example.invalid`, `${config.baseUrl}?`, `${config.baseUrl}?token=${marker}`,
    `${config.baseUrl}#`, ' https://api.example.invalid', 'https://api.example.invalid/\nv3'])
  ('rejects unsafe configured API base %j before minting', async (baseUrl) => {
    const fetchImplementation = fetchStub();
    await redacted(getBoundedRepositoryToken({ ...config, baseUrl }, 'read', { fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([{ owner: '.' }, { repo: '..' }, { owner: 'x/y' }, { repo: 'x?key' }, { appId: '0' },
    { appId: '1e3' }, { appId: '9007199254740992' }])
  ('rejects invalid signing/repository config %j without transport', async (override) => {
    const fetchImplementation = fetchStub();
    await redacted(getBoundedRepositoryToken({ ...config, ...override }, 'read', { fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([0, -1, 10_001, 1.5, Infinity, NaN])('rejects invalid deadline %s', async (timeoutMs) => {
    const fetchImplementation = fetchStub();
    await redacted(getBoundedRepositoryToken(config, 'read', { timeoutMs, fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['https://other.example.invalid/repos/exampleorg/example-meta/installation', 'GET'],
    [`${config.baseUrl}/repos/another/example-meta/installation`, 'GET'],
    [`${config.baseUrl}/repos/exampleorg/another/installation`, 'GET'],
    [`${lookupUrl}?token=${marker}`, 'GET'], [`${lookupUrl}#fragment`, 'GET'],
    [`${config.baseUrl}/app`, 'GET'], [lookupUrl, 'POST'], [tokenUrl, 'GET'],
    [`${config.baseUrl}/app/installations/0/access_tokens`, 'POST'],
    [`${config.baseUrl}/app/installations/9007199254740992/access_tokens`, 'POST'],
    [`${config.baseUrl}/app/installations/987/access_tokens/other`, 'POST'],
    ['https://api.example.invalid/repos/exampleorg/example-meta/installation', 'GET'],
    [`${config.baseUrl}/repos/exampleorg/../example-meta/installation`, 'GET'],
  ])('refuses a factory request outside exact same-origin API paths: %s %s', async (url, method) => {
    vi.spyOn(appAuth, 'getGitHubAppRepositoryReadToken').mockImplementation(async (_config, fetcher) => {
      await fetcher!(url, { method });
      return { token, expiresAt };
    });
    const fetchImplementation = fetchStub();
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 404])('rejects HTTP %s without reading raw diagnostic bodies', async (status) => {
    const body = wire(Buffer.from(marker), false);
    const fetchImplementation = vi.fn(async () => new Response(body.response.body, { status }));
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(body.pull).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it.each([500, 502, 503, 504])('preserves a redacted retryable-server classification for HTTP %s', async (status) => {
    const fetchImplementation = vi.fn(async () => new Response(marker, { status }));
    const error = await getBoundedRepositoryToken(config, 'read', { fetchImplementation })
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'TransientAuthoritativeReadError', kind: 'retryable_server' });
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();
    expect(`${(error as Error).stack}\n${JSON.stringify(error)}`).not.toContain(marker);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('preserves explicit rate-limit evidence while a bare forbidden response remains final', async () => {
    const rateLimited = vi.fn(async () => new Response(marker, {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' },
    }));
    const error = await getBoundedRepositoryToken(config, 'read', { fetchImplementation: rateLimited })
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'TransientAuthoritativeReadError', kind: 'rate_limit' });
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();

    const forbidden = vi.fn(async () => new Response(marker, { status: 403 }));
    await expect(getBoundedRepositoryToken(config, 'read', { fetchImplementation: forbidden }))
      .rejects.toMatchObject({ name: 'InternalGitHubDependencyUnavailableError' });
    expect(forbidden).toHaveBeenCalledOnce();
  });

  it.each([401, 403])('labels internal App-token HTTP %s as a typed dependency authorization outage', async (status) => {
    const body = wire(Buffer.from(marker), false);
    const fetchImplementation = vi.fn(async () => new Response(body.response.body, { status }));
    const error = await getBoundedRepositoryToken(config, 'read', { fetchImplementation })
      .then(() => undefined, (reason: unknown) => reason);

    expect(error).toMatchObject({ name: 'InternalGitHubDependencyUnavailableError' });
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();
    expect(body.pull).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it('classifies an absent service-owned App key as unavailable before any request', async () => {
    const fetchImplementation = fetchStub();
    const error = await getBoundedRepositoryToken({ ...config, privateKey: '' }, 'read', { fetchImplementation })
      .then(() => undefined, (reason: unknown) => reason);

    expect(error).toMatchObject({ name: 'InternalGitHubDependencyUnavailableError',
      message: 'Internal GitHub authority dependency is unavailable' });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect((error as Error).stack).not.toContain(privateKey);
  });

  it('rejects malformed static App identity even when the private key is absent', async () => {
    const fetchImplementation = fetchStub();
    await redacted(getBoundedRepositoryToken({ ...config, appId: 'not-an-app-id', privateKey: '' }, 'read',
      { fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('classifies only the App signing failure for a malformed-present service key', async () => {
    const fetchImplementation = fetchStub();
    const error = await getBoundedRepositoryToken({ ...config, privateKey: 'malformed-present-private-key' }, 'read',
      { fetchImplementation }).then(() => undefined, (reason: unknown) => reason);

    expect(error).toMatchObject({ name: 'InternalGitHubDependencyUnavailableError',
      message: 'Internal GitHub authority dependency is unavailable' });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect((error as Error).message).not.toContain('malformed-present-private-key');
    expect((error as Error).cause).toBeUndefined();
  });

  it('classifies a fetch rejection as network failure without retaining its cause', async () => {
    const fetchImplementation = vi.fn(async () => { throw new Error(marker); });
    const error = await getBoundedRepositoryToken(config, 'read', { fetchImplementation })
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'TransientAuthoritativeReadError', kind: 'network' });
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();
    expect(`${(error as Error).stack}\n${JSON.stringify(error)}`).not.toContain(marker);
  });

  it('does not classify a successful response with malformed token JSON as transient', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => new Response(
      String(input).endsWith('/installation') ? JSON.stringify({ id: 987 }) : marker, { status: 200 }));
    const error = await getBoundedRepositoryToken(config, 'read', { fetchImplementation })
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ name: 'TransientAuthoritativeReadError' });
    expect((error as Error).cause).toBeUndefined();
  });

  it('classifies a response-stream read rejection as network failure', async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(marker)); } });
    const fetchImplementation = vi.fn(async () => new Response(body, { status: 200 }));
    await transient(getBoundedRepositoryToken(config, 'read', { fetchImplementation }), 'network');
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('rejects a fetch implementation that followed a redirect', async () => {
    const body = wire(Buffer.from('{"id":987}'), false);
    Object.defineProperty(body.response, 'redirected', { value: true });
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation: vi.fn(async () => body.response) }));
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.pull).not.toHaveBeenCalled();
  });

  it.each(['lookup', 'token'])('allows exactly 64 KiB for the %s response without using remote json()', async (stage) => {
    const json = JSON.stringify(stage === 'lookup' ? { id: 987 } : tokenBody());
    const response = new Response(json + ' '.repeat(MAX_APP_TOKEN_RESPONSE_BYTES - Buffer.byteLength(json)));
    const remoteJson = vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const fetchImplementation = fetchStub();
    if (stage === 'lookup') fetchImplementation.mockResolvedValueOnce(response);
    else fetchImplementation.mockResolvedValueOnce(new Response('{"id":987}')).mockResolvedValueOnce(response);
    expect((await getBoundedRepositoryToken(config, 'read', { fetchImplementation })).token).toBe(token);
    expect(remoteJson).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });

  it.each(['lookup', 'token'])('rejects 64 KiB plus one byte for the %s response and cancels it', async (stage) => {
    const json = JSON.stringify(stage === 'lookup' ? { id: 987 } : tokenBody());
    const body = wire(Buffer.from(json + ' '.repeat(MAX_APP_TOKEN_RESPONSE_BYTES - Buffer.byteLength(json) + 1)), false);
    body.response.headers.set('content-length', '1');
    const fetchImplementation = fetchStub();
    if (stage === 'lookup') fetchImplementation.mockResolvedValueOnce(body.response);
    else fetchImplementation.mockResolvedValueOnce(new Response('{"id":987}')).mockResolvedValueOnce(body.response);
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.response.body?.locked).toBe(false);
    expect(fetchImplementation).toHaveBeenCalledTimes(stage === 'lookup' ? 1 : 2);
  });

  it('bounds UTF-8 bytes and rejects malformed UTF-8 without exposing data', async () => {
    for (const bytes of [Buffer.from('é'.repeat(MAX_APP_TOKEN_RESPONSE_BYTES / 2 + 1)), Buffer.from([0xff])]) {
      await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation: vi.fn(async () => new Response(bytes)) }));
    }
  });

  it('counts response bytes across chunks, not just the largest individual chunk', async () => {
    const json = JSON.stringify({ id: 987 });
    const chunks = [Buffer.from(json), Buffer.alloc(MAX_APP_TOKEN_RESPONSE_BYTES - Buffer.byteLength(json), 32), Buffer.from(' ')];
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); }, cancel,
    }, { highWaterMark: 0 });
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation: vi.fn(async () => new Response(stream)) }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('redacts response-body failures and releases the reader', async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const response = { ok: true, status: 200, redirected: false, body: { getReader: () => ({
      read: async () => { throw new Error(marker); }, cancel, releaseLock,
    }) } } as unknown as Response;
    await transient(getBoundedRepositoryToken(config, 'read', { fetchImplementation: vi.fn(async () => response) }), 'network');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it.each(['', '{}', '[]', 'null', marker, '{"id":0}', '{"id":-1}'])('redacts invalid installation responses %j', async (text) => {
    const fetchImplementation = vi.fn(async () => new Response(text));
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each(['read', 'publish'] as const)('preserves existing %s token expiry/permission checks and tightens bearer syntax', async (mode) => {
    for (const override of [{ token: 'ghs_' }, { token: 'ghs_test\n' }, { token: 'ghp_wrong' },
      { expires_at: '2000-01-01T00:00:00Z' }, { permissions: { contents: 'write' } }, { permissions: {} }]) {
      const fetchImplementation = fetchStub(mode).mockResolvedValueOnce(new Response('{"id":987}'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...tokenBody(mode), ...override })));
      await redacted(getBoundedRepositoryToken(config, mode, { fetchImplementation }));
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    }
  });

  it('redacts transport exceptions and never retries', async () => {
    const fetchImplementation = vi.fn(async () => { throw new Error(marker); });
    await transient(getBoundedRepositoryToken(config, 'read', { fetchImplementation }), 'network');
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([undefined, 1, 250, 10_000])('bounds an uncooperative whole factory at timeout %s', async (timeoutMs) => {
    const factory = vi.spyOn(appAuth, 'getGitHubAppRepositoryReadToken').mockImplementation(() => new Promise(() => {}));
    const fetchImplementation = fetchStub();
    let settled = false;
    const failure = transient(getBoundedRepositoryToken(config, 'read', { timeoutMs, fetchImplementation }), 'deadline').then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync((timeoutMs ?? 10_000) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(factory).toHaveBeenCalledOnce();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('aborts uncooperative fetch and cancels its late response without a second request', async () => {
    let finish!: (response: Response) => void;
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    const failure = transient(getBoundedRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation }), 'deadline');
    await vi.advanceTimersByTimeAsync(250);
    await failure;
    expect(fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const late = wire(Buffer.from('{"id":987}'), false);
    finish(late.response);
    await Promise.resolve();
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.pull).not.toHaveBeenCalled();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('shares the deadline across lookup and an unfinished token response body', async () => {
    let finish!: (response: Response) => void;
    const body = wire(Buffer.from(JSON.stringify(tokenBody())), false);
    const fetchImplementation = fetchStub().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(body.response);
    const failure = transient(getBoundedRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation }), 'deadline');
    await vi.advanceTimersByTimeAsync(200);
    finish(new Response('{"id":987}'));
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(body.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.response.body?.locked).toBe(false);
  });

  it.each(['hang', 'throw', 'reject'])('bounds uncooperative body read/cancel when cancellation may %s', async (behavior) => {
    const cancel = vi.fn((): Promise<void> => {
      if (behavior === 'throw') throw new Error(marker);
      return behavior === 'hang' ? new Promise(() => {}) : Promise.reject(new Error(marker));
    });
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
    const releaseLock = vi.fn();
    const response = { ok: true, status: 200, redirected: false, body: { getReader: () => ({ read, cancel, releaseLock }) } } as unknown as Response;
    const failure = transient(getBoundedRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation: vi.fn(async () => response) }), 'deadline');
    await vi.advanceTimersByTimeAsync(250);
    await failure;
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('honors caller cancellation before minting and while fetch is uncooperative, without retaining its reason', async () => {
    const parent = new AbortController();
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    const removed = vi.spyOn(parent.signal, 'removeEventListener');
    const failure = redacted(getBoundedRepositoryToken(config, 'read', { signal: parent.signal, fetchImplementation }));
    parent.abort(new Error(marker));
    await failure;
    expect(fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    fetchImplementation.mockClear();
    await redacted(getBoundedRepositoryToken(config, 'read', { signal: parent.signal, fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
