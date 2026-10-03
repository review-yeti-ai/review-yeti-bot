import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConcurrencyLimitedModelClient,
  leaseWaitDelayMs,
  PROVIDER_LEASE_WAIT_MAX_DELAY_MS,
  withProviderConcurrencyLimit,
} from '../../src/gateway/concurrencyLimitedModelClient';
import {
  DEFAULT_LEASED_LOCAL_CONCURRENCY,
  parseProviderCapacityMap,
  providerConcurrencyWorkerConfigFromEnv,
  providerLeaseServiceConfigFromEnv,
} from '../../src/config/providerConcurrency';
import {
  planRateLimitRetry,
  RATE_LIMIT_RETRY_MAX_DELAY_MS,
  RATE_LIMIT_RETRY_WINDOW_MS,
  rateLimitRetryDelayMs,
} from '../../src/gateway/rateLimitBackoff';
import { HttpProviderLeaseCoordinator, providerLeaseEndpointFor } from '../../src/review/providerLeaseHttp';
import { providerPublishingModelClient } from '../../src/cli/publishingReview';
import type { OpenRouterRequest, ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { ProviderLeaseCoordinator } from '../../src/gateway/providerLeaseCoordinator';
import { MemoryLeaseBoard, rateLimitedProvider } from '../support/providerConcurrencyFixtures';

const MODEL = 'pr-reviewer';
const RUN_ID = `run_${'a'.repeat(32)}`;
const TOKEN = 'ghs_provider_lease_test_token';
const ENDPOINT = 'https://dispatch.example.test/api/dispatch/completion';

function request(overrides: Partial<OpenRouterRequest> = {}): OpenRouterRequest {
  return { model: MODEL, messages: [{ role: 'user', content: 'synthetic' }], timeoutMs: 600_000, ...overrides } as OpenRouterRequest;
}

/** Scaled-down real sleep so jittered waits stay realistic in ordering but fast in wall time. */
const fastSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('aborted')); return; }
  setTimeout(resolve, Math.max(1, Math.floor(ms / 50)));
});

