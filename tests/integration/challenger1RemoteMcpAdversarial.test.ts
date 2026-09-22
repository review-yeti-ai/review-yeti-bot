import express, { type Request } from 'express';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
  type McpToolRegistry,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import {
  JSONRPC_ERRORS,
  MCP_ERRORS,
  buildToolResultJson,
} from '../../src/mcp/server/mcpTypes';
import { createActionDispatchApp, type ActionDispatchAppOptions } from '../../src/dispatchServer';
import { SlidingWindowRateLimiter } from '../../src/mcp/server/mcpRateLimiter';

describe('Adversarial Session & Transport Verification (Challenger 1 — Milestone 1)', () => {
  const TEST_AUTH_TOKEN = 'challenger_adversarial_token_secret_999';
  let currentTime: number;
  let uuidCounter: number;
  let activeRouters: RemoteMcpRouter[] = [];
  let activeServers: http.Server[] = [];

  beforeEach(() => {
    currentTime = 1_000_000;
    uuidCounter = 1;
    activeRouters = [];
    activeServers = [];
  });

  afterEach(async () => {
    for (const r of activeRouters) {
      r.destroy();
    }
    for (const s of activeServers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  function buildAdversarialApp(customOptions?: Partial<RemoteMcpRouterOptions> & { toolDelayMs?: number }) {
    const authenticator: McpAuthenticator = {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === `Bearer ${TEST_AUTH_TOKEN}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'adv-token-digest',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'challenger-agent',
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === TEST_AUTH_TOKEN) {
          return {
            authType: 'static_token',
            tokenDigest: 'adv-token-digest',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'challenger-agent',
          };
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      checkRepositoryAccess: vi.fn(() => true),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;

    const toolRegistry: McpToolRegistry = {
      listTools: vi.fn(() => [
        {
          name: 'get_review_status',
          description: 'Query review run status',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'slow_running_tool',
          description: 'Tool simulating long-running operation',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'failing_tool',
          description: 'Tool simulating unexpected exception',
          inputSchema: { type: 'object' as const },
        },
      ]),
      getTool: vi.fn((name: string) => {
        if (name === 'slow_running_tool') {
          return {
            definition: { name: 'slow_running_tool', inputSchema: { type: 'object' as const } },
            execute: vi.fn(async () => {
              const delay = customOptions?.toolDelayMs ?? 100;
              await new Promise((resolve) => setTimeout(resolve, delay));
              return buildToolResultJson({ status: 'completed_slow_op' });
            }),
          };
        }
        if (name === 'failing_tool') {
          return {
            definition: { name: 'failing_tool', inputSchema: { type: 'object' as const } },
            execute: vi.fn(async () => {
              throw new Error('Critical internal database blowout');
            }),
          };
        }
        if (name === 'get_review_status') {
          return {
            definition: { name: 'get_review_status', inputSchema: { type: 'object' as const } },
            execute: vi.fn(async (args) => buildToolResultJson({ found: true, args })),
          };
        }
        return undefined;
      }),
    };

    const router = createRemoteMcpRouter({
      authenticator,
      toolRegistry,
      now: () => currentTime,
      uuidGenerator: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
      sessionTtlMs: 1_800_000,
      maxSessions: 100,
      keepAliveMs: 5_000,
      ...customOptions,
    });
    activeRouters.push(router);

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.use('/api/mcp', router);

    return { app, router, authenticator, toolRegistry };
  }

  // =========================================================================
  // Challenge 1: Rapid Concurrent Session Creation (>100 sessions)
  // =========================================================================
  describe('Challenge 1: Rapid Concurrent Session Creation (>100 sessions)', () => {
    it('saturates exactly at 100 sessions under flood and rejects requests 101..120 with 429 and -32000', async () => {
      const { app, router } = buildAdversarialApp({ maxSessions: 100 });

      // Fire 120 concurrent initialize requests
      const floodPromises = Array.from({ length: 120 }, (_, idx) =>
        request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
          .send({
            jsonrpc: '2.0',
            id: idx + 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: `client-${idx + 1}`, version: '1.0.0' },
            },
          })
      );

      const responses = await Promise.all(floodPromises);

      const successful = responses.filter((r) => r.status === 200);
      const rejected = responses.filter((r) => r.status === 429);

      // Verify exact saturation thresholds
      expect(successful).toHaveLength(100);
      expect(rejected).toHaveLength(20);

      // Verify active session count strictly capped at 100
      expect(router.sessionManager.activeSessionCount()).toBe(100);

      // Verify successful responses delivered unique session IDs and protocol result
      const sessionIds = new Set<string>();
      for (const res of successful) {
        const sid = res.headers['mcp-session-id'];
        expect(sid).toBeDefined();
        expect(sessionIds.has(sid)).toBe(false);
        sessionIds.add(sid);
        expect(res.body.result.protocolVersion).toBe('2024-11-05');
      }
      expect(sessionIds.size).toBe(100);

      // Verify rejected responses return HTTP 429 and JSON-RPC error -32000
      for (const res of rejected) {
        expect(res.body).toEqual({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: MCP_ERRORS.TOO_MANY_SESSIONS,
            message: 'Maximum concurrent MCP sessions exceeded',
          },
        });
      }
    });

    it('reclaims slots immediately upon session closure, allowing queued sessions to succeed', async () => {
      const { app, router } = buildAdversarialApp({ maxSessions: 100 });

      // Saturate 100 sessions
      const sessionIds: string[] = [];
      for (let i = 1; i <= 100; i++) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
          .send({ jsonrpc: '2.0', id: i, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
        expect(res.status).toBe(200);
        sessionIds.push(res.headers['mcp-session-id']);
      }

      expect(router.sessionManager.activeSessionCount()).toBe(100);

      // Session 101 must be rejected with 429
      const overflow1 = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 101, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect(overflow1.status).toBe(429);
      expect(overflow1.body.error.code).toBe(-32000);

      // Explicitly close one session
      router.sessionManager.closeSession(sessionIds[0]);
      expect(router.sessionManager.activeSessionCount()).toBe(99);

      // Session 102 should now succeed and fill the vacant slot
      const reclaimed = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 102, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect(reclaimed.status).toBe(200);
      expect(router.sessionManager.activeSessionCount()).toBe(100);

      // Session 103 must be rejected again
      const overflow2 = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 103, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect(overflow2.status).toBe(429);
      expect(overflow2.body.error.code).toBe(-32000);
    });

    it('enforces saturation ceiling on SSE connections and recovers slots when SSE stream closes', async () => {
      const { app, router } = buildAdversarialApp({ maxSessions: 3 });

      // Open 3 SSE streams
      const sseSessions: string[] = [];
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve, reject) => {
          const req = request(app)
            .get('/api/mcp/sse')
            .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
            .buffer(false)
            .parse((res: any) => {
              res.on('data', (chunk: any) => {
                const match = /sessionId=([0-9a-f-]{36})/.exec(chunk.toString());
                if (match) {
                  sseSessions.push(match[1]);
                  resolve();
                }
              });
              res.on('error', reject);
            });
          req.on('error', () => {});
          req.end();
        });
      }

      expect(router.sessionManager.activeSessionCount()).toBe(3);

      // 4th SSE connection attempt rejected with 429
      const overflowSse = await request(app)
        .get('/api/mcp/sse')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`);
      expect(overflowSse.status).toBe(429);
      expect(overflowSse.body.error).toMatch(/Maximum concurrent MCP sessions exceeded/i);

      // Also 4th Streamable HTTP initialize rejected with 429
      const overflowHttp = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 999, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect(overflowHttp.status).toBe(429);
      expect(overflowHttp.body.error.code).toBe(-32000);

      // Close 1 SSE session
      router.sessionManager.closeSession(sseSessions[0]);
      expect(router.sessionManager.activeSessionCount()).toBe(2);

      // New HTTP session succeeds
      const newHttp = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 1000, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect(newHttp.status).toBe(200);
      expect(router.sessionManager.activeSessionCount()).toBe(3);
    });
  });

  // =========================================================================
  // Challenge 2: SSE Client Disconnect During Active Transmission
  // =========================================================================
  describe('Challenge 2: SSE Client Disconnect During Active Transmission', () => {
    it('cleans up session and keepalive timer when client abruptly disconnects during idle stream', async () => {
      const { app, router } = buildAdversarialApp();

      // Spin up real HTTP server to capture real socket lifecycle
      const server = http.createServer(app);
      activeServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      let capturedSessionId = '';
      await new Promise<void>((resolve, reject) => {
        const clientReq = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/mcp/sse',
            method: 'GET',
            headers: { Authorization: `Bearer ${TEST_AUTH_TOKEN}` },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');

            res.on('data', (chunk) => {
              const text = chunk.toString();
              const match = /sessionId=([0-9a-f-]{36})/.exec(text);
              if (match) {
                capturedSessionId = match[1];

                // Verify session is active in session manager
                expect(router.sessionManager.getSession(capturedSessionId)).toBeDefined();
                expect(router.sessionManager.activeSessionCount()).toBe(1);

                // Abruptly destroy the client socket
                clientReq.destroy();
                resolve();
              }
            });
            res.on('error', () => {});
          }
        );
        clientReq.on('error', () => {});
        clientReq.end();
      });

      // Wait for server-side close event propagation
      await new Promise((r) => setTimeout(r, 60));

      // Verify session was destroyed
      expect(router.sessionManager.getSession(capturedSessionId)).toBeUndefined();
      expect(router.sessionManager.activeSessionCount()).toBe(0);

      // Verify subsequent message to the destroyed session returns 404
      const postRes = await request(app)
        .post(`/api/mcp/messages?sessionId=${capturedSessionId}`)
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(postRes.status).toBe(404);
      expect(postRes.body.error).toMatch(/Active SSE session not found/i);
    });

    it('safely handles client disconnect DURING active in-flight tool execution without crash', async () => {
      // Configure 150ms delay on slow tool execution
      const { app, router } = buildAdversarialApp({ toolDelayMs: 150 });

      const server = http.createServer(app);
      activeServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      let capturedSessionId = '';
      let clientReqRef: http.ClientRequest | null = null;

      // 1. Establish SSE stream
      await new Promise<void>((resolve, reject) => {
        clientReqRef = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/mcp/sse',
            method: 'GET',
            headers: { Authorization: `Bearer ${TEST_AUTH_TOKEN}` },
          },
          (res) => {
            res.on('data', (chunk) => {
              const match = /sessionId=([0-9a-f-]{36})/.exec(chunk.toString());
              if (match) {
                capturedSessionId = match[1];
                resolve();
              }
            });
            res.on('error', reject);
          }
        );
        clientReqRef.on('error', () => {});
        clientReqRef.end();
      });

      expect(router.sessionManager.activeSessionCount()).toBe(1);

      // 2. Dispatch slow tool call over POST /messages (returns 202 Accepted)
      const dispatchRes = await request(app)
        .post(`/api/mcp/messages?sessionId=${capturedSessionId}`)
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 55,
          method: 'tools/call',
          params: { name: 'slow_running_tool', arguments: {} },
        });

      expect(dispatchRes.status).toBe(202);
      expect(dispatchRes.body).toEqual({ status: 'accepted' });

      // 3. Abruptly kill client SSE connection while tool is executing (before 150ms elapsed)
      await new Promise((r) => setTimeout(r, 20));
      clientReqRef!.destroy();

      // Wait for tool execution to finish on server and attempt write (total 200ms)
      await new Promise((r) => setTimeout(r, 200));

      // 4. Verify server did not crash and session was cleanly reaped
      expect(router.sessionManager.getSession(capturedSessionId)).toBeUndefined();
      expect(router.sessionManager.activeSessionCount()).toBe(0);

      // 5. Verify server is fully alive and responds to new requests
      const livenessRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 56, method: 'ping' });

      expect(livenessRes.status).toBe(200);
      expect(livenessRes.body).toEqual({ jsonrpc: '2.0', id: 56, result: {} });
    });
  });

  // =========================================================================
  // Challenge 3: Stale Session ID Injection & Adversarial Identifiers
  // =========================================================================
  describe('Challenge 3: Stale Session ID Injection & Adversarial Identifiers', () => {
    it('returns HTTP 404 with JSON-RPC error -32002 on unknown session ID in Mcp-Session-Id header', async () => {
      const { app } = buildAdversarialApp();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .set('Mcp-Session-Id', 'ba111111-2222-4333-8444-555555555555')
        .send({ jsonrpc: '2.0', id: 701, method: 'ping' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 701,
        error: {
          code: MCP_ERRORS.SESSION_EXPIRED,
          message: 'Session expired or not found',
        },
      });
    });

    it('returns HTTP 404 on POST /api/mcp/messages with unknown sessionId parameter', async () => {
      const { app } = buildAdversarialApp();

      const res = await request(app)
        .post('/api/mcp/messages?sessionId=ba111111-2222-4333-8444-555555555555')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 702, method: 'ping' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Active SSE session not found' });
    });

    it('expires and reaps sessions after 30m idle TTL, rejecting subsequent calls with 404 / -32002', async () => {
      const { app, router } = buildAdversarialApp({ sessionTtlMs: 1_800_000 });

      // Create session at t=1,000,000
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });

      const sessionId = initRes.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();

      // Touch session at t=1,010,000
      currentTime += 10_000;
      const touchRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .set('Mcp-Session-Id', sessionId)
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      expect(touchRes.status).toBe(200);

      // Advance clock past 30 minutes from last touch (10,000 + 1,800,001 ms)
      currentTime += 1_800_001;

      // Access expired session
      const expiredRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .set('Mcp-Session-Id', sessionId)
        .send({ jsonrpc: '2.0', id: 3, method: 'ping' });

      expect(expiredRes.status).toBe(404);
      expect(expiredRes.body.error.code).toBe(MCP_ERRORS.SESSION_EXPIRED);
      expect(router.sessionManager.activeSessionCount()).toBe(0);
    });

    it('safely rejects adversarial and malicious session ID strings without 500 crashes or info leaks', async () => {
      const { app } = buildAdversarialApp();

      const maliciousSessionIds = [
        "' OR '1'='1' --",
        "'; DROP TABLE sessions; --",
        "../../../../etc/passwd",
        "..\\..\\..\\windows\\win.ini",
        "<script>alert('xss')</script>",
        "00000000-0000-0000-0000-000000000000%00extra",
        "uuid-" + "A".repeat(4000),
        "invalid-random-string",
        "undefined",
        "null",
      ];

      for (const malformedId of maliciousSessionIds) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
          .set('Mcp-Session-Id', malformedId)
          .send({ jsonrpc: '2.0', id: 99, method: 'ping' });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe(MCP_ERRORS.SESSION_EXPIRED);
        expect(res.body.error.message).toBe('Session expired or not found');

        // Verify zero info leak
        const bodyStr = JSON.stringify(res.body);
        expect(bodyStr).not.toContain('stack');
        expect(bodyStr).not.toContain('node_modules');
        expect(bodyStr).not.toContain('Postgres');
      }
    });
  });

  // =========================================================================
  // Challenge 4: Malformed JSON-RPC Payloads & Standard Error Codes
  // =========================================================================
  describe('Challenge 4: Malformed JSON-RPC Payloads & Standard Error Codes', () => {
    it('rejects payload missing jsonrpc header with HTTP 400 and code -32600 (INVALID_REQUEST)', async () => {
      const { app } = buildAdversarialApp();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ id: 10, method: 'ping' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 10,
        error: {
          code: JSONRPC_ERRORS.INVALID_REQUEST,
          message: 'Invalid Request',
        },
      });
    });

    it('rejects invalid jsonrpc versions (1.0, 3.0, numeric) with HTTP 400 and code -32600', async () => {
      const { app } = buildAdversarialApp();

      for (const badVer of ['1.0', '3.0', 2.0, true, null]) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
          .send({ jsonrpc: badVer, id: 11, method: 'ping' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
      }
    });

    it('rejects payloads missing method or having non-string method with HTTP 400 and code -32600', async () => {
      const { app } = buildAdversarialApp();

      // Missing method
      const missingMethod = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 12 });
      expect(missingMethod.status).toBe(400);
      expect(missingMethod.body.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);

      // Non-string method (number, boolean, array, object)
      for (const badMethod of [123, false, ['ping'], { name: 'ping' }]) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
          .send({ jsonrpc: '2.0', id: 13, method: badMethod });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
      }
    });

    it('returns code -32601 (METHOD_NOT_FOUND) when method string is unknown', async () => {
      const { app } = buildAdversarialApp();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 14, method: 'arbitrary/unknown_method' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 14,
        error: {
          code: JSONRPC_ERRORS.METHOD_NOT_FOUND,
          message: 'Method not found',
        },
      });
    });

    it('returns code -32602 (INVALID_PARAMS) when tools/call has missing or non-string tool name', async () => {
      const { app } = buildAdversarialApp();

      // Missing name in params
      const missingName = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 15,
          method: 'tools/call',
          params: { arguments: {} },
        });

      expect(missingName.status).toBe(200);
      expect(missingName.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(missingName.body.error.message).toMatch(/Invalid tool name/i);

      // Non-string name
      const numericName = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: { name: 12345, arguments: {} },
        });

      expect(numericName.status).toBe(200);
      expect(numericName.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    });

    it('returns code -32601 (METHOD_NOT_FOUND) when calling unregistered tool name', async () => {
      const { app } = buildAdversarialApp();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: { name: 'non_existent_tool_xyz', arguments: {} },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND);
      expect(res.body.error.message).toContain('Tool not found: non_existent_tool_xyz');
    });

    it('catches tool handler execution exceptions and maps to code -32603 (INTERNAL_ERROR)', async () => {
      const { app } = buildAdversarialApp();

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 18,
          method: 'tools/call',
          params: { name: 'failing_tool', arguments: {} },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 18,
        error: {
          code: JSONRPC_ERRORS.INTERNAL_ERROR,
          message: 'Critical internal database blowout',
        },
      });
    });

    it('handles batch anomalies (empty batch, invalid elements, mixed valid/invalid)', async () => {
      const { app } = buildAdversarialApp();

      // Empty batch -> 400
      const emptyBatch = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send([]);

      expect(emptyBatch.status).toBe(400);
      expect(emptyBatch.body.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);

      // Mixed batch
      const mixedBatch = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send([
          { jsonrpc: '2.0', id: 'm1', method: 'ping' },
          { jsonrpc: '2.0', id: 'm2', method: 'non_existent_method' },
          { id: 'm3', method: 'ping' }, // missing jsonrpc
        ]);

      expect(mixedBatch.status).toBe(200);
      expect(Array.isArray(mixedBatch.body)).toBe(true);
      expect(mixedBatch.body).toHaveLength(3);

      expect(mixedBatch.body[0]).toEqual({ jsonrpc: '2.0', id: 'm1', result: {} });
      expect(mixedBatch.body[1].error.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND);
      expect(mixedBatch.body[2].error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    });

    it('handles non-JSON raw body syntax error via dispatchServer middleware returning HTTP 400', async () => {
      const verifier = { verify: vi.fn() };
      const app = createActionDispatchApp({
        verifier: verifier as any,
        admission: { admit: vi.fn() } as any,
        resolveInstallationId: vi.fn(),
        databaseReady: vi.fn(async () => true),
        allowAppGate: false,
        mcpConfig: {
          enabled: true,
          path: '/api/mcp',
          authToken: TEST_AUTH_TOKEN,
          maxSessions: 100,
          sessionTtlMs: 1_800_000,
          rateLimitWindowMs: 60_000,
          rateLimitMax: 200,
          rateLimit: { windowMs: 60_000, max: 200 },
        },
      });

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .set('Content-Type', 'application/json')
        .send('{ broken JSON non-syntax');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid JSON body' });
    });
  });
});
