import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';
import { parseResourceUri } from '../../src/mcp/server/resources';

describe('MCP Native Resources & SSE Subscriptions Suite (tests/unit/mcpResources.test.ts)', () => {
  let app: express.Express;
  let router: RemoteMcpRouter;
  let currentTime: number;
  let uuidCounter: number;
  let mockDb: any;

  function buildTestApp(customOptions?: Partial<RemoteMcpRouterOptions>) {
    currentTime = 1_000_000;
    uuidCounter = 1;

    mockDb = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        // Mock review_runs + review_gate_attempts
        if (sql.includes('review_runs') && sql.includes('review_gate_attempts')) {
          return {
            rows: [
              {
                run_id: 'run_test_1234567890',
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                pr_number: 123,
                head_sha: '01cc3c3070ae025c9a9bb8176c92106c30488151',
                run_status: 'complete',
                run_stage: 'completed',
                attempt: 1,
                lease_owner: null,
                lease_expires_at: null,
                created_at: new Date('2026-09-22T10:00:00Z'),
                updated_at: new Date('2026-09-22T10:05:00Z'),
                attempt_id: 'attempt-cisco-cdr-123-1',
                check_id: '102735106478',
                desired_state: 'success',
                decision: JSON.stringify({ verdict: 'SHIP', summary: 'Clean review' }),
                current_attempt: true,
              },
            ],
          };
        }

        // Mock review_worker_completions
        if (sql.includes('review_worker_completions')) {
          return {
            rows: [
              {
                run_id: 'run_test_1234567890',
                head_sha: '01cc3c3070ae025c9a9bb8176c92106c30488151',
                payload: {
                  findings: [
                    {
                      finding_id: 'finding_001',
                      severity: 'P1',
                      category: 'Architecture',
                      title: 'Unbounded event buffer capacity',
                      path: 'src/events/buffer.ts',
                      line_start: 42,
                      line_end: 48,
                      violated_adrs: ['ADR 0564'],
                      body: 'Event buffer allows unbounded growth without capacity backpressure per ADR 0564.',
                      suggestion: 'Introduce ring-buffer with bounded drop-oldest policy.',
                      unresolved: true,
                      status: 'OPEN',
                    },
                    {
                      finding_id: 'finding_002',
                      severity: 'P2',
                      category: 'Security',
                      title: 'Missing input trimming on query filter',
                      path: 'src/api/query.ts',
                      line_start: 15,
                      line_end: 18,
                      body: 'Whitespace is not trimmed before validation check.',
                      unresolved: false,
                      status: 'RESOLVED',
                    },
                  ],
                },
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

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

    router = createRemoteMcpRouter({
      db: mockDb,
      authenticator,
      now: () => currentTime,
      uuidGenerator: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
      sessionTtlMs: 1_800_000,
      maxSessions: 10,
      keepAliveMs: 15_000,
      ...customOptions,
    });

    const testApp = express();
    testApp.use(express.json({ limit: '512kb' }));
    testApp.use('/api/mcp', router);
    return { testApp, authenticator };
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

  describe('Suite 1: Resource Catalog Discovery (resources/list)', () => {
    it('TC-RES-001: Returns catalog containing 3 resource templates with standard URIs', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/list',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(1);

      const result = response.body.result;
      expect(result).toBeDefined();
      expect(Array.isArray(result.resources)).toBe(true);
      expect(result.resources.length).toBe(3);

      const uris = result.resources.map((r: any) => r.uri);
      expect(uris).toContain('review-yeti://runs/{owner}/{repo}/{pr_number}');
      expect(uris).toContain('review-yeti://findings/{owner}/{repo}/{pr_number}');
      expect(uris).toContain('review-yeti://charters/{owner}/{repo}');
    });

    it('TC-RES-002: Resource templates include names, descriptions, and mimeType application/json', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/list',
        });

      expect(response.status).toBe(200);
      for (const res of response.body.result.resources) {
        expect(res.name).toBeTypeOf('string');
        expect(res.name.length).toBeGreaterThan(0);
        expect(res.description).toBeTypeOf('string');
        expect(res.mimeType).toBe('application/json');
      }

      // Also verify resourceTemplates array is provided
      expect(Array.isArray(response.body.result.resourceTemplates)).toBe(true);
      expect(response.body.result.resourceTemplates.length).toBe(3);
    });
  });

  describe('Suite 2: Resource Read Operations (resources/read)', () => {
    it('TC-READ-001: Reads review-yeti://runs/... with database run state and gate attempt', async () => {
      const uri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'resources/read',
          params: { uri },
        });

      expect(response.status).toBe(200);
      expect(response.body.result).toBeDefined();
      expect(Array.isArray(response.body.result.contents)).toBe(true);
      expect(response.body.result.contents.length).toBe(1);

      const content = response.body.result.contents[0];
      expect(content.uri).toBe(uri);
      expect(content.mimeType).toBe('application/json');

      const data = JSON.parse(content.text);
      expect(data.uri).toBe(uri);
      expect(data.owner).toBe('calltelemetry');
      expect(data.repo).toBe('cisco-cdr');
      expect(data.pr_number).toBe(123);
      expect(data.found).toBe(true);
      expect(data.phase).toBe('completed');
      expect(data.verdict).toBe('SHIP');
      expect(data.run_id).toBe('run_test_1234567890');
      expect(data.head_sha).toBe('01cc3c3070ae025c9a9bb8176c92106c30488151');
      expect(data.check_run).toEqual({
        id: 102735106478,
        url: 'https://github.com/calltelemetry/cisco-cdr/runs/102735106478',
        conclusion: 'success',
      });
    });

    it('TC-READ-002: Reads review-yeti://runs/... fallback when database has no records', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const uri = 'review-yeti://runs/calltelemetry/cisco-cdr/999';
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'resources/read',
          params: { uri },
        });

      expect(response.status).toBe(200);
      const content = response.body.result.contents[0];
      const data = JSON.parse(content.text);
      expect(data.found).toBe(false);
      expect(data.verdict).toBe('PENDING');
      expect(data.phase).toBe('queued');
      expect(data.run_id).toBeNull();
      expect(data.check_run).toBeNull();
    });

    it('TC-READ-003: Reads review-yeti://findings/... with structured findings and ADR citations', async () => {
      const uri = 'review-yeti://findings/calltelemetry/cisco-cdr/123';
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 20,
          method: 'resources/read',
          params: { uri },
        });

      expect(response.status).toBe(200);
      const content = response.body.result.contents[0];
      expect(content.uri).toBe(uri);
      expect(content.mimeType).toBe('application/json');

      const data = JSON.parse(content.text);
      expect(data.uri).toBe(uri);
      expect(data.owner).toBe('calltelemetry');
      expect(data.repo).toBe('cisco-cdr');
      expect(data.pr_number).toBe(123);
      expect(data.total_count).toBe(2);
      expect(data.unresolved_count).toBe(1);
      expect(data.findings.length).toBe(2);

      const f1 = data.findings[0];
      expect(f1.finding_id).toBe('finding_001');
      expect(f1.severity).toBe('P1');
      expect(f1.category).toBe('Architecture');
      expect(f1.title).toBe('Unbounded event buffer capacity');
      expect(f1.file_path).toBe('src/events/buffer.ts');
      expect(f1.line_start).toBe(42);
      expect(f1.line_end).toBe(48);
      expect(f1.violated_adrs).toContain('ADR 0564');
      expect(f1.unresolved).toBe(true);
      expect(f1.status).toBe('OPEN');
    });

    it('TC-READ-004: Reads review-yeti://findings/... fallback when no findings exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const uri = 'review-yeti://findings/calltelemetry/cisco-cdr/999';
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 21,
          method: 'resources/read',
          params: { uri },
        });

      expect(response.status).toBe(200);
      const content = response.body.result.contents[0];
      const data = JSON.parse(content.text);
      expect(data.total_count).toBe(0);
      expect(data.unresolved_count).toBe(0);
      expect(data.findings).toEqual([]);
    });

    it('TC-READ-005: Reads review-yeti://charters/... with active personas and directives', async () => {
      const uri = 'review-yeti://charters/calltelemetry/cisco-cdr';
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 30,
          method: 'resources/read',
          params: { uri },
        });

      expect(response.status).toBe(200);
      const content = response.body.result.contents[0];
      expect(content.uri).toBe(uri);
      expect(content.mimeType).toBe('application/json');

      const data = JSON.parse(content.text);
      expect(data.uri).toBe(uri);
      expect(data.owner).toBe('calltelemetry');
      expect(data.repo).toBe('cisco-cdr');
      expect(Array.isArray(data.active_personas)).toBe(true);
      expect(data.active_personas.length).toBeGreaterThanOrEqual(4);

      const personaIds = data.active_personas.map((p: any) => p.id);
      expect(personaIds).toContain('architect');
      expect(personaIds).toContain('security');
      expect(personaIds).toContain('correctness');
      expect(personaIds).toContain('performance');

      expect(data.directives).toBeDefined();
      expect(data.directives.max_investigation_turns).toBe(3);
      expect(data.directives.lane_call_budget).toBe(5);
      expect(data.directives.zoekt_enabled).toBe(true);
    });

    it('TC-READ-006: Rejects malformed or unsupported resource URI with -32602', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 31,
          method: 'resources/read',
          params: { uri: 'review-yeti://unknown-type/calltelemetry/cisco-cdr' },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(response.body.error.message).toMatch(/unsupported/i);
    });

    it('TC-READ-007: Rejects unauthenticated resource read with HTTP 401', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .send({
          jsonrpc: '2.0',
          id: 32,
          method: 'resources/read',
          params: { uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123' },
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(MCP_ERRORS.UNAUTHORIZED);
    });

    it('TC-READ-008: Rejects unauthorized repository access with HTTP 403 McpRbacError', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 33,
          method: 'resources/read',
          params: { uri: 'review-yeti://runs/calltelemetry/unauthorized-vault/123' },
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(response.body.error.message).toMatch(/Forbidden/i);
    });

    it('TC-READ-009: Allows admin caller to read any repository resource', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer admin-token')
        .send({
          jsonrpc: '2.0',
          id: 34,
          method: 'resources/read',
          params: { uri: 'review-yeti://runs/calltelemetry/unauthorized-vault/123' },
        });

      expect(response.status).toBe(200);
      expect(response.body.result).toBeDefined();
      expect(response.body.result.contents[0].uri).toBe('review-yeti://runs/calltelemetry/unauthorized-vault/123');
    });
  });

  describe('Suite 3: Resource Subscriptions (resources/subscribe & resources/unsubscribe)', () => {
    it('TC-SUB-001: Successfully subscribes to valid resource URI and tracks in session', async () => {
      // 1. Initialize session
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        });

      const sessionId = initRes.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();

      // 2. Subscribe to resource
      const subRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('mcp-session-id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/subscribe',
          params: { uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123' },
        });

      expect(subRes.status).toBe(200);
      expect(subRes.body.result).toEqual({});

      // Verify subscription tracked in session state
      const session = router.sessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.subscriptions.has('review-yeti://runs/calltelemetry/cisco-cdr/123')).toBe(true);
    });

    it('TC-SUB-002: Successfully unsubscribes from resource URI and removes from session', async () => {
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        });

      const sessionId = initRes.headers['mcp-session-id'];

      // Subscribe first
      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('mcp-session-id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/subscribe',
          params: { uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123' },
        });

      const session = router.sessionManager.getSession(sessionId);
      expect(session?.subscriptions.has('review-yeti://runs/calltelemetry/cisco-cdr/123')).toBe(true);

      // Unsubscribe
      const unsubRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('mcp-session-id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/unsubscribe',
          params: { uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123' },
        });

      expect(unsubRes.status).toBe(200);
      expect(unsubRes.body.result).toEqual({});
      expect(session?.subscriptions.has('review-yeti://runs/calltelemetry/cisco-cdr/123')).toBe(false);
    });

    it('TC-SUB-003: Rejects subscription to unauthorized repository with HTTP 403', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'resources/subscribe',
          params: { uri: 'review-yeti://runs/calltelemetry/secret-internal-repo/123' },
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
    });

    it('TC-SUB-004: Rejects subscription with invalid or missing URI with -32602', async () => {
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'resources/subscribe',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    });
  });

  describe('Suite 4: Real-Time SSE Resource Notifications', () => {
    it('TC-NOTIF-001: Pushes notifications/resources/updated over active SSE stream to subscribed session', async () => {
      const targetUri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';
      let activeSessionId = '';
      let receivedEvents = '';

      // Establish SSE connection
      await new Promise<void>((resolve, reject) => {
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', 'Bearer valid-token')
          .buffer(false)
          .parse((res: any) => {
            res.on('data', (chunk: any) => {
              const text = chunk.toString();
              receivedEvents += text;
              const match = /sessionId=([0-9a-f-]{36})/.exec(receivedEvents);
              if (match && !activeSessionId) {
                activeSessionId = match[1];
                resolve();
              }
            });
            res.on('error', reject);
          });
        sseReq.on('error', () => {});
        sseReq.end();
      });

      expect(activeSessionId).toBeDefined();

      // Subscribe to target URI via messages endpoint
      const subRes = await request(app)
        .post(`/api/mcp/messages?sessionId=${activeSessionId}`)
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 100,
          method: 'resources/subscribe',
          params: { uri: targetUri },
        });

      expect(subRes.status).toBe(202);

      // Allow event loop to process subscription
      await new Promise((r) => setTimeout(r, 50));

      const session = router.sessionManager.getSession(activeSessionId);
      expect(session?.subscriptions.has(targetUri)).toBe(true);

      // Clear received events before trigger
      receivedEvents = '';

      // Trigger notification
      const notifiedCount = router.notifyResourceUpdated(targetUri);
      expect(notifiedCount).toBe(1);

      // Wait for SSE data chunk
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedEvents).toContain('event: message');
      expect(receivedEvents).toContain('notifications/resources/updated');
      expect(receivedEvents).toContain(targetUri);

      router.sessionManager.closeSession(activeSessionId);
    });

    it('TC-NOTIF-002: Does not push notifications to sessions that are not subscribed to the URI', async () => {
      let activeSessionId = '';
      let receivedEvents = '';

      await new Promise<void>((resolve, reject) => {
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', 'Bearer valid-token')
          .buffer(false)
          .parse((res: any) => {
            res.on('data', (chunk: any) => {
              receivedEvents += chunk.toString();
              const match = /sessionId=([0-9a-f-]{36})/.exec(receivedEvents);
              if (match && !activeSessionId) {
                activeSessionId = match[1];
                resolve();
              }
            });
            res.on('error', reject);
          });
        sseReq.on('error', () => {});
        sseReq.end();
      });

      // Session is NOT subscribed to this URI
      receivedEvents = '';
      const notifiedCount = router.notifyResourceUpdated('review-yeti://runs/calltelemetry/cisco-cdr/999');
      expect(notifiedCount).toBe(0);

      await new Promise((r) => setTimeout(r, 50));
      expect(receivedEvents).not.toContain('notifications/resources/updated');

      router.sessionManager.closeSession(activeSessionId);
    });

    it('TC-NOTIF-003: Does not push notifications after session unsubscribes from URI', async () => {
      const targetUri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';
      let activeSessionId = '';
      let receivedEvents = '';

      await new Promise<void>((resolve, reject) => {
        const sseReq = request(app)
          .get('/api/mcp/sse')
          .set('Authorization', 'Bearer valid-token')
          .buffer(false)
          .parse((res: any) => {
            res.on('data', (chunk: any) => {
              receivedEvents += chunk.toString();
              const match = /sessionId=([0-9a-f-]{36})/.exec(receivedEvents);
              if (match && !activeSessionId) {
                activeSessionId = match[1];
                resolve();
              }
            });
            res.on('error', reject);
          });
        sseReq.on('error', () => {});
        sseReq.end();
      });

      // Subscribe
      await request(app)
        .post(`/api/mcp/messages?sessionId=${activeSessionId}`)
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 101,
          method: 'resources/subscribe',
          params: { uri: targetUri },
        });

      await new Promise((r) => setTimeout(r, 50));

      // Unsubscribe
      await request(app)
        .post(`/api/mcp/messages?sessionId=${activeSessionId}`)
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 102,
          method: 'resources/unsubscribe',
          params: { uri: targetUri },
        });

      await new Promise((r) => setTimeout(r, 50));

      receivedEvents = '';
      const count = router.notifyResourceUpdated(targetUri);
      expect(count).toBe(0);

      await new Promise((r) => setTimeout(r, 50));
      expect(receivedEvents).not.toContain('notifications/resources/updated');

      router.sessionManager.closeSession(activeSessionId);
    });
  });

  describe('Suite 5: Resource URI Parser Unit Tests', () => {
    it('TC-URI-001: Parses valid runs, findings, and charters URIs', () => {
      const run = parseResourceUri('review-yeti://runs/calltelemetry/cisco-cdr/456');
      expect(run).toEqual({
        type: 'runs',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        prNumber: 456,
      });

      const finding = parseResourceUri('review-yeti://findings/calltelemetry/review-yeti-bot/789');
      expect(finding).toEqual({
        type: 'findings',
        owner: 'calltelemetry',
        repo: 'review-yeti-bot',
        prNumber: 789,
      });

      const charter = parseResourceUri('review-yeti://charters/calltelemetry/cisco-cdr');
      expect(charter).toEqual({
        type: 'charters',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
      });
    });

    it('TC-URI-002: Rejects invalid schemes or non-positive PR numbers', () => {
      expect(parseResourceUri('https://example.com')).toBeNull();
      expect(parseResourceUri('review-yeti://runs/owner/repo/0')).toBeNull();
      expect(parseResourceUri('review-yeti://runs/owner/repo/-5')).toBeNull();
      expect(parseResourceUri('review-yeti://runs/owner/repo/abc')).toBeNull();
      expect(parseResourceUri('review-yeti://invalid/owner/repo')).toBeNull();
      expect(parseResourceUri('')).toBeNull();
    });
  });
});
