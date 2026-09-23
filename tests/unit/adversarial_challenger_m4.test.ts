/**
 * Milestone 4 Empirical Challenger Verification & Stress Suite
 *
 * Dedicated adversarial stress test harness verifying:
 * 1. Inbound DeepSeek Review Tools:
 *    - preflight_diff_review (DeepSeek model, AST detection, CRLF/boundary, fallback)
 *    - generate_fix_diff (model synthesis, git apply --check verification, fallback)
 *    - dispute_finding (model adjudication, DB update, SSE notification, blocker math)
 *    - explain_finding (DeepSeek model prompt, JSON parsing, heuristic fallback)
 *    - trigger_review (engine selection, CRD/DB propagation, conflict detection)
 * 2. Hardened Finding Resolution in explainFinding.ts:
 *    - Top-level findings (payload.findings, payload.result.findings)
 *    - Persona-nested findings (payload.result.personas, payload.personas)
 *    - Artifact fallback (review_run_artifacts with & without pull_number)
 *    - Nonexistent finding IDs (graceful tool result, no unhandled throw)
 *    - Scoped caller tenancy (cross-tenant isolation, unscoped auth filtering, admin bypass)
 *    - SHA256 hashId lookup and malformed payload resilience
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createExplainFindingTool,
  evaluateWithHeuristics,
  buildExplainPrompt,
  type StoredFindingRecord,
} from '../../src/mcp/server/tools/explainFinding';
import {
  createPreflightDiffReviewTool,
  parseUnifiedDiff,
  buildPreflightPersonaPrompt,
  parseModelPersonaFindings,
} from '../../src/mcp/server/tools/preflightDiffReview';
import {
  createGenerateFixDiffTool,
  validatePatchWithGitApply,
  synthesizeUnifiedDiff,
} from '../../src/mcp/server/tools/generateFixDiff';
import {
  createDisputeFindingTool,
  defaultAdjudicateFinding,
  evaluateDisputeWithModel,
} from '../../src/mcp/server/tools/disputeFinding';
import {
  createTriggerReviewTool,
} from '../../src/mcp/server/tools/triggerReview';
import {
  ExplainFindingInputSchema,
  PreflightDiffReviewInputSchema,
  GenerateFixDiffInputSchema,
  DisputeFindingInputSchema,
  TriggerReviewInputSchema,
} from '../../src/mcp/server/tools/schemas';
import { McpRbacError } from '../../src/mcp/server/mcpRbac';
import type { McpAuthenticatedCaller } from '../../src/mcp/server/mcpAuthenticator';

describe('Milestone 4 Challenger Stress Suite: Inbound Tools & Finding Resolution Hardening', () => {

  // =========================================================================
  // TASK 1: Empirically verify Inbound DeepSeek Review Tools
  // =========================================================================
  describe('Inbound DeepSeek Review Tools Verification', () => {

    // --- 1. preflight_diff_review ---
    it('EMP-INB-01: preflight_diff_review evaluates diff with DeepSeek model client and blends with static AST findings', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Unbounded in-memory queue growth',
              severity: 'P1',
              category: 'Architecture',
              file_path: 'src/services/queue.ts',
              line: 45,
              rationale: 'Pushing to array without max-depth check causes unbounded heap consumption.',
              suggested_fix: 'Enforce MAX_QUEUE_DEPTH check before push.',
              confidence: 0.95,
            },
            {
              title: 'Low confidence speculative issue',
              severity: 'P2',
              category: 'Correctness',
              file_path: 'src/services/queue.ts',
              line: 50,
              rationale: 'Could maybe be improved',
              confidence: 0.50, // Should be filtered out (< 0.70)
            },
          ]),
        }),
      };

      const diff = `diff --git a/src/services/queue.ts b/src/services/queue.ts
index 1111111..2222222 100644
--- a/src/services/queue.ts
+++ b/src/services/queue.ts
@@ -40,3 +40,5 @@ export class EventQueue {
+  push(item: any) {
+    this.items.push(item);
+  }
`;

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient as any });
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff,
      });

      expect(mockModelClient.complete).toHaveBeenCalledTimes(1);
      const callArgs = mockModelClient.complete.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('You are Review Yeti\'s preflight diff review panel');
      expect(callArgs.messages[0].content).toContain('src/services/queue.ts');

      const data = JSON.parse((result as any).content[0].text);
      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings).toHaveLength(1); // Low confidence finding filtered out
      expect(data.findings[0].title).toBe('Unbounded in-memory queue growth');
      expect(data.findings[0].severity).toBe('P1');
    });

    it('EMP-INB-02: preflight_diff_review falls back gracefully to static rules when model throws or times out', async () => {
      const failingModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('DeepSeek API connection timeout (12000ms)')),
      };

      const diffWithSecret = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,2 +10,3 @@ export function verifyToken() {
+  const secret = "ghp_1234567890abcdef1234567890abcdef1234";
   return true;
`;

      const tool = createPreflightDiffReviewTool({ modelClient: failingModelClient as any });
      // Should NOT throw despite model error
      const result = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: diffWithSecret,
      });

      const data = JSON.parse((result as any).content[0].text);
      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings.length).toBeGreaterThan(0);
      expect(data.findings[0].title).toMatch(/Hardcoded secret/i);
      expect(data.findings[0].severity).toBe('P0');
    });

    // --- 2. generate_fix_diff ---
    it('EMP-INB-03: generate_fix_diff synthesizes unified diff via model and verifies syntax with git apply', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-fix-1',
              payload: {
                findings: [
                  {
                    finding_id: 'f-fix-1',
                    title: 'Missing length guard on buffer',
                    file_path: 'src/buffer.ts',
                    line_start: 1,
                    line_end: 3,
                    rationale: 'Unbounded buffer write',
                    suggested_fix: 'Add bounds check',
                  },
                ],
              },
            },
          ],
        }),
      };

      const originalLines = 'function write(buf: any) {\n  buf.write();\n}\n';
      const replacementLines = 'function write(buf: any) {\n  if (buf.length > 1024) throw new Error("Too large");\n  buf.write();\n}\n';

      const mockModel = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            replacement_lines: replacementLines,
            explanation: 'Guards against oversized buffer payload before write operation.',
          }),
        }),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        fetchFileLines: vi.fn().mockResolvedValue(originalLines),
        modelClient: mockModel,
        validatePatch: true,
      });

      const caller: McpAuthenticatedCaller = {
        authType: 'static_token',
        isAdmin: true,
        allowedRepositories: null,
        callerId: 'admin',
        tokenDigest: 'd',
      };

      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 42,
          finding_id: 'f-fix-1',
        },
        { caller }
      );

      const data = JSON.parse((res as any).content[0].text);
      expect(data.patch).toContain('if (buf.length > 1024)');
      expect(data.file_path).toBe('src/buffer.ts');
      expect(data.explanation).toBe('Guards against oversized buffer payload before write operation.');
    });

    it('EMP-INB-04: generate_fix_diff falls back safely to heuristic diff when model produces unparseable commentary', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-fix-2',
              payload: {
                findings: [
                  {
                    finding_id: 'f-fix-2',
                    title: 'SQL injection defect',
                    file_path: 'src/db.ts',
                    line_start: 1,
                    line_end: 1,
                    suggested_fix: 'const res = db.query("SELECT * FROM t WHERE id = $1", [id]);',
                  },
                ],
              },
            },
          ],
        }),
      };

      // Model returns commentary without JSON wrapper
      const plainTextCommentary = 'I cannot synthesize this fix automatically because of custom query builders.';

      const mockModel = {
        complete: vi.fn().mockResolvedValue({ content: plainTextCommentary }),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        fetchFileLines: vi.fn().mockResolvedValue('const res = db.query("SELECT * FROM t WHERE id = " + id);\n'),
        modelClient: mockModel,
        validatePatch: true,
      });

      const caller: McpAuthenticatedCaller = {
        authType: 'static_token',
        isAdmin: true,
        allowedRepositories: null,
        callerId: 'admin',
        tokenDigest: 'd',
      };

      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 42,
          finding_id: 'f-fix-2',
        },
        { caller }
      );

      const data = JSON.parse((res as any).content[0].text);
      // Fallback synthesis must produce valid hunk headers using static suggested_fix
      expect(data.patch).toContain('@@ -1,1 +1,1 @@');
      expect(data.patch).toContain('const res = db.query("SELECT * FROM t WHERE id = $1", [id]);');
    });

    // --- 3. dispute_finding ---
    it('EMP-INB-05: dispute_finding invokes model client for technical rebuttal and updates ledger on overruled', async () => {
      let updatedPayload: any = null;
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('FROM review_runs r') && sql.includes('JOIN review_worker_completions c')) {
            return {
              rows: [
                {
                  run_id: 'run-1',
                  execution_attempt: 1,
                  payload: {
                    findings: [
                      {
                        finding_id: 'f-dispute-1',
                        severity: 'P1',
                        title: 'Potential race condition in cache update',
                        status: 'ACTIVE',
                      },
                    ],
                  },
                },
              ],
            };
          }
          if (sql.includes('UPDATE review_worker_completions')) {
            updatedPayload = JSON.parse(params[0]);
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };

      const mockModel = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            verdict: 'overruled',
            reasoning: 'The cache update is guarded by an atomic mutex confirmed in line 12.',
            confidence: 0.94,
          }),
        }),
      };

      const notifySpy = vi.fn();

      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModel,
        notifyResourceUpdated: notifySpy,
      });

      const caller: McpAuthenticatedCaller = {
        authType: 'static_token',
        isAdmin: true,
        allowedRepositories: null,
        callerId: 'admin',
        tokenDigest: 'd',
      };

      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pr_number: 10,
          finding_id: 'f-dispute-1',
          counter_argument: 'Cache update is serialized using a dedicated Mutex lock instantiated in line 12.',
        },
        { caller }
      );

      const data = JSON.parse((res as any).content[0].text);
      expect(data.verdict).toBe('overruled');
      expect(data.confidence).toBe(0.94);
      expect(data.remaining_blockers).toBe(0);

      // Verify DB update
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE review_worker_completions'),
        expect.any(Array)
      );
      expect(updatedPayload.findings[0].status).toBe('OVERRULED');

      // Verify SSE resource update notifications were emitted
      expect(notifySpy).toHaveBeenCalledWith('review-yeti://findings/calltelemetry/cisco-cdr/10');
      expect(notifySpy).toHaveBeenCalledWith('review-yeti://runs/calltelemetry/cisco-cdr/10');
    });

    it('EMP-INB-06: dispute_finding rejects low-effort arguments immediately with upheld verdict via defaultAdjudicateFinding heuristics', async () => {
      const finding = { finding_id: 'f-dispute-2', severity: 'P0', title: 'Hardcoded secret' };
      const adjudication1 = defaultAdjudicateFinding(finding, 'not a bug');
      expect(adjudication1.verdict).toBe('upheld');
      expect(adjudication1.reasoning).toMatch(/lacks technical evidence/i);

      const adjudication2 = defaultAdjudicateFinding(finding, 'whatever leave it');
      expect(adjudication2.verdict).toBe('upheld');

      const adjudication3 = defaultAdjudicateFinding(finding, 'This is validated by integration test and bounded by MAX_ENTRIES');
      expect(adjudication3.verdict).toBe('overruled');
    });

    // --- 4. trigger_review ---
    it('EMP-INB-07: trigger_review accepts review_engine parameter and propagates to admission candidate', async () => {
      const mockAdmit = vi.fn().mockResolvedValue({ run: { runId: 'run-test-engine' } });
      const mockResolve = vi.fn().mockResolvedValue({
        identity: 'test-ident',
        prepared: {
          config: { review_engine: 'composed' },
          policy: {
            effectivePolicy: { central: {} },
            effectivePolicyDigest: 'd'.repeat(64),
            effectiveConfigDigest: 'e'.repeat(64),
            sources: [
              {
                repositoryId: 1001,
                repository: 'calltelemetry/cisco-cdr',
                sha: 'b'.repeat(40),
                path: 'policy/review.json',
                contentDigest: 'c'.repeat(64),
              },
            ],
          },
          transport: {},
          expectedPersonaIds: ['reviewer'],
        },
      });

      const tool = createTriggerReviewTool({
        admissionRepository: { admit: mockAdmit },
        resolveGitHubPullRequest: vi.fn().mockResolvedValue({
          headSha: '0123456789abcdef0123456789abcdef01234567',
          baseSha: '1111111111111111111111111111111111111111',
          repositoryId: 1001,
        }),
        authoritativePublishing: {
          acceptNewRequests: true,
          repositoryIds: [1001],
          expectedAppId: 4385771,
          resolver: { resolve: mockResolve },
        } as any,
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 99,
        head_sha: '0123456789abcdef0123456789abcdef01234567',
        review_engine: 'composed',
      });

      const data = JSON.parse((res as any).content[0].text);
      expect(data.dispatched).toBe(true);
      expect(data.message).toContain('engine: composed');

      // Verify admission repository was called with reviewEngine
      expect(mockAdmit).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewEngine: 'composed',
        })
      );
    });

    it('EMP-INB-08: trigger_review throws error on head_sha mismatch with GitHub PR state', async () => {
      const tool = createTriggerReviewTool({
        resolveGitHubPullRequest: vi.fn().mockResolvedValue({
          headSha: '2222222222222222222222222222222222222222',
        }),
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          head_sha: '1111111111111111111111111111111111111111',
        })
      ).rejects.toThrow(/does not match current GitHub PR/i);
    });
  });

  // =========================================================================
  // TASK 2: Stress test newly hardened finding resolution in explainFinding.ts
  // =========================================================================
  describe('explainFinding Finding Resolution Hardening', () => {

    const adminCaller: McpAuthenticatedCaller = {
      authType: 'static_token',
      isAdmin: true,
      allowedRepositories: null,
      callerId: 'admin-caller',
      tokenDigest: 'd1',
    };

    const ciscoCaller: McpAuthenticatedCaller = {
      authType: 'static_token',
      isAdmin: false,
      allowedRepositories: new Set(['calltelemetry/cisco-cdr']),
      callerId: 'cisco-caller',
      tokenDigest: 'd2',
    };

    const otherCaller: McpAuthenticatedCaller = {
      authType: 'static_token',
      isAdmin: false,
      allowedRepositories: new Set(['otherorg/otherrepo']),
      callerId: 'other-caller',
      tokenDigest: 'd3',
    };

    // --- Top-Level Findings: payload.findings ---
    it('EMP-RES-01: resolves finding from top-level payload.findings by finding_id, id, and SHA-256 hashId', async () => {
      const runId = 'run-top-1';
      const filePath = 'src/billing.ts';
      const lineStart = 10;
      const title = 'Floating point math in billing calculation';

      const expectedHashId = createHash('sha256')
        .update(`${runId}:${filePath}:${lineStart}:${title}`)
        .digest('hex')
        .slice(0, 16);

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: runId,
              payload: {
                findings: [
                  {
                    finding_id: 'f-explicit-id',
                    id: 'f-alias-id',
                    title,
                    file_path: filePath,
                    line_start: lineStart,
                    line_end: 15,
                    severity: 'P0',
                    rationale: 'Binary float rounding issues cause billing ledger drift',
                    violated_adrs: ['ADR 0242'],
                  },
                ],
              },
            },
          ],
        }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      // 1. Match by finding_id
      const res1 = await tool.execute(
        { owner: 'calltelemetry', repo: 'cisco-cdr', finding_id: 'f-explicit-id', question: 'Explain this' },
        { caller: adminCaller }
      );
      const data1 = JSON.parse((res1 as any).content[0].text);
      expect(data1.explanation).toContain(title);
      expect(data1.citations).toContain('ADR 0242');

      // 2. Match by id alias
      const res2 = await tool.execute(
        { owner: 'calltelemetry', repo: 'cisco-cdr', finding_id: 'f-alias-id', question: 'Explain this' },
        { caller: adminCaller }
      );
      const data2 = JSON.parse((res2 as any).content[0].text);
      expect(data2.explanation).toContain(title);

      // 3. Match by SHA-256 hashId
      const res3 = await tool.execute(
        { owner: 'calltelemetry', repo: 'cisco-cdr', finding_id: expectedHashId, question: 'Explain this' },
        { caller: adminCaller }
      );
      const data3 = JSON.parse((res3 as any).content[0].text);
      expect(data3.explanation).toContain(title);
    });

    // --- Top-Level Findings: payload.result.findings ---
    it('EMP-RES-02: resolves finding from payload.result.findings array', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-result-findings',
              payload: {
                result: {
                  findings: [
                    {
                      finding_id: 'f-result-100',
                      title: 'Memory leak in event emitter',
                      file_path: 'src/emitter.ts',
                      line_start: 20,
                      line_end: 25,
                      severity: 'P1',
                      rationale: 'Listeners added without corresponding cleanup',
                      violated_adrs: ['ADR 0564'],
                    },
                  ],
                },
              },
            },
          ],
        }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });
      const res = await tool.execute(
        { owner: 'calltelemetry', repo: 'cisco-cdr', finding_id: 'f-result-100', question: 'Why is this bad?' },
        { caller: adminCaller }
      );

      const data = JSON.parse((res as any).content[0].text);
      expect(data.explanation).toContain('Memory leak in event emitter');
      expect(data.citations).toContain('ADR 0564');
    });

    // --- Persona-Nested Findings: payload.result.personas & payload.personas ---
    it('EMP-RES-03: resolves finding nested inside result.personas and legacy personas across distinct completions', async () => {
      // 1. Result.personas completion
      const mockDbResult = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-personas-result',
              payload: {
                result: {
                  personas: [
                    {
                      name: 'security',
                      findings: [
                        {
                          finding_id: 'f-sec-nested',
                          title: 'Insecure cookie configuration',
                          file_path: 'src/session.ts',
                          line_start: 5,
                          severity: 'P1',
                          rationale: 'Missing HttpOnly flag',
                          violated_adrs: ['ADR 0100'],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        }),
      };

      const toolResult = createExplainFindingTool({ queryableDatabase: mockDbResult });
      const res1 = await toolResult.execute(
        { owner: 'calltelemetry', repo: 'cisco-cdr', finding_id: 'f-sec-nested', question: 'What is HttpOnly?' },
        { caller: adminCaller }
      );
      expect(JSON.parse((res1 as any).content[0].text).explanation).toContain('Insecure cookie configuration');

      // 2. Legacy personas completion
      const mockDbLegacy = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-personas-legacy',
              payload: {
                personas: [
                  {
                    name: 'architecture',
                    findings: [
                      {
                        finding_id: 'f-arch-legacy',
                        title: 'Circular dependency between modules',
                        file_path: 'src/modA.ts',
                        line_start: 1,
                        severity: 'P1',
                        rationale: 'Cycle detected',
                        violated_adrs: ['ADR 0200'],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      };

      const toolLegacy = createExplainFindingTool({ queryableDatabase: mockDbLegacy });
      const res2 = await toolLegacy.execute(
        { owner: 'calltelemetry', repo: 'cisco-cdr', finding_id: 'f-arch-legacy', question: 'Explain cycle' },
        { caller: adminCaller }
      );
      expect(JSON.parse((res2 as any).content[0].text).explanation).toContain('Circular dependency between modules');
    });

    // --- Database Fallback: review_worker_completions -> review_run_artifacts ---
    it('EMP-RES-04: falls back to review_run_artifacts when review_worker_completions returns 0 rows (with and without pull_number)', async () => {
      const queriedTables: string[] = [];

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('FROM review_runs r\n                   JOIN review_worker_completions c')) {
            queriedTables.push('review_worker_completions');
            return { rows: [] }; // Empty worker completions
          }
          if (sql.includes('FROM review_runs r\n                         JOIN review_run_artifacts a')) {
            queriedTables.push('review_run_artifacts');
            return {
              rows: [
                {
                  run_id: 'run-art-fallback',
                  payload: {
                    findings: [
                      {
                        finding_id: 'f-art-1',
                        title: 'Finding stored in artifacts table',
                        file_path: 'src/artifact.ts',
                        line_start: 50,
                        severity: 'P1',
                        rationale: 'Discovered during arbitration blob storage',
                        violated_adrs: ['ADR 0564'],
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

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      // Case A: with pull_number
      const resWithPr = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 123,
          finding_id: 'f-art-1',
          question: 'Explain artifact finding',
        },
        { caller: adminCaller }
      );

      expect(queriedTables).toContain('review_worker_completions');
      expect(queriedTables).toContain('review_run_artifacts');
      const dataA = JSON.parse((resWithPr as any).content[0].text);
      expect(dataA.explanation).toContain('Finding stored in artifacts table');

      // Case B: without pull_number
      queriedTables.length = 0;
      const resWithoutPr = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'f-art-1',
          question: 'Explain artifact finding without pr',
        },
        { caller: adminCaller }
      );

      expect(queriedTables).toContain('review_worker_completions');
      expect(queriedTables).toContain('review_run_artifacts');
      const dataB = JSON.parse((resWithoutPr as any).content[0].text);
      expect(dataB.explanation).toContain('Finding stored in artifacts table');
    });

    // --- Nonexistent Finding IDs ---
    it('EMP-RES-05: nonexistent finding ID returns clean not-found tool result without throwing', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'nonexistent-uuid-999',
          question: 'Can I ignore this?',
        },
        { caller: adminCaller }
      );

      expect(res).toBeDefined();
      const data = JSON.parse((res as any).content[0].text);
      expect(data.explanation).toMatch(/Finding 'nonexistent-uuid-999' was not found in the review ledger/i);
      expect(data.satisfies_requirement).toBeNull();
      expect(data.citations).toEqual([]);
    });

    // --- Tenancy Scoping: Caller RBAC Enforcement ---
    it('EMP-RES-06: scoped tenancy strictly enforces caller access and fails closed on unauthorized cross-tenant queries', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              run_id: 'run-secret',
              payload: {
                findings: [
                  {
                    finding_id: 'f-confidential',
                    title: 'Confidential security vulnerability',
                    file_path: 'src/crypto.ts',
                    line_start: 1,
                    severity: 'P0',
                    rationale: 'Private key leak',
                  },
                ],
              },
            },
          ],
        }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      // 1. Authorized caller for calltelemetry/cisco-cdr: SUCCEEDS
      const resAllowed = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'f-confidential',
          question: 'Explain this',
        },
        { caller: ciscoCaller }
      );
      const dataAllowed = JSON.parse((resAllowed as any).content[0].text);
      expect(dataAllowed.explanation).toContain('Confidential security vulnerability');

      // 2. Unauthorized caller for calltelemetry/cisco-cdr: FAILS CLOSED (returns finding not found, 0 data leaked)
      const resDenied = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'f-confidential',
          question: 'Explain this',
        },
        { caller: otherCaller }
      );
      const dataDenied = JSON.parse((resDenied as any).content[0].text);
      expect(dataDenied.explanation).toContain('was not found in the review ledger');

      // 3. Missing caller context on scoped query: FAILS CLOSED
      const resNoCaller = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        finding_id: 'f-confidential',
        question: 'Explain this',
      });
      const dataNoCaller = JSON.parse((resNoCaller as any).content[0].text);
      expect(dataNoCaller.explanation).toContain('was not found in the review ledger');
    });

    it('EMP-RES-07: unscoped queries (no owner/repo) filter database results to only callers permitted repositories', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              run_id: 'run-cisco',
              payload: {
                findings: [{ finding_id: 'f-cisco', title: 'Cisco Finding' }],
              },
            },
            {
              owner: 'secret-corp',
              repo: 'secret-repo',
              run_id: 'run-secret',
              payload: {
                findings: [{ finding_id: 'f-secret', title: 'Secret Finding' }],
              },
            },
          ],
        }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      // Cisco caller should find f-cisco
      const res1 = await tool.execute(
        { finding_id: 'f-cisco', question: 'Explain' },
        { caller: ciscoCaller }
      );
      expect(JSON.parse((res1 as any).content[0].text).explanation).toContain('Cisco Finding');

      // Cisco caller should NOT find f-secret (filtered out by canAccessRepository)
      const res2 = await tool.execute(
        { finding_id: 'f-secret', question: 'Explain' },
        { caller: ciscoCaller }
      );
      expect(JSON.parse((res2 as any).content[0].text).explanation).toContain('was not found in the review ledger');

      // Admin caller should find f-secret
      const resAdmin = await tool.execute(
        { finding_id: 'f-secret', question: 'Explain' },
        { caller: adminCaller }
      );
      expect(JSON.parse((resAdmin as any).content[0].text).explanation).toContain('Secret Finding');
    });

    // --- Corrupted / Malformed DB Payloads Resilience ---
    it('EMP-RES-08: gracefully handles corrupted JSON string in database row payload without crashing', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-corrupt',
              payload: '{ "invalid_json": true, incomplete... ', // malformed JSON string
            },
          ],
        }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      // Should not throw SyntaxError; should gracefully return not found
      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'any-id',
          question: 'Explain this',
        },
        { caller: adminCaller }
      );

      const data = JSON.parse((res as any).content[0].text);
      expect(data.explanation).toMatch(/was not found in the review ledger/i);
    });

    it('EMP-RES-09: explain_finding falls back to heuristic evaluation when modelClient times out', async () => {
      const timeoutModel = {
        complete: vi.fn().mockRejectedValue(new Error('Model timeout 10000ms')),
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-timeout',
              payload: {
                findings: [
                  {
                    finding_id: 'f-timeout-1',
                    title: 'Unbounded ring buffer',
                    file_path: 'src/ring.ts',
                    line_start: 10,
                    violated_adrs: ['ADR 0564'],
                    rationale: 'Missing ring size limit',
                  },
                ],
              },
            },
          ],
        }),
      };

      const tool = createExplainFindingTool({
        queryableDatabase: mockDb,
        modelClient: timeoutModel,
      });

      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'f-timeout-1',
          question: 'What if I implement a bounded LRU ring buffer with max capacity 100?',
        },
        { caller: adminCaller }
      );

      const data = JSON.parse((res as any).content[0].text);
      expect(data.satisfies_requirement).toBe(true);
      expect(data.explanation).toMatch(/satisfies the architectural and safety requirements/i);
      expect(data.citations).toContain('ADR 0564');
    });
  });
});
