// This suite isolates authentication and unavailable dependencies. Positive append-only admission,
// returned receipts and immutable source evidence are covered by disputedFindingRecheckFlow.test.ts
// and completedFindingRecheckAdmission.postgres.test.ts, which fail if enqueue is never reached.
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
  const TEST_OWNER = 'exampleorg';
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
        for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
          if (process.env[k] === '') delete process.env[k];
        }
        execSync('git init', { cwd: tempDir, stdio: 'ignore' });
        execSync('git config user.name "Test Runner" && git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });

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
  describe('Challenge Area 2: dispute_finding fresh-review requests', () => {
    const input = {
      owner: TEST_OWNER, repo: TEST_REPO, pr_number: TEST_PR,
      finding_id: 'source-finding-e2e',
      counter_argument: 'The handler binds the authenticated repository before it reads tenant data.',
    };

    it('keeps the legacy heuristic helper advisory and outside the request path', () => {
      const finding = { finding_id: 'f-sec', title: 'Potential insecure deserialization' };
      expect(defaultAdjudicateFinding(finding, 'not a bug').verdict).toBe('upheld');
      expect(defaultAdjudicateFinding(finding,
        'Strict JSON parsing and schema validation prevent prototype pollution.').verdict).toBe('overruled');
    });

    it('requires repository-scoped authorization and never calls an adjudicator or emits mutation events', async () => {
      const modelClient = { complete: vi.fn() };
      const notifyResourceUpdated = vi.fn();
      const tool = createDisputeFindingTool({ modelClient, notifyResourceUpdated });
      await expect(tool.execute(input, {
        caller: createMockCaller(),
        authenticatedByConfiguredAuthenticator: true,
        authorizedRepository: { owner: TEST_OWNER, repo: TEST_REPO },
      })).rejects.toThrow('Fresh finding review is temporarily unavailable');
      expect(modelClient.complete).not.toHaveBeenCalled();
      expect(notifyResourceUpdated).not.toHaveBeenCalled();
    });

    it('rejects a caller whose repository grant does not include the target before source access', async () => {
      const query = vi.fn();
      const tool = createDisputeFindingTool({ transactionPool: { connect: vi.fn() } as any,
        queryableDatabase: { query } });
      await expect(tool.execute(input, {
        caller: { ...createMockCaller(false), allowedRepositories: new Set(['other/repository']) },
        authenticatedByConfiguredAuthenticator: true,
        authorizedRepository: { owner: TEST_OWNER, repo: TEST_REPO },
      })).rejects.toThrow(/denied|access/i);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
