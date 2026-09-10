import { z } from 'zod';
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import { MAX_COMPLETION_BYTES, parseWorkerReviewCompletion, type WorkerReviewCompletion } from './workerReviewCompletion';

export interface WorkerReviewCompletionAdapter {
  reportReviewResult(event: WorkerReviewCompletion): Promise<void>;
}

export const MAX_WORKER_REVIEW_RESPONSE_BYTES = 16 * 1024;

const receiptSchema = z.object({
  version: z.literal('WorkerReviewCompletionAccepted.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  status: z.enum(['recorded', 'duplicate', 'ignored']),
}).strict();

function unavailable(): Error { return new Error('Worker review completion could not be acknowledged'); }

/** Best effort only: a hostile or broken stream must not extend the deadline. */
function cancel(body: { cancel(): Promise<unknown> } | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* No response/transport details escape. */ }
}

/** One bounded POST to the service's /api/dispatch/completion endpoint. Receipt
 * validation acknowledges delivery only: even "recorded" is not eligibility
 * evidence, and "ignored" must never be presented as successful review proof. */
export class HttpWorkerReviewCompletionAdapter implements WorkerReviewCompletionAdapter {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: {
    token: string;
    endpoint: string;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }) {
    try {
      if (!isGitHubInstallationToken(options.token)) throw unavailable();
      const endpoint = validateWorkerCompletionEndpoint(options.endpoint);
      // Reject even an empty query delimiter; the bearer belongs only in headers.
      if (endpoint.includes('?')) throw unavailable();
      const timeoutMs = options.timeoutMs ?? 10_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) throw unavailable();
      const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
      if (typeof fetchImplementation !== 'function') throw unavailable();
      this.endpoint = endpoint;
      this.token = options.token;
      this.timeoutMs = timeoutMs;
      this.fetchImplementation = fetchImplementation;
    } catch { throw new Error('Worker review completion transport configuration is invalid'); }
  }

  async reportReviewResult(event: WorkerReviewCompletion): Promise<void> {
    let payload: WorkerReviewCompletion;
    let body: string;
    try {
      payload = parseWorkerReviewCompletion(event);
      body = JSON.stringify(payload);
      // Bound the actual wire representation as well as the parser's input.
      if (Buffer.byteLength(body, 'utf8') > MAX_COMPLETION_BYTES) throw unavailable();
    } catch { throw unavailable(); }

    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    let cleanupBody: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) throw unavailable();
    };
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable());
      }, this.timeoutMs);
    });
    const post = async (): Promise<void> => {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body, redirect: 'error', signal: controller.signal,
      });
      // A fetch ignoring abort may resolve after reportReviewResult has already
      // rejected. Dispose of its late body without reading or accepting it.
      if (controller.signal.aborted) { cancel(response.body); throw unavailable(); }
      cleanupBody = () => cancel(response.body);
      checkDeadline();
      if (response.status !== 200 || response.redirected || !response.body) throw unavailable();
      const reader = response.body.getReader();
      cleanupBody = () => {
        cancel(reader);
        try { reader.releaseLock(); } catch { /* Cancellation may still be pending. */ }
      };
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        checkDeadline();
        const chunk = await reader.read();
        checkDeadline();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw unavailable();
        bytes += chunk.value.byteLength;
        if (bytes > MAX_WORKER_REVIEW_RESPONSE_BYTES) throw unavailable();
        if (chunk.value.byteLength > 0) chunks.push(chunk.value);
      }
      const receipt = receiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true })
        .decode(Buffer.concat(chunks, bytes))));
      if (receipt.runId !== payload.runId) throw unavailable();
      checkDeadline();
    };
    try {
      // Abort alone cannot bound uncooperative fetch/read implementations.
      await Promise.race([post(), expired]);
    } catch { throw unavailable(); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      try { cleanupBody?.(); } catch { /* Cleanup must not replace the redacted outcome. */ }
    }
  }
}
