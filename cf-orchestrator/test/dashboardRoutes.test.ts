import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import type { Env } from '../src/types.js';

function createMockEnv(): Env {
  return {
    ENVIRONMENT: 'production',
    PARALLEL_MODE: 'true',
    PILOT_REPOSITORIES: 'all',
  } as unknown as Env;
}

describe('Review Yeti Cloudflare Edge REST API Routes', () => {
  it('OPTIONS /api/dashboard/overview returns CORS headers with 204 status', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/dashboard/overview', {
      method: 'OPTIONS',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('GET'));
  });

  it('GET /api/dashboard/overview returns valid OverviewStats telemetry', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/dashboard/overview', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.overview);
    assert.ok(body.overview.totalReviewsExecuted > 0);
    assert.ok(body.overview.totalTokens);
    assert.ok(body.overview.totalPromptTokens > 0);
    assert.ok(body.overview.totalCompletionTokens > 0);
    assert.equal(typeof body.overview.passRatePercent, 'number');
    assert.equal(typeof body.overview.r2CacheHitRatePercent, 'number');
    assert.ok(Array.isArray(body.overview.providerHealth));
    assert.ok(body.overview.providerHealth.some((p: any) => p.id === 'cloudflare-edge'));
  });

  it('GET /api/overview and GET /api/stats/overview alias correctly to overview telemetry', async () => {
    const env = createMockEnv();
    for (const path of ['/api/overview', '/api/stats/overview']) {
      const req = new Request(`https://worker.dev${path}`, { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(body.overview.totalCostUSD > 0);
    }
  });

  it('GET /api/dashboard/logs returns recent review runs', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/dashboard/logs', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.logs));
    assert.ok(body.logs.length >= 2);
    const first = body.logs[0];
    assert.ok(first.id);
    assert.ok(first.repo);
    assert.ok(typeof first.prNumber === 'number');
    assert.ok(['SHIP', 'NACK', 'COMMENT', 'PENDING'].includes(first.verdict));
    assert.ok(Array.isArray(first.personas));
    assert.ok(first.personas.includes('Review Yeti Swarm'));
  });

  it('GET /api/analytics/summary returns executive KPI metrics', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/analytics/summary?range=7d', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.summary);
    assert.ok(body.summary.totalReviews > 0);
    assert.ok(body.summary.p95DurationMs > 0);
    assert.ok(body.summary.totalSpendUsd > 0);
    assert.ok(body.summary.findingSeverityRatio);
    assert.equal(body.summary.range, '7d');
  });

  it('GET /api/analytics/latency returns percentiles and time buckets', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/analytics/latency?window=24h', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.p50DurationMs > 0);
    assert.ok(body.p95DurationMs > 0);
    assert.ok(Array.isArray(body.timeBuckets));
    assert.ok(body.timeBuckets.length > 0);
  });

  it('GET /api/analytics/costs returns model and repo spend breakdown', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/analytics/costs', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.totalSpendUsd > 0);
    assert.ok(Array.isArray(body.breakdown));
    assert.ok(body.breakdown.some((m: any) => m.displayName.includes('Review Yeti PR Reviewer')));
    assert.equal(body.breakdown[0].percentage, 100);
    assert.equal(body.breakdown[0].model, 'calltelemetry/yeti-pr-reviewer');
    assert.ok(Array.isArray(body.byRepo));
  });

  it('GET /api/analytics/tokens returns token burn points', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/analytics/tokens', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.totalTokens > 0);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
  });

  it('GET /api/analytics/findings returns quality and severity distribution', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/analytics/findings', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.totalFindings > 0);
    assert.ok(body.severityCounts.P0 >= 0);
    assert.ok(body.categoryDistribution);
  });

  it('GET /api/dashboard/repositories and GET /api/github/repos return monitored repos', async () => {
    const env = createMockEnv();
    for (const path of ['/api/dashboard/repositories', '/api/github/repos']) {
      const req = new Request(`https://worker.dev${path}`, { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.repositories));
      assert.ok(body.repositories.some((r: any) => r.repo === 'cisco-cdr'));
    }
  });

  it('GET /api/status and GET /api/cloudflare/status return Cloudflare control plane status', async () => {
    const env = createMockEnv();
    for (const path of ['/api/status', '/api/cloudflare/status']) {
      const req = new Request(`https://worker.dev${path}`, { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(body.status);
    }
  });

  it('GET /version and GET /api/dashboard/about return Review Yeti metadata', async () => {
    const env = createMockEnv();
    for (const path of ['/version', '/api/dashboard/about']) {
      const req = new Request(`https://worker.dev${path}`, { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.about.name, 'Review Yeti');
      assert.equal(body.about.version, 'v2.4.0');
    }
  });
});
