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

// Internal control flow only. Never retain a transport exception or response.
class RetryableDeliveryError extends Error {}
const retryDelaysMs = [250, 500] as const;

/** Best effort only: a hostile or broken stream must not extend the deadline. */
function cancel(body: { cancel(): Promise<unknown> } | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* No response/transport details escape. */ }
}

/** At most three identical POSTs within one total deadline. Only 503 (temporary
 * service unavailability) and ambiguous fetch/read failures are retried. Other
 * statuses, including 429/other 5xx, remain fail-closed rather than guessing a
 * Retry-After or treating an application failure as temporary. Receipt
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
      const timeoutMs = options.timeoutMs ?? 30_000;
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

    const deadline = performance.now() + this.timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.postAttempt(payload, body, deadline);
        return;
      } catch (error) {
        const delay = retryDelaysMs[attempt];
        if (!(error instanceof RetryableDeliveryError) || delay === undefined
          || performance.now() + delay >= deadline) throw unavailable();
        // No reset of the total budget, no server-controlled/unbounded sleep.
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async postAttempt(payload: WorkerReviewCompletion, body: string, deadline: number): Promise<void> {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw unavailable();
    const controller = new AbortController();
    let cleanupBody: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) throw unavailable();
    };
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable());
      }, remainingMs);
    });
    const post = async (): Promise<void> => {
      let response: Response;
      try {
        response = await this.fetchImplementation(this.endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body, redirect: 'error', signal: controller.signal,
        });
      } catch { throw new RetryableDeliveryError(); }
      // A fetch ignoring abort may resolve after reportReviewResult has already
      // rejected. Dispose of its late body without reading or accepting it.
      if (controller.signal.aborted) { cancel(response.body); throw unavailable(); }
      cleanupBody = () => cancel(response.body);
      checkDeadline();
      if (!response.redirected && response.status === 503) throw new RetryableDeliveryError();
      // REL-1056: a 4xx is a DETERMINISTIC contract rejection and must stay
      // terminal (never retried), but it is worth surfacing the bounded reason
      // class so the operator can tell "this diff cannot be reviewed" from
      // "the service was briefly unavailable" without log forensics. Only the
      // service-owned token crosses this boundary; no upstream text is read.
      if (!response.redirected && response.status >= 400 && response.status < 500) {
        let reason = '';
        try {
          const parsed = JSON.parse(await response.text()) as { reason?: unknown };
          if (typeof parsed.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(parsed.reason)) reason = parsed.reason;
        } catch { /* A malformed body must not change the terminal outcome. */ }
        throw new Error(`Worker review completion was rejected by the service${reason ? `: ${reason}` : ''}`);
      }
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
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); }
        catch { throw new RetryableDeliveryError(); }
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
    } catch (error) {
      if (error instanceof RetryableDeliveryError) throw error;
      throw unavailable();
    }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      try { cleanupBody?.(); } catch { /* Cleanup must not replace the redacted outcome. */ }
    }
  }
}
