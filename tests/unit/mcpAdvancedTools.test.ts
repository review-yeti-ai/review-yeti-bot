import { describe, expect, it, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDefaultToolRegistry,
  createRemoteMcpRouter,
  type RemoteMcpRouter,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  createGenerateFixDiffTool,
  synthesizeUnifiedDiff,
  validatePatchWithGitApply,
  createDisputeFindingTool,
  createAttestPrGateTool,
  createReplyReviewThreadTool,
  createExplainFindingTool,
  createPreflightDiffReviewTool,
} from '../../src/mcp/server/tools';
import type { McpAuthenticatedCaller, McpAuthenticator } from '../../src/mcp/server/mcpAuthenticator';
import { McpAuthError } from '../../src/mcp/server/mcpAuthenticator';

describe('Advanced MCP Review Tools Unit Suite (tests/unit/mcpAdvancedTools.test.ts)', () => {
  const TEST_OWNER = 'calltelemetry';
  const TEST_REPO = 'ct-review-bot';
  const TEST_PR = 123;
  const TEST_HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

  function createMockCaller(options: {
    isAdmin?: boolean;
    allowedRepos?: string[];
    callerId?: string;
  } = {}): McpAuthenticatedCaller {
    return {
      authType: 'static_token',
      tokenDigest: 'mock-digest',
      isAdmin: options.isAdmin ?? false,
      allowedRepositories: options.allowedRepos
        ? new Set(options.allowedRepos.map((r) => r.toLowerCase()))
        : new Set([`${TEST_OWNER}/${TEST_REPO}`.toLowerCase()]),
      callerId: options.callerId || 'test-worker-m8',
    };
  }

  function buildExpressTestApp(router: RemoteMcpRouter) {
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.use('/api/mcp', router);
    return app;
  }

  function createMockAuthenticator(caller: McpAuthenticatedCaller): McpAuthenticator {
    return {
      authenticate: vi.fn(async (_req: Request) => caller),
      authenticateToken: vi.fn(async (_token: string) => caller),
      checkRepositoryAccess: vi.fn((c: McpAuthenticatedCaller, owner: string, repo: string) => {
        if (c.isAdmin) return true;
        return c.allowedRepositories?.has(`${owner}/${repo}`.toLowerCase()) ?? false;
      }),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;
  }

  // ===========================================================================
  // 1. Tool Catalog Registration (12 Tools)
  // ===========================================================================
  describe('1. Tool Catalog Registration & Schema Audit', () => {
    it('registers exactly 12 tools in createDefaultToolRegistry', () => {
      const registry = createDefaultToolRegistry();
      const tools = registry.listTools();

      expect(tools).toHaveLength(12);
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'get_review_status',
          'get_review_findings',
          'get_model_matrix',
          'trigger_review',
          'cancel_review',
          'watch_review_progress',
          'preflight_diff_review',
          'explain_finding',
          'generate_fix_diff',
          'dispute_finding',
          'attest_pr_gate',
          'reply_review_thread',
        ])
      );

      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('serves all 12 tools via tools/list over remoteMcpRouter HTTP endpoint', async () => {
      const caller = createMockCaller({ isAdmin: true });
      const router = createRemoteMcpRouter({
        authenticator: createMockAuthenticator(caller),
      });
      const app = buildExpressTestApp(router);

      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(200);
      expect(response.body.result.tools).toHaveLength(12);
      const toolNames = response.body.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('generate_fix_diff');
      expect(toolNames).toContain('dispute_finding');
      expect(toolNames).toContain('attest_pr_gate');
      expect(toolNames).toContain('reply_review_thread');

      router.destroy();
    });
  });

  // ===========================================================================
  // 2. generate_fix_diff
  // ===========================================================================
  describe('2. Tool: generate_fix_diff', () => {
    const findingId = 'finding-leak-101';
    const samplePayload = {
      result: {
        personas: [
          {
            id: 'memory-leak-analyst',
            findings: [
              {
                finding_id: findingId,
                title: 'Unbounded memory cache growth',
                severity: 'P1',
                path: 'src/cache/store.ts',
                line_start: 10,
                line_end: 12,
                originalCode: 'const cache = new Map();\ncache.set(key, val);',
                replacementCode: 'const cache = new QuickLRU({ maxSize: 1000 });\ncache.set(key, val);',
                body: 'Replace unbounded map with bounded LRU cache',
              },
            ],
          },
        ],
      },
    };

    it('happy path: synthesizes valid unified git diff patch with hunk headers', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-42',
              head_sha: TEST_HEAD_SHA,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const tool = createGenerateFixDiffTool({ queryableDatabase: mockDb });
      const context = { caller: createMockCaller() };

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
        },
        context
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.file_path).toBe('src/cache/store.ts');
      expect(data.original_lines).toBe('const cache = new Map();\ncache.set(key, val);');
      expect(data.replacement_lines).toBe('const cache = new QuickLRU({ maxSize: 1000 });\ncache.set(key, val);');
      expect(data.explanation).toContain('Replace unbounded map');

      // Validate patch header and hunk syntax
      expect(data.patch).toContain('--- a/src/cache/store.ts');
      expect(data.patch).toContain('+++ b/src/cache/store.ts');
      expect(data.patch).toContain('@@ -10,2 +10,2 @@');
      expect(data.patch).toContain('-const cache = new Map();');
      expect(data.patch).toContain('+const cache = new QuickLRU({ maxSize: 1000 });');

      // Verify with git apply --unidiff-zero --check
      const tempDir = mkdtempSync(join(tmpdir(), 'git-apply-test-'));
      try {
        for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
          if (process.env[k] === '') delete process.env[k];
        }
        execSync('git init', { cwd: tempDir, stdio: 'ignore' });
        execSync('git config user.name "Test Runner" && git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
        writeFileSync(join(tempDir, 'store.ts'), 'const cache = new Map();\ncache.set(key, val);\n');
        execSync('git add store.ts && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

        const patchFile = join(tempDir, 'fix.patch');
        const testPatch = synthesizeUnifiedDiff(
          'store.ts',
          1,
          'const cache = new Map();\ncache.set(key, val);',
          'const cache = new QuickLRU({ maxSize: 1000 });\ncache.set(key, val);'
        );
        writeFileSync(patchFile, testPatch);

        expect(() => {
          execSync('git apply --unidiff-zero --check fix.patch', { cwd: tempDir });
        }).not.toThrow();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('missing finding: throws descriptive error', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-42',
              head_sha: TEST_HEAD_SHA,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const tool = createGenerateFixDiffTool({ queryableDatabase: mockDb });
      const context = { caller: createMockCaller() };

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            finding_id: 'non-existent-finding',
          },
          context
        )
      ).rejects.toThrow(/Finding 'non-existent-finding' was not found in review ledger/);
    });

    it('RBAC rejection: throws McpRbacError when caller lacks repo access', async () => {
      const tool = createGenerateFixDiffTool({});
      const restrictedCaller = createMockCaller({ allowedRepos: ['other/repo'] });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            finding_id: findingId,
          },
          { caller: restrictedCaller }
        )
      ).rejects.toThrow(/Forbidden/);
    });

    it('model-backed unified diff synthesis with AST line anchor accuracy', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-42',
              head_sha: TEST_HEAD_SHA,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            replacement_lines: 'const cache = new QuickLRU({ maxSize: 500 });\ncache.set(key, val);',
            explanation: 'Synthesized bounded LRU cache fix via DeepSeek',
          }),
        }),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.file_path).toBe('src/cache/store.ts');
      expect(data.replacement_lines).toBe('const cache = new QuickLRU({ maxSize: 500 });\ncache.set(key, val);');
      expect(data.explanation).toBe('Synthesized bounded LRU cache fix via DeepSeek');
      expect(data.patch).toContain('@@ -10,2 +10,2 @@');
      expect(data.patch).toContain('+const cache = new QuickLRU({ maxSize: 500 });');

      const validation = await validatePatchWithGitApply(data.patch, 'src/cache/store.ts', 'const cache = new Map();\ncache.set(key, val);');
      expect(validation.valid).toBe(true);
      expect(mockModelClient.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'deepseek/deepseek-v4-flash-0731',
          temperature: 0.1,
        })
      );
    });

    it('model error fallback: reverts to static replacement code when model fails', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-42',
              head_sha: TEST_HEAD_SHA,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('DeepSeek API connection reset')),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.file_path).toBe('src/cache/store.ts');
      expect(data.replacement_lines).toBe('const cache = new QuickLRU({ maxSize: 1000 });\ncache.set(key, val);');
      expect(data.explanation).toContain('Replace unbounded map');
      expect(data.patch).toContain('@@ -10,2 +10,2 @@');
    });

    it('model non-JSON response fallback: reverts to static replacement code', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-42',
              head_sha: TEST_HEAD_SHA,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: 'Here is how you fix it: just use a cache',
        }),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.replacement_lines).toBe('const cache = new QuickLRU({ maxSize: 1000 });\ncache.set(key, val);');
      expect(data.patch).toContain('@@ -10,2 +10,2 @@');
    });

    it('synthesizes unified diff with accurate AST line anchor startLine', () => {
      const patch = synthesizeUnifiedDiff(
        'src/services/auth.ts',
        75,
        'const key = "weak";',
        'const key = crypto.randomBytes(32).toString("hex");'
      );
      expect(patch).toContain('--- a/src/services/auth.ts\n+++ b/src/services/auth.ts\n@@ -75,1 +75,1 @@');
      expect(patch).toContain('-const key = "weak";');
      expect(patch).toContain('+const key = crypto.randomBytes(32).toString("hex");');
    });
  });

  // ===========================================================================
  // 3. dispute_finding
  // ===========================================================================
  describe('3. Tool: dispute_finding', () => {
    const findingId = 'finding-sec-202';
    const samplePayload = {
      result: {
        personas: [
          {
            id: 'security-reviewer',
            findings: [
              {
                finding_id: findingId,
                title: 'Potential SQL Injection in dynamic query',
                severity: 'P0',
                status: 'OPEN',
                resolved: false,
                path: 'src/db/query.ts',
                line: 45,
              },
              {
                finding_id: 'finding-style-203',
                title: 'Missing return type annotation',
                severity: 'P2',
                status: 'OPEN',
                resolved: false,
                path: 'src/util/helper.ts',
                line: 12,
              },
            ],
          },
        ],
      },
    };

    it('overruled verdict: substantive counter-argument overrules finding, decrements blockers, and emits SSE notification', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  run_id: 'run-99',
                  execution_attempt: 1,
                  payload: JSON.stringify(samplePayload),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const notifySpy = vi.fn();
      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        notifyResourceUpdated: notifySpy,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument:
            'The parameter is pre-sanitized through sqlStringEscape and strictly validated as an integer ID in route schema.',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.finding_id).toBe(findingId);
      expect(data.disputed).toBe(true);
      expect(data.verdict).toBe('overruled');
      expect(data.reasoning).toContain('overruled and resolved');
      expect(data.remaining_blockers).toBe(0); // P0 finding was overruled, P2 is not a blocker

      // Verify DB update was called
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE review_worker_completions'),
        expect.any(Array)
      );

      // Verify SSE notifications emitted
      expect(notifySpy).toHaveBeenCalledWith(`review-yeti://findings/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);
      expect(notifySpy).toHaveBeenCalledWith(`review-yeti://runs/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);
    });

    it('upheld verdict: dismissive counter-argument is rejected by quorum', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-99',
              execution_attempt: 1,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const notifySpy = vi.fn();
      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        notifyResourceUpdated: notifySpy,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: 'not a bug ignore this',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.verdict).toBe('upheld');
      expect(data.reasoning).toContain('lacks technical evidence');
      expect(data.remaining_blockers).toBe(1); // P0 remains a blocker
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('custom adjudicator injection', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-99',
              execution_attempt: 1,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const customAdjudicator = vi.fn().mockResolvedValue({
        verdict: 'overruled' as const,
        reasoning: 'Custom quorum approved architectural exemption',
      });

      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        adjudicateDispute: customAdjudicator,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: 'Architectural ADR 0594 allows dynamic column indexing.',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(customAdjudicator).toHaveBeenCalled();
      expect(data.verdict).toBe('overruled');
      expect(data.reasoning).toBe('Custom quorum approved architectural exemption');
    });

    it('storage fallback: disputes finding successfully when record is in review_run_artifacts', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('review_worker_completions')) {
            return { rows: [] }; // Empty in completions
          }
          if (sql.includes('review_run_artifacts')) {
            return {
              rows: [
                {
                  run_id: 'run-art-1',
                  payload: JSON.stringify(samplePayload),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const tool = createDisputeFindingTool({ queryableDatabase: mockDb });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: 'Architectural ADR 0594 allows dynamic column indexing with proven bounds.',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.verdict).toBe('overruled');
      expect(data.disputed).toBe(true);
      expect(data.remaining_blockers).toBe(0);
    });

    it('model-backed adjudication: OVERRULED verdict with confidence and DB ledger update', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  run_id: 'run-99',
                  execution_attempt: 1,
                  payload: JSON.stringify(samplePayload),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            verdict: 'overruled',
            reasoning: 'Model evaluated counter-argument against ADR 0242 and confirmed valid integer sanitization.',
            confidence: 0.94,
          }),
        }),
      };

      const notifySpy = vi.fn();
      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
        notifyResourceUpdated: notifySpy,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: 'Parameter is strongly typed and checked by schema validator before query builder.',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.finding_id).toBe(findingId);
      expect(data.disputed).toBe(true);
      expect(data.verdict).toBe('overruled');
      expect(data.confidence).toBe(0.94);
      expect(data.reasoning).toContain('Model evaluated counter-argument');
      expect(data.remaining_blockers).toBe(0);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE review_worker_completions'),
        expect.any(Array)
      );
      expect(notifySpy).toHaveBeenCalledWith(`review-yeti://findings/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);
    });

    it('model-backed adjudication: UPHELD verdict with confidence keeps blocker', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-99',
              execution_attempt: 1,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            verdict: 'upheld',
            reasoning: 'Counter-argument does not demonstrate parameterization or boundary checking.',
            confidence: 0.88,
          }),
        }),
      };

      const notifySpy = vi.fn();
      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
        notifyResourceUpdated: notifySpy,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: 'I do not think this is an issue, query runs fine in dev.',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.finding_id).toBe(findingId);
      expect(data.disputed).toBe(true);
      expect(data.verdict).toBe('upheld');
      expect(data.confidence).toBe(0.88);
      expect(data.reasoning).toContain('Counter-argument does not demonstrate parameterization');
      expect(data.remaining_blockers).toBe(1);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE review_worker_completions'),
        expect.arrayContaining([expect.stringContaining('"resolved":false')])
      );
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('model error fallback: reverts to heuristic adjudication on model failure', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  run_id: 'run-99',
                  execution_attempt: 1,
                  payload: JSON.stringify(samplePayload),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('DeepSeek API connection reset')),
      };

      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument:
            'The parameter is pre-sanitized through sqlStringEscape and strictly validated as an integer ID in route schema.',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.verdict).toBe('overruled');
      expect(data.confidence).toBe(0.85);
      expect(data.reasoning).toContain('Quorum adjudication accepted counter-argument');
      expect(data.remaining_blockers).toBe(0);
    });

    it('output schema matches DisputeFindingOutput contract', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-99',
              execution_attempt: 1,
              payload: JSON.stringify(samplePayload),
            },
          ],
        }),
      };

      const tool = createDisputeFindingTool({ queryableDatabase: mockDb });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: 'invalid rebuttal',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data).toHaveProperty('finding_id');
      expect(data).toHaveProperty('disputed');
      expect(data).toHaveProperty('verdict');
      expect(data).toHaveProperty('reasoning');
      expect(data).toHaveProperty('confidence');
      expect(data).toHaveProperty('remaining_blockers');
      expect(typeof data.confidence).toBe('number');
      expect(typeof data.remaining_blockers).toBe('number');
    });
  });

  // ===========================================================================
  // 4. attest_pr_gate
  // ===========================================================================
  describe('4. Tool: attest_pr_gate', () => {
    it('PASSED gate: exact head SHA match, SHIP verdict, 0 blockers, passing CI checks returns HMAC token', async () => {
      const cleanPayload = {
        result: {
          verdict: 'SHIP',
          personas: [
            {
              id: 'reviewer',
              findings: [
                {
                  finding_id: 'p2-note',
                  severity: 'P2',
                  title: 'Clean code style note',
                },
              ],
            },
          ],
        },
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-gate-1',
              head_sha: TEST_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify(cleanPayload),
            },
          ],
        }),
      };

      const mockCheckRuns = {
        listCheckRunsForCommit: vi.fn().mockResolvedValue([
          { name: 'ci/tests', status: 'completed', conclusion: 'success' },
          { name: 'ci/lint', status: 'completed', conclusion: 'success' },
        ]),
      };

      const fixedTime = 1774000000000;
      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        checkRunsClient: mockCheckRuns,
        attestationSecret: 'test-secret-key',
        now: () => fixedTime,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: TEST_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(true);
      expect(data.gate_status).toBe('PASSED');
      expect(data.blockers).toHaveLength(0);
      expect(data.head_sha).toBe(TEST_HEAD_SHA);
      expect(data.attestation_token).toMatch(/^[a-f0-9]{64}$/);
      expect(data.timestamp).toBe(new Date(fixedTime).toISOString());
    });

    it('BLOCKED gate: head SHA mismatch fails attestation', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-gate-1',
              head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP' } }),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({ queryableDatabase: mockDb });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: TEST_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.attestation_token).toBe('');
      expect(data.blockers.some((b: string) => b.includes('head SHA mismatch'))).toBe(true);
    });

    it('BLOCKED gate: non-SHIP verdict and unresolved P0 blocker', async () => {
      const blockerPayload = {
        result: {
          verdict: 'FIX_FIRST',
          personas: [
            {
              id: 'security',
              findings: [
                {
                  finding_id: 'sec-1',
                  severity: 'P0',
                  title: 'Critical Auth Bypass',
                  path: 'src/auth.ts',
                  line: 15,
                  status: 'OPEN',
                  resolved: false,
                },
              ],
            },
          ],
        },
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-gate-2',
              head_sha: TEST_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'FIX_FIRST' }),
              payload: JSON.stringify(blockerPayload),
            },
          ],
        }),
      };

      const tool = createAttestPrGateTool({ queryableDatabase: mockDb });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: TEST_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.blockers.some((b: string) => b.includes('required \'SHIP\''))).toBe(true);
      expect(data.blockers.some((b: string) => b.includes('[P0] Critical Auth Bypass'))).toBe(true);
    });

    it('BLOCKED gate: failing CI check run blocks gate sign-off', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-gate-3',
              head_sha: TEST_HEAD_SHA,
              decision: JSON.stringify({ verdict: 'SHIP' }),
              payload: JSON.stringify({ result: { verdict: 'SHIP' } }),
            },
          ],
        }),
      };

      const mockCheckRuns = {
        listCheckRunsForCommit: vi.fn().mockResolvedValue([
          { name: 'ci/unit-tests', status: 'completed', conclusion: 'failure' },
        ]),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        checkRunsClient: mockCheckRuns,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: TEST_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(false);
      expect(data.gate_status).toBe('BLOCKED');
      expect(data.blockers.some((b: string) => b.includes("CI check run 'ci/unit-tests' failed"))).toBe(true);
    });

    it('PASSED gate: accepts desired_state success as authoritative passing verdict', async () => {
      const cleanPayload = {
        result: {
          findings: [],
        },
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-gate-success-1',
              head_sha: TEST_HEAD_SHA,
              desired_state: 'success',
              payload: JSON.stringify(cleanPayload),
            },
          ],
        }),
      };

      const mockCheckRuns = {
        listCheckRunsForCommit: vi.fn().mockResolvedValue([
          { name: 'ci/tests', status: 'completed', conclusion: 'success' },
        ]),
      };

      const tool = createAttestPrGateTool({
        queryableDatabase: mockDb,
        checkRunsClient: mockCheckRuns,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          head_sha: TEST_HEAD_SHA,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.attested).toBe(true);
      expect(data.gate_status).toBe('PASSED');
      expect(data.blockers).toHaveLength(0);
      expect(data.attestation_token).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ===========================================================================
  // 5. reply_review_thread
  // ===========================================================================
  describe('5. Tool: reply_review_thread', () => {
    it('happy path: posts in-thread reply via injected replyToReviewComment', async () => {
      const mockReplyFn = vi.fn().mockResolvedValue({
        id: 987654321,
        in_reply_to_id: 123456,
        html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/123#discussion_r987654321',
        created_at: '2026-09-22T12:00:00Z',
      });

      const tool = createReplyReviewThreadTool({ replyToReviewComment: mockReplyFn });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          comment_id: 123456,
          body: 'Fixed in commit 0123456. Cache capacity is now bounded.',
        },
        { caller: createMockCaller() }
      );

      expect(mockReplyFn).toHaveBeenCalledWith(
        TEST_OWNER,
        TEST_REPO,
        TEST_PR,
        123456,
        'Fixed in commit 0123456. Cache capacity is now bounded.'
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.comment_id).toBe(987654321);
      expect(data.thread_id).toBe(123456);
      expect(data.reply_url).toContain('discussion_r987654321');
      expect(data.posted_at).toBe('2026-09-22T12:00:00Z');
    });

    it('happy path: posts in-thread reply via installationClient.request', async () => {
      const mockClient = {
        request: vi.fn().mockResolvedValue({
          id: 555666777,
          in_reply_to_id: 111222,
          html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/123#discussion_r555666777',
          created_at: '2026-09-22T13:00:00Z',
        }),
      };

      const tool = createReplyReviewThreadTool({ installationClient: mockClient });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          comment_id: 111222,
          body: 'Acknowledged, reviewing.',
        },
        { caller: createMockCaller() }
      );

      expect(mockClient.request).toHaveBeenCalledWith(
        `/repos/${TEST_OWNER}/${TEST_REPO}/pulls/${TEST_PR}/comments/111222/replies`,
        {
          method: 'POST',
          body: JSON.stringify({ body: 'Acknowledged, reviewing.' }),
        }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.comment_id).toBe(555666777);
      expect(data.thread_id).toBe(111222);
    });

    it('RBAC rejection: throws McpRbacError when caller lacks repo access', async () => {
      const tool = createReplyReviewThreadTool({});
      const restrictedCaller = createMockCaller({ allowedRepos: ['other/repo'] });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            comment_id: 123456,
            body: 'Hello',
          },
          { caller: restrictedCaller }
        )
      ).rejects.toThrow(/Forbidden/);
    });

    it('error handling: bubbles up GitHub API failure', async () => {
      const mockClient = {
        request: vi.fn().mockRejectedValue(new Error('GitHub API comment 123456 not found (404)')),
      };

      const tool = createReplyReviewThreadTool({ installationClient: mockClient });

      await expect(
        tool.execute(
          {
            owner: TEST_OWNER,
            repo: TEST_REPO,
            pr_number: TEST_PR,
            comment_id: 123456,
            body: 'Hello',
          },
          { caller: createMockCaller() }
        )
      ).rejects.toThrow(/comment 123456 not found/);
    });
  });

  // ===========================================================================
  // 6. Router Integration & End-to-End tools/call Invocations
  // ===========================================================================
  describe('6. Router tools/call Invocations for 4 Advanced Tools', () => {
    let app: express.Express;
    let router: RemoteMcpRouter;

    beforeEach(() => {
      const caller = createMockCaller({ isAdmin: true });
      const authenticator = createMockAuthenticator(caller);

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT c.payload') || sql.includes('SELECT c.run_id')) {
            return {
              rows: [
                {
                  run_id: 'run-e2e',
                  execution_attempt: 1,
                  head_sha: TEST_HEAD_SHA,
                  decision: JSON.stringify({ verdict: 'SHIP' }),
                  payload: JSON.stringify({
                    result: {
                      verdict: 'SHIP',
                      personas: [
                        {
                          id: 'security',
                          findings: [
                            {
                              finding_id: 'sec-fix-1',
                              title: 'Vulnerable crypto hash',
                              severity: 'P1',
                              path: 'src/hash.ts',
                              line: 20,
                              originalCode: 'createHash("md5")',
                              replacementCode: 'createHash("sha256")',
                            },
                          ],
                        },
                      ],
                    },
                  }),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      router = createRemoteMcpRouter({
        authenticator,
        db: mockDb,
        replyReviewThreadDeps: {
          replyToReviewComment: vi.fn().mockResolvedValue({
            id: 888999,
            in_reply_to_id: 777,
            html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/123#discussion_r888999',
            created_at: '2026-09-22T14:00:00Z',
          }),
        },
      });
      app = buildExpressTestApp(router);
    });

    it('successfully calls generate_fix_diff via POST /api/mcp tools/call', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'generate_fix_diff',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: 'sec-fix-1',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);
      expect(content.file_path).toBe('src/hash.ts');
      expect(content.patch).toContain('--- a/src/hash.ts');
      expect(content.patch).toContain('-createHash("md5")');
      expect(content.patch).toContain('+createHash("sha256")');
    });

    it('successfully calls dispute_finding via POST /api/mcp tools/call', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'dispute_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: 'sec-fix-1',
              counter_argument:
                'MD5 is only used for non-cryptographic checksumming of file cache keys as per ADR 0242.',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);
      expect(content.verdict).toBe('overruled');
      expect(content.remaining_blockers).toBe(0);
    });

    it('successfully calls attest_pr_gate via POST /api/mcp tools/call', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'attest_pr_gate',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              head_sha: TEST_HEAD_SHA,
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);
      expect(content.gate_status).toBeDefined();
    });

    it('successfully calls reply_review_thread via POST /api/mcp tools/call', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 13,
          method: 'tools/call',
          params: {
            name: 'reply_review_thread',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              comment_id: 777,
              body: 'Acknowledged through MCP router.',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);
      expect(content.comment_id).toBe(888999);
      expect(content.thread_id).toBe(777);
    });
  });

  // ===========================================================================
  // 7. Tool: explain_finding
  // ===========================================================================
  describe('7. Tool: explain_finding', () => {
    const explainFindingId = 'finding-arch-701';
    const explainPayload = {
      result: {
        personas: [
          {
            id: 'memory-leak-analyst',
            findings: [
              {
                finding_id: explainFindingId,
                title: 'Unbounded in-memory session cache',
                severity: 'P1',
                category: 'Architecture',
                path: 'src/session/cache.ts',
                line_start: 15,
                line_end: 20,
                rationale: 'Map retains all caller session entries indefinitely leading to memory leak.',
                suggested_fix: 'Use QuickLRU with bounded max size.',
                violated_adrs: ['ADR-0045'],
              },
            ],
          },
        ],
      },
    };

    it('model-backed explanation: evaluates compliant developer proposal and cites ADRs', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-701',
              owner: TEST_OWNER,
              repo: TEST_REPO,
              payload: JSON.stringify(explainPayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            explanation: 'Architectural analysis: Unbounded Map growth exhausts Node.js heap under sustained traffic.',
            satisfies_requirement: true,
            citations: ['ADR-0045'],
          }),
        }),
      };

      const tool = createExplainFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: TEST_PR,
          finding_id: explainFindingId,
          question: 'What if I replace the Map with a bounded QuickLRU cache of maxSize 1000?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.explanation).toContain('Architectural analysis: Unbounded Map growth');
      expect(data.satisfies_requirement).toBe(true);
      expect(data.citations).toContain('ADR-0045');
      expect(mockModelClient.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'deepseek/deepseek-v4-flash-0731',
          temperature: 0.1,
        })
      );
    });

    it('model-backed explanation: rejects non-compliant proposal that suppresses check', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-701',
              owner: TEST_OWNER,
              repo: TEST_REPO,
              payload: JSON.stringify(explainPayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            explanation: 'Bypassing or clearing the map periodically violates the strict bounds guarantee in ADR-0045.',
            satisfies_requirement: false,
            citations: ['ADR-0045'],
          }),
        }),
      };

      const tool = createExplainFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: TEST_PR,
          finding_id: explainFindingId,
          question: 'Can I just disable or ignore this finding?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBe(false);
      expect(data.explanation).toContain('violates the strict bounds guarantee');
    });

    it('informational inquiry: returns null for proposal_satisfies_rules', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-701',
              owner: TEST_OWNER,
              repo: TEST_REPO,
              payload: JSON.stringify(explainPayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            explanation: 'This finding flags memory growth due to indefinite map storage.',
            satisfies_requirement: null,
            citations: ['ADR-0045'],
          }),
        }),
      };

      const tool = createExplainFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: TEST_PR,
          finding_id: explainFindingId,
          question: 'What does this finding mean?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('flags memory growth');
    });

    it('model error fallback: gracefully reverts to evaluateWithHeuristics', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-701',
              owner: TEST_OWNER,
              repo: TEST_REPO,
              payload: JSON.stringify(explainPayload),
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('DeepSeek API 503 Service Unavailable')),
      };

      const tool = createExplainFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: TEST_PR,
          finding_id: explainFindingId,
          question: 'What does this finding mean and why did it occur?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('Unbounded in-memory session cache');
      expect(data.citations).toContain('ADR-0045');
    });
  });

  // ===========================================================================
  // 8. Tool: preflight_diff_review
  // ===========================================================================
  describe('8. Tool: preflight_diff_review', () => {
    const diffWithSecretAndCode = `diff --git a/src/config/keys.ts b/src/config/keys.ts
--- a/src/config/keys.ts
+++ b/src/config/keys.ts
@@ -1,2 +1,3 @@
+export const API_KEY = "sk-abcdef1234567890abcdef1234567890";
+export function connect() { return true; }
`;

    it('gate removal: static secret findings and model-backed findings coexist in results', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Unauthenticated connection export',
              severity: 'warning',
              category: 'Security',
              file_path: 'src/config/keys.ts',
              line: 3,
              rationale: 'connect() export lacks credentials authentication',
              confidence: 0.91,
            },
          ]),
        }),
      };

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });

      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: diffWithSecretAndCode,
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.findings).toHaveLength(2);
      const titles = data.findings.map((f: any) => f.title);
      expect(titles).toContain('Hardcoded secret token or credential detected in diff');
      expect(titles).toContain('Unauthenticated connection export');
      expect(data.eligible_to_ship).toBe(false);
      expect(mockModelClient.complete).toHaveBeenCalled();
    });

    it('compareClaims deduplication: merges model findings that match static findings', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Hardcoded secret token or credential detected in diff',
              severity: 'blocking',
              category: 'Security',
              file_path: 'src/config/keys.ts',
              line: 1,
              rationale: 'Extended model analysis: Plaintext API secret token committed in source file violates security policy and ADR-0012.',
              confidence: 0.98,
            },
          ]),
        }),
      };

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });

      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: diffWithSecretAndCode,
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].severity).toBe('P0');
      expect(data.findings[0].rationale).toContain('Model Analysis:');
    });

    it('severity calibration and advisory demotion: maps blocking/warning/info and demotes advisory titles', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Critical concurrency race condition',
              severity: 'blocking',
              category: 'Architecture',
              file_path: 'src/worker.ts',
              line: 10,
              rationale: 'Unsynchronized shared state',
              confidence: 0.95,
            },
            {
              title: 'Missing timeout on outbound request',
              severity: 'warning',
              category: 'Performance',
              file_path: 'src/worker.ts',
              line: 25,
              rationale: 'Request can hang indefinitely',
              confidence: 0.88,
            },
            {
              title: 'Code style: naming conventions in helper functions',
              severity: 'warning',
              category: 'Style',
              file_path: 'src/worker.ts',
              line: 30,
              rationale: 'Follow camelCase naming standards for internal helpers',
              confidence: 0.85,
            },
            {
              title: 'Informational log format suggestion',
              severity: 'info',
              category: 'Observability',
              file_path: 'src/worker.ts',
              line: 40,
              rationale: 'Structured logging is preferred',
              confidence: 0.8,
            },
            {
              title: 'Potential race condition on shared worker queue',
              severity: 'blocking',
              category: 'Architecture',
              file_path: 'src/worker.ts',
              line: 35,
              rationale: 'Cannot verify if queue is thread-safe without seeing the rest of the file',
              confidence: 0.85,
            },
          ]),
        }),
      };

      const cleanDiff = `diff --git a/src/worker.ts b/src/worker.ts
--- a/src/worker.ts
+++ b/src/worker.ts
@@ -1,1 +1,40 @@
+export function processJobs() {}
`;

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });
      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: cleanDiff,
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.findings).toHaveLength(5);
      expect(data.findings[0].severity).toBe('P0');
      expect(data.findings[1].severity).toBe('P1');
      expect(data.findings[2].severity).toBe('P2');
      expect(data.findings[3].severity).toBe('P2');
      expect(data.findings[4].severity).toBe('P2');
    });

    it('confidence filtering: drops findings with confidence below 0.70', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'High confidence architectural flaw',
              severity: 'P1',
              category: 'Architecture',
              file_path: 'src/app.ts',
              line: 5,
              rationale: 'Circular dependency detected',
              confidence: 0.85,
            },
            {
              title: 'Low confidence speculative issue',
              severity: 'P1',
              category: 'Architecture',
              file_path: 'src/app.ts',
              line: 12,
              rationale: 'Might be an issue maybe',
              confidence: 0.55,
            },
          ]),
        }),
      };

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });
      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: `diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,15 @@\n+export const x = 1;`,
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].title).toBe('High confidence architectural flaw');
    });

    it('SLA timeout fallback: gracefully falls back to static findings on timeout or error', async () => {
      const mockModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('12000ms SLA timeout exceeded')),
      };

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });
      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: diffWithSecretAndCode,
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].title).toBe('Hardcoded secret token or credential detected in diff');
      expect(data.eligible_to_ship).toBe(false);
    });

    it('fast-ship bypass: skips LLM call when diff only modifies safe docs or assets', async () => {
      const mockModelClient = {
        complete: vi.fn(),
      };

      const docDiff = `diff --git a/docs/guide.md b/docs/guide.md
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1,1 +1,2 @@
+# Updated documentation
`;

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });
      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: docDiff,
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.eligible_to_ship).toBe(true);
      expect(data.findings).toEqual([]);
      expect(mockModelClient.complete).not.toHaveBeenCalled();
    });
  });
});

