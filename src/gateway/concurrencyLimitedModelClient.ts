/**
 * A `ReviewModelClient` decorator that bounds how many provider calls are in flight, per worker
 * (an in-process cap) and across workers (a lease from the dispatch service's Postgres-backed
 * coordinator, see `../config/providerConcurrency`).
 *
 * Wrapping the one model client the publishing worker builds covers every call it makes: persona
 * lanes, moderator, arbiter, composed turns and map-reduce chunks.
 *
 * Per call:
 *   1. take a local slot (FIFO, abortable);
 *   2. lease a slot for the call's capacity key; when every slot is held, wait with jitter and ask
 *      again, never past the call's own deadline (minus a reserve so the call can still run);
 *   3. renew the lease while the call is in flight (heartbeat at a third of its TTL);
 *   4. release the lease and the local slot in `finally`.
 *
 * Fail open, always: a coordinator that is not configured, unreachable, slow, throttled or
 * answering malformed data makes the call proceed under the local cap only (and the coordinator is
 * skipped for a cool-down so a dead service is not asked once per call). Waiting that runs out of
 * budget proceeds without a lease. Coordination is never the reason a review fails; at worst the
 * provider rejects the overflow with a 429 and the engines' rate-limit ladder
 * (`./rateLimitBackoff`) rides it out.
 */
import { normalizeCapacityKey } from '../config/providerConcurrency';
import type { ProviderLeaseCoordinator } from '../review/providerLease';
import { logger } from '../utils/logger';
import { OpenRouterTimeoutError, type OpenRouterRequest, type OpenRouterResponse, type ReviewModelClient } from './openRouterClient';

/** How long the coordinator is skipped after it failed once. */
export const PROVIDER_COORDINATOR_COOLDOWN_MS = 30_000;
/** Ceiling on a single wait between denied lease requests. */
export const PROVIDER_LEASE_WAIT_MAX_DELAY_MS = 10_000;
/** Time kept for the provider call itself when deciding how long a lease wait may last. */
export const PROVIDER_LEASE_CALL_RESERVE_MS = 60_000;
/** Absolute bound on waiting for one lease when the call carries no usable deadline. */
export const PROVIDER_LEASE_MAX_WAIT_MS = 600_000;
/** Shortest heartbeat interval, whatever TTL the service reports. */
export const PROVIDER_LEASE_MIN_HEARTBEAT_MS = 1_000;

export interface ConcurrencyLimitedModelClientOptions {
  /** Cross-worker coordinator; absent means local cap only. */
  coordinator?: ProviderLeaseCoordinator;
  /** Per-worker in-process cap; absent means no local cap. */
  localConcurrency?: number;
  /** Capacity key for every call; otherwise the normalized request model. */
  fixedKey?: string;
  /** Absolute instant (epoch ms) no lease wait may extend past, e.g. the worker's work cutoff. */
  deadlineAtMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  coordinatorCooldownMs?: number;
}

export interface ConcurrencyLimiterStats {
  granted: number;
  deniedWaits: number;
  unmanaged: number;
  failedOpen: number;
  waitExhausted: number;
  leasesLost: number;
  inFlight: number;
  peakInFlight: number;
}

function cancelled(): OpenRouterTimeoutError {
  return new OpenRouterTimeoutError('OpenRouter request was cancelled', 'request');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** FIFO counting semaphore whose waiters can be cancelled. */
export class AbortableSemaphore {
  private available: number;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Semaphore capacity must be a positive integer');
    this.available = capacity;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(cancelled());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }
    this.available = Math.min(this.capacity, this.available + 1);
  }
}

/**
 * Equal-jitter backoff between denied lease requests: half the step is fixed so waiters do not
 * spin, half is random so they do not re-ask in one synchronized burst.
 */
export function leaseWaitDelayMs(attempt: number, suggestedMs: number, random: () => number = Math.random): number {
  const base = Math.max(250, Number.isFinite(suggestedMs) ? suggestedMs : 2_000);
  const step = Math.min(PROVIDER_LEASE_WAIT_MAX_DELAY_MS, base * Math.pow(1.5, Math.max(0, attempt)));
  const unit = Math.min(Math.max(random(), 0), 1);
  return Math.floor(step / 2 + unit * (step / 2));
}

export interface ConcurrencyLimitedModelClient extends ReviewModelClient {
  stats(): ConcurrencyLimiterStats;
}

/**
 * Wraps `client`. With neither a coordinator nor a local cap the client is returned unchanged, so
 * an unconfigured deployment behaves exactly as before.
 */
export function withProviderConcurrencyLimit(
  client: ReviewModelClient,
  options: ConcurrencyLimitedModelClientOptions,
): ReviewModelClient {
  if (!options.coordinator && options.localConcurrency === undefined) return client;
  return createConcurrencyLimitedModelClient(client, options);
}

