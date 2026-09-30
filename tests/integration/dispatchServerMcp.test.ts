import express from 'express';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createActionDispatchApp, type ActionDispatchAppOptions } from '../../src/dispatchServer';
import { McpAuthenticator } from '../../src/mcp/server/mcpAuthenticator';
import { SlidingWindowRateLimiter } from '../../src/mcp/server/mcpRateLimiter';
import { createRemoteMcpRouter, type RemoteMcpRouter } from '../../src/mcp/server/remoteMcpRouter';
import { MCP_ERRORS } from '../../src/mcp/server/mcpTypes';
import type { GitHubWebhookAdmissionEvent } from '../../src/review/githubWebhookAdmission';

describe('Action Dispatch Server MCP Integration (tests/integration/dispatchServerMcp.test.ts)', () => {
  const TEST_STATIC_AUTH_TOKEN = 'yeti_integration_test_token_secret_777';
  const TEST_WEBHOOK_SECRET = 'webhook-stack-test-secret-at-least-32-bytes';
  let clockTime: number;
  let activeRouters: RemoteMcpRouter[] = [];
  let activeLimiters: SlidingWindowRateLimiter[] = [];

  beforeEach(() => {
    clockTime = 1_000_000;
    activeRouters = [];
    activeLimiters = [];
  });

  afterEach(() => {
    for (const r of activeRouters) r.destroy();
    for (const l of activeLimiters) l.close();
  });

  interface BuildAppOptions {
    mcpEnabled?: boolean;
    mcpPath?: string;
    authToken?: string;
    databaseReady?: boolean;
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
    oidcClaims?: any;
    useCustomClock?: boolean;
    webhookEnabled?: boolean;
  }

  function buildApp(opts: BuildAppOptions = {}) {
    const mcpEnabled = opts.mcpEnabled ?? true;
    const mcpPath = opts.mcpPath || '/api/mcp';
    const authToken = opts.authToken ?? TEST_STATIC_AUTH_TOKEN;
    const isDbReady = opts.databaseReady ?? true;

    const verifier = {
      verify: vi.fn(async (token: string) => {
        if (token === 'valid-oidc-token') {
          return (
            opts.oidcClaims || {
              repository: 'calltelemetry/cisco-cdr',
              repository_id: '123',
              repository_owner_id: '99',
              run_id: '98765',
              run_attempt: '1',
              event_name: 'workflow_dispatch',
            }
          );
        }
        throw new Error('Invalid OIDC signature or claims');
      }),
    };

    const authenticator = new McpAuthenticator({
      staticAuthToken: authToken,
      oidcVerifier: verifier,
    });
    const webhookOnEvent = vi.fn(async (_event: GitHubWebhookAdmissionEvent) => ({ status: 'accepted' }));

    const rateLimiter = new SlidingWindowRateLimiter({
      windowMs: opts.rateLimitWindowMs ?? 60_000,
      maxRequests: opts.rateLimitMax ?? 60,
      now: opts.useCustomClock ? () => clockTime : Date.now,
      errorCode: MCP_ERRORS.RATE_LIMITED_ALT,
    });
    activeLimiters.push(rateLimiter);

    const mockDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('review_runs')) {
          return {
            rows: [
              {
                run_id: 'run_integration_test',
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                pr_number: 42,
                head_sha: 'a'.repeat(40),
                run_status: 'succeeded',
                run_stage: 'publish',
                attempt: 1,
                check_id: '9988',
                desired_state: 'success',
                decision: JSON.stringify({ verdict: 'SHIP' }),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    const router = createRemoteMcpRouter({
      authenticator,
      db: mockDb,
      now: opts.useCustomClock ? () => clockTime : Date.now,
    });
    activeRouters.push(router);

    const appOptions: ActionDispatchAppOptions = {
      verifier: verifier as any,
      admission: { admit: vi.fn(async () => ({ status: 'accepted' } as any)) },
      resolveInstallationId: vi.fn(async () => 123),
      databaseReady: vi.fn(async () => isDbReady),
      allowAppGate: false,
      mcpConfig: {
        enabled: mcpEnabled,
        path: mcpPath,
        authToken,
        maxSessions: 100,
        sessionTtlMs: 1_800_000,
        rateLimitWindowMs: opts.rateLimitWindowMs ?? 60_000,
        rateLimitMax: opts.rateLimitMax ?? 60,
        rateLimit: {
          windowMs: opts.rateLimitWindowMs ?? 60_000,
          max: opts.rateLimitMax ?? 60,
        },
      },
      mcpRouter: router,
      mcpAuthenticator: authenticator,
      mcpRateLimiter: rateLimiter,
      ...(opts.webhookEnabled ? {
        githubWebhook: { secret: TEST_WEBHOOK_SECRET, onEvent: webhookOnEvent },
      } : {}),
    };

    const app = createActionDispatchApp(appOptions);
    return { app, router, rateLimiter, verifier, authToken, authenticator, webhookOnEvent };
  }

  describe('Suite 1: Feature Flag Toggling & Route Seams', () => {
    it('Test 1.1: Disabled by default returns 404 for MCP routes but 200 for health', async () => {
      const { app } = buildApp({ mcpEnabled: false });

      const mcpPost = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_STATIC_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(mcpPost.status).toBe(404);

      const sseGet = await request(app)
        .get('/api/mcp/sse')
        .set('Authorization', `Bearer ${TEST_STATIC_AUTH_TOKEN}`);
      expect(sseGet.status).toBe(404);

      const msgPost = await request(app)
        .post('/api/mcp/messages')
        .set('Authorization', `Bearer ${TEST_STATIC_AUTH_TOKEN}`)
        .send({});
      expect(msgPost.status).toBe(404);

      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
      expect(health.body.service).toBe('review-yeti-action-dispatch');
    });

    it('Test 1.2: Enabled mounts router and auth interceptor', async () => {
      const { app } = buildApp({ mcpEnabled: true });

      const unauth = await request(app).post('/api/mcp').send({});
      expect(unauth.status).toBe(401);
      expect(unauth.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
    });

    it('Test 1.3: Custom path mounting', async () => {
      const { app } = buildApp({ mcpEnabled: true, mcpPath: '/custom/mcp/v1' });

      const custom = await request(app).post('/custom/mcp/v1').send({});
      expect(custom.status).toBe(401);

      const defaultPath = await request(app).post('/api/mcp').send({});
      expect(defaultPath.status).toBe(404);
    });
  });

  describe('Suite 2: Authentication Enforcement', () => {
    it('Test 2.1: Missing Authorization header returns 401 with JSON-RPC error -32001', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer');
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        error: {
          code: MCP_ERRORS.UNAUTHORIZED,
          message: 'Unauthorized: Missing or invalid Bearer token',
        },
        id: null,
      });
    });

    it('Test 2.2: Invalid Bearer token returns 401', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer invalid-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
    });

    it('Test 2.3: Valid Static Bearer Token returns 200 OK', async () => {
      const { app, authToken } = buildApp();
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 10, method: 'ping' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ jsonrpc: '2.0', id: 10, result: {} });
    });

    it('Test 2.4: Valid GitHub Actions OIDC Token returns 200 OK', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token')
        .send({ jsonrpc: '2.0', id: 11, method: 'ping' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ jsonrpc: '2.0', id: 11, result: {} });
    });
  });

  describe('Suite 3: Repository RBAC & Sanitized Rejection', () => {
    it('Test 3.1: OIDC caller targeting own repository succeeds', async () => {
      const { app } = buildApp({
        oidcClaims: {
          repository: 'calltelemetry/cisco-cdr',
          repository_id: '123',
          repository_owner_id: '99',
          run_id: '1',
          run_attempt: '1',
          event_name: 'workflow_dispatch',
        },
      });

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token')
        .send({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'calltelemetry', repo: 'cisco-cdr', pull_number: 42 },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it('Test 3.2: OIDC caller targeting foreign repository returns HTTP 403 sanitized error', async () => {
      const { app } = buildApp({
        oidcClaims: {
          repository: 'calltelemetry/cisco-cdr',
          repository_id: '123',
          repository_owner_id: '99',
          run_id: '1',
          run_attempt: '1',
          event_name: 'workflow_dispatch',
        },
      });

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token')
        .send({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'calltelemetry', repo: 'secret-service', pull_number: 1 },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        error: {
          code: MCP_ERRORS.FORBIDDEN,
          message: 'Forbidden: Access to repository calltelemetry/secret-service denied',
        },
        id: null,
      });
      // Guarantees sanitization:
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('stack');
      expect(bodyStr).not.toContain('database');
    });

    it('Test 3.3: Admin Static Token targeting any repository succeeds', async () => {
      const { app, authToken } = buildApp();

      const res1 = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          jsonrpc: '2.0',
          id: 22,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'external-corp', repo: 'external-repo', pull_number: 1 },
          },
        });
      expect(res1.status).toBe(200);
    });
  });

  describe('Suite 4: Request Payload Bounds & Malformed Data', () => {
    it('Test 4.1: Standard JSON-RPC call <= 64KB succeeds', async () => {
      const { app, authToken } = buildApp();
      const payload32k = {
        jsonrpc: '2.0',
        id: 30,
        method: 'ping',
        padding: 'a'.repeat(30_000), // ~30KB
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload32k);

      expect(res.status).toBe(200);
    });

    it('Test 4.2: Standard JSON-RPC call > 64KB rejected with HTTP 413', async () => {
      const { app, authToken } = buildApp();
      const oversizedPayload = {
        jsonrpc: '2.0',
        id: 31,
        method: 'ping',
        padding: 'b'.repeat(66_000), // > 64KB
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(oversizedPayload);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
    });

    it('Test 4.3: Preflight Diff Review payload <= 512KB succeeds', async () => {
      const { app, authToken } = buildApp();
      const diffPayload = {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'preflight_diff_review',
          arguments: {
            repo: 'cisco-cdr',
            diff: 'diff --git a/file.ts b/file.ts\n' + 'c'.repeat(200_000), // ~200KB
          },
        },
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(diffPayload);

      expect(res.status).toBe(200);
    });

    it('Test 4.4: Preflight Diff Review payload > 512KB rejected with HTTP 413', async () => {
      const { app, authToken } = buildApp();
      const oversizedDiff = {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'preflight_diff_review',
          arguments: {
            repo: 'cisco-cdr',
            diff: 'd'.repeat(530_000), // > 512KB
          },
        },
      };

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(oversizedDiff);

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
    });

    it('Test 4.5: Malformed JSON syntax handled with HTTP 400', async () => {
      const { app, authToken } = buildApp();
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Content-Type', 'application/json')
        .send('{"jsonrpc": "2.0", broken');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid JSON body' });
    });
  });

  describe('REL-1198: composed webhook/MCP parser isolation', () => {
    const diffHeader = 'diff --git a/src/example.ts b/src/example.ts\n'
      + '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+// ';

    function preflightPayload(diffBytes = 134_073) {
      return {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'preflight_diff_review',
          arguments: {
            owner: 'calltelemetry', repo: 'ct-uat', target_branch: 'main',
            diff: diffHeader + 'x'.repeat(diffBytes - Buffer.byteLength(diffHeader)),
          },
        },
      };
    }

    function sizedPreflight(bytes: number) {
      const payload = preflightPayload(Buffer.byteLength(diffHeader));
      payload.params.arguments.diff += 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(payload)));
      const raw = JSON.stringify(payload);
      expect(Buffer.byteLength(raw)).toBe(bytes);
      return raw;
    }

    function sizedWebhook(bytes: number) {
      const prefix = JSON.stringify({ action: 'opened', preserve: 'raw whitespace' }, null, 2);
      return prefix + ' '.repeat(bytes - Buffer.byteLength(prefix));
    }

    it.each([false, true])('passes the complete 134073-byte diff through the real tool (chunked=%s)', async (chunked) => {
      const f = buildApp({ webhookEnabled: true });
      const tool = f.router.toolRegistry.getTool('preflight_diff_review')!;
      const execute = vi.spyOn(tool, 'execute');
      const payload = preflightPayload();
      const raw = JSON.stringify(payload);
      expect(Buffer.byteLength(payload.params.arguments.diff)).toBe(134_073);
      expect(Buffer.byteLength(raw)).toBeGreaterThan(100 * 1024);
      expect(Buffer.byteLength(raw)).toBeLessThan(512 * 1024);
      const pending = request(f.app).post('/api/mcp')
        .set('Authorization', `Bearer ${f.authToken}`)
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json,text/event-stream');
      if (chunked) {
        pending.write(raw.slice(0, 60_000));
        pending.write(raw.slice(60_000));
      } else {
        pending.send(raw);
      }
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledExactlyOnceWith(payload.params.arguments, expect.objectContaining({
        authenticatedByConfiguredAuthenticator: true,
        authorizedRepository: { owner: 'calltelemetry', repo: 'ct-uat' },
      }));
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });

    it.each([512 * 1024, 512 * 1024 + 1])('retains the preflight wire limit at %i bytes with webhook enabled', async (bytes) => {
      const f = buildApp({ webhookEnabled: true });
      const execute = vi.spyOn(f.router.toolRegistry.getTool('preflight_diff_review')!, 'execute');
      const authenticate = vi.spyOn(f.authenticator, 'authenticate');
      const raw = sizedPreflight(bytes);
      const res = await request(f.app).post('/api/mcp')
        .set('Authorization', `Bearer ${f.authToken}`)
        .set('Content-Type', 'application/json').send(raw);
      expect(res.status).toBe(bytes === 512 * 1024 ? 200 : 413);
      if (bytes === 512 * 1024) {
        expect(res.body.error).toBeUndefined();
        expect(execute).toHaveBeenCalledExactlyOnceWith(JSON.parse(raw).params.arguments, expect.objectContaining({
          authenticatedByConfiguredAuthenticator: true,
          authorizedRepository: { owner: 'calltelemetry', repo: 'ct-uat' },
        }));
      } else {
        expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
        expect(authenticate).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      }
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });

    it.each([undefined, 'invalid-mcp-token'])('refuses a large preflight without valid authentication (%s)', async (token) => {
      const f = buildApp({ webhookEnabled: true });
      const execute = vi.spyOn(f.router.toolRegistry.getTool('preflight_diff_review')!, 'execute');
      const pending = request(f.app).post('/api/mcp');
      if (token) pending.set('Authorization', `Bearer ${token}`);
      const res = await pending.send(preflightPayload());
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
      expect(execute).not.toHaveBeenCalled();
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });

    it.each([64 * 1024, 64 * 1024 + 1])('retains the standard MCP limit at %i bytes with webhook enabled', async (bytes) => {
      const f = buildApp({ webhookEnabled: true });
      const authenticate = vi.spyOn(f.authenticator, 'authenticate');
      const payload = { jsonrpc: '2.0', id: 1, method: 'ping', padding: '' };
      payload.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(payload)));
      const raw = JSON.stringify(payload);
      expect(Buffer.byteLength(raw)).toBe(bytes);
      const res = await request(f.app).post('/api/mcp')
        .set('Authorization', `Bearer ${f.authToken}`)
        .set('Content-Type', 'application/json').send(raw);
      expect(res.status).toBe(bytes === 64 * 1024 ? 200 : 413);
      if (bytes > 64 * 1024) {
        expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
        expect(authenticate).not.toHaveBeenCalled();
      }
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });

    it('does not let the webhook parser consume an unrelated body before the generic 64KiB limit', async () => {
      const f = buildApp({ webhookEnabled: true });
      const res = await request(f.app).post('/not-a-webhook')
        .send({ padding: 'x'.repeat(66_000) });
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });

    it.each(['/api/webhooks/github', '/api/webhook/github', '/webhook', '/API/WEBHOOKS/GITHUB/'])
    ('retains exact raw HMAC bytes and the 100KiB webhook bound on %s', async (path) => {
      const f = buildApp({ webhookEnabled: true });
      const raw = sizedWebhook(100 * 1024);
      const signature = `sha256=${createHmac('sha256', TEST_WEBHOOK_SECRET).update(raw).digest('hex')}`;
      const res = await request(f.app).post(path)
        .set('Content-Type', 'application/json').set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', signature).send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'accepted' });
      expect(f.webhookOnEvent).toHaveBeenCalledTimes(1);
      const webhookEvent = f.webhookOnEvent.mock.calls[0][0];
      expect(webhookEvent.rawBody.equals(Buffer.from(raw))).toBe(true);
      expect(webhookEvent.body).toEqual(JSON.parse(raw));
    });

    it.each(['/api/webhooks/github', '/api/webhook/github', '/webhook'])
    ('still rejects a webhook above 100KiB on %s', async (path) => {
      const f = buildApp({ webhookEnabled: true });
      const raw = sizedWebhook(100 * 1024 + 1);
      const res = await request(f.app).post(path)
        .set('Content-Type', 'application/json').set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', TEST_WEBHOOK_SECRET).update(raw).digest('hex')}`)
        .send(raw);
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body exceeds its permitted size' });
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });

    it('refuses a webhook signature over normalized JSON rather than the actual raw bytes', async () => {
      const f = buildApp({ webhookEnabled: true });
      const raw = sizedWebhook(100 * 1024);
      const signature = `sha256=${createHmac('sha256', TEST_WEBHOOK_SECRET)
        .update(JSON.stringify(JSON.parse(raw))).digest('hex')}`;
      const res = await request(f.app).post('/api/webhooks/github')
        .set('Content-Type', 'application/json').set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', signature).send(raw);
      expect(res.status).toBe(401);
      expect(f.webhookOnEvent).not.toHaveBeenCalled();
    });
  });

  describe('Suite 5: Sliding Window Rate Limiting (60 req/min)', () => {
    it('Test 5.1 & 5.2: Permits 60 requests in window and rejects 61st with HTTP 429', async () => {
      const { app, authToken } = buildApp({
        rateLimitMax: 60,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      for (let i = 0; i < 60; i++) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: i, method: 'ping' });
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('60');
        expect(res.headers['x-ratelimit-remaining']).toBe(String(59 - i));
      }

      // 61st request in the same window
      const rejected = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 61, method: 'ping' });

      expect(rejected.status).toBe(429);
      expect(rejected.headers['retry-after']).toBeDefined();
      expect(rejected.body.error.code).toBe(MCP_ERRORS.RATE_LIMITED_ALT);
    });

    it('Test 5.3: Sliding window reset permits subsequent requests', async () => {
      const { app, authToken } = buildApp({
        rateLimitMax: 60,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      for (let i = 0; i < 60; i++) {
        await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ jsonrpc: '2.0', id: i, method: 'ping' });
      }

      // Advance clock past 60 seconds
      clockTime += 60_001;

      const replenished = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 62, method: 'ping' });

      expect(replenished.status).toBe(200);
      expect(replenished.headers['x-ratelimit-remaining']).toBe('59');
    });

    it('Test 5.4: Separate callers have independent rate limit buckets', async () => {
      const { app, authToken } = buildApp({
        rateLimitMax: 2,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      // Caller 1 (static token) exhausts quota
      await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' });

      const caller1Exhausted = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 3, method: 'ping' });
      expect(caller1Exhausted.status).toBe(429);

      // Caller 2 (OIDC token) has separate bucket
      const caller2Success = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-oidc-token')
        .send({ jsonrpc: '2.0', id: 4, method: 'ping' });
      expect(caller2Success.status).toBe(200);
    });

    it('Test 5.5: Health endpoint exemption during rate limit saturation', async () => {
      const { app, authToken } = buildApp({
        rateLimitMax: 1,
        rateLimitWindowMs: 60_000,
        useCustomClock: true,
      });

      await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      // Saturate MCP
      const mcpBlocked = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      expect(mcpBlocked.status).toBe(429);

      // /health must still succeed with 200
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
    });
  });

  describe('Suite 6: Transport Protocols', () => {
    it('Test 6.1: Streamable HTTP initialize returns protocol version 2024-11-05 and Mcp-Session-Id', async () => {
      const { app, authToken } = buildApp();
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        });

      expect(res.status).toBe(200);
      expect(res.body.result.protocolVersion).toBe('2024-11-05');
      expect(res.headers['mcp-session-id']).toBeDefined();
    });

    it('Test 6.2: SSE Channel Initiation GET /api/mcp/sse', async () => {
      const { app, router, authToken } = buildApp();

      await new Promise<void>((resolve, reject) => {
        let endpointData = '';
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', `Bearer ${authToken}`)
          .buffer(false)
          .parse((res: any) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            res.on('data', (chunk: any) => {
              endpointData += chunk.toString();
              const match = /sessionId=([0-9a-f-]{36})/.exec(endpointData);
              if (match) {
                expect(endpointData).toContain('event: endpoint');
                router.sessionManager.closeSession(match[1]);
                resolve();
              }
            });
            res.on('error', reject);
          });
        sseReq.on('error', () => {});
        sseReq.end();
      });
    });

    it('Test 6.3: SSE Inbound Gateway POST /api/mcp/messages returns 202 Accepted', async () => {
      const { app, router, authToken } = buildApp();

      let activeSessionId = '';
      await new Promise<void>((resolve, reject) => {
        let endpointData = '';
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', `Bearer ${authToken}`)
          .buffer(false)
          .parse((res: any) => {
            res.on('data', (chunk: any) => {
              endpointData += chunk.toString();
              const match = /sessionId=([0-9a-f-]{36})/.exec(endpointData);
              if (match) {
                activeSessionId = match[1];
                resolve();
              }
            });
            res.on('error', reject);
          });
        sseReq.on('error', () => {});
        sseReq.end();
      });

      const res = await request(app)
        .post(`/api/mcp/messages?sessionId=${activeSessionId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 40, method: 'ping' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'accepted' });
      router.sessionManager.closeSession(activeSessionId);
    });

    it('Test 6.4: Unknown Session ID on POST /api/mcp/messages returns 404', async () => {
      const { app, authToken } = buildApp();
      const res = await request(app)
        .post('/api/mcp/messages?sessionId=00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ jsonrpc: '2.0', id: 41, method: 'ping' });

      expect(res.status).toBe(404);
    });
  });

  describe('Suite 7: Non-Interference with Existing Action Dispatch Routes', () => {
    it('Test 7.1: /health remains public and unaffected', async () => {
      const { app } = buildApp();
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
      expect(health.body.status).toBe('ok');
      expect(health.body.service).toBe('review-yeti-action-dispatch');
    });

    it('Test 7.2: /ready reflects database health', async () => {
      const readyApp = buildApp({ databaseReady: true }).app;
      expect((await request(readyApp).get('/ready')).status).toBe(200);

      const notReadyApp = buildApp({ databaseReady: false }).app;
      const notReady = await request(notReadyApp).get('/ready');
      expect(notReady.status).toBe(503);
      expect(notReady.body.status).toBe('not_ready');
    });

    it('Test 7.3: /api/dispatch/action retains existing OIDC admission', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/dispatch/action').send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/GitHub Actions OIDC bearer token is required/i);
    });
  });
});
