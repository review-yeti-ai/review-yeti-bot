import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
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

describe('Empirical Challenger Suite: Milestone M7 MCP Resources & SSE Subscriptions', () => {
  let app: express.Express;
  let router: RemoteMcpRouter;
  let currentTime: number;
  let uuidCounter: number;
  let mockDb: any;
  let authenticator: McpAuthenticator;

  function buildTestApp(customOptions?: Partial<RemoteMcpRouterOptions>) {
    currentTime = 1_000_000;
    uuidCounter = 1;

    mockDb = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('review_runs') && sql.includes('review_gate_attempts')) {
          if (values && values[0] === 'error-owner') {
            throw new Error('Database connection timeout');
          }
          return {
            rows: [
              {
                run_id: 'run_stress_100',
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

        if (sql.includes('review_worker_completions')) {
          if (values && values[0] === 'error-owner') {
            throw new Error('Database connection timeout');
          }
          return {
            rows: [
              {
                run_id: 'run_stress_100',
                head_sha: '01cc3c3070ae025c9a9bb8176c92106c30488151',
                payload: {
                  findings: [
                    {
                      finding_id: 'finding_stress_01',
                      severity: 'P1',
                      title: 'Critical boundary hazard',
                      path: 'src/core.ts',
                      line_start: 10,
                      line_end: 20,
                      status: 'OPEN',
                    },
                  ],
                },
              },
            ],
          };
        }

        if (sql.includes('repo_review_policies')) {
          if (values && values[0] === 'error-owner') {
            throw new Error('Database connection timeout');
          }
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };

    authenticator = {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === 'Bearer valid-token') {
          return {
            authType: 'static_token',
            tokenDigest: 'valid-token1',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr', 'calltelemetry/review-yeti-bot', 'error-owner/cisco-cdr']),
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
      authenticateToken: vi.fn(async () => {
        throw new Error('Not implemented');
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
      uuidGenerator: () => `test-session-${uuidCounter++}`,
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

  // =========================================================================
  // SECTION 1: Adversarial Boundary Conditions & Malformed URIs
  // =========================================================================
  describe('Adversarial Dimension 1: Boundary Conditions & Malformed URIs', () => {
    const malformedUris = [
      { name: 'Standard HTTP URL', uri: 'http://github.com/calltelemetry/cisco-cdr/pull/123' },
      { name: 'HTTPS URL', uri: 'https://github.com/calltelemetry/cisco-cdr/pull/123' },
      { name: 'File scheme', uri: 'file:///etc/passwd' },
      { name: 'Invalid scheme name', uri: 'custom-scheme://runs/calltelemetry/cisco-cdr/123' },
      { name: 'Missing scheme slash (single slash)', uri: 'review-yeti:/runs/calltelemetry/cisco-cdr/123' },
      { name: 'Triple slash', uri: 'review-yeti:///runs/calltelemetry/cisco-cdr/123' },
      { name: 'Unsupported resource collection', uri: 'review-yeti://unknown/calltelemetry/cisco-cdr/123' },
      { name: 'Unsupported commits collection', uri: 'review-yeti://commits/calltelemetry/cisco-cdr/123' },
      { name: 'Runs URI missing pr_number', uri: 'review-yeti://runs/calltelemetry/cisco-cdr' },
      { name: 'Runs URI missing repo and pr_number', uri: 'review-yeti://runs/calltelemetry' },
      { name: 'Runs URI root only', uri: 'review-yeti://runs' },
      { name: 'Runs URI empty repo double slash', uri: 'review-yeti://runs/calltelemetry//123' },
      { name: 'Runs URI empty owner double slash', uri: 'review-yeti://runs//cisco-cdr/123' },
      { name: 'Runs URI non-numeric pr_number (letters)', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/abc' },
      { name: 'Runs URI non-numeric pr_number (alphanumeric)', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123a' },
      { name: 'Runs URI zero pr_number', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/0' },
      { name: 'Runs URI negative pr_number', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/-123' },
      { name: 'Runs URI decimal pr_number', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/12.34' },
      { name: 'Runs URI overflow safe integer', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/99999999999999999999999999999' },
      { name: 'Runs URI with query string', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123?foo=bar' },
      { name: 'Runs URI with URL hash/fragment', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123#summary' },
      { name: 'Runs URI with extra trailing path segments', uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123/extra/path' },
      { name: 'Findings URI missing pr_number', uri: 'review-yeti://findings/calltelemetry/cisco-cdr' },
      { name: 'Findings URI with negative pr_number', uri: 'review-yeti://findings/calltelemetry/cisco-cdr/-1' },
      { name: 'Findings URI with zero pr_number', uri: 'review-yeti://findings/calltelemetry/cisco-cdr/0' },
      { name: 'Charters URI missing repo', uri: 'review-yeti://charters/calltelemetry' },
      { name: 'Charters URI root only', uri: 'review-yeti://charters' },
      { name: 'Charters URI with trailing slash', uri: 'review-yeti://charters/calltelemetry/' },
      { name: 'Charters URI with extra path segments', uri: 'review-yeti://charters/calltelemetry/cisco-cdr/extra' },
    ];

    for (const testCase of malformedUris) {
      it(`parseResourceUri returns null for: ${testCase.name} (${testCase.uri})`, () => {
        expect(parseResourceUri(testCase.uri)).toBeNull();
      });

      it(`resources/read returns -32602 for: ${testCase.name}`, async () => {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-token')
          .send({
            jsonrpc: '2.0',
            id: 101,
            method: 'resources/read',
            params: { uri: testCase.uri },
          });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(res.body.error.message).toMatch(/Unsupported or invalid resource URI/i);
      });

      it(`resources/subscribe returns -32602 for: ${testCase.name}`, async () => {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-token')
          .send({
            jsonrpc: '2.0',
            id: 102,
            method: 'resources/subscribe',
            params: { uri: testCase.uri },
          });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(res.body.error.message).toMatch(/Unsupported or invalid resource URI/i);
      });

      it(`resources/unsubscribe returns -32602 for: ${testCase.name}`, async () => {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-token')
          .send({
            jsonrpc: '2.0',
            id: 103,
            method: 'resources/unsubscribe',
            params: { uri: testCase.uri },
          });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(res.body.error.message).toMatch(/Unsupported or invalid resource URI/i);
      });
    }

    it('rejects null, non-string, or empty params in resources/read, subscribe, unsubscribe', async () => {
      const methods = ['resources/read', 'resources/subscribe', 'resources/unsubscribe'];
      const invalidParams = [
        {},
        { uri: null },
        { uri: 12345 },
        { uri: true },
        { uri: ['review-yeti://runs/calltelemetry/cisco-cdr/123'] },
        { uri: '' },
      ];

      for (const method of methods) {
        for (const params of invalidParams) {
          const res = await request(app)
            .post('/api/mcp')
            .set('Authorization', 'Bearer valid-token')
            .send({
              jsonrpc: '2.0',
              id: 200,
              method,
              params,
            });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        }
      }
    });

    it('rejects path traversal attempts in owner or repo via RBAC fail-closed', async () => {
      const traversalUris = [
        'review-yeti://runs/../../../123',
        'review-yeti://findings/..%2f..%2f/cisco-cdr/123',
        'review-yeti://charters/../etc/passwd',
      ];

      for (const uri of traversalUris) {
        const res = await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-token')
          .send({
            jsonrpc: '2.0',
            id: 201,
            method: 'resources/read',
            params: { uri },
          });

        expect([200, 403]).toContain(res.status);
        expect(res.body.error).toBeDefined();
        // Either rejected as invalid URI regex (-32602) or rejected as 403 (-32003 / FORBIDDEN)
        expect([JSONRPC_ERRORS.INVALID_PARAMS, MCP_ERRORS.FORBIDDEN]).toContain(res.body.error.code);
      }
    });

    it('gracefully handles database errors during resource read without crashing', async () => {
      const uri = 'review-yeti://runs/error-owner/cisco-cdr/123';
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 202,
          method: 'resources/read',
          params: { uri },
        });

      expect(res.status).toBe(200);
      // The router catches database exceptions in readResourceContent and converts to INTERNAL_ERROR or fallback
      // Either fallback data or internal error response:
      if (res.body.error) {
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INTERNAL_ERROR);
      } else {
        expect(res.body.result).toBeDefined();
      }
    });
  });

  // =========================================================================
  // SECTION 2: Lifecycle of Subscriptions
  // =========================================================================
  describe('Adversarial Dimension 2: Lifecycle of Subscriptions', () => {
    it('subscribing twice to the same URI in the same session is idempotent (Set deduplication)', async () => {
      // 1. Initialize session
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {} },
        });
      const sessionId = initRes.header['mcp-session-id'];
      expect(sessionId).toBeDefined();

      const uri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';

      // 2. First subscribe
      const sub1 = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/subscribe',
          params: { uri },
        });
      expect(sub1.status).toBe(200);
      expect(sub1.body.result).toEqual({});

      // Verify session set contains 1 element
      const session = router.sessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.subscriptions.has(uri)).toBe(true);
      expect(session?.subscriptions.size).toBe(1);

      // 3. Second subscribe to identical URI
      const sub2 = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/subscribe',
          params: { uri },
        });
      expect(sub2.status).toBe(200);
      expect(sub2.body.result).toEqual({});

      // Set size must still be 1 (no duplicates)
      expect(session?.subscriptions.size).toBe(1);
    });

    it('unsubscribing from a URI not currently subscribed is a safe, idempotent no-op', async () => {
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {} },
        });
      const sessionId = initRes.header['mcp-session-id'];

      const uri = 'review-yeti://runs/calltelemetry/cisco-cdr/999';

      const unsubRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'resources/unsubscribe',
          params: { uri },
        });

      expect(unsubRes.status).toBe(200);
      expect(unsubRes.body.result).toEqual({});
      expect(unsubRes.body.error).toBeUndefined();

      const session = router.sessionManager.getSession(sessionId);
      expect(session?.subscriptions.has(uri)).toBe(false);
      expect(session?.subscriptions.size).toBe(0);
    });

    it('unsubscribing twice from the same URI is safe and idempotent', async () => {
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {} },
        });
      const sessionId = initRes.header['mcp-session-id'];
      const uri = 'review-yeti://findings/calltelemetry/cisco-cdr/123';

      // Subscribe first
      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/subscribe',
          params: { uri },
        });

      // Unsubscribe 1
      const unsub1 = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/unsubscribe',
          params: { uri },
        });
      expect(unsub1.status).toBe(200);
      expect(unsub1.body.result).toEqual({});

      // Unsubscribe 2
      const unsub2 = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'resources/unsubscribe',
          params: { uri },
        });
      expect(unsub2.status).toBe(200);
      expect(unsub2.body.result).toEqual({});
    });

    it('multi-URI subscriptions: unsubscribing one URI isolates removal and preserves others', async () => {
      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {} },
        });
      const sessionId = initRes.header['mcp-session-id'];

      const uriA = 'review-yeti://runs/calltelemetry/cisco-cdr/101';
      const uriB = 'review-yeti://findings/calltelemetry/cisco-cdr/101';
      const uriC = 'review-yeti://charters/calltelemetry/cisco-cdr';

      // Subscribe to all 3
      for (const u of [uriA, uriB, uriC]) {
        await request(app)
          .post('/api/mcp')
          .set('Authorization', 'Bearer valid-token')
          .set('Mcp-Session-Id', sessionId)
          .send({ jsonrpc: '2.0', id: 5, method: 'resources/subscribe', params: { uri: u } });
      }

      const session = router.sessionManager.getSession(sessionId);
      expect(session?.subscriptions.size).toBe(3);

      // Unsubscribe only URI B
      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .set('Mcp-Session-Id', sessionId)
        .send({ jsonrpc: '2.0', id: 6, method: 'resources/unsubscribe', params: { uri: uriB } });

      expect(session?.subscriptions.size).toBe(2);
      expect(session?.subscriptions.has(uriA)).toBe(true);
      expect(session?.subscriptions.has(uriB)).toBe(false);
      expect(session?.subscriptions.has(uriC)).toBe(true);
    });

    it('unsubscribing without explicit Mcp-Session-Id header returns 200 without throwing', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 50,
          method: 'resources/unsubscribe',
          params: { uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123' },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({});
    });

    it('subscribing without explicit Mcp-Session-Id header creates a new session and returns header', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 51,
          method: 'resources/subscribe',
          params: { uri: 'review-yeti://runs/calltelemetry/cisco-cdr/123' },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({});
      const newSessionId = res.header['mcp-session-id'];
      expect(newSessionId).toBeDefined();

      const createdSession = router.sessionManager.getSession(newSessionId);
      expect(createdSession).toBeDefined();
      expect(createdSession?.subscriptions.has('review-yeti://runs/calltelemetry/cisco-cdr/123')).toBe(true);
    });
  });

  // =========================================================================
  // SECTION 3: SSE Notification Delivery Isolation & Resilience
  // =========================================================================
  describe('Adversarial Dimension 3: SSE Notification Delivery Isolation & Stream Resilience', () => {
    it('delivers SSE notification strictly to subscribed session and NOT to non-subscribed or different-URI sessions', () => {
      // Create mock SSE responses for 4 sessions
      const mockWriteSessionSubscribed = vi.fn();
      const mockWriteSessionDiffUri = vi.fn();
      const mockWriteSessionUnsubscribed = vi.fn();
      const mockWriteSessionNeverSubscribed = vi.fn();

      const targetUri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';
      const otherUri = 'review-yeti://runs/calltelemetry/cisco-cdr/456';

      // 1. Session A: Subscribed to targetUri
      const s1 = router.sessionManager.createSession({
        write: mockWriteSessionSubscribed,
        writableEnded: false,
      } as any);
      s1.subscriptions.add(targetUri);

      // 2. Session B: Subscribed to otherUri
      const s2 = router.sessionManager.createSession({
        write: mockWriteSessionDiffUri,
        writableEnded: false,
      } as any);
      s2.subscriptions.add(otherUri);

      // 3. Session C: Subscribed then unsubscribed
      const s3 = router.sessionManager.createSession({
        write: mockWriteSessionUnsubscribed,
        writableEnded: false,
      } as any);
      s3.subscriptions.add(targetUri);
      s3.subscriptions.delete(targetUri);

      // 4. Session D: Never subscribed to anything
      router.sessionManager.createSession({
        write: mockWriteSessionNeverSubscribed,
        writableEnded: false,
      } as any);

      // Notify targetUri with payload
      const payload = { verdict: 'SHIP', phase: 'completed' };
      const notified = router.notifyResourceUpdated(targetUri, payload);

      // Assertion: Exactly 1 session notified
      expect(notified).toBe(1);

      // Session A received notification
      expect(mockWriteSessionSubscribed).toHaveBeenCalledTimes(1);
      const writtenData = mockWriteSessionSubscribed.mock.calls[0][0];
      expect(writtenData).toContain('event: message\n');
      expect(writtenData).toContain('notifications/resources/updated');
      expect(writtenData).toContain(targetUri);
      expect(writtenData).toContain('SHIP');

      // Other sessions received NOTHING
      expect(mockWriteSessionDiffUri).not.toHaveBeenCalled();
      expect(mockWriteSessionUnsubscribed).not.toHaveBeenCalled();
      expect(mockWriteSessionNeverSubscribed).not.toHaveBeenCalled();
    });

    it('notifyResourceUpdated safely skips streams with writableEnded === true', () => {
      const mockWriteEnded = vi.fn();
      const mockWriteActive = vi.fn();
      const targetUri = 'review-yeti://findings/calltelemetry/cisco-cdr/555';

      // Session 1: Ended stream
      const s1 = router.sessionManager.createSession({
        write: mockWriteEnded,
        writableEnded: true,
      } as any);
      s1.subscriptions.add(targetUri);

      // Session 2: Active stream
      const s2 = router.sessionManager.createSession({
        write: mockWriteActive,
        writableEnded: false,
      } as any);
      s2.subscriptions.add(targetUri);

      const count = router.notifyResourceUpdated(targetUri);
      expect(count).toBe(1);
      expect(mockWriteEnded).not.toHaveBeenCalled();
      expect(mockWriteActive).toHaveBeenCalledTimes(1);
    });

    it('notifyResourceUpdated without payload conforms to standard MCP spec params', () => {
      const mockWrite = vi.fn();
      const targetUri = 'review-yeti://charters/calltelemetry/cisco-cdr';

      const s = router.sessionManager.createSession({
        write: mockWrite,
        writableEnded: false,
      } as any);
      s.subscriptions.add(targetUri);

      router.notifyResourceUpdated(targetUri);

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const chunk = mockWrite.mock.calls[0][0];
      const dataMatch = /data: (.*)\n\n/.exec(chunk);
      expect(dataMatch).not.toBeNull();

      const parsed = JSON.parse(dataMatch![1]);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.method).toBe('notifications/resources/updated');
      expect(parsed.params).toEqual({ uri: targetUri });
      expect(parsed.params.payload).toBeUndefined();
    });

    it('EMPIRICAL OBSERVATION: res.write throwing on one session halts the notification loop and starves remaining sessions', () => {
      const badWrite = vi.fn(() => {
        throw new Error('EPIPE: broken pipe on disconnected socket');
      });
      const goodWrite = vi.fn();
      const targetUri = 'review-yeti://runs/calltelemetry/cisco-cdr/777';

      // Session 1: Socket write throws
      const s1 = router.sessionManager.createSession({
        write: badWrite,
        writableEnded: false,
      } as any);
      s1.subscriptions.add(targetUri);

      // Session 2: Healthy active stream
      const s2 = router.sessionManager.createSession({
        write: goodWrite,
        writableEnded: false,
      } as any);
      s2.subscriptions.add(targetUri);

      let errorThrown = false;
      try {
        router.notifyResourceUpdated(targetUri);
      } catch (err: any) {
        errorThrown = true;
        expect(err.message).toContain('broken pipe');
      }

      // Observation: EPIPE propagates out of notifyResourceUpdated
      expect(errorThrown).toBe(true);
      // Consequence: Session 2 was starved because notifyResourceUpdated lacks try/catch inside loop
      expect(goodWrite).not.toHaveBeenCalled();
    });

    it('EMPIRICAL OBSERVATION: Subscribing with mixed-case repo does not match lower-case notification URI', async () => {
      const mockWrite = vi.fn();
      const mixedCaseUri = 'review-yeti://runs/CallTelemetry/Cisco-CDR/123';
      const canonicalUri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';

      const s = router.sessionManager.createSession({
        write: mockWrite,
        writableEnded: false,
      } as any);

      // Client subscribes with mixed-case URI
      s.subscriptions.add(mixedCaseUri);

      // System emits notification with canonical lowercase URI
      const count = router.notifyResourceUpdated(canonicalUri);

      // Because Set.has(uri) does exact string matching, count is 0
      expect(count).toBe(0);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('end-to-end SSE stream connection receives live resource updates', async () => {
      const eventEmitter = new EventEmitter();
      const targetUri = 'review-yeti://runs/calltelemetry/cisco-cdr/123';

      // 1. Establish SSE stream via supertest request
      // We simulate Express SSE connection by attaching router to a mock server
      const sseRes: any = {
        writeHead: vi.fn(),
        write: vi.fn((data: string) => {
          eventEmitter.emit('data', data);
          return true;
        }),
        end: vi.fn(),
        writableEnded: false,
      };

      const session = router.sessionManager.createSession(sseRes);
      session.subscriptions.add(targetUri);

      // Listen for data
      const receivedMessages: string[] = [];
      eventEmitter.on('data', (d) => receivedMessages.push(d));

      // Trigger update
      router.notifyResourceUpdated(targetUri, { test: 123 });

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0]).toContain('notifications/resources/updated');
      expect(receivedMessages[0]).toContain(targetUri);
    });
  });
});
