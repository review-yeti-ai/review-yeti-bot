import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import {
  dashboardStore,
  calculatePercentile,
  generateDefaultReviewLogs,
} from '../../src/persistence/dashboardStore';

describe('Milestone 4: Analytics Engine & Multi-Horizon Verification', () => {
  let app: any;
  let authToken: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    // Authenticate admin session
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  // ==========================================================================
  // SECTION 1: Mathematical Percentile Calculations (Nearest-Rank Method)
  // ==========================================================================
  describe('Mathematical Percentile Algorithm (calculatePercentile)', () => {
    it('returns 0 for empty or invalid arrays', () => {
      expect(calculatePercentile([], 95)).toBe(0);
      expect(calculatePercentile([NaN, -1, 0] as number[], 95)).toBe(0);
    });

    it('calculates single-element sample set correctly', () => {
      expect(calculatePercentile([1000], 95)).toBe(1000);
      expect(calculatePercentile([1000], 50)).toBe(1000);
    });

    it('calculates two-element sample set correctly', () => {
      expect(calculatePercentile([1000, 5000], 95)).toBe(5000);
      expect(calculatePercentile([1000, 5000], 50)).toBe(1000);
    });

    it('calculates five-element sample set correctly', () => {
      expect(calculatePercentile([100, 200, 300, 400, 500], 95)).toBe(500);
      expect(calculatePercentile([100, 200, 300, 400, 500], 50)).toBe(300);
    });

    it('calculates multi-element distributions accurately (p50, p90, p95, p99)', () => {
      const values = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
      expect(calculatePercentile(values, 50)).toBe(5000);
      expect(calculatePercentile(values, 90)).toBe(9000);
      expect(calculatePercentile(values, 95)).toBe(10000);
      expect(calculatePercentile(values, 99)).toBe(10000);
    });
  });

  // ==========================================================================
  // SECTION 2: Dynamic Seed Generator & Store Retention Buffer
  // ==========================================================================
  describe('Dynamic Seed Fixtures & Buffer Retention', () => {
    it('generates 15 default review logs distributed across 24h, 7d, and 30d', () => {
      const logs = generateDefaultReviewLogs();
      expect(logs.length).toBe(15);

      const now = Date.now();
      const DAY = 24 * 3600 * 1000;

      const runs24h = logs.filter((l) => now - new Date(l.timestamp).getTime() <= DAY);
      const runs7d = logs.filter((l) => now - new Date(l.timestamp).getTime() <= 7 * DAY);
      const runs30d = logs.filter((l) => now - new Date(l.timestamp).getTime() <= 30 * DAY);

      expect(runs24h.length).toBe(5);
      expect(runs7d.length).toBe(10);
      expect(runs30d.length).toBe(15);

      // Verify realistic latencies between 1200ms and 9500ms
      for (const log of logs) {
        expect(log.latencyMs).toBeGreaterThanOrEqual(1200);
        expect(log.latencyMs).toBeLessThanOrEqual(9500);
        expect(log.costUSD).toBeGreaterThan(0);
        expect(log.tokens?.total).toBeGreaterThan(0);
      }
    });

    it('enforces 1,000-entry retention buffer cap without dropping recent reviews', () => {
      const initialCount = (dashboardStore as any).data.reviewLogs?.length || 0;
      expect(initialCount).toBeGreaterThanOrEqual(15);

      // Record a test run
      dashboardStore.recordReviewRun({
        id: 'job-buffer-test-run',
        repo: 'exampleorg/example-api',
        prNumber: 9999,
        status: 'completed',
        durationMs: 2500,
        costUSD: 0.15,
        promptTokens: 12000,
        completionTokens: 1500,
      });

      const updatedLogs = (dashboardStore as any).data.reviewLogs;
      expect(updatedLogs[0].id).toBe('job-buffer-test-run');
      expect(updatedLogs.length).toBeLessThanOrEqual(1000);
    });
  });

  // ==========================================================================
  // SECTION 3: API Parameter Validation & Authentication
  // ==========================================================================
  describe('API Query Validation & Authentication', () => {
    it('rejects unauthenticated requests across analytics endpoints with 401', async () => {
      const endpoints = ['/summary', '/latency', '/costs', '/tokens', '/findings'];
      for (const ep of endpoints) {
        const res = await request(app).get(`/api/analytics${ep}`);
        expect(res.status).toBe(401);
      }
    });

    it('rejects unsupported range queries with 400 Bad Request', async () => {
      const invalidQueries = ['90d', '1y', 'invalid_range', '12h'];
      for (const q of invalidQueries) {
        const res = await request(app)
          .get(`/api/analytics/summary?range=${q}`)
          .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Unsupported range/);
      }
    });

    it('accepts both ?range and ?window parameters interchangeably for 24h, 7d, 30d', async () => {
      for (const w of ['24h', '7d', '30d']) {
        const resRange = await request(app)
          .get(`/api/analytics/summary?range=${w}`)
          .set('Authorization', `Bearer ${authToken}`);
        expect(resRange.status).toBe(200);
        expect(resRange.body.summary.range).toBe(w);

        const resWindow = await request(app)
          .get(`/api/analytics/summary?window=${w}`)
          .set('Authorization', `Bearer ${authToken}`);
        expect(resWindow.status).toBe(200);
        expect(resWindow.body.summary.range).toBe(w);
      }
    });
  });

  // ==========================================================================
  // SECTION 4: The 5 Dedicated Analytics REST Endpoints
  // ==========================================================================
  describe('Endpoint 1: GET /api/analytics/summary', () => {
    it('returns executive summary with p95, avg, spend, tokens, and finding quality', async () => {
      const res = await request(app)
        .get('/api/analytics/summary?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const { summary } = res.body;

      expect(summary.totalReviews).toBeGreaterThanOrEqual(1);
      expect(summary.p95DurationMs).toBeGreaterThan(0);
      expect(summary.avgDurationMs).toBeGreaterThan(0);
      expect(summary.totalSpendUsd).toBeGreaterThan(0);
      expect(summary.totalTokens).toBeGreaterThan(0);
      expect(summary.successRate).toBeGreaterThanOrEqual(0);
      expect(summary.findingSeverityRatio).toBeDefined();
      expect(summary.findingSeverityRatio).toHaveProperty('p0');
      expect(summary.findingSeverityRatio).toHaveProperty('p1');
      expect(summary.findingSeverityRatio).toHaveProperty('p2');
      expect(summary.acceptanceRate).toBeGreaterThanOrEqual(0);
      expect(summary.range).toBe('7d');
    });

    it('supports repository-specific filtering on summary', async () => {
      const res = await request(app)
        .get('/api/analytics/summary?range=30d&repo=exampleorg/example-api')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary.repo).toBe('exampleorg/example-api');
      expect(res.body.summary.totalReviews).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Endpoint 2: GET /api/analytics/latency', () => {
    it('returns percentile distributions and daily time buckets', async () => {
      const res = await request(app)
        .get('/api/analytics/latency?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.p50DurationMs).toBeGreaterThan(0);
      expect(res.body.p90DurationMs).toBeGreaterThanOrEqual(res.body.p50DurationMs);
      expect(res.body.p95DurationMs).toBeGreaterThanOrEqual(res.body.p90DurationMs);
      expect(res.body.p99DurationMs).toBeGreaterThanOrEqual(res.body.p95DurationMs);
      expect(res.body.avgDurationMs).toBeGreaterThan(0);

      expect(Array.isArray(res.body.timeBuckets)).toBe(true);
      expect(res.body.timeBuckets.length).toBe(7);

      const bucket = res.body.timeBuckets[0];
      expect(bucket).toHaveProperty('timestamp');
      expect(bucket).toHaveProperty('p95');
      expect(bucket).toHaveProperty('avg');
    });

    it('returns hourly time bucket for 24h range', async () => {
      const res = await request(app)
        .get('/api/analytics/latency?range=24h')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.range).toBe('24h');
      expect(res.body.timeBuckets.length).toBe(1);
    });
  });

  describe('Endpoint 3: GET /api/analytics/costs', () => {
    it('returns model spend breakdown and byRepo ranking', async () => {
      const res = await request(app)
        .get('/api/analytics/costs?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalSpendUsd).toBeGreaterThan(0);
      expect(res.body.monthlyBudgetUsd).toBeGreaterThan(0);
      expect(res.body.budgetPercentUsed).toBeGreaterThanOrEqual(0);

      expect(Array.isArray(res.body.breakdown)).toBe(true);
      expect(res.body.breakdown.length).toBeGreaterThan(0);

      expect(Array.isArray(res.body.byRepo)).toBe(true);
      expect(res.body.byRepo.length).toBeGreaterThan(0);

      const topRepo = res.body.byRepo[0];
      expect(topRepo).toHaveProperty('repo');
      expect(topRepo).toHaveProperty('spendUsd');
      expect(topRepo).toHaveProperty('reviewCount');
      expect(topRepo).toHaveProperty('avgSpendPerPR');
      expect(topRepo).toHaveProperty('totalTokens');
      expect(topRepo.spendUsd).toBeGreaterThan(0);
    });
  });

  describe('Endpoint 4: GET /api/analytics/tokens', () => {
    it('returns prompt, completion, total, and monotonically increasing cumulativeTokens', async () => {
      const res = await request(app)
        .get('/api/analytics/tokens?range=7d&interval=day')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalTokens).toBeGreaterThan(0);
      expect(res.body.promptTokens).toBeGreaterThan(0);
      expect(res.body.completionTokens).toBeGreaterThan(0);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(7);

      let prevCumulative = 0;
      for (const pt of res.body.data) {
        expect(pt).toHaveProperty('timestamp');
        expect(pt).toHaveProperty('promptTokens');
        expect(pt).toHaveProperty('completionTokens');
        expect(pt).toHaveProperty('totalTokens');
        expect(pt).toHaveProperty('cumulativeTokens');
        expect(pt.cumulativeTokens).toBeGreaterThanOrEqual(prevCumulative);
        prevCumulative = pt.cumulativeTokens;
      }
    });
  });

  describe('Endpoint 5: GET /api/analytics/findings', () => {
    it('returns finding severity ratios and acceptance vs dismissal rates', async () => {
      const res = await request(app)
        .get('/api/analytics/findings?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalFindings).toBeGreaterThanOrEqual(1);

      expect(res.body.severityCounts).toBeDefined();
      expect(res.body.severityCounts.P0).toBeDefined();
      expect(res.body.severityCounts.P1).toBeDefined();
      expect(res.body.severityCounts.P2).toBeDefined();

      expect(res.body.severityRatio).toBeDefined();
      expect(res.body.severityRatio.p0).toBeGreaterThanOrEqual(0);
      expect(res.body.severityRatio.p1).toBeGreaterThanOrEqual(0);
      expect(res.body.severityRatio.p2).toBeGreaterThanOrEqual(0);

      expect(res.body.acceptanceRate).toBeGreaterThanOrEqual(0);
      expect(res.body.dismissalRate).toBeGreaterThanOrEqual(0);
      expect(Math.round(res.body.acceptanceRate + res.body.dismissalRate)).toBe(100);
    });
  });

  // ==========================================================================
  // SECTION 5: Backwards Compatibility
  // ==========================================================================
  describe('Backwards Compatibility with Existing Analytics Endpoints', () => {
    it('preserves GET /api/analytics/personas response contract', async () => {
      const res = await request(app)
        .get('/api/analytics/personas')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.personas)).toBe(true);
    });

    it('preserves GET /api/analytics/indexer response contract', async () => {
      const res = await request(app)
        .get('/api/analytics/indexer')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.indexer).toBeDefined();
    });
  });
});
