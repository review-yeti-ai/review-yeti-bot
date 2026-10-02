import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import {
  dashboardStore,
  calculatePercentile,
  generateDefaultReviewLogs,
} from '../../src/persistence/dashboardStore';
import { AnalyticsTimeRange } from '../../src/types/analytics';

describe('Milestone 4 Challenger 2: Multi-Window Cost, Token & Severity Stress Harness', () => {
  let app: any;
  let authToken: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

    // Clear cache before each test
    (dashboardStore as any).invalidateCache();

    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  // ==========================================================================
  // SECTION 1: Spend Breakdown Rollup (`byRepo` Sum vs Global `totalSpendUsd`)
  // ==========================================================================
  describe('Mission 1: `byRepo` spend breakdown sums match global `totalCost` across all time windows (24h, 7d, 30d)', () => {
    const windows: AnalyticsTimeRange[] = ['24h', '7d', '30d'];

    windows.forEach((window) => {
      it(`[${window}] byRepo spend sum matches totalSpendUsd within floating point precision`, async () => {
        const resCosts = await request(app)
          .get(`/api/analytics/costs?range=${window}`)
          .set('Authorization', `Bearer ${authToken}`);

        expect(resCosts.status).toBe(200);
        expect(resCosts.body.success).toBe(true);

        const { totalSpendUsd, byRepo } = resCosts.body;
        expect(typeof totalSpendUsd).toBe('number');
        expect(Array.isArray(byRepo)).toBe(true);

        // Sum byRepo spendUsd
        const sumByRepoSpend = byRepo.reduce(
          (acc: number, item: { spendUsd: number }) => acc + item.spendUsd,
          0
        );

        // Precision check: within 0.0002 due to individual repo toFixed(4)
        const diff = Math.abs(sumByRepoSpend - totalSpendUsd);
        expect(diff).toBeLessThanOrEqual(0.001);

        // Also verify reviewCount sums
        const sumByRepoReviews = byRepo.reduce(
          (acc: number, item: { reviewCount: number }) => acc + item.reviewCount,
          0
        );

        // Verify totalTokens sums
        const sumByRepoTokens = byRepo.reduce(
          (acc: number, item: { totalTokens: number }) => acc + item.totalTokens,
          0
        );

        // Compare against GET /api/analytics/summary
        const resSummary = await request(app)
          .get(`/api/analytics/summary?range=${window}`)
          .set('Authorization', `Bearer ${authToken}`);

        expect(resSummary.status).toBe(200);
        const { summary } = resSummary.body;

        expect(summary.totalSpendUsd).toBeCloseTo(totalSpendUsd, 4);
        expect(summary.totalReviews).toBe(sumByRepoReviews);
        expect(summary.totalTokens).toBe(sumByRepoTokens);
      });
    });

    it('handles single-repository filter: byRepo has exactly 1 entry matching totalSpendUsd', async () => {
      const targetRepo = 'calltelemetry/cisco-cdr';
      for (const window of windows) {
        const resCosts = await request(app)
          .get(`/api/analytics/costs?range=${window}&repo=${targetRepo}`)
          .set('Authorization', `Bearer ${authToken}`);

        expect(resCosts.status).toBe(200);
        const { totalSpendUsd, byRepo } = resCosts.body;

        expect(byRepo.length).toBeLessThanOrEqual(1);
        if (byRepo.length === 1) {
          expect(byRepo[0].repo).toBe(targetRepo);
          expect(byRepo[0].spendUsd).toBeCloseTo(totalSpendUsd, 4);
        } else {
          expect(totalSpendUsd).toBe(0);
        }
      }
    });

    it('handles zero review runs in window: totalSpendUsd is 0 and byRepo is empty array', async () => {
      // Create isolated store state with empty logs
      const rawStore = dashboardStore as any;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        rawStore.data.reviewLogs = [];
        (dashboardStore as any).invalidateCache();

        for (const window of windows) {
          const resCosts = await request(app)
            .get(`/api/analytics/costs?range=${window}`)
            .set('Authorization', `Bearer ${authToken}`);

          expect(resCosts.status).toBe(200);
          expect(resCosts.body.totalSpendUsd).toBe(0);
          expect(resCosts.body.byRepo).toEqual([]);

          const resSummary = await request(app)
            .get(`/api/analytics/summary?range=${window}`)
            .set('Authorization', `Bearer ${authToken}`);

          expect(resSummary.status).toBe(200);
          expect(resSummary.body.summary.totalSpendUsd).toBe(0);
          expect(resSummary.body.summary.totalReviews).toBe(0);
        }
      } finally {
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });

    it('stress tests multi-repo spend aggregation with 50 synthetic repositories and fractional costs', async () => {
      const rawStore = dashboardStore as any;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        const syntheticLogs = [];
        const now = Date.now();
        let expectedTotalSpend = 0;

        for (let i = 0; i < 50; i++) {
          const repoName = `org/repo-${i % 10}`;
          const cost = parseFloat((0.0123 + (i * 0.0045)).toFixed(4));
          syntheticLogs.push({
            id: `synthetic-cost-run-${i}`,
            repo: repoName,
            prRun: `${repoName} #${100 + i}`,
            prNumber: 100 + i,
            timestamp: new Date(now - (i * 3600 * 1000)).toISOString(), // spread over 50 hours
            latencyMs: 1500,
            costUSD: cost,
            cost: cost,
            tokens: { prompt: 1000, completion: 200, total: 1200 },
            status: 'completed',
          });
        }

        rawStore.data.reviewLogs = syntheticLogs;
        (dashboardStore as any).invalidateCache();

        const res = await request(app)
          .get('/api/analytics/costs?range=7d')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const { totalSpendUsd, byRepo } = res.body;

        const sumSpend = byRepo.reduce((acc: number, r: any) => acc + r.spendUsd, 0);
        // Ensure rollup matches global totalSpendUsd within round-off tolerance
        expect(Math.abs(sumSpend - totalSpendUsd)).toBeLessThanOrEqual(0.002);
        expect(byRepo.length).toBe(10); // 10 distinct repos
      } finally {
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });
  });

  // ==========================================================================
  // SECTION 2: Monotonic Cumulative Token Burn Curves
  // ==========================================================================
  describe('Mission 2: Cumulative token burn curves (`cumulativeTokens` monotonically non-decreasing)', () => {
    const windows: AnalyticsTimeRange[] = ['24h', '7d', '30d'];

    windows.forEach((window) => {
      it(`[${window}] cumulativeTokens is strictly monotonically non-decreasing over time series`, async () => {
        const res = await request(app)
          .get(`/api/analytics/tokens?range=${window}`)
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const { data, totalTokens, promptTokens, completionTokens } = res.body;
        expect(Array.isArray(data)).toBe(true);

        const expectedLength = window === '24h' ? 1 : window === '30d' ? 30 : 7;
        expect(data.length).toBe(expectedLength);

        let previousCumulative = 0;
        let runningTotal = 0;

        for (let i = 0; i < data.length; i++) {
          const pt = data[i];

          // 1. Non-negative token counts
          expect(pt.promptTokens).toBeGreaterThanOrEqual(0);
          expect(pt.completionTokens).toBeGreaterThanOrEqual(0);
          expect(pt.totalTokens).toBe(pt.promptTokens + pt.completionTokens);

          // 2. Monotonically non-decreasing assertion
          expect(pt.cumulativeTokens).toBeGreaterThanOrEqual(previousCumulative);
          previousCumulative = pt.cumulativeTokens;

          runningTotal += pt.totalTokens;
          expect(pt.cumulativeTokens).toBe(runningTotal);
        }

        // Final point must equal totalTokens
        const finalPoint = data[data.length - 1];
        expect(finalPoint.cumulativeTokens).toBe(totalTokens);
        expect(totalTokens).toBe(promptTokens + completionTokens);
      });
    });

    it('stress tests monotonic burn curves with burst traffic on isolated days', async () => {
      const rawStore = dashboardStore as any;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        const now = Date.now();
        const DAY = 24 * 3600 * 1000;
        // Traffic only on day -5 and day -2
        const burstLogs = [
          {
            id: 'burst-1',
            repo: 'calltelemetry/cisco-cdr',
            timestamp: new Date(now - 5 * DAY).toISOString(),
            latencyMs: 2000,
            tokens: { prompt: 50000, completion: 5000, total: 55000 },
          },
          {
            id: 'burst-2',
            repo: 'calltelemetry/cisco-cdr',
            timestamp: new Date(now - 2 * DAY).toISOString(),
            tokens: { prompt: 100000, completion: 15000, total: 115000 },
          },
        ];

        rawStore.data.reviewLogs = burstLogs;
        (dashboardStore as any).invalidateCache();

        const res = await request(app)
          .get('/api/analytics/tokens?range=7d')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const { data, totalTokens } = res.body;

        expect(totalTokens).toBe(170000);
        let prev = 0;
        for (const pt of data) {
          expect(pt.cumulativeTokens).toBeGreaterThanOrEqual(prev);
          prev = pt.cumulativeTokens;
        }
        expect(data[data.length - 1].cumulativeTokens).toBe(170000);
      } finally {
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });

    it('handles out-of-order review timestamps gracefully preserving chronological monotonicity', async () => {
      const rawStore = dashboardStore as any;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        const now = Date.now();
        const DAY = 24 * 3600 * 1000;
        // Out of chronological order
        const shuffledLogs = [
          {
            id: 'shuffled-1',
            repo: 'repo-a',
            timestamp: new Date(now - 1 * DAY).toISOString(),
            tokens: { prompt: 1000, completion: 100, total: 1100 },
          },
          {
            id: 'shuffled-2',
            repo: 'repo-a',
            timestamp: new Date(now - 6 * DAY).toISOString(),
            tokens: { prompt: 2000, completion: 200, total: 2200 },
          },
          {
            id: 'shuffled-3',
            repo: 'repo-a',
            timestamp: new Date(now - 3 * DAY).toISOString(),
            tokens: { prompt: 3000, completion: 300, total: 3300 },
          },
        ];

        rawStore.data.reviewLogs = shuffledLogs;
        (dashboardStore as any).invalidateCache();

        const res = await request(app)
          .get('/api/analytics/tokens?range=7d')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const { data, totalTokens } = res.body;

        expect(totalTokens).toBe(6600);
        let prev = 0;
        for (const pt of data) {
          expect(pt.cumulativeTokens).toBeGreaterThanOrEqual(prev);
          prev = pt.cumulativeTokens;
        }
        expect(data[data.length - 1].cumulativeTokens).toBe(6600);
      } finally {
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });

    it('handles zero reviews: cumulativeTokens stays 0 across all time steps', async () => {
      const rawStore = dashboardStore as any;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        rawStore.data.reviewLogs = [];
        (dashboardStore as any).invalidateCache();

        const res = await request(app)
          .get('/api/analytics/tokens?range=30d')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const { data, totalTokens, promptTokens, completionTokens } = res.body;

        expect(totalTokens).toBe(0);
        expect(promptTokens).toBe(0);
        expect(completionTokens).toBe(0);
        expect(data.length).toBe(30);

        for (const pt of data) {
          expect(pt.totalTokens).toBe(0);
          expect(pt.cumulativeTokens).toBe(0);
        }
      } finally {
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });
  });

  // ==========================================================================
  // SECTION 3: Finding Quality, Severity Ratios & Acceptance Rates
  // ==========================================================================
  describe('Mission 3: Finding quality & severity metrics (P0+P1+P2 == 100% or 0%, acceptance + dismissal == 100%)', () => {
    const windows: AnalyticsTimeRange[] = ['24h', '7d', '30d'];

    windows.forEach((window) => {
      it(`[${window}] P0/P1/P2 counts sum to totalFindings and acceptanceRate + dismissalRate == 100%`, async () => {
        const res = await request(app)
          .get(`/api/analytics/findings?range=${window}`)
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const {
          totalFindings,
          severityCounts,
          severityRatio,
          acceptanceRate,
          dismissalRate,
          activeFindings,
          dismissedFindings,
        } = res.body;

        // 1. Severity counts must sum to totalFindings
        const sumCounts = severityCounts.P0 + severityCounts.P1 + severityCounts.P2;
        expect(sumCounts).toBe(totalFindings);

        // 2. Active + dismissed must sum to totalFindings
        expect(activeFindings + dismissedFindings).toBe(totalFindings);

        // 3. Acceptance rate + Dismissal rate == 100%
        if (totalFindings > 0) {
          expect(Math.round(acceptanceRate + dismissalRate)).toBe(100);
          expect(Math.abs(acceptanceRate + dismissalRate - 100)).toBeLessThanOrEqual(0.1);
        } else {
          expect(acceptanceRate).toBe(100);
          expect(dismissalRate).toBe(0);
        }

        // 4. Severity ratios sum: when totalFindings > 0, sum of ratios is ~1.0 (100%)
        if (totalFindings > 0) {
          const ratioSum = severityRatio.p0 + severityRatio.p1 + severityRatio.p2;
          expect(ratioSum).toBeGreaterThanOrEqual(0.99);
          expect(ratioSum).toBeLessThanOrEqual(1.01);

          // In percentage terms (e.g. rounded as shown in UI)
          const p0Pct = Math.round(severityRatio.p0 * 100);
          const p1Pct = Math.round(severityRatio.p1 * 100);
          const p2Pct = Math.round(severityRatio.p2 * 100);
          expect(p0Pct + p1Pct + p2Pct).toBeGreaterThanOrEqual(99);
          expect(p0Pct + p1Pct + p2Pct).toBeLessThanOrEqual(101);
        } else {
          expect(severityRatio.p0).toBe(0);
          expect(severityRatio.p1).toBe(0);
          expect(severityRatio.p2).toBe(0);
        }
      });
    });

    it('verifies zero findings edge case: severity ratios are 0% and acceptance is 100% default', async () => {
      const rawStore = dashboardStore as any;
      const originalFindings = rawStore.data.findings;
      const originalFindingStates = rawStore.data.findingStates;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        rawStore.data.findings = {};
        rawStore.data.findingStates = {};
        // Strip personaLogs nits
        rawStore.data.reviewLogs = (rawStore.data.reviewLogs || []).map((l: any) => ({
          ...l,
          personaLogs: [],
        }));
        (dashboardStore as any).invalidateCache();

        const res = await request(app)
          .get('/api/analytics/findings?range=7d')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.totalFindings).toBe(0);
        expect(res.body.severityCounts.P0).toBe(0);
        expect(res.body.severityCounts.P1).toBe(0);
        expect(res.body.severityCounts.P2).toBe(0);

        // Ratios are 0
        expect(res.body.severityRatio.p0).toBe(0);
        expect(res.body.severityRatio.p1).toBe(0);
        expect(res.body.severityRatio.p2).toBe(0);

        // Acceptance rate defaults to 100%, dismissalRate to 0%
        expect(res.body.acceptanceRate).toBe(100);
        expect(res.body.dismissalRate).toBe(0);
        expect(res.body.acceptanceRate + res.body.dismissalRate).toBe(100);
      } finally {
        rawStore.data.findings = originalFindings;
        rawStore.data.findingStates = originalFindingStates;
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });

    it('stress tests finding ratios with arbitrary mixtures of P0, P1, P2 and dismissals', async () => {
      const rawStore = dashboardStore as any;
      const originalFindings = rawStore.data.findings;
      const originalFindingStates = rawStore.data.findingStates;
      const originalLogs = rawStore.data.reviewLogs;

      try {
        const testReviewId = 'job-stress-finding-test';
        const now = Date.now();

        // 1 review run
        rawStore.data.reviewLogs = [
          {
            id: testReviewId,
            repo: 'calltelemetry/test-repo',
            prRun: 'calltelemetry/test-repo #1',
            timestamp: new Date(now - 3600 * 1000).toISOString(),
            status: 'completed',
          },
        ];

        // 12 findings: 3 P0 (1 dismissed), 4 P1 (2 dismissed), 5 P2 (1 dismissed)
        // Total = 12 findings. Active = 8, Dismissed = 4.
        // Acceptance = 8 / 12 = 66.7%, Dismissal = 4 / 12 = 33.3%. Sum = 100%.
        // P0 ratio = 3 / 12 = 0.25 (25%)
        // P1 ratio = 4 / 12 = 0.333 (33.3%)
        // P2 ratio = 5 / 12 = 0.417 (41.7%)
        const findingsMap: Record<string, any> = {};
        for (let i = 0; i < 3; i++) {
          findingsMap[`p0-${i}`] = {
            id: `p0-${i}`,
            severity: 'P0',
            status: i === 0 ? 'dismissed' : 'active',
            dismissedReason: i === 0 ? 'False positive' : undefined,
          };
        }
        for (let i = 0; i < 4; i++) {
          findingsMap[`p1-${i}`] = {
            id: `p1-${i}`,
            severity: 'P1',
            status: i < 2 ? 'dismissed' : 'active',
            dismissedReason: i < 2 ? 'Intentional design' : undefined,
          };
        }
        for (let i = 0; i < 5; i++) {
          findingsMap[`p2-${i}`] = {
            id: `p2-${i}`,
            severity: 'P2',
            status: i === 0 ? 'dismissed' : 'active',
            dismissedReason: i === 0 ? 'Minor nit ignored' : undefined,
          };
        }

        rawStore.data.findings = { [testReviewId]: findingsMap };
        rawStore.data.findingStates = {};
        (dashboardStore as any).invalidateCache();

        const res = await request(app)
          .get('/api/analytics/findings?range=24h')
          .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const {
          totalFindings,
          severityCounts,
          severityRatio,
          acceptanceRate,
          dismissalRate,
          activeFindings,
          dismissedFindings,
        } = res.body;

        expect(totalFindings).toBe(12);
        expect(severityCounts.P0).toBe(3);
        expect(severityCounts.P1).toBe(4);
        expect(severityCounts.P2).toBe(5);

        expect(activeFindings).toBe(8);
        expect(dismissedFindings).toBe(4);

        expect(acceptanceRate).toBe(66.7);
        expect(dismissalRate).toBe(33.3);
        expect(acceptanceRate + dismissalRate).toBe(100);

        expect(severityRatio.p0).toBe(0.25);
        expect(severityRatio.p1).toBe(0.333);
        expect(severityRatio.p2).toBe(0.417);
        expect(severityRatio.p0 + severityRatio.p1 + severityRatio.p2).toBe(1.0);
      } finally {
        rawStore.data.findings = originalFindings;
        rawStore.data.findingStates = originalFindingStates;
        rawStore.data.reviewLogs = originalLogs;
        (dashboardStore as any).invalidateCache();
      }
    });
  });

  // ==========================================================================
  // SECTION 4: Cross-Window Invariance & Boundary Integrity
  // ==========================================================================
  describe('Cross-Window Invariance & Monotonic Window Bounds', () => {
    it('review counts, spend, and token volume monotonically expand or equal from 24h -> 7d -> 30d', async () => {
      const res24h = await request(app)
        .get('/api/analytics/summary?range=24h')
        .set('Authorization', `Bearer ${authToken}`);
      const res7d = await request(app)
        .get('/api/analytics/summary?range=7d')
        .set('Authorization', `Bearer ${authToken}`);
      const res30d = await request(app)
        .get('/api/analytics/summary?range=30d')
        .set('Authorization', `Bearer ${authToken}`);

      const s24h = res24h.body.summary;
      const s7d = res7d.body.summary;
      const s30d = res30d.body.summary;

      // In any time series, 24h <= 7d <= 30d
      expect(s7d.totalReviews).toBeGreaterThanOrEqual(s24h.totalReviews);
      expect(s30d.totalReviews).toBeGreaterThanOrEqual(s7d.totalReviews);

      expect(s7d.totalSpendUsd).toBeGreaterThanOrEqual(s24h.totalSpendUsd);
      expect(s30d.totalSpendUsd).toBeGreaterThanOrEqual(s7d.totalSpendUsd);

      expect(s7d.totalTokens).toBeGreaterThanOrEqual(s24h.totalTokens);
      expect(s30d.totalTokens).toBeGreaterThanOrEqual(s7d.totalTokens);
    });
  });
});
