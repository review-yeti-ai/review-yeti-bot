export const PUBLIC_GITHUB_API_BASE_URL = 'https://api.github.com';
export const APP_TOKEN_TIMEOUT_LIMITS = { minimumMs: 1, maximumMs: 10_000 } as const;
export const GITHUB_JSON_TIMEOUT_LIMITS = { minimumMs: 250, maximumMs: 30_000 } as const;
export const GITHUB_INSTALLATION_TOKEN_MAX_LENGTH = 1_024;
export const GITHUB_INSTALLATION_TOKEN_PATTERN_SOURCE = String.raw`ghs_(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_]+)`;
const githubInstallationTokenPattern = new RegExp(`^(?:${GITHUB_INSTALLATION_TOKEN_PATTERN_SOURCE})$`, 'u');

export function isGitHubInstallationToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > GITHUB_INSTALLATION_TOKEN_MAX_LENGTH) return false;
  // GitHub installation tokens historically used one opaque ghs_ segment.
  // Current tokens are a three-segment, base64url-style value that retains the
  // same ghs_ prefix. Keep the grammar exact so whitespace, URL delimiters and
  // arbitrary bearer strings are still rejected before any network I/O.
  return githubInstallationTokenPattern.test(value);
}
