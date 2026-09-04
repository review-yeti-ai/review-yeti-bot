// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { ReviewRunStore } from '../../src/persistence/reviewRunStore';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import { OverviewMetrics } from '../../src/components/dashboard/overview-metrics';
import { RecentReviewsTable } from '../../src/components/dashboard/recent-reviews-table';
import { PersonaStatusGrid } from '../../src/components/dashboard/persona-status-grid';

const TEST_DIR = path.join(__dirname, '../../fixtures/tmp/empty_state_stress');

describe('M2 & M3 Adversarial Stress Testing: Empty State & Zero-Value Metrics', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('1. ReviewRunStore Empty State & Boundary Testing', () => {
    it('behaves safely with 0 reviews and non-existent database file', () => {
      const nonExistentPath = path.join(TEST_DIR, 'non_existent_review_runs.json');
      const store = new ReviewRunStore(nonExistentPath);

      expect(store.getHead('calltelemetry', 'cisco-cdr', 1)).toBeUndefined();
      expect(store.getPreviousHead('calltelemetry', 'cisco-cdr', 1)).toBeUndefined();
      expect(store.isCurrentHead('calltelemetry', 'cisco-cdr', 1, 'sha123')).toBe(false);
      expect(store.filterResolvedNits(1, [])).toEqual([]);
    });

    it('handles null/undefined and empty input parameters gracefully without throwing', () => {
      const storePath = path.join(TEST_DIR, 'empty_review_runs.json');
      fs.writeFileSync(storePath, JSON.stringify({ deliveries: {}, heads: {}, threads: {} }), 'utf8');
      const store = new ReviewRunStore(storePath);

      expect(store.claimDelivery('')).toBe(false);
      expect(store.claimDelivery(null as any)).toBe(false);
      expect(store.filterResolvedNits(1, null as any)).toEqual([]);
      expect(store.filterResolvedNits(1, undefined as any)).toEqual([]);

      expect(() => store.recordThreads(1, [])).not.toThrow();
      expect(() => store.recordThreads(1, null as any)).not.toThrow();
    });

    it('handles empty JSON file or corrupted JSON gracefully', () => {
      const corruptPath = path.join(TEST_DIR, 'corrupt_review_runs.json');
      fs.writeFileSync(corruptPath, '{ invalid_json: ', 'utf8');

      let store: ReviewRunStore | null = null;
      let constructionError: unknown = null;
      try {
        store = new ReviewRunStore(corruptPath);
      } catch (err) {
        constructionError = err;
      }
      expect(constructionError).toBeNull();

      expect(store?.getHead(123)).toBeUndefined();
      expect(store?.filterResolvedNits(123, [{ title: 'test' }])).toEqual([{ title: 'test' }]);
    });
  });

  describe('2. PRMemoryStore Empty State & Boundary Testing', () => {
    let memoryStore: PRMemoryStore;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
    });

    afterEach(() => {
      memoryStore.close();
    });

    it('returns zero counts for uninitialized / empty memory store', async () => {
      const counts = memoryStore.getCounts();
      expect(counts).toEqual({
        learningsCount: 0,
        suppressedNitsCount: 0,
        adrConstraintsCount: 0,
      });

      const repoState = await memoryStore.queryLearnings('calltelemetry/cisco-cdr');
      expect(repoState.learnings).toEqual([]);
      expect(repoState.resolvedNits).toEqual([]);
      expect(repoState.adrConstraints).toEqual([]);

      const feedback = memoryStore.getFeedbackCounts('calltelemetry/cisco-cdr');
      expect(feedback).toEqual({
        positiveFeedbackCount: 0,
        negativeFeedbackCount: 0,
      });
    });

    it('handles query parameters on 0 memories without errors', async () => {
      const repoState = await memoryStore.queryLearnings('non-existent-repo', {
        category: 'security',
        filePath: 'src/index.ts',
        query: 'auth',
      });
      expect(repoState.learnings).toHaveLength(0);
      expect(repoState.resolvedNits).toHaveLength(0);
      expect(repoState.adrConstraints).toHaveLength(0);
    });

    it('handles batch operations on empty arrays safely', async () => {
      await expect(memoryStore.incrementNitSuppressionBatch([])).resolves.not.toThrow();
    });

    it('handles corrupt or empty git file imports gracefully', async () => {
      await expect(memoryStore.importFromGitFile('test-repo', '')).resolves.not.toThrow();
      await expect(memoryStore.importFromGitFile('test-repo', '{ invalid: json ')).resolves.not.toThrow();
      await expect(memoryStore.importFromGitFile('test-repo', '{}')).resolves.not.toThrow();
    });

    it('exports empty repo state to valid JSON string', async () => {
      const exported = await memoryStore.exportToGitFile('empty-repo');
      expect(exported).toBeDefined();
      const parsed = JSON.parse(exported);
      expect(parsed.repo).toBe('empty-repo');
      expect(parsed.memory.learnings).toEqual([]);
      expect(parsed.memory.resolvedNits).toEqual([]);
      expect(parsed.memory.adrConstraints).toEqual([]);
    });
  });

  describe('3. SymbolGraphStore Empty State & Boundary Testing', () => {
    let graphStore: SymbolGraphStore;

    beforeEach(() => {
      graphStore = new SymbolGraphStore(':memory:');
    });

    afterEach(async () => {
      await graphStore.close();
    });

    it('returns zero nodes and zero edges for empty database', () => {
      const counts = graphStore.getCounts();
      expect(counts).toEqual({ nodes: 0, edges: 0 });
    });

    it('returns empty result structure for querySymbols when 0 symbols indexed', async () => {
      const res = await graphStore.querySymbols('nonExistentSymbol');
      expect(res.symbolName).toBe('nonExistentSymbol');
      expect(res.definitions).toEqual([]);
      expect(res.references).toEqual([]);
      expect(res.callers).toEqual([]);
      expect(res.callees).toEqual([]);
      expect(res.length).toBe(0);
      expect(res[0]).toBeUndefined();
    });

    it('returns empty array for queryCallers on empty database', () => {
      const callers = graphStore.queryCallers('nonExistentSymbol');
      expect(callers).toEqual([]);
    });

    it('returns empty results for semanticSearch on empty database', async () => {
      const results = await graphStore.semanticSearch('authentication token', 10);
      expect(results).toEqual([]);
    });

    it('indexes empty directory cleanly returning zero metrics', async () => {
      const emptyDir = path.join(TEST_DIR, 'empty_repo');
      fs.mkdirSync(emptyDir, { recursive: true });

      const stats = await graphStore.indexRepository(emptyDir);
      expect(stats.filesIndexed).toBe(0);
      expect(stats.totalLines).toBe(0);
      expect(stats.symbolsExtracted).toBe(0);
      expect(stats.referencesRecorded).toBe(0);
    });
  });

  describe('4. DashboardStore Empty State & Analytics Verification', () => {
    let storePath: string;
    let dashStore: DashboardStore;

    beforeEach(() => {
      storePath = path.join(TEST_DIR, 'dashboard_empty.json');
      const emptyData = {
        repositories: [],
        settings: {
          defaultModelOverrides: {},
          memoryEngineSettings: { autoSuppressNits: true, learningConfidenceThreshold: 80, maxLearningsPerRepo: 500 },
          providerCostCaps: { monthlyBudgetUSD: 100, dailyBudgetUSD: 10, alertThresholdPercent: 80, actionOnCapBreach: 'fail_closed' },
        },
        apiKeys: [],
        reviewCounter: 0,
        totalCostUSD: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        reviewLogs: [],
      };
      fs.writeFileSync(storePath, JSON.stringify(emptyData), 'utf8');
      dashStore = new DashboardStore(storePath);
    });

    it('getOverviewStats computes accurate zero-value metrics with 0 reviews', () => {
      const overview = dashStore.getOverviewStats();
      expect(overview.totalRepositories).toBe(0);
      expect(overview.activeAutomations).toBe(0);
      expect(overview.totalReviewsExecuted).toBe(0);
      expect(overview.totalCostUSD).toBe(0);
      expect(overview.costCapBreached).toBe(false);
      expect(overview.totalTokens).toEqual({ prompt: 0, completion: 0, total: 0 });
      expect(overview.memoryGraph).toEqual({
        symbolNodesCount: 0,
        symbolEdgesCount: 0,
        learningsCount: 0,
        suppressedNitsCount: 0,
        adrConstraintsCount: 0,
      });
    });

    it('getAnalyticsSummary computes zero values without NaN or division by zero errors', () => {
      const summary = dashStore.getAnalyticsSummary();
      expect(summary.totalReviews).toBe(0);
      expect(summary.totalSpendUsd).toBe(0);
      expect(summary.totalTokens).toBe(0);
      expect(summary.avgLatencyMs).toBe(0);
      expect(summary.successRate).toBe(100);
      expect(summary.memoryRulesCount).toBe(0);
      expect(Number.isNaN(summary.avgLatencyMs)).toBe(false);
      expect(Number.isNaN(summary.successRate)).toBe(false);
    });

    it('getTokenTimeSeries generates zero tokens per interval without error', () => {
      const timeSeries = dashStore.getTokenTimeSeries('7d');
      expect(timeSeries).toHaveLength(7);
      for (const pt of timeSeries) {
        expect(pt.promptTokens).toBe(0);
        expect(pt.completionTokens).toBe(0);
        expect(pt.totalTokens).toBe(0);
      }
    });

    it('getCostBreakdown handles zero total spend without NaN', () => {
      const costBreakdown = dashStore.getCostBreakdown();
      expect(costBreakdown.totalSpendUsd).toBe(0);
      expect(costBreakdown.budgetPercentUsed).toBe(0);
      expect(Array.isArray(costBreakdown.breakdown)).toBe(true);
      for (const item of costBreakdown.breakdown) {
        expect(item.spendUsd).toBe(0);
        expect(item.percentage).toBe(0);
        expect(Number.isNaN(item.spendUsd)).toBe(false);
        expect(Number.isNaN(item.percentage)).toBe(false);
      }
    });

    it('getPersonaAnalytics handles 0 reviews without division by zero or NaN', () => {
      const analytics = dashStore.getPersonaAnalytics();
      expect(Array.isArray(analytics)).toBe(true);
      expect(analytics.length).toBeGreaterThan(0);
      for (const p of analytics) {
        expect(p.totalReviews).toBe(0);
        expect(p.approvalRate).toBe(0);
        expect(p.avgConfidence).toBe(0);
        expect(p.avgLatencyMs).toBe(0);
        expect(Number.isNaN(p.approvalRate)).toBe(false);
        expect(Number.isNaN(p.avgConfidence)).toBe(false);
        expect(Number.isNaN(p.avgLatencyMs)).toBe(false);
      }
    });

    it('getIndexerAnalytics returns zero latencies when indexer metrics are empty', () => {
      const analytics = dashStore.getIndexerAnalytics();
      expect(analytics.astParseLatencyMs).toBe(0);
      expect(analytics.vectorEmbedLatencyMs).toBe(0);
      expect(Number.isNaN(analytics.astParseLatencyMs)).toBe(false);
      expect(Number.isNaN(analytics.vectorEmbedLatencyMs)).toBe(false);
    });

    it('handles review log entries with missing optional fields without crashing', () => {
      const malformedRun = {
        id: 'run-malformed',
        // prRun, repo, prNumber missing
        headSha: undefined,
        personas: undefined,
        quorum: undefined,
        arbiterVerdict: undefined,
        timestamp: undefined,
        latencyMs: undefined,
        costUSD: undefined,
        tokens: undefined,
      };

      expect(() => {
        dashStore.recordReviewRun(malformedRun);
      }).not.toThrow();

      const logs = dashStore.getReviewLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].repo).toBeDefined();
      expect(logs[0].prNumber).toBe(1);
      expect(logs[0].verdict).toBe('SHIP');
      expect(logs[0].costUSD).toBe(0);
      expect(logs[0].latencyMs).toBe(0);

      expect(() => dashStore.getAnalyticsSummary()).not.toThrow();
      expect(() => dashStore.getCostBreakdown()).not.toThrow();
      expect(() => dashStore.getPersonaAnalytics()).not.toThrow();
    });
  });

  describe('5. Frontend Components Empty & Null State Rendering', () => {
    it('OverviewMetrics renders zero stats safely when stats prop is null or undefined', () => {
      const { container: containerNull } = render(<OverviewMetrics stats={null} />);
      expect(containerNull).toBeDefined();
      expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(3); // todaysReviews, totalReviews, activeRepos, symbolNodes

      const { container: containerUndef } = render(<OverviewMetrics stats={undefined} />);
      expect(containerUndef).toBeDefined();
    });

    it('OverviewMetrics handles empty object stats without throwing', () => {
      const { container } = render(<OverviewMetrics stats={{} as any} />);
      expect(container).toBeDefined();
      expect(screen.getByText('Within Budget')).toBeInTheDocument();
    });

    it('RecentReviewsTable renders empty state banner when jobs is empty array, null, or undefined', () => {
      const { rerender } = render(<RecentReviewsTable jobs={[]} />);
      expect(screen.getByText('No recent PR review executions')).toBeInTheDocument();

      rerender(<RecentReviewsTable jobs={undefined} />);
      expect(screen.getByText('No recent PR review executions')).toBeInTheDocument();

      rerender(<RecentReviewsTable jobs={null as any} />);
      expect(screen.getByText('No recent PR review executions')).toBeInTheDocument();
    });

    it('RecentReviewsTable handles jobs with missing fields safely', () => {
      const jobsWithMissingFields = [
        {
          id: 'job-1',
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 101,
          title: 'Fix issue',
          status: 'completed' as const,
          verdict: 'SHIP' as const,
          personas: [],
          tokens: 0,
          cost: 0,
          latencyMs: 120,
          timestamp: '10m ago',
        },
      ];

      render(<RecentReviewsTable jobs={jobsWithMissingFields} />);
      expect(screen.getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
      expect(screen.getByText('Fix issue')).toBeInTheDocument();
    });

    it('PersonaStatusGrid renders active/disabled defaults when personas prop is empty or undefined', () => {
      const { rerender } = render(<PersonaStatusGrid personas={{}} />);
      expect(screen.getByText('Reviewer Personas & Model Ensembles (11 Active)')).toBeInTheDocument();

      rerender(<PersonaStatusGrid personas={undefined} />);
      expect(screen.getByText('Reviewer Personas & Model Ensembles (11 Active)')).toBeInTheDocument();
    });
  });
});
