/**
 * Cross-review provider concurrency leases (see `../config/providerConcurrency` for why).
 *
 * One row per in-flight provider call. A key's capacity is the number of unexpired rows it may
 * have. Acquire serializes per key on a transaction-scoped advisory lock, reaps that key's expired
 * rows, counts what is left and inserts only below capacity, all in one transaction, so two
 * workers can never both take the last slot. A worker that crashes simply stops renewing; its row
 * expires after the TTL and the next acquire for that key reaps it.
 *
 * The table has no foreign key to `review_runs` on purpose: acquire/renew/release run once per
 * model call, and a key-share lock on that hot table per call buys nothing a TTL does not already
 * guarantee.
 */
import { randomUUID } from 'node:crypto';
import { capacityFor, type ProviderLeaseServiceConfig } from '../config/providerConcurrency';
import { workerExecutionAuthorized, type Queryable } from './incrementalPriorReview';
import { withReviewPrTransaction, type ReviewPrTransactionPool } from './reviewPrTransaction';
import type { ProviderLeaseAcquireResult } from '../review/providerLease';

export const PROVIDER_CONCURRENCY_LEASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS provider_concurrency_leases (
    lease_id UUID PRIMARY KEY,
    capacity_key TEXT NOT NULL CHECK (capacity_key ~ '^[a-z0-9][a-z0-9._:/@-]{0,127}$'),
    run_id TEXT NOT NULL CHECK (run_id ~ '^run_[a-f0-9]{32}$'),
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS provider_concurrency_leases_key_expiry_idx
    ON provider_concurrency_leases (capacity_key, expires_at);
  CREATE INDEX IF NOT EXISTS provider_concurrency_leases_run_idx
    ON provider_concurrency_leases (run_id, execution_attempt);
`;

/** What the service suggests a denied worker waits before asking again. */
export const PROVIDER_LEASE_DENIED_RETRY_AFTER_MS = 2_000;

export interface ProviderLeaseCaller {
  runId: string;
  executionAttempt: number;
  workerTokenDigest: string;
}

export type StoreAcquireResult = { status: 'unauthorized' } | ProviderLeaseAcquireResult;
export type StoreRenewResult = { status: 'unauthorized' } | { status: 'renewed'; ttlMs: number } | { status: 'lost' };
export type StoreReleaseResult = { status: 'unauthorized' } | { status: 'released' };

/** The service side of the coordinator; `PostgresProviderLeaseStore` is the production one. */
export interface ProviderLeaseStore {
  acquire(caller: ProviderLeaseCaller, capacityKey: string): Promise<StoreAcquireResult>;
  renew(caller: ProviderLeaseCaller, leaseId: string): Promise<StoreRenewResult>;
  release(caller: ProviderLeaseCaller, leaseId: string): Promise<StoreReleaseResult>;
}

export type ProviderLeaseDatabase = Queryable & ReviewPrTransactionPool;

export function providerLeaseLockKey(capacityKey: string): string {
  return `provider-concurrency-lease:${capacityKey}`;
}

export class PostgresProviderLeaseStore implements ProviderLeaseStore {
  constructor(
    private readonly database: ProviderLeaseDatabase,
    private readonly config: ProviderLeaseServiceConfig,
    private readonly newLeaseId: () => string = randomUUID,
  ) {}

  async acquire(caller: ProviderLeaseCaller, capacityKey: string): Promise<StoreAcquireResult> {
    const capacity = capacityFor(this.config.capacity, capacityKey);
    return withReviewPrTransaction(this.database, async (client) => {
      if (!await workerExecutionAuthorized(client, caller)) return { status: 'unauthorized' as const };
      if (capacity === undefined) return { status: 'unmanaged' as const };
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [providerLeaseLockKey(capacityKey)]);
      await client.query(
        'DELETE FROM provider_concurrency_leases WHERE capacity_key = $1 AND expires_at <= clock_timestamp()',
        [capacityKey],
      );
      const counted = await client.query(
        `SELECT COUNT(*)::int AS in_use FROM provider_concurrency_leases
          WHERE capacity_key = $1 AND expires_at > clock_timestamp()`,
        [capacityKey],
      );
      const inUse = Number(counted.rows[0]?.in_use ?? 0);
      if (!Number.isSafeInteger(inUse) || inUse < 0) throw new Error('Provider lease count is unavailable');
      if (inUse >= capacity) {
        return { status: 'denied' as const, retryAfterMs: PROVIDER_LEASE_DENIED_RETRY_AFTER_MS, capacity, inUse };
      }
      const leaseId = this.newLeaseId();
      await client.query(
        `INSERT INTO provider_concurrency_leases (lease_id, capacity_key, run_id, execution_attempt, expires_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() + ($5::int * interval '1 millisecond'))`,
        [leaseId, capacityKey, caller.runId, caller.executionAttempt, this.config.ttlMs],
      );
      return { status: 'granted' as const, leaseId, ttlMs: this.config.ttlMs, capacity, inUse: inUse + 1 };
    });
  }

  async renew(caller: ProviderLeaseCaller, leaseId: string): Promise<StoreRenewResult> {
    return withReviewPrTransaction(this.database, async (client) => {
      if (!await workerExecutionAuthorized(client, caller)) return { status: 'unauthorized' as const };
      // Only a live lease is renewed: an expired one may already have been counted out and its
      // slot handed to another worker, so reviving it would overshoot the capacity.
      const renewed = await client.query(
        `UPDATE provider_concurrency_leases
            SET expires_at = clock_timestamp() + ($4::int * interval '1 millisecond')
          WHERE lease_id = $1 AND run_id = $2 AND execution_attempt = $3 AND expires_at > clock_timestamp()
          RETURNING lease_id`,
        [leaseId, caller.runId, caller.executionAttempt, this.config.ttlMs],
      );
      return renewed.rows.length > 0 ? { status: 'renewed' as const, ttlMs: this.config.ttlMs } : { status: 'lost' as const };
    });
  }

  async release(caller: ProviderLeaseCaller, leaseId: string): Promise<StoreReleaseResult> {
    return withReviewPrTransaction(this.database, async (client) => {
      if (!await workerExecutionAuthorized(client, caller)) return { status: 'unauthorized' as const };
      await client.query(
        'DELETE FROM provider_concurrency_leases WHERE lease_id = $1 AND run_id = $2 AND execution_attempt = $3',
        [leaseId, caller.runId, caller.executionAttempt],
      );
      return { status: 'released' as const };
    });
  }
}
