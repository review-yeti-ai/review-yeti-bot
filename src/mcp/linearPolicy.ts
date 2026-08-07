/**
 * Linear MCP policy for review-yeti-bot.
 *
 * Policy:
 * - LINEAR_API_KEY only (personal API key / service key).
 * - Reject OAuth and official remote OAuth MCP endpoints.
 * - Preferred external package when stdio is used: cline/linear-mcp
 *   (https://github.com/cline/linear-mcp) with env LINEAR_API_KEY only.
 */

export const LINEAR_APPROVED_PACKAGE = 'cline/linear-mcp';
export const LINEAR_APPROVED_REPO = 'https://github.com/cline/linear-mcp';

/** Hosts / paths that imply Linear's remote OAuth MCP or OAuth browser flow. */
const OAUTH_LINEAR_URL_MARKERS = [
  'mcp.linear.app',
  'linear.app/oauth',
  'api.linear.app/oauth',
  'linear.app/authorize',
];

/** Env keys that indicate OAuth client credentials (rejected for Linear). */
const OAUTH_ENV_KEYS = [
  'LINEAR_CLIENT_ID',
  'LINEAR_CLIENT_SECRET',
  'LINEAR_OAUTH_CLIENT_ID',
  'LINEAR_OAUTH_CLIENT_SECRET',
  'LINEAR_REDIRECT_URI',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
];

export interface LinearMcpCandidate {
  id?: string;
  name?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface LinearPolicyResult {
  ok: boolean;
  error?: string;
  /** True when this candidate is clearly a Linear-related MCP. */
  isLinear: boolean;
}

function lower(s: string | undefined): string {
  return (s || '').toLowerCase();
}

function blobOf(candidate: LinearMcpCandidate): string {
  return [
    candidate.id,
    candidate.name,
    candidate.transport,
    candidate.url,
    candidate.command,
    ...(candidate.args || []),
    ...Object.keys(candidate.env || {}),
    ...Object.values(candidate.env || {}),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isLinearMcpCandidate(candidate: LinearMcpCandidate): boolean {
  const blob = blobOf(candidate);
  if (!blob) return false;
  if (blob.includes('linear')) return true;
  if (lower(candidate.id).includes('builtin-linear')) return true;
  if ((candidate.url || '').includes('linear.app')) return true;
  return false;
}

function hasOauthUrl(url: string | undefined): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return OAUTH_LINEAR_URL_MARKERS.some((m) => u.includes(m));
}

function hasOauthEnv(env: Record<string, string> | undefined): boolean {
  if (!env) return false;
  const keys = Object.keys(env).map((k) => k.toUpperCase());
  return OAUTH_ENV_KEYS.some((k) => keys.includes(k));
}

function hasApiKeyEnv(env: Record<string, string> | undefined): boolean {
  if (!env) return false;
  const key = env.LINEAR_API_KEY || env.linear_api_key;
  return Boolean(key && String(key).trim());
}

/**
 * Reject Linear MCP registrations that require OAuth.
 * Non-Linear candidates always pass (ok: true, isLinear: false).
 */
export function assertLinearApiKeyOnly(candidate: LinearMcpCandidate): LinearPolicyResult {
  if (!isLinearMcpCandidate(candidate)) {
    return { ok: true, isLinear: false };
  }

  if (hasOauthUrl(candidate.url)) {
    return {
      ok: false,
      isLinear: true,
      error:
        `Rejected OAuth Linear MCP endpoint (${candidate.url}). ` +
        `review-yeti-bot requires LINEAR_API_KEY only. ` +
        `Use built-in Linear adapter or stdio ${LINEAR_APPROVED_PACKAGE} with LINEAR_API_KEY. ` +
        `See ${LINEAR_APPROVED_REPO}`,
    };
  }

  if (hasOauthEnv(candidate.env)) {
    return {
      ok: false,
      isLinear: true,
      error:
        `Rejected Linear MCP OAuth client credentials. ` +
        `Only LINEAR_API_KEY is allowed (no LINEAR_CLIENT_ID/SECRET, no OAuth redirect). ` +
        `Approved package: ${LINEAR_APPROVED_PACKAGE}`,
    };
  }

  // Remote HTTP Linear without API key in env is treated as OAuth/remote-auth and rejected.
  if (candidate.transport === 'http' && candidate.url && lower(candidate.url).includes('linear')) {
    if (!hasApiKeyEnv(candidate.env)) {
      return {
        ok: false,
        isLinear: true,
        error:
          `Rejected HTTP Linear MCP without LINEAR_API_KEY. ` +
          `OAuth/remote Linear MCP is not supported. Use adapter or ${LINEAR_APPROVED_PACKAGE} stdio + LINEAR_API_KEY.`,
      };
    }
  }

  // Official remote SSE pattern often uses npx mcp-remote https://mcp.linear.app/sse
  const argsBlob = (candidate.args || []).join(' ').toLowerCase();
  const cmdBlob = lower(candidate.command);
  if (
    argsBlob.includes('mcp.linear.app') ||
    argsBlob.includes('mcp-remote') && argsBlob.includes('linear') ||
    (cmdBlob.includes('mcp-remote') && argsBlob.includes('linear'))
  ) {
    return {
      ok: false,
      isLinear: true,
      error:
        `Rejected OAuth remote Linear MCP (mcp-remote / mcp.linear.app). ` +
        `Use LINEAR_API_KEY with built-in adapter or ${LINEAR_APPROVED_PACKAGE}.`,
    };
  }

  return { ok: true, isLinear: true };
}

/**
 * Reject Linear integration updates that try to set OAuth client fields.
 */
export function assertLinearIntegrationApiKeyOnly(patch: {
  oauthClientId?: string;
  oauthClientSecret?: string;
  apiKey?: string;
}): LinearPolicyResult {
  if (patch.oauthClientId || patch.oauthClientSecret) {
    return {
      ok: false,
      isLinear: true,
      error:
        'Linear integration rejects OAuth client credentials. Set apiKey (LINEAR_API_KEY) only.',
    };
  }
  return { ok: true, isLinear: true };
}
