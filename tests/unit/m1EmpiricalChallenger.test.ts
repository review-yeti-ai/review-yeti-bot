// This suite isolates authentication and unavailable dependencies. Positive append-only admission,
// returned receipts and immutable source evidence are covered by disputedFindingRecheckFlow.test.ts
// and completedFindingRecheckAdmission.postgres.test.ts, which fail if enqueue is never reached.
import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type RemoteMcpRouterOptions,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
} from '../../src/mcp/server/mcpAuthenticator';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import {
  createExplainFindingTool,
  evaluateWithHeuristics,
  type StoredFindingRecord,
} from '../../src/mcp/server/tools/explainFinding';
import { createGenerateFixDiffTool } from '../../src/mcp/server/tools/generateFixDiff';
import { createPreflightDiffReviewTool } from '../../src/mcp/server/tools/preflightDiffReview';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';

describe('Milestone 1 Empirical Challenger Suite (tests/unit/m1EmpiricalChallenger.test.ts)', () => {
  const TEST_OWNER = 'calltelemetry';
  const TEST_REPO = 'cisco-cdr';
  const TEST_PR = 42;

  function createRouterTestApp(routerInstance: RemoteMcpRouter) {
    const testApp = express();
    testApp.use(express.json({ limit: '512kb' }));
    testApp.use('/api/mcp', routerInstance);
    return testApp;
  }

  function createSimpleAdminAuthenticator(): McpAuthenticator {
    return {
      authenticate: vi.fn(async () => ({
        authType: 'static_token',
        tokenDigest: 'mock-digest',
        isAdmin: true,
        allowedRepositories: null,
        callerId: 'test-admin',
      })),
      authenticateToken: vi.fn(async () => ({
        authType: 'static_token',
        tokenDigest: 'mock-digest',
        isAdmin: true,
        allowedRepositories: null,
        callerId: 'test-admin',
      })),
      checkRepositoryAccess: vi.fn(() => true),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;
  }

  function createMockCaller(isAdmin = true, allowed = [`${TEST_OWNER}/${TEST_REPO}`]): McpAuthenticatedCaller {
    return {
      authType: 'static_token',
      tokenDigest: 'test-digest',
      isAdmin,
      allowedRepositories: isAdmin ? null : new Set(allowed.map((s) => s.toLowerCase())),
      callerId: 'challenger-caller',
    };
  }

  // ===========================================================================
  // SECTION 1: dispute_finding requests an authenticated fresh review only
  // ===========================================================================
  describe('1. dispute_finding fresh-review request contract', () => {
    const input = {
      owner: TEST_OWNER,
      repo: TEST_REPO,
      pr_number: TEST_PR,
      finding_id: 'source-finding-001',
      counter_argument: 'The request router binds the authenticated repository before reading tenant data.',
    };

    it('requires the caller and authorized repository to agree before opening a transaction', async () => {
      const connect = vi.fn();
      const tool = createDisputeFindingTool({ transactionPool: { connect } as any });
      const restricted = createMockCaller(false, ['other/repo']);
      await expect(tool.execute(input, {
        caller: restricted,
        authenticatedByConfiguredAuthenticator: true, authorizedRepository: { owner: TEST_OWNER, repo: TEST_REPO },
      })).rejects.toThrow(/denied|access/i);
      expect(connect).not.toHaveBeenCalled();
    });

    it('does not adjudicate or mutate a finding when no transaction pool is available', async () => {
      const modelClient = { complete: vi.fn() };
      const adjudicateDispute = vi.fn();
      const tool = createDisputeFindingTool({ modelClient, adjudicateDispute });
      await expect(tool.execute(input, {
        caller: createMockCaller(),
        authenticatedByConfiguredAuthenticator: true, authorizedRepository: { owner: TEST_OWNER, repo: TEST_REPO },
      })).rejects.toThrow('Fresh finding review is temporarily unavailable');
      expect(modelClient.complete).not.toHaveBeenCalled();
      expect(adjudicateDispute).not.toHaveBeenCalled();
    });

    it('keeps the request schema bounded and rejects malformed coordinates', () => {
      const tool = createDisputeFindingTool();
      expect(tool.schema.safeParse({ ...input, counter_argument: 'a'.repeat(10_000) }).success).toBe(true);
      expect(tool.schema.safeParse({ ...input, counter_argument: 'a'.repeat(10_001) }).success).toBe(false);
      expect(tool.schema.safeParse({ ...input, pr_number: 0 }).success).toBe(false);
      expect(tool.schema.safeParse({ ...input, extra: 'not accepted' }).success).toBe(false);
    });
  });

  // ===========================================================================
  // SECTION 2: explain_finding Adversarial Empirical Tests
  // ===========================================================================
  describe('2. explain_finding Empirical Adversarial Hardening', () => {
    const explainFindingId = 'finding-sqli-999';
    const explainPayload = {
      result: {
        personas: [
          {
            name: 'Security',
            findings: [
              {
                finding_id: explainFindingId,
                title: 'SQL injection via unsanitized string interpolation',
                severity: 'P0',
                category: 'Security',
                file_path: 'src/db/users.ts',
                line_start: 33,
                line_end: 35,
                violated_adrs: ['ADR-0242', 'ADR-0594'],
                rationale: 'User input is interpolated directly into database query without parameterized placeholders.',
                suggested_fix: 'Use parameterized SQL query with prepared statements.',
              },
            ],
          },
        ],
      },
    };

    it('compliant proposal: evaluates parameterization proposal as satisfies_requirement: true', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sqli-1',
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
            explanation: 'The proposed remediation correctly replaces string concatenation with parameterized SQL bindings ($1, $2), eliminating SQL injection attack vectors and fully satisfying ADR-0242.',
            satisfies_requirement: true,
            citations: ['ADR-0242'],
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
          question: 'What if I parameterize the query using db.query("SELECT * FROM users WHERE id = $1", [userId]) and sanitize the input?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBe(true);
      expect(data.explanation).toContain('parameterized SQL bindings');
      expect(data.citations).toContain('ADR-0242');
    });

    it('non-compliant proposal: rejects proposal attempting to bypass or disable validation', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sqli-2',
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
            explanation: 'Bypassing the check by turning off query validation does not eliminate the SQL injection flaw and directly violates ADR-0242 security requirements.',
            satisfies_requirement: false,
            citations: ['ADR-0242'],
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
          question: 'Can I just disable the query linter and bypass SQL escaping since this is an internal admin endpoint?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBe(false);
      expect(data.explanation).toContain('violates ADR-0242');
    });

    it('informational inquiry: returns satisfies_requirement: null for conceptual questions', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sqli-3',
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
            explanation: 'SQL injection occurs when untrusted user input is concatenated into dynamic SQL queries, allowing attackers to execute arbitrary SQL commands.',
            satisfies_requirement: null,
            citations: ['ADR-0242', 'ADR-0594'],
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
          question: 'What does SQL injection mean and why is this line dangerous?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.explanation).toContain('SQL injection occurs');
      expect(data.citations).toContain('ADR-0242');
    });

    it('fallback to evaluateWithHeuristics: gracefully falls back on model exception', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sqli-4',
              owner: TEST_OWNER,
              repo: TEST_REPO,
              payload: JSON.stringify(explainPayload),
            },
          ],
        }),
      };

      // Model throws 502 Bad Gateway
      const mockModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('502 Bad Gateway: Upstream LLM unavailable')),
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
          question: 'What if I parameterize and sanitize the query arguments?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      // Heuristic fallback should detect 'parameterize' and set satisfiesRequirement = true
      expect(data.satisfies_requirement).toBe(true);
      expect(data.explanation).toContain('satisfies the architectural and safety requirements');
      expect(data.citations).toContain('ADR-0242');
    });

    it('fallback to evaluateWithHeuristics: handles pure heuristic evaluation directly', () => {
      const record: StoredFindingRecord = {
        finding_id: 'f-1',
        title: 'Unbounded Cache',
        severity: 'P1',
        category: 'Performance',
        file_path: 'src/cache.ts',
        line_start: 10,
        line_end: 20,
        violated_adrs: ['ADR-0045'],
        rationale: 'Cache can grow without bound.',
        suggested_fix: 'Use bounded LRU cache.',
      };

      // Test compliant heuristic
      const resCompliant = evaluateWithHeuristics(record, 'Can I use a bounded LRU cache with max-size 500?');
      expect(resCompliant.satisfiesRequirement).toBe(true);
      expect(resCompliant.citations).toEqual(['ADR-0045']);

      // Test non-compliant heuristic
      const resNonCompliant = evaluateWithHeuristics(record, 'Can I just remove the cache check and ignore it?');
      expect(resNonCompliant.satisfiesRequirement).toBe(false);

      // Test informational heuristic
      const resInfo = evaluateWithHeuristics(record, 'What does this finding mean?');
      expect(resInfo.satisfiesRequirement).toBeNull();
    });

    it('missing finding: returns structured guidance when finding ID is not in review ledger', async () => {
      const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pull_number: TEST_PR,
          finding_id: 'nonexistent-finding-id',
          question: 'How do I fix this?',
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.explanation).toContain('was not found in the review ledger');
      expect(data.satisfies_requirement).toBeNull();
      expect(data.citations).toEqual([]);
    });
  });

  // ===========================================================================
  // SECTION 3: remoteMcpRouter & dispatchIndex DI Wiring & Precedence Tests
  // ===========================================================================
  describe('3. remoteMcpRouter & dispatchIndex DI Wiring & Precedence', () => {
    const sampleDbFindingId = 'f-router-01';
    const sampleDbPayload = {
      result: {
        personas: [
          {
            name: 'Security',
            findings: [
              {
                finding_id: sampleDbFindingId,
                title: 'Router DI finding',
                severity: 'P1',
                category: 'Architecture',
                file_path: 'src/router.ts',
                line_start: 10,
                line_end: 20,
                violated_adrs: ['ADR-0010'],
                rationale: 'Router DI test finding',
              },
            ],
          },
        ],
      },
    };

    it('keeps dispute requests out of model adjudication while other tools use the top-level modelClient', async () => {
      const topModelClient = {
        complete: vi.fn().mockImplementation(async ({ messages }: any) => {
          const sys = messages.find((m: any) => m.role === 'system')?.content || '';
          const usr = messages.find((m: any) => m.role === 'user')?.content || '';
          const allText = `${sys} ${usr}`;

          if (allText.includes('preflight diff review panel')) {
            return {
              content: JSON.stringify([
                {
                  title: 'Model-found diff issue',
                  severity: 'P1',
                  category: 'Architecture',
                  file_path: 'src/main.ts',
                  line: 5,
                  rationale: 'Found via top-level model client',
                  confidence: 0.95,
                },
              ]),
            };
          }
          if (allText.includes('Blocker Quorum Adjudicator')) {
            return {
              content: JSON.stringify({
                verdict: 'overruled',
                reasoning: 'Adjudicated by top-level model client',
                confidence: 0.91,
              }),
            };
          }
          if (allText.includes('architectural advisor')) {
            return {
              content: JSON.stringify({
                explanation: 'Explained by top-level model client',
                satisfies_requirement: true,
                citations: ['ADR-0010'],
              }),
            };
          }
          // Default code patch response for generate_fix_diff
          return {
            content: JSON.stringify({
              replacement_lines: 'const safe = true;',
              explanation: 'Patch generated by top-level model client',
            }),
          };
        }),
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-router-1',
              execution_attempt: 1,
              payload: JSON.stringify(sampleDbPayload),
            },
          ],
        }),
      };

      const router = createRemoteMcpRouter({
        db: mockDb,
        authenticator: createSimpleAdminAuthenticator(),
        modelClient: topModelClient as any,
      });
      const app = createRouterTestApp(router);

      // 1. Test preflight_diff_review invocation
      const resPreflight = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,2 @@\n+export const x = 1;',
              repo: 'calltelemetry/cisco-cdr',
            },
          },
        });
      expect(resPreflight.status).toBe(200);
      const preflightData = JSON.parse(resPreflight.body.result.content[0].text);
      expect(preflightData.findings).toHaveLength(1);
      expect(preflightData.findings[0].title).toBe('Model-found diff issue');

      // 2. Test explain_finding invocation
      const resExplain = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'explain_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pull_number: TEST_PR,
              finding_id: sampleDbFindingId,
              question: 'How should I fix this?',
            },
          },
        });
      expect(resExplain.status).toBe(200);
      const explainData = JSON.parse(resExplain.body.result.content[0].text);
      expect(explainData.explanation).toContain('Explained by top-level model client');

      // 3. Test dispute_finding invocation
      const resDispute = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'dispute_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: sampleDbFindingId,
              counter_argument: 'This is justified by architectural design doc 42.',
            },
          },
        });
      expect(resDispute.status).toBe(200);
      expect(resDispute.body.error?.message).toMatch(/pool\.connect|temporarily unavailable/i);

      // 4. Test generate_fix_diff invocation
      const resFix = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 104,
          method: 'tools/call',
          params: {
            name: 'generate_fix_diff',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: sampleDbFindingId,
            },
          },
        });
      expect(resFix.status).toBe(200);
      const fixData = JSON.parse(resFix.body.result.content[0].text);
      expect(fixData.patch).toBeDefined();

      // The dispute tool only queues an authenticated fresh review and never calls an adjudicator.
      expect(topModelClient.complete).toHaveBeenCalledTimes(3);

      router.destroy();
    });

    it('does not invoke dispute model overrides or top-level models', async () => {
      const topModelClient = {
        complete: vi.fn().mockResolvedValue({ content: '{"verdict":"upheld"}' }),
      };

      const customDisputeClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            verdict: 'overruled',
            reasoning: 'Custom dispute override executed',
            confidence: 0.99,
          }),
        }),
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-override-1',
              execution_attempt: 1,
              payload: JSON.stringify(sampleDbPayload),
            },
          ],
        }),
      };

      const router = createRemoteMcpRouter({
        db: mockDb,
        authenticator: createSimpleAdminAuthenticator(),
        modelClient: topModelClient as any,
        disputeFindingDeps: {
          modelClient: customDisputeClient as any,
        },
      });
      const app = createRouterTestApp(router);

      const res = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 105,
          method: 'tools/call',
          params: {
            name: 'dispute_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: sampleDbFindingId,
              counter_argument: 'Custom justification',
            },
          },
        });

      expect(res.status).toBe(200);
      expect(customDisputeClient.complete).not.toHaveBeenCalled();
      expect(topModelClient.complete).not.toHaveBeenCalled();
      expect(res.body.error?.message).toMatch(/pool\.connect|temporarily unavailable/i);

      router.destroy();
    });

    it('dispatchIndex environment API key resolution precedence', () => {
      // Test 1: OPENROUTER_API_KEY takes first precedence
      const env1: Record<string, string | undefined> = {
        OPENROUTER_API_KEY: 'key-openrouter',
        REVIEW_YETI_BIFROST_API_KEY: 'key-bifrost-1',
        BIFROST_VIRTUAL_KEY: 'key-bifrost-2',
        OPENROUTER_PR_REVIEW_API_KEY: 'key-pr-review',
      };
      const key1 =
        env1.OPENROUTER_API_KEY ||
        env1.REVIEW_YETI_BIFROST_API_KEY ||
        env1.BIFROST_VIRTUAL_KEY ||
        env1.OPENROUTER_PR_REVIEW_API_KEY;
      expect(key1).toBe('key-openrouter');

      // Test 2: REVIEW_YETI_BIFROST_API_KEY takes second precedence
      const env2: Record<string, string | undefined> = {
        REVIEW_YETI_BIFROST_API_KEY: 'key-bifrost-1',
        BIFROST_VIRTUAL_KEY: 'key-bifrost-2',
        OPENROUTER_PR_REVIEW_API_KEY: 'key-pr-review',
      };
      const key2 =
        env2.OPENROUTER_API_KEY ||
        env2.REVIEW_YETI_BIFROST_API_KEY ||
        env2.BIFROST_VIRTUAL_KEY ||
        env2.OPENROUTER_PR_REVIEW_API_KEY;
      expect(key2).toBe('key-bifrost-1');

      // Test 3: Base URL resolution
      const envBase: Record<string, string | undefined> = {
        OPENROUTER_BASE_URL: 'https://custom-gateway.local/v1',
        BIFROST_BASE_URL: 'https://bifrost.local/v1',
      };
      const baseUrl = envBase.OPENROUTER_BASE_URL || envBase.BIFROST_BASE_URL;
      expect(baseUrl).toBe('https://custom-gateway.local/v1');

      // Test 4: When no key is set, resolves to undefined
      const envEmpty: Record<string, string | undefined> = {};
      const keyEmpty =
        envEmpty.OPENROUTER_API_KEY ||
        envEmpty.REVIEW_YETI_BIFROST_API_KEY ||
        envEmpty.BIFROST_VIRTUAL_KEY ||
        envEmpty.OPENROUTER_PR_REVIEW_API_KEY;
      expect(keyEmpty).toBeUndefined();
    });

    it('does not apply heuristic adjudication to a dispute request when modelClient is omitted', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-heuristic-1',
              execution_attempt: 1,
              payload: JSON.stringify(sampleDbPayload),
            },
          ],
        }),
      };

      const router = createRemoteMcpRouter({
        db: mockDb,
        authenticator: createSimpleAdminAuthenticator(),
      });
      const app = createRouterTestApp(router);

      // Preflight diff in heuristic mode
      const resPreflight = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 201,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              diff: 'diff --git a/docs/readme.md b/docs/readme.md\n--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1,1 +1,2 @@\n+# Docs update',
              repo: 'calltelemetry/cisco-cdr',
            },
          },
        });
      expect(resPreflight.status).toBe(200);
      const preflightData = JSON.parse(resPreflight.body.result.content[0].text);
      expect(preflightData.eligible_to_ship).toBe(true);

      // Explain in heuristic mode
      const resExplain = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 202,
          method: 'tools/call',
          params: {
            name: 'explain_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pull_number: TEST_PR,
              finding_id: sampleDbFindingId,
              question: 'What does this mean?',
            },
          },
        });
      expect(resExplain.status).toBe(200);
      const explainData = JSON.parse(resExplain.body.result.content[0].text);
      expect(explainData.explanation).toBeDefined();

      // Dispute in heuristic mode
      const resDispute = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 203,
          method: 'tools/call',
          params: {
            name: 'dispute_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: sampleDbFindingId,
              counter_argument: 'Verified technical mitigation and bounds in place.',
            },
          },
        });
      expect(resDispute.status).toBe(200);
      expect(resDispute.body.error?.message).toMatch(/pool\.connect|temporarily unavailable/i);

      router.destroy();
    });

    it('all individual per-tool overrides independently override top-level modelClient', async () => {
      const topModelClient = { complete: vi.fn() };
      const preflightClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Override preflight finding',
              severity: 'P1',
              category: 'Architecture',
              file_path: 'src/main.ts',
              line: 5,
              rationale: 'Override client finding',
              confidence: 0.9,
            },
          ]),
        }),
      };
      const explainClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            explanation: 'Override explain explanation',
            satisfies_requirement: true,
            citations: ['ADR-0010'],
          }),
        }),
      };
      const fixClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            replacement_lines: 'const fix = true;',
            explanation: 'Override fix patch',
          }),
        }),
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-override-all',
              execution_attempt: 1,
              payload: JSON.stringify(sampleDbPayload),
            },
          ],
        }),
      };

      const router = createRemoteMcpRouter({
        db: mockDb,
        authenticator: createSimpleAdminAuthenticator(),
        modelClient: topModelClient as any,
        preflightDeps: { modelClient: preflightClient as any },
        explainDeps: { modelClient: explainClient as any },
        generateFixDiffDeps: { modelClient: fixClient as any },
      });
      const app = createRouterTestApp(router);

      // Preflight
      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 301,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,2 @@\n+export const y = 2;',
              repo: 'calltelemetry/cisco-cdr',
            },
          },
        });
      expect(preflightClient.complete).toHaveBeenCalled();

      // Explain
      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 302,
          method: 'tools/call',
          params: {
            name: 'explain_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pull_number: TEST_PR,
              finding_id: sampleDbFindingId,
              question: 'Explain this finding',
            },
          },
        });
      expect(explainClient.complete).toHaveBeenCalled();

      // Fix diff
      await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 303,
          method: 'tools/call',
          params: {
            name: 'generate_fix_diff',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: sampleDbFindingId,
            },
          },
        });
      expect(fixClient.complete).toHaveBeenCalled();

      // Top-level client should not have been called for these 3 overridden tools
      expect(topModelClient.complete).not.toHaveBeenCalled();

      router.destroy();
    });
  });
});
