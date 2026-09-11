import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBoundedCiRepositoryToken, type CiTokenPurpose } from '../../src/github/ciAppToken';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { appId: '4385771', privateKey, repository: { repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta' },
  baseUrl: 'https://api.example.invalid/api/v3' };
const token = 'ghs_synthetic_ci';
const grants = { 'repository-dispatch': { contents: 'write' }, 'workflow-dispatch': { actions: 'write' },
  'check-publication': { checks: 'write' },
  read: { actions: 'read', contents: 'read', pull_requests: 'read', checks: 'read' } };
function body(purpose: CiTokenPurpose) { return { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  permissions: { ...grants[purpose], metadata: 'read' } }; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function fetcher(purpose: CiTokenPurpose) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
    .mockResolvedValueOnce(json(body(purpose), 201)).mockResolvedValueOnce(json({ id: 123, full_name: 'calltelemetry/ct-meta' }));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('separate bounded CI-purpose minter', () => {
  it.each(['repository-dispatch', 'workflow-dispatch', 'check-publication', 'read'] as const)('mints only %s permissions for the exact numeric repository', async (purpose) => {
    const fetchImplementation = fetcher(purpose);
    const result = await getBoundedCiRepositoryToken(config, purpose, { fetchImplementation });
    expect(result.token).toBe(token);
    expect(result.permissions).toEqual(body(purpose).permissions);
    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([
      `${config.baseUrl}/repos/calltelemetry/ct-meta/installation`, `${config.baseUrl}/app/installations/987/access_tokens`,
      `${config.baseUrl}/repos/calltelemetry/ct-meta`,
    ]);
    expect(JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body))).toEqual({ repository_ids: [123], permissions: grants[purpose] });
    for (const [url, init] of fetchImplementation.mock.calls) {
      expect(String(url)).not.toContain(token);
      expect(init?.redirect).toBe('error');
      expect(init?.signal?.aborted).toBe(true);
      expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28');
    }
    const jwt = new Headers(fetchImplementation.mock.calls[0][1]?.headers).get('authorization')!.slice(7);
    expect(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).iss).toBe('4385771');
    expect(new Headers(fetchImplementation.mock.calls[2][1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
  });
  it.each(['repository-dispatch', 'workflow-dispatch', 'read'] as const)('rejects extra grants for %s, including other CI purposes', async (purpose) => {
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json({ ...body(purpose), permissions: { ...body(purpose).permissions, checks: 'write' } }, 201));
    await expect(getBoundedCiRepositoryToken(config, purpose, { fetchImplementation: stub })).rejects.toThrow(/^Repository CI App token is unavailable$/u);
    expect(stub).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { checks: 'read' }, { checks: 'write', contents: 'read' }, { checks: 'write', actions: 'write' },
    { checks: 'write', pull_requests: 'read' }, { checks: 'write', metadata: 'write' }])
  ('rejects missing, downgraded or excess publication permissions %j', async (permissions) => {
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json({ ...body('check-publication'), permissions }, 201));
    await expect(getBoundedCiRepositoryToken(config, 'check-publication', { fetchImplementation: stub }))
      .rejects.toThrow(/^Repository CI App token is unavailable$/u);
    expect(stub).toHaveBeenCalledTimes(2);
  });
  it('accepts publication checks write when implicit metadata read is omitted from the response', async () => {
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json({ ...body('check-publication'), permissions: { checks: 'write' } }, 201))
      .mockResolvedValueOnce(json({ id: 123, full_name: 'calltelemetry/ct-meta' }));
    await expect(getBoundedCiRepositoryToken(config, 'check-publication', { fetchImplementation: stub }))
      .resolves.toMatchObject({ token, permissions: { checks: 'write' } });
    expect(JSON.parse(String(stub.mock.calls[1][1]?.body)))
      .toEqual({ repository_ids: [123], permissions: { checks: 'write' } });
  });
  it('requires checks read for admission rather than returning a token unable to read the published gate', async () => {
    const { checks: _checks, ...permissions } = grants.read;
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json({ ...body('read'), permissions: { ...permissions, metadata: 'read' } }, 201));
    await expect(getBoundedCiRepositoryToken(config, 'read', { fetchImplementation: stub }))
      .rejects.toThrow(/^Repository CI App token is unavailable$/u);
    expect(stub).toHaveBeenCalledTimes(2);
  });
  it.each(['repository-dispatch', 'workflow-dispatch'] as const)('does not add checks read to %s grants', async (purpose) => {
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json({ ...body(purpose), permissions: { ...body(purpose).permissions, checks: 'read' } }, 201));
    await expect(getBoundedCiRepositoryToken(config, purpose, { fetchImplementation: stub }))
      .rejects.toThrow(/^Repository CI App token is unavailable$/u);
    expect(stub).toHaveBeenCalledTimes(2);
  });
  it.each([{ id: 987, app_id: 1 }, { id: '987', app_id: 4385771 }, {}])('rejects wrong installation identity %j', async (installation) => {
    const stub = vi.fn<typeof fetch>().mockResolvedValue(json(installation));
    await expect(getBoundedCiRepositoryToken(config, 'workflow-dispatch', { fetchImplementation: stub })).rejects.toThrow('Repository CI App token is unavailable');
    expect(stub).toHaveBeenCalledOnce();
  });
  it.each([{ id: 999, full_name: 'calltelemetry/ct-meta' }, { id: 123, full_name: 'calltelemetry/other' }])
  ('rejects a renamed or wrong numeric repository after mint %j', async (repository) => {
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json(body('read'), 201)).mockResolvedValueOnce(json(repository));
    await expect(getBoundedCiRepositoryToken(config, 'read', { fetchImplementation: stub })).rejects.toThrow('Repository CI App token is unavailable');
  });
  it.each([{ token: 'pat_synthetic' }, { token: 'ghs_bad space' }, { expires_at: '2000-01-01T00:00:00Z' },
    { permissions: { actions: 'write', metadata: 'write' } }, { permissions: { actions: 'read' } }])
  ('rejects unsafe returned token contract %j', async (change) => {
    const stub = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 987, app_id: 4385771 }))
      .mockResolvedValueOnce(json({ ...body('workflow-dispatch'), ...change }, 201));
    await expect(getBoundedCiRepositoryToken(config, 'workflow-dispatch', { fetchImplementation: stub })).rejects.toThrow('Repository CI App token is unavailable');
  });
  it.each([{ appId: '1' }, { baseUrl: 'http://api.example.invalid' }, { baseUrl: 'https://u:p@api.example.invalid' },
    { repository: { ...config.repository, repo: '..' } }])('rejects unsafe configuration %j before I/O', async (change) => {
    const stub = vi.fn<typeof fetch>();
    await expect(getBoundedCiRepositoryToken({ ...config, ...change }, 'read', { fetchImplementation: stub })).rejects.toThrow('Repository CI App token is unavailable');
    expect(stub).not.toHaveBeenCalled();
  });
  it.each([0, 249, 10_001, NaN])('rejects unbounded minter deadline %s', async (timeoutMs) => {
    const stub = vi.fn<typeof fetch>();
    await expect(getBoundedCiRepositoryToken(config, 'read', { fetchImplementation: stub, timeoutMs })).rejects.toThrow('Repository CI App token is unavailable');
    expect(stub).not.toHaveBeenCalled();
  });
  it('bounds the whole operation across lookup and a stuck token body; cancellation cannot hold it open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cancel = vi.fn(() => new Promise<void>(() => undefined)); const releaseLock = vi.fn();
    const stub = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(json({ id: 987, app_id: 4385771 })), 200)))
      .mockResolvedValueOnce({ status: 201, body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel, releaseLock }) } } as unknown as Response);
    const pending = getBoundedCiRepositoryToken(config, 'read', { timeoutMs: 250, fetchImplementation: stub });
    const assertion = expect(pending).rejects.toThrow(/^Repository CI App token is unavailable$/u);
    await vi.advanceTimersByTimeAsync(250); await assertion;
    expect(stub).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors pre-abort without signing or requesting', async () => {
    const abort = new AbortController(); abort.abort(new Error('PRIVATE_DIAGNOSTIC'));
    const stub = vi.fn<typeof fetch>();
    await expect(getBoundedCiRepositoryToken(config, 'read', { signal: abort.signal, fetchImplementation: stub })).rejects.toThrow('Repository CI App token is unavailable');
    expect(stub).not.toHaveBeenCalled();
  });
  it('caps response bytes at 64 KiB and never retains provider diagnostics', async () => {
    const stub = vi.fn<typeof fetch>().mockResolvedValue(new Response('é'.repeat(32 * 1024 + 1)));
    await expect(getBoundedCiRepositoryToken(config, 'read', { fetchImplementation: stub })).rejects.toThrow(/^Repository CI App token is unavailable$/u);
  });
});
