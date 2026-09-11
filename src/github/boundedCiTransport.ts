import { validateGitHubAppApiBaseUrl } from './boundedAppToken';

export const CI_API_VERSION = '2022-11-28';
export const MAX_CI_RESPONSE_BYTES = 1024 * 1024;
export function ciUnavailable(): Error { return new Error('GitHub CI operation unavailable'); }

export interface CiTransportOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

function cancel(body: { cancel(): Promise<unknown> } | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Never await cancellation. */ }
}

/** Internal transport for the CI client/minter. One budget covers the complete
 * operation, every page and response body. No retry, remote URL following, or
 * response-provided json()/text() methods. Constructors do not perform I/O. */
export class BoundedCiTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(options: CiTransportOptions = {}) {
    this.baseUrl = validateGitHubAppApiBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) throw ciUnavailable();
    this.fetcher = options.fetchImplementation ?? globalThis.fetch;
    if (typeof this.fetcher !== 'function') throw ciUnavailable();
  }

  async run<T>(operation: (request: (path: string, authorization: string, method?: 'GET' | 'POST', body?: unknown,
    maxBytes?: number) => Promise<{ status: number; data?: unknown }>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const abort = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const check = () => { if (abort.signal.aborted || performance.now() >= deadline) throw ciUnavailable(); };
    let cleanup: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => { abort.abort(); reject(ciUnavailable()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, this.timeoutMs);
      if (signal?.aborted) onAbort();
    });
    const request = async (path: string, authorization: string, method: 'GET' | 'POST' = 'GET', body?: unknown,
      maxBytes = MAX_CI_RESPONSE_BYTES): Promise<{ status: number; data?: unknown }> => {
      check();
      // Paths are constructed by the trusted client, not accepted from events.
      if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u0020\u007f]/u.test(path)
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CI_RESPONSE_BYTES) throw ciUnavailable();
      const url = new URL(`${this.baseUrl}${path}`);
      if (url.href !== `${this.baseUrl}${path}` || url.origin !== new URL(this.baseUrl).origin) throw ciUnavailable();
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && Buffer.byteLength(encoded) > 64 * 1024) throw ciUnavailable();
      const response = await this.fetcher(url.href, { method, body: encoded, redirect: 'error', signal: abort.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${authorization}`,
          'X-GitHub-Api-Version': CI_API_VERSION, 'User-Agent': 'review-yeti-ci-service',
          ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) } });
      if (abort.signal.aborted) { cancel(response.body); throw ciUnavailable(); }
      cleanup = () => cancel(response.body);
      check();
      if (response.redirected || !Number.isInteger(response.status) || response.status < 200 || response.status >= 600) throw ciUnavailable();
      if (response.status !== 200 && response.status !== 201) {
        cleanup(); cleanup = undefined;
        return { status: response.status };
      }
      if (!response.body) throw ciUnavailable();
      const reader = response.body.getReader();
      let cleaned = false;
      const release = () => {
        if (cleaned) return;
        cleaned = true; cancel(reader);
        try { reader.releaseLock(); } catch { /* Pending reads cannot extend the deadline. */ }
      };
      cleanup = release;
      try {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read(); check();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw ciUnavailable();
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw ciUnavailable();
          if (chunk.value.byteLength) chunks.push(chunk.value);
        }
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
        check(); return { status: response.status, data };
      } finally { release(); if (cleanup === release) cleanup = undefined; }
    };
    try {
      const execute = async () => { check(); const result = await operation(request); check(); return result; };
      return await Promise.race([execute(), expired]);
    } catch { throw ciUnavailable(); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      abort.abort(); cleanup?.();
    }
  }
}
