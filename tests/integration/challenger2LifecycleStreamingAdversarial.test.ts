import express, { type Request, type Response } from 'express';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
  type McpExecutionContext,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  createTriggerReviewTool,
  type TriggerReviewDependencies,
} from '../../src/mcp/server/tools/triggerReview';
import {
  createCancelReviewTool,
  type CancelReviewDependencies,
} from '../../src/mcp/server/tools/cancelReview';
import {
  createWatchReviewProgressTool,
  type WatchReviewProgressDependencies,
  type JetStreamProgressEvent,
} from '../../src/mcp/server/tools/watchReviewProgress';
import {
  createPreflightDiffReviewTool,
  parseUnifiedDiff,
  type PreflightDiffReviewDependencies,
} from '../../src/mcp/server/tools/preflightDiffReview';
import {
  TriggerReviewInputSchema,
  CancelReviewInputSchema,
  WatchReviewProgressInputSchema,
  PreflightDiffReviewInputSchema,
  MAX_PREFLIGHT_DIFF_BYTES,
} from '../../src/mcp/server/tools/schemas';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';

describe('Adversarial Lifecycle, Streaming & Preflight Verification (Challenger 2 — Milestone 2)', () => {
  const TEST_AUTH_TOKEN = 'challenger2_m2_adversarial_bearer_token';
  const callerIdentity = 'challenger2-reviewer';

  let mockDb: any;
  let app: express.Express;
  let router: RemoteMcpRouter;
  let activeServers: http.Server[] = [];

  function createTestAuthenticator(): McpAuthenticator {
    return {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === `Bearer ${TEST_AUTH_TOKEN}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest-chal-2',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr', 'calltelemetry/pr-manager-mcp']),
            callerId: callerIdentity,
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === TEST_AUTH_TOKEN) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest-chal-2',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr', 'calltelemetry/pr-manager-mcp']),
            callerId: callerIdentity,
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

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    };

    router = createRemoteMcpRouter({
      authenticator: createTestAuthenticator(),
      db: mockDb,
    });

    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/mcp', router);
    activeServers = [];
  });

  afterEach(async () => {
    router.destroy();
    for (const s of activeServers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  // ===========================================================================
  // CHALLENGE 1: trigger_review — Concurrency, 409 Conflict & Force Bypass
  // ===========================================================================
  describe('Challenge 1: trigger_review Concurrency, Conflict & Force Bypass', () => {
    it('ADV-TRIG-001: Concurrent trigger attempts for same PR produce 409 Conflict on racing request', async () => {
      // Simulate state where an active run is in flight for PR 101
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('review_runs') && sql.includes('SELECT')) {
          return {
            rows: [
              {
                run_id: 'run_in_flight_101',
                attempt: 1,
                status: 'running',
                head_sha: '1111111111111111111111111111111111111111',
              },
            ],
          };
        }
        return { rows: [] };
      });

      const tool = createTriggerReviewTool({ queryableDatabase: mockDb });

      // Concurrent invocation without force flag
      const promise1 = tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 101,
        head_sha: '1111111111111111111111111111111111111111',
        force: false,
      });

      const promise2 = tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 101,
        head_sha: '1111111111111111111111111111111111111111',
        force: false,
      });

      const results = await Promise.allSettled([promise1, promise2]);

      // Both concurrent requests without force encounter the active run and reject with 409 Conflict
      for (const res of results) {
        expect(res.status).toBe('rejected');
        if (res.status === 'rejected') {
          expect(res.reason.message).toContain('Conflict: Review attempt run_in_flight_101 is currently running');
          expect(res.reason.code).toBe(409);
        }
      }
    });

    it('ADV-TRIG-002: Over-the-wire JSON-RPC returns error code 409 on conflict', async () => {
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('review_runs') && sql.includes('SELECT')) {
          return {
            rows: [{ run_id: 'run_active_http', status: 'running' }],
          };
        }
        return { rows: [] };
      });

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'rpc-trig-conflict',
          method: 'tools/call',
          params: {
            name: 'trigger_review',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pull_number: 102,
              head_sha: '2222222222222222222222222222222222222222',
              force: false,
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe('rpc-trig-conflict');
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(409);
      expect(res.body.error.message).toContain('Conflict: Review attempt run_active_http is currently running');
    });

    it('ADV-TRIG-003: force delegates supersession to governed admission without pre-cancelling', async () => {
      let runCancelled = false;
      let outboxTerminal = false;

      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('review_runs') && sql.includes('SELECT')) {
          return {
            rows: [
              {
                run_id: 'run_stale_to_override',
                attempt: 2,
                status: 'running',
                head_sha: '2222222222222222222222222222222222222222',
              },
            ],
          };
        }
        if (sql.includes('UPDATE review_runs') && sql.includes("status = 'cancelled'")) {
          runCancelled = true;
          return { rows: [] };
        }
        if (sql.includes('UPDATE review_dispatch_outbox') && sql.includes("status = 'terminal'")) {
          outboxTerminal = true;
          return { rows: [] };
        }
        return { rows: [] };
      });

      const mockAdmit = vi.fn(async () => ({
        run: { runId: 'run_newly_admitted_33333333333333' },
      }));
      const tool = createTriggerReviewTool({
        queryableDatabase: mockDb,
        admissionRepository: { admit: mockAdmit as any },
        resolveGitHubPullRequest: async () => ({
          headSha: '3333333333333333333333333333333333333333',
          baseSha: '4'.repeat(40), repositoryId: 1001, installationId: 2001,
        }),
        authoritativePublishing: {
          expectedAppId: 4385771, repositoryIds: [1001],
          resolver: { resolve: async (requested: any) => ({
            identity: requested,
            prepared: { policy: {
              effectivePolicyDigest: '5'.repeat(64),
              effectiveConfigDigest: '6'.repeat(64),
            } },
          }) },
        } as any,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 102,
        head_sha: '3333333333333333333333333333333333333333',
        force: true,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.dispatched).toBe(true);
      expect(data.job_crd_created).toBe(false);
      expect(runCancelled).toBe(false);
      expect(outboxTerminal).toBe(false);
      expect(mockAdmit).toHaveBeenCalled();
    });

    it('ADV-TRIG-004: Head SHA mismatch against GitHub PR throws error', async () => {
      const mockResolver = vi.fn(async (owner: string, repo: string, pullNumber: number) => ({
        headSha: 'ffffffffffffffffffffffffffffffffffffffff',
      }));

      const tool = createTriggerReviewTool({
        resolveGitHubPullRequest: mockResolver,
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 103,
          head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
      ).rejects.toThrow(/Specified head_sha .* does not match current GitHub PR #103 head SHA/);
    });

    it('ADV-TRIG-005: Schema rejects malformed commit SHAs (short, long, non-hex)', async () => {
      const invalidShas = [
        'short',
        '123456789012345678901234567890123456789', // 39 chars
        '12345678901234567890123456789012345678901', // 41 chars
        'gggggggggggggggggggggggggggggggggggggggg', // non-hex
      ];

      for (const badSha of invalidShas) {
        const parsed = TriggerReviewInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 104,
          head_sha: badSha,
        });
        expect(parsed.success).toBe(false);
      }
    });
  });

  // ===========================================================================
  // CHALLENGE 2: cancel_review — Missing Audit Reason & Finished Attempts
  // ===========================================================================
  describe('Challenge 2: cancel_review Audit Reason & Inactive Attempt Rejection', () => {
    it('ADV-CANC-001: Missing audit reason is rejected at Zod schema level with -32602', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'rpc-canc-missing-reason',
          method: 'tools/call',
          params: {
            name: 'cancel_review',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pull_number: 55,
              // reason omitted
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('Invalid parameters for tool cancel_review: Required');
    });

    it('ADV-CANC-002: Blank, empty, or whitespace-only reason is rejected', async () => {
      const emptyReasons = ['', '   ', '\t\n'];

      for (const blankReason of emptyReasons) {
        const parsed = CancelReviewInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 55,
          reason: blankReason,
        });
        expect(parsed.success).toBe(false);
      }

      // Also verify tool execute directly rejects empty reason
      const tool = createCancelReviewTool();
      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 55,
          reason: '   ',
        })
      ).rejects.toThrow(/Invalid arguments|non-empty reason/);
    });

    it('ADV-CANC-003: Cancellation of already-finished attempt throws Not Found error', async () => {
      // Query returns empty because run is 'completed' (not in 'queued','running','publishing')
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const tool = createCancelReviewTool({
        queryableDatabase: mockDb,
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 55,
          reason: 'Attempting to cancel already-finished review',
        })
      ).rejects.toThrow(/Not Found: No active review run found for calltelemetry\/cisco-cdr PR #55 to cancel/);
    });

    it('ADV-CANC-004: Over-the-wire cancel of already-finished attempt returns error envelope', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'rpc-canc-finished',
          method: 'tools/call',
          params: {
            name: 'cancel_review',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pull_number: 55,
              reason: 'Canceling finished job',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('No active review run found');
    });

    it('ADV-CANC-005: Valid cancellation updates DB, terminates outbox, and reaps pod', async () => {
      let dbUpdatedWithReason: string | undefined;
      let outboxTerminated = false;

      mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('review_runs') && sql.includes('SELECT')) {
          return {
            rows: [
              {
                run_id: 'run_to_cancel_live',
                attempt: 3,
                lease_owner: 'review-worker-pod-999',
                status: 'running',
              },
            ],
          };
        }
        if (sql.includes('UPDATE review_runs') && sql.includes("status = 'cancelled'")) {
          dbUpdatedWithReason = params[1];
          return { rows: [] };
        }
        if (sql.includes('UPDATE review_dispatch_outbox') && sql.includes("status = 'terminal'")) {
          outboxTerminated = true;
          return { rows: [] };
        }
        return { rows: [] };
      });

      const mockPatch = vi.fn(async () => ({ reapedPod: 'review-worker-pod-999', success: true }));

      const tool = createCancelReviewTool({
        queryableDatabase: mockDb,
        patchCancellation: mockPatch,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 55,
        reason: 'Security incident: malicious code detected in PR',
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.cancelled).toBe(true);
      expect(data.attempt_id).toBe('review-attempt-55-3');
      expect(data.reaped_pod).toBe('review-worker-pod-999');
      expect(dbUpdatedWithReason).toBe('Security incident: malicious code detected in PR');
      expect(outboxTerminated).toBe(true);
      expect(mockPatch).toHaveBeenCalledWith(
        'ct-review-to_cancel_live',
        'ct-review-system',
        'Security incident: malicious code detected in PR'
      );
    });
  });

  // ===========================================================================
  // CHALLENGE 3: watch_review_progress — Timeout Boundaries & Disconnects
  // ===========================================================================
  describe('Challenge 3: watch_review_progress Timeout Boundaries & Disconnect Resilience', () => {
    it('ADV-WATCH-001: Extreme timeout values (0s, negative, >900s) are strictly rejected', async () => {
      const invalidTimeouts = [0, -1, -500, 901, 1000, 10000];

      for (const t of invalidTimeouts) {
        const parsed = WatchReviewProgressInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 44,
          timeout_seconds: t,
        });
        expect(parsed.success).toBe(false);
      }

      // Test over HTTP endpoint with timeout_seconds = 0
      const res0 = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'rpc-watch-0',
          method: 'tools/call',
          params: {
            name: 'watch_review_progress',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pull_number: 44,
              timeout_seconds: 0,
            },
          },
        });

      expect(res0.body.error).toBeDefined();
      expect(res0.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res0.body.error.message).toContain('timeout_seconds must be between 1 and 900 seconds');

      // Test over HTTP endpoint with timeout_seconds = 1000 (>900s)
      const res1000 = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 'rpc-watch-1000',
          method: 'tools/call',
          params: {
            name: 'watch_review_progress',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pull_number: 44,
              timeout_seconds: 1000,
            },
          },
        });

      expect(res1000.body.error).toBeDefined();
      expect(res1000.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res1000.body.error.message).toContain('timeout_seconds must be between 1 and 900 seconds');
    });

    it('ADV-WATCH-002: Boundary timeout values (1s and 900s) are accepted by schema', () => {
      const parsed1 = WatchReviewProgressInputSchema.safeParse({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        timeout_seconds: 1,
      });
      expect(parsed1.success).toBe(true);

      const parsed900 = WatchReviewProgressInputSchema.safeParse({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        timeout_seconds: 900,
      });
      expect(parsed900.success).toBe(true);
    });

    it('ADV-WATCH-003: Clean unsubscribe on normal verdict event', async () => {
      let unsubscribed = false;
      const mockSubscriber = vi.fn(async (_subject: string, options: any) => {
        setTimeout(() => {
          options.onEvent(
            {
              event_kind: 'verdict_declared',
              occurred_at: new Date().toISOString(),
              data: { verdict: 'SHIP', summary: 'All clear' },
            },
            1
          );
        }, 15);

        return {
          unsubscribe: vi.fn(async () => {
            unsubscribed = true;
          }),
        };
      });

      const tool = createWatchReviewProgressTool({
        subscribeProgress: mockSubscriber,
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        timeout_seconds: 5,
      });

      const data = JSON.parse((res.content[0] as any).text);
      expect(data.streaming).toBe(true);
      expect(data.events).toHaveLength(1);
      expect(data.events[0].verdict).toBe('SHIP');
      expect(unsubscribed).toBe(true);
    });

    it('ADV-WATCH-004: Clean unsubscribe and timed_out flag on timeout deadline', async () => {
      let unsubscribed = false;
      const mockSubscriber = vi.fn(async (_subject: string, _options: any) => {
        // No events emitted; let it time out
        return {
          unsubscribe: vi.fn(async () => {
            unsubscribed = true;
          }),
        };
      });

      const tool = createWatchReviewProgressTool({
        subscribeProgress: mockSubscriber,
      });

      const start = Date.now();
      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        timeout_seconds: 1, // 1s deadline
      });
      const elapsed = Date.now() - start;

      const data = JSON.parse((res.content[0] as any).text);
      expect(data.streaming).toBe(true);
      expect(data.timed_out).toBe(true);
      expect(unsubscribed).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(elapsed).toBeLessThan(2000);
    });

    it('ADV-WATCH-005: Stream error invokes cleanup and rejects cleanly', async () => {
      let unsubscribed = false;
      const mockSubscriber = vi.fn(async (_subject: string, options: any) => {
        setTimeout(() => {
          options.onError(new Error('NATS JetStream connection partitioned'));
        }, 15);

        return {
          unsubscribe: vi.fn(async () => {
            unsubscribed = true;
          }),
        };
      });

      const tool = createWatchReviewProgressTool({
        subscribeProgress: mockSubscriber,
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 44,
          timeout_seconds: 5,
        })
      ).rejects.toThrow(/NATS JetStream connection partitioned/);

      expect(unsubscribed).toBe(true);
    });

    it('ADV-WATCH-006: SSE client disconnect triggers session cleanup without unhandled exceptions', async () => {
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, () => resolve()));
      activeServers.push(server);
      const addr = server.address() as any;
      const port = addr.port;

      // 1. Establish SSE client
      let sseReceivedData = '';
      let sessionId = '';

      const reqSse = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/mcp/sse',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        },
      });

      const sseEstablished = new Promise<void>((resolve) => {
        reqSse.on('response', (res) => {
          res.on('data', (chunk) => {
            sseReceivedData += chunk.toString('utf8');
            const match = /sessionId=([a-f0-9-]+)/.exec(sseReceivedData);
            if (match) {
              sessionId = match[1];
              resolve();
            }
          });
        });
      });

      reqSse.end();
      await sseEstablished;
      expect(sessionId).toBeTruthy();

      // Verify session exists in manager
      const activeCountBefore = router.sessionManager.activeSessionCount();
      expect(activeCountBefore).toBeGreaterThanOrEqual(1);

      // 2. Abrupt client disconnect mid-stream
      reqSse.destroy();

      // Allow node event loop to process 'close' event
      await new Promise((r) => setTimeout(r, 50));

      // Session should be destroyed on disconnect
      const sessionAfter = router.sessionManager.getSession(sessionId);
      expect(sessionAfter).toBeUndefined();
    });
  });

  // ===========================================================================
  // CHALLENGE 4: preflight_diff_review — SLA Budget (<15s under load) & Blast Radius
  // ===========================================================================
  describe('Challenge 4: preflight_diff_review SLA Budget & Blast Radius Calculation', () => {
    const complexTsDiff = `diff --git a/src/auth/tokenManager.ts b/src/auth/tokenManager.ts
--- a/src/auth/tokenManager.ts
+++ b/src/auth/tokenManager.ts
@@ -1,15 +1,25 @@
-export function generateToken(userId: string): string {
-  return "dummy";
-}
+export function generateToken(userId: string, salt: string): string {
+  return userId + salt;
+}
+
+export class TokenValidator {
+  isValid(t: string): boolean {
+    return t.length > 10;
+  }
+}
diff --git a/src/services/billingService.ts b/src/services/billingService.ts
--- a/src/services/billingService.ts
+++ b/src/services/billingService.ts
@@ -5,3 +5,6 @@
+export const DEFAULT_BILLING_RATE = 100;
+export async function chargeCustomer(customerId: string, amount: number) {
+  return { charged: true, amount };
+}
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -1,3 +1,4 @@
 name: Production Deploy
 on: [push]
+run-name: Deploy-Run
`;

    it('ADV-PREF-001: Complex diff AST blast radius identifies modified exports and sensitive patterns', async () => {
      const tool = createPreflightDiffReviewTool();

      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: complexTsDiff,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.eligible_to_ship).toBe(true); // No P0 secrets or injections
      expect(data.blast_radius_summary).toContain('CRITICAL'); // Touched .github/workflows/deploy.yml
      expect(data.blast_radius_summary).toContain('generateToken');
      expect(data.blast_radius_summary).toContain('TokenValidator');
      expect(data.blast_radius_summary).toContain('critical infrastructure or security components');
    });

    it('ADV-PREF-002: AST blast radius sets HIGH tier when exports modified without sensitive files', async () => {
      const exportOnlyDiff = `diff --git a/src/utils/math.ts b/src/utils/math.ts
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,2 +1,4 @@
+export function calculateTax(val: number): number {
+  return val * 0.1;
+}
`;
      const tool = createPreflightDiffReviewTool();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: exportOnlyDiff,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.blast_radius_summary).toContain('HIGH');
      expect(data.blast_radius_summary).toContain('calculateTax');
    });

    it('ADV-PREF-003: Multi-vulnerability diff detects multiple P0s (Secret, SQLi, Shell injection)', async () => {
      const multiVulnDiff = `diff --git a/src/vuln.ts b/src/vuln.ts
--- a/src/vuln.ts
+++ b/src/vuln.ts
@@ -1,5 +1,12 @@
 const config = {};
+// Secret leak
+const GITHUB_TOKEN = "ghp_123456789012345678901234567890123456";
+// SQL injection
+const query = "SELECT * FROM users WHERE id = " + req.params.id;
+// Command injection
+exec("ping " + userInput);
`;

      const tool = createPreflightDiffReviewTool();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: multiVulnDiff,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings).toHaveLength(3);

      const titles = data.findings.map((f: any) => f.title);
      expect(titles.some((t: string) => t.includes('Hardcoded secret'))).toBe(true);
      expect(titles.some((t: string) => t.includes('SQL injection'))).toBe(true);
      expect(titles.some((t: string) => t.includes('Command Injection'))).toBe(true);

      for (const f of data.findings) {
        expect(f.severity).toBe('P0');
        expect(f.category).toBe('Security');
      }
    });

    it('ADV-PREF-004: SLA budget verification under load (50 concurrent complex diff reviews < 15s SLA)', async () => {
      // Build a realistically sized diff (~50KB) with 20 files and hundreds of lines
      let multiFileDiff = '';
      for (let i = 1; i <= 20; i++) {
        multiFileDiff += `diff --git a/src/module${i}.ts b/src/module${i}.ts\n`;
        multiFileDiff += `--- a/src/module${i}.ts\n+++ b/src/module${i}.ts\n`;
        multiFileDiff += `@@ -1,10 +1,25 @@\n`;
        multiFileDiff += `+export function moduleFunction${i}(arg: string) {\n`;
        multiFileDiff += `+  return "result_${i}_" + arg;\n`;
        multiFileDiff += `+}\n`;
        for (let j = 0; j < 20; j++) {
          multiFileDiff += `+const helper${i}_${j} = ${j * 10};\n`;
        }
      }

      const tool = createPreflightDiffReviewTool();

      const startTime = Date.now();
      const CONCURRENCY = 50;

      const tasks = Array.from({ length: CONCURRENCY }).map(() =>
        tool.execute({
          repo: 'calltelemetry/cisco-cdr',
          diff: multiFileDiff,
        })
      );

      const outcomes = await Promise.all(tasks);
      const totalDuration = Date.now() - startTime;

      // SLA assertion: Must finish strictly within 15,000 ms (<15s)
      expect(totalDuration).toBeLessThan(15_000);

      // Verify all 50 executions succeeded with valid schema outputs
      expect(outcomes).toHaveLength(CONCURRENCY);
      for (const outcome of outcomes) {
        const parsed = JSON.parse((outcome.content[0] as any).text);
        expect(parsed.eligible_to_ship).toBe(true);
        expect(parsed.blast_radius_summary).toContain('20 files modified');
        expect(parsed.blast_radius_summary).toContain('HIGH');
      }
    });

    it('ADV-PREF-005: Model client timeout is bounded (<12s) to preserve <15s SLA budget', async () => {
      // Mock model client that hangs for 20s (exceeding SLA if not aborted)
      const mockModelClient = {
        evaluateDiff: vi.fn(async (_prompt: string, signal?: AbortSignal) => {
          return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({ findings: [] });
            }, 20_000);

            if (signal) {
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Model evaluation aborted'));
              });
            }
          });
        }),
      };

      const tool = createPreflightDiffReviewTool({
        modelClient: mockModelClient,
      });

      const start = Date.now();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: `diff --git a/src/simple.ts b/src/simple.ts\n--- a/src/simple.ts\n+++ b/src/simple.ts\n@@ -1,1 +1,2 @@\n+const x = 1;\n`,
      });
      const duration = Date.now() - start;

      // Tool should catch model abort and complete in ~12s, strictly <15s SLA
      expect(duration).toBeLessThan(14_500);
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.eligible_to_ship).toBe(true);
    }, 16_000);

    it('ADV-PREF-006: Exceeding 512KB diff limit is rejected by input validation', async () => {
      // Create diff exceeding 512KB
      const oversizedDiff = 'diff --git a/big.txt b/big.txt\n+' + 'X'.repeat(513 * 1024);

      const parsed = PreflightDiffReviewInputSchema.safeParse({
        repo: 'calltelemetry/cisco-cdr',
        diff: oversizedDiff,
      });

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain('exceeds maximum allowed size of 512KB');
      }
    });

    it('ADV-PREF-007: Empty diff is rejected', () => {
      const parsed = PreflightDiffReviewInputSchema.safeParse({
        repo: 'calltelemetry/cisco-cdr',
        diff: '',
      });

      expect(parsed.success).toBe(false);
    });

    it('ADV-PREF-008: Binary diffs and patch formats are safely handled without crash', () => {
      const binaryDiff = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..d270381
Binary files /dev/null and b/assets/logo.png differ
`;
      const parsed = parseUnifiedDiff(binaryDiff);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].isBinary).toBe(true);
      expect(parsed[0].path).toBe('assets/logo.png');
    });
  });
});