export function createConcurrencyLimitedModelClient(
  client: ReviewModelClient,
  options: ConcurrencyLimitedModelClientOptions,
): ConcurrencyLimitedModelClient {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableDelay;
  const cooldownMs = options.coordinatorCooldownMs ?? PROVIDER_COORDINATOR_COOLDOWN_MS;
  const local = options.localConcurrency !== undefined ? new AbortableSemaphore(options.localConcurrency) : undefined;
  const coordinator = options.coordinator;
  let coordinatorSkippedUntil = 0;
  const stats: ConcurrencyLimiterStats = {
    granted: 0, deniedWaits: 0, unmanaged: 0, failedOpen: 0, waitExhausted: 0, leasesLost: 0, inFlight: 0, peakInFlight: 0,
  };

  const failOpen = (key: string) => {
    stats.failedOpen += 1;
    if (now() >= coordinatorSkippedUntil) {
      logger.warn('Provider lease coordinator unavailable; proceeding under the local concurrency cap', {
        capacityKey: key, localConcurrency: options.localConcurrency ?? null, cooldownMs,
      });
    }
    coordinatorSkippedUntil = now() + cooldownMs;
  };

  /** A granted lease (id and TTL), or undefined when the call proceeds without one. */
  async function lease(key: string, callDeadlineMs: number, signal?: AbortSignal): Promise<{ leaseId: string; ttlMs: number } | undefined> {
    if (!coordinator || now() < coordinatorSkippedUntil) return undefined;
    // Fixed once per call: waiting may use the call's budget minus a reserve for the call itself
    // (at most PROVIDER_LEASE_CALL_RESERVE_MS, at most half), never the whole budget.
    const budgetMs = callDeadlineMs - now();
    const waitDeadlineMs = now() + Math.min(PROVIDER_LEASE_MAX_WAIT_MS, budgetMs - Math.min(PROVIDER_LEASE_CALL_RESERVE_MS, budgetMs / 2));
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw cancelled();
      let result: Awaited<ReturnType<ProviderLeaseCoordinator['acquire']>>;
      try {
        result = await coordinator.acquire(key, signal);
      } catch {
        if (signal?.aborted) throw cancelled();
        failOpen(key);
        return undefined;
      }
      if (result.status === 'granted') {
        stats.granted += 1;
        return { leaseId: result.leaseId, ttlMs: result.ttlMs };
      }
      if (result.status === 'unmanaged') {
        stats.unmanaged += 1;
        return undefined;
      }
      const delayMs = leaseWaitDelayMs(attempt, result.retryAfterMs, random);
      if (!(delayMs < waitDeadlineMs - now())) {
        stats.waitExhausted += 1;
        logger.warn('Provider lease wait budget exhausted; proceeding without a lease', {
          capacityKey: key, capacity: result.capacity, inUse: result.inUse, attempts: attempt + 1,
        });
        return undefined;
      }
      stats.deniedWaits += 1;
      await sleep(delayMs, signal);
    }
  }

  function heartbeat(key: string, held: { leaseId: string | undefined }, ttlMs: number): () => void {
    if (!coordinator) return () => undefined;
    const intervalMs = Math.max(PROVIDER_LEASE_MIN_HEARTBEAT_MS, Math.floor(ttlMs / 3));
    let renewing = false;
    const timer = setInterval(() => {
      const leaseId = held.leaseId;
      if (!leaseId || renewing) return;
      renewing = true;
      void coordinator.renew(leaseId).then((result) => {
        if (result.status === 'lost' && held.leaseId === leaseId) {
          held.leaseId = undefined;
          stats.leasesLost += 1;
          logger.warn('Provider lease expired while its call was in flight; continuing without it', { capacityKey: key });
        }
      }).catch(() => undefined).finally(() => { renewing = false; });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return {
    stats: () => ({ ...stats }),
    async complete(request: OpenRouterRequest): Promise<OpenRouterResponse> {
      const startedAt = now();
      const requestTimeoutMs = Number(request.timeoutMs);
      const ownDeadline = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? startedAt + requestTimeoutMs : Infinity;
      const callDeadlineMs = Math.min(ownDeadline, options.deadlineAtMs ?? Infinity);
      const key = options.fixedKey ?? normalizeCapacityKey(request.model);

      if (local) await local.acquire(request.signal);
      const held: { leaseId: string | undefined } = { leaseId: undefined };
      let stopHeartbeat: () => void = () => undefined;
      stats.inFlight += 1;
      stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
      try {
        if (key) {
          const granted = await lease(key, callDeadlineMs, request.signal);
          if (granted) {
            held.leaseId = granted.leaseId;
            stopHeartbeat = heartbeat(key, held, granted.ttlMs);
          }
        }
        const waitedMs = now() - startedAt;
        const forwarded = waitedMs > 0 && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
          ? { ...request, timeoutMs: Math.max(1, requestTimeoutMs - waitedMs) }
          : request;
        return await client.complete(forwarded);
      } finally {
        stopHeartbeat();
        stats.inFlight -= 1;
        const leaseId = held.leaseId;
        held.leaseId = undefined;
        if (leaseId && coordinator) await coordinator.release(leaseId).catch(() => undefined);
        local?.release();
      }
    },
  };
}
