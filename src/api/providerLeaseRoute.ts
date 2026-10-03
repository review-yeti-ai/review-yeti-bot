/**
 * `POST /api/dispatch/provider-lease`. A publishing worker, with its own per-run bearer, leases one
 * provider concurrency slot before a model call, renews it while the call runs, and releases it
 * afterwards (see `../config/providerConcurrency`).
 *
 * The answer is advisory for the worker: any non-200 answer makes it proceed under its local cap.
 * It is never authority over a review outcome.
 */
import type { Request, Response } from 'express';
import { sha256 } from '../review/reviewCore';
import {
  PROVIDER_LEASE_ACQUIRE_VERSION,
  PROVIDER_LEASE_RENEW_VERSION,
  PROVIDER_LEASE_RESPONSE_VERSION,
  providerLeaseRequestSchema,
} from '../review/providerLease';
import type { ProviderLeaseStore } from '../persistence/providerConcurrencyLeaseRepository';
import { logger } from '../utils/logger';

function workerBearer(request: Request): string | null {
  return /^Bearer\s+(ghs_[^\s]+)$/iu.exec(request.header('authorization') ?? '')?.[1] ?? null;
}

/** Rate-limit key for the lease route: the caller's per-run bearer digest, never its raw value. */
export function providerLeaseRateLimitKey(request: Request): string {
  const bearer = workerBearer(request);
  return bearer ? `lease:${sha256(bearer)}` : `ip:${request.ip ?? 'unknown'}`;
}

export function createProviderLeaseHandler(store: ProviderLeaseStore) {
  return async (request: Request, response: Response) => {
    const bearer = workerBearer(request);
    if (!bearer) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const parsed = providerLeaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid provider lease request' });
    const body = parsed.data;
    const caller = { runId: body.runId, executionAttempt: body.executionAttempt, workerTokenDigest: sha256(bearer) };
    try {
      const result = body.version === PROVIDER_LEASE_ACQUIRE_VERSION
        ? await store.acquire(caller, body.capacityKey)
        : body.version === PROVIDER_LEASE_RENEW_VERSION
          ? await store.renew(caller, body.leaseId)
          : await store.release(caller, body.leaseId);
      if (result.status === 'unauthorized') {
        return response.status(403).json({ error: 'Worker is not authorized for this execution' });
      }
      return response.status(200).json({ version: PROVIDER_LEASE_RESPONSE_VERSION, ...result });
    } catch {
      logger.warn('Provider lease store unavailable', { reason: 'persistence_unavailable', runId: body.runId });
      return response.status(503).json({ error: 'Provider lease coordination is temporarily unavailable' });
    }
  };
}
