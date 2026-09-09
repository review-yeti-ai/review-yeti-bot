import {
  getGitHubAppRepositoryReadToken, getGitHubAppRepositoryPublishToken,
  getGitHubAppInstallationIdForRepository,
  type GitHubRepositoryInstallationConfig, type InstallationTokenResult,
} from './appAuth';

export const MAX_APP_TOKEN_RESPONSE_BYTES = 64 * 1024;

function unavailable(): Error { return new Error('Repository App token is unavailable'); }

/** Validate before startup accepts traffic, as well as before signing requests. */
export function validateGitHubAppApiBaseUrl(value: string = 'https://api.github.com'): string {
  try {
    if (typeof value !== 'string' || value.length > 2_000
      || /[\u0000-\u0020\u007f\\?#]/u.test(value)) throw unavailable();
    const api = new URL(value);
    if (api.protocol !== 'https:' || !api.hostname || api.username || api.password) throw unavailable();
    return api.href.replace(/\/+$/u, '');
  } catch { throw new Error('GitHub App API base URL must be HTTPS without credentials, query, or fragment'); }
}

export interface BoundedAppTransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

function cancel(body: { cancel(): Promise<unknown> } | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Best effort, never awaited. */ }
}

/** Reuse the existing repository/permission-scoped minters with one deadline
 * covering the entire factory, both HTTP requests and their bodies. No caching.
 * baseUrl retains appAuth's GitHub.com default; an explicit HTTPS API prefix
 * (e.g. an enterprise /api/v3) is pinned for every request. timeoutMs is 1..10000. */
export async function getBoundedRepositoryToken(
  config: GitHubRepositoryInstallationConfig,
  mode: 'read' | 'publish',
  options: BoundedAppTransportOptions = {},
): Promise<InstallationTokenResult> {
  if (mode !== 'read' && mode !== 'publish') throw unavailable();
  return withBoundedRepositoryTransport(config, options, true, async (selected, boundedFetch) => {
    const result = await (mode === 'read' ? getGitHubAppRepositoryReadToken : getGitHubAppRepositoryPublishToken)(selected, boundedFetch);
    if (!/^ghs_[A-Za-z0-9_]+$/u.test(result.token)) throw unavailable();
    return result;
  });
}

/** Lookup only: no token mint, extra permissions, redirect, or cached installation. */
export async function getBoundedRepositoryInstallationId(
  config: GitHubRepositoryInstallationConfig,
  options: BoundedAppTransportOptions = {},
): Promise<number> {
  try {
    return await withBoundedRepositoryTransport(config, options, false, getGitHubAppInstallationIdForRepository);
  } catch { throw new Error('Repository App installation is unavailable'); }
}

async function withBoundedRepositoryTransport<T>(
  config: GitHubRepositoryInstallationConfig,
  options: BoundedAppTransportOptions,
  allowTokenMint: boolean,
  operation: (config: GitHubRepositoryInstallationConfig, fetcher: typeof fetch) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupBody: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  const signal = options.signal;
  try {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
      || signal?.aborted) throw unavailable();
    const deadline = performance.now() + timeoutMs;
    const checkDeadline = () => {
      if (controller.signal.aborted || signal?.aborted || performance.now() >= deadline) throw unavailable();
    };
    const selected = { appId: config.appId, privateKey: config.privateKey, owner: config.owner, repo: config.repo,
      baseUrl: config.baseUrl ?? 'https://api.github.com' };
    if (typeof selected.appId !== 'string' || !/^[1-9][0-9]*$/u.test(selected.appId)
      || !Number.isSafeInteger(Number(selected.appId)) || typeof selected.privateKey !== 'string' || !selected.privateKey
      || [selected.owner, selected.repo].some((value) => typeof value !== 'string'
        || !/^[A-Za-z0-9_.-]{1,100}$/u.test(value) || value === '.' || value === '..')) throw unavailable();
    selected.baseUrl = validateGitHubAppApiBaseUrl(selected.baseUrl);
    const api = new URL(selected.baseUrl);
    const installationUrl = `${selected.baseUrl}/repos/${encodeURIComponent(selected.owner)}/${encodeURIComponent(selected.repo)}/installation`;
    const tokenPrefix = `${selected.baseUrl}/app/installations/`;
    const fetcher = options.fetchImplementation ?? globalThis.fetch;
    if (typeof fetcher !== 'function') throw unavailable();
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(unavailable()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, Math.max(0, deadline - performance.now()));
    });
    const boundedFetch: typeof fetch = async (input, init) => {
      checkDeadline();
      if (typeof input !== 'string') throw unavailable();
      const url = new URL(input);
      const tokenSuffix = input.startsWith(tokenPrefix) ? input.slice(tokenPrefix.length) : '';
      if (url.origin !== api.origin || url.href !== input || url.username || url.password || url.search || url.hash
        || !((input === installationUrl && init?.method === 'GET')
          || (allowTokenMint && /^[1-9][0-9]*\/access_tokens$/u.test(tokenSuffix)
            && Number.isSafeInteger(Number(tokenSuffix.split('/')[0])) && init?.method === 'POST'))) throw unavailable();
      const response = await fetcher(input, { ...init, redirect: 'error', signal: controller.signal });
      if (controller.signal.aborted) { cancel(response.body); throw unavailable(); }
      cleanupBody = () => cancel(response.body);
      checkDeadline();
      if (!response.ok || response.redirected || !response.body) throw unavailable();
      const reader = response.body.getReader();
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        cancel(reader);
        try { reader.releaseLock(); } catch { /* A pending cancellation cannot extend the deadline. */ }
      };
      cleanupBody = cleanup;
      try {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          checkDeadline();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw unavailable();
          bytes += chunk.value.byteLength;
          if (bytes > MAX_APP_TOKEN_RESPONSE_BYTES) throw unavailable();
          if (chunk.value.byteLength) chunks.push(chunk.value);
        }
        // Give the existing minter a native, already bounded response. Its JSON
        // parsing can no longer wait on a remote/uncooperative response method.
        return new Response(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
          { status: response.status, headers: { 'Content-Type': 'application/json' } });
      } finally { cleanup(); if (cleanupBody === cleanup) cleanupBody = undefined; }
    };
    const run = async () => {
      checkDeadline();
      const result = await operation(selected, boundedFetch);
      checkDeadline();
      return result;
    };
    return await Promise.race([run(), expired]);
  } catch { throw unavailable(); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    controller.abort();
    try { cleanupBody?.(); } catch { /* Do not replace the redacted outcome. */ }
  }
}
