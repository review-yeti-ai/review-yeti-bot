import { z } from 'zod';
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import { parseIncompleteP2RecoveryContext, type IncompleteP2RecoveryContext } from './incompleteP2Recovery';

const responseSchema = z.object({
  version: z.literal('IncompleteP2RecoveryResponse.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  context: z.unknown().nullable(),
}).strict();

export interface IncompleteP2RecoverySource {
  read(signal?: AbortSignal): Promise<IncompleteP2RecoveryContext | null>;
}

/** A mandatory, bounded evidence read. Failure never degrades to an empty archive. */
export class HttpIncompleteP2RecoverySource implements IncompleteP2RecoverySource {
  private readonly endpoint: string;
  constructor(private readonly options: {
    token: string; completionEndpoint: string; runId: string; executionAttempt: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!isGitHubInstallationToken(options.token) || !/^run_[a-f0-9]{32}$/u.test(options.runId)
      || !Number.isSafeInteger(options.executionAttempt) || options.executionAttempt < 2) {
      throw new Error('Invalid retained finding read identity');
    }
    const url = new URL(validateWorkerCompletionEndpoint(options.completionEndpoint));
    if (url.search || url.hash || !url.pathname.endsWith('/completion')) throw new Error('Invalid retained finding endpoint');
    url.pathname = `${url.pathname.slice(0, -'/completion'.length)}/incomplete-p2-recovery`;
    this.endpoint = url.toString();
  }

  async read(signal?: AbortSignal): Promise<IncompleteP2RecoveryContext | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (this.options.fetchImplementation ?? globalThis.fetch)(this.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'IncompleteP2RecoveryRequest.v1', runId: this.options.runId,
          executionAttempt: this.options.executionAttempt }),
      });
      if (response.status !== 200 || response.redirected || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Retained findings unavailable');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 80_000) throw new Error('Retained findings response exceeds its bound');
          chunks.push(chunk.value);
        }
      } finally { void reader.cancel().catch(() => undefined); }
      const parsed = responseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (parsed.runId !== this.options.runId || parsed.executionAttempt !== this.options.executionAttempt) {
        throw new Error('Retained findings response identity mismatch');
      }
      if (parsed.context === null) return null;
      const context = parseIncompleteP2RecoveryContext(parsed.context);
      if (context.runId !== this.options.runId || context.executionAttempt !== this.options.executionAttempt) {
        throw new Error('Retained findings context identity mismatch');
      }
      return context;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
