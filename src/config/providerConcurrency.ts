/**
 * Cross-review provider concurrency: configuration shared by the dispatch service (which owns the
 * lease table and the per-key capacity) and the publishing worker (which leases a slot before each
 * model call).
 *
 * WHY THIS EXISTS
 *
 * Every review runs in its own worker pod and fans out several concurrent provider calls (persona
 * lanes, map-reduce chunks, composed tasks). An upstream provider account with a hard concurrent
 * request cap (for example 15 slots, shared with other gateway keys) rejects the overflow with
 * HTTP 429 "Concurrent limit reached". With three or more reviews in flight, the sum of their
 * fan-outs routinely exceeds that cap. An in-process semaphore cannot coordinate across pods, so
 * the service keeps a small Postgres lease table keyed by provider/model and each worker holds one
 * lease per in-flight call.
 *
 * Everything here is off by default and fail-open:
 * - the service mounts the lease route only when `REVIEW_YETI_PROVIDER_CONCURRENCY` parses;
 * - the worker asks for leases only when `REVIEW_YETI_PROVIDER_LEASES=true`;
 * - a worker that cannot reach the coordinator (unset, 404, 5xx, timeout, malformed answer)
 *   proceeds under its per-worker local cap. Coordination is never the reason a review fails.
 */

/** Service: `key=slots` pairs, comma separated; `*` is the capacity for any other key. */
export const PROVIDER_CONCURRENCY_ENV = 'REVIEW_YETI_PROVIDER_CONCURRENCY';
/** Service: lease time-to-live; a holder that stops renewing frees its slot after this long. */
export const PROVIDER_LEASE_TTL_ENV = 'REVIEW_YETI_PROVIDER_LEASE_TTL_MS';
/** Worker: `true` to lease a slot from the service before each provider call. */
export const PROVIDER_LEASES_ENV = 'REVIEW_YETI_PROVIDER_LEASES';
/** Worker: optional fixed capacity key used for every call instead of the request model. */
export const PROVIDER_LEASE_KEY_ENV = 'REVIEW_YETI_PROVIDER_LEASE_KEY';
/** Worker: per-worker in-process cap on concurrent provider calls. */
export const PROVIDER_LOCAL_CONCURRENCY_ENV = 'REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY';

export const DEFAULT_PROVIDER_LEASE_TTL_MS = 60_000;
export const MIN_PROVIDER_LEASE_TTL_MS = 5_000;
export const MAX_PROVIDER_LEASE_TTL_MS = 600_000;
export const MAX_PROVIDER_SLOTS = 1_000;
export const MAX_PROVIDER_LOCAL_CONCURRENCY = 64;
/**
 * The local cap a worker uses when leases are enabled but no explicit local cap is configured. It
 * is what bounds the worker if the coordinator becomes unreachable; it equals the default lane cap
 * so a single review's lanes still run side by side.
 */
export const DEFAULT_LEASED_LOCAL_CONCURRENCY = 8;

const CAPACITY_KEY = /^[a-z0-9][a-z0-9._:/@-]{0,127}$/u;

/** A lower-cased capacity key, or undefined when the value cannot be one. */
export function normalizeCapacityKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  return CAPACITY_KEY.test(key) ? key : undefined;
}

export interface ProviderCapacityMap {
  /** Exact keys and their slot counts. */
  readonly capacities: ReadonlyMap<string, number>;
  /** Capacity for a key not listed; undefined means unlisted keys are unmanaged. */
  readonly wildcard?: number;
}

function parseSlots(raw: string): number | undefined {
  if (!/^\d+$/u.test(raw)) return undefined;
  const slots = Number(raw);
  return Number.isSafeInteger(slots) && slots >= 1 && slots <= MAX_PROVIDER_SLOTS ? slots : undefined;
}

