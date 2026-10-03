import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';
import { providerLeaseRateLimitKey } from '../../src/api/providerLeaseRoute';
import { createRateLimiter } from '../../src/security/rateLimiter';
import { PostgresProviderLeaseStore, type ProviderLeaseStore } from '../../src/persistence/providerConcurrencyLeaseRepository';
import { parseProviderCapacityMap } from '../../src/config/providerConcurrency';
import { sha256 } from '../../src/review/reviewCore';

const RUN_ID = `run_${'b'.repeat(32)}`;
const TOKEN = 'ghs_provider_lease_route_token';
const LEASE_ID = '22222222-2222-4222-8222-222222222222';
const acquireBody = { version: 'ProviderLeaseAcquire.v1', runId: RUN_ID, executionAttempt: 1, capacityKey: 'pr-reviewer' };

function fakeStore(overrides: Partial<ProviderLeaseStore> = {}): ProviderLeaseStore {
  return {
    acquire: vi.fn(async () => ({ status: 'granted' as const, leaseId: LEASE_ID, ttlMs: 60_000, capacity: 12, inUse: 1 })),
    renew: vi.fn(async () => ({ status: 'renewed' as const, ttlMs: 60_000 })),
    release: vi.fn(async () => ({ status: 'released' as const })),
    ...overrides,
  };
}

function app(store?: ProviderLeaseStore, providerLeaseRateLimiter = ((_req: any, _res: any, next: any) => next()) as any) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => true),
    allowAppGate: false,
    ...(store ? { providerLease: store, providerLeaseRateLimiter } : {}),
  });
}

describe('POST /api/dispatch/provider-lease', () => {
  it('is not mounted unless the service configured provider concurrency', async () => {
    expect((await request(app()).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`).send(acquireBody)).status).toBe(404);
  });

  it('requires a worker installation bearer and a strict request shape', async () => {
    const store = fakeStore();
    expect((await request(app(store)).post('/api/dispatch/provider-lease').send(acquireBody)).status).toBe(401);
    expect((await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', 'Bearer not-an-installation-token').send(acquireBody)).status).toBe(401);
    for (const body of [{}, { ...acquireBody, capacityKey: 'Bad Key' }, { ...acquireBody, extra: true }, { ...acquireBody, runId: 'run_1' },
      { version: 'ProviderLeaseRenew.v1', runId: RUN_ID, executionAttempt: 1, leaseId: 'not-a-uuid' }]) {
      expect((await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(400);
    }
    expect(store.acquire).not.toHaveBeenCalled();
  });

  it('answers 403 when the bearer is not this execution\'s worker token', async () => {
    const store = fakeStore({ acquire: vi.fn(async () => ({ status: 'unauthorized' as const })) });
    const response = await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`).send(acquireBody);
    expect(response.status).toBe(403);
    expect(store.acquire).toHaveBeenCalledWith({ runId: RUN_ID, executionAttempt: 1, workerTokenDigest: sha256(TOKEN) }, 'pr-reviewer');
  });

  it('serves acquire, renew and release as versioned answers', async () => {
    const store = fakeStore();
    const acquired = await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`).send(acquireBody);
    expect(acquired.status).toBe(200);
    expect(acquired.body).toEqual({ version: 'ProviderLease.v1', status: 'granted', leaseId: LEASE_ID, ttlMs: 60_000, capacity: 12, inUse: 1 });
    const renewed = await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`)
      .send({ version: 'ProviderLeaseRenew.v1', runId: RUN_ID, executionAttempt: 1, leaseId: LEASE_ID });
    expect(renewed.body).toEqual({ version: 'ProviderLease.v1', status: 'renewed', ttlMs: 60_000 });
    const released = await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`)
      .send({ version: 'ProviderLeaseRelease.v1', runId: RUN_ID, executionAttempt: 1, leaseId: LEASE_ID });
    expect(released.body).toEqual({ version: 'ProviderLease.v1', status: 'released' });
  });

  it('answers 503 (which the worker treats as unavailable) when the store fails', async () => {
    const store = fakeStore({ acquire: vi.fn(async () => { throw new Error('connection terminated'); }) });
    const response = await request(app(store)).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${TOKEN}`).send(acquireBody);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('connection terminated');
  });

  it('rate-limits per run bearer, not per shared client address', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyGenerator: providerLeaseRateLimitKey });
    const instance = app(fakeStore(), limiter);
    const send = (token: string) => request(instance).post('/api/dispatch/provider-lease').set('Authorization', `Bearer ${token}`).send(acquireBody);
    expect((await send(TOKEN)).status).toBe(200);
    expect((await send(TOKEN)).status).toBe(200);
    expect((await send(TOKEN)).status).toBe(429);
    expect((await send('ghs_another_run_token')).status).toBe(200);
  });
});

describe('PostgresProviderLeaseStore authorization', () => {
  function scriptedDatabase(binding: { status: string; digest: string } | undefined) {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text.replace(/\s+/gu, ' ').trim());
      if (text.includes('FROM review_runs runs JOIN review_dispatch_outbox')) {
        return { rows: binding ? [{ status: binding.status, worker_token_digest: binding.digest }] : [] };
      }
      if (text.includes('COUNT(*)')) return { rows: [{ in_use: 0 }] };
      return { rows: [] };
    });
    return { statements, database: { query, connect: async () => ({ query, release: vi.fn() }) } };
  }
  const config = { capacity: parseProviderCapacityMap('pr-reviewer=2'), ttlMs: 60_000 };
  const caller = { runId: RUN_ID, executionAttempt: 1, workerTokenDigest: sha256(TOKEN) };

  it.each([
    ['another execution\'s token', { status: 'running', digest: sha256('ghs_someone_else') }],
    ['a finished run', { status: 'succeeded', digest: sha256(TOKEN) }],
    ['an unknown execution', undefined],
  ])('takes no slot for %s', async (_label, binding) => {
    const { statements, database } = scriptedDatabase(binding);
    const store = new PostgresProviderLeaseStore(database as any, config);
    expect(await store.acquire(caller, 'pr-reviewer')).toEqual({ status: 'unauthorized' });
    expect(await store.renew(caller, LEASE_ID)).toEqual({ status: 'unauthorized' });
    expect(await store.release(caller, LEASE_ID)).toEqual({ status: 'unauthorized' });
    expect(statements.some((statement) => /INSERT|UPDATE|DELETE|pg_advisory/u.test(statement))).toBe(false);
  });

  it('grants under the advisory lock after reaping expired leases, for the live execution', async () => {
    const { statements, database } = scriptedDatabase({ status: 'running', digest: sha256(TOKEN) });
    const store = new PostgresProviderLeaseStore(database as any, config, () => LEASE_ID);
    expect(await store.acquire(caller, 'pr-reviewer')).toEqual({ status: 'granted', leaseId: LEASE_ID, ttlMs: 60_000, capacity: 2, inUse: 1 });
    const order = ['BEGIN', 'pg_advisory_xact_lock', 'DELETE FROM provider_concurrency_leases', 'COUNT(*)', 'INSERT INTO provider_concurrency_leases', 'COMMIT']
      .map((fragment) => statements.findIndex((statement) => statement.includes(fragment)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reports an unlisted key as unmanaged without locking or counting', async () => {
    const { statements, database } = scriptedDatabase({ status: 'running', digest: sha256(TOKEN) });
    const store = new PostgresProviderLeaseStore(database as any, config);
    expect(await store.acquire(caller, 'other-model')).toEqual({ status: 'unmanaged' });
    expect(statements.some((statement) => /pg_advisory|INSERT/u.test(statement))).toBe(false);
  });
});
