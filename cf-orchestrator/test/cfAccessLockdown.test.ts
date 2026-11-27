import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import worker, { defaultMcpRouter, handleFetch, isAuthorizedAccess } from '../src/worker.js';
import type { Env } from '../src/types.js';

function createLockedEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'production',
    PARALLEL_CHECK_NAME: 'Review Yeti',
    PILOT_REPOSITORIES: 'all',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
    PUBLIC_READ_MCP: 'false',
    REQUIRE_CF_ACCESS: 'true',
    REVIEW_YETI_MCP_AUTH_TOKEN: 'secret-mcp-token-999',
    ASSETS: {
      fetch: async () => new Response('<html>Portal</html>', { status: 200 }),
    } as any,
    ...overrides,
  } as Env;
}

describe('Whole-Site Cloudflare Access Lockdown', () => {
  it('enforces workers_dev=false, preview_urls=false, PUBLIC_READ_MCP=false, and REQUIRE_CF_ACCESS=true in wrangler.toml', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), 'utf8');
    assert.match(wrangler, /^workers_dev\s*=\s*false\b/mu);
    assert.match(wrangler, /^preview_urls\s*=\s*false\b/mu);
    assert.match(wrangler, /^run_worker_first\s*=\s*true\b/mu);
    assert.match(wrangler, /^PUBLIC_READ_MCP\s*=\s*"false"/mu);
    assert.match(wrangler, /^REQUIRE_CF_ACCESS\s*=\s*"true"/mu);
  });

  it('blocks unauthenticated requests to /memory and root static assets with 403', async () => {
    const env = createLockedEnv();
    for (const path of ['/', '/memory', '/reviews', '/analytics', '/l', '/live-swarm']) {
      const req = new Request(`https://review-bot.example.com${path}`, { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 403, `Expected 403 for unauthenticated ${path}`);
    }
  });

  it('blocks unauthenticated requests to /api/memory/*, /api/reviews, /api/runs, /api/analytics/*, /api/dashboard/*, /api/live/*, /version', async () => {
    const env = createLockedEnv();
    const apiPaths = [
      '/version',
      '/api/overview',
      '/api/memory/stats',
      '/api/memory/overview',
      '/api/memory/query',
      '/api/memory/export',
      '/api/reviews',
      '/api/runs',
      '/api/analytics/cost',
      '/api/dashboard/overview',
      '/api/live/active',
    ];
    for (const path of apiPaths) {
      const req = new Request(`https://review-bot.example.com${path}`, { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 403, `Expected 403 for unauthenticated ${path}`);
    }
  });

  it('rejects spoofed Cf-Access-Authenticated-User-Email, CF-Access-Client-Id, and unsigned Cf-Access-Jwt-Assertion headers', async () => {
    const env = createLockedEnv({
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'expected-aud-tag',
    });

    const spoofedHeadersList: Record<string, string>[] = [
      { 'Cf-Access-Authenticated-User-Email': 'spoof@example.com' },
      { 'CF-Access-Client-Id': 'spoof-client-id' },
      { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzcG9vZiJ9.' },
    ];

    for (const headers of spoofedHeadersList) {
      const req = new Request('https://review-bot.example.com/api/memory/stats', {
        method: 'GET',
        headers,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 403);
    }
  });

  it('allows requests with valid Bearer REVIEW_YETI_MCP_AUTH_TOKEN', async () => {
    const env = createLockedEnv();
    const req = new Request('https://review-bot.example.com/api/memory/stats', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer secret-mcp-token-999',
      },
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
  });

  it('verifies RS256 Cloudflare Access JWT against ACCESS_TEAM_DOMAIN and ACCESS_AUD', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-cf-access-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keySet = createLocalJWKSet({ keys: [jwk] });

    const env = createLockedEnv({
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'aud-review-bot-123',
    });

    const validJwt = await new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-cf-access-kid' })
      .setIssuer('https://example.cloudflareaccess.com')
      .setAudience('aud-review-bot-123')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const validReq = new Request('https://review-bot.example.com/memory', {
      headers: { 'Cf-Access-Jwt-Assertion': validJwt },
    });
    assert.equal(await isAuthorizedAccess(validReq, env, { keySet }), true);

    const wrongAudJwt = await new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-cf-access-kid' })
      .setIssuer('https://example.cloudflareaccess.com')
      .setAudience('wrong-aud')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const wrongAudReq = new Request('https://review-bot.example.com/memory', {
      headers: { 'Cf-Access-Jwt-Assertion': wrongAudJwt },
    });
    assert.equal(await isAuthorizedAccess(wrongAudReq, env, { keySet }), false);
  });

  it('keeps /health and /ready probes accessible for liveness checks', async () => {
    const env = createLockedEnv();
    const res = await worker.fetch(new Request('https://review-bot.example.com/health'), env);
    assert.equal(res.status, 200);
  });

  it('blocks unauthenticated GET /api/mcp and GET /mcp with 401 when PUBLIC_READ_MCP is false', async () => {
    for (const tokenOverride of ['secret-mcp-token-999', '']) {
      const env = createLockedEnv({ REVIEW_YETI_MCP_AUTH_TOKEN: tokenOverride });
      for (const path of ['/api/mcp', '/mcp']) {
        const res = await worker.fetch(
          new Request(`https://review-bot.example.com${path}`, { method: 'GET' }),
          env
        );
        assert.equal(res.status, 401, `Expected 401 for unauthenticated GET ${path}`);
        assert.equal(res.headers.get('Cache-Control'), 'no-store');
      }
    }
  });

  it('allows authenticated GET /api/mcp via Bearer token or Cloudflare Access authorization', async () => {
    const env = createLockedEnv();
    const bearerRes = await worker.fetch(
      new Request('https://review-bot.example.com/api/mcp', {
        method: 'GET',
        headers: { Authorization: 'Bearer secret-mcp-token-999' },
      }),
      env
    );
    assert.equal(bearerRes.status, 200);
    assert.equal((await bearerRes.json() as any).toolsCount, 23);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-mcp-access-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keySet = createLocalJWKSet({ keys: [jwk] });

    const accessEnv = createLockedEnv({
      REVIEW_YETI_MCP_AUTH_TOKEN: '',
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'aud-review-bot-123',
    });
    const validJwt = await new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-mcp-access-kid' })
      .setIssuer('https://example.cloudflareaccess.com')
      .setAudience('aud-review-bot-123')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const mcpReq = new Request('https://review-bot.example.com/api/mcp', {
      method: 'GET',
      headers: { 'Cf-Access-Jwt-Assertion': validJwt },
    });
    const accessAuthorized = await isAuthorizedAccess(mcpReq, accessEnv, { keySet });
    assert.equal(accessAuthorized, true);

    const accessRes = await defaultMcpRouter.handleHttpRequest(mcpReq, accessEnv, { accessAuthorized });
    assert.equal(accessRes.status, 200);
    assert.equal((await accessRes.json() as any).toolsCount, 23);
  });

  it('serves /review_yeti/mcp across GET, POST, auth, and SSE only when Access JWT (multi-AUD) or Bearer token verifies', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-review-yeti-mcp-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keySet = createLocalJWKSet({ keys: [jwk] });

    const env = createLockedEnv({
      REVIEW_YETI_MCP_AUTH_TOKEN: 'secret-mcp-token-999',
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'aud-portal-111, aud-mcp-edge-222',
    });

    // 1. Unauthenticated GET, POST, /auth, and /sse fail closed with 401
    for (const [method, path, body] of [
      ['GET', '/review_yeti/mcp', undefined],
      ['GET', '/review_yeti/mcp/auth', undefined],
      ['GET', '/review_yeti/mcp/sse', undefined],
      ['POST', '/review_yeti/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })],
    ] as const) {
      const res = await handleFetch(
        new Request(`https://mcp.example.com${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body,
        }),
        env,
        undefined,
        { keySet }
      );
      assert.equal(res.status, 401, `Expected 401 for unauthenticated ${method} ${path}`);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    }

    // 2. Signed RS256 Access JWT matching the second AUD authorizes all MCP routes
    const mcpEdgeJwt = await new SignJWT({ email: 'agent@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-review-yeti-mcp-kid' })
      .setIssuer('https://example.cloudflareaccess.com')
      .setAudience('aud-mcp-edge-222')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const authProbe = await handleFetch(
      new Request('https://mcp.example.com/review_yeti/mcp/auth', {
        method: 'GET',
        headers: { 'Cf-Access-Jwt-Assertion': mcpEdgeJwt },
      }),
      env,
      undefined,
      { keySet }
    );
    assert.equal(authProbe.status, 200);
    assert.deepEqual(await authProbe.json(), {
      authenticated: true,
      service: 'review-yeti',
      transport: 'cloudflare',
    });

    const toolsListRes = await handleFetch(
      new Request('https://mcp.example.com/review_yeti/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Jwt-Assertion': mcpEdgeJwt,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
      env,
      undefined,
      { keySet }
    );
    assert.equal(toolsListRes.status, 200);
    assert.equal((await toolsListRes.json() as any).result.tools.length, 23);

    const toolCallRes = await handleFetch(
      new Request('https://mcp.example.com/review_yeti/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Jwt-Assertion': mcpEdgeJwt,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'review_yeti_get_cloudflare_status', arguments: {} },
        }),
      }),
      env,
      undefined,
      { keySet }
    );
    assert.equal(toolCallRes.status, 200);
    assert.ok((await toolCallRes.json() as any).result?.content?.[0]?.text);

    const sseRes = await handleFetch(
      new Request('https://mcp.example.com/review_yeti/mcp/sse', {
        method: 'GET',
        headers: { 'Cf-Access-Jwt-Assertion': mcpEdgeJwt },
      }),
      env,
      undefined,
      { keySet }
    );
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(firstChunk, /data: \/review_yeti\/mcp\/messages\?sessionId=/);
    await reader.cancel();

    // 3. Bearer token still works for operator transitions on /review_yeti/mcp
    const bearerRes = await handleFetch(
      new Request('https://mcp.example.com/review_yeti/mcp/auth', {
        method: 'GET',
        headers: { Authorization: 'Bearer secret-mcp-token-999' },
      }),
      env,
      undefined,
      { keySet }
    );
    assert.equal(bearerRes.status, 200);
  });

  it('keeps legacy endpoints active when LEGACY_SUNSET_HOSTS is unset, and returns 410 Gone only on configured legacy hosts', async () => {
    // 1. Default (unset LEGACY_SUNSET_HOSTS): legacy host retains active routes
    const defaultEnv = createLockedEnv({ GITHUB_WEBHOOK_SECRET: 'test-webhook-secret' });
    const preSunsetWebhook = await handleFetch(
      new Request('https://review-bot.example.com/api/webhooks/github', {
        method: 'POST',
        body: '{}',
      }),
      defaultEnv
    );
    assert.equal(preSunsetWebhook.status, 401);

    const preSunsetMcp = await handleFetch(
      new Request('https://review-bot.example.com/api/mcp', { method: 'GET' }),
      defaultEnv
    );
    assert.equal(preSunsetMcp.status, 401);

    // 2. Enabled (LEGACY_SUNSET_HOSTS=review-bot.example.com): retired endpoints return 410 + structured warning
    const sunsetEnv = createLockedEnv({
      GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
      LEGACY_SUNSET_HOSTS: 'review-bot.example.com',
    });
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '));
    };
    try {
      const legacyWebhookRes = await handleFetch(
        new Request('https://review-bot.example.com/api/webhooks/github', {
          method: 'POST',
          headers: { 'User-Agent': 'GitHub-Hookshot/test' },
          body: '{}',
        }),
        sunsetEnv
      );
      assert.equal(legacyWebhookRes.status, 410);
      assert.equal(legacyWebhookRes.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await legacyWebhookRes.json(), {
        error: 'endpoint_retired',
        host: 'review-bot.example.com',
        path: '/api/webhooks/github',
        endpoint: 'webhook',
      });

      for (const [method, path] of [
        ['POST', '/api/mcp'],
        ['GET', '/api/mcp/auth'],
        ['POST', '/mcp'],
      ] as const) {
        const legacyMcpRes = await handleFetch(
          new Request(`https://review-bot.example.com${path}`, {
            method,
            headers: { Authorization: 'Bearer secret-mcp-token-999' },
          }),
          sunsetEnv
        );
        assert.equal(legacyMcpRes.status, 410, `Expected 410 for sunset ${method} ${path}`);
        assert.equal(legacyMcpRes.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(await legacyMcpRes.json(), {
          error: 'endpoint_retired',
          host: 'review-bot.example.com',
          path,
          endpoint: 'mcp',
        });
      }

      // 3. Health probe, Service Binding (review-yeti-internal), and mcp.example.com/review_yeti/mcp remain active
      const healthRes = await handleFetch(
        new Request('https://review-bot.example.com/health'),
        sunsetEnv
      );
      assert.equal(healthRes.status, 200);

      const serviceBindingWebhook = await handleFetch(
        new Request('https://review-yeti-internal/api/webhooks/github', {
          method: 'POST',
          body: '{}',
        }),
        sunsetEnv
      );
      assert.equal(serviceBindingWebhook.status, 401);

      const mcpPlaneAuth = await handleFetch(
        new Request('https://mcp.example.com/review_yeti/mcp/auth', {
          method: 'GET',
          headers: { Authorization: 'Bearer secret-mcp-token-999' },
        }),
        sunsetEnv
      );
      assert.equal(mcpPlaneAuth.status, 200);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnMessages.length, 4);
    for (const msg of warnMessages) {
      const parsed = JSON.parse(msg);
      assert.equal(parsed.event, 'legacy_host_sunset_hit');
      assert.equal(parsed.host, 'review-bot.example.com');
    }
  });
});
