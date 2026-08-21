import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import { initMetrics, getMetrics, getPrometheusMetrics } from '../../src/telemetry/metrics';

describe('Empirical Verification: R1 (Live Queue & OTEL Streaming) & R2 (Trailing 24h Review KPI)', () => {
  const tmpDbPath = path.join(process.cwd(), 'fixtures/tmp/test_m4_empirical_r1_r2.json');
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

  describe('Requirement R1: Live Queue Metrics, Concurrency Limits & OTEL Streaming', () => {
    it('verifies maxConcurrentJobs defaults to 3 and responds to environment variable override', () => {
      delete process.env.MAX_CONCURRENT_REVIEW_JOBS;
      expect(bus.getQueueMetrics().maxConcurrentJobs).toBe(3);

      process.env.MAX_CONCURRENT_REVIEW_JOBS = '5';
      expect(bus.getQueueMetrics().maxConcurrentJobs).toBe(5);

      process.env.MAX_CONCURRENT_REVIEW_JOBS = 'invalid_number';
      expect(bus.getQueueMetrics().maxConcurrentJobs).toBe(3);
    });

    it('verifies activeJobsCount and queuedJobsCount transitions across job lifecycle', () => {
      expect(bus.getQueueMetrics().activeJobsCount).toBe(0);
      expect(bus.getQueueMetrics().queuedJobsCount).toBe(0);

      // 1. Publish job:queued event
      bus.publishEvent({
        jobId: 'job_org_repo_pr101',
        timestamp: new Date().toISOString(),
        type: 'job:queued',
        persona: 'all',
        data: { repo: 'org/repo', prNumber: 101, status: 'queued' }
      });

      let metrics = bus.getQueueMetrics();
      expect(metrics.queuedJobsCount).toBe(1);
      expect(metrics.activeJobsCount).toBe(0);

      // 2. Publish job:dispatched event
      bus.publishEvent({
        jobId: 'job_org_repo_pr101',
        timestamp: new Date().toISOString(),
        type: 'job:dispatched',
        persona: 'all',
        data: { repo: 'org/repo', prNumber: 101, status: 'dispatched' }
      });

      metrics = bus.getQueueMetrics();
      expect(metrics.queuedJobsCount).toBe(0);
      expect(metrics.activeJobsCount).toBe(1);

      // 3. Transition to active persona execution
      bus.publishEvent({
        jobId: 'job_org_repo_pr101',
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { personaId: 'security' }
      });

      metrics = bus.getQueueMetrics();
      expect(metrics.queuedJobsCount).toBe(0);
      expect(metrics.activeJobsCount).toBe(1);

      // 4. Complete job
      bus.publishEvent({
        jobId: 'job_org_repo_pr101',
        timestamp: new Date().toISOString(),
        type: 'job:complete',
        persona: 'all',
        data: { status: 'completed' }
      });

      metrics = bus.getQueueMetrics();
      expect(metrics.queuedJobsCount).toBe(0);
      expect(metrics.activeJobsCount).toBe(0);
    });

    it('verifies job:queued and job:dispatched event emissions and event listeners', () => {
      const receivedEvents: any[] = [];
      const listener = (evt: any) => receivedEvents.push(evt);
      bus.on('event', listener);

      bus.publishEvent({
        jobId: 'job_test_1',
        timestamp: new Date().toISOString(),
        type: 'job:queued',
        persona: 'all',
        data: { repo: 'test/repo', prNumber: 1, status: 'queued' }
      });

      bus.publishEvent({
        jobId: 'job_test_1',
        timestamp: new Date().toISOString(),
        type: 'job:dispatched',
        persona: 'all',
        data: { repo: 'test/repo', prNumber: 1, status: 'dispatched' }
      });

      bus.off('event', listener);

      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].type).toBe('job:queued');
      expect(receivedEvents[1].type).toBe('job:dispatched');
    });

    it('verifies OTEL counter tracking for jobsQueued, jobsDispatched, activeJobs, queuedJobs, and LLM tokens in Prometheus export', async () => {
      const metrics = getMetrics();
      
      metrics.jobsQueued.add(1, { repository: 'cisco/cdr' });
      metrics.queuedJobs.add(1, { repository: 'cisco/cdr' });

      metrics.jobsDispatched.add(1, { repository: 'cisco/cdr' });
      metrics.queuedJobs.add(-1, { repository: 'cisco/cdr' });
      metrics.activeJobs.add(1, { repository: 'cisco/cdr' });

      metrics.tokensPrompt.add(1500, { provider: 'openai', model: 'gpt-4o' });
      metrics.tokensCompletion.add(500, { provider: 'openai', model: 'gpt-4o' });
      metrics.tokensTotal.add(2000, { provider: 'openai', model: 'gpt-4o' });
      metrics.modelCostUsd.add(0.045, { provider: 'openai', model: 'gpt-4o' });

      const prometheusOutput = await getPrometheusMetrics();

      expect(prometheusOutput).toContain('ct_queue_jobs_queued_total');
      expect(prometheusOutput).toContain('ct_queue_jobs_dispatched_total');
      expect(prometheusOutput).toContain('ct_queue_active_jobs');
      expect(prometheusOutput).toContain('ct_queue_queued_jobs');
      expect(prometheusOutput).toContain('ct_review_tokens_prompt_total');
      expect(prometheusOutput).toContain('ct_review_tokens_completion_total');
      expect(prometheusOutput).toContain('ct_review_tokens_total');
      expect(prometheusOutput).toContain('ct_review_model_cost_usd_total');
    });
  });

  describe('Requirement R2: Trailing 24-Hour Review KPI Summary', () => {
    it('returns 0 for all trailing 24h KPI metrics when 0 logs exist in store', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const overview = store.getOverviewStats();

      expect(overview.trailing24hReviewsExecuted).toBe(0);
      expect(overview.trailing24hAvgTokensPerPR).toBe(0);
      expect(overview.trailing24hAvgCostPerPR).toBe(0);
    });

    it('excludes review logs older than 24 hours from KPI calculation', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const now = Date.now();
      const oldTime1 = new Date(now - 25 * 3600 * 1000).toISOString(); // 25h ago
      const oldTime2 = new Date(now - 72 * 3600 * 1000).toISOString(); // 72h ago

      store.recordReviewRun({
        id: 'old_run_1',
        timestamp: oldTime1,
        tokens: { prompt: 10000, completion: 5000, total: 15000 },
        costUSD: 1.50,
      });

      store.recordReviewRun({
        id: 'old_run_2',
        timestamp: oldTime2,
        tokens: { prompt: 20000, completion: 10000, total: 30000 },
        costUSD: 3.00,
      });

      const overview = store.getOverviewStats();

      expect(overview.trailing24hReviewsExecuted).toBe(0);
      expect(overview.trailing24hAvgTokensPerPR).toBe(0);
      expect(overview.trailing24hAvgCostPerPR).toBe(0);
    });

    it('accurately computes Avg Tokens per PR, Avg Cost per PR, and Total Reviews Executed for logs inside 24h window', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const now = Date.now();
      const recent1 = new Date(now - 1 * 3600 * 1000).toISOString(); // 1h ago
      const recent2 = new Date(now - 12 * 3600 * 1000).toISOString(); // 12h ago
      const recent3 = new Date(now - 23 * 3600 * 1000).toISOString(); // 23h ago
      const expired = new Date(now - 25 * 3600 * 1000).toISOString(); // 25h ago

      // Run 1: 1000 prompt + 500 completion = 1500 total, cost = $0.05
      store.recordReviewRun({
        id: 'rec_1',
        timestamp: recent1,
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        costUSD: 0.05,
      });

      // Run 2: 2000 prompt + 1000 completion = 3000 total, cost = $0.10
      store.recordReviewRun({
        id: 'rec_2',
        timestamp: recent2,
        tokens: { prompt: 2000, completion: 1000, total: 3000 },
        costUSD: 0.10,
      });

      // Run 3: 3000 prompt + 1500 completion = 4500 total, cost = $0.15
      store.recordReviewRun({
        id: 'rec_3',
        timestamp: recent3,
        tokens: { prompt: 3000, completion: 1500, total: 4500 },
        costUSD: 0.15,
      });

      // Expired Run (should be ignored)
      store.recordReviewRun({
        id: 'exp_1',
        timestamp: expired,
        tokens: { prompt: 50000, completion: 50000, total: 100000 },
        costUSD: 10.00,
      });

      const overview = store.getOverviewStats();

      // Total inside 24h: 3 reviews
      expect(overview.trailing24hReviewsExecuted).toBe(3);

      // Total tokens = 1500 + 3000 + 4500 = 9000
      // Avg Tokens per PR = Math.round(9000 / 3) = 3000
      expect(overview.trailing24hAvgTokensPerPR).toBe(3000);

      // Total cost = 0.05 + 0.10 + 0.15 = 0.30
      // Avg Cost per PR = parseFloat((0.30 / 3).toFixed(4)) = 0.1
      expect(overview.trailing24hAvgCostPerPR).toBe(0.1);
    });

    it('safely handles logs with missing/malformed timestamp, missing cost/token fields without crashing', () => {
      const store = new DashboardStore(tmpDbPath);
      (store as any).data.reviewLogs = [];
      (store as any).invalidateCache();

      const now = Date.now();
      const recent = new Date(now - 1 * 3600 * 1000).toISOString();

      store.recordReviewRun({
        id: 'log_malformed_time',
        timestamp: 'invalid-date-string',
        tokens: { prompt: 100, completion: 100, total: 200 },
        costUSD: 0.50,
      });

      store.recordReviewRun({
        id: 'log_missing_tokens',
        timestamp: recent,
        costUSD: 0.02,
      });

      store.recordReviewRun({
        id: 'log_second_recent',
        timestamp: recent,
        tokens: 500,
        costUSD: 0.04,
      });

      const overview = store.getOverviewStats();

      // Only logs with valid timestamp inside 24h should be counted (2 logs)
      expect(overview.trailing24hReviewsExecuted).toBe(2);
      // Total tokens = 0 + 500 = 500, avg = Math.round(500 / 2) = 250
      expect(overview.trailing24hAvgTokensPerPR).toBe(250);
      // Total cost = 0.02 + 0.04 = 0.06, avg = parseFloat((0.06 / 2).toFixed(4)) = 0.03
      expect(overview.trailing24hAvgCostPerPR).toBe(0.03);
    });
  });
});
