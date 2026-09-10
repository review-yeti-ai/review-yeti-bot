export const PUBLIC_GITHUB_API_BASE_URL = 'https://api.github.com';
export const APP_TOKEN_TIMEOUT_LIMITS = { minimumMs: 1, maximumMs: 10_000 } as const;
export const GITHUB_JSON_TIMEOUT_LIMITS = { minimumMs: 250, maximumMs: 30_000 } as const;

export function isGitHubInstallationToken(value: unknown): value is string {
  return typeof value === 'string' && /^ghs_[A-Za-z0-9_]+$/u.test(value);
}
