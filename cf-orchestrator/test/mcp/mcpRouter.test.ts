import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultMcpRouter, McpRouter } from '../../src/mcp/mcpRouter.js';
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME } from '../../src/mcp/types.js';

describe('Review Yeti MCP Router & Protocol (JSON-RPC 2.0)', () => {
  it('handles "initialize" with protocol version and capabilities', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.ok(res.result);
    assert.equal(res.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(res.result.serverInfo.name, MCP_SERVER_NAME);
    assert.ok(res.result.capabilities.tools);
    assert.ok(res.result.capabilities.resources);
  });

  it('handles "ping" returning an empty object', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 'ping-123',
      method: 'ping',
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 'ping-123');
    assert.deepEqual(res.result, {});
  });

  it('handles "tools/list" returning all registered Review Yeti tools', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.result);
    assert.ok(Array.isArray(res.result.tools));
    assert.equal(res.result.tools.length, 18);

    const toolNames = res.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes('review_yeti_query_active_jobs'));
    assert.ok(toolNames.includes('review_yeti_query_findings'));
    assert.ok(toolNames.includes('review_yeti_get_cloudflare_status'));
    assert.ok(toolNames.includes('review_yeti_get_billable_runtime_report'));
    assert.ok(toolNames.includes('review_yeti_get_runtime_metrics'));
    assert.ok(toolNames.includes('review_yeti_get_analytics_dashboard'));
    assert.ok(toolNames.includes('review_yeti_trigger_review'));
    assert.ok(toolNames.includes('review_yeti_cancel_review'));
    assert.ok(toolNames.includes('review_yeti_purge_cache'));
    assert.ok(toolNames.includes('review_yeti_attest_pr_gate'));
    assert.ok(toolNames.includes('review_yeti_dispute_finding'));
    assert.ok(toolNames.includes('review_yeti_reply_review_thread'));
    assert.ok(toolNames.includes('review_yeti_onboard_organization'));
    assert.ok(toolNames.includes('review_yeti_onboard_repository'));
    assert.ok(toolNames.includes('review_yeti_update_repository_settings'));
    assert.ok(toolNames.includes('review_yeti_sync_github_installation'));
    assert.ok(toolNames.includes('review_yeti_get_onboarding_status'));
    assert.ok(toolNames.includes('review_yeti_list_repositories'));
  });

  it('supports unprefixed tool name aliases and legacy aliases', () => {
    assert.ok(defaultMcpRouter.getTool('attest_pr_gate'));
    assert.ok(defaultMcpRouter.getTool('dispute_finding'));
    assert.ok(defaultMcpRouter.getTool('reply_review_thread'));
    assert.ok(defaultMcpRouter.getTool('trigger_review'));
    assert.ok(defaultMcpRouter.getTool('get_review_findings'));
    assert.ok(defaultMcpRouter.getTool('review_yeti_get_review_findings'));
  });

  it('rejects invalid JSON-RPC version with error code -32600', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '1.0' as any,
      id: 3,
      method: 'tools/list',
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.error);
    assert.equal(res.error.code, -32600);
    assert.ok(res.error.message.includes('jsonrpc must be "2.0"'));
  });

  it('rejects unknown methods with error code -32601', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'unknown/method',
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.error);
    assert.equal(res.error.code, -32601);
  });

  it('rejects "tools/call" without tool name with error code -32602', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {},
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
  });

  it('rejects "tools/call" for unknown tool with error code -32601', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'non_existent_tool' },
    });

    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.error);
    assert.equal(res.error.code, -32601);
    assert.ok(res.error.message.includes('unknown tool "non_existent_tool"'));
  });

  it('handles "resources/list" and "resources/read" correctly', async () => {
    const listRes = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
    });

    assert.equal(listRes.jsonrpc, '2.0');
    assert.ok(Array.isArray(listRes.result.resources));
    assert.equal(listRes.result.resources.length, 3);

    const readRes = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'resources/read',
      params: { uri: 'reviewyeti://status/cloudflare' },
    });

    assert.equal(readRes.jsonrpc, '2.0');
    assert.ok(readRes.result.contents[0].text);
  });

  it('rejects "resources/read" without URI parameter (-32602)', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 81,
      method: 'resources/read',
      params: {},
    });
    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
    assert.ok(res.error.message.includes('"uri" required'));
  });

  it('rejects "resources/read" for unknown resource URI (-32602)', async () => {
    const res = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 82,
      method: 'resources/read',
      params: { uri: 'reviewyeti://nonexistent/resource' },
    });
    assert.equal(res.jsonrpc, '2.0');
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
    assert.ok(res.error.message.includes('Resource not found'));
  });

  it('rejects "tools/call" with invalid argument schema (-32602)', async () => {
    // 1. Missing required field 'repo' for review_yeti_trigger_review
    const missingRequiredRes = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'review_yeti_trigger_review',
        arguments: { prNumber: 5293 },
      },
    });
    assert.equal(missingRequiredRes.error?.code, -32602);
    assert.ok(missingRequiredRes.error?.message.includes('Missing required parameter: "repo"'));

    // 2. Wrong type for prNumber (string instead of number)
    const wrongTypeRes = await defaultMcpRouter.handleRpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'review_yeti_trigger_review',
        arguments: { repo: 'example-api', prNumber: 'not-a-number' },
      },
    });
    assert.equal(wrongTypeRes.error?.code, -32602);
    assert.ok(wrongTypeRes.error?.message.includes('Parameter "prNumber" must be a number'));
  });

  describe('handleHttpRequest Transport & Security Gates', () => {
    it('handles OPTIONS request with CORS headers', async () => {
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://review-bot.example.com' },
      });
      const res = await defaultMcpRouter.handleHttpRequest(req, { ALLOWED_ORIGINS: 'https://review-bot.example.com' });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://review-bot.example.com');
      assert.ok(res.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
    });

    describe('configured origin allowlist (ALLOWED_ORIGINS)', () => {
      const preflight = (origin: string | null, env: Record<string, unknown>) => defaultMcpRouter.handleHttpRequest(
        new Request('https://review-yeti.test/api/mcp', { method: 'OPTIONS', headers: origin ? { Origin: origin } : {} }),
        env,
      );

      it('allows an https subdomain of a *.suffix entry and nothing else', async () => {
        const env = { ALLOWED_ORIGINS: '*.example.com' };
        assert.equal((await preflight('https://dash.example.com', env)).headers.get('Access-Control-Allow-Origin'), 'https://dash.example.com');
        assert.equal((await preflight('https://a.b.example.com', env)).headers.get('Access-Control-Allow-Origin'), 'https://a.b.example.com');
        // Not https, the bare apex, a suffix lookalike and a malformed origin are all rejected: the response falls back to the
        // request's own origin rather than echoing the caller.
        for (const rejected of ['http://dash.example.com', 'https://example.com', 'https://evilexample.com', 'https://dash.example.com.evil.test', 'not a url']) {
          assert.equal((await preflight(rejected, env)).headers.get('Access-Control-Allow-Origin'), 'https://review-yeti.test', rejected);
        }
      });

      it('echoes only exact matches and prefers the first exact entry as the fallback', async () => {
        const env = { ALLOWED_ORIGINS: ' *.example.org , https://one.example.com ' };
        assert.equal((await preflight('https://one.example.com', env)).headers.get('Access-Control-Allow-Origin'), 'https://one.example.com');
        assert.equal((await preflight('https://one.example.com.evil.test', env)).headers.get('Access-Control-Allow-Origin'), 'https://one.example.com');
        assert.equal((await preflight('https://two.example.org', env)).headers.get('Access-Control-Allow-Origin'), 'https://two.example.org');
      });

      it('with nothing configured allows only loopback and no-origin callers, falling back to the request origin', async () => {
        for (const env of [{}, { ALLOWED_ORIGINS: '' }, { ALLOWED_ORIGINS: ' , ' }]) {
          assert.equal((await preflight('https://dash.example.com', env)).headers.get('Access-Control-Allow-Origin'), 'https://review-yeti.test');
          assert.equal((await preflight('http://localhost:3000', env)).headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
          assert.equal((await preflight(null, env)).headers.get('Access-Control-Allow-Origin'), 'https://review-yeti.test');
        }
      });
    });

    it('handles GET discovery request with tool list', async () => {
      const req = new Request('https://review-yeti.test/api/mcp', { method: 'GET' });
      const res = await defaultMcpRouter.handleHttpRequest(req, {});
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.name, 'review-yeti-cf-orchestrator');
      assert.ok(data.toolsCount >= 8);
    });

    it('rejects POST tools/call with 401 when REVIEW_YETI_MCP_AUTH_TOKEN is unconfigured', async () => {
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'review_yeti_query_active_jobs', arguments: {} },
        }),
      });
      const res = await defaultMcpRouter.handleHttpRequest(req, {});
      assert.equal(res.status, 401);
      const data = (await res.json()) as any;
      assert.equal(data.error.code, -32000);
      assert.ok(data.error.message.includes('requires authentication'));
    });

    it('rejects POST with 401 when token is invalid', async () => {
      const env = { REVIEW_YETI_MCP_AUTH_TOKEN: 'correct_token_123' };
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong_token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' }),
      });
      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 401);
    });

    it('allows POST when token is valid and executes tools', async () => {
      const env = { REVIEW_YETI_MCP_AUTH_TOKEN: 'correct_token_123' };
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer correct_token_123',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 13,
          method: 'tools/call',
          params: { name: 'review_yeti_query_active_jobs', arguments: {} },
        }),
      });
      const res = await defaultMcpRouter.handleHttpRequest(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.ok(!data.error);
      assert.ok(data.result.content);
    });

    it('rejects POST resources/list with 401 when REVIEW_YETI_MCP_AUTH_TOKEN is unconfigured', async () => {
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 14,
          method: 'resources/list',
        }),
      });
      const res = await defaultMcpRouter.handleHttpRequest(req, {});
      assert.equal(res.status, 401);
      const data = (await res.json()) as any;
      assert.equal(data.error.code, -32000);
      assert.ok(data.error.message.includes('requires authentication'));
    });

    it('rejects unsupported HTTP method with 405 Method Not Allowed', async () => {
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'DELETE',
      });
      const res = await defaultMcpRouter.handleHttpRequest(req, {});
      assert.equal(res.status, 405);
      const text = await res.text();
      assert.ok(text.includes('Method Not Allowed'));
    });
  });
});
