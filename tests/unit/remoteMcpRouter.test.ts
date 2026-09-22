import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
  type McpToolRegistry,
  type McpToolHandler,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import { buildToolResultText, buildToolResultJson, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';

describe('Remote MCP Router Unit Suite (tests/unit/remoteMcpRouter.test.ts)', () => {
  let app: express.Express;
  let router: RemoteMcpRouter;
  let currentTime: number;
  let uuidCounter: number;

  function buildTestApp(customOptions?: Partial<RemoteMcpRouterOptions>) {
    currentTime = 1_000_000;
    uuidCounter = 1;

    const authenticator: McpAuthenticator = {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === 'Bearer valid-token') {
          return {
            authType: 'static_token',
            tokenDigest: 'valid-token1',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr', 'calltelemetry/review-yeti-bot']),
            callerId: 'test-caller',
          } satisfies McpAuthenticatedCaller;
        }
        if (header === 'Bearer admin-token') {
          return {
            authType: 'static_token',
            tokenDigest: 'admin-token1',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'admin-caller',
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === 'valid-token') {
          return {
            authType: 'static_token',
            tokenDigest: 'valid-token1',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
            callerId: 'test-caller',
          };
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      checkRepositoryAccess: vi.fn((caller: McpAuthenticatedCaller, owner: string, repo: string) => {
        if (caller.isAdmin) return true;
        return caller.allowedRepositories?.has(`${owner}/${repo}`.toLowerCase()) ?? false;
      }),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;

    const toolRegistry: McpToolRegistry = {
      listTools: vi.fn(() => [
        {
          name: 'get_review_status',
          description: 'Query review run status',
          inputSchema: { type: 'object' as const, properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
        },
        {
          name: 'get_review_findings',
          description: 'Query structured findings',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'watch_review_progress',
          description: 'Stream progress',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'trigger_review',
          description: 'Trigger review',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'cancel_review',
          description: 'Cancel review',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'explain_finding',
          description: 'Explain finding',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'preflight_diff_review',
          description: 'Preflight diff review',
          inputSchema: { type: 'object' as const },
        },
        {
          name: 'get_model_matrix',
          description: 'Query model matrix',
          inputSchema: { type: 'object' as const },
        },
      ]),
      getTool: vi.fn((name: string) => {
        if (name === 'throwing_tool') {
          return {
            definition: { name: 'throwing_tool', inputSchema: { type: 'object' as const } },
            execute: vi.fn(async () => {
              throw new Error('Explosive tool failure');
            }),
          };
        }
        if (name === 'get_review_status') {
          return {
            definition: { name: 'get_review_status', inputSchema: { type: 'object' as const } },
            execute: vi.fn(async (args) => buildToolResultJson({ found: true, args })),
          };
        }
        if (name === 'get_model_matrix') {
          return {
            definition: { name: 'get_model_matrix', inputSchema: { type: 'object' as const } },
            execute: vi.fn(async () => buildToolResultJson({ models: ['model-1'] })),
          };
        }
        return undefined;
      }),
    };

    router = createRemoteMcpRouter({
      authenticator,
      toolRegistry,
      now: () => currentTime,
      uuidGenerator: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
      sessionTtlMs: 1_800_000,
      maxSessions: 3,
      keepAliveMs: 15_000,
      ...customOptions,
    });

    const testApp = express();
    testApp.use(express.json({ limit: '512kb' }));
    testApp.use('/api/mcp', router);
    return { testApp, authenticator, toolRegistry };
  }

  beforeEach(() => {
    const { testApp } = buildTestApp();
    app = testApp;
  });

  afterEach(() => {
    if (router) {
      router.destroy();
    }
  });

  describe('Protocol Negotiation', () => {
    it('TC-101: successfully handles initialize with protocol version 2024-11-05', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
          },
          serverInfo: {
            name: 'review-yeti-action-dispatch',
            version: '1.45.3',
          },
        },
      });
      expect(response.headers['mcp-session-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('TC-102: handles notifications/initialized returning HTTP 204', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        });

      expect(response.status).toBe(204);
    });

    it('TC-103: returns pong result on ping', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    });

    it('TC-104: returns catalog of 8 registered tools on tools/list', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });

      expect(response.status).toBe(200);
      expect(response.body.result.tools).toHaveLength(8);
      const names = response.body.result.tools.map((t: any) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'get_review_status',
          'get_review_findings',
          'watch_review_progress',
          'trigger_review',
          'cancel_review',
          'explain_finding',
          'preflight_diff_review',
          'get_model_matrix',
        ])
      );
      for (const tool of response.body.result.tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
      }
    });

    it('TC-105: successfully executes registered tool on tools/call', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'get_model_matrix', arguments: { limit: 5 } },
        });

      expect(response.status).toBe(200);
      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(4);
      expect(response.body.result).toHaveProperty('content');
      expect(response.body.result.content[0].type).toBe('text');
    });

    it('TC-106: returns error -32601 on unknown tool call', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'unknown_nonexistent_tool', arguments: {} },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        id: 5,
        error: {
          code: -32601,
          message: 'Tool not found: unknown_nonexistent_tool',
        },
      });
    });

    it('TC-107: rejects malformed JSON-RPC missing jsonrpc property with HTTP 400', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ id: 7, method: 'ping' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      });
    });

    it('TC-108: returns error -32601 on unknown JSON-RPC method', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 8, method: 'unsupported/method' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        id: 8,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    });

    it('M1-UNIT-PROTO-008: handles batch requests and rejects empty batch with 400', async () => {
      const emptyBatch = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send([]);

      expect(emptyBatch.status).toBe(400);
      expect(emptyBatch.body.error.code).toBe(-32600);

      const batch = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send([
          { jsonrpc: '2.0', id: 10, method: 'ping' },
          { jsonrpc: '2.0', id: 11, method: 'ping' },
        ]);

      expect(batch.status).toBe(200);
      expect(Array.isArray(batch.body)).toBe(true);
      expect(batch.body).toHaveLength(2);
      expect(batch.body[0]).toEqual({ jsonrpc: '2.0', id: 10, result: {} });
      expect(batch.body[1]).toEqual({ jsonrpc: '2.0', id: 11, result: {} });
    });
  });

  describe('Session Lifecycle & Limits', () => {
    it('M1-UNIT-SESS-001: assigns UUIDv4 and tracks session state on initialize', async () => {
      const init = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        });

      const sessionId = init.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(router.sessionManager.activeSessionCount()).toBe(1);
    });

    it('M1-UNIT-SESS-002: session activity touch updates lastSeenAt', async () => {
      const init = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });

      const sessionId = init.headers['mcp-session-id'];
      const initialSeen = router.sessionManager.getSession(sessionId)?.lastSeenAt;

      currentTime += 60_000;

      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' });

      const updatedSeen = router.sessionManager.getSession(sessionId)?.lastSeenAt;
      expect(updatedSeen).toBeGreaterThan(initialSeen!);
      expect(updatedSeen).toBe(currentTime);
    });

    it('TC-403 / M1-UNIT-SESS-003: reaps idle sessions after 30 minutes TTL', async () => {
      const init = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });

      const sessionId = init.headers['mcp-session-id'];

      // Advance clock past 30 minutes
      currentTime += 1_800_001;
      router.sessionManager.reapIdleSessions(currentTime);

      const ping = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({ jsonrpc: '2.0', id: 2, method: 'ping' });

      expect(ping.status).toBe(404);
      expect(ping.body.error.code).toBe(MCP_ERRORS.SESSION_EXPIRED);
      expect(ping.body.error.message).toMatch(/Session expired or not found/i);
    });

    it('M1-UNIT-SESS-004: returns 404 for unknown session ID', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', '00000000-0000-4000-8000-999999999999')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(MCP_ERRORS.SESSION_EXPIRED);
    });

    it('TC-401 / TC-402 / M1-UNIT-SESS-005: enforces max concurrent sessions ceiling', async () => {
      // Create 3 sessions (maxSessions is configured as 3 in buildTestApp)
      for (let i = 1; i <= 3; i++) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-token')
          .send({ jsonrpc: '2.0', id: i, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
        expect(res.status).toBe(200);
      }

      expect(router.sessionManager.activeSessionCount()).toBe(3);

      // 4th session creation on POST /api/mcp must fail with 429
      const overflowPost = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2024-11-05' } });

      expect(overflowPost.status).toBe(429);
      expect(overflowPost.body.error.code).toBe(MCP_ERRORS.TOO_MANY_SESSIONS);

      // 4th session creation on GET /api/mcp/sse must also fail with 429
      const overflowSse = await request(app)
        .get('/api/mcp/sse')
        .set('Authorization', 'Bearer valid-token');

      expect(overflowSse.status).toBe(429);
      expect(overflowSse.body.error).toMatch(/Maximum concurrent MCP sessions exceeded/i);
    });

    it('TC-502: destroy cleans up active sessions and reaper', () => {
      router.sessionManager.createSession();
      router.sessionManager.createSession();
      expect(router.sessionManager.activeSessionCount()).toBe(2);

      router.destroy();
      expect(router.sessionManager.activeSessionCount()).toBe(0);
    });
  });

  describe('HTTP+SSE Streaming Transport', () => {
    it('TC-301 / M1-UNIT-SSE-001: emits endpoint event with valid sessionId on GET /api/mcp/sse', async () => {
      await new Promise<void>((resolve, reject) => {
        let endpointData = '';
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', 'Bearer valid-token')
          .buffer(false)
          .parse((res: any) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            res.on('data', (chunk: any) => {
              endpointData += chunk.toString();
              const match = /sessionId=([0-9a-f-]{36})/.exec(endpointData);
              if (match) {
                expect(endpointData).toMatch(/data: \/api\/mcp\/messages\?sessionId=[0-9a-f-]{36}/);
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

    it('TC-303 / M1-UNIT-SSE-003: receives message on POST /api/mcp/messages and returns 202', async () => {
      let activeSessionId = '';
      await new Promise<void>((resolve, reject) => {
        let endpointData = '';
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', 'Bearer valid-token')
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

      const postRes = await request(app)
        .post(`/api/mcp/messages?sessionId=${activeSessionId}`)
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 99, method: 'ping' });

      expect(postRes.status).toBe(202);
      expect(postRes.body).toEqual({ status: 'accepted' });
      router.sessionManager.closeSession(activeSessionId);
    });

    it('TC-304 / M1-UNIT-SSE-004 & 005: rejects invalid or missing sessionId on POST /api/mcp/messages', async () => {
      const missingSession = await request(app)
        .post('/api/mcp/messages')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(missingSession.status).toBe(400);
      expect(missingSession.body.error).toMatch(/sessionId query parameter is required/i);

      const invalidSession = await request(app)
        .post('/api/mcp/messages?sessionId=00000000-0000-4000-8000-000000000000')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(invalidSession.status).toBe(404);
      expect(invalidSession.body.error).toMatch(/Active SSE session not found/i);
    });

    it('TC-203 / M1-UNIT-SSE-006: rejects unauthenticated GET /api/mcp/sse with HTTP 401 without establishing stream', async () => {
      const res = await request(app).get('/api/mcp/sse');

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).not.toContain('text/event-stream');
      expect(res.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
    });
  });

  describe('Authentication and RBAC Boundaries', () => {
    it('TC-201 / M1-UNIT-AUTH-001: returns HTTP 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

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

    it('TC-202 / M1-UNIT-AUTH-002: returns HTTP 401 on invalid token scheme or token string', async () => {
      const badScheme = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(badScheme.status).toBe(401);
      expect(badScheme.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);

      const badToken = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer wrong-secret-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(badToken.status).toBe(401);
      expect(badToken.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
    });

    it('TC-204: returns HTTP 401 when POST /api/mcp/messages is unauthenticated', async () => {
      let activeSessionId = '';
      await new Promise<void>((resolve, reject) => {
        let endpointData = '';
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', 'Bearer valid-token')
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
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(401);
      router.sessionManager.closeSession(activeSessionId);
    });

    it('M1-UNIT-AUTH-004: executes tool call when caller is authorized for target repository', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 50,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'calltelemetry', repo: 'cisco-cdr', pull_number: 42 },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it('TC-205 / M1-UNIT-AUTH-005: returns HTTP 403 sanitized error on cross-tenant repository access', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 51,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'unauthorized-org', repo: 'secret-repo', pull_number: 1 },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: MCP_ERRORS.FORBIDDEN,
          message: 'Forbidden: Access to repository unauthorized-org/secret-repo denied',
        },
      });
    });

    it('M1-UNIT-AUTH-006: sanitized 403 error does not leak internal stack traces or database info', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 52,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'other-corp', repo: 'classified-repo' },
          },
        });

      expect(res.status).toBe(403);
      const str = JSON.stringify(res.body);
      expect(str).not.toContain('stack');
      expect(str).not.toContain('node_modules');
      expect(str).not.toContain('Postgres');
      expect(str).not.toContain('database');
    });

    it('allows admin caller to access any repository', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer admin-token')
        .send({
          jsonrpc: '2.0',
          id: 53,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: { owner: 'any-external-org', repo: 'any-repo' },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });
  });

  describe('Error Handling and Robustness', () => {
    it('TC-501: catches tool handler exceptions and returns JSON-RPC internal error -32603', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 60,
          method: 'tools/call',
          params: { name: 'throwing_tool', arguments: {} },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 60,
        error: {
          code: -32603,
          message: 'Explosive tool failure',
        },
      });
    });
  });
});
