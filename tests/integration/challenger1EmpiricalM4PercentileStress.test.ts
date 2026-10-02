/**
 * Milestone 4 Challenger 1: Empirical Adversarial Stress Test Suite
 * Percentile & Latency Boundary Challenger (teamwork_preview_challenger_m4_1)
 *
 * Exhaustively stress-tests:
 * 1. Nearest-rank percentile algorithm under boundary distributions:
 *    - 0 reviews (empty, NaN, negative, non-numeric values)
 *    - 1 review (single value preservation across p50, p90, p95, p99)
 *    - 2 reviews (rank step between index 0 and 1)
 *    - 100 identical latencies (invariance across all quantiles)
 *    - Skewed bimodal latencies (e.g. 90 fast vs 10 slow, 95 fast vs 5 slow)
 *    - Extreme sample sizes (10,000 reviews, high dynamic range)
 * 2. Time-window boundaries (24h, 7d, 30d filtering):
 *    - Timestamps precisely at limit boundaries:
 *      `now - 24h - 1ms` (excluded) vs `now - 24h + 1ms` (included) vs `now - 24h` (included)
 *      `now - 7d - 1ms` (excluded) vs `now - 7d + 1ms` (included) vs `now - 7d` (included)
 *      `now - 30d - 1ms` (excluded) vs `now - 30d + 1ms` (included) vs `now - 30d` (included)
 *    - Corrupt / malformed timestamps (NaN dates, empty strings, missing timestamp)
 * 3. Repository filtering & query validation:
 *    - Parameter rejection with HTTP 400 for `window=90d`, `window=invalid`, `range=1y`, `range=12h`, etc.
 *      across all 5 endpoints (/summary, /latency, /costs, /tokens, /findings)
 *    - Repository filtering (`repo=...` vs All Repositories)
 *    - Non-existent repository zero-metrics gracefulness
 *    - Adversarial strings in `repo` (path traversal, SQL injection fragments)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import {
  dashboardStore,
  calculatePercentile,
  ReviewLogEntry,
} from '../../src/persistence/dashboardStore';

describe('Milestone 4 Challenger 1: Empirical Percentile & Latency Boundary Stress Suite', () => {
  let app: any;
  let authToken: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  // ==========================================================================
  // SECTION 1: Nearest-Rank Percentile Boundary Distributions
  // ==========================================================================
  describe('Boundary Distributions: Nearest-Rank Percentile Algorithm', () => {
    it('Distribution 1: 0 reviews (empty array, null, undefined, NaN, negatives)', () => {
      expect(calculatePercentile([], 95)).toBe(0);
      expect(calculatePercentile([], 50)).toBe(0);
      expect(calculatePercentile([] as any, 99)).toBe(0);
      expect(calculatePercentile(null as any, 95)).toBe(0);
      expect(calculatePercentile(undefined as any, 95)).toBe(0);

      // Filtering non-positive and non-numbers
      const dirtyArray = [NaN, -500, 0, -1, NaN];
      expect(calculatePercentile(dirtyArray, 95)).toBe(0);
      expect(calculatePercentile(dirtyArray, 50)).toBe(0);
    });

    it('Distribution 2: 1 review (single element set)', () => {
      const latencies = [1542];
      expect(calculatePercentile(latencies, 50)).toBe(1542);
      expect(calculatePercentile(latencies, 90)).toBe(1542);
      expect(calculatePercentile(latencies, 95)).toBe(1542);
      expect(calculatePercentile(latencies, 99)).toBe(1542);
      expect(calculatePercentile(latencies, 1)).toBe(1542);
      expect(calculatePercentile(latencies, 100)).toBe(1542);
    });

    it('Distribution 3: 2 reviews (nearest-rank step threshold verification)', () => {
      const latencies = [1000, 5000];
      // For N = 2:
      // p50: ceil(0.50 * 2) - 1 = 1 - 1 = 0 -> 1000
      expect(calculatePercentile(latencies, 50)).toBe(1000);
      // p51: ceil(0.51 * 2) - 1 = 2 - 1 = 1 -> 5000
      expect(calculatePercentile(latencies, 51)).toBe(5000);
      // p90: ceil(0.90 * 2) - 1 = 2 - 1 = 1 -> 5000
      expect(calculatePercentile(latencies, 90)).toBe(5000);
      // p95: ceil(0.95 * 2) - 1 = 2 - 1 = 1 -> 5000
      expect(calculatePercentile(latencies, 95)).toBe(5000);
      // p99: ceil(0.99 * 2) - 1 = 2 - 1 = 1 -> 5000
      expect(calculatePercentile(latencies, 99)).toBe(5000);

      // Unsorted input verification
      const unsorted = [5000, 1000];
      expect(calculatePercentile(unsorted, 50)).toBe(1000);
      expect(calculatePercentile(unsorted, 95)).toBe(5000);
    });

    it('Distribution 4: 100 identical latencies', () => {
      const uniform = Array(100).fill(2500);
      expect(calculatePercentile(uniform, 10)).toBe(2500);
      expect(calculatePercentile(uniform, 50)).toBe(2500);
      expect(calculatePercentile(uniform, 90)).toBe(2500);
      expect(calculatePercentile(uniform, 95)).toBe(2500);
      expect(calculatePercentile(uniform, 99)).toBe(2500);
      expect(calculatePercentile(uniform, 100)).toBe(2500);
    });

    it('Distribution 5: Skewed bimodal latencies (90 fast reviews vs 10 slow reviews)', () => {
      // 90 fast runs at 800ms, 10 slow runs at 15000ms
      const fast = Array(90).fill(800);
      const slow = Array(10).fill(15000);
      const combined = [...slow, ...fast]; // unsorted order

      // N = 100:
      // p50: rank ceil(0.50 * 100) - 1 = 49 -> 800
      expect(calculatePercentile(combined, 50)).toBe(800);
      // p90: rank ceil(0.90 * 100) - 1 = 89 -> 800
      expect(calculatePercentile(combined, 90)).toBe(800);
      // p91: rank ceil(0.91 * 100) - 1 = 90 -> 15000
      expect(calculatePercentile(combined, 91)).toBe(15000);
      // p95: rank ceil(0.95 * 100) - 1 = 94 -> 15000
      expect(calculatePercentile(combined, 95)).toBe(15000);
      // p99: rank ceil(0.99 * 100) - 1 = 98 -> 15000
      expect(calculatePercentile(combined, 99)).toBe(15000);
    });

    it('Distribution 6: Boundary cliff at exact 95% threshold (95 fast vs 5 slow)', () => {
      // 95 fast at 600ms, 5 slow at 25000ms
      const bimodal = [...Array(95).fill(600), ...Array(5).fill(25000)];
      // At N = 100:
      // p95 index is ceil(0.95 * 100) - 1 = 95 - 1 = 94.
      // Index 94 is the 95th element (the last element of 600ms).
      expect(calculatePercentile(bimodal, 95)).toBe(600);
      // p96 index is ceil(0.96 * 100) - 1 = 96 - 1 = 95.
      // Index 95 is the 96th element (the first element of 25000ms).
      expect(calculatePercentile(bimodal, 96)).toBe(25000);

      // In contrast, if 94 fast and 6 slow:
      const bimodal94 = [...Array(94).fill(600), ...Array(6).fill(25000)];
      // p95 index is 94, which is now 25000ms:
      expect(calculatePercentile(bimodal94, 95)).toBe(25000);
    });

    it('Distribution 7: Scaled stress test with 10,000 latency measurements', () => {
      // 10,000 reviews linearly scaled from 1ms to 10,000ms
      const largeSet = Array.from({ length: 10000 }, (_, i) => i + 1);
      // Nearest rank:
      // p50: ceil(0.50 * 10000) = 5000 -> 5000
      expect(calculatePercentile(largeSet, 50)).toBe(5000);
      // p95: ceil(0.95 * 10000) = 9500 -> 9500
      expect(calculatePercentile(largeSet, 95)).toBe(9500);
      // p99: ceil(0.99 * 10000) = 9900 -> 9900
      expect(calculatePercentile(largeSet, 99)).toBe(9900);
    });
  });

  // ==========================================================================
  // SECTION 2: Time-Window Boundaries (24h, 7d, 30d filtering)
  // ==========================================================================
  describe('Time-Window Boundaries: Precise +/- 1ms Cutoff Filtering', () => {
    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;

    beforeEach(() => {
      // Reset dashboardStore to avoid cross-test pollution
      dashboardStore.reset();
    });

    it('24h Window: excludes (now - 24h - 1ms) and includes (now - 24h + 1ms) & (now - 24h)', () => {
      const now = Date.now();
      const window24hMs = 24 * 3600 * 1000;

      const boundaryLogs: ReviewLogEntry[] = [
        {
          id: 'log-24h-before',
          prRun: 'test/repo #101',
          repo: 'test/repo',
          prNumber: 101,
          headSha: 'abc101',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window24hMs - 1).toISOString(), // 1ms before cutoff
          latencyMs: 9999,
        },
        {
          id: 'log-24h-exact',
          prRun: 'test/repo #102',
          repo: 'test/repo',
          prNumber: 102,
          headSha: 'abc102',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window24hMs).toISOString(), // exactly at cutoff
          latencyMs: 1234,
        },
        {
          id: 'log-24h-after',
          prRun: 'test/repo #103',
          repo: 'test/repo',
          prNumber: 103,
          headSha: 'abc103',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window24hMs + 1).toISOString(), // 1ms inside window
          latencyMs: 5678,
        },
      ];

      (dashboardStore as any).data.reviewLogs = boundaryLogs;
      (dashboardStore as any).invalidateCache();

      const filtered = dashboardStore.getFilteredReviewLogs('24h');
      const filteredIds = filtered.map((l) => l.id);

      expect(filteredIds).not.toContain('log-24h-before');
      expect(filteredIds).toContain('log-24h-exact');
      expect(filteredIds).toContain('log-24h-after');
      expect(filtered.length).toBe(2);
    });

    it('7d Window: excludes (now - 7d - 1ms) and includes (now - 7d + 1ms) & (now - 7d)', () => {
      const now = Date.now();
      const window7dMs = 7 * 86400 * 1000;

      const boundaryLogs: ReviewLogEntry[] = [
        {
          id: 'log-7d-before',
          prRun: 'test/repo #201',
          repo: 'test/repo',
          prNumber: 201,
          headSha: 'abc201',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window7dMs - 1).toISOString(),
          latencyMs: 9999,
        },
        {
          id: 'log-7d-exact',
          prRun: 'test/repo #202',
          repo: 'test/repo',
          prNumber: 202,
          headSha: 'abc202',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window7dMs).toISOString(),
          latencyMs: 2222,
        },
        {
          id: 'log-7d-after',
          prRun: 'test/repo #203',
          repo: 'test/repo',
          prNumber: 203,
          headSha: 'abc203',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window7dMs + 1).toISOString(),
          latencyMs: 3333,
        },
      ];

      (dashboardStore as any).data.reviewLogs = boundaryLogs;
      (dashboardStore as any).invalidateCache();

      const filtered = dashboardStore.getFilteredReviewLogs('7d');
      const filteredIds = filtered.map((l) => l.id);

      expect(filteredIds).not.toContain('log-7d-before');
      expect(filteredIds).toContain('log-7d-exact');
      expect(filteredIds).toContain('log-7d-after');
      expect(filtered.length).toBe(2);
    });

    it('30d Window: excludes (now - 30d - 1ms) and includes (now - 30d + 1ms) & (now - 30d)', () => {
      const now = Date.now();
      const window30dMs = 30 * 86400 * 1000;

      const boundaryLogs: ReviewLogEntry[] = [
        {
          id: 'log-30d-before',
          prRun: 'test/repo #301',
          repo: 'test/repo',
          prNumber: 301,
          headSha: 'abc301',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window30dMs - 1).toISOString(),
          latencyMs: 9999,
        },
        {
          id: 'log-30d-exact',
          prRun: 'test/repo #302',
          repo: 'test/repo',
          prNumber: 302,
          headSha: 'abc302',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window30dMs).toISOString(),
          latencyMs: 4444,
        },
        {
          id: 'log-30d-after',
          prRun: 'test/repo #303',
          repo: 'test/repo',
          prNumber: 303,
          headSha: 'abc303',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: new Date(now - window30dMs + 1).toISOString(),
          latencyMs: 5555,
        },
      ];

      (dashboardStore as any).data.reviewLogs = boundaryLogs;
      (dashboardStore as any).invalidateCache();

      const filtered = dashboardStore.getFilteredReviewLogs('30d');
      const filteredIds = filtered.map((l) => l.id);

      expect(filteredIds).not.toContain('log-30d-before');
      expect(filteredIds).toContain('log-30d-exact');
      expect(filteredIds).toContain('log-30d-after');
      expect(filtered.length).toBe(2);
    });

    it('Gracefully filters out invalid, corrupt, or missing timestamps', () => {
      const corruptLogs: ReviewLogEntry[] = [
        {
          id: 'log-corrupt-1',
          prRun: 'test/repo #401',
          headSha: 'corrupt1',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: 'not-a-valid-date-string',
        },
        {
          id: 'log-corrupt-2',
          prRun: 'test/repo #402',
          headSha: 'corrupt2',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: '',
        },
        {
          id: 'log-corrupt-3',
          prRun: 'test/repo #403',
          headSha: 'corrupt3',
          personas: ['security'],
          quorum: '1/1',
          arbiterVerdict: 'SHIP',
          timestamp: undefined as any,
        },
      ];

      (dashboardStore as any).data.reviewLogs = corruptLogs;
      (dashboardStore as any).invalidateCache();

      expect(dashboardStore.getFilteredReviewLogs('24h')).toEqual([]);
      expect(dashboardStore.getFilteredReviewLogs('7d')).toEqual([]);
      expect(dashboardStore.getFilteredReviewLogs('30d')).toEqual([]);

      // Summary on all-corrupt data returns zero metrics safely
      const summary = dashboardStore.getAnalyticsSummary('7d');
      expect(summary.totalReviews).toBe(0);
      expect(summary.p95DurationMs).toBe(0);
      expect(summary.avgDurationMs).toBe(0);
      expect(summary.totalSpendUsd).toBe(0);
    });
  });

  // ==========================================================================
  // SECTION 3: Repository Filtering & Query Validation
  // ==========================================================================
  describe('Repository Filtering & Adversarial Query Validation', () => {
    beforeEach(() => {
      dashboardStore.reset();
    });

    it('Strictly rejects invalid window/range query values with HTTP 400 across all 5 endpoints', async () => {
      const invalidRanges = [
        '90d',
        'invalid',
        '1y',
        '12h',
        '0d',
        '365d',
        'all',
        '../passwd',
        'true',
      ];
      const endpoints = ['/summary', '/latency', '/costs', '/tokens', '/findings'];

      for (const ep of endpoints) {
        for (const badRange of invalidRanges) {
          // Test with ?range=
          const resRange = await request(app)
            .get(`/api/analytics${ep}?range=${encodeURIComponent(badRange)}`)
            .set('Authorization', `Bearer ${authToken}`);

          expect(resRange.status).toBe(400);
          expect(resRange.body.success).toBe(false);
          expect(resRange.body.error).toContain('Unsupported range');

          // Test with ?window=
          const resWindow = await request(app)
            .get(`/api/analytics${ep}?window=${encodeURIComponent(badRange)}`)
            .set('Authorization', `Bearer ${authToken}`);

          expect(resWindow.status).toBe(400);
          expect(resWindow.body.success).toBe(false);
          expect(resWindow.body.error).toContain('Unsupported range');
        }
      }
    });

    it('Repository filtering correctly isolates metrics for specific repos', async () => {
      // Query summary for exampleorg/example-api
      const resCisco = await request(app)
        .get('/api/analytics/summary?range=30d&repo=exampleorg/example-api')
        .set('Authorization', `Bearer ${authToken}`);

      expect(resCisco.status).toBe(200);
      expect(resCisco.body.success).toBe(true);
      expect(resCisco.body.summary.repo).toBe('exampleorg/example-api');
      expect(resCisco.body.summary.activeRepositories).toBe(1);

      // Query summary for exampleorg/example-meta
      const resMeta = await request(app)
        .get('/api/analytics/summary?range=30d&repo=exampleorg/example-meta')
        .set('Authorization', `Bearer ${authToken}`);

      expect(resMeta.status).toBe(200);
      expect(resMeta.body.success).toBe(true);
      expect(resMeta.body.summary.repo).toBe('exampleorg/example-meta');

      // Unfiltered "All Repositories" should have review count >= sum of individual repos
      const resAll = await request(app)
        .get('/api/analytics/summary?range=30d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(resAll.status).toBe(200);
      expect(resAll.body.summary.totalReviews).toBeGreaterThanOrEqual(
        resCisco.body.summary.totalReviews + resMeta.body.summary.totalReviews
      );
    });

    it('Repository filter with non-existent repo returns 200 OK with zero metrics gracefully', async () => {
      const res = await request(app)
        .get('/api/analytics/summary?range=7d&repo=org/does-not-exist')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary.totalReviews).toBe(0);
      expect(res.body.summary.p95DurationMs).toBe(0);
      expect(res.body.summary.avgDurationMs).toBe(0);
      expect(res.body.summary.totalSpendUsd).toBe(0);
      expect(res.body.summary.totalTokens).toBe(0);
    });

    it('Adversarial inputs in repo parameter are sanitized and treated safely', async () => {
      const maliciousRepos = [
        "exampleorg/example-api' OR '1'='1",
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "exampleorg/example-api; DROP TABLE review_logs;",
      ];

      for (const badRepo of maliciousRepos) {
        const res = await request(app)
          .get(`/api/analytics/summary?range=7d&repo=${encodeURIComponent(badRepo)}`)
          .set('Authorization', `Bearer ${authToken}`);

        // Must safely return 200 with zero reviews (since repo does not match)
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.summary.totalReviews).toBe(0);
      }
    });

    it('Repository filtering applies consistently across latency, costs, tokens, and findings endpoints', async () => {
      const repo = 'exampleorg/example-api';

      // 1. Latency
      const resLatency = await request(app)
        .get(`/api/analytics/latency?range=7d&repo=${encodeURIComponent(repo)}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(resLatency.status).toBe(200);
      expect(resLatency.body.repo).toBe(repo);

      // 2. Costs
      const resCosts = await request(app)
        .get(`/api/analytics/costs?range=7d&repo=${encodeURIComponent(repo)}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(resCosts.status).toBe(200);
      expect(resCosts.body.byRepo.every((r: any) => r.repo === repo)).toBe(true);

      // 3. Tokens
      const resTokens = await request(app)
        .get(`/api/analytics/tokens?range=7d&repo=${encodeURIComponent(repo)}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(resTokens.status).toBe(200);

      // 4. Findings
      const resFindings = await request(app)
        .get(`/api/analytics/findings?range=7d&repo=${encodeURIComponent(repo)}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(resFindings.status).toBe(200);
    });
  });
});
