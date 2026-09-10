import {
  GITHUB_JSON_TIMEOUT_LIMITS, isGitHubInstallationToken, PUBLIC_GITHUB_API_BASE_URL,
} from './githubTransportPolicy';

export const MAX_GITHUB_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GitHubJsonClient {
  request(path: string, init?: RequestInit): Promise<any>;
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* best effort */ }
}

/** Bounded GitHub.com JSON transport for repository-scoped installation tokens. */
export function createBoundedGitHubJsonClient(options: {
  token: string;
  fetchImplementation?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): GitHubJsonClient {
  const fetchImpl = options.fetchImplementation || globalThis.fetch;
  const baseUrl = (options.baseUrl || PUBLIC_GITHUB_API_BASE_URL).replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!isGitHubInstallationToken(options.token)
    || baseUrl !== PUBLIC_GITHUB_API_BASE_URL
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < GITHUB_JSON_TIMEOUT_LIMITS.minimumMs
    || timeoutMs > GITHUB_JSON_TIMEOUT_LIMITS.maximumMs) {
    throw new Error('Bounded GitHub JSON transport configuration is invalid');
  }
  return { async request(path: string, init: RequestInit = {}): Promise<any> {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\u0000-\u0020\u007f\\#]/u.test(path)) {
      throw new Error('GitHub JSON request path is invalid');
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/vnd.github+json', authorization: `Bearer ${options.token}`,
          'x-github-api-version': '2022-11-28', ...(init.headers || {}),
        },
      });
    } catch { throw new Error('GitHub JSON request failed before response'); }
    if (!response.ok || response.redirected || !response.body) {
      cancel(response.body);
      throw new Error(`GitHub JSON request failed with HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_GITHUB_JSON_RESPONSE_BYTES) {
      cancel(response.body);
      throw new Error('GitHub JSON response exceeded the byte limit');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_GITHUB_JSON_RESPONSE_BYTES) throw new Error();
        chunks.push(chunk.value);
      }
      const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
    } catch {
      try { await reader.cancel(); } catch { /* best-effort bounded cleanup */ }
      throw new Error('GitHub JSON response was unavailable');
    }
  } };
}
