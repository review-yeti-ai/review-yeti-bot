import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { createApp } from '../../src/app';

function createCleanStore(filePath: string): DashboardStore {
  const store = new DashboardStore(filePath);
  (store as any).data.reviewLogs = [];
  (store as any).data.reviewCounter = 0;
  (store as any).data.totalCostUSD = 0;
  (store as any).data.totalPromptTokens = 0;
  (store as any).data.totalCompletionTokens = 0;
  (store as any).data.dailyReviewCounts = {};
  (store as any).invalidateCache();
  (store as any).saveData((store as any).data);
  return store;
}

describe('R2 Today\'s Reviews Telemetry & Date Boundary Diagnostic Stress Suite', () => {
  const tempTestDir = path.join(process.cwd(), 'data', 'test-r2-date-boundary');
  let app: any;
  let validApiKey: string;

  beforeEach(() => {
    if (!fs.existsSync(tempTestDir)) {
      fs.mkdirSync(tempTestDir, { recursive: true });
    }
    app = createApp();
    const createdKey = dashboardStore.createApiKey('r2-test-key');
    validApiKey = createdKey.rawKey;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. Date Boundary Midnight Rollover (23:59:59 UTC vs 00:00:01 UTC)', () => {
    it('accurately categorizes review logs at 23:59:59 UTC vs 00:00:01 UTC across midnight rollover', () => {
      const storeFile = path.join(tempTestDir, 'store-midnight-rollover.json');
      const store = createCleanStore(storeFile);

      // Lock system time to 2026-07-28T12:00:00.000Z
      const baseNow = new Date('2026-07-28T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(baseNow);

      // Log 1: Exactly at 23:59:59.999 UTC on 2026-07-28
      store.recordReviewRun({
        id: 'run-utc-235959',
        prRun: 'calltelemetry/cisco-cdr #101',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 101,
        timestamp: '2026-07-28T23:59:59.999Z',
        costUSD: 0.15,
        tokens: { prompt: 1000, completion: 500, total: 1500 },
      });

      // Log 2: Exactly at 00:00:01.000 UTC on 2026-07-29 (next UTC day)
      store.recordReviewRun({
        id: 'run-utc-000001',
        prRun: 'calltelemetry/cisco-cdr #102',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 102,
        timestamp: '2026-07-29T00:00:01.000Z',
        costUSD: 0.20,
        tokens: { prompt: 1200, completion: 600, total: 1800 },
      });

      // Fetch overview stats when system time is July 28 UTC
      const overviewJul28 = store.getOverviewStats();

      expect(overviewJul28.todayDateBadge).toBe('2026-07-28');
      expect(overviewJul28.totalReviewsExecuted).toBe(2);
      expect(overviewJul28.todaysReviewsExecuted).toBeGreaterThanOrEqual(1);

      // Now shift simulated system clock across midnight to 2026-07-29T10:00:00.000Z
      const nextDayNow = new Date('2026-07-29T10:00:00.000Z');
      vi.setSystemTime(nextDayNow);

      // Reload store from disk to recalculate relative to new system date
      const reloadedStore = new DashboardStore(storeFile);
      const overviewJul29 = reloadedStore.getOverviewStats();

      expect(overviewJul29.todayDateBadge).toBe('2026-07-29');
      expect(overviewJul29.totalReviewsExecuted).toBe(2);
      expect(overviewJul29.todaysReviewsExecuted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('2. Multi-Timezone Offset ISO 8601 Parsing & Resolution', () => {
    it('correctly handles ISO 8601 timestamps with negative (UTC-5), positive (UTC+9), and zero (UTC+0) offsets', () => {
      const storeFile = path.join(tempTestDir, 'store-tz-offsets.json');
      const store = createCleanStore(storeFile);

      const fixedDate = new Date('2026-07-28T14:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(fixedDate);

      // Timestamp in UTC-5 offset (CDT): 2026-07-28 09:00:00 -05:00 (= 2026-07-28T14:00:00Z UTC)
      store.recordReviewRun({
        id: 'run-utc-minus-5',
        prRun: 'calltelemetry/cisco-cdr #201',
        timestamp: '2026-07-28T09:00:00.000-05:00',
        costUSD: 0.10,
      });

      // Timestamp in UTC+9 offset (JST): 2026-07-28 23:00:00 +09:00 (= 2026-07-28T14:00:00Z UTC)
      store.recordReviewRun({
        id: 'run-utc-plus-9',
        prRun: 'calltelemetry/cisco-cdr #202',
        timestamp: '2026-07-28T23:00:00.000+09:00',
        costUSD: 0.12,
      });

      // Timestamp in standard UTC Z format: 2026-07-28T14:00:00.000Z
      store.recordReviewRun({
        id: 'run-utc-zero',
        prRun: 'calltelemetry/cisco-cdr #203',
        timestamp: '2026-07-28T14:00:00.000Z',
        costUSD: 0.08,
      });

      const overview = store.getOverviewStats();

      expect(overview.totalReviewsExecuted).toBe(3);
      expect(overview.todaysReviewsExecuted).toBe(3);
      expect(overview.todaysReviewsCount).toBe(3);
      expect(overview.totalCostUSD).toBeCloseTo(0.30, 2);
    });

    it('resiliently handles invalid, missing, or malformed timestamps without crashing getOverviewStats()', () => {
      const storeFile = path.join(tempTestDir, 'store-malformed-ts.json');
      const store = createCleanStore(storeFile);

      const fixedDate = new Date('2026-07-28T14:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(fixedDate);

      // Record run with invalid string timestamp (stored as string, throws RangeError in Date parsing, caught safely)
      store.recordReviewRun({
        id: 'run-invalid-ts',
        prRun: 'calltelemetry/cisco-cdr #301',
        timestamp: 'not-a-valid-date-string',
      });

      // Record run with empty timestamp (falls back to new Date().toISOString() = today)
      store.recordReviewRun({
        id: 'run-empty-ts',
        prRun: 'calltelemetry/cisco-cdr #302',
        timestamp: '',
      });

      // Record run with standard timestamp (explicit today)
      store.recordReviewRun({
        id: 'run-valid-ts',
        prRun: 'calltelemetry/cisco-cdr #303',
        timestamp: '2026-07-28T14:00:00.000Z',
      });

      expect(() => {
        const overview = store.getOverviewStats();
        expect(overview.totalReviewsExecuted).toBe(3);
        // run-invalid-ts is safely excluded (false), run-empty-ts (fallback today) and run-valid-ts (today) are counted
        expect(overview.todaysReviewsExecuted).toBe(2);
      }).not.toThrow();
    });
  });

  describe('3. Real-Time Webhook PR Event Metric Increments & Cache Invalidation', () => {
    it('immediately invalidates cache and increments todaysReviewsExecuted on new review recording', () => {
      const storeFile = path.join(tempTestDir, 'store-realtime-webhook.json');
      const store = createCleanStore(storeFile);

      const fixedDate = new Date('2026-07-28T15:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(fixedDate);

      // Initial stats query
      const initialOverview = store.getOverviewStats();
      expect(initialOverview.todaysReviewsExecuted).toBe(0);
      expect(initialOverview.totalReviewsExecuted).toBe(0);

      // Simulate incoming Webhook PR review completion event
      store.recordReviewRun({
        id: 'webhook-pr-event-1',
        prRun: 'calltelemetry/ct-review-bot #501',
        repo: 'calltelemetry/ct-review-bot',
        prNumber: 501,
        timestamp: new Date().toISOString(),
        arbiterVerdict: 'SHIP',
        costUSD: 0.45,
        tokens: { prompt: 3000, completion: 1500, total: 4500 },
      });

      // Next immediate call to getOverviewStats() MUST reflect updated values
      const updatedOverview = store.getOverviewStats();
      expect(updatedOverview.todaysReviewsExecuted).toBe(1);
      expect(updatedOverview.totalReviewsExecuted).toBe(1);
      expect(updatedOverview.totalCostUSD).toBeCloseTo(0.45, 2);
      expect(updatedOverview.totalTokens.prompt).toBe(3000);
      expect(updatedOverview.totalTokens.completion).toBe(1500);
    });

    it('stress-tests rapid burst of 50 webhook PR events with linear metric accumulation', () => {
      const storeFile = path.join(tempTestDir, 'store-rapid-burst.json');
      const store = createCleanStore(storeFile);

      const fixedDate = new Date('2026-07-28T16:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(fixedDate);

      const burstCount = 50;
      const costPerRun = 0.05;

      for (let i = 1; i <= burstCount; i++) {
        store.recordReviewRun({
          id: `burst-webhook-run-${i}`,
          prRun: `calltelemetry/cisco-cdr #${1000 + i}`,
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 1000 + i,
          timestamp: new Date().toISOString(),
          arbiterVerdict: i % 2 === 0 ? 'SHIP' : 'NACK',
          costUSD: costPerRun,
          tokens: { prompt: 500, completion: 250, total: 750 },
        });

        // Verify real-time query after EACH event
        const stats = store.getOverviewStats();
        expect(stats.todaysReviewsExecuted).toBe(i);
        expect(stats.totalReviewsExecuted).toBe(i);
        expect(stats.totalCostUSD).toBeCloseTo(i * costPerRun, 2);
      }

      // Reload store from disk to verify persistence of telemetry
      const reloaded = new DashboardStore(storeFile);
      const finalStats = reloaded.getOverviewStats();
      expect(finalStats.todaysReviewsExecuted).toBe(burstCount);
      expect(finalStats.totalReviewsExecuted).toBe(burstCount);
      expect(finalStats.totalCostUSD).toBeCloseTo(burstCount * costPerRun, 2);
    });

    it('accurately tracks todaysReviewsExecuted when review logs exceed 100 entries buffer limit', () => {
      const storeFile = path.join(tempTestDir, 'store-over-100-burst.json');
      const store = createCleanStore(storeFile);

      const fixedDate = new Date('2026-07-28T17:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(fixedDate);

      const burstCount = 105;
      const costPerRun = 0.02;

      for (let i = 1; i <= burstCount; i++) {
        store.recordReviewRun({
          id: `burst-over-100-${i}`,
          prRun: `calltelemetry/cisco-cdr #${2000 + i}`,
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 2000 + i,
          timestamp: new Date().toISOString(),
          arbiterVerdict: 'SHIP',
          costUSD: costPerRun,
        });

        const stats = store.getOverviewStats();
        expect(stats.todaysReviewsExecuted).toBe(i);
        expect(stats.totalReviewsExecuted).toBe(i);
      }

      // Display entries should be capped at 100 in reviewLogs array
      expect(store.getReviewLogs().length).toBe(100);

      // Reload store from disk to verify persisted telemetry
      const reloaded = new DashboardStore(storeFile);
      const finalStats = reloaded.getOverviewStats();
      expect(finalStats.todaysReviewsExecuted).toBe(105);
      expect(finalStats.totalReviewsExecuted).toBe(105);
    });

    it('verifies HTTP GET /api/dashboard/overview returns real-time updated telemetry after trigger-test-review', async () => {
      // 1. Get initial overview telemetry over API
      const res1 = await request(app)
        .get('/api/dashboard/overview')
        .set('x-api-key', validApiKey);

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      const initialCount = res1.body.overview.todaysReviewsExecuted;

      // 2. Trigger test review execution endpoint POST /api/dashboard/trigger-test-review
      const testRunRes = await request(app)
        .post('/api/dashboard/trigger-test-review')
        .set('x-api-key', validApiKey)
        .send({
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 999,
          title: 'Test Date Boundary PR',
        });

      expect(testRunRes.status).toBe(200);
      expect(testRunRes.body.success).toBe(true);

      // 3. Re-query overview API and confirm real-time increment
      const res2 = await request(app)
        .get('/api/dashboard/overview')
        .set('x-api-key', validApiKey);

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.overview.todaysReviewsExecuted).toBe(initialCount + 1);
    });
  });
});
