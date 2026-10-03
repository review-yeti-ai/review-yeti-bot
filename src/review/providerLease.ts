/**
 * Wire contract of `POST /api/dispatch/provider-lease`: a publishing worker leases one provider
 * concurrency slot before a model call, renews it while the call is in flight, and releases it
 * afterwards. One route, three request shapes, each bound to the worker's own run and execution
 * attempt and authenticated with its per-run bearer (the same as the checkpoint route).
 */
import { z } from 'zod';

export const PROVIDER_LEASE_ACQUIRE_VERSION = 'ProviderLeaseAcquire.v1' as const;
export const PROVIDER_LEASE_RENEW_VERSION = 'ProviderLeaseRenew.v1' as const;
export const PROVIDER_LEASE_RELEASE_VERSION = 'ProviderLeaseRelease.v1' as const;
export const PROVIDER_LEASE_RESPONSE_VERSION = 'ProviderLease.v1' as const;

/** The longest wait the service suggests before a denied worker asks again. */
export const MAX_PROVIDER_LEASE_RETRY_AFTER_MS = 30_000;
/** Bound on a lease response body; the answers are a few dozen bytes. */
export const MAX_PROVIDER_LEASE_RESPONSE_BYTES = 4_096;

const runId = z.string().regex(/^run_[a-f0-9]{32}$/u);
const executionAttempt = z.number().int().positive().safe();
const leaseId = z.string().uuid();
const capacityKey = z.string().regex(/^[a-z0-9][a-z0-9._:/@-]{0,127}$/u);

export const providerLeaseRequestSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(PROVIDER_LEASE_ACQUIRE_VERSION), runId, executionAttempt, capacityKey }).strict(),
  z.object({ version: z.literal(PROVIDER_LEASE_RENEW_VERSION), runId, executionAttempt, leaseId }).strict(),
  z.object({ version: z.literal(PROVIDER_LEASE_RELEASE_VERSION), runId, executionAttempt, leaseId }).strict(),
]);

export type ProviderLeaseRequest = z.infer<typeof providerLeaseRequestSchema>;

const ttlMs = z.number().int().positive().safe();

export const providerLeaseResponseSchema = z.discriminatedUnion('status', [
  /** A slot is held until `ttlMs` from now unless renewed. */
  z.object({ version: z.literal(PROVIDER_LEASE_RESPONSE_VERSION), status: z.literal('granted'), leaseId, ttlMs,
    capacity: z.number().int().positive().safe(), inUse: z.number().int().nonnegative().safe() }).strict(),
  /** Every slot is held; ask again after about `retryAfterMs`. */
  z.object({ version: z.literal(PROVIDER_LEASE_RESPONSE_VERSION), status: z.literal('denied'),
    retryAfterMs: z.number().int().positive().max(MAX_PROVIDER_LEASE_RETRY_AFTER_MS),
    capacity: z.number().int().positive().safe(), inUse: z.number().int().nonnegative().safe() }).strict(),
  /** The service does not coordinate this key; the worker uses only its local cap. */
  z.object({ version: z.literal(PROVIDER_LEASE_RESPONSE_VERSION), status: z.literal('unmanaged') }).strict(),
  z.object({ version: z.literal(PROVIDER_LEASE_RESPONSE_VERSION), status: z.literal('renewed'), ttlMs }).strict(),
  /** The lease expired (or was never this execution's); the slot is no longer counted. */
  z.object({ version: z.literal(PROVIDER_LEASE_RESPONSE_VERSION), status: z.literal('lost') }).strict(),
  z.object({ version: z.literal(PROVIDER_LEASE_RESPONSE_VERSION), status: z.literal('released') }).strict(),
]);

export type ProviderLeaseResponse = z.infer<typeof providerLeaseResponseSchema>;
