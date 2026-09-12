import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMocks = vi.hoisted(() => ({
  poolConstructor: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) {
      pgMocks.poolConstructor(config);
    }

    async query(): Promise<never> {
      throw new Error('unexpected PostgreSQL connection attempt');
    }

    async end(): Promise<void> {}
  },
}));

import {
  REAPER_ACCEPTANCE_CLEANUP_FAILURES,
  runReaperMetricsAcceptance,
  runReaperMetricsAcceptanceCleanup,
} from '../support/reaperMetricsAcceptanceHarness';

describe('REL-817 acceptance database isolation', () => {
  beforeEach(() => {
    pgMocks.poolConstructor.mockClear();
  });

  it.each([
    'host=production-db.example.invalid',
    'hostaddr=203.0.113.10',
    'port=6432',
    'user=production_role',
    'dbname=production',
    'database=production',
    'service=production',
    'options=-c%20search_path%3Dpublic',
    'sslmode=require',
  ])('rejects the connection override %s before constructing a PostgreSQL pool', async (override) => {
    let thrown: unknown;
    try {
      await runReaperMetricsAcceptance(
        `postgresql://postgres:postgres@127.0.0.1:5432/postgres?${override}`,
      );
    } catch (error) {
      thrown = error;
    }

    expect(pgMocks.poolConstructor).not.toHaveBeenCalled();
    expect(thrown).toEqual(expect.objectContaining({
      message: 'REL-817 acceptance database URL must not include connection override parameters',
    }));
  });
});

describe('REL-817 acceptance resource cleanup', () => {
  it('attempts every cleanup and preserves the original operation failure', async () => {
    const calls: string[] = [];
    const originalFailure = new Error('reaper acceptance operation failed');
    const metricsFailure = new Error('metrics close failed');
    const storeFailure = new Error('store close failed');
    const schemaFailure = new Error('schema drop failed');
    const adminFailure = new Error('admin pool end failed');
    let thrown: unknown;

    try {
      await runReaperMetricsAcceptanceCleanup([
        { name: 'metrics server', run: async () => { calls.push('metrics'); throw metricsFailure; } },
        { name: 'store', run: async () => { calls.push('store'); throw storeFailure; } },
        { name: 'schema', run: async () => { calls.push('schema'); throw schemaFailure; } },
        { name: 'admin pool', run: async () => { calls.push('admin'); throw adminFailure; } },
      ], { error: originalFailure });
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(['metrics', 'store', 'schema', 'admin']);
    expect(thrown).toBe(originalFailure);
    expect((originalFailure as Error & {
      [REAPER_ACCEPTANCE_CLEANUP_FAILURES]: unknown;
    })[REAPER_ACCEPTANCE_CLEANUP_FAILURES]).toEqual([
      { name: 'metrics server', error: metricsFailure },
      { name: 'store', error: storeFailure },
      { name: 'schema', error: schemaFailure },
      { name: 'admin pool', error: adminFailure },
    ]);
  });

  it('attempts every cleanup and aggregates failures when the operation succeeded', async () => {
    const calls: string[] = [];
    const metricsFailure = new Error('metrics close failed');
    const schemaFailure = new Error('schema drop failed');
    let thrown: unknown;

    try {
      await runReaperMetricsAcceptanceCleanup([
        { name: 'metrics server', run: async () => { calls.push('metrics'); throw metricsFailure; } },
        { name: 'store', run: async () => { calls.push('store'); } },
        { name: 'schema', run: async () => { calls.push('schema'); throw schemaFailure; } },
        { name: 'admin pool', run: async () => { calls.push('admin'); } },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(['metrics', 'store', 'schema', 'admin']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([metricsFailure, schemaFailure]);
    expect((thrown as Error).message).toContain('metrics server, schema');
  });
});
