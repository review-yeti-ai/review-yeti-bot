import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createActionDispatchApp, type ActionDispatchAppOptions } from '../../src/dispatchServer';
import {
  McpAuthenticator,
  extractBearerToken,
  timingSafeTokenMatch,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import { verifyRepositoryAccess, McpRbacError } from '../../src/mcp/server/mcpRbac';
import { SlidingWindowRateLimiter } from '../../src/mcp/server/mcpRateLimiter';
import { createRemoteMcpRouter, type RemoteMcpRouter } from '../../src/mcp/server/remoteMcpRouter';
import { MCP_ERRORS } from '../../src/mcp/server/mcpTypes';

describe('Adversarial Security & Boundaries Verification (Challenger 2 Suite)', () => {
  const STATIC_SECRET = 'yeti_sec_token_empirical_challenger_9999_xyz';
  let clockTime: number;
  let activeRouters: RemoteMcpRouter[] = [];
  let activeLimiters: SlidingWindowRateLimiter[] = [];

  beforeEach(() => {
    clockTime = 10_000_000;
    activeRouters = [];
    activeLimiters = [];
  });

  afterEach(() => {
    for (const r of activeRouters) r.destroy();
    for (const l of activeLimiters) l.close();
  });

  interface AppFixtureOptions {
    authToken?: string;
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
    useCustomClock?: boolean;
    oidcClaims?: any;
    oidcError?: Error;
  }

  function buildHarness(opts: AppFixtureOptions = {}) {
    const authToken = opts.authToken ?? STATIC_SECRET;
    const oidcVerifier = {
      verify: vi.fn(async (token: string) => {
        if (opts.oidcError) {
          throw opts.oidcError;
        }
        if (token === 'valid-oidc-token-tenant-a') {
          return (
            opts.oidcClaims || {
              repository: 'calltelemetry/cisco-cdr',
              repository_id: '101',
              repository_owner_id: '42',
              run_id: '5001',
              run_attempt: '1',
              event_name: 'workflow_dispatch',
            }
          );
        }
        if (token === 'valid-oidc-token-tenant-b') {
          return {
            repository: 'external-org/payment-service',
            repository_id: '202',
            repository_owner_id: '88',
            run_id: '5002',
            run_attempt: '1',
            event_name: 'push',
          };
        }
        if (token === 'expired-oidc-token') {
          const err = new Error('jwt expired');
          err.name = 'TokenExpiredError';
          throw err;
        }
        throw new Error('Invalid OIDC signature');
      }),
    };

    const authenticator = new McpAuthenticator({
      staticAuthToken: authToken,
      oidcVerifier,
    });

    const rateLimiter = new SlidingWindowRateLimiter({
      windowMs: opts.rateLimitWindowMs ?? 60_000,
      maxRequests: opts.rateLimitMax ?? 60,
      now: opts.useCustomClock ? () => clockTime : Date.now,
      errorCode: MCP_ERRORS.RATE_LIMITED_ALT,
    });
    activeLimiters.push(rateLimiter);

    const router = createRemoteMcpRouter({
      authenticator,
      now: opts.useCustomClock ? () => clockTime : Date.now,
    });
    activeRouters.push(router);

    const appOptions: ActionDispatchAppOptions = {
      verifier: oidcVerifier as any,
      admission: { admit: vi.fn(async () => ({ status: 'accepted' } as any)) },
      resolveInstallationId: vi.fn(async () => 999),
      databaseReady: vi.fn(async () => true),
      allowAppGate: false,
      mcpConfig: {
        enabled: true,
        path: '/api/mcp',
        authToken,
        maxSessions: 100,
        sessionTtlMs: 1_800_000,
        rateLimitWindowMs: opts.rateLimitWindowMs ?? 60_000,
        rateLimitMax: opts.rateLimitMax ?? 60,
      },
      mcpRouter: router,
      mcpAuthenticator: authenticator,
      mcpRateLimiter: rateLimiter,
    };

    const app = createActionDispatchApp(appOptions);
    return { app, router, rateLimiter, authenticator, oidcVerifier, authToken };
  }

  // =========================================================================
  // TASK 1: AUTH BYPASS ATTEMPTS
  // =========================================================================
  describe('Challenge 1: Adversarial Authentication Bypass Attempts', () => {
    it('1.1 Empty Bearer token variants (missing token) are rejected with HTTP 401', async () => {
      const { app } = buildHarness();

      const emptyVariants = [
        'Bearer',
        'Bearer ',
        'Bearer   ',
        'Bearer \t',
      ];

      for (const headerVal of emptyVariants) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', headerVal)
          .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toContain('Bearer');
        expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
        expect(res.body.error.message).toMatch(/Unauthorized: Missing or invalid Bearer token/i);
      }
    });

    it('1.2 Malformed Bearer tokens (trailing words, bad schemes, quotes) are rejected with HTTP 401', async () => {
      const { app, authToken } = buildHarness();

      const malformedHeaders = [
        `Bearer ${authToken} trailing-garbage`,
        `Bearer "`,
        `Bearer ""`,
        `Bearer '`,
        `Basic dXNlcjpwYXNz`,
        `Token ${authToken}`,
        `bearer; ${authToken}`,
        `Bearer: ${authToken}`,
        `Bearer unknown-token-xyz`,
      ];

      for (const headerVal of malformedHeaders) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', headerVal)
          .send({ jsonrpc: '2.0', id: 2, method: 'ping' });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
      }
    });

    it('1.3 Expired OIDC token is rejected with HTTP 401 without stack trace disclosure', async () => {
      const { app } = buildHarness();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer expired-oidc-token')
        .send({ jsonrpc: '2.0', id: 3, method: 'ping' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
      expect(res.body.error.message).toBe('Unauthorized: Missing or invalid Bearer token');
      const responseStr = JSON.stringify(res.body);
      expect(responseStr).not.toContain('TokenExpiredError');
      expect(responseStr).not.toContain('jwt expired');
      expect(responseStr).not.toContain('stack');
    });

    it('1.4 Substring, prefix, suffix, and single-char mutations of static token fail timingSafeTokenMatch', () => {
      const secret = 'super_secure_cluster_static_token_2026';

      // Prefixes
      expect(timingSafeTokenMatch('super_secure', secret)).toBe(false);
      expect(timingSafeTokenMatch(secret.slice(0, 10), secret)).toBe(false);
      expect(timingSafeTokenMatch(secret.slice(0, secret.length - 1), secret)).toBe(false);

      // Suffixes
      expect(timingSafeTokenMatch('token_2026', secret)).toBe(false);
      expect(timingSafeTokenMatch(secret.slice(1), secret)).toBe(false);

      // Substrings
      expect(timingSafeTokenMatch('cluster_static', secret)).toBe(false);

      // Extensions
      expect(timingSafeTokenMatch(`${secret}_extra`, secret)).toBe(false);

      // Single character mutation (Hamming distance 1)
      const mutated = secret.slice(0, -1) + (secret.endsWith('6') ? '7' : '0');
      expect(timingSafeTokenMatch(mutated, secret)).toBe(false);

      // Empty / undefined inputs
      expect(timingSafeTokenMatch('', secret)).toBe(false);
      expect(timingSafeTokenMatch(secret, '')).toBe(false);
      expect(timingSafeTokenMatch('', '')).toBe(false);

      // Exact match
      expect(timingSafeTokenMatch(secret, secret)).toBe(true);
    });

    it('1.5 Substring tokens in HTTP requests are rejected with HTTP 401', async () => {
      const { app, authToken } = buildHarness();

      const substringTokens = [
        authToken.slice(0, 15),
        authToken.slice(5),
        authToken.slice(10, 25),
        `${authToken}x`,
        `x${authToken}`,
      ];

      for (const subToken of substringTokens) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${subToken}`)
          .send({ jsonrpc: '2.0', id: 4, method: 'ping' });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
      }
    });

    it('1.6 Query parameter authentication is forbidden on POST /api/mcp', async () => {
      const { app, authToken } = buildHarness();

      // POST /api/mcp?token=... must NOT accept query param auth
      const res = await request(app)
        .post(`/api/mcp?token=${authToken}`)
        .send({ jsonrpc: '2.0', id: 5, method: 'ping' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
    });

    it('1.7 GET /api/mcp/sse with empty or whitespace query token is rejected with HTTP 401', async () => {
      const { app } = buildHarness();

      const emptyQueries = ['?token=', '?token=%20%20', '?access_token='];
      for (const q of emptyQueries) {
        const res = await request(app).get(`/api/mcp/sse${q}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
      }
    });
  });

  // =========================================================================
  // TASK 2: RBAC BYPASS ATTEMPTS
  // =========================================================================
  describe('Challenge 2: Adversarial RBAC & Tenancy Bypass Attempts', () => {
    it('2.1 Path traversal in repository coordinates throws McpRbacError and rejects regex', () => {
      const caller: any = {
        authType: 'oidc',
        tokenDigest: 'caller123456',
        isAdmin: false,
        allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
        callerId: 'oidc:calltelemetry/cisco-cdr:1',
      };

      const traversalAttempts = [
        { owner: 'calltelemetry', repo: '../../cisco-cdr' },
        { owner: 'calltelemetry', repo: '../cisco-cdr' },
        { owner: '../../root', repo: 'cisco-cdr' },
        { owner: 'calltelemetry', repo: 'cisco-cdr/submodule' },
        { owner: 'calltelemetry/nested', repo: 'cisco-cdr' },
        { owner: 'calltelemetry', repo: 'cisco-cdr\0nullbyte' },
        { owner: 'calltelemetry\\backslash', repo: 'cisco-cdr' },
        { owner: 'calltelemetry%2e%2e', repo: 'cisco-cdr' },
      ];

      for (const { owner, repo } of traversalAttempts) {
        expect(() => verifyRepositoryAccess(caller, owner, repo)).toThrowError(McpRbacError);
      }
    });

    it('2.2 Path traversal via HTTP tool call returns HTTP 403 sanitized error', async () => {
      const { app } = buildHarness();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token-tenant-a')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'calltelemetry', repo: '../../other-repo', pull_number: 1 },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).toMatch(/Forbidden: Access to repository calltelemetry\/\.\.\/\.\.\/other-repo denied/i);
      expect(JSON.stringify(res.body)).not.toContain('stack');
    });

    it('2.3 Cross-tenant query attempt: Tenant A cannot access Tenant B or internal repositories', async () => {
      const { app } = buildHarness();

      // Tenant A is scoped to 'calltelemetry/cisco-cdr'
      const crossTenantQueries = [
        { owner: 'external-org', repo: 'payment-service' },
        { owner: 'calltelemetry', repo: 'ct-infrastructure' },
        { owner: 'calltelemetry', repo: 'secret-ops' },
        { owner: 'cisco-cdr', repo: 'calltelemetry' }, // Inverted coordinates
      ];

      for (const { owner, repo } of crossTenantQueries) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-oidc-token-tenant-a')
          .send({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {
              name: 'get_review_status',
              arguments: { owner, repo, pull_number: 42 },
            },
          });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
        expect(res.body.error.message).toContain(`Access to repository ${owner}/${repo} denied`);
      }
    });

    it('2.4 Direct verifyRepositoryAccess check fails closed on empty owner or repo', () => {
      const caller: any = {
        authType: 'oidc',
        tokenDigest: 'caller123456',
        isAdmin: false,
        allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
        callerId: 'oidc:test:1',
      };

      expect(() => verifyRepositoryAccess(caller, '', 'cisco-cdr')).toThrowError(McpRbacError);
      expect(() => verifyRepositoryAccess(caller, 'calltelemetry', '')).toThrowError(McpRbacError);
      expect(() => verifyRepositoryAccess(caller, '', '')).toThrowError(McpRbacError);
      expect(() => verifyRepositoryAccess(caller, '   ', 'cisco-cdr')).toThrowError(McpRbacError);
    });

    it('2.5 Dot-dot alone fails allowed repositories check if regex permits it', () => {
      const caller: any = {
        authType: 'oidc',
        tokenDigest: 'caller123456',
        isAdmin: false,
        allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
        callerId: 'oidc:test:1',
      };

      // ".." matches [A-Za-z0-9_.-]+, but targetRepo is "../.." which is NOT in allowedRepositories
      expect(() => verifyRepositoryAccess(caller, '..', '..')).toThrowError(McpRbacError);
    });

    it('2.6 Empty owner parameter behavior: router level vs direct RBAC check', async () => {
      const { app } = buildHarness();

      // Tenant A is only authorized for 'calltelemetry/cisco-cdr'
      // If valid owner and unauthorized repo is given, RBAC blocks with 403:
      const blockedRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token-tenant-a')
        .send({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'unauthorized-org', repo: 'cisco-cdr', pull_number: 1 },
          },
        });
      expect(blockedRes.status).toBe(403);

      // When owner is empty string "", router condition `if (owner && repo)` evaluates to false:
      const emptyOwnerRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token-tenant-a')
        .send({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: '', repo: 'cisco-cdr', pull_number: 1 },
          },
        });

      // Documents router boundary behavior: in M1 mock, tool execution proceeds because owner is falsy
      expect(emptyOwnerRes.status).toBe(200);
    });
  });

  // =========================================================================
  // TASK 3: OVERSIZED PAYLOAD INJECTION
  // =========================================================================
  describe('Challenge 3: Adversarial Oversized Payload Injection', () => {
    it('3.1 Standard JSON-RPC payload > 64KB (e.g. 66KB) returns HTTP 413', async () => {
      const { app, authToken } = buildHarness();

      const oversizedBody = {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'get_review_status',
          arguments: {
            owner: 'calltelemetry',
            repo: 'cisco-cdr',
            pull_number: 1,
            extra: 'X'.repeat(66 * 1024), // 66KB of padding
          },
        },
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(oversizedBody);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
    });

    it('3.2 Standard ping or tools/list > 64KB returns HTTP 413', async () => {
      const { app, authToken } = buildHarness();

      const paddedPing = {
        jsonrpc: '2.0',
        id: 31,
        method: 'ping',
        blob: 'Z'.repeat(65 * 1024),
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(paddedPing);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
    });

    it('3.3 Preflight Diff Review payload <= 512KB is accepted (250KB diff)', async () => {
      const { app, authToken } = buildHarness();

      const validDiffBody = {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'preflight_diff_review',
          arguments: {
            repo: 'calltelemetry/cisco-cdr',
            diff: 'diff --git a/app.ts b/app.ts\n' + '+'.repeat(250 * 1024),
          },
        },
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(validDiffBody);

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it('3.4 Preflight Diff Review payload > 512KB (e.g. 540KB) returns HTTP 413', async () => {
      const { app, authToken } = buildHarness();

      const oversizedDiffBody = {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'preflight_diff_review',
          arguments: {
            repo: 'calltelemetry/cisco-cdr',
            diff: '+'.repeat(540 * 1024), // > 512KB
          },
        },
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(oversizedDiffBody);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
    });

    it('3.5 Spoofing attack: oversized non-diff tool claiming diff parameters is rejected with 413', async () => {
      const { app, authToken } = buildHarness();

      // Attacker tries to bypass 64KB limit on get_review_status by stuffing diff args
      const spoofedBody = {
        jsonrpc: '2.0',
        id: 34,
        method: 'tools/call',
        params: {
          name: 'get_review_status', // NOT preflight_diff_review
          arguments: {
            owner: 'calltelemetry',
            repo: 'cisco-cdr',
            pull_number: 1,
            diff: 'fake diff ' + 'F'.repeat(70 * 1024),
          },
        },
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(spoofedBody);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
    });
  });

  // =========================================================================
  // TASK 4: RATE LIMIT BURSTING
  // =========================================================================
  describe('Challenge 4: Rate Limit Bursting (>60 requests in <10s)', () => {
    it('4.1 Bursts 65 requests in rapid succession (<10s), verifying 429 throttling and Retry-After', async () => {
      const { app, authToken } = buildHarness({
        rateLimitMax: 60,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      // Rapidly burst 60 requests in 1 second (15ms per request)
      for (let i = 0; i < 60; i++) {
        clockTime += 15; // simulates < 1 second total elapsed time
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: i, method: 'ping' });

        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('60');
        expect(res.headers['x-ratelimit-remaining']).toBe(String(59 - i));
      }

      // Request 61 to 65 must receive HTTP 429 within the same <10s window
      for (let j = 60; j < 65; j++) {
        clockTime += 50; // total elapsed time still ~1.2s (<10s)
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: j, method: 'ping' });

        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
        const retryAfter = Number(res.headers['retry-after']);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);

        expect(res.headers['x-ratelimit-remaining']).toBe('0');
        expect(res.headers['x-ratelimit-limit']).toBe('60');
        expect(res.headers['x-ratelimit-reset']).toBeDefined();

        expect(res.body.jsonrpc).toBe('2.0');
        expect(res.body.error.code).toBe(MCP_ERRORS.RATE_LIMITED_ALT);
        expect(res.body.error.message).toMatch(/Too many requests.*Rate limit exceeded/i);
      }
    });

    it('4.2 Rate limiter recovers immediately after sliding window expires', async () => {
      const { app, authToken } = buildHarness({
        rateLimitMax: 60,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      // Saturate bucket
      for (let i = 0; i < 60; i++) {
        clockTime += 10;
        await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: i, method: 'ping' });
      }

      // Verify throttled
      const throttled = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 61, method: 'ping' });
      expect(throttled.status).toBe(429);

      // Advance clock past 60s window
      clockTime += 60_005;

      // New request succeeds
      const recovered = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 62, method: 'ping' });
      expect(recovered.status).toBe(200);
      expect(recovered.headers['x-ratelimit-remaining']).toBe('59');
    });

    it('4.3 Rate limit isolation: Bursting caller does not throttle other authenticated callers', async () => {
      const { app, authToken } = buildHarness({
        rateLimitMax: 60,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      // Caller 1 (Static token) bursts 60 requests in <10s
      for (let i = 0; i < 60; i++) {
        clockTime += 20;
        await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: i, method: 'ping' });
      }

      // Caller 1 gets 429
      const caller1Throttled = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 61, method: 'ping' });
      expect(caller1Throttled.status).toBe(429);

      // Caller 2 (OIDC token) arrives during the burst: must NOT be throttled
      const caller2Success = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token-tenant-a')
        .send({ jsonrpc: '2.0', id: 62, method: 'ping' });
      expect(caller2Success.status).toBe(200);
      expect(caller2Success.headers['x-ratelimit-remaining']).toBe('59');
    });

    it('4.4 Health and Ready probes are immune to MCP rate limit burst saturation', async () => {
      const { app, authToken } = buildHarness({
        rateLimitMax: 10,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      // Saturate rate limiter
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: i, method: 'ping' });
      }

      // MCP is saturated
      const mcp429 = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 11, method: 'ping' });
      expect(mcp429.status).toBe(429);

      // /health returns 200 without being rate-limited
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
      expect(health.body.status).toBe('ok');

      // /ready returns 200 without being rate-limited
      const ready = await request(app).get('/ready');
      expect(ready.status).toBe(200);
      expect(ready.body.status).toBe('ready');
    });
  });
});
