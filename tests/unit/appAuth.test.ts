import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  generateGitHubAppJwt,
  getGitHubAppInstallationIdForRepository,
  getGitHubAppInstallationToken,
  getGitHubAppRepositoryReadToken,
} from '../../src/github/appAuth';

describe('GitHub App Authentication & Installation Token Exchange', () => {
  // Generate temporary 2048-bit RSA key pair for testing
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('generates a valid RS256-signed JWT for GitHub App ID', () => {
    const jwt = generateGitHubAppJwt('123456', privateKey);
    expect(jwt).toBeDefined();

    const parts = jwt.split('.');
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('123456');
    expect(payload.exp - payload.iat).toBe(660); // 10 minutes + 60s skew
  });

  it('exchanges JWT for GitHub App installation token (ghs_...) via mock fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        token: 'ghs_mockInstallationToken123456789',
        expires_at: '2026-07-24T13:30:00Z',
        permissions: { pull_requests: 'write', issues: 'write' },
      }),
    });

    const result = await getGitHubAppInstallationToken(
      {
        appId: '123456',
        privateKey,
        installationId: '987654',
      },
      mockFetch as any
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.token).toBe('ghs_mockInstallationToken123456789');
    expect(result.permissions).toEqual({ pull_requests: 'write', issues: 'write' });
  });

  it('resolves a repository installation with App authentication and no installation token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 456 }) });
    await expect(getGitHubAppInstallationIdForRepository({
      appId: '123456',
      privateKey,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
    }, mockFetch as any)).resolves.toBe(456);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/calltelemetry/cisco-cdr/installation');
    expect(new Headers(mockFetch.mock.calls[0][1].headers).get('authorization')).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
  });

  it('fails closed when the App is not installed on the target repository', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(getGitHubAppInstallationIdForRepository({
      appId: '123456',
      privateKey,
      owner: 'calltelemetry',
      repo: 'missing',
    }, mockFetch as any)).rejects.toThrow(/HTTP 404/u);
  });

  it('mints a token restricted to one repository with read-only permissions', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 42 }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          token: 'ghs_repositoryReadToken123456789',
          expires_at: '2099-09-02T02:00:00Z',
          permissions: { contents: 'read', pull_requests: 'read' },
        }),
      });

    await expect(getGitHubAppRepositoryReadToken({
      appId: '123456',
      privateKey,
      owner: 'calltelemetry',
      repo: 'ct-pr-operator-sandbox',
    }, mockFetch as any)).resolves.toEqual({
      token: 'ghs_repositoryReadToken123456789',
      expiresAt: '2099-09-02T02:00:00Z',
      permissions: { contents: 'read', pull_requests: 'read' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/calltelemetry/ct-pr-operator-sandbox/installation',
    );
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://api.github.com/app/installations/42/access_tokens',
    );
    expect(mockFetch.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      repositories: ['ct-pr-operator-sandbox'],
      permissions: { contents: 'read', pull_requests: 'read' },
    });
    expect(mockFetch.mock.calls.map(([url]) => url).join('\n')).not.toContain('ghs_');
  });
});
