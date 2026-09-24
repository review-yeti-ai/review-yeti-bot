/**
 * REL-1085: the worker's read of the service's verdict-cache source, for
 * planning. One bounded POST to the dispatch service's `/verdict-cache-base`, a
 * sibling of the completion endpoint, authenticated with the same per-run
 * bearer. Any failure rejects; the planner turns that into a review without
 * cache hits.
 */
import { z } from 'zod';
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import { verdictCacheSourceSchema, type VerdictCacheBaseSource, type VerdictCacheSource } from './verdictCache';

export const MAX_VERDICT_CACHE_BASE_RESPONSE_BYTES = 2_000_000;

const responseSchema = z.object({
  version: z.literal('VerdictCacheBase.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  maxAgeMs: z.number().int().positive().safe(),
  source: verdictCacheSourceSchema.nullable(),
}).strict();

function unavailable(): Error { return new Error('Verdict cache base could not be read'); }

/** `https://host/api/dispatch/completion` -> `https://host/api/dispatch/verdict-cache-base`. */
export function verdictCacheBaseEndpointFor(completionEndpoint: string): string {
  const endpoint = validateWorkerCompletionEndpoint(completionEndpoint);
  const url = new URL(endpoint);
  if (url.search || url.hash || !url.pathname.endsWith('/completion')) throw unavailable();
  url.pathname = `${url.pathname.slice(0, -'/completion'.length)}/verdict-cache-base`;
  return url.toString();
}

export class HttpVerdictCacheBaseSource implements VerdictCacheBaseSource {
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    token: string;
    completionEndpoint: string;
    runId: string;
    executionAttempt: number;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!isGitHubInstallationToken(options.token) || !/^run_[a-f0-9]{32}$/u.test(options.runId)
      || !Number.isSafeInteger(options.executionAttempt) || options.executionAttempt < 1) throw unavailable();
    this.endpoint = verdictCacheBaseEndpointFor(options.completionEndpoint);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) throw unavailable();
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  async read(signal?: AbortSignal): Promise<{ source: VerdictCacheSource | null; maxAgeMs: number }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'VerdictCacheBaseRequest.v1', runId: this.options.runId, executionAttempt: this.options.executionAttempt }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_VERDICT_CACHE_BASE_RESPONSE_BYTES) throw unavailable();
          chunks.push(chunk.value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      const parsed = responseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (parsed.runId !== this.options.runId) throw unavailable();
      return { source: parsed.source, maxAgeMs: parsed.maxAgeMs };
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