/** Parses `key=slots[,key=slots...]`. Throws on any malformed entry. */
export function parseProviderCapacityMap(raw: string): ProviderCapacityMap {
  const capacities = new Map<string, number>();
  let wildcard: number | undefined;
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`${PROVIDER_CONCURRENCY_ENV} has no entries`);
  for (const entry of entries) {
    const separator = entry.lastIndexOf('=');
    if (separator <= 0) throw new Error(`${PROVIDER_CONCURRENCY_ENV} entry must be key=slots`);
    const rawKey = entry.slice(0, separator).trim();
    const slots = parseSlots(entry.slice(separator + 1).trim());
    if (slots === undefined) throw new Error(`${PROVIDER_CONCURRENCY_ENV} slots must be a whole number from 1 to ${MAX_PROVIDER_SLOTS}`);
    if (rawKey === '*') {
      if (wildcard !== undefined) throw new Error(`${PROVIDER_CONCURRENCY_ENV} repeats the * entry`);
      wildcard = slots;
      continue;
    }
    const key = normalizeCapacityKey(rawKey);
    if (!key) throw new Error(`${PROVIDER_CONCURRENCY_ENV} has an invalid key`);
    if (capacities.has(key)) throw new Error(`${PROVIDER_CONCURRENCY_ENV} repeats a key`);
    capacities.set(key, slots);
  }
  return { capacities, ...(wildcard !== undefined ? { wildcard } : {}) };
}

/** Slots for `key`, or undefined when the key is not coordinated. */
export function capacityFor(map: ProviderCapacityMap, key: string): number | undefined {
  return map.capacities.get(key) ?? map.wildcard;
}

export interface ProviderLeaseServiceConfig {
  readonly capacity: ProviderCapacityMap;
  readonly ttlMs: number;
}

export type ProviderLeaseServiceConfigResult =
  | { status: 'disabled' }
  | { status: 'invalid'; reason: string }
  | { status: 'enabled'; config: ProviderLeaseServiceConfig };

/**
 * The service's lease configuration. Absent means the route is not mounted and workers fail open
 * to their local cap. A malformed value is reported as `invalid` (the caller logs it and leaves the
 * route unmounted) rather than thrown: a typo in a capacity map must not stop the dispatch service.
 */
export function providerLeaseServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderLeaseServiceConfigResult {
  const raw = String(env[PROVIDER_CONCURRENCY_ENV] ?? '').trim();
  if (!raw) return { status: 'disabled' };
  let capacity: ProviderCapacityMap;
  try {
    capacity = parseProviderCapacityMap(raw);
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'invalid capacity map' };
  }
  const rawTtl = String(env[PROVIDER_LEASE_TTL_ENV] ?? '').trim();
  let ttlMs = DEFAULT_PROVIDER_LEASE_TTL_MS;
  if (rawTtl) {
    const parsed = /^\d+$/u.test(rawTtl) ? Number(rawTtl) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < MIN_PROVIDER_LEASE_TTL_MS || parsed > MAX_PROVIDER_LEASE_TTL_MS) {
      return { status: 'invalid', reason: `${PROVIDER_LEASE_TTL_ENV} must be from ${MIN_PROVIDER_LEASE_TTL_MS} to ${MAX_PROVIDER_LEASE_TTL_MS}` };
    }
    ttlMs = parsed;
  }
  return { status: 'enabled', config: { capacity, ttlMs } };
}

export interface ProviderConcurrencyWorkerConfig {
  /** Whether the worker asks the service for a lease before each provider call. */
  readonly leasesEnabled: boolean;
  /** A fixed capacity key for every call; otherwise the request model is the key. */
  readonly fixedKey?: string;
  /** Per-worker in-process cap; undefined means no local cap. */
  readonly localConcurrency?: number;
}

/**
 * The worker's concurrency settings. Every malformed value degrades to the safe default (never to
 * an unbounded value when leases are enabled, never to a failure).
 */
export function providerConcurrencyWorkerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderConcurrencyWorkerConfig {
  const leasesEnabled = String(env[PROVIDER_LEASES_ENV] ?? '').trim().toLowerCase() === 'true';
  const fixedKey = normalizeCapacityKey(env[PROVIDER_LEASE_KEY_ENV]);
  const rawLocal = String(env[PROVIDER_LOCAL_CONCURRENCY_ENV] ?? '').trim();
  const parsedLocal = /^\d+$/u.test(rawLocal) ? Number(rawLocal) : Number.NaN;
  const explicitLocal = Number.isSafeInteger(parsedLocal) && parsedLocal >= 1
    ? Math.min(parsedLocal, MAX_PROVIDER_LOCAL_CONCURRENCY)
    : undefined;
  const localConcurrency = explicitLocal ?? (leasesEnabled ? DEFAULT_LEASED_LOCAL_CONCURRENCY : undefined);
  return {
    leasesEnabled,
    ...(fixedKey ? { fixedKey } : {}),
    ...(localConcurrency !== undefined ? { localConcurrency } : {}),
  };
}
