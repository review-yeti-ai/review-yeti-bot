import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as Diff from 'diff';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGenerateFixDiffTool,
  synthesizeUnifiedDiff,
  createDisputeFindingTool,
  defaultAdjudicateFinding,
  createAttestPrGateTool,
  createReplyReviewThreadTool,
} from '../../src/mcp/server/tools';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
} from '../../src/mcp/server/remoteMcpRouter';
import type { McpAuthenticatedCaller } from '../../src/mcp/server/mcpAuthenticator';

describe('Empirical Challenger Suite: generate_fix_diff & dispute_finding (Milestone M8)', () => {
  const TEST_OWNER = 'calltelemetry';
  const TEST_REPO = 'ct-review-bot';
  const TEST_PR = 789;
  const TEST_HEAD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

  function createMockCaller(isAdmin = true): McpAuthenticatedCaller {
    return {
      authType: 'static_token',
      tokenDigest: 'mock-digest',
      isAdmin,
      allowedRepositories: new Set([`${TEST_OWNER}/${TEST_REPO}`.toLowerCase()]),
      callerId: 'empirical-challenger-m8',
    };
  }

  // =========================================================================
  // Challenge Area 1: generate_fix_diff (Unified Diff & git apply)
  // =========================================================================
  describe('Challenge Area 1: generate_fix_diff & Unified Diff Synthesis', () => {
    it('1.1 Syntax & Hunk Header: produces canonical unified diff headers with precise counts', () => {
      const patch1 = synthesizeUnifiedDiff('src/app.ts', 1, 'const x = 1;', 'const x = 2;');
      expect(patch1).toBe(
        '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;\n'
      );

      // Normalization of leading slash
      const patch2 = synthesizeUnifiedDiff('/src/service/api.ts', 45, 'oldFunc();', 'newFunc();');
      expect(patch2.startsWith('--- a/src/service/api.ts\n+++ b/src/service/api.ts\n@@ -45,1 +45,1 @@')).toBe(true);

      // Windows CRLF line ending normalization
      const patch3 = synthesizeUnifiedDiff('crlf.ts', 10, 'line1\r\nline2', 'line1_fixed\r\nline2_fixed');
      expect(patch3).not.toContain('\r');
      expect(patch3).toContain('@@ -10,2 +10,2 @@\n-line1\n-line2\n+line1_fixed\n+line2_fixed\n');
    });

    it('1.2 Asymmetric Line Counts: handles multi-line reductions and expansions accurately', () => {
      // 5 lines reduced to 1 line
      const orig5 = 'line1\nline2\nline3\nline4\nline5';
      const rep1 = 'consolidatedLine';
      const patchReduction = synthesizeUnifiedDiff('reduce.ts', 20, orig5, rep1);
      expect(patchReduction).toContain('@@ -20,5 +20,1 @@\n');
      expect(patchReduction).toContain('-line1\n-line2\n-line3\n-line4\n-line5\n+consolidatedLine\n');

      // 1 line expanded to 4 lines
      const orig1 = 'return null;';
      const rep4 = 'if (!data) {\n  return null;\n}\nreturn data;';
      const patchExpansion = synthesizeUnifiedDiff('expand.ts', 99, orig1, rep4);
      expect(patchExpansion).toContain('@@ -99,1 +99,4 @@\n');
      expect(patchExpansion).toContain('-return null;\n+if (!data) {\n+  return null;\n+}\n+return data;\n');
    });

    it('1.3 Boundary Operations: handles pure insertion and pure deletion hunk syntax', () => {
      // Pure insertion: 0 lines deleted, 2 lines added
      const patchInsert = synthesizeUnifiedDiff('insert.ts', 5, '', 'import x from "x";\nimport y from "y";');
      expect(patchInsert).toContain('@@ -5,0 +5,2 @@\n');
      const insertBody = patchInsert.split('@@\n')[1];
      expect(insertBody).not.toContain('-');
      expect(insertBody).toContain('+import x from "x";\n+import y from "y";\n');

      // Pure deletion: 2 lines deleted, 0 lines added
      const patchDelete = synthesizeUnifiedDiff('delete.ts', 30, 'console.log("debug1");\nconsole.log("debug2");', '');
      expect(patchDelete).toContain('@@ -30,2 +30,0 @@\n');
      const deleteBody = patchDelete.split('@@\n')[1];
      expect(deleteBody).toContain('-console.log("debug1");\n-console.log("debug2");\n');
      expect(deleteBody).not.toContain('+');
    });

    it('1.4 Diff Parser Compatibility: standard diff package parses and applies all synthesized patches', () => {
      const cases = [
        {
          file: 'src/config.ts',
          start: 1,
          orig: 'export const PORT = 3000;',
          rep: 'export const PORT = process.env.PORT || 3000;',
          source: 'export const PORT = 3000;\nexport const HOST = "0.0.0.0";\n',
        },
        {
          file: 'src/middleware.ts',
          start: 2,
          orig: 'verifyToken(req);\ncheckRole(req);',
          rep: 'await authenticateAndAuthorize(req);',
          source: 'import auth from "auth";\nverifyToken(req);\ncheckRole(req);\nnext();\n',
        },
        {
          file: 'src/insert.ts',
          start: 2,
          orig: '',
          rep: '// added comment\nvalidate(req);',
          source: 'line1\nline2\nline3\n',
        },
      ];

      for (const tc of cases) {
        const patch = synthesizeUnifiedDiff(tc.file, tc.start, tc.orig, tc.rep);
        const parsed = Diff.parsePatch(patch);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].hunks).toHaveLength(1);

        const applied = Diff.applyPatch(tc.source, patch);
        expect(applied).not.toBe(false);
        expect(typeof applied).toBe('string');
      }
    });

    it('1.5 Git Apply Compatibility: patches apply cleanly via git apply --unidiff-zero --check', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'git-apply-empirical-'));
      try {
        execSync('git init', { cwd: tempDir, stdio: 'ignore' });

        // Create sample target files
        const originalA = 'lineA1\nlineA2\nlineA3\nlineA4\n';
        writeFileSync(join(tempDir, 'fileA.txt'), originalA);

        const originalB = 'const debug = true;\nrun();\n';
        writeFileSync(join(tempDir, 'fileB.js'), originalB);

        execSync('git add . && git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

        // Test multi-line replacement on fileA at line 2
        const patchA = synthesizeUnifiedDiff('fileA.txt', 2, 'lineA2\nlineA3', 'lineA2_modified\nlineA3_modified\nlineA3_extra');
        writeFileSync(join(tempDir, 'patchA.patch'), patchA);
        expect(() => {
          execSync('git apply --unidiff-zero --check patchA.patch', { cwd: tempDir });
        }).not.toThrow();

        // Test single line replacement on fileB at line 1
        const patchB = synthesizeUnifiedDiff('fileB.js', 1, 'const debug = true;', 'const debug = false;');
        writeFileSync(join(tempDir, 'patchB.patch'), patchB);
        expect(() => {
          execSync('git apply --unidiff-zero --check patchB.patch', { cwd: tempDir });
        }).not.toThrow();

        // Verify that standard git apply --check requires --unidiff-zero for 0-context diffs
        expect(() => {
          execSync('git apply --check patchA.patch', { cwd: tempDir, stdio: 'pipe' });
        }).toThrow();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('1.6 Database Extraction Matrix: extracts code and suggestion from varied schemas and fallbacks', async () => {
      // 1. Finding with fixOptions[0].suggestionCode and codeSnippet
      const findingWithFixOptions = {
        finding_id: 'fix-opt-1',
        title: 'Deprecation warning',
        path: 'src/legacy.ts',
        line: 5,
        codeSnippet: 'Buffer.alloc(10)',
        fixOptions: [
          {
            suggestionCode: 'Buffer.allocUnsafe(10)',
            explanation: 'Use allocUnsafe for performance',
          },
        ],
      };

      // 2. Finding with suggested_fix
      const findingWithSuggestedFix = {
        finding_id: 'sug-fix-2',
        title: 'Missing await',
        path: 'src/async.ts',
        line: 12,
        original_lines: 'db.save(record);',
        suggested_fix: 'await db.save(record);',
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-extract',
              head_sha: TEST_HEAD_SHA,
              payload: JSON.stringify({
                findings: [findingWithFixOptions, findingWithSuggestedFix],
              }),
            },
          ],
        }),
      };

      const tool = createGenerateFixDiffTool({ queryableDatabase: mockDb });
      const context = { caller: createMockCaller() };

      const res1: any = await tool.execute(
        { owner: TEST_OWNER, repo: TEST_REPO, pr_number: TEST_PR, finding_id: 'fix-opt-1' },
        context
      );
      const data1 = JSON.parse(res1.content[0].text);
      expect(data1.file_path).toBe('src/legacy.ts');
      expect(data1.original_lines).toBe('Buffer.alloc(10)');
      expect(data1.replacement_lines).toBe('Buffer.allocUnsafe(10)');
      expect(data1.explanation).toBe('Use allocUnsafe for performance');
      expect(data1.patch).toContain('@@ -5,1 +5,1 @@');

      const res2: any = await tool.execute(
        { owner: TEST_OWNER, repo: TEST_REPO, pr_number: TEST_PR, finding_id: 'sug-fix-2' },
        context
      );
      const data2 = JSON.parse(res2.content[0].text);
      expect(data2.file_path).toBe('src/async.ts');
      expect(data2.original_lines).toBe('db.save(record);');
      expect(data2.replacement_lines).toBe('await db.save(record);');
    });

    it('1.7 fetchFileLines Fallback: calls fetchFileLines when originalCode is absent from payload', async () => {
      const findingWithoutCode = {
        finding_id: 'fetch-fallback-1',
        title: 'Undefined variable',
        path: 'src/runtime.ts',
        line_start: 14,
        line_end: 14,
        suggestion: 'const count = 0;',
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-fetch',
              payload: JSON.stringify({ findings: [findingWithoutCode] }),
            },
          ],
        }),
      };

      const mockFetchLines = vi.fn().mockResolvedValue('let count;');
      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        fetchFileLines: mockFetchLines,
      });

      const res: any = await tool.execute(
        { owner: TEST_OWNER, repo: TEST_REPO, pr_number: TEST_PR, finding_id: 'fetch-fallback-1' },
        { caller: createMockCaller() }
      );

      expect(mockFetchLines).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 'src/runtime.ts', 14, 14);
      const data = JSON.parse(res.content[0].text);
      expect(data.original_lines).toBe('let count;');
      expect(data.replacement_lines).toBe('const count = 0;');
      expect(data.patch).toContain('-let count;\n+const count = 0;\n');
    });
  });

  // =========================================================================
  // Challenge Area 2: dispute_finding (Quorum, Recount & SSE)
  // =========================================================================
  describe('Challenge Area 2: dispute_finding & Quorum Adjudication', () => {
    it('2.1 Quorum Adjudication Matrix: distinguishes dismissals from verifiable technical arguments', () => {
      const mockFinding = { finding_id: 'f-sec', title: 'Potential Insecure Deserialization' };

      // Rebuttals that MUST be upheld (rejected dispute)
      const dismissals = [
        'ignore',
        'ignore this',
        'whatever',
        'not a bug',
        'dont care',
        'wont fix',
        'skip',
        'override',
        'stfu',
        'false positive',
        'this is fine',
        'not important',
        'leave it',
        'looks good to me',
        'short string',
      ];

      for (const text of dismissals) {
        const res = defaultAdjudicateFinding(mockFinding, text);
        expect(res.verdict).toBe('upheld');
        expect(res.reasoning).toContain('lacks technical evidence');
      }

      // Rebuttals that MUST be overruled (accepted dispute)
      const validCounterArguments = [
        'The input is deserialized using strict JSON parser with a fixed schema validator preventing proto pollution.',
        'Architecture Decision Record ADR 0594 explicitly designates this module as an internal zero-trust adapter.',
        'Benchmark results in docs/perf.md demonstrate that this caching layer is bounded to 10,000 entries.',
        'This parameter is already sanitized at line 45 using sqlStringEscape and verified by test/sanitizer.test.ts.',
      ];

      for (const text of validCounterArguments) {
        const res = defaultAdjudicateFinding(mockFinding, text);
        expect(res.verdict).toBe('overruled');
        expect(res.reasoning).toContain('overruled and resolved');
      }
    });

    it('2.2 Database State Mutation: marks status OVERRULED and resolved true on acceptance', async () => {
      const findingId = 'blocker-vuln-1';
      const initialPayload = {
        findings: [
          {
            finding_id: findingId,
            title: 'Critical Vulnerability',
            severity: 'P0',
            status: 'OPEN',
            resolved: false,
          },
        ],
      };

      let updatedPayloadStr = '';
      let disputeRecordInserted: any = null;

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('SELECT c.run_id')) {
            return {
              rows: [
                {
                  run_id: 'run-state-1',
                  execution_attempt: 1,
                  payload: JSON.stringify(initialPayload),
                },
              ],
            };
          }
          if (sql.includes('UPDATE review_worker_completions')) {
            updatedPayloadStr = params[0];
            return { rowCount: 1 };
          }
          if (sql.includes('INSERT INTO review_finding_disputes')) {
            disputeRecordInserted = params;
            return { rowCount: 1 };
          }
          return { rows: [] };
        }),
      };

      const tool = createDisputeFindingTool({ queryableDatabase: mockDb });
      const counterArg =
        'This endpoint requires TLS client mutual authentication at the ingress gateway, neutralizing unauthenticated access.';

      const res: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: findingId,
          counter_argument: counterArg,
        },
        { caller: createMockCaller() }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.verdict).toBe('overruled');
      expect(data.disputed).toBe(true);

      // Verify payload was updated
      expect(updatedPayloadStr).toBeTruthy();
      const updatedPayload = JSON.parse(updatedPayloadStr);
      const mutatedFinding = updatedPayload.findings[0];
      expect(mutatedFinding.status).toBe('OVERRULED');
      expect(mutatedFinding.resolved).toBe(true);
      expect(mutatedFinding.dispute_reasoning).toContain('overruled and resolved');
      expect(mutatedFinding.counter_argument).toBe(counterArg);

      // Verify dispute ledger record
      expect(disputeRecordInserted).toBeDefined();
      expect(disputeRecordInserted[0]).toBe(findingId);
      expect(disputeRecordInserted[5]).toBe('overruled');
    });

    it('2.3 Blocker Recalculation: correctly counts remaining P0/P1 blockers while ignoring P2/P3/resolved', async () => {
      const findingsList = [
        { finding_id: 'p0-blocker', severity: 'P0', status: 'OPEN', resolved: false },
        { finding_id: 'p1-blocker', severity: 'P1', status: 'OPEN', resolved: false },
        { finding_id: 'p2-advisory', severity: 'P2', status: 'OPEN', resolved: false },
        { finding_id: 'p3-info', severity: 'P3', status: 'OPEN', resolved: false },
        { finding_id: 'p0-already-resolved', severity: 'P0', status: 'RESOLVED', resolved: true },
      ];

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT c.run_id')) {
            return {
              rows: [
                {
                  run_id: 'run-count-1',
                  execution_attempt: 1,
                  payload: JSON.stringify({ findings: findingsList }),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const tool = createDisputeFindingTool({ queryableDatabase: mockDb });

      // Overrule p0-blocker: remaining should be 1 (only p1-blocker left)
      const res1: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: 'p0-blocker',
          counter_argument: 'Guarded by upstream API Gateway rate limiter and validation.',
        },
        { caller: createMockCaller() }
      );

      const data1 = JSON.parse(res1.content[0].text);
      expect(data1.verdict).toBe('overruled');
      expect(data1.remaining_blockers).toBe(1);

      // Now overrule p1-blocker: remaining should be 0
      findingsList[0].status = 'OVERRULED';
      findingsList[0].resolved = true;

      const res2: any = await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: 'p1-blocker',
          counter_argument: 'Architecture Decision Record ADR 012 permits this pattern.',
        },
        { caller: createMockCaller() }
      );

      const data2 = JSON.parse(res2.content[0].text);
      expect(data2.verdict).toBe('overruled');
      expect(data2.remaining_blockers).toBe(0);
    });

    it('2.4 SSE Real-Time Emissions: emits notifications on both findings and runs URIs on overruling', async () => {
      const notifySpy = vi.fn();
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sse-1',
              execution_attempt: 1,
              payload: JSON.stringify({
                findings: [
                  { finding_id: 'sse-p0', severity: 'P0', status: 'OPEN', resolved: false },
                ],
              }),
            },
          ],
        }),
      };

      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        notifyResourceUpdated: notifySpy,
      });

      // 1. Overruled finding MUST trigger 2 SSE events
      await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: 'sse-p0',
          counter_argument: 'Valid architectural mitigation and verified context provided.',
        },
        { caller: createMockCaller() }
      );

      expect(notifySpy).toHaveBeenCalledTimes(2);
      expect(notifySpy).toHaveBeenCalledWith(`review-yeti://findings/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);
      expect(notifySpy).toHaveBeenCalledWith(`review-yeti://runs/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);

      notifySpy.mockClear();

      // 2. Upheld finding MUST NOT trigger SSE events
      await tool.execute(
        {
          owner: TEST_OWNER,
          repo: TEST_REPO,
          pr_number: TEST_PR,
          finding_id: 'sse-p0',
          counter_argument: 'ignore this',
        },
        { caller: createMockCaller() }
      );

      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('2.5 End-to-End Router SSE Protocol: verifies active session receives resource update events over HTTP SSE stream', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT c.run_id')) {
            return {
              rows: [
                {
                  run_id: 'run-e2e-sse',
                  execution_attempt: 1,
                  payload: JSON.stringify({
                    findings: [
                      { finding_id: 'e2e-f1', severity: 'P1', status: 'OPEN', resolved: false },
                    ],
                  }),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const router: RemoteMcpRouter = createRemoteMcpRouter({
        db: mockDb,
        authenticator: {
          authenticate: vi.fn(async () => createMockCaller(true)),
          checkRepositoryAccess: vi.fn(() => true),
        } as any,
      });

      const app = express();
      app.use(express.json());
      app.use('/api/mcp', router);

      // Create synthetic SSE session and subscribe to both URIs
      const deliveredEvents: any[] = [];
      const mockSseStream: any = {
        writableEnded: false,
        write: vi.fn((data: string) => {
          const match = data.match(/data: ({.*})/);
          if (match) {
            deliveredEvents.push(JSON.parse(match[1]));
          }
          return true;
        }),
      };

      const session = router.sessionManager.createSession(mockSseStream);
      session.subscriptions.add(`review-yeti://findings/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);
      session.subscriptions.add(`review-yeti://runs/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}`);

      // Invoke dispute_finding via JSON-RPC POST /api/mcp
      const response = await request(app)
        .post('/api/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'dispute_finding',
            arguments: {
              owner: TEST_OWNER,
              repo: TEST_REPO,
              pr_number: TEST_PR,
              finding_id: 'e2e-f1',
              counter_argument:
                'Technical mitigation verified: Memory bounds are strictly enforced by LRU cache adapter.',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();

      // Verify delivered SSE notifications
      expect(deliveredEvents).toHaveLength(2);
      expect(deliveredEvents[0]).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: `review-yeti://findings/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}` },
      });
      expect(deliveredEvents[1]).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: `review-yeti://runs/${TEST_OWNER}/${TEST_REPO}/${TEST_PR}` },
      });

      router.destroy();
    });
  });
});
