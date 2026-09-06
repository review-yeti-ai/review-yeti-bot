import { describe, expect, it, vi } from 'vitest';
import { getGitHubAppRepositoryPublishToken } from '../../src/github/appAuth';

// A syntactically valid throwaway key so generateGitHubAppJwt can sign. Not a secret.
const { generateKeyPairSync } = await import('node:crypto');
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const config = {
  appId: '123456',
  privateKey: privateKey as string,
  owner: 'calltelemetry',
  repo: 'ct-meta',
};

function fetchStub(tokenBody: unknown, { installationOk = true } = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith('/installation')) {
      return new Response(JSON.stringify(installationOk ? { id: 987 } : {}), { status: installationOk ? 200 : 404 });
    }
    return new Response(JSON.stringify(tokenBody), { status: 200 });
  }) as unknown as typeof fetch;
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe('App-minted publish token', () => {
  it('mints a repo-scoped checks:write token', async () => {
    const fetchFn = fetchStub({ token: 'ghs_ok', expires_at: future(), permissions: { checks: 'write' } });
    const result = await getGitHubAppRepositoryPublishToken(config, fetchFn);
    expect(result.token).toBe('ghs_ok');
    expect(result.permissions).toEqual({ checks: 'write' });
  });

  it('requests exactly one repository and only checks: write', async () => {
    const fetchFn = fetchStub({ token: 'ghs_ok', expires_at: future(), permissions: { checks: 'write' } });
    await getGitHubAppRepositoryPublishToken(config, fetchFn);
    const call = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .find(([url]) => String(url).includes('/access_tokens'));
    const body = JSON.parse(String((call?.[1] as { body?: unknown })?.body));
    // Least privilege is the point: the lane creates and completes one check run.
    expect(body.repositories).toEqual(['ct-meta']);
    expect(body.permissions).toEqual({ checks: 'write' });
  });

  it('refuses a token granted more than it asked for', async () => {
    // GitHub returns the permissions actually granted. A broader grant than
    // requested must fail loudly rather than being used.
    const fetchFn = fetchStub({
      token: 'ghs_ok',
      expires_at: future(),
      permissions: { checks: 'write', contents: 'write' },
    });
    await expect(getGitHubAppRepositoryPublishToken(config, fetchFn)).rejects.toThrow(/unsafe contract/u);
  });

  it.each([
    ['a non-installation token', { token: 'ghp_pat', expires_at: future(), permissions: { checks: 'write' } }],
    ['a read-only grant', { token: 'ghs_ok', expires_at: future(), permissions: { checks: 'read' } }],
    ['no permissions at all', { token: 'ghs_ok', expires_at: future(), permissions: {} }],
    ['an already-expired token', { token: 'ghs_ok', expires_at: new Date(Date.now() - 1000).toISOString(), permissions: { checks: 'write' } }],
  ])('refuses %s', async (_label, body) => {
    await expect(getGitHubAppRepositoryPublishToken(config, fetchStub(body))).rejects.toThrow(/unsafe contract/u);
  });

  it('fails when the installation cannot be resolved', async () => {
    const fetchFn = fetchStub({ token: 'ghs_ok', expires_at: future(), permissions: { checks: 'write' } }, { installationOk: false });
    await expect(getGitHubAppRepositoryPublishToken(config, fetchFn)).rejects.toThrow(/installation lookup failed/u);
  });
});