/** One review: `lanes` concurrent lanes, each making `turns` sequential provider calls. */
async function runReview(client: ReviewModelClient, lanes: number, turns: number): Promise<'completed' | 'failed'> {
  const outcomes = await Promise.allSettled(Array.from({ length: lanes }, async () => {
    for (let turn = 0; turn < turns; turn += 1) await client.complete(request());
  }));
  return outcomes.every((outcome) => outcome.status === 'fulfilled') ? 'completed' : 'failed';
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('cross-review provider concurrency (shared coordinator)', () => {
  it('six concurrent reviews sharing one coordinator all complete and never exceed the configured capacity', async () => {
    const provider = rateLimitedProvider({ slots: 15, durationMs: 15 });
    const board = new MemoryLeaseBoard({ capacity: { [MODEL]: 12 } });
    const workers = Array.from({ length: 6 }, (_, index) => createConcurrencyLimitedModelClient(provider, {
      coordinator: board.coordinatorFor(`worker-${index}`), localConcurrency: 8, sleep: fastSleep,
    }));
    const outcomes = await Promise.all(workers.map((worker) => runReview(worker, 8, 3)));
    expect(outcomes).toEqual(Array(6).fill('completed'));
    expect(provider.observed.rejected).toBe(0);
    expect(provider.observed.completed).toBe(6 * 8 * 3);
    expect(provider.observed.peak).toBeLessThanOrEqual(12);
    expect(board.peakByKey.get(MODEL)).toBeLessThanOrEqual(12);
    expect(board.inUse(MODEL)).toBe(0);
    expect(workers.reduce((sum, worker) => sum + worker.stats().deniedWaits, 0)).toBeGreaterThan(0);
  });

  it('control: the same six reviews without the coordinator overrun the provider and are rejected with 429', async () => {
    const provider = rateLimitedProvider({ slots: 15, durationMs: 15 });
    const workers = Array.from({ length: 6 }, () => createConcurrencyLimitedModelClient(provider, { localConcurrency: 8 }));
    const outcomes = await Promise.all(workers.map((worker) => runReview(worker, 8, 3)));
    expect(provider.observed.rejected).toBeGreaterThan(0);
    expect(outcomes).toContain('failed');
  });

  it('a lease held by a crashed worker is reclaimed after its TTL and the waiting call proceeds', async () => {
    let clock = 1_000_000;
    const board = new MemoryLeaseBoard({ capacity: { [MODEL]: 2 }, ttlMs: 60_000, retryAfterMs: 2_000, now: () => clock });
    expect(board.grab(MODEL, 'crashed-worker')).toBeDefined();
    expect(board.grab(MODEL, 'crashed-worker')).toBeDefined();
    const calls: number[] = [];
    const client = createConcurrencyLimitedModelClient({
      complete: async (req) => { calls.push(clock); return { model: req.model, content: 'ok', usage: null, costUSD: null, raw: {} }; },
    }, {
      coordinator: board.coordinatorFor('live-worker'), now: () => clock, random: () => 0.5,
      sleep: async (ms) => { clock += ms; },
    });
    await client.complete(request({ timeoutMs: 600_000 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(1_000_000 + 60_000);
    expect(client.stats()).toMatchObject({ granted: 1, waitExhausted: 0, failedOpen: 0 });
    expect(board.inUse(MODEL)).toBe(0);
  });

  it('never waits past the call budget: when every slot stays held it proceeds without a lease', async () => {
    let clock = 0;
    const board = new MemoryLeaseBoard({ capacity: { [MODEL]: 1 }, ttlMs: 10_000_000, now: () => clock });
    board.grab(MODEL, 'other-worker');
    const inner = vi.fn(async (req: OpenRouterRequest) => ({ model: req.model, content: 'ok', usage: null, costUSD: null, raw: { timeoutMs: req.timeoutMs } }));
    const client = createConcurrencyLimitedModelClient({ complete: inner }, {
      coordinator: board.coordinatorFor('live'), now: () => clock, random: () => 1, sleep: async (ms) => { clock += ms; },
    });
    await client.complete(request({ timeoutMs: 120_000 }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(client.stats().waitExhausted).toBe(1);
    // Waiting kept at least half of the call's own budget (and never all of it) for the call itself.
    const forwarded = inner.mock.calls[0][0].timeoutMs;
    expect(forwarded).toBeGreaterThanOrEqual(60_000);
    expect(forwarded).toBeLessThanOrEqual(120_000);
    expect(clock).toBeLessThanOrEqual(60_000);
  });

  it('renews a long call\'s lease on a heartbeat and releases it exactly once afterwards', async () => {
    vi.useFakeTimers();
    const board = new MemoryLeaseBoard({ capacity: { [MODEL]: 4 }, ttlMs: 6_000 });
    let finish!: () => void;
    const client = createConcurrencyLimitedModelClient({
      complete: (req) => new Promise((resolve) => { finish = () => resolve({ model: req.model, content: 'ok', usage: null, costUSD: null, raw: {} }); }),
    }, { coordinator: board.coordinatorFor('worker') });
    const pending = client.complete(request());
    await vi.advanceTimersByTimeAsync(10);
    expect(board.inUse(MODEL)).toBe(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(board.renewCalls).toBeGreaterThanOrEqual(5);
    expect(board.inUse(MODEL)).toBe(1);
    finish();
    await pending;
    expect(board.releaseCalls).toBe(1);
    expect(board.inUse(MODEL)).toBe(0);
    const renewals = board.renewCalls;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(board.renewCalls).toBe(renewals);
  });

  it('releases the lease and the local slot when the provider call throws', async () => {
    const board = new MemoryLeaseBoard({ capacity: { [MODEL]: 1 } });
    const client = createConcurrencyLimitedModelClient({ complete: async () => { throw new Error('synthetic provider failure'); } }, {
      coordinator: board.coordinatorFor('worker'), localConcurrency: 1,
    });
    await expect(client.complete(request())).rejects.toThrow('synthetic provider failure');
    await expect(client.complete(request())).rejects.toThrow('synthetic provider failure');
    expect(board.inUse(MODEL)).toBe(0);
    expect(board.releaseCalls).toBe(2);
  });

  it('a call cancelled while queued for the local slot leaves the queue and leaks no slot', async () => {
    let finishFirst!: () => void;
    const inner = vi.fn((req: OpenRouterRequest) => new Promise<any>((resolve) => {
      const done = () => resolve({ model: req.model, content: 'ok', usage: null, costUSD: null, raw: {} });
      if (inner.mock.calls.length === 1) finishFirst = done; else done();
    }));
    const client = createConcurrencyLimitedModelClient({ complete: inner }, { localConcurrency: 1 });
    const first = client.complete(request());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const controller = new AbortController();
    const queued = client.complete(request({ signal: controller.signal }));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'OpenRouterTimeoutError' });
    finishFirst();
    await first;
    // The cancelled waiter is gone: the slot returns to the pool and the next call gets it.
    await expect(client.complete(request())).resolves.toMatchObject({ content: 'ok' });
    await expect(client.complete(request())).resolves.toMatchObject({ content: 'ok' });
    expect(inner).toHaveBeenCalledTimes(3);
    expect(client.stats().inFlight).toBe(0);
  });

  it('a lease lost while its call runs stops the heartbeat and is not released afterwards', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const renew = vi.fn(async () => ({ status: 'lost' as const }));
    const release = vi.fn(async () => undefined);
    const coordinator: ProviderLeaseCoordinator = {
      acquire: vi.fn(async () => ({ status: 'granted' as const, leaseId: '33333333-3333-4333-8333-333333333333', ttlMs: 3_000, capacity: 1, inUse: 1 })),
      renew, release,
    };
    const client = createConcurrencyLimitedModelClient({
      complete: (req) => new Promise((resolve) => { finish = () => resolve({ model: req.model, content: 'ok', usage: null, costUSD: null, raw: {} }); }),
    }, { coordinator });
    const pending = client.complete(request());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(client.stats().leasesLost).toBe(1);
    finish();
    await expect(pending).resolves.toMatchObject({ content: 'ok' });
    // The call finished normally without the lease, and nothing was released on its behalf.
    expect(release).not.toHaveBeenCalled();
  });

  it('a key the service does not manage proceeds under the local cap only', async () => {
    const board = new MemoryLeaseBoard({ capacity: { 'other-model': 1 } });
    const provider = rateLimitedProvider({ slots: 50, durationMs: 5 });
    const client = createConcurrencyLimitedModelClient(provider, { coordinator: board.coordinatorFor('worker'), localConcurrency: 3 });
    await runReview(client, 9, 2);
    expect(provider.observed.peak).toBeLessThanOrEqual(3);
    expect(client.stats().unmanaged).toBe(18);
  });

  it('stops waiting when the call is cancelled', async () => {
    const board = new MemoryLeaseBoard({ capacity: { [MODEL]: 1 } });
    board.grab(MODEL, 'other');
    const controller = new AbortController();
    const inner = vi.fn();
    const client = createConcurrencyLimitedModelClient({ complete: inner }, { coordinator: board.coordinatorFor('w') });
    const pending = client.complete(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'OpenRouterTimeoutError' });
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('coordinator unavailable: fail open to the local cap', () => {
  it('proceeds under the local cap when the coordinator rejects, and skips it during the cool-down', async () => {
    const acquire = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const coordinator: ProviderLeaseCoordinator = { acquire, renew: vi.fn(), release: vi.fn() };
    const provider = rateLimitedProvider({ slots: 50, durationMs: 5 });
    const client = createConcurrencyLimitedModelClient(provider, { coordinator, localConcurrency: 3 });
    expect(await runReview(client, 8, 3)).toBe('completed');
    expect(provider.observed.completed).toBe(24);
    expect(provider.observed.peak).toBeLessThanOrEqual(3);
    // Only the first burst (one probe per local slot) reaches the dead coordinator; the cool-down
    // keeps the other calls from asking it once each.
    expect(acquire.mock.calls.length).toBeLessThanOrEqual(3);
    expect(client.stats().failedOpen).toBeLessThanOrEqual(3);
  });

  it('treats an un-upgraded service (404) through the real HTTP client as unavailable, not as a failure', async () => {
    const fetchImplementation = vi.fn(async () => new Response('{"error":"not found"}', { status: 404 }));
    const coordinator = new HttpProviderLeaseCoordinator({ token: TOKEN, completionEndpoint: ENDPOINT, runId: RUN_ID,
      executionAttempt: 1, fetchImplementation: fetchImplementation as unknown as typeof fetch });
    const provider = rateLimitedProvider({ slots: 50, durationMs: 1 });
    const client = createConcurrencyLimitedModelClient(provider, { coordinator, localConcurrency: 2 });
    expect(await runReview(client, 4, 2)).toBe('completed');
    expect(provider.observed.peak).toBeLessThanOrEqual(2);
    expect(fetchImplementation.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('retries the coordinator after the cool-down elapses', async () => {
    let clock = 0;
    const acquire = vi.fn(async () => { throw new Error('HTTP 503'); });
    const client = createConcurrencyLimitedModelClient({ complete: async (req) => ({ model: req.model, content: '', usage: null, costUSD: null, raw: {} }) },
      { coordinator: { acquire, renew: vi.fn(), release: vi.fn() }, now: () => clock, coordinatorCooldownMs: 30_000 });
    await client.complete(request());
    clock = 29_999;
    await client.complete(request());
    expect(acquire).toHaveBeenCalledTimes(1);
    clock = 30_000;
    await client.complete(request());
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('returns the client unchanged when neither leases nor a local cap are configured', () => {
    const client: ReviewModelClient = { complete: vi.fn() };
    expect(withProviderConcurrencyLimit(client, {})).toBe(client);
    expect(providerPublishingModelClient(client, {}, undefined)).toBe(client);
    const coordinator: ProviderLeaseCoordinator = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn() };
    // A coordinator without the worker flag is ignored, so an unconfigured worker is unchanged.
    expect(providerPublishingModelClient(client, {}, coordinator)).toBe(client);
    expect(providerPublishingModelClient(client, { REVIEW_YETI_PROVIDER_LEASES: 'true' }, coordinator)).not.toBe(client);
  });
});

describe('provider concurrency configuration', () => {
  it('parses the service capacity map, including the * default, and rejects malformed entries', () => {
    const map = parseProviderCapacityMap('PR-Reviewer=12, bifrost/fast-model=4 ,*=6');
    expect([...map.capacities]).toEqual([['pr-reviewer', 12], ['bifrost/fast-model', 4]]);
    expect(map.wildcard).toBe(6);
    for (const bad of ['', 'pr-reviewer', 'pr-reviewer=0', 'pr-reviewer=1001', 'pr-reviewer=1.5', 'a=1,a=2', '*=1,*=2', 'bad key=3']) {
      expect(() => parseProviderCapacityMap(bad), bad).toThrow();
    }
  });

  it('reports a malformed service configuration as invalid instead of throwing, and bounds the TTL', () => {
    expect(providerLeaseServiceConfigFromEnv({})).toEqual({ status: 'disabled' });
    expect(providerLeaseServiceConfigFromEnv({ REVIEW_YETI_PROVIDER_CONCURRENCY: 'pr-reviewer=zero' }).status).toBe('invalid');
    expect(providerLeaseServiceConfigFromEnv({ REVIEW_YETI_PROVIDER_CONCURRENCY: 'pr-reviewer=12', REVIEW_YETI_PROVIDER_LEASE_TTL_MS: '10' }).status).toBe('invalid');
    expect(providerLeaseServiceConfigFromEnv({ REVIEW_YETI_PROVIDER_CONCURRENCY: 'pr-reviewer=12' })).toMatchObject({
      status: 'enabled', config: { ttlMs: 60_000 },
    });
  });

  it('keeps the worker unbounded by default and never unbounded once leases are enabled', () => {
    expect(providerConcurrencyWorkerConfigFromEnv({})).toEqual({ leasesEnabled: false });
    expect(providerConcurrencyWorkerConfigFromEnv({ REVIEW_YETI_PROVIDER_LEASES: 'true' }))
      .toEqual({ leasesEnabled: true, localConcurrency: DEFAULT_LEASED_LOCAL_CONCURRENCY });
    expect(providerConcurrencyWorkerConfigFromEnv({ REVIEW_YETI_PROVIDER_LEASES: 'true', REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY: 'many' }))
      .toEqual({ leasesEnabled: true, localConcurrency: DEFAULT_LEASED_LOCAL_CONCURRENCY });
    expect(providerConcurrencyWorkerConfigFromEnv({ REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY: '6', REVIEW_YETI_PROVIDER_LEASE_KEY: 'Bifrost/PR-Reviewer' }))
      .toEqual({ leasesEnabled: false, localConcurrency: 6, fixedKey: 'bifrost/pr-reviewer' });
    expect(providerConcurrencyWorkerConfigFromEnv({ REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY: '9999' }).localConcurrency).toBe(64);
  });
});

describe('lease wait backoff', () => {
  it('is jittered within [step/2, step] and capped per wait', () => {
    expect(leaseWaitDelayMs(0, 2_000, () => 0)).toBe(1_000);
    expect(leaseWaitDelayMs(0, 2_000, () => 1)).toBe(2_000);
    expect(leaseWaitDelayMs(20, 2_000, () => 1)).toBe(PROVIDER_LEASE_WAIT_MAX_DELAY_MS);
    expect(leaseWaitDelayMs(20, 2_000, () => 0)).toBe(PROVIDER_LEASE_WAIT_MAX_DELAY_MS / 2);
  });
});

describe('rate-limit retry ladder', () => {
  it('honours the sanitized Retry-After as a floor, even above the per-sleep cap', () => {
    expect(rateLimitRetryDelayMs(1, 7_000, () => 0)).toBe(7_000);
    expect(rateLimitRetryDelayMs(1, 45_000, () => 1)).toBe(45_000);
    expect(planRateLimitRetry({ retriesSoFar: 0, firstFailureAtMs: 0, nowMs: 0, retryAfterFloorMs: 7_000, budgetLeftMs: 60_000, random: () => 0 }))
      .toEqual({ retry: true, delayMs: 7_000, retryNumber: 1 });
  });

  it('keeps full jitter within [0, min(cap, base * 2^(n-1))]', () => {
    for (let retry = 1; retry <= 10; retry += 1) {
      const ceiling = Math.min(RATE_LIMIT_RETRY_MAX_DELAY_MS, 2_000 * 2 ** (retry - 1));
      expect(rateLimitRetryDelayMs(retry, 0, () => 0)).toBe(0);
      expect(rateLimitRetryDelayMs(retry, 0, () => 0.999_999)).toBeLessThanOrEqual(ceiling);
      expect(rateLimitRetryDelayMs(retry, 0, () => 0.999_999)).toBeGreaterThan(ceiling * 0.99);
    }
  });

  it('is bounded by the remaining budget, not by a small attempt count', () => {
    // Twenty retries are fine while the budget lasts (the transport ladder stops at five).
    expect(planRateLimitRetry({ retriesSoFar: 20, firstFailureAtMs: 0, nowMs: 120_000, retryAfterFloorMs: 0, budgetLeftMs: 600_000, random: () => 0.5 }).retry).toBe(true);
    expect(planRateLimitRetry({ retriesSoFar: 2, firstFailureAtMs: 0, nowMs: 0, retryAfterFloorMs: 10_000, budgetLeftMs: 10_000, random: () => 0 }))
      .toEqual({ retry: false, reason: 'budget' });
    expect(planRateLimitRetry({ retriesSoFar: 2, firstFailureAtMs: 0, nowMs: RATE_LIMIT_RETRY_WINDOW_MS - 1_000, retryAfterFloorMs: 1_000, budgetLeftMs: Infinity, random: () => 0 }))
      .toEqual({ retry: false, reason: 'window' });
    expect(planRateLimitRetry({ retriesSoFar: 0, firstFailureAtMs: 0, nowMs: 0, retryAfterFloorMs: Infinity, budgetLeftMs: Infinity }))
      .toEqual({ retry: false, reason: 'cooldown_exceeds_bound' });
  });
});

describe('HTTP lease coordinator', () => {
  it('posts to the completion endpoint\'s provider-lease sibling with the run-bound body and bearer', async () => {
    expect(providerLeaseEndpointFor(ENDPOINT)).toBe('https://dispatch.example.test/api/dispatch/provider-lease');
    const fetchImplementation = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      version: 'ProviderLease.v1', status: 'granted', leaseId: '11111111-1111-4111-8111-111111111111', ttlMs: 60_000, capacity: 12, inUse: 3,
    }), { status: 200 }));
    const coordinator = new HttpProviderLeaseCoordinator({ token: TOKEN, completionEndpoint: ENDPOINT, runId: RUN_ID,
      executionAttempt: 2, fetchImplementation: fetchImplementation as unknown as typeof fetch });
    await expect(coordinator.acquire('pr-reviewer')).resolves.toEqual({
      status: 'granted', leaseId: '11111111-1111-4111-8111-111111111111', ttlMs: 60_000, capacity: 12, inUse: 3,
    });
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://dispatch.example.test/api/dispatch/provider-lease');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ version: 'ProviderLeaseAcquire.v1', capacityKey: 'pr-reviewer', runId: RUN_ID, executionAttempt: 2 });
  });

  it.each([
    ['503', () => new Response('{}', { status: 503 })],
    ['429 from the route limiter', () => new Response('{}', { status: 429 })],
    ['malformed body', () => new Response('{"version":"ProviderLease.v1","status":"granted"}', { status: 200 })],
    ['oversized body', () => new Response('x'.repeat(10_000), { status: 200 })],
    ['network error', () => { throw new TypeError('fetch failed'); }],
  ])('rejects on %s so the caller fails open', async (_label, respond) => {
    const coordinator = new HttpProviderLeaseCoordinator({ token: TOKEN, completionEndpoint: ENDPOINT, runId: RUN_ID,
      executionAttempt: 1, fetchImplementation: (async () => respond()) as unknown as typeof fetch });
    await expect(coordinator.acquire('pr-reviewer')).rejects.toThrow('Provider lease coordinator unavailable');
  });

  it('refuses to construct with a non-installation token or a malformed run identity', () => {
    expect(() => new HttpProviderLeaseCoordinator({ token: 'not-a-token', completionEndpoint: ENDPOINT, runId: RUN_ID, executionAttempt: 1 })).toThrow();
    expect(() => new HttpProviderLeaseCoordinator({ token: TOKEN, completionEndpoint: ENDPOINT, runId: 'run_x', executionAttempt: 1 })).toThrow();
  });
});
