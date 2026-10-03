import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.js';

describe('Review Yeti MCP Worker Route Integration (/api/mcp)', () => {
  it('GET /api/mcp returns server info, CORS headers, and tool list', async () => {
    const req = new Request('https://review-yeti.test/api/mcp', {
      method: 'GET',
    });
    const res = await worker.fetch(req, {} as any);

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Access-Control-Allow-Origin'));
    const data = (await res.json()) as any;
    assert.equal(data.name, 'review-yeti-cf-orchestrator');
    assert.equal(data.toolsCount, 9);
    assert.ok(Array.isArray(data.tools));
  });

  it('OPTIONS /api/mcp returns 204 with CORS preflight headers', async () => {
    const req = new Request('https://review-yeti.test/api/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://review-bot.example.com' },
    });
    const res = await worker.fetch(req, { ALLOWED_ORIGINS: 'https://review-bot.example.com' } as any);

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://review-bot.example.com');
    assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
  });

  it('POST /api/mcp executes "initialize" JSON-RPC handshake', async () => {
    const req = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
      }),
    });
    const res = await worker.fetch(req, {} as any);

    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.jsonrpc, '2.0');
    assert.equal(data.id, 'init-1');
    assert.ok(data.result.serverInfo);
  });

  it('POST /api/mcp dispatches "tools/call" for review_yeti_get_cloudflare_status', async () => {
    const mockEnv = {
      ENVIRONMENT: 'production',
      PARALLEL_MODE: 'true',
      REVIEW_YETI_MCP_AUTH_TOKEN: 'mcp_integration_token_123',
    };

    const req = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer mcp_integration_token_123',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'tools/call',
        params: {
          name: 'review_yeti_get_cloudflare_status',
          arguments: { repo: 'example-api' },
        },
      }),
    });
    const res = await worker.fetch(req, mockEnv as any);

    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.jsonrpc, '2.0');
    assert.equal(data.id, 'call-1');
    assert.ok(data.result.content);
    assert.ok(data.result.content[0].text.includes('Review Yeti Cloudflare Control Plane Status'));
  });

  it('POST /api/mcp returns 400 on malformed JSON payload', async () => {
    const req = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'MALFORMED_NON_JSON_DATA',
    });
    const res = await worker.fetch(req, {} as any);

    assert.equal(res.status, 400);
    const data = (await res.json()) as any;
    assert.equal(data.error.code, -32700);
  });

  it('enforces REVIEW_YETI_MCP_AUTH_TOKEN when configured', async () => {
    const secureEnv = {
      REVIEW_YETI_MCP_AUTH_TOKEN: 'secret_mcp_auth_token_xyz',
    };

    // 1. Missing auth header -> 401
    const unauthReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    const unauthRes = await worker.fetch(unauthReq, secureEnv as any);
    assert.equal(unauthRes.status, 401);

    // 2. Invalid auth token -> 401
    const wrongAuthReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong_token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    const wrongAuthRes = await worker.fetch(wrongAuthReq, secureEnv as any);
    assert.equal(wrongAuthRes.status, 401);

    // 3. Valid auth token -> 200
    const validAuthReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret_mcp_auth_token_xyz',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    const validAuthRes = await worker.fetch(validAuthReq, secureEnv as any);
    assert.equal(validAuthRes.status, 200);
    const validData = (await validAuthRes.json()) as any;
    assert.deepEqual(validData.result, {});
  });

  it('rejects all tools (mutating and read) and resources with 401 when REVIEW_YETI_MCP_AUTH_TOKEN is unset (fail-closed auth)', async () => {
    const unconfiguredEnv = {};
    const toolsToTest = [
      { name: 'review_yeti_trigger_review', args: { repo: 'example-api', prNumber: 5293 } },
      { name: 'review_yeti_cancel_review', args: { repo: 'example-api', prNumber: 5293 } },
      { name: 'review_yeti_purge_cache', args: {} },
      { name: 'review_yeti_query_active_jobs', args: {} },
      { name: 'review_yeti_query_findings', args: { repo: 'example-api', prNumber: 5293 } },
      { name: 'review_yeti_get_cloudflare_status', args: {} },
      { name: 'review_yeti_get_billable_runtime_report', args: {} },
      { name: 'review_yeti_get_runtime_metrics', args: {} },
      { name: 'review_yeti_get_analytics_dashboard', args: {} },
    ];

    for (let i = 0; i < toolsToTest.length; i++) {
      const tool = toolsToTest[i];
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10 + i,
          method: 'tools/call',
          params: {
            name: tool.name,
            arguments: tool.args,
          },
        }),
      });
      const res = await worker.fetch(req, unconfiguredEnv as any);
      assert.equal(res.status, 401, `Tool ${tool.name} must be rejected with 401 when token is unset`);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, -32000);
      assert.ok(body.error.message.includes('requires authentication'));
    }

    // Verify resources/read is also rejected with 401 when token is unset
    const resourceReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'resources/read',
        params: {
          uri: 'reviewyeti://analytics/dashboard',
        },
      }),
    });
    const resourceRes = await worker.fetch(resourceReq, unconfiguredEnv as any);
    assert.equal(resourceRes.status, 401, 'resources/read must be rejected with 401 when token is unset');
    const resourceBody = (await resourceRes.json()) as any;
    assert.equal(resourceBody.error.code, -32000);
    assert.ok(resourceBody.error.message.includes('requires authentication'));
  });

  it('allows public read-only tools and blocks mutating tools when PUBLIC_READ_MCP="true"', async () => {
    const publicEnv = {
      ENVIRONMENT: 'production',
      PARALLEL_MODE: 'true',
      PUBLIC_READ_MCP: 'true',
    };

    // 1. Read-only tool execution succeeds without token
    const readReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'pub-read-1',
        method: 'tools/call',
        params: {
          name: 'review_yeti_get_runtime_metrics',
          arguments: { repo: 'example-api', windowHours: 24 },
        },
      }),
    });
    const readRes = await worker.fetch(readReq, publicEnv as any);
    assert.equal(readRes.status, 200);
    const readData = (await readRes.json()) as any;
    assert.ok(readData.result.content);
    assert.ok(readData.result.content[0].text.includes('Review Yeti Runtime Latency'));

    // 2. Resources read succeeds without token
    const resReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'pub-res-1',
        method: 'resources/read',
        params: { uri: 'reviewyeti://analytics/dashboard' },
      }),
    });
    const resRes = await worker.fetch(resReq, publicEnv as any);
    assert.equal(resRes.status, 200);

    // 3. Mutating tool execution is strictly rejected with 401 even when PUBLIC_READ_MCP="true"
    const mutateReq = new Request('https://review-yeti.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'pub-mutate-1',
        method: 'tools/call',
        params: {
          name: 'review_yeti_trigger_review',
          arguments: { owner: 'exampleorg', repo: 'example-api', prNumber: 5318 },
        },
      }),
    });
    const mutateRes = await worker.fetch(mutateReq, publicEnv as any);
    assert.equal(mutateRes.status, 401);
  });

  it('routes /mcp identically to /api/mcp', async () => {
    const req = new Request('https://review-yeti.test/mcp', {
      method: 'GET',
    });
    const res = await worker.fetch(req, {} as any);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.name, 'review-yeti-cf-orchestrator');
    assert.equal(data.toolsCount, 9);
  });
});
