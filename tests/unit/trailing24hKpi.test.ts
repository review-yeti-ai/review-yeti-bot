import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore } from '../../src/persistence/dashboardStore';

describe('Trailing 24-Hour Review KPI Summary (Requirement R2)', () => {
  const tmpStoreFile = path.join(process.cwd(), 'fixtures/tmp/test_r2_trailing24h.json');
  let store: DashboardStore;

  beforeEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try { fs.unlinkSync(tmpStoreFile); } catch {}
    }
    store = new DashboardStore(tmpStoreFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try { fs.unlinkSync(tmpStoreFile); } catch {}
    }
  });

  it('returns 0 for 24h metrics when no review runs have occurred', () => {
    (store as any).data.reviewLogs = [];
    (store as any).invalidateCache();

    const stats = store.getOverviewStats();
    expect(stats.trailing24hReviewsExecuted).toBe(0);
    expect(stats.trailing24hAvgTokensPerPR).toBe(0);
    expect(stats.trailing24hAvgCostPerPR).toBe(0);
  });

  it('correctly filters logs inside 24h window vs older than 24h', () => {
    (store as any).data.reviewLogs = [];
    (store as any).invalidateCache();

    const now = Date.now();
    const recentTime = new Date(now - 2 * 3600 * 1000).toISOString(); // 2 hours ago
    const olderTime = new Date(now - 30 * 3600 * 1000).toISOString(); // 30 hours ago

    store.recordReviewRun({
      id: 'run_recent_1',
      costUSD: 0.15,
      tokens: { prompt: 1000, completion: 500, total: 1500 },
      timestamp: recentTime,
    });

    store.recordReviewRun({
      id: 'run_recent_2',
      costUSD: 0.25,
      tokens: { prompt: 2000, completion: 1000, total: 3000 },
      timestamp: recentTime,
    });

    store.recordReviewRun({
      id: 'run_old_1',
      costUSD: 0.50,
      tokens: { prompt: 5000, completion: 5000, total: 10000 },
      timestamp: olderTime,
    });

    const stats = store.getOverviewStats();
    expect(stats.trailing24hReviewsExecuted).toBe(2);
    // (1500 + 3000) / 2 = 2250 tokens/PR
    expect(stats.trailing24hAvgTokensPerPR).toBe(2250);
    // (0.15 + 0.25) / 2 = 0.2 cost/PR
    expect(stats.trailing24hAvgCostPerPR).toBe(0.2);
  });

  it('handles zero division safely when reviews exist but total 0', () => {
    (store as any).data.reviewLogs = [];
    (store as any).invalidateCache();

    const now = Date.now();
    const recentTime = new Date(now - 1 * 3600 * 1000).toISOString();

    store.recordReviewRun({
      id: 'run_zero_1',
      costUSD: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      timestamp: recentTime,
    });

    const stats = store.getOverviewStats();
    expect(stats.trailing24hReviewsExecuted).toBe(1);
    expect(stats.trailing24hAvgTokensPerPR).toBe(0);
    expect(stats.trailing24hAvgCostPerPR).toBe(0);
  });

  it('correctly handles default seeded review logs if timestamps fall in 24h', () => {
    const stats = store.getOverviewStats();
    expect(typeof stats.trailing24hReviewsExecuted).toBe('number');
    expect(typeof stats.trailing24hAvgTokensPerPR).toBe('number');
    expect(typeof stats.trailing24hAvgCostPerPR).toBe('number');
  });
});
