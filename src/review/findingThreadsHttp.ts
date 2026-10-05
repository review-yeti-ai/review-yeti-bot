/**
 * ADR 0002: the worker side of `POST /api/dispatch/finding-threads`, a sibling of the completion
 * endpoint authenticated with the same per-run bearer. Legacy v1 publication is best effort; v2
 * publication retries are safe and a failure is surfaced as an unsuccessful raw check update.
 */
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import {
  FINDING_THREADS_REQUEST_V2_VERSION, findingThreadsReadResultSchema, findingThreadsResultSchema,
  type FindingThreadsPublishRequest,
} from './findingThreadsContract';
import type { PriorFindingThread } from './findingConvergence';

export interface FindingThreadsPublisher {
  publish(request: FindingThreadsPublishRequest, signal?: AbortSignal):
    Promise<{ created: number; skipped: number; resolved: number }>;
  /** The review App's own finding threads, author-verified by the service (the only source whose
   * resolutions may satisfy a P2). Optional so a test double may implement publication only. */
  read?(headSha: string, signal?: AbortSignal): Promise<PriorFindingThread[]>;
}

class FindingThreadsHttpError extends Error {
  constructor(readonly retryable: boolean) {
    super('Finding threads could not be published');
  }
}

function unavailable(retryable = false): FindingThreadsHttpError { return new FindingThreadsHttpError(retryable); }

/** `https://host/api/dispatch/completion` -> `https://host/api/dispatch/finding-threads`. */
export function findingThreadsEndpointFor(completionEndpoint: string): string {
  const endpoint = validateWorkerCompletionEndpoint(completionEndpoint);
  const url = new URL(endpoint);
  if (url.search || url.hash || !url.pathname.endsWith('/completion')) throw unavailable();
  url.pathname = `${url.pathname.slice(0, -'/completion'.length)}/finding-threads`;
  return url.toString();
}

export class HttpFindingThreadsPublisher implements FindingThreadsPublisher {
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
    this.endpoint = findingThreadsEndpointFor(options.completionEndpoint);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 60_000) throw unavailable();
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  async read(headSha: string, signal?: AbortSignal): Promise<PriorFindingThread[]> {
    const body = await this.post({ version: 'FindingThreadsRead.v1', runId: this.options.runId,
      executionAttempt: this.options.executionAttempt, headSha }, signal);
    const parsed = findingThreadsReadResultSchema.parse(body);
    if (parsed.runId !== this.options.runId) throw unavailable();
    return parsed.threads as PriorFindingThread[];
  }

  async publish(request: FindingThreadsPublishRequest, signal?: AbortSignal):
    Promise<{ created: number; skipped: number; resolved: number }> {
    const version = 'reviewDecision' in request ? FINDING_THREADS_REQUEST_V2_VERSION : 'FindingThreadsRequest.v1';
    const payload = { version, runId: this.options.runId, executionAttempt: this.options.executionAttempt, ...request };
    let result: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await this.post(payload, signal);
        break;
      } catch (error) {
        if (version !== FINDING_THREADS_REQUEST_V2_VERSION || attempt > 0 || signal?.aborted
          || !(error instanceof FindingThreadsHttpError) || !error.retryable) throw unavailable();
      }
    }
    const parsed = findingThreadsResultSchema.parse(result);
    if (parsed.runId !== this.options.runId) throw unavailable();
    return { created: parsed.created, skipped: parsed.skipped, resolved: parsed.resolved };
  }

  private async post(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable(response.status === 502 || response.status === 503 || response.status === 504);
      }
      try { return await response.json(); }
      catch { throw unavailable(true); }
    } catch (error) {
      if (error instanceof FindingThreadsHttpError) throw error;
      throw unavailable(true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
