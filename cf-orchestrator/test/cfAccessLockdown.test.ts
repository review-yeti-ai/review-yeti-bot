import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import worker, { isAuthorizedAccess } from '../src/worker.js';
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
});
