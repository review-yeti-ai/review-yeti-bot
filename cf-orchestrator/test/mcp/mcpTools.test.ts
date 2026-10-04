import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  queryActiveJobsTool,
  queryFindingsTool,
  getCloudflareStatusTool,
  getBillableRuntimeReportTool,
  getRuntimeMetricsTool,
  getAnalyticsDashboardTool,
  triggerReviewTool,
  cancelReviewTool,
  purgeCacheTool,
} from '../../src/mcp/tools/index.js';

describe('Review Yeti MCP Tools Implementation', () => {
  it('review_yeti_query_active_jobs returns active jobs and formatted markdown table', async () => {
    const mockEnv = {
      REPO_GATE: {
        idFromName: () => 'gate_1',
        get: () => ({
          async fetch() {
            return Response.json({
              activeSlots: 1,
              activeRuns: [{ prNumber: 5290, runId: 'run_cf_bd36035bf508024da7457527fa0fa4f5' }],
              queueDepth: 1,
              queuedPrs: [5295],
            });
          },
        }),
      },
      REVIEW_RUN: {
        idFromName: () => 'run_do_1',
        get: () => ({
          async fetch() {
            return Response.json({
              phase: 'worker_executing',
              fencingEpoch: 2,
              workerId: 'worker_mars_01',
              leaseAgeMs: 12000,
            });
          },
        }),
      },
    };

    const result = await queryActiveJobsTool.execute({ repo: 'example-api' }, { env: mockEnv });
    assert.equal(result.content.length, 2);
    assert.ok(result.content[0].text?.includes('Active Review Jobs'));
    assert.ok(result.content[0].text?.includes('#5290'));
    assert.ok(result.content[0].text?.includes('#5295'));

    const parsed = JSON.parse(result.content[1].text!);
    assert.equal(parsed.activeJobsCount, 2);
    assert.equal(parsed.jobs[0].prNumber, 5290);
    assert.equal(parsed.jobs[0].phase, 'worker_executing');
    assert.equal(parsed.jobs[1].phase, 'queued_in_semaphore');
  });

  it('review_yeti_query_findings filters by severity, rule, and path', async () => {
    // Filter P0 blockers
    const p0Res = await queryFindingsTool.execute({ severity: 'P0' }, {});
    const p0Parsed = JSON.parse(p0Res.content[1].text!);
    assert.ok(p0Parsed.count > 0);
    assert.ok(p0Parsed.findings.every((f: any) => f.severity === 'P0'));
    assert.ok(p0Res.content[0].text?.includes('[P0 Blocker]'));

    // Filter by rule
    const ruleRes = await queryFindingsTool.execute({ rule: 'fencing' }, {});
    const ruleParsed = JSON.parse(ruleRes.content[1].text!);
    assert.ok(ruleParsed.count > 0);
    assert.ok(ruleParsed.findings[0].rule.includes('fencing'));

    // Filter by path
    const pathRes = await queryFindingsTool.execute({ pathPattern: 'wrangler.toml' }, {});
    const pathParsed = JSON.parse(pathRes.content[1].text!);
    assert.ok(pathParsed.count > 0);
    assert.ok(pathParsed.findings[0].path.includes('wrangler.toml'));
  });

  it('review_yeti_get_cloudflare_status returns edge DO concurrency and R2 cache report', async () => {
    const mockEnv = {
      ENVIRONMENT: 'production',
      PARALLEL_MODE: 'true',
      REPO_GATE: {
        idFromName: () => 'gate_1',
        get: () => ({
          async fetch() {
            return Response.json({
              activeSlots: 2,
              activeRuns: [{ prNumber: 5290, runId: 'run_1' }],
              queueDepth: 0,
              queuedPrs: [],
            });
          },
        }),
      },
    };

    const res = await getCloudflareStatusTool.execute({}, { env: mockEnv });
    assert.ok(res.content[0].text?.includes('RepoGate Concurrency'));
    assert.ok(res.content[0].text?.includes('**2 / 5**'));
    assert.ok(res.content[0].text?.includes('1-Hour (3,600s) Aggressive TTL'));
    assert.ok(res.content[0].text?.includes('MATCHING'));

    const parsed = JSON.parse(res.content[1].text!);
    assert.equal(parsed.repoGate.activeSlotsUsed, 2);
    assert.equal(parsed.shadowParity.status, 'MATCHING');
    assert.equal(parsed.shadowParity.dataSource, 'baseline_sample_telemetry');
    assert.equal(parsed.dataSource, 'live_edge_telemetry');
    assert.equal(parsed.computePlane.activeRunner, 'cloudflare');
    assert.equal(parsed.computePlane.defaultRunner, 'cloudflare');
    assert.deepEqual(parsed.computePlane.supportedRunners, ['cloudflare', 'digitalocean']);
    assert.deepEqual(parsed.computePlane.aliases, { digitalocean: ['mars', 'do'] });
  });

  it('review_yeti_get_billable_runtime_report calculates compute costs and savings vs DOKS', async () => {
    const res = await getBillableRuntimeReportTool.execute({ timeframeDays: 30 }, {});
    const parsed = JSON.parse(res.content[1].text!);

    assert.ok(parsed.summary.totalRuns > 0);
    assert.ok(parsed.summary.totalBillableSeconds > 0);
    assert.ok(parsed.summary.totalComputeCostUSD > 0);
    assert.ok(parsed.summary.netSavingsUSD > 0);
    assert.ok(parsed.summary.savingsPercent > 50);

    assert.ok(res.content[0].text?.includes('DigitalOcean Managed Agents'));
    assert.ok(res.content[0].text?.includes('Cost Efficiency vs DOKS Kubernetes Baseline'));
    assert.ok(res.content[0].text?.includes('Net Cloudflare Edge Cost Savings'));
  });

  it('review_yeti_get_billable_runtime_report handles zero matching runs without false savings', async () => {
    const res = await getBillableRuntimeReportTool.execute({ runnerType: 'doks' }, {});
    const parsed = JSON.parse(res.content[1].text!);

    assert.equal(parsed.summary.totalRuns, 0);
    assert.equal(parsed.summary.totalBillableSeconds, 0);
    assert.equal(parsed.summary.totalComputeCostUSD, 0);
    assert.equal(parsed.summary.estimatedDoksBaselineCostUSD, 0);
    assert.equal(parsed.summary.netSavingsUSD, 0);
    assert.equal(parsed.summary.savingsPercent, 0);
  });

  it('review_yeti_get_runtime_metrics computes p50, p75, p90, p95, p99 and scales with windowHours', async () => {
    const res24 = await getRuntimeMetricsTool.execute({ windowHours: 24, comparisonMode: true }, {});
    const parsed24 = JSON.parse(res24.content[1].text!);

    const p24 = parsed24.percentilesWallLatencyMs;
    assert.ok(p24.p50 > 0);
    assert.ok(p24.p75 >= p24.p50);
    assert.ok(p24.p90 >= p24.p75);
    assert.ok(p24.p95 >= p24.p90);
    assert.ok(p24.p99 >= p24.p95);
    assert.ok(p24.max >= p24.p99);

    assert.ok(parsed24.stageBreakdownMs.r2CacheHydration < 1500, 'R2 cache hydration must be sub-1.5s');
    assert.ok(parsed24.comparisonVsDoks.speedupRatio > 1.0, 'Cloudflare must be faster than DOKS baseline');
    assert.ok(res24.content[0].text?.includes('p50 (Median)'));

    // Dynamic window scaling verification
    const res2 = await getRuntimeMetricsTool.execute({ windowHours: 2 }, {});
    const parsed2 = JSON.parse(res2.content[1].text!);
    assert.equal(parsed2.sampleCount, 3);

    const res168 = await getRuntimeMetricsTool.execute({ windowHours: 168 }, {});
    const parsed168 = JSON.parse(res168.content[1].text!);
    assert.equal(parsed168.sampleCount, 19);
    assert.ok(parsed168.sampleCount > parsed24.sampleCount);
    assert.ok(parsed24.sampleCount > parsed2.sampleCount);
  });

  it('review_yeti_get_analytics_dashboard compiles KPIs, hotspots, and rule trends', async () => {
    const res = await getAnalyticsDashboardTool.execute({ repo: 'example-api', timeframe: '7d' }, {});
    const parsed = JSON.parse(res.content[1].text!);

    assert.ok(parsed.kpis.totalReviews > 0);
    assert.ok(parsed.kpis.passRatePercent > 80);
    assert.ok(parsed.topViolatedRules.length > 0);
    assert.ok(parsed.findingHotspots.length > 0);

    assert.ok(res.content[0].text?.includes('Core Key Performance Indicators'));
    assert.ok(res.content[0].text?.includes('Top Rule Violations'));
    assert.ok(res.content[0].text?.includes('Code Hotspots'));
  });

  it('review_yeti_trigger_review validates required params and returns run details', async () => {
    // Missing repo / prNumber error
    const errRes = await triggerReviewTool.execute({ repo: '' }, {});
    assert.equal(errRes.isError, true);

    // Valid trigger without REPO_GATE (fail-closed: slotGranted is false by default)
    const validRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296 }, {});
    assert.ok(!validRes.isError);
    const parsed = JSON.parse(validRes.content[1].text!);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.prNumber, 5296);
    assert.equal(parsed.runner, 'cloudflare'); // Default runner is Cloudflare Containers
    assert.equal(parsed.slotGranted, false);
    assert.ok(parsed.runId.startsWith('run_cf_mcp_'));
    assert.ok(validRes.content[0].text?.includes('Review Yeti Job Dispatched'));
    assert.ok(validRes.content[0].text?.includes('Unallocated'));

    // Env-driven runner selection when args.runner is omitted
    const envDoRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296 }, { env: { RUNNER_TYPE: 'digitalocean' } });
    const envDoParsed = JSON.parse(envDoRes.content[1].text!);
    assert.equal(envDoParsed.ok, true);
    assert.equal(envDoParsed.runner, 'digitalocean');

    // Explicit runner selection: DigitalOcean Managed Agents option
    const doRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296, runner: 'digitalocean' }, {});
    const doParsed = JSON.parse(doRes.content[1].text!);
    assert.equal(doParsed.ok, true);
    assert.equal(doParsed.runner, 'digitalocean');

    // Alias runner selection: 'mars' and 'do' normalize to 'digitalocean'
    const marsRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296, runner: 'mars' }, {});
    const marsParsed = JSON.parse(marsRes.content[1].text!);
    assert.equal(marsParsed.ok, true);
    assert.equal(marsParsed.runner, 'digitalocean');

    const aliasDoRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296, runner: 'do' }, {});
    const aliasDoParsed = JSON.parse(aliasDoRes.content[1].text!);
    assert.equal(aliasDoParsed.ok, true);
    assert.equal(aliasDoParsed.runner, 'digitalocean');

    // Invalid runner value is rejected fail-closed
    const invalidRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296, runner: 'invalid_compute_engine' }, {});
    assert.equal(invalidRes.isError, true);
    assert.ok(invalidRes.content[0].text?.includes('Invalid runner "invalid_compute_engine"'));

    // Valid trigger with REPO_GATE granting slot
    const mockGateEnv = {
      REPO_GATE: {
        idFromName: () => 'gate_1',
        get: () => ({
          async fetch() {
            return Response.json({ granted: true, queuePosition: 0 });
          },
        }),
      },
    };
    const grantedRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296 }, { env: mockGateEnv });
    const grantedParsed = JSON.parse(grantedRes.content[1].text!);
    assert.equal(grantedParsed.slotGranted, true);
    assert.ok(grantedRes.content[0].text?.includes('Slot Granted (Executing Now)'));

    // Trigger when REPO_GATE fails (fail-closed: returns error and does not dispatch)
    const mockFailingGateEnv = {
      REPO_GATE: {
        idFromName: () => 'gate_1',
        get: () => ({
          async fetch() {
            return new Response('Internal Server Error', { status: 500 });
          },
        }),
      },
    };
    const failRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296 }, { env: mockFailingGateEnv });
    assert.equal(failRes.isError, true);
    const failParsed = JSON.parse(failRes.content[1].text!);
    assert.equal(failParsed.ok, false);
    assert.equal(failParsed.slotGranted, false);
    assert.equal(failParsed.dispatched, false);

    // Trigger when REPO_GATE explicitly denies slot (evicted)
    const mockEvictedGateEnv = {
      REPO_GATE: {
        idFromName: () => 'gate_1',
        get: () => ({
          async fetch() {
            return Response.json({ granted: false, evicted: true });
          },
        }),
      },
    };
    const evictedRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296 }, { env: mockEvictedGateEnv });
    assert.equal(evictedRes.isError, true);
    const evictedParsed = JSON.parse(evictedRes.content[1].text!);
    assert.equal(evictedParsed.ok, false);
    assert.equal(evictedParsed.slotGranted, false);
    assert.equal(evictedParsed.evicted, true);

    // Trigger when REVIEW_JOB_WORKFLOW throws (surfaces error and fails closed)
    const mockFailingWorkflowEnv = {
      REVIEW_JOB_WORKFLOW: {
        create: async () => {
          throw new Error('Cloudflare Workflow quota exceeded');
        },
      },
    };
    const wfErrRes = await triggerReviewTool.execute({ repo: 'example-api', prNumber: 5296 }, { env: mockFailingWorkflowEnv });
    assert.equal(wfErrRes.isError, true);
    assert.ok(wfErrRes.content[0].text?.includes('Cloudflare Workflow quota exceeded'));
  });

  it('review_yeti_cancel_review triggers cancellation and evicts queued runs', async () => {
    const mockEnv = {
      REVIEW_RUN: {
        idFromName: () => 'run_1',
        get: () => ({
          async fetch() {
            return Response.json({ cancelled: true, previousPhase: 'Running' });
          },
        }),
      },
      REPO_GATE: {
        idFromName: () => 'gate_1',
        get: () => ({
          async fetch(url: string) {
            if (url.includes('/active-run')) {
              return Response.json({ activeRunId: 'run_active_123' });
            }
            return Response.json({ evicted: true, count: 1, evictedRunIds: ['run_q_1'] });
          },
        }),
      },
    };

    const res = await cancelReviewTool.execute(
      { repo: 'example-api', prNumber: 5290, reason: 'Test abort' },
      { env: mockEnv }
    );

    assert.ok(!res.isError);
    const parsed = JSON.parse(res.content[1].text!);
    assert.equal(parsed.cancelled, true);
    assert.equal(parsed.previousPhase, 'Running');
    assert.equal(parsed.evictedCount, 1, 'Must record evicted queued run count');
    assert.ok(res.content[0].text?.includes('Cancellation Executed'));
  });

  it('review_yeti_purge_cache sweeps expired archives and supports specific PRs', async () => {
    // Dry run / unbound bucket fallback
    const fallbackRes = await purgeCacheTool.execute({}, {});
    assert.ok(fallbackRes.content[0].text?.includes('Cache Purge'));
    const fallbackParsed = JSON.parse(fallbackRes.content[1].text!);
    assert.equal(fallbackParsed.deletedCount, 0);
    assert.equal(fallbackParsed.scannedCount, 0);

    // Specific PR purge with mock bucket
    const deletedKeys: string[] = [];
    const mockBucket = {
      async delete(key: string) {
        deletedKeys.push(key);
      },
    };

    const prRes = await purgeCacheTool.execute(
      { repo: 'example-api', prNumber: 5290 },
      { env: { WORKSPACE_CACHE_BUCKET: mockBucket } }
    );
    assert.ok(prRes.content[0].text?.includes('Specific PR Cache Purged'));
    assert.equal(deletedKeys[0], 'exampleorg/example-api/pr-5290.tar.zst');
  });
});
