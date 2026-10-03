/**
 * Fixtures for the cross-review provider concurrency tests.
 *
 * `MemoryLeaseBoard` mirrors the service's lease semantics (per-key capacity, TTL, reap of expired
 * holders on acquire) so several decorated clients -- each standing in for one worker pod -- can
 * share one coordinator in a unit test. The production accounting is SQL and is exercised against
 * real Postgres in `tests/integration/providerConcurrencyLease.postgres.test.ts`.
 *
 * `rateLimitedProvider` stands in for one upstream account with a hard concurrent-request cap: when
 * a call arrives while every slot is in use it answers like the real provider does, HTTP 429
 * "Concurrent limit reached for <model>: 15/15 slots in use ...".
 */
import { OpenRouterResponseError, type OpenRouterRequest, type OpenRouterResponse, type ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { ProviderLeaseAcquireResult, ProviderLeaseCoordinator } from '../../src/review/providerLease';

export class MemoryLeaseBoard {
  private readonly leases = new Map<string, { key: string; holder: string; expiresAt: number }>();
  private sequence = 0;
  readonly peakByKey = new Map<string, number>();
  acquireCalls = 0;
  renewCalls = 0;
  releaseCalls = 0;

  constructor(private readonly options: {
    capacity: Record<string, number>;
    ttlMs?: number;
    retryAfterMs?: number;
    now?: () => number;
  }) {}

  private get now(): number { return (this.options.now ?? Date.now)(); }
  private get ttlMs(): number { return this.options.ttlMs ?? 60_000; }

  inUse(key: string): number {
    return [...this.leases.values()].filter((lease) => lease.key === key && lease.expiresAt > this.now).length;
  }

  /** Takes a slot directly, as a holder that will crash (never renew, never release). */
  grab(key: string, holder: string): string | undefined {
    const result = this.acquireFor(holder, key);
    return result.status === 'granted' ? result.leaseId : undefined;
  }

  acquireFor(holder: string, key: string): ProviderLeaseAcquireResult {
    this.acquireCalls += 1;
    const capacity = this.options.capacity[key];
    if (capacity === undefined) return { status: 'unmanaged' };
    for (const [id, lease] of this.leases) if (lease.key === key && lease.expiresAt <= this.now) this.leases.delete(id);
    const inUse = this.inUse(key);
    if (inUse >= capacity) return { status: 'denied', retryAfterMs: this.options.retryAfterMs ?? 250, capacity, inUse };
    this.sequence += 1;
    const leaseId = `00000000-0000-4000-8000-${this.sequence.toString(16).padStart(12, '0')}`;
    this.leases.set(leaseId, { key, holder, expiresAt: this.now + this.ttlMs });
    this.peakByKey.set(key, Math.max(this.peakByKey.get(key) ?? 0, inUse + 1));
    return { status: 'granted', leaseId, ttlMs: this.ttlMs, capacity, inUse: inUse + 1 };
  }

  /** One worker's view of the shared coordinator. */
  coordinatorFor(holder: string): ProviderLeaseCoordinator {
    return {
      acquire: async (key) => this.acquireFor(holder, key),
      renew: async (leaseId) => {
        this.renewCalls += 1;
        const lease = this.leases.get(leaseId);
        if (!lease || lease.holder !== holder || lease.expiresAt <= this.now) return { status: 'lost' };
        lease.expiresAt = this.now + this.ttlMs;
        return { status: 'renewed', ttlMs: this.ttlMs };
      },
      release: async (leaseId) => {
        this.releaseCalls += 1;
        const lease = this.leases.get(leaseId);
        if (lease && lease.holder === holder) this.leases.delete(leaseId);
      },
    };
  }
}

export function concurrentLimitMessage(model: string, slots: number): string {
  return `Concurrent limit reached for ${model}: ${slots}/${slots} slots in use. Wait for a request to complete or upgrade your plan for more.`;
}

export interface RateLimitedProvider extends ReviewModelClient {
  readonly observed: { inFlight: number; peak: number; rejected: number; completed: number };
}

/** An upstream with `slots` concurrent slots; each accepted call takes `durationMs`. */
export function rateLimitedProvider(options: { slots: number; durationMs: number }): RateLimitedProvider {
  const observed = { inFlight: 0, peak: 0, rejected: 0, completed: 0 };
  return {
    observed,
    async complete(request: OpenRouterRequest): Promise<OpenRouterResponse> {
      if (observed.inFlight >= options.slots) {
        observed.rejected += 1;
        throw new OpenRouterResponseError(
          `gateway.test HTTP 429: ${concurrentLimitMessage(request.model, options.slots)}`, 429);
      }
      observed.inFlight += 1;
      observed.peak = Math.max(observed.peak, observed.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, options.durationMs));
        observed.completed += 1;
        return { model: request.model, content: 'ok', usage: null, costUSD: null, raw: {} };
      } finally {
        observed.inFlight -= 1;
      }
    },
  };
}
