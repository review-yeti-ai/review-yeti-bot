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

export interface GitHubRepositoryInstallationConfig {
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
  baseUrl?: string;
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

/** Resolves the App installation for an allowlisted repository without creating a token. */
export async function getGitHubAppInstallationIdForRepository(
  config: GitHubRepositoryInstallationConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<number> {
  const { appId, privateKey, owner, repo, baseUrl = 'https://api.github.com' } = config;
  const jwt = generateGitHubAppJwt(appId, privateKey);
  const url = `${baseUrl.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'ct-review-bot[bot]',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GitHub App repository installation lookup failed HTTP ${response.status}`);
  const body = await response.json() as { id?: unknown };
  const installationId = Number(body.id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GitHub App repository installation lookup returned no installation id');
  }
  return installationId;
}

/**
 * Mints a short-lived installation token constrained to one repository and
 * the two read permissions needed by a non-publishing review worker.
 */
export async function getGitHubAppRepositoryReadToken(
  config: GitHubRepositoryInstallationConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<InstallationTokenResult> {
  const installationId = await getGitHubAppInstallationIdForRepository(config, fetchFn);
  const { appId, privateKey, repo, baseUrl = 'https://api.github.com' } = config;
  const jwt = generateGitHubAppJwt(appId, privateKey);
  const url = `${baseUrl.replace(/\/+$/, '')}/app/installations/${installationId}/access_tokens`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ct-review-bot[bot]',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      repositories: [repo],
      permissions: { contents: 'read', pull_requests: 'read' },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub App repository read token exchange failed HTTP ${response.status}`);
  }
  const body = await response.json() as {
    token?: unknown;
    expires_at?: unknown;
    permissions?: unknown;
  };
  const token = typeof body.token === 'string' ? body.token : '';
  const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : '';
  const permissions = body.permissions && typeof body.permissions === 'object' && !Array.isArray(body.permissions)
    ? body.permissions as Record<string, unknown>
    : {};
  const permissionValues = Object.values(permissions);
  if (!token.startsWith('ghs_') || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() ||
      permissions.contents !== 'read' || permissions.pull_requests !== 'read' ||
      permissionValues.some((value) => value !== 'read')) {
    throw new Error('GitHub App repository read token exchange returned an unsafe contract');
  }
  return {
    token,
    expiresAt,
    permissions: permissions as Record<string, string>,
  };
}
