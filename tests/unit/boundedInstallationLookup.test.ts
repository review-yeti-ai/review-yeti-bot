import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as appAuth from '../../src/github/appAuth';
import { getBoundedRepositoryInstallationId, MAX_APP_TOKEN_RESPONSE_BYTES, validateGitHubAppApiBaseUrl } from '../../src/github/boundedAppToken';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const config = { appId: '4385771', privateKey, owner: 'calltelemetry', repo: 'ct-meta', baseUrl: 'https://api.example.invalid/api/v3' };
const lookupUrl = `${config.baseUrl}/repos/calltelemetry/ct-meta/installation`;
const marker = 'SYNTHETIC_PRIVATE_LOOKUP_DIAGNOSTIC';

async function redacted(pending: Promise<unknown>) {
  const error = await pending.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('Repository App installation is unavailable');
  expect((error as Error).cause).toBeUndefined();
  expect((error as Error).stack).not.toContain(marker);
  expect((error as Error).stack).not.toContain(privateKey);
}

describe('bounded repository installation lookup', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it.each([undefined, `${config.baseUrl}/`])('uses one signed, exact repository GET with API base %s and never mints a token', async (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":987}'));
    await expect(getBoundedRepositoryInstallationId(Object.freeze({ ...config, baseUrl }), { fetchImplementation: fetcher })).resolves.toBe(987);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${baseUrl ? config.baseUrl : 'https://api.github.com'}/repos/calltelemetry/ct-meta/installation`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.body).toBeUndefined();
    expect(init?.signal?.aborted).toBe(true);
    const jwt = new Headers(init?.headers).get('authorization')!.slice(7);
    expect(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).iss).toBe(config.appId);
  });

  it.each(['', 'http://api.example.invalid', `https://user:${marker}@api.example.invalid`,
    `https://${marker}@api.example.invalid`, `${config.baseUrl}?`, `${config.baseUrl}?token=${marker}`,
    `${config.baseUrl}#`, ' https://api.example.invalid', 'https://api.example.invalid/\nv3',
    'https://api.example.invalid\\other', `https://api.example.invalid/${'a'.repeat(2_000)}`])
  ('rejects unsafe API base %j before signing/fetch', async (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => validateGitHubAppApiBaseUrl(baseUrl)).toThrow('GitHub App API base URL must be HTTPS without credentials, query, or fragment');
    await redacted(getBoundedRepositoryInstallationId({ ...config, baseUrl }, { fetchImplementation: fetcher }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ owner: '.' }, { repo: '..' }, { repo: 'another/repo' }, { appId: '0' }, { privateKey: marker }])
  ('rejects invalid config before transport: %j', async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    await redacted(getBoundedRepositoryInstallationId({ ...config, ...override }, { fetchImplementation: fetcher }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, -1, 10_001, NaN, 1.5])('rejects invalid deadline %s', async (timeoutMs) => {
    const fetcher = vi.fn<typeof fetch>();
    await redacted(getBoundedRepositoryInstallationId(config, { timeoutMs, fetchImplementation: fetcher }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['https://other.example.invalid/repos/calltelemetry/ct-meta/installation', 'GET'],
    [`${config.baseUrl}/repos/another/ct-meta/installation`, 'GET'],
    [`${lookupUrl}?token=${marker}`, 'GET'], [lookupUrl, 'POST'],
    [`${config.baseUrl}/app/installations/987/access_tokens`, 'POST'],
  ])('refuses a legacy helper escaping its lookup-only scope: %s %s', async (url, method) => {
    vi.spyOn(appAuth, 'getGitHubAppInstallationIdForRepository').mockImplementation(async (_config, fetcher) => {
      await fetcher!(url, { method });
      return 987;
    });
    const fetcher = vi.fn<typeof fetch>();
    await redacted(getBoundedRepositoryInstallationId(config, { fetchImplementation: fetcher }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308, 401, 403, 404, 429, 500])('cancels HTTP %s without consuming diagnostics or retrying', async (status) => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel, pull }, { highWaterMark: 0 }), { status }));
    await redacted(getBoundedRepositoryInstallationId(config, { fetchImplementation: fetcher }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads exactly 64 KiB locally, never a response-supplied JSON method', async () => {
    const remote = new Response('{"id":987}' + ' '.repeat(MAX_APP_TOKEN_RESPONSE_BYTES - 10));
    const json = vi.spyOn(remote, 'json').mockImplementation(() => new Promise(() => undefined));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(remote);
    await expect(getBoundedRepositoryInstallationId(config, { fetchImplementation: fetcher })).resolves.toBe(987);
    expect(json).not.toHaveBeenCalled();
    expect(remote.body?.locked).toBe(false);
  });

  it.each([Buffer.from('{"id":987}' + ' '.repeat(MAX_APP_TOKEN_RESPONSE_BYTES - 9)),
    Buffer.from(`{"id":987,"ignored":"${'é'.repeat(MAX_APP_TOKEN_RESPONSE_BYTES / 2)}"}`),
    Buffer.from([0xc3, 0x28]), Buffer.from(`{${marker}`), Buffer.from('{"id":0}')])
  ('rejects oversized bytes, malformed UTF-8/JSON, or invalid identity', async (bytes) => {
    const remote = new Response(bytes, { headers: { 'Content-Length': '1' } });
    await redacted(getBoundedRepositoryInstallationId(config, { fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(remote) }));
    expect(remote.body?.locked).toBe(false);
  });

  it.each(['factory', 'fetch', 'body'] as const)('hard-bounds non-cooperative %s and redacts errors', async (stage) => {
    const cancel = vi.fn(() => new Promise(() => undefined));
    const releaseLock = vi.fn();
    const remote = { ok: true, status: 200, body: { getReader: () => ({
      read: () => new Promise(() => undefined), cancel, releaseLock,
    }) } } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => stage === 'body' ? Promise.resolve(remote) : new Promise(() => undefined));
    if (stage === 'factory') vi.spyOn(appAuth, 'getGitHubAppInstallationIdForRepository').mockImplementation(() => new Promise(() => undefined));
    const pending = redacted(getBoundedRepositoryInstallationId(config, { timeoutMs: 250, fetchImplementation: fetcher }));
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(stage === 'factory' ? 0 : 1);
    if (stage === 'body') { expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce(); }
  });

  it('cancels a late fetch without reading it', async () => {
    let deliver!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
    const pending = redacted(getBoundedRepositoryInstallationId(config, { timeoutMs: 250, fetchImplementation: fetcher }));
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    const cancel = vi.fn();
    const pull = vi.fn();
    deliver(new Response(new ReadableStream({ cancel, pull }, { highWaterMark: 0 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors caller abort during a hung lookup and removes its listener', async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const pending = redacted(getBoundedRepositoryInstallationId(config, { signal: parent.signal, fetchImplementation: fetcher }));
    parent.abort(new Error(marker));
    await pending;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
