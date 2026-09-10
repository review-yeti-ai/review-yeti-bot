import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getGitHubAppRepositoryMergeGroupToken } from '../../src/github/appAuth';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const config = { appId: '4385771', privateKey, owner: 'calltelemetry', repo: 'dashboard' };
const future = () => new Date(Date.now() + 3_600_000).toISOString();

function fetchStub(tokenBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).endsWith('/installation') ? { id: 987 } : tokenBody,
  ), { status: 200 })) as unknown as typeof fetch;
}

describe('App-minted merge-group token', () => {
  it('requests one repository with only the read and check grants needed by the gate', async () => {
    const permissions = { checks: 'write', contents: 'read', pull_requests: 'read', merge_queues: 'read', metadata: 'read' };
    const fetchFn = fetchStub({ token: 'ghs_ok', expires_at: future(), permissions });
    await expect(getGitHubAppRepositoryMergeGroupToken(config, fetchFn)).resolves.toEqual({
      token: 'ghs_ok', expiresAt: expect.any(String), permissions,
    });
    const call = (fetchFn as any).mock.calls.find(([url]: [unknown]) => String(url).includes('/access_tokens'));
    expect(JSON.parse(String(call[1].body))).toEqual({
      repositories: ['dashboard'], permissions: {
        checks: 'write', contents: 'read', pull_requests: 'read', merge_queues: 'read',
      },
    });
  });

  it.each([
    { checks: 'read', contents: 'read', pull_requests: 'read', merge_queues: 'read' },
    { checks: 'write', contents: 'write', pull_requests: 'read', merge_queues: 'read' },
    { checks: 'write', contents: 'read', pull_requests: 'write', merge_queues: 'read' },
    { checks: 'write', contents: 'read', pull_requests: 'read', merge_queues: 'write' },
    { checks: 'write', contents: 'read', pull_requests: 'read', merge_queues: 'read', issues: 'read' },
  ])('rejects an unsafe effective permission set %#', async (permissions) => {
    await expect(getGitHubAppRepositoryMergeGroupToken(config,
      fetchStub({ token: 'ghs_ok', expires_at: future(), permissions }))).rejects.toThrow('unsafe contract');
  });
});
