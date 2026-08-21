import crypto from 'node:crypto';
import { logger } from '../utils/logger';

export interface GitHubAppAuthConfig {
  appId: string;
  privateKey: string; // PEM-encoded RSA private key
  installationId: string;
  baseUrl?: string;
}

export interface InstallationTokenResult {
  token: string;
  expiresAt: string;
  permissions?: Record<string, string>;
}

/**
 * Encodes a JSON object or string to base64url format.
 */
function base64url(input: string | Buffer | object): string {
  const buf = typeof input === 'string'
    ? Buffer.from(input, 'utf8')
    : Buffer.isBuffer(input)
      ? input
      : Buffer.from(JSON.stringify(input), 'utf8');

  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Generates an RS256-signed JWT for GitHub App authentication (valid for 10 minutes).
 */
export function generateGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // 60 seconds in the past to compensate for clock drift
    exp: now + (10 * 60), // 10 minutes expiration max allowed by GitHub
    iss: appId,
  };

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  const signatureB64 = base64url(signer.sign(privateKeyPem));

  return `${unsignedToken}.${signatureB64}`;
}

/**
 * Exchanges a GitHub App JWT for a repository Installation Access Token (`ghs_...`).
 * Comments posted with this token display as `ct-review-bot[bot]`.
 */
export async function getGitHubAppInstallationToken(
  config: GitHubAppAuthConfig,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<InstallationTokenResult> {
  const { appId, privateKey, installationId, baseUrl = 'https://api.github.com' } = config;
  const jwt = generateGitHubAppJwt(appId, privateKey);
  const url = `${baseUrl.replace(/\/+$/, '')}/app/installations/${installationId}/access_tokens`;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${jwt}`,
      'User-Agent': 'ct-review-bot[bot]',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('Failed to obtain GitHub App Installation Token', { status: res.status, errText });
    throw new Error(`GitHub App installation token exchange failed HTTP ${res.status}: ${errText}`);
  }

  const data: any = await res.json();
  logger.info(`Successfully generated GitHub App Installation Token for installation ${installationId}`);

  return {
    token: data.token,
    expiresAt: data.expires_at,
    permissions: data.permissions,
  };
}
