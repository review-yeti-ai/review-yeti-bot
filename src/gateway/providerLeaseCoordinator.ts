/**
 * The port the provider concurrency decorator (`./concurrencyLimitedModelClient`) consumes: one
 * worker's view of the cross-review lease coordinator. It is owned by the gateway layer that
 * consumes it; the review layer implements it over HTTP (`../review/providerLeaseHttp`) against
 * the wire contract in `../review/providerLease`.
 */

export type ProviderLeaseAcquireResult =
  | { status: 'granted'; leaseId: string; ttlMs: number; capacity: number; inUse: number }
  | { status: 'denied'; retryAfterMs: number; capacity: number; inUse: number }
  | { status: 'unmanaged' };

export type ProviderLeaseRenewResult = { status: 'renewed'; ttlMs: number } | { status: 'lost' };

/**
 * Any rejection means "coordinator unavailable": the caller fails open to its local cap.
 */
export interface ProviderLeaseCoordinator {
  acquire(capacityKey: string, signal?: AbortSignal): Promise<ProviderLeaseAcquireResult>;
  renew(leaseId: string, signal?: AbortSignal): Promise<ProviderLeaseRenewResult>;
  release(leaseId: string, signal?: AbortSignal): Promise<void>;
}
