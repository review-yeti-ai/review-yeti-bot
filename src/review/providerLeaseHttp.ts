/**
 * The worker's client for `POST /api/dispatch/provider-lease`, a sibling of the completion
 * endpoint authenticated with the same per-run bearer. Every failure rejects; the caller
 * (`../gateway/concurrencyLimitedModelClient`) turns any rejection into "proceed under the local
 * cap", so this client never decides a review outcome.
 */
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { validateWorkerCompletionEndpoint } from './workerCompletion';
import {
  MAX_PROVIDER_LEASE_RESPONSE_BYTES,
  PROVIDER_LEASE_ACQUIRE_VERSION,
  PROVIDER_LEASE_RELEASE_VERSION,
  PROVIDER_LEASE_RENEW_VERSION,
  providerLeaseResponseSchema,
  type ProviderLeaseAcquireResult,
  type ProviderLeaseCoordinator,
  type ProviderLeaseResponse,
} from './providerLease';

/** Short on purpose: a slow coordinator must not eat into the review's model-call budget. */
export const DEFAULT_PROVIDER_LEASE_TIMEOUT_MS = 3_000;

function unavailable(): Error { return new Error('Provider lease coordinator unavailable'); }

/** `https://host/api/dispatch/completion` -> `https://host/api/dispatch/provider-lease`. */
export function providerLeaseEndpointFor(completionEndpoint: string): string {
  const url = new URL(validateWorkerCompletionEndpoint(completionEndpoint));
  if (url.search || url.hash || !url.pathname.endsWith('/completion')) throw unavailable();
  url.pathname = `${url.pathname.slice(0, -'/completion'.length)}/provider-lease`;
  return url.toString();
}

export class HttpProviderLeaseCoordinator implements ProviderLeaseCoordinator {
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
    this.endpoint = providerLeaseEndpointFor(options.completionEndpoint);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_LEASE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) throw unavailable();
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  async acquire(capacityKey: string, signal?: AbortSignal): Promise<ProviderLeaseAcquireResult> {
    const response = await this.post({ version: PROVIDER_LEASE_ACQUIRE_VERSION, capacityKey }, signal);
    if (response.status === 'granted' || response.status === 'denied' || response.status === 'unmanaged') {
      const { version: _version, ...result } = response;
      return result;
    }
    throw unavailable();
  }

  async renew(leaseId: string, signal?: AbortSignal): Promise<{ status: 'renewed'; ttlMs: number } | { status: 'lost' }> {
    const response = await this.post({ version: PROVIDER_LEASE_RENEW_VERSION, leaseId }, signal);
    if (response.status === 'renewed') return { status: 'renewed', ttlMs: response.ttlMs };
    if (response.status === 'lost') return { status: 'lost' };
    throw unavailable();
  }

  async release(leaseId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.post({ version: PROVIDER_LEASE_RELEASE_VERSION, leaseId }, signal);
    if (response.status !== 'released') throw unavailable();
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderLeaseResponse> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, runId: this.options.runId, executionAttempt: this.options.executionAttempt }),
      });
      if (response.status !== 200 || response.redirected || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_PROVIDER_LEASE_RESPONSE_BYTES) throw unavailable();
      return providerLeaseResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
