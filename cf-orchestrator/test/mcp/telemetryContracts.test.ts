import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../src/types.js';
import type { ReviewFindingItem, ToolResult } from '../../src/mcp/types.js';
import { getAnalyticsDashboardTool } from '../../src/mcp/tools/getAnalyticsDashboard.js';
import { getRuntimeMetricsTool } from '../../src/mcp/tools/getRuntimeMetrics.js';
import { queryFindingsTool } from '../../src/mcp/tools/queryFindings.js';
import { SAMPLE_REPO_CDR } from '../../src/sampleRepositories.js';

const reviewRows = [1000, 4000].map((durationMs, index) => ({
  id: `review-${index}`,
  repo: SAMPLE_REPO_CDR,
  pr_number: 108 + index,
  verdict: index === 0 ? 'SHIP' : 'BLOCK',
  duration_ms: durationMs,
  spend_usd: 0.01,
  total_tokens: 100,
  created_at: 1700000000000,
}));

const findingRows = ['active', 'dismissed'].map((status, index) => ({
  id: `finding-${index}`,
  review_id: 'review-0',
  path: 'src/worker.ts',
  line_number: 10 + index,
  severity: 'P1',
  title: `Finding ${index}`,
  description: `Finding ${index} details`,
  status,
  created_at: 1700000000000,
}));

function boundDb(empty = false) {
  return {
    prepare(query: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            async all() {
              return {
                results: empty ? [] : query.includes('FROM reviews') ? reviewRows : findingRows,
              };
            },
          };
        },
      };
    },
  };
}

function payload(result: ToolResult) {
  assert.equal(result.isError, undefined);
  assert.ok(result.content[1].text);
  return JSON.parse(result.content[1].text);
}

describe('MCP edge telemetry contracts', () => {
  it('declares the optional installation variable as a string binding', () => {
    const env: Pick<Env, 'GITHUB_APP_INSTALLATION_ID'> = { GITHUB_APP_INSTALLATION_ID: '123' };
    assert.equal(env.GITHUB_APP_INSTALLATION_ID, '123');
    const omitted: Pick<Env, 'GITHUB_APP_INSTALLATION_ID'> = {};
    assert.equal(omitted.GITHUB_APP_INSTALLATION_ID, undefined);
  });

  it('declares dispatch status origin as optional deployment configuration', () => {
    const env: Pick<Env, 'DISPATCH_STATUS_BASE_URL'> = {
      DISPATCH_STATUS_BASE_URL: 'https://operator.example.com',
    };
    assert.equal(env.DISPATCH_STATUS_BASE_URL, 'https://operator.example.com');
    const omitted: Pick<Env, 'DISPATCH_STATUS_BASE_URL'> = {};
    assert.equal(omitted.DISPATCH_STATUS_BASE_URL, undefined);
  });

  it('labels bound-D1 analytics with the canonical live source', async () => {
    const result = payload(await getAnalyticsDashboardTool.execute({}, { env: { DB: boundDb() } }));
    assert.equal(result.dataSource, 'live_telemetry');
    assert.equal(result.kpis.totalReviews, 2);
    assert.equal(result.kpis.avgReviewDurationMs, 2500);
    assert.ok(result.recentActivity.every((review: { repo: string }) => review.repo === SAMPLE_REPO_CDR));
  });

  it('labels bound-D1 runtime metrics without changing observed durations', async () => {
    const result = payload(await getRuntimeMetricsTool.execute({}, { env: { DB: boundDb() } }));
    assert.equal(result.dataSource, 'live_telemetry');
    assert.equal(result.sampleCount, 2);
    assert.equal(result.percentilesWallLatencyMs.p50, 2500);
    assert.equal(result.percentilesWallLatencyMs.min, 1000);
    assert.equal(result.percentilesWallLatencyMs.max, 4000);
  });

  it('advertises and preserves dismissed findings as a distinct filterable status', async () => {
    const dismissed: ReviewFindingItem['status'] = 'dismissed';
    assert.ok(queryFindingsTool.definition.inputSchema.properties.status.enum.includes(dismissed));
    const result = payload(await queryFindingsTool.execute({ status: dismissed }, { env: { DB: boundDb() } }));
    assert.equal(result.dataSource, 'live_telemetry');
    assert.equal(result.count, 1);
    assert.equal(result.findings[0].findingId, 'finding-1');
    assert.equal(result.findings[0].status, dismissed);
  });

  it('keeps active D1 findings open without including dismissed records', async () => {
    const result = payload(await queryFindingsTool.execute({ status: 'open' }, { env: { DB: boundDb() } }));
    assert.equal(result.count, 1);
    assert.equal(result.findings[0].findingId, 'finding-0');
    assert.equal(result.findings[0].status, 'open');
  });

  it('keeps empty bound-D1 results empty', async () => {
    const context = { env: { DB: boundDb(true) } };
    const dashboard = payload(await getAnalyticsDashboardTool.execute({}, context));
    const runtime = payload(await getRuntimeMetricsTool.execute({}, context));
    const findings = payload(await queryFindingsTool.execute({}, context));
    assert.equal(dashboard.dataSource, 'live_telemetry');
    assert.equal(dashboard.kpis.totalReviews, 0);
    assert.deepEqual(dashboard.recentActivity, []);
    assert.equal(runtime.dataSource, 'live_telemetry');
    assert.equal(runtime.sampleCount, 0);
    assert.equal(runtime.percentilesWallLatencyMs.p50, 0);
    assert.equal(findings.count, 0);
    assert.deepEqual(findings.findings, []);
  });

  it('keeps no-DB sample labels explicit and repository identities neutral', async () => {
    const dashboard = payload(await getAnalyticsDashboardTool.execute({}, {}));
    const runtime = payload(await getRuntimeMetricsTool.execute({}, {}));
    const findings = payload(await queryFindingsTool.execute({}, {}));
    assert.equal(dashboard.dataSource, 'baseline_sample_telemetry');
    assert.equal(runtime.dataSource, 'baseline_sample_telemetry');
    assert.equal(findings.dataSource, 'baseline_sample_telemetry');
    assert.ok(dashboard.recentActivity.every((review: { repo: string }) => review.repo === SAMPLE_REPO_CDR));
    assert.ok(findings.findings.every((finding: { repo: string }) => finding.repo === SAMPLE_REPO_CDR));
  });
});
