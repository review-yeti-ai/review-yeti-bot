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
      assert.ok(body.repositories.some((r: any) => r.repo === 'sample-cdr'));
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
    const repoReq = new Request('https://worker.dev/api/memory/query?repo=sample-cdr', { method: 'GET' });
    const repoRes = await worker.fetch(repoReq, env);
    assert.equal(repoRes.status, 200);
    const repoBody = (await repoRes.json()) as any;
    assert.equal(repoBody.success, true);
    assert.ok(repoBody.learnings.every((l: any) => l.repo.includes('sample-cdr')));
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

describe('Neutral dashboard API state and boundary controls', () => {
  it('keeps sample repository identities consistent across overview, memory and filtered exports', async () => {
    const env = createMockEnv();
    const overview = await worker.fetch(new Request('https://worker.dev/api/overview'), env);
    const data = await overview.json() as any;
    assert.ok(Object.hasOwn(data.overview.liveDurableObjects, 'example/sample-cdr'));
    assert.ok(Object.hasOwn(data.overview.liveDurableObjects, 'example/sample-meta'));
    const exported = await worker.fetch(new Request('https://worker.dev/api/memory/export?repo=sample-cdr'), env);
    const snapshot = await exported.json() as any;
    assert.equal(snapshot.organization, 'example');
    assert.ok(snapshot.workspaces.length > 0);
    assert.equal(snapshot.scope, 'sample-cdr');
    assert.ok(snapshot.workspaces.some((w: any) => w.repository === 'example/sample-cdr'));
    assert.ok(snapshot.workspaces.some((w: any) => w.repository === 'example/sample-meta'));
    // The existing server export labels the requested scope while retaining the full ledger.
    assert.equal(snapshot.sha256Digest.length, 64);
  });

  it('filters distinct memory entity classes and rejects unmatched repository/search combinations', async () => {
    const env = createMockEnv();
    for (const [category, key] of [['security', 'learnings'], ['nit', 'suppressedNits'], ['adr', 'adrConstraints']]) {
      const res = await worker.fetch(new Request(`https://worker.dev/api/memory/query?category=${category}`), env);
      const body = await res.json() as any;
      assert.equal(res.status, 200);
      assert.ok(body[key].length > 0);
    }
    const res = await worker.fetch(new Request('https://worker.dev/api/memory/query?repo=sample-meta&q=missing-symbol&category=performance'), env);
    const body = await res.json() as any;
    assert.deepEqual(body.learnings, []);
    assert.deepEqual(body.suppressedNits, []);
    assert.deepEqual(body.adrConstraints, []);
    assert.deepEqual(body.workspaces, []);
    const all = await worker.fetch(new Request('https://worker.dev/api/memory/query?repo=all&q=hmac'), env);
    const matches = await all.json() as any;
    assert.ok(matches.learnings.length > 0);
    assert.ok(matches.learnings.every((l: any) => JSON.stringify(l).toLowerCase().includes('hmac')));
  });

  it('reports bound R2 metrics and preserves a cache purge when the bucket is present', async () => {
    const env = { ...createMockEnv(), WORKSPACE_CACHE_BUCKET: { list: async () => ({ objects: [{key:'example/cache',size:1024}] }) } } as unknown as Env;
    const overview = await worker.fetch(new Request('https://worker.dev/api/overview'), env);
    const data = await overview.json() as any;
    assert.equal(data.overview.memoryGraph.r2ObjectsCount, 1);
    assert.equal(data.overview.memoryGraph.r2TotalBytes, 1024);
    // The real routed request uses the bound environment; no resource mutation is required by this stub.
    const res = await worker.fetch(new Request('https://worker.dev/api/memory/purge', {method:'POST'}), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).success, true);
  });

  for (const [path, key] of [['/api/github/orgs','organizations'], ['/api/dashboard/config','config'], ['/api/live/jobs','jobs']]) {
    it(`returns the public ${key} dashboard contract`, async () => {
      const res = await worker.fetch(new Request('https://worker.dev'+path), createMockEnv());
      const data = await res.json() as any;
      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.ok(data[key]);
    });
  }

  for (const path of ['/api/reviews','/api/runs','/api/analytics/cost','/api/analytics/token-burn','/api/analytics/findings-quality','/api/memory/overview','/api/memory/graph','/api/memory/learnings']) {
    it(`retains the ${path} read alias`, async () => {
      const res = await worker.fetch(new Request('https://worker.dev'+path), createMockEnv());
      assert.equal(res.status, 200);
      assert.equal((await res.json() as any).success, true);
    });
  }

  for (const method of ['PUT','PATCH']) {
    it(`preserves ${method} repository configuration and default malformed-body handling`, async () => {
      const res = await worker.fetch(new Request('https://worker.dev/api/dashboard/repositories', {method,body:'not-json'}), createMockEnv());
      const body = await res.json() as any;
      assert.equal(res.status, 200);
      assert.deepEqual(body.repository, {});
    });
  }

  it('rejects incomplete or malformed event publication with the public validation response', async () => {
    for (const body of ['not-json', '{}', JSON.stringify({jobId:'example-run'})]) {
      const res = await worker.fetch(new Request('https://worker.dev/api/live/publish', {method:'POST',body}), createMockEnv());
      assert.equal(res.status, 400);
      assert.equal((await res.json() as any).error, 'jobId and event required');
    }
  });

  it('keeps HITL defaults and explicit verdict, severity and dismissal payloads intact', async () => {
    const env=createMockEnv();
    const list = await worker.fetch(new Request('https://worker.dev/api/dashboard/hitl/prompt-guidance'),env);
    assert.ok((await list.json() as any).guidance.length > 0);
    for (const path of ['/api/dashboard/hitl/prompt-guidance','/api/dashboard/hitl/verdict-override','/api/dashboard/hitl/findings/dismiss','/api/dashboard/hitl/findings/severity']) {
      const malformed = await worker.fetch(new Request('https://worker.dev'+path,{method:'POST',body:'not-json'}),env);
      assert.equal(malformed.status,200);
      assert.equal((await malformed.json() as any).success,true);
    }
    const changed = await worker.fetch(new Request('https://worker.dev/api/dashboard/hitl/verdict-override',{method:'POST',body:JSON.stringify({jobId:'example-run',verdict:'BLOCK',reason:'Boundary failure',author:'example-reviewer'})}),env);
    const override=(await changed.json() as any).override;
    assert.equal(override.jobId,'example-run');assert.equal(override.verdict,'BLOCK');assert.equal(override.reason,'Boundary failure');assert.equal(override.author,'example-reviewer');
  });

  it('uses D1 review records for actual verdict and token values instead of the fallback feed', async () => {
    const reviews=['SHIP','BLOCK','COMMENT'].map((verdict,i)=>({id:'example-review-'+i,repo:'example/sample-cdr',pr_number:i+1,title:i===0?'':`Sample ${i}`,head_sha:'a'.repeat(40),verdict,status:'completed',duration_ms:1000,prompt_tokens:100,completion_tokens:20,total_tokens:120,spend_usd:0.01,created_at:1700000000000,quorum:i===0?'':'Sample quorum'}));
    const writes:unknown[][]=[];
    const db={prepare:(sql:string)=>({bind:(...values:unknown[])=>({all:async()=>({results:sql.includes('FROM reviews')?reviews:[]}),run:async()=>{writes.push(values);return{};}}),all:async()=>({results:[]})})};
    const env={...createMockEnv(),DB:db} as unknown as Env;
    const res=await worker.fetch(new Request('https://worker.dev/api/dashboard/logs'),env);const body=await res.json() as any;
    assert.equal(res.status,200);const actual=body.logs.filter((r:any)=>r.id.startsWith('example-review-'));
    assert.deepEqual(actual.map((r:any)=>r.verdict),['SHIP','NACK','COMMENT']);assert.ok(actual.every((r:any)=>r.tokenDetails.total===120));assert.ok(actual[0].title.includes('PR #1'));
    const update=await worker.fetch(new Request('https://worker.dev/api/github/repos',{method:'POST',body:JSON.stringify({id:'example/sample-cdr',owner:'example',repo:'sample-cdr',defaultBranch:'main',automationEnabled:true,generateFlowchart:true,customProfile:'balanced'})}),env);
    assert.equal(update.status,200);assert.equal(writes.length,1);
  });

  it('proxies a bound live stream without changing upstream bytes', async () => {
    const calls:string[]=[];const upstream='event: sample\ndata: {"jobId":"example-run"}\n\n';
    const env={...createMockEnv(),REVIEW_RUN:{idFromName:(name:string)=>name,get:()=>({fetch:async(url:string)=>{calls.push(url);return new Response(upstream,{headers:{'Content-Type':'text/event-stream'}});}})}} as unknown as Env;
    const res=await worker.fetch(new Request('https://worker.dev/api/live/stream?jobId=example-run'),env);
    assert.equal(await res.text(),upstream);assert.deepEqual(calls,['http://do/stream']);
  });

  it('drains the local live stream and retires it through its real abort signal', async () => {
    const controller=new AbortController();const res=await worker.fetch(new Request('https://worker.dev/api/live/stream?jobId=example-run',{signal:controller.signal}),createMockEnv());
    const reader=res.body!.getReader(),decoder=new TextDecoder();let content='';
    try{while(!content.includes('"overallProgress":100')){const item=await reader.read();assert.equal(item.done,false);content+=decoder.decode(item.value);}}
    finally{controller.abort();await reader.cancel();}
    assert.ok(content.includes('event: connection:open'));assert.ok(content.includes('example-run'));
  });
});


