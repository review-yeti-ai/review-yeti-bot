import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as appAuth from '../../src/github/appAuth';
import { getBoundedRepositoryToken, MAX_APP_TOKEN_RESPONSE_BYTES } from '../../src/github/boundedAppToken';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const config = { appId: '4385771', privateKey, owner: 'calltelemetry', repo: 'ct-meta', baseUrl: 'https://api.example.invalid/api/v3' };
const lookupUrl = `${config.baseUrl}/repos/calltelemetry/ct-meta/installation`;
const tokenUrl = `${config.baseUrl}/app/installations/987/access_tokens`;
const marker = 'SYNTHETIC_PRIVATE_TOKEN_DIAGNOSTIC';
const token = 'ghs_test';
const expiresAt = '2099-01-01T00:00:00.000Z';
const failureMessage = 'Repository App token is unavailable';

function tokenBody(mode: 'read' | 'publish' = 'read') {
  return { token, expires_at: expiresAt, permissions: mode === 'read'
    ? { contents: 'read', pull_requests: 'read', metadata: 'read' }
    : { checks: 'write', metadata: 'read' } };
}

function fetchStub(mode: 'read' | 'publish' = 'read') {
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

describe('getBoundedRepositoryToken', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it.each(['read', 'publish'] as const)('reuses actual %s minter with exact repo grants and bounded HTTPS requests', async (mode) => {
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
      permissions: mode === 'read' ? { contents: 'read', pull_requests: 'read' } : { checks: 'write' } });
  });

  it('retains the explicit standard GitHub default without caching across calls', async () => {
    const fetchImplementation = fetchStub();
    for (let attempt = 0; attempt < 2; attempt++) {
      await getBoundedRepositoryToken({ ...config, baseUrl: undefined }, 'read', { fetchImplementation });
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(fetchImplementation.mock.calls[0][0]).toBe('https://api.github.com/repos/calltelemetry/ct-meta/installation');
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
    { appId: '1e3' }, { appId: '9007199254740992' }, { privateKey: marker }])
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
    ['https://other.example.invalid/repos/calltelemetry/ct-meta/installation', 'GET'],
    [`${config.baseUrl}/repos/another/ct-meta/installation`, 'GET'],
    [`${config.baseUrl}/repos/calltelemetry/another/installation`, 'GET'],
    [`${lookupUrl}?token=${marker}`, 'GET'], [`${lookupUrl}#fragment`, 'GET'],
    [`${config.baseUrl}/app`, 'GET'], [lookupUrl, 'POST'], [tokenUrl, 'GET'],
    [`${config.baseUrl}/app/installations/0/access_tokens`, 'POST'],
    [`${config.baseUrl}/app/installations/9007199254740992/access_tokens`, 'POST'],
    [`${config.baseUrl}/app/installations/987/access_tokens/other`, 'POST'],
    ['https://api.example.invalid/repos/calltelemetry/ct-meta/installation', 'GET'],
    [`${config.baseUrl}/repos/calltelemetry/../ct-meta/installation`, 'GET'],
  ])('refuses a factory request outside exact same-origin API paths: %s %s', async (url, method) => {
    vi.spyOn(appAuth, 'getGitHubAppRepositoryReadToken').mockImplementation(async (_config, fetcher) => {
      await fetcher!(url, { method });
      return { token, expiresAt };
    });
    const fetchImplementation = fetchStub();
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 401, 403, 404, 429, 500])('rejects HTTP %s without reading raw diagnostic bodies', async (status) => {
    const body = wire(Buffer.from(marker), false);
    const fetchImplementation = vi.fn(async () => new Response(body.response.body, { status }));
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(body.pull).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
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
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation: vi.fn(async () => response) }));
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
    await redacted(getBoundedRepositoryToken(config, 'read', { fetchImplementation }));
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([undefined, 1, 250, 10_000])('bounds an uncooperative whole factory at timeout %s', async (timeoutMs) => {
    const factory = vi.spyOn(appAuth, 'getGitHubAppRepositoryReadToken').mockImplementation(() => new Promise(() => {}));
    const fetchImplementation = fetchStub();
    let settled = false;
    const failure = redacted(getBoundedRepositoryToken(config, 'read', { timeoutMs, fetchImplementation })).then(() => { settled = true; });
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
    const failure = redacted(getBoundedRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation }));
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
    const failure = redacted(getBoundedRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation }));
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
    const failure = redacted(getBoundedRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation: vi.fn(async () => response) }));
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
