import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresProviderLeaseStore,
  PROVIDER_CONCURRENCY_LEASE_SCHEMA_SQL,
} from '../../src/persistence/providerConcurrencyLeaseRepository';
import { parseProviderCapacityMap } from '../../src/config/providerConcurrency';
import { createActionDispatchApp } from '../../src/dispatchServer';
import { sha256 } from '../../src/review/reviewCore';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

// Skip locally without a database, fail loudly in CI if the database URL is lost.
requireDatabaseUrlInCi();

/**
 * Cross-review provider concurrency leases in real SQL: capacity is counted and granted inside one
 * transaction per key (so concurrent workers can never both take the last slot), an expired holder
 * is reaped by the next acquire, and only the bearer of the live execution may lease, renew or
 * release.
 */
const databaseUrl = postgresDatabaseUrl();
const OWNED_SCHEMA = /^provider_lease_test_[0-9a-f]{16}$/u;
const TOKEN = 'ghs_provider_lease_postgres_token';
const KEY = 'pr-reviewer';

function runId(number: number): string {
  return `run_${number.toString(16).padStart(32, '0')}`;
}

describeWithPostgres('provider concurrency leases (real SQL)', () => {
  let pool: Pool | undefined;
  let schemaName: string | undefined;

  function storeFor(capacity: string, ttlMs = 60_000): PostgresProviderLeaseStore {
    return new PostgresProviderLeaseStore(pool!, { capacity: parseProviderCapacityMap(capacity), ttlMs });
  }

  async function insertRun(id: string, options: { status?: string; executionAttempt?: number; token?: string } = {}): Promise<void> {
    await pool!.query(`INSERT INTO review_runs (run_id, status) VALUES ($1, $2)`, [id, options.status ?? 'running']);
    await pool!.query(`INSERT INTO review_dispatch_outbox (run_id, execution_attempt, worker_token_digest) VALUES ($1, $2, $3)`,
      [id, options.executionAttempt ?? 0, sha256(options.token ?? TOKEN)]);
  }

  const caller = (id: string, executionAttempt = 1, token = TOKEN) => ({ runId: id, executionAttempt, workerTokenDigest: sha256(token) });

  async function liveLeases(key = KEY): Promise<number> {
    return Number((await pool!.query(
      'SELECT COUNT(*)::int AS n FROM provider_concurrency_leases WHERE capacity_key = $1 AND expires_at > clock_timestamp()', [key],
    )).rows[0].n);
  }

  beforeAll(async () => {
    schemaName = `provider_lease_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schemaName}` });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      // The two columns `workerExecutionAuthorized` reads, in the production shape.
      await client.query(`
        CREATE TABLE review_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE review_dispatch_outbox (
          run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
          execution_attempt INTEGER NOT NULL DEFAULT 0, worker_token_digest VARCHAR(64)
        );
      `);
      await client.query(PROVIDER_CONCURRENCY_LEASE_SCHEMA_SQL);
      // The DDL is idempotent, as the schema gate requires.
      await client.query(PROVIDER_CONCURRENCY_LEASE_SCHEMA_SQL);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    await pool?.query('TRUNCATE provider_concurrency_leases, review_dispatch_outbox, review_runs CASCADE');
  });

  afterAll(async () => {
    if (!schemaName) return;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error(`Refusing to drop unowned schema: ${schemaName}`);
    try { await pool?.query(`DROP SCHEMA "${schemaName}" CASCADE`); } finally { await pool?.end(); pool = undefined; }
  });

  it('grants exactly the capacity when many workers race for the last slots', async () => {
    const ids = Array.from({ length: 6 }, (_, index) => runId(index + 1));
    for (const id of ids) await insertRun(id);
    const store = storeFor(`${KEY}=5`);
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => store.acquire(caller(ids[index % ids.length]), KEY)));
    expect(results.filter((result) => result.status === 'granted')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'denied')).toHaveLength(25);
    expect(results.find((result) => result.status === 'denied')).toMatchObject({ retryAfterMs: 2_000, capacity: 5, inUse: 5 });
    expect(await liveLeases()).toBe(5);
  });

  it('reclaims a crashed holder\'s slot once its lease expires', async () => {
    await insertRun(runId(1));
    await insertRun(runId(2));
    const store = storeFor(`${KEY}=2`);
    const crashed = await store.acquire(caller(runId(1)), KEY);
    expect(crashed.status).toBe('granted');
    expect((await store.acquire(caller(runId(1)), KEY)).status).toBe('granted');
    expect((await store.acquire(caller(runId(2)), KEY)).status).toBe('denied');
    // The crashed worker never renews: its lease runs out.
    await pool!.query(`UPDATE provider_concurrency_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_id = $1`,
      [(crashed as { leaseId: string }).leaseId]);
    const reclaimed = await store.acquire(caller(runId(2)), KEY);
    expect(reclaimed).toMatchObject({ status: 'granted', inUse: 2 });
    const rows = (await pool!.query('SELECT lease_id FROM provider_concurrency_leases')).rows.map((row) => row.lease_id);
    expect(rows).not.toContain((crashed as { leaseId: string }).leaseId);
  });

  it('renews only a live lease, and an expired one stays lost', async () => {
    await insertRun(runId(1));
    const store = storeFor(`${KEY}=2`);
    const live = await store.acquire(caller(runId(1)), KEY) as { leaseId: string };
    await pool!.query(`UPDATE provider_concurrency_leases SET expires_at = clock_timestamp() + interval '1 second' WHERE lease_id = $1`, [live.leaseId]);
    expect(await store.renew(caller(runId(1)), live.leaseId)).toEqual({ status: 'renewed', ttlMs: 60_000 });
    const expiresInMs = Number((await pool!.query(
      `SELECT EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000 AS ms FROM provider_concurrency_leases WHERE lease_id = $1`, [live.leaseId],
    )).rows[0].ms);
    expect(expiresInMs).toBeGreaterThan(50_000);
    await pool!.query(`UPDATE provider_concurrency_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_id = $1`, [live.leaseId]);
    expect(await store.renew(caller(runId(1)), live.leaseId)).toEqual({ status: 'lost' });
    expect(await liveLeases()).toBe(0);
  });

  it('frees a slot on release, and never releases another execution\'s lease', async () => {
    await insertRun(runId(1));
    await insertRun(runId(2), { token: 'ghs_second_worker_token' });
    const store = storeFor(`${KEY}=1`);
    const held = await store.acquire(caller(runId(1)), KEY) as { leaseId: string };
    expect(await store.release(caller(runId(2), 1, 'ghs_second_worker_token'), held.leaseId)).toEqual({ status: 'released' });
    expect(await liveLeases()).toBe(1);
    expect((await store.acquire(caller(runId(2), 1, 'ghs_second_worker_token'), KEY)).status).toBe('denied');
    expect(await store.release(caller(runId(1)), held.leaseId)).toEqual({ status: 'released' });
    expect((await store.acquire(caller(runId(2), 1, 'ghs_second_worker_token'), KEY)).status).toBe('granted');
  });

  it('takes no slot for a wrong token, another attempt, or a finished run', async () => {
    await insertRun(runId(1));
    await insertRun(runId(2), { status: 'succeeded' });
    const store = storeFor(`${KEY}=3`);
    expect(await store.acquire(caller(runId(1), 1, 'ghs_wrong_token'), KEY)).toEqual({ status: 'unauthorized' });
    expect(await store.acquire(caller(runId(1), 2), KEY)).toEqual({ status: 'unauthorized' });
    expect(await store.acquire(caller(runId(2)), KEY)).toEqual({ status: 'unauthorized' });
    expect(Number((await pool!.query('SELECT COUNT(*)::int AS n FROM provider_concurrency_leases')).rows[0].n)).toBe(0);
  });

  it('keeps each capacity key separate and leaves unlisted keys unmanaged', async () => {
    await insertRun(runId(1));
    const store = storeFor(`${KEY}=1,fast-model=1`);
    expect((await store.acquire(caller(runId(1)), KEY)).status).toBe('granted');
    expect((await store.acquire(caller(runId(1)), 'fast-model')).status).toBe('granted');
    expect((await store.acquire(caller(runId(1)), KEY)).status).toBe('denied');
    expect(await store.acquire(caller(runId(1)), 'unlisted-model')).toEqual({ status: 'unmanaged' });
  });

  it('serves the route end to end: 401 without a bearer, 403 for a foreign bearer, 200 for the live worker', async () => {
    await insertRun(runId(1));
    const app = createActionDispatchApp({
      verifier: { verify: vi.fn() } as any, admission: { admit: vi.fn() } as any, resolveInstallationId: vi.fn(),
      databaseReady: vi.fn(async () => true), allowAppGate: false, providerLease: storeFor(`${KEY}=1`),
    });
    const body = { version: 'ProviderLeaseAcquire.v1', runId: runId(1), executionAttempt: 1, capacityKey: KEY };
    expect((await request(app).post('/api/dispatch/provider-lease').send(body)).status).toBe(401);
    expect((await request(app).post('/api/dispatch/provider-lease').set('Authorization', 'Bearer ghs_foreign_token').send(body)).status).toBe(403);
    const granted = await request(app).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ version: 'ProviderLease.v1', status: 'granted', capacity: 1, inUse: 1 });
    expect(await liveLeases()).toBe(1);
  });
});