describe('Dashboard trigger and gate public fallback boundaries', () => {
  it('sends the public trigger command and completed lifecycle through a bound review run', async () => {
    const calls: Array<{ url: string; payload: any }> = [];
    let resolveComplete!: () => void;
    const completed = new Promise<void>(resolve => { resolveComplete = resolve; });
    const env = { ...createMockEnv(), REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (url: string, init: RequestInit) => {
        const payload = JSON.parse(init.body as string);
        calls.push({ url, payload });
        if (payload.type === 'stage:transition' && payload.stage === 'complete') resolveComplete();
        return Response.json({ success: true });
      } }),
    } } as unknown as Env;
    const res = await worker.fetch(new Request('https://worker.dev/api/live/trigger', {
      method: 'POST', body: JSON.stringify({ jobId: 'example-bound-run', repo: 'example/sample-cdr', prNumber: 23 }),
    }), env);
    assert.equal(res.status, 200);
    await completed;
    assert.deepEqual(calls[0], { url: 'http://do/trigger', payload: { jobId: 'example-bound-run', repo: 'example/sample-cdr', prNumber: 23 } });
    const transitions = calls.filter(call => call.url === 'http://do/events' && call.payload.type === 'stage:transition');
    assert.equal(transitions.at(-1)?.payload.stage, 'complete');
    assert.equal(transitions.at(-1)?.payload.overallProgress, 100);
    assert.ok(transitions.every(call => call.payload.jobId === 'example-bound-run'));
    assert.ok(calls.some(call => call.payload.type === 'log:chunk'));
  });

  it('uses documented trigger defaults for malformed JSON and untyped pull request numbers', async () => {
    for (const [body, expectedRepo] of [
      ['not-json', 'reviewyeti-ai/yeti-pr-reviewer'],
      [JSON.stringify({ jobId: 'example-trigger', repo: 'example/sample-cdr', prNumber: 'untyped' }), 'example/sample-cdr'],
    ]) {
      const res = await worker.fetch(new Request('https://worker.dev/api/live/trigger', { method: 'POST', body }), createMockEnv());
      const data = await res.json() as any;
      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.prNumber, 1282);
      assert.equal(data.stagesCount, 6);
      assert.ok(data.streamUrl.includes(data.jobId));
      assert.equal(data.repo, expectedRepo);
    }
  });

  it('reads bound gate state using the neutral repository IDs in overview', async () => {
    const queried: string[] = [];
    const env = { ...createMockEnv(), REPO_GATE: { idFromName: (name: string) => { queried.push(name); return name; }, get: () => ({ fetch: async () => Response.json({ activeCount: 2, queueLength: 1 }) }) } } as unknown as Env;
    const res = await worker.fetch(new Request('https://worker.dev/api/dashboard/overview'), env);
    const data = await res.json() as any;
    assert.equal(res.status, 200);
    assert.ok(queried.includes('example/sample-cdr'));
    assert.ok(queried.includes('example/sample-meta'));
    assert.equal(data.overview.liveDurableObjects['example/sample-cdr'].activeCount, 2);
    assert.equal(data.overview.liveDurableObjects['example/sample-meta'].queueLength, 1);
    assert.ok(data.overview.activeJobsCount >= 6);
  });
});


