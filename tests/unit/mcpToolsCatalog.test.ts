import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  DefaultMcpToolRegistry,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  GetReviewStatusInputSchema,
  GetReviewFindingsInputSchema,
  GetModelMatrixInputSchema,
  TriggerReviewInputSchema,
  CancelReviewInputSchema,
  WatchReviewProgressInputSchema,
  PreflightDiffReviewInputSchema,
  ExplainFindingInputSchema,
} from '../../src/mcp/server/tools/schemas';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import { createGetReviewFindingsTool } from '../../src/mcp/server/tools/getReviewFindings';
import { createGetModelMatrixTool } from '../../src/mcp/server/tools/getModelMatrix';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import { createCancelReviewTool } from '../../src/mcp/server/tools/cancelReview';
import { createWatchReviewProgressTool } from '../../src/mcp/server/tools/watchReviewProgress';
import { createPreflightDiffReviewTool, parseUnifiedDiff } from '../../src/mcp/server/tools/preflightDiffReview';
import { createExplainFindingTool } from '../../src/mcp/server/tools/explainFinding';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';
import { type McpAuthenticator, type McpAuthenticatedCaller, McpAuthError } from '../../src/mcp/server/mcpAuthenticator';

describe('Review Yeti Remote MCP Tool Catalog Suite (tests/unit/mcpToolsCatalog.test.ts)', () => {
  let app: express.Express;
  let router: RemoteMcpRouter;
  let mockDb: any;

  const validToken = 'valid-test-token-123';
  const callerIdentity = 'test-author';

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    };

    const authenticator: McpAuthenticator = {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === `Bearer ${validToken}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest123',
            isAdmin: false,
            allowedRepositories: new Set(['calltelemetry/cisco-cdr', 'calltelemetry/pr-manager-mcp']),
            callerId: callerIdentity,
          } satisfies McpAuthenticatedCaller;
        }
        if (header === 'Bearer admin-token') {
          return {
            authType: 'static_token',
            tokenDigest: 'admindigest',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'admin-user',
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === validToken) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest123',
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

    router = createRemoteMcpRouter({
      authenticator,
      db: mockDb,
    });

    app = express();
    app.use(express.json());
    app.use('/api/mcp', router);
  });

  afterEach(() => {
    router.destroy();
  });

  // =========================================================================
  // SUITE 1: Tool Registry & Discovery Verification (tools/list)
  // =========================================================================
  describe('Suite 1: Tool Registry & Discovery Verification', () => {
    it('TC-REG-001: Enumerates exactly 8 registered core tools', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.tools).toHaveLength(8);

      const toolNames = res.body.result.tools.map((t: any) => t.name);
      expect(toolNames).toEqual([
        'get_review_status',
        'get_review_findings',
        'get_model_matrix',
        'trigger_review',
        'cancel_review',
        'watch_review_progress',
        'preflight_diff_review',
        'explain_finding',
      ]);
    });

    it('TC-REG-002: Validates ToolDefinition schema compliance for all tools', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

      expect(res.status).toBe(200);
      for (const tool of res.body.result.tools) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(5);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('TC-REG-003: Rejects duplicate tool registration in DefaultMcpToolRegistry', () => {
      const reg = new DefaultMcpToolRegistry();
      const mockTool = {
        definition: { name: 'dup_tool', inputSchema: { type: 'object' as const } },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      };

      reg.registerTool(mockTool);
      expect(() => reg.registerTool(mockTool)).toThrowError(/Tool already registered: dup_tool/);
    });
  });

  // =========================================================================
  // SUITE 2: Strict Zod Input Validation Tests
  // =========================================================================
  describe('Suite 2: Strict Zod Input Validation Tests', () => {
    it('TC-VAL-001 (get_review_status): Rejects missing required parameters', () => {
      const result = GetReviewStatusInputSchema.safeParse({ owner: 'calltelemetry' });
      expect(result.success).toBe(false);
    });

    it('TC-VAL-002 (get_review_status): Rejects negative or non-integer pull numbers', () => {
      expect(GetReviewStatusInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: -1 }).success).toBe(false);
      expect(GetReviewStatusInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 4.5 }).success).toBe(false);
      expect(GetReviewStatusInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 0 }).success).toBe(false);
    });

    it('TC-VAL-003 (get_review_status): Rejects malformed commit SHA', () => {
      expect(
        GetReviewStatusInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, head_sha: 'invalid-sha!' })
          .success
      ).toBe(false);
    });

    it('TC-VAL-004 (get_review_findings): Rejects invalid severity enum', () => {
      expect(
        GetReviewFindingsInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, severity: 'P5' as any })
          .success
      ).toBe(false);
      expect(
        GetReviewFindingsInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, severity: 'CRITICAL' as any })
          .success
      ).toBe(false);
    });

    it('TC-VAL-005 (watch_review_progress): Rejects timeout outside [1, 900]', () => {
      expect(
        WatchReviewProgressInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, timeout_seconds: 0 })
          .success
      ).toBe(false);
      expect(
        WatchReviewProgressInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, timeout_seconds: 901 })
          .success
      ).toBe(false);
      expect(
        WatchReviewProgressInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, timeout_seconds: 60 })
          .success
      ).toBe(true);
    });

    it('TC-VAL-006 (trigger_review): Rejects missing or non-40-char commit SHA', () => {
      expect(TriggerReviewInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1 }).success).toBe(false);
      expect(
        TriggerReviewInputSchema.safeParse({
          owner: 'ct',
          repo: 'bot',
          pull_number: 1,
          head_sha: 'abc123', // < 40 chars
        }).success
      ).toBe(false);
      expect(
        TriggerReviewInputSchema.safeParse({
          owner: 'ct',
          repo: 'bot',
          pull_number: 1,
          head_sha: 'g'.repeat(40), // non-hex
        }).success
      ).toBe(false);
      expect(
        TriggerReviewInputSchema.safeParse({
          owner: 'ct',
          repo: 'bot',
          pull_number: 1,
          head_sha: 'a'.repeat(40), // valid 40 hex
        }).success
      ).toBe(true);
    });

    it('TC-VAL-007 (cancel_review): Rejects empty or omitted reason', () => {
      expect(CancelReviewInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1 }).success).toBe(false);
      expect(
        CancelReviewInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, reason: '' }).success
      ).toBe(false);
      expect(
        CancelReviewInputSchema.safeParse({ owner: 'ct', repo: 'bot', pull_number: 1, reason: '   ' }).success
      ).toBe(false);
    });

    it('TC-VAL-008 (explain_finding): Rejects missing finding_id or question', () => {
      expect(ExplainFindingInputSchema.safeParse({ finding_id: '' }).success).toBe(false);
      expect(ExplainFindingInputSchema.safeParse({ finding_id: 'f1', question: '' }).success).toBe(false);
    });

    it('TC-VAL-009 (preflight_diff_review): Rejects diff exceeding 512KB and empty diff', () => {
      expect(
        PreflightDiffReviewInputSchema.safeParse({ diff: '', repo: 'calltelemetry/cisco-cdr' }).success
      ).toBe(false);
      expect(
        PreflightDiffReviewInputSchema.safeParse({
          diff: 'x'.repeat(512 * 1024 + 1),
          repo: 'calltelemetry/cisco-cdr',
        }).success
      ).toBe(false);
    });

    it('TC-VAL-010 (get_model_matrix): Applies safe defaults on empty object', () => {
      const parsed = GetModelMatrixInputSchema.safeParse({});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.benchmark_type).toBe('verified');
        expect(parsed.data.sort_by).toBe('swe-score');
        expect(parsed.data.limit).toBe(20);
      }
    });
  });

  // =========================================================================
  // SUITE 3: get_review_status Tool Execution
  // =========================================================================
  describe('Suite 3: get_review_status Tool Execution', () => {
    it('TC-STAT-001: Returns found review run with check run and worker state', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run_123',
            owner: 'calltelemetry',
            repo: 'cisco-cdr',
            pr_number: 42,
            head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            run_status: 'running',
            run_stage: 'evaluate_personas',
            attempt: 2,
            lease_owner: 'review-worker-pr-42-pod',
            lease_expires_at: new Date(Date.now() + 60000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            attempt_id: 'review-attempt-42-2',
            check_id: '998877',
            desired_state: 'in_progress',
            decision: null,
          },
        ],
      });

      const tool = createGetReviewStatusTool(mockDb);
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 42,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.found).toBe(true);
      expect(data.phase).toBe('evaluating_personas');
      expect(data.verdict).toBe('RUNNING');
      expect(data.attempt_id).toBe('review-attempt-42-2');
      expect(data.active_worker?.pod_name).toBe('review-worker-pr-42-pod');
      expect(data.check_run?.id).toBe(998877);
    });

    it('TC-STAT-002: Returns found: false when no run matches PR', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const tool = createGetReviewStatusTool(mockDb);
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 9999,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.found).toBe(false);
      expect(data.verdict).toBe('PENDING');
      expect(data.message).toContain('No review run found');
    });

    it('TC-STAT-003: Succeeded run returns SHIP verdict and completed phase', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run_clean',
            owner: 'calltelemetry',
            repo: 'cisco-cdr',
            pr_number: 10,
            head_sha: 'c'.repeat(40),
            run_status: 'succeeded',
            run_stage: 'publish',
            attempt: 1,
            check_id: '12345',
            desired_state: 'success',
            decision: JSON.stringify({ verdict: 'SHIP' }),
          },
        ],
      });

      const tool = createGetReviewStatusTool(mockDb);
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 10,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.found).toBe(true);
      expect(data.verdict).toBe('SHIP');
      expect(data.phase).toBe('completed');
      expect(data.check_run?.conclusion).toBe('success');
    });

    it('TC-STAT-004: Fails closed when database collaborator is omitted', async () => {
      const tool = createGetReviewStatusTool();
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 42,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.found).toBe(false);
      expect(data.verdict).toBe('PENDING');
      expect(data.message).toContain('Database service is unavailable');
    });
  });

  // =========================================================================
  // SUITE 4: get_review_findings Tool Execution
  // =========================================================================
  describe('Suite 4: get_review_findings Tool Execution', () => {
    it('TC-FIND-001: Returns structured findings with line anchors and violated ADRs', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run_find_1',
            head_sha: 'a'.repeat(40),
            payload: {
              result: {
                personas: [
                  {
                    id: 'security-reviewer',
                    findings: [
                      {
                        finding_id: 'f-sec-1',
                        severity: 'P1',
                        path: 'src/auth/jwtParser.ts',
                        line: 62,
                        startLine: 45,
                        title: 'Unbounded cache violates ADR 0564 and ADR 0242',
                        body: 'Cache can cause OOM.',
                        recommendation: 'Use bounded LRU cache',
                      },
                    ],
                  },
                  {
                    id: 'architecture-reviewer',
                    findings: [
                      {
                        finding_id: 'f-arch-1',
                        severity: 'P0',
                        path: 'src/gateway/telecom.ts',
                        line: 42,
                        startLine: 38,
                        title: 'Channel buffer violates ADR 0337',
                        body: 'Unbounded channel buffering.',
                        recommendation: 'Use ring buffer',
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      });

      const tool = createGetReviewFindingsTool(mockDb);
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 43,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.total_count).toBe(2);
      expect(data.findings).toHaveLength(2);

      const fSec = data.findings.find((f: any) => f.finding_id === 'f-sec-1');
      expect(fSec.severity).toBe('P1');
      expect(fSec.category).toBe('Security');
      expect(fSec.violated_adrs).toContain('ADR 0564');
      expect(fSec.violated_adrs).toContain('ADR 0242');
      expect(fSec.line_start).toBe(45);
      expect(fSec.line_end).toBe(62);

      const fArch = data.findings.find((f: any) => f.finding_id === 'f-arch-1');
      expect(fArch.severity).toBe('P0');
      expect(fArch.category).toBe('Architecture');
      expect(fArch.violated_adrs).toContain('ADR 0337');
    });

    it('TC-FIND-002: Filters findings by severity level', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run_find_2',
            payload: {
              findings: [
                { finding_id: 'f1', severity: 'P0', title: 'Critical crash', path: 'index.ts', line: 1 },
                { finding_id: 'f2', severity: 'P1', title: 'High memory leak', path: 'index.ts', line: 10 },
              ],
            },
          },
        ],
      });

      const tool = createGetReviewFindingsTool(mockDb);
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 43,
        severity: 'P0',
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].severity).toBe('P0');
      expect(data.total_count).toBe(1);
    });

    it('TC-FIND-003: Returns empty findings for non-existent run without error', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const tool = createGetReviewFindingsTool(mockDb);
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 9999,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.findings).toEqual([]);
      expect(data.total_count).toBe(0);
      expect(data.unresolved_count).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 5: watch_review_progress Tool Execution
  // =========================================================================
  describe('Suite 5: watch_review_progress Tool Execution', () => {
    it('TC-WATCH-001: Streams progress notifications for persona turns and verdict', async () => {
      const mockSubscriber = vi.fn(async (subject: string, options: any) => {
        setTimeout(() => {
          options.onEvent(
            {
              event_kind: 'persona:start',
              occurred_at: new Date().toISOString(),
              data: { persona: 'security-sentinel', turn_index: 1, status: 'in_progress' },
            },
            1
          );
          options.onEvent(
            {
              event_kind: 'tool:invocation',
              occurred_at: new Date().toISOString(),
              data: { persona: 'security-sentinel', tool_name: 'zoekt_search', duration_ms: 50 },
            },
            2
          );
          options.onEvent(
            {
              event_kind: 'verdict_declared',
              occurred_at: new Date().toISOString(),
              data: { verdict: 'SHIP', summary: 'All clean' },
            },
            3
          );
        }, 10);

        return {
          unsubscribe: vi.fn(async () => {}),
        };
      });

      const tool = createWatchReviewProgressTool({
        subscribeProgress: mockSubscriber,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        timeout_seconds: 5,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.streaming).toBe(true);
      expect(data.events).toHaveLength(3);
      expect(data.events[0].event).toBe('persona_progress');
      expect(data.events[1].event).toBe('tool_invocation');
      expect(data.events[2].event).toBe('verdict_declared');
      expect(data.events[2].verdict).toBe('SHIP');
    });

    it('TC-WATCH-002: Enforces streaming timeout deadline cleanly', async () => {
      const mockSubscriber = vi.fn(async (_subject: string, _options: any) => {
        // No events emitted
        return {
          unsubscribe: vi.fn(async () => {}),
        };
      });

      const tool = createWatchReviewProgressTool({
        subscribeProgress: mockSubscriber,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        timeout_seconds: 1, // 1s timeout
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.streaming).toBe(true);
      expect(data.timed_out).toBe(true);
    });

    it('TC-WATCH-003: Fails closed when JetStream subscriber is omitted', async () => {
      const tool = createWatchReviewProgressTool({});
      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 44,
          timeout_seconds: 5,
        })
      ).rejects.toThrow(/JetStream subscription service unavailable/i);
    });
  });

  // =========================================================================
  // SUITE 6: trigger_review Tool Execution
  // =========================================================================
  describe('Suite 6: trigger_review Tool Execution', () => {
    it('TC-TRIG-001: Dispatches exact-head review attempt', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] }); // No active run

      const mockAdmit = vi.fn(async () => ({
        run: { runId: 'run_' + 'a'.repeat(32) },
      }));
      const tool = createTriggerReviewTool({
        queryableDatabase: mockDb,
        admissionRepository: { admit: mockAdmit as any },
        resolveGitHubPullRequest: async () => ({
          headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
          repositoryId: 1001, installationId: 2001,
        }),
        authoritativePublishing: {
          expectedAppId: 4385771, repositoryIds: [1001],
          resolver: { resolve: async (requested: any) => ({
            identity: requested,
            prepared: { policy: {
              effectivePolicyDigest: 'c'.repeat(64),
              effectiveConfigDigest: 'd'.repeat(64),
            } },
          }) },
        } as any,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 60,
        head_sha: 'a'.repeat(40),
        priority: 'expedited',
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.dispatched).toBe(true);
      expect(data.attempt_id).toContain('review-attempt-60-');
      expect(data.job_crd_created).toBe(false);
      expect(data.message).toContain('expedited');
      expect(mockAdmit).toHaveBeenCalled();
    });

    it('TC-TRIG-002: Retrigger on active attempt without force throws 409 Conflict', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ run_id: 'run_active_1', status: 'running' }],
      });

      const tool = createTriggerReviewTool({
        queryableDatabase: mockDb,
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 60,
          head_sha: 'a'.repeat(40),
          force: false,
        })
      ).rejects.toThrow(/Conflict.*currently running/);
    });

    it('TC-TRIG-003: force never pre-cancels an active review before governed admission', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ run_id: 'run_active_2', status: 'running' }],
      });

      const tool = createTriggerReviewTool({
        queryableDatabase: mockDb,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 60,
        head_sha: 'a'.repeat(40),
        force: true,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.dispatched).toBe(true);
      expect(mockDb.query).toHaveBeenCalledOnce();
      expect(mockDb.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE review_runs'), expect.anything(),
      );
    });
  });

  // =========================================================================
  // SUITE 7: cancel_review Tool Execution
  // =========================================================================
  describe('Suite 7: cancel_review Tool Execution', () => {
    it('TC-CANC-001: Cancels active review run and signals pod reaping', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ run_id: 'run_to_cancel', attempt: 1, lease_owner: 'review-worker-pr-44-xyz', status: 'running' }],
        })
        .mockResolvedValueOnce({ rows: [] }) // update review_runs
        .mockResolvedValueOnce({ rows: [] }); // update outbox

      const mockPatch = vi.fn(async () => ({ reapedPod: 'review-worker-pr-44-xyz', success: true }));

      const tool = createCancelReviewTool({
        queryableDatabase: mockDb,
        patchCancellation: mockPatch,
      });

      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 44,
        reason: 'Superseded by new commit push',
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.cancelled).toBe(true);
      expect(data.attempt_id).toBe('review-attempt-44-1');
      expect(data.reaped_pod).toBe('review-worker-pr-44-xyz');
      expect(data.message).toContain('Superseded by new commit push');
      expect(mockPatch).toHaveBeenCalled();
    });

    it('TC-CANC-002: Throws error when canceling non-existent or inactive PR run', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const tool = createCancelReviewTool({
        queryableDatabase: mockDb,
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 9999,
          reason: 'Cleanup',
        })
      ).rejects.toThrow(/Not Found: No active review run found/);
    });
  });

  // =========================================================================
  // SUITE 8: explain_finding Tool Execution
  // =========================================================================
  describe('Suite 8: explain_finding Tool Execution', () => {
    const mockFindingPayload = {
      result: {
        personas: [
          {
            persona: 'security-sentinel',
            findings: [
              {
                finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
                title: 'Unbounded JWT token cache violates memory limits',
                severity: 'P1',
                category: 'Security',
                file_path: 'src/auth/jwtParser.ts',
                line_start: 45,
                line_end: 62,
                violated_adrs: ['ADR 0564', 'ADR 0242'],
                rationale: 'JWT verification caches tokens in an unbounded in-memory Map which can lead to OOM under token flooding attacks.',
                suggested_fix: 'Use a bounded LRU cache with an explicit max-entry capacity.',
              },
            ],
          },
        ],
      },
    };

    const seededMockDb = {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('review_runs') || sql.includes('review_worker_completions')) {
          return {
            rows: [
              {
                payload: JSON.stringify(mockFindingPayload),
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                run_id: 'run_100',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    const authorizedCaller = {
      authType: 'static',
      tokenDigest: 'abc',
      isAdmin: false,
      allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
      callerId: 'static:test',
    };
    const authorizedContext = { caller: authorizedCaller as any, sessionId: 's1' };

    it('TC-EXPL-001: Explains finding and approves compliant proposed fix', async () => {
      const tool = createExplainFindingTool({ queryableDatabase: seededMockDb });
      const result = await tool.execute(
        {
          finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          question: 'What if I replace the Map with a bounded LRU cache with max capacity 1000?',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
        },
        authorizedContext
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.satisfies_requirement).toBe(true);
      expect(data.citations).toContain('ADR 0564');
      expect(data.explanation).toContain('satisfies the architectural');
    });

    it('TC-EXPL-002: Rejects non-compliant remediation proposal', async () => {
      const tool = createExplainFindingTool({ queryableDatabase: seededMockDb });
      const result = await tool.execute(
        {
          finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          question: 'Can I just disable and remove the cache check?',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
        },
        authorizedContext
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.satisfies_requirement).toBe(false);
      expect(data.explanation).toContain('does not satisfy');
    });

    it('TC-EXPL-003: Informational inquiry returns satisfies_requirement: null', async () => {
      const tool = createExplainFindingTool({ queryableDatabase: seededMockDb });
      const result = await tool.execute(
        {
          finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          question: 'Why was this finding raised and what does it mean?',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
        },
        authorizedContext
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('Rationale:');
      expect(data.citations).toContain('ADR 0564');
    });

    it('TC-EXPL-004: Non-existent finding ID returns informative message without crashing', async () => {
      const emptyDb = {
        query: vi.fn(async () => ({ rows: [] })),
      };
      const tool = createExplainFindingTool({ queryableDatabase: emptyDb });
      const result = await tool.execute(
        {
          finding_id: 'fnd_completely_unknown_9999',
          question: 'How do I fix this?',
        },
        authorizedContext
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('was not found in the review ledger');
      expect(data.citations).toEqual([]);
    });

    it('TC-EXPL-005: Denies cross-tenant finding retrieval for caller without repository access', async () => {
      const foreignCaller = {
        authType: 'oidc',
        tokenDigest: 'abc',
        isAdmin: false,
        allowedRepositories: new Set(['other-org/other-repo']),
        callerId: 'oidc:other-org/other-repo:1',
      };
      const tool = createExplainFindingTool({ queryableDatabase: seededMockDb });
      const result = await tool.execute(
        {
          finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          question: 'What is this finding about?',
        },
        { caller: foreignCaller as any, sessionId: 's1' }
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('was not found in the review ledger');
      expect(data.citations).toEqual([]);
    });

    it('TC-EXPL-006: Cleanly returns not-found response when database query throws', async () => {
      const failingDb = {
        query: vi.fn().mockRejectedValue(new Error('relation review_worker_completions does not exist')),
      };
      const tool = createExplainFindingTool({ queryableDatabase: failingDb });
      const result = await tool.execute(
        {
          finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          question: 'What is this finding about?',
        },
        authorizedContext
      );

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('was not found in the review ledger');
      expect(data.citations).toEqual([]);
    });

    it('TC-EXPL-007: Fails closed when execution context or caller is missing for scoped repository', async () => {
      const tool = createExplainFindingTool({ queryableDatabase: seededMockDb });
      // Call with no context at all
      const resultNoContext = await tool.execute({
        finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        question: 'What is this finding about?',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
      });
      const dataNoContext = JSON.parse((resultNoContext.content[0] as any).text);
      expect(dataNoContext.explanation).toContain('was not found in the review ledger');

      // Call with empty context (no caller)
      const resultNoCaller = await tool.execute(
        {
          finding_id: 'fnd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          question: 'What is this finding about?',
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
        },
        { sessionId: 's1' } as any
      );
      const dataNoCaller = JSON.parse((resultNoCaller.content[0] as any).text);
      expect(dataNoCaller.explanation).toContain('was not found in the review ledger');
    });
  });

  // =========================================================================
  // SUITE 9: preflight_diff_review Tool Execution
  // =========================================================================
  describe('Suite 9: preflight_diff_review Tool Execution', () => {
    it('TC-PREF-001: Instant Fast-Ship Approval for pure documentation diff (<50ms)', async () => {
      const docDiff = `diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1,3 +1,4 @@
 # Documentation
+Added new architecture diagram.
`;

      const tool = createPreflightDiffReviewTool();
      const start = Date.now();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: docDiff,
      });
      const duration = Date.now() - start;

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.eligible_to_ship).toBe(true);
      expect(data.findings).toEqual([]);
      expect(data.blast_radius_summary).toContain('Eligible for fast-ship');
      expect(duration).toBeLessThan(100);
    });

    it('TC-PREF-002: Bypasses Fast-Ship when sensitive workflow path is touched', async () => {
      const workflowDiff = `diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -1,2 +1,3 @@
 name: Deploy
+run: echo test
`;

      const tool = createPreflightDiffReviewTool();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: workflowDiff,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.blast_radius_summary).toContain('CRITICAL');
      expect(data.blast_radius_summary).toContain('infrastructure');
    });

    it('TC-PREF-003: Computes AST Blast Radius for TypeScript changes', async () => {
      const codeDiff = `diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts
--- a/src/auth/jwt.ts
+++ b/src/auth/jwt.ts
@@ -10,2 +10,4 @@
-export function verifyJwt(token: string): boolean {
+export function verifyJwt(token: string, secret: string): boolean {
+  return token === secret;
+}
`;

      const tool = createPreflightDiffReviewTool();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: codeDiff,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.blast_radius_summary).toContain('verifyJwt');
    });

    it('TC-PREF-004: Identifies P0 secret leaks and marks eligible_to_ship: false', async () => {
      const secretDiff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,3 @@
 const API_URL = "https://api.example.com";
+const API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890";
`;

      const tool = createPreflightDiffReviewTool();
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: secretDiff,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].severity).toBe('P0');
      expect(data.findings[0].category).toBe('Security');
      expect(data.findings[0].title).toContain('Hardcoded secret');
    });

    it('TC-PREF-005: ParseUnifiedDiff parses hunks and lines correctly', () => {
      const diff = `diff --git a/src/calc.ts b/src/calc.ts
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -1,2 +1,3 @@
 export function add(a: number, b: number) {
-  return 0;
+  return a + b;
+}
`;
      const parsed = parseUnifiedDiff(diff);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].path).toBe('src/calc.ts');
      expect(parsed[0].addedLines).toHaveLength(2);
      expect(parsed[0].deletedLines).toHaveLength(1);
      expect(parsed[0].modifiedExports).toContain('add');
    });
  });

  // =========================================================================
  // SUITE 10: get_model_matrix Tool Execution
  // =========================================================================
  describe('Suite 10: get_model_matrix Tool Execution', () => {
    it('TC-MATR-001: Returns default model matrix sorted by SWE-score', async () => {
      const tool = createGetModelMatrixTool();
      const result = await tool.execute({});

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.benchmark_type).toBe('verified');
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.summary).toBeDefined();
      expect(data.summary.best_score_model).toBeDefined();

      // Check sorting descending by swe_score
      for (let i = 1; i < data.models.length; i++) {
        expect(data.models[i - 1].swe_score).toBeGreaterThanOrEqual(data.models[i].swe_score);
      }
    });

    it('TC-MATR-002: Respects pagination limit and sort by efficiency', async () => {
      const tool = createGetModelMatrixTool();
      const result = await tool.execute({
        sort_by: 'efficiency',
        limit: 3,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.models.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < data.models.length; i++) {
        expect(data.models[i - 1].cost_efficiency).toBeGreaterThanOrEqual(data.models[i].cost_efficiency);
      }
    });
  });

  // =========================================================================
  // SUITE 11: End-to-End JSON-RPC Dispatch & Error Envelope Suite
  // =========================================================================
  describe('Suite 11: End-to-End JSON-RPC Dispatch & Error Envelope Suite', () => {
    it('TC-DISP-001: Dispatches tools/call for get_model_matrix via HTTP POST /api/mcp', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'get_model_matrix',
            arguments: { limit: 5 },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(101);
      expect(res.body.result.content[0].type).toBe('text');
      const data = JSON.parse(res.body.result.content[0].text);
      expect(data.returned_models).toBeLessThanOrEqual(5);
    });

    it('TC-DISP-002: Returns JSON-RPC -32601 for unknown tool name', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'unknown_fake_tool',
            arguments: {},
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND);
      expect(res.body.error.message).toContain('Tool not found: unknown_fake_tool');
    });

    it('TC-DISP-003: Returns JSON-RPC -32602 with schema details for invalid parameters', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'trigger_review',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pull_number: 'not-a-number', // type violation
              head_sha: 'a'.repeat(40),
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('Invalid parameters for tool trigger_review');
    });

    it('TC-DISP-004: Enforces RBAC 403 on tools/call targeting unauthorized repository', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 104,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: {
              owner: 'unauthorized-org',
              repo: 'secret-repo',
              pull_number: 1,
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).toContain('Forbidden: Access to repository unauthorized-org/secret-repo denied');
    });

    it('TC-DISP-005: Catches tool handler exceptions and returns JSON-RPC internal error -32603', async () => {
      const throwingRegistry = new DefaultMcpToolRegistry();
      throwingRegistry.registerTool({
        definition: { name: 'failing_tool', inputSchema: { type: 'object' } },
        execute: async () => {
          throw new Error('Database connection reset unexpectedly');
        },
      });

      const customRouter = createRemoteMcpRouter({
        toolRegistry: throwingRegistry,
      });

      const customApp = express();
      customApp.use(express.json());
      customApp.use('/api/mcp', customRouter);

      const res = await request(customApp)
        .post('/api/mcp')
        .set('Authorization', 'Bearer dummy-token')
        .send({
          jsonrpc: '2.0',
          id: 105,
          method: 'tools/call',
          params: {
            name: 'failing_tool',
            arguments: {},
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INTERNAL_ERROR);
      expect(res.body.error.message).toContain('Database connection reset unexpectedly');

      customRouter.destroy();
    });

    it('TC-DISP-006: Enforces RBAC 403 on preflight_diff_review targeting unauthorized repository via single repo parameter', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 106,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              repo: 'unauthorized-org/secret-repo',
              diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Hello\n+# World',
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).toContain('Forbidden: Access to repository unauthorized-org/secret-repo denied');
    });

    it('TC-DISP-007: Allows preflight_diff_review on authorized repository via single repo parameter', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 107,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              repo: 'calltelemetry/cisco-cdr',
              diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Hello\n+# World',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it('TC-DISP-008: Fails closed with 403 when repo parameter omits organization owner', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          jsonrpc: '2.0',
          id: 108,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              repo: 'unauthorized-repo',
              diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Hello\n+# World',
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
    });
  });
});
