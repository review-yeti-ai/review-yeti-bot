import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { generateGitHubAppJwt, getGitHubAppInstallationToken } from '../../src/github/appAuth';

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
});
