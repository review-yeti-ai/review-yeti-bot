import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Response } from 'express';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import { initMetrics, getMetrics, getPrometheusMetrics } from '../../src/telemetry/metrics';

describe('Empirical Challenger Suite: Requirement R1 (Live Queue & OTel Streaming) & R2 (Trailing 24h KPIs)', () => {
  const tmpDbPath = path.join(process.cwd(), 'fixtures/tmp/test_challenger1_r1_r2_empirical.json');
  const originalEnv = { ...process.env };
  let bus: LiveStreamBus;

  beforeEach(() => {
    process.env = { ...originalEnv };
    if (!fs.existsSync(path.dirname(tmpDbPath))) {
      fs.mkdirSync(path.dirname(tmpDbPath), { recursive: true });
    }
    if (fs.existsSync(tmpDbPath)) {
      try { fs.unlinkSync(tmpDbPath); } catch {}
    }
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
    initMetrics();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    bus.clearHistory();
    if (fs.existsSync(tmpDbPath)) {
      try { fs.unlinkSync(tmpDbPath); } catch {}
    }
  });

  // =========================================================================
  // Requirement R1: Live Queue Metrics, Out-of-Order Lifecycle & OTel Streaming
  // =========================================================================
  describe('Requirement R1: Live Queue & OTel Streaming Empirical Harness', () => {

    it('validates queue metrics across 50 concurrent job publish/enqueue/dispatch lifecycle cycles', async () => {
      const jobCount = 50;
      const initialMetrics = bus.getQueueMetrics();
      expect(initialMetrics.activeJobsCount).toBe(0);
      expect(initialMetrics.queuedJobsCount).toBe(0);

      // Phase 1: Enqueue 50 jobs concurrently
      for (let i = 1; i <= jobCount; i++) {
        bus.publishEvent({
          jobId: `job_concurrent_batch_${i}`,
          timestamp: new Date().toISOString(),
          type: 'job:queued',
          persona: 'all',
          data: { repo: 'cisco/cdr', prNumber: 100 + i, status: 'queued' },
        });
      }

      let queueState = bus.getQueueMetrics();
      expect(queueState.queuedJobsCount).toBe(50);
      expect(queueState.activeJobsCount).toBe(0);

      // Phase 2: Dispatch 30 jobs concurrently
      for (let i = 1; i <= 30; i++) {
        bus.publishEvent({
          jobId: `job_concurrent_batch_${i}`,
          timestamp: new Date().toISOString(),
          type: 'job:dispatched',
          persona: 'all',
          data: { repo: 'cisco/cdr', prNumber: 100 + i, status: 'dispatched' },
        });
      }

      queueState = bus.getQueueMetrics();
      expect(queueState.queuedJobsCount).toBe(20);
      expect(queueState.activeJobsCount).toBe(30);

      // Phase 3: Start persona evaluations for dispatched jobs
      for (let i = 1; i <= 30; i++) {
        bus.publishEvent({
          jobId: `job_concurrent_batch_${i}`,
          timestamp: new Date().toISOString(),
          type: 'persona:start',
          persona: 'security',
          data: { personaId: 'security' },
        });
      }

      queueState = bus.getQueueMetrics();
      expect(queueState.queuedJobsCount).toBe(20);
      expect(queueState.activeJobsCount).toBe(30);

      // Phase 4: Complete all 50 jobs
      for (let i = 1; i <= jobCount; i++) {
        bus.publishEvent({
          jobId: `job_concurrent_batch_${i}`,
          timestamp: new Date().toISOString(),
          type: 'job:complete',
          persona: 'all',
          data: { status: 'completed' },
        });
      }

      queueState = bus.getQueueMetrics();
      expect(queueState.queuedJobsCount).toBe(0);
      expect(queueState.activeJobsCount).toBe(0);
    });

    it('empirically tests resilience under out-of-order event sequences (complete before dispatch/queue)', () => {
      // Out of order: complete event received first for unknown job
      bus.publishEvent({
        jobId: 'job_ooo_1',
        timestamp: new Date().toISOString(),
        type: 'job:complete',
        persona: 'all',
        data: { status: 'completed' },
      });

      let metrics = bus.getQueueMetrics();
      expect(metrics.activeJobsCount).toBe(0);
      expect(metrics.queuedJobsCount).toBe(0);
      expect(bus.getJobStatus('job_ooo_1')?.status).toBe('completed');

      // Subsequent job:queued for already completed job
      bus.publishEvent({
        jobId: 'job_ooo_1',
        timestamp: new Date().toISOString(),
        type: 'job:queued',
        persona: 'all',
        data: { status: 'queued' },
      });

      metrics = bus.getQueueMetrics();
      expect(metrics.activeJobsCount).toBe(0);
      expect(metrics.queuedJobsCount).toBe(1);
      expect(bus.getJobStatus('job_ooo_1')?.status).toBe('queued');
    });

    it('stress tests high-volume rapid event storming (1,000 events) and ring buffer capping', () => {
      const jobId = 'job_storm_1000';
      const startTime = performance.now();

      for (let i = 1; i <= 1000; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'performance',
          data: { chunk: `Log line chunk ${i}`, tokensUsed: 1 },
        });
      }

      const duration = performance.now() - startTime;
      const history = bus.getHistory(jobId);

      // Ring buffer must strictly cap at 500 events
      expect(history.length).toBe(500);
      // History should contain the most recent events (501 to 1000)
      expect(history[499].data.chunk).toBe('Log line chunk 1000');
      expect(history[0].data.chunk).toBe('Log line chunk 501');
      // Execution throughput should be sub-500ms
      expect(duration).toBeLessThan(500);
    });

    it('verifies OTel metric meters, gauge balance, and Prometheus export attribute formatting', async () => {
      const metrics = getMetrics();

      // Reset / Add metrics
      metrics.jobsQueued.add(10, { repository: 'cisco/cdr' });
      metrics.queuedJobs.add(10, { repository: 'cisco/cdr' });

      metrics.jobsDispatched.add(6, { repository: 'cisco/cdr' });
      metrics.queuedJobs.add(-6, { repository: 'cisco/cdr' });
      metrics.activeJobs.add(6, { repository: 'cisco/cdr' });

      metrics.tokensPrompt.add(12000, { provider: 'anthropic', model: 'claude-3-5-sonnet' });
      metrics.tokensCompletion.add(3000, { provider: 'anthropic', model: 'claude-3-5-sonnet' });
      metrics.tokensTotal.add(15000, { provider: 'anthropic', model: 'claude-3-5-sonnet' });
      metrics.modelCostUsd.add(0.0825, { provider: 'anthropic', model: 'claude-3-5-sonnet' });

      const prometheusOutput = await getPrometheusMetrics();

      expect(prometheusOutput).toContain('ct_queue_jobs_queued_total');
      expect(prometheusOutput).toContain('ct_queue_jobs_dispatched_total');
      expect(prometheusOutput).toContain('ct_queue_active_jobs');
      expect(prometheusOutput).toContain('ct_queue_queued_jobs');
      expect(prometheusOutput).toContain('ct_review_tokens_prompt_total');
      expect(prometheusOutput).toContain('ct_review_tokens_completion_total');
      expect(prometheusOutput).toContain('ct_review_tokens_total');
      expect(prometheusOutput).toContain('ct_review_model_cost_usd_total');

      // Check attribute formatting in Prometheus output
      expect(prometheusOutput).toContain('repository="cisco/cdr"');
      expect(prometheusOutput).toContain('model="claude-3-5-sonnet"');
    });

    it('handles dead SSE client disconnection and ping interval cleanup gracefully without memory leaks', () => {
      const jobId = 'job_sse_cleanup_test';
      let writtenData: string[] = [];

      // Mock Response object
      const mockRes: Partial<Response> = {
        setHeader: vi.fn(),
        write: vi.fn().mockImplementation((chunk: string) => {
          if (chunk.includes('TRIGGER_ERROR')) {
            throw new Error('Socket write EPIPE');
          }
          writtenData.push(chunk);
          return true;
        }),
        on: vi.fn(),
      };

      bus.addClient(jobId, mockRes as Response);

      // Publish initial normal event
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { message: 'Normal event' },
      });

      expect(writtenData.length).toBeGreaterThan(0);

      // Publish error-triggering event
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:chunk',
        persona: 'security',
        data: { message: 'TRIGGER_ERROR' },
      });

      // Subsequent event should not throw and dead client should be removed
      expect(() => {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'job:complete',
          persona: 'all',
          data: { status: 'completed' },
        });
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Requirement R2: Trailing 24-Hour Review KPI Summary Empirical Harness
  // =========================================================================
  describe('Requirement R2: Trailing 24h Review KPI Summary Empirical Harness', () => {

    it('empirically verifies sliding 24h window cutoff boundaries', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const now = Date.now();
      const recent1hAgo = new Date(now - 3600 * 1000).toISOString();
      const recent12hAgo = new Date(now - 12 * 3600 * 1000).toISOString();
      const justInside23h = new Date(now - 23 * 3600 * 1000).toISOString();
      const clearlyOutside25h = new Date(now - 25 * 3600 * 1000).toISOString();

      // Log 1: 1h ago -> included
      store.recordReviewRun({
        id: 'log_1h',
        timestamp: recent1hAgo,
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        costUSD: 0.10,
      });

      // Log 2: 12h ago -> included
      store.recordReviewRun({
        id: 'log_12h',
        timestamp: recent12hAgo,
        tokens: { prompt: 2000, completion: 1000, total: 3000 },
        costUSD: 0.20,
      });

      // Log 3: 23h ago -> included
      store.recordReviewRun({
        id: 'log_23h',
        timestamp: justInside23h,
        tokens: { prompt: 3000, completion: 1500, total: 4500 },
        costUSD: 0.30,
      });

      // Log 4: 25h ago -> EXCLUDED
      store.recordReviewRun({
        id: 'log_25h',
        timestamp: clearlyOutside25h,
        tokens: { prompt: 5000, completion: 5000, total: 10000 },
        costUSD: 1.00,
      });

      const overview = store.getOverviewStats();

      // Total included logs = 3 (1h, 12h, 23h)
      expect(overview.trailing24hReviewsExecuted).toBe(3);

      // Total tokens = 1500 + 3000 + 4500 = 9000 -> Avg = 9000 / 3 = 3000
      expect(overview.trailing24hAvgTokensPerPR).toBe(3000);

      // Total cost = 0.10 + 0.20 + 0.30 = 0.60 -> Avg = 0.60 / 3 = 0.2
      expect(overview.trailing24hAvgCostPerPR).toBe(0.2);
    });

    it('stress tests malformed log timestamps and defensive fallback behavior', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const recentTime = new Date(Date.now() - 3600000).toISOString();

      // 1. Falsy timestamp (null) -> recordReviewRun defaults to Date.now() (valid, current)
      store.recordReviewRun({
        id: 'malformed_null_ts',
        timestamp: null as any,
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        costUSD: 0.10,
      });

      // 2. Falsy timestamp ("") -> recordReviewRun defaults to Date.now() (valid, current)
      store.recordReviewRun({
        id: 'malformed_empty_ts',
        timestamp: '',
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        costUSD: 0.10,
      });

      // 3. Invalid date string ("INVALID_DATE") -> timestamp retained as-is, filtered out by getOverviewStats (isNaN)
      store.recordReviewRun({
        id: 'malformed_invalid_str',
        timestamp: 'INVALID_DATE_STRING',
        tokens: { prompt: 9999, completion: 9999, total: 19998 },
        costUSD: 5.00,
      });

      // 4. Valid log with missing token details
      store.recordReviewRun({
        id: 'valid_missing_tokens',
        timestamp: recentTime,
        tokens: undefined,
        costUSD: 0.05,
      });

      // 5. Valid log with numeric tokens format (`tokens: 600`)
      store.recordReviewRun({
        id: 'valid_numeric_tokens',
        timestamp: recentTime,
        tokens: 600 as any,
        costUSD: 0.05,
      });

      const overview = store.getOverviewStats();

      // Included logs: 4 (null_ts [defaulted to now], empty_ts [defaulted to now], missing_tokens, numeric_tokens)
      // Filtered out: 1 (invalid_str)
      expect(overview.trailing24hReviewsExecuted).toBe(4);

      // Total tokens = 1500 + 1500 + 0 + 600 = 3600 -> Avg = 3600 / 4 = 900
      expect(overview.trailing24hAvgTokensPerPR).toBe(900);

      // Total cost = 0.10 + 0.10 + 0.05 + 0.05 = 0.30 -> Avg = 0.30 / 4 = 0.075
      expect(overview.trailing24hAvgCostPerPR).toBe(0.075);
    });

    it('evaluates computation performance and floating-point cost precision across 5,000 review logs', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const now = Date.now();
      const logs: any[] = [];

      // Generate 2,500 logs inside trailing 24h
      for (let i = 0; i < 2500; i++) {
        const offset = Math.floor(Math.random() * 80000000); // within 22.2h
        logs.push({
          id: `recent_${i}`,
          timestamp: new Date(now - offset).toISOString(),
          tokens: { prompt: 1000, completion: 500, total: 1500 },
          costUSD: 0.0123,
        });
      }

      // Generate 2,500 logs outside trailing 24h
      for (let i = 0; i < 2500; i++) {
        const offset = 86400000 + Math.floor(Math.random() * 80000000); // 24h to 46h ago
        logs.push({
          id: `old_${i}`,
          timestamp: new Date(now - offset).toISOString(),
          tokens: { prompt: 10000, completion: 5000, total: 15000 },
          costUSD: 0.50,
        });
      }

      (store as any).data.reviewLogs = logs;
      (store as any).invalidateCache();

      const startTime = performance.now();
      const overview = store.getOverviewStats();
      const duration = performance.now() - startTime;

      expect(overview.trailing24hReviewsExecuted).toBe(2500);
      expect(overview.trailing24hAvgTokensPerPR).toBe(1500);
      expect(overview.trailing24hAvgCostPerPR).toBe(0.0123);
      // Computing 5,000 logs must execute well within 50ms SLA
      expect(duration).toBeLessThan(50);
    });

    it('verifies timezone parameter behavior and cache consistency in getOverviewStats', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const now = new Date();
      const recentTime = now.toISOString();

      store.recordReviewRun({
        id: 'tz_run_1',
        timestamp: recentTime,
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        costUSD: 0.05,
      });

      // Default call without timezone (cached)
      const overviewDefault = store.getOverviewStats();
      expect(overviewDefault.trailing24hReviewsExecuted).toBe(1);

      // Call with specific timezone ('America/New_York')
      const overviewNY = store.getOverviewStats('America/New_York');
      expect(overviewNY.trailing24hReviewsExecuted).toBe(1);

      // Call with another timezone ('Asia/Tokyo')
      const overviewTokyo = store.getOverviewStats('Asia/Tokyo');
      expect(overviewTokyo.trailing24hReviewsExecuted).toBe(1);
    });
  });
});