describe('Integrated public topology route boundaries', () => {
  it('returns all four public tiers and stable telemetry for the default or empty job identifier', async () => {
    for (const query of ['', '?jobId=']) {
      const response = await worker.fetch(new Request('https://worker.dev/api/live/topology' + query), createMockEnv());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), 'application/json');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      const topology = await response.json() as any;
      assert.equal(topology.success, true);
      assert.equal(topology.jobId, 'run_live_reviewyeti_pr1282');
      assert.ok(Number.isFinite(Date.parse(topology.timestamp)));
      assert.equal(topology.healthScore, 99.9);
      assert.equal(topology.activeWorkers, 4);
      assert.deepEqual(topology.tiers, [
        { tier: 1, name: 'Edge Ingress', nodesCount: 2, status: 'HEALTHY' },
        { tier: 2, name: 'State & Storage Mesh', nodesCount: 4, status: 'HEALTHY' },
        { tier: 3, name: 'Autonomous Swarm Agents', nodesCount: 5, status: 'IN_FLIGHT' },
        { tier: 4, name: 'Inference Fleet', nodesCount: 4, status: 'HEALTHY' },
      ]);
    }
  });

  it('retains an explicit job identifier without invoking mutable review or storage bindings', async () => {
    let bindingCalls = 0;
    const env = { ...createMockEnv(), REVIEW_RUN: { idFromName: () => { bindingCalls++; throw new Error('Unexpected review mutation'); } }, DB: { prepare: () => { bindingCalls++; throw new Error('Unexpected database mutation'); } } } as unknown as Env;
    const response = await worker.fetch(new Request('https://worker.dev/api/live/topology?jobId=example-topology-run'), env);
    assert.equal(response.status, 200);
    const topology = await response.json() as any;
    assert.equal(topology.jobId, 'example-topology-run');
    assert.equal(topology.globalThroughputTokSec, 384);
    assert.equal(topology.edgeP95RttMs, 14.2);
    assert.equal(topology.r2CacheHitRate, 95.8);
    assert.equal(bindingCalls, 0);
  });

  it('preserves topology CORS preflight without returning a topology payload', async () => {
    const response = await worker.fetch(new Request('https://worker.dev/api/live/topology', { method: 'OPTIONS' }), createMockEnv());
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(response.headers.get('Access-Control-Allow-Methods')?.includes('GET'));
  });

  it('keeps the public read available while rejecting an unauthorized adjacent cache mutation', async () => {
    const env = { ...createMockEnv(), REVIEW_YETI_MCP_AUTH_TOKEN: 'example-authorized-token' } as Env;
    const read = await worker.fetch(new Request('https://worker.dev/api/live/topology', { headers: { Authorization: 'Bearer example-invalid-token' } }), env);
    assert.equal(read.status, 200);
    assert.equal((await read.json() as any).success, true);
    const mutation = await worker.fetch(new Request('https://worker.dev/api/cache/purge-expired', { method: 'POST', headers: { Authorization: 'Bearer example-invalid-token' } }), env);
    assert.equal(mutation.status, 401);
    assert.match(await mutation.text(), /requires valid authorization token/);
  });

  it('returns the existing not-found error for an unknown adjacent topology path', async () => {
    const response = await worker.fetch(new Request('https://worker.dev/api/live/topology-unknown'), createMockEnv());
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Not Found/i);
  });
});
