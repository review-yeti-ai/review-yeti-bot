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
    assert.equal(body.breakdown[0].model, 'reviewyeti-ai/yeti-pr-reviewer');
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
      assert.ok(body.repositories.some((r: any) => r.repo === 'example-api'));
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

  it('GET /api/live/active returns active review jobs with persona progress', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/live/active', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.jobs));
    assert.ok(body.jobs.length > 0);
    assert.ok(body.jobs[0].jobId);
    assert.ok(body.jobs[0].repo.startsWith('reviewyeti-ai/'));
    assert.ok(body.jobs[0].personaProgress);
  });

  it('GET /api/live/diff returns structured diff hunks and findings', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/live/diff?jobId=run_live_reviewyeti_pr1282', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.files));
    assert.ok(body.files.length > 0);
    assert.ok(Array.isArray(body.findings));
  });

  it('GET /api/live/stream returns SSE text/event-stream headers and readable body', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/live/stream?jobId=run_live_reviewyeti_pr1282', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('text/event-stream'));
    assert.ok(res.body !== null);
  });

  it('POST /api/dashboard/hitl/prompt-guidance registers Human-In-The-Loop guidance', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/dashboard/hitl/prompt-guidance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: 'run_live_reviewyeti_pr1282',
        guidance: 'Enforce tight bounds on context compaction ratio.',
        targetPersonas: ['architecture'],
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.guidance.id);
  });

  it('GET /api/github/repos/:owner/:repo/pulls returns active pull requests for repository', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/github/repos/reviewyeti-ai/review-yeti-bot/pulls', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.pulls));
    assert.ok(body.pulls.length > 0);
    assert.ok(body.pulls[0].number);
    assert.ok(body.pulls[0].title);
  });

  it('POST /api/live/publish accepts live streaming events cleanly', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/live/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: 'run_live_reviewyeti_pr1282',
        event: {
          type: 'task:progress',
          progress: 90,
          taskId: 'task_sec_boundary',
        },
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
  });

  it('POST /api/dashboard/repositories updates repository automation configuration', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/dashboard/repositories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: 'reviewyeti-ai',
        repo: 'review-yeti-bot',
        automationEnabled: true,
        customProfile: 'assertive',
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.repository);
  });

  it('POST /api/live/trigger triggers live streaming review and returns 6-stage stream URL', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/live/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: 'run_live_test_trigger_1',
        repo: 'reviewyeti-ai/yeti-pr-reviewer',
        prNumber: 1282,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.jobId, 'run_live_test_trigger_1');
    assert.equal(body.stagesCount, 6);
    assert.ok(body.streamUrl.includes('run_live_test_trigger_1'));
  });

  it('POST /api/dashboard/trigger-review aliases correctly to live review trigger', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/dashboard/trigger-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: 'run_live_test_trigger_2',
        repo: 'reviewyeti-ai/yeti-pr-reviewer',
        prNumber: 1282,
      }),
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.stagesCount, 6);
  });

  it('GET /api/live/stream initializes SSE event stream with text/event-stream headers', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/live/stream?jobId=run_live_test_stream_1', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('text/event-stream'));
    assert.equal(res.headers.get('Cache-Control'), 'no-cache, no-transform');
  });

  it('GET /api/memory/stats returns full enterprise knowledge graph & compaction state', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/memory/stats', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.r2);
    assert.equal(body.r2.bucket, 'review-yeti-workspace-cache');
    assert.ok(body.workspaces.length >= 3);
    assert.ok(body.learnings.length >= 5);
    assert.ok(body.suppressedNits.length >= 3);
    assert.ok(body.adrConstraints.length >= 2);
    assert.equal(body.compaction.ratio, '4.2x');
    assert.ok(body.analytics.timeline.length > 0);
  });

  it('GET /api/memory/query filters learnings and workspaces by keyword and category', async () => {
    const env = createMockEnv();
    // 1. Query by security keyword
    const req = new Request('https://worker.dev/api/memory/query?q=hmac&category=security', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.learnings.some((l: any) => l.title.includes('HMAC')));

    // 2. Query by repo filter
    const repoReq = new Request('https://worker.dev/api/memory/query?repo=example-api', { method: 'GET' });
    const repoRes = await worker.fetch(repoReq, env);
    assert.equal(repoRes.status, 200);
    const repoBody = (await repoRes.json()) as any;
    assert.equal(repoBody.success, true);
    assert.ok(repoBody.learnings.every((l: any) => l.repo.includes('example-api')));
  });

  it('GET /api/memory/export delivers cryptographic JSON and Markdown documents with SHA-256 digest', async () => {
    const env = createMockEnv();

    // 1. JSON Export
    const jsonReq = new Request('https://worker.dev/api/memory/export?format=json', { method: 'GET' });
    const jsonRes = await worker.fetch(jsonReq, env);
    assert.equal(jsonRes.status, 200);
    assert.ok(jsonRes.headers.get('Content-Type')?.includes('application/json'));
    assert.ok(jsonRes.headers.get('X-Memory-Digest'));
    const jsonBody = (await jsonRes.json()) as any;
    assert.equal(jsonBody.version, '2.1.0');
    assert.ok(jsonBody.sha256Digest);
    assert.ok(jsonBody.workspaces.length > 0);

    // 2. Markdown Export
    const mdReq = new Request('https://worker.dev/api/memory/export?format=markdown', { method: 'GET' });
    const mdRes = await worker.fetch(mdReq, env);
    assert.equal(mdRes.status, 200);
    assert.ok(mdRes.headers.get('Content-Type')?.includes('text/markdown'));
    assert.ok(mdRes.headers.get('X-Memory-Digest'));
    const mdText = await mdRes.text();
    assert.ok(mdText.includes('# Review Yeti Codebase Knowledge Graph'));
    assert.ok(mdText.includes('Active Workspace Caches'));
    assert.ok(mdText.includes('Reviewer Learnings & Policy Ledger'));
  });

  it('POST /api/memory/purge executes cache sweep and reports deleted count', async () => {
    const env = createMockEnv();
    const req = new Request('https://worker.dev/api/memory/purge', { method: 'POST' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.ok(body.message.includes('Workspace cache purged'));
  });
});
