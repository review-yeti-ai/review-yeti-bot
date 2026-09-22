import express, { type Request, type Response } from 'express';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  createTriggerReviewTool,
} from '../../src/mcp/server/tools/triggerReview';
import {
  createCancelReviewTool,
} from '../../src/mcp/server/tools/cancelReview';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';

describe('Empirical Challenger 2: Lifecycle, Concurrency & Race Condition Stress Harness', () => {
  const TEST_TOKEN = 'stress_test_token_12345';
  let activeServers: http.Server[] = [];

  function createMockAuthenticator(): McpAuthenticator {
    return {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === `Bearer ${TEST_TOKEN}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest-stress',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
            callerId: 'stress-tester',
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === TEST_TOKEN) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest-stress',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
            callerId: 'stress-tester',
          };
        }
        throw new McpAuthError('Unauthorized');
      }) as any,
      checkRepositoryAccess: vi.fn((caller: McpAuthenticatedCaller, owner: string, repo: string) => {
        if (caller.isAdmin) return true;
        return caller.allowedRepositories?.has(`${owner}/${repo}`.toLowerCase()) ?? false;
      }),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;
  }

  afterEach(async () => {
    for (const s of activeServers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    activeServers = [];
  });

  // ===========================================================================
  // SECTION 1: CONCURRENT SESSION HANDSHAKES & CEILING ENFORCEMENT
  // ===========================================================================
  describe('1. Concurrent Session Handshakes and Capacity Ceilings', () => {
    it('STRESS-SESS-001: 150 concurrent initialize requests strictly enforce maxSessions limit (100)', async () => {
      const MAX_SESSIONS = 100;
      const CONCURRENT_REQUESTS = 150;

      const router = createRemoteMcpRouter({
        authenticator: createMockAuthenticator(),
        maxSessions: MAX_SESSIONS,
      });

      const app = express();
      app.use(express.json());
      app.use('/api/mcp', router);

      const promises = Array.from({ length: CONCURRENT_REQUESTS }).map((_, i) =>
        request(app)
          .post('/api/mcp')
          .set('Authorization', `Bearer ${TEST_TOKEN}`)
          .send({
            jsonrpc: '2.0',
            id: `init-${i}`,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'stress-client', version: '1.0.0' },
            },
          })
      );

      const responses = await Promise.all(promises);

      const successful = responses.filter((r) => r.status === 200 && !r.body.error);
      const rateLimited = responses.filter((r) => r.status === 429);

      expect(successful).toHaveLength(MAX_SESSIONS);
      expect(rateLimited).toHaveLength(CONCURRENT_REQUESTS - MAX_SESSIONS);

      for (const limited of rateLimited) {
        expect(limited.body.error.code).toBe(MCP_ERRORS.TOO_MANY_SESSIONS);
        expect(limited.body.error.message).toContain('Maximum concurrent MCP sessions exceeded');
      }

      const sessionIds = new Set(successful.map((r) => r.header['mcp-session-id']));
      expect(sessionIds.size).toBe(MAX_SESSIONS);

      expect(router.sessionManager.activeSessionCount()).toBe(MAX_SESSIONS);

      router.destroy();
    });

    it('STRESS-SESS-002: 50 concurrent SSE connections enforce maxSessions limit and receive endpoint events', async () => {
      const MAX_SESSIONS = 25;
      const TOTAL_CONCURRENT = 35;

      const router = createRemoteMcpRouter({
        authenticator: createMockAuthenticator(),
        maxSessions: MAX_SESSIONS,
      });

      const app = express();
      app.use(express.json());
      app.use('/api/mcp', router);

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, () => resolve()));
      activeServers.push(server);
      const port = (server.address() as any).port;

      const clientRequests: http.ClientRequest[] = [];
      const sessionIdsReceived: string[] = [];
      let rejected429Count = 0;

      const connectPromises = Array.from({ length: TOTAL_CONCURRENT }).map(() => {
        return new Promise<void>((resolve) => {
          const reqSse = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/mcp/sse',
            method: 'GET',
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
          });
          clientRequests.push(reqSse);

          reqSse.on('response', (res) => {
            if (res.statusCode === 429) {
              rejected429Count++;
              resolve();
              return;
            }
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString('utf8');
              const match = /sessionId=([a-f0-9-]+)/.exec(data);
              if (match) {
                sessionIdsReceived.push(match[1]);
                resolve();
              }
            });
          });
          reqSse.end();
        });
      });

      await Promise.all(connectPromises);

      expect(sessionIdsReceived).toHaveLength(MAX_SESSIONS);
      expect(rejected429Count).toBe(TOTAL_CONCURRENT - MAX_SESSIONS);
      expect(router.sessionManager.activeSessionCount()).toBe(MAX_SESSIONS);

      for (const creq of clientRequests) {
        creq.destroy();
      }

      await new Promise((r) => setTimeout(r, 100));
      expect(router.sessionManager.activeSessionCount()).toBe(0);

      router.destroy();
    });
  });

  // ===========================================================================
  // SECTION 2: SESSION EXPIRATION, ACTIVITY TOUCHING & TTL
  // ===========================================================================
  describe('2. Session Expiration, TTL & Touch Prolongation', () => {
    it('STRESS-TTL-001: Session expires after TTL, touching extends TTL, expired session is 404', async () => {
      let virtualNow = 1_000_000;
      const SESSION_TTL_MS = 60_000;

      const router = createRemoteMcpRouter({
        authenticator: createMockAuthenticator(),
        sessionTtlMs: SESSION_TTL_MS,
        now: () => virtualNow,
      });

      const app = express();
      app.use(express.json());
      app.use('/api/mcp', router);

      const initRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'init-ttl',
          method: 'initialize',
          params: {},
        });

      expect(initRes.status).toBe(200);
      const sessionId = initRes.header['mcp-session-id'];
      expect(sessionId).toBeTruthy();

      virtualNow += 40_000;

      const pingRes = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 'ping-touch',
          method: 'ping',
        });

      expect(pingRes.status).toBe(200);

      virtualNow += 40_000;

      expect(router.sessionManager.getSession(sessionId)).toBeDefined();
      expect(router.sessionManager.activeSessionCount()).toBe(1);

      virtualNow += 70_000;

      expect(router.sessionManager.getSession(sessionId)).toBeUndefined();
      expect(router.sessionManager.activeSessionCount()).toBe(0);

      const msgRes = await request(app)
        .post(`/api/mcp/messages?sessionId=${sessionId}`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'msg-expired',
          method: 'ping',
        });

      expect(msgRes.status).toBe(404);
      expect(msgRes.body.error).toContain('Active SSE session not found');

      router.destroy();
    });
  });

  // ===========================================================================
  // SECTION 3: SSE KEEPALIVES & DISCONNECT CLEANUP
  // ===========================================================================
  describe('3. SSE Keepalive Frames & Graceful Abrupt Disconnects', () => {
    it('STRESS-SSE-001: Server sends periodic keepalive comments and cleans up on client hangup', async () => {
      const KEEPALIVE_MS = 25;

      const router = createRemoteMcpRouter({
        authenticator: createMockAuthenticator(),
        keepAliveMs: KEEPALIVE_MS,
      });

      const app = express();
      app.use('/api/mcp', router);

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, () => resolve()));
      activeServers.push(server);
      const port = (server.address() as any).port;

      let keepaliveCount = 0;
      let endpointReceived = false;

      const reqSse = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/mcp/sse',
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      const keepalivePromise = new Promise<void>((resolve) => {
        reqSse.on('response', (res) => {
          res.on('data', (chunk) => {
            const str = chunk.toString('utf8');
            if (str.includes('event: endpoint')) {
              endpointReceived = true;
            }
            if (str.includes(': keepalive')) {
              keepaliveCount++;
              if (keepaliveCount >= 3) {
                resolve();
              }
            }
          });
        });
      });

      reqSse.end();
      await keepalivePromise;

      expect(endpointReceived).toBe(true);
      expect(keepaliveCount).toBeGreaterThanOrEqual(3);
      expect(router.sessionManager.activeSessionCount()).toBe(1);

      reqSse.destroy();
      await new Promise((r) => setTimeout(r, 60));

      expect(router.sessionManager.activeSessionCount()).toBe(0);

      router.destroy();
    });
  });

  // ===========================================================================
  // SECTION 4: RACE CONDITIONS BETWEEN TRIGGER_REVIEW AND CANCEL_REVIEW
  // ===========================================================================
  describe('4. Race Conditions: Concurrent trigger_review vs cancel_review', () => {
    class MockReviewDatabase {
      private runs = new Map<string, any>();
      private outbox = new Map<string, any>();

      constructor(initialRuns: any[] = []) {
        for (const r of initialRuns) {
          this.runs.set(r.run_id, { ...r });
        }
      }

      async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5) + 1));

        if (sql.includes('SELECT run_id, attempt, status, head_sha') || sql.includes('SELECT run_id, attempt, head_sha, lease_owner, status')) {
          const owner = params[0];
          const repo = params[1];
          const prNumber = params[2];

          const matched = Array.from(this.runs.values()).filter(
            (r) =>
              r.owner === owner &&
              r.repo === repo &&
              r.pr_number === prNumber &&
              ['queued', 'running', 'publishing'].includes(r.status)
          );
          return { rows: matched.slice(0, 1) };
        }

        if (sql.includes('UPDATE review_runs') && sql.includes("status = 'cancelled'")) {
          const runId = params[0];
          const reason = params[1] || 'superseded';
          const r = this.runs.get(runId);
          if (r) {
            r.status = 'cancelled';
            r.error_text = reason;
            r.lease_owner = null;
          }
          return { rows: [] };
        }

        if (sql.includes('UPDATE review_dispatch_outbox')) {
          const runId = params[0];
          const o = this.outbox.get(runId);
          if (o) o.status = 'terminal';
          return { rows: [] };
        }

        return { rows: [] };
      }

      getRun(runId: string) {
        return this.runs.get(runId);
      }

      addRun(run: any) {
        this.runs.set(run.run_id, run);
      }
    }

    it('RACE-001: Concurrent trigger_review(force: false) and cancel_review on active run resolves deterministically without exception', async () => {
      const db = new MockReviewDatabase([
        {
          run_id: 'run_active_pr_99',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 99,
          attempt: 1,
          status: 'running',
          head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          lease_owner: 'worker-pod-99',
        },
      ]);

      const triggerTool = createTriggerReviewTool({ queryableDatabase: db as any });
      const cancelTool = createCancelReviewTool({ queryableDatabase: db as any });

      const triggerPromise = triggerTool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 99,
        head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        force: false,
      });

      const cancelPromise = cancelTool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 99,
        reason: 'User cancelled due to urgent bugfix commit',
      });

      const [triggerOutcome, cancelOutcome] = await Promise.allSettled([triggerPromise, cancelPromise]);

      if (cancelOutcome.status === 'fulfilled') {
        const cancelData = JSON.parse((cancelOutcome.value.content[0] as any).text);
        expect(cancelData.cancelled).toBe(true);
        expect(db.getRun('run_active_pr_99')?.status).toBe('cancelled');
      }

      if (triggerOutcome.status === 'rejected') {
        expect(triggerOutcome.reason.code).toBe(409);
      }
    });

    it('RACE-002: 20 concurrent cancel_review requests against same active run all settle gracefully without corrupting state', async () => {
      const db = new MockReviewDatabase([
        {
          run_id: 'run_heavy_cancel_pr_100',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 100,
          attempt: 1,
          status: 'running',
          head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          lease_owner: 'worker-pod-100',
        },
      ]);

      const cancelTool = createCancelReviewTool({ queryableDatabase: db as any });

      const CONCURRENCY = 20;
      const cancelPromises = Array.from({ length: CONCURRENCY }).map((_, i) =>
        cancelTool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 100,
          reason: `Concurrent cancel request ${i}`,
        })
      );

      const outcomes = await Promise.allSettled(cancelPromises);

      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      for (const f of fulfilled) {
        if (f.status === 'fulfilled') {
          const data = JSON.parse((f.value.content[0] as any).text);
          expect(data.cancelled).toBe(true);
        }
      }

      for (const r of rejected) {
        if (r.status === 'rejected') {
          expect(r.reason.message).toContain('No active review run found');
        }
      }

      expect(db.getRun('run_heavy_cancel_pr_100')?.status).toBe('cancelled');
    });

    it('RACE-003: 20 concurrent trigger_review(force: false) requests against an in-flight run all safely 409 Conflict', async () => {
      const db = new MockReviewDatabase([
        {
          run_id: 'run_locked_pr_200',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 200,
          attempt: 1,
          status: 'running',
          head_sha: 'cccccccccccccccccccccccccccccccccccccccc',
        },
      ]);

      const triggerTool = createTriggerReviewTool({ queryableDatabase: db as any });

      const CONCURRENCY = 20;
      const triggerPromises = Array.from({ length: CONCURRENCY }).map(() =>
        triggerTool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 200,
          head_sha: 'cccccccccccccccccccccccccccccccccccccccc',
          force: false,
        })
      );

      const outcomes = await Promise.allSettled(triggerPromises);

      expect(outcomes).toHaveLength(CONCURRENCY);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.reason.code).toBe(409);
          expect(outcome.reason.message).toContain('Conflict: Review attempt run_locked_pr_200 is currently running');
        }
      }
    });

    it('RACE-004: force dispatches a new identity without pre-cancelling active state', async () => {
      const db = new MockReviewDatabase([
        {
          run_id: 'run_to_supersede_300',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 300,
          attempt: 1,
          status: 'running',
          head_sha: 'dddddddddddddddddddddddddddddddddddddddd',
        },
      ]);

      const mockAdmit = vi.fn(async () => ({
        run: { runId: 'run_new_superseded_300' },
      }));
      const triggerTool = createTriggerReviewTool({
        queryableDatabase: db as any,
        admissionRepository: { admit: mockAdmit as any },
        resolveGitHubPullRequest: async () => ({
          headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          baseSha: 'f'.repeat(40), repositoryId: 1001, installationId: 2001,
        }),
        authoritativePublishing: {
          expectedAppId: 4385771, repositoryIds: [1001],
          resolver: { resolve: async (requested: any) => ({
            identity: requested,
            prepared: { policy: {
              effectivePolicyDigest: '1'.repeat(64),
              effectiveConfigDigest: '2'.repeat(64),
            } },
          }) },
        } as any,
      });

      const outcome = await triggerTool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 300,
        head_sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        force: true,
      });

      const data = JSON.parse((outcome.content[0] as any).text);
      expect(data.dispatched).toBe(true);
      expect(data.job_crd_created).toBe(false);
      expect(db.getRun('run_to_supersede_300')?.status).toBe('running');
      expect(mockAdmit).toHaveBeenCalled();
    });
  });
});
