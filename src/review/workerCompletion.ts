import { z } from 'zod';

const runId = z.string().regex(/^run_[a-f0-9]{32}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().safe();

export const workerFailureClasses = [
  'contract',
  'timeout',
  'budget_exhausted',
  'auth',
  'rate_limit',
  'transport',
  'provider_error',
] as const;

export const workerTerminalFailureSchema = z.object({
  version: z.literal('WorkerTerminalFailure.v1'),
  runId,
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
  checkId: positiveInteger.optional(),
  failureClass: z.enum(workerFailureClasses),
}).strict();

export type WorkerTerminalFailure = z.infer<typeof workerTerminalFailureSchema>;

/** The dispatch service derives this only from the bearer; it is never sent by the worker. */
export interface WorkerCompletionProof {
  workerTokenDigest: string;
}

export interface WorkerCompletionAdapter {
  reportTerminalFailure(event: WorkerTerminalFailure): Promise<void>;
}

/**
 * Sends only the typed terminal-failure event. The provider error itself never
 * crosses the worker boundary: upstream responses can contain prompts, keys, or
 * other sensitive material, while the bounded failure class is sufficient for
 * durable recovery and diagnosis.
 */
export class HttpWorkerCompletionAdapter implements WorkerCompletionAdapter {
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
    if (!options.token.startsWith('ghs_')) throw new Error('worker completion requires a ghs_ installation token');
    const endpoint = options.endpoint.trim();
    if (!endpoint) throw new Error('worker completion endpoint is required');
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error('worker completion endpoint must be a valid URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new Error('worker completion endpoint must be an HTTPS URL without userinfo or fragments');
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error('worker completion timeout must be between 250ms and 30000ms');
    }
    this.endpoint = endpoint;
    this.token = options.token;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = options.fetchImplementation || globalThis.fetch;
  }

  async reportTerminalFailure(event: WorkerTerminalFailure): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`worker completion callback failed with HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
