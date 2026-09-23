import { describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  createPreflightDiffReviewTool,
  parseUnifiedDiff,
  calibratePreflightSeverity,
  parseModelPersonaFindings,
  deduplicateFindings,
  buildPreflightPersonaPrompt,
} from '../../src/mcp/server/tools/preflightDiffReview';
import {
  createGenerateFixDiffTool,
  synthesizeUnifiedDiff,
  validatePatchWithGitApply,
} from '../../src/mcp/server/tools/generateFixDiff';
import { compareClaims } from '../../src/review/claimSimilarity';

describe('Milestone 1 Challenger Stress Suite: preflight_diff_review & generate_fix_diff', () => {

  // =========================================================================
  // SECTION 1: preflight_diff_review Stress Testing
  // =========================================================================
  describe('preflight_diff_review stress testing', () => {
    const diffWithSecretAndCode = `diff --git a/src/api/auth.ts b/src/api/auth.ts
index 1111111..2222222 100644
--- a/src/api/auth.ts
+++ b/src/api/auth.ts
@@ -10,3 +10,4 @@ export function authenticateUser(token: string) {
+  const masterKey = "sk-live1234567890abcdef1234567890";
   return token === masterKey;
 }
`;

    const diffWithSqliAndCmdi = `diff --git a/src/db/query.ts b/src/db/query.ts
index 3333333..4444444 100644
--- a/src/db/query.ts
+++ b/src/db/query.ts
@@ -20,2 +20,4 @@ export function runQuery(req: any) {
+  const sql = "SELECT * FROM users WHERE id = " + req.id;
+  execSync("echo " + req.command);
 }
`;

    it('EMP-PRE-01: uncommitted diff with static secret triggers BOTH static check and model persona evaluation', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Unbounded memory buffer allocation',
              severity: 'warning',
              category: 'Architecture',
              file_path: 'src/api/auth.ts',
              line: 12,
              rationale: 'Function retains unbounded references leading to possible memory leak',
              confidence: 0.92,
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
      expect(mockModelClient.complete).toHaveBeenCalled();
      expect(data.findings).toHaveLength(2);

      const staticFinding = data.findings.find((f: any) => f.title.includes('secret'));
      const modelFinding = data.findings.find((f: any) => f.title.includes('Unbounded memory'));

      expect(staticFinding).toBeDefined();
      expect(staticFinding.severity).toBe('P0');
      expect(staticFinding.category).toBe('Security');

      expect(modelFinding).toBeDefined();
      expect(modelFinding.severity).toBe('P1');
      expect(modelFinding.category).toBe('Architecture');

      expect(data.eligible_to_ship).toBe(false);
    });

    it('EMP-PRE-02: uncommitted diff with SQLi and CMDi triggers static checks alongside model persona', async () => {
      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              title: 'Missing transaction boundary',
              severity: 'warning',
              category: 'Correctness',
              file_path: 'src/db/query.ts',
              line: 21,
              rationale: 'Multi-statement operations must execute in a database transaction',
              confidence: 0.88,
            },
          ]),
        }),
      };

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });
      const res: any = await tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: diffWithSqliAndCmdi,
      });

      const data = JSON.parse(res.content[0].text);
      expect(mockModelClient.complete).toHaveBeenCalled();
      expect(data.findings.length).toBeGreaterThanOrEqual(3);

      const titles = data.findings.map((f: any) => f.title);
      expect(titles.some((t: string) => t.includes('SQL injection'))).toBe(true);
      expect(titles.some((t: string) => t.includes('Command Injection'))).toBe(true);
      expect(titles.some((t: string) => t.includes('Missing transaction'))).toBe(true);
      expect(data.eligible_to_ship).toBe(false);
    });

    it('EMP-PRE-03: near-duplicate claims merge cleanly via compareClaims and keep higher severity', async () => {
      const existing = [
        {
          finding_id: 'static-sqli-1',
          severity: 'P1' as const,
          category: 'Security',
          title: 'Potential SQL injection vulnerability via string concatenation',
          file_path: 'src/db/query.ts',
          line: 20,
          rationale: 'Dynamic SQL concatenation is unsafe',
          confidence: 0.8,
        },
      ];

      const modelFindings = [
        {
          finding_id: 'model-sqli-1',
          severity: 'P0' as const,
          category: 'Security',
          title: 'Potential SQL injection vulnerability via string concatenation in query',
          file_path: 'src/db/query.ts',
          line: 21, // Within near duplicate window (1 line apart)
          rationale: 'Model deep analysis: dynamic query allows arbitrary SQL execution by attackers.',
          suggested_fix: 'Use parameterized query placeholders.',
          confidence: 0.96,
        },
      ];

      const merged = deduplicateFindings(existing, modelFindings);
      expect(merged).toHaveLength(1);
      expect(merged[0].severity).toBe('P0');
      expect(merged[0].rationale).toContain('Model Analysis:');
      expect(merged[0].suggested_fix).toBe('Use parameterized query placeholders.');
      expect(merged[0].confidence).toBe(0.96);
    });

    it('EMP-PRE-04: distinct claims and different files do NOT merge', async () => {
      const existing = [
        {
          finding_id: 'find-1',
          severity: 'P1' as const,
          category: 'Security',
          title: 'SQL injection vulnerability in query builder',
          file_path: 'src/db/query.ts',
          line: 10,
          rationale: 'Unparameterized query dynamic interpolation',
        },
      ];

      const modelFindings = [
        {
          finding_id: 'find-2',
          severity: 'P1' as const,
          category: 'Security',
          title: 'SQL injection vulnerability in query builder',
          file_path: 'src/db/other.ts', // Different file!
          line: 10,
          rationale: 'Unparameterized query dynamic interpolation',
        },
        {
          finding_id: 'find-3',
          severity: 'P1' as const,
          category: 'Architecture',
          title: 'Unbounded ring buffer allocation memory leak', // Distinct claim!
          file_path: 'src/db/query.ts',
          line: 150,
          rationale: 'Memory leak due to queue overflow',
        },
      ];

      const merged = deduplicateFindings(existing, modelFindings);
      expect(merged).toHaveLength(3);
    });

    it('EMP-PRE-05: 12s timeout AbortController aborts cleanly and falls back to static findings without throwing', async () => {
      let receivedSignal: AbortSignal | undefined;
      const mockModelClient = {
        complete: vi.fn().mockImplementation(async (opts: any) => {
          receivedSignal = opts.signal;
          return new Promise((_, reject) => {
            if (opts.signal?.aborted) {
              reject(new Error('Aborted'));
              return;
            }
            opts.signal?.addEventListener('abort', () => {
              reject(new Error('Operation aborted by signal'));
            });
            setTimeout(() => reject(new Error('Model timeout')), 12_500);
          });
        }),
      };

      const tool = createPreflightDiffReviewTool({ modelClient: mockModelClient });

      vi.useFakeTimers();
      const execPromise = tool.execute({
        repo: 'calltelemetry/cisco-cdr',
        diff: diffWithSecretAndCode,
      });

      await vi.advanceTimersByTimeAsync(12_005);
      const res: any = await execPromise;
      vi.useRealTimers();

      expect(receivedSignal?.aborted).toBe(true);
      const data = JSON.parse(res.content[0].text);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].title).toContain('Hardcoded secret');
      expect(data.eligible_to_ship).toBe(false);
    });

    it('EMP-PRE-06: severity calibration demotes advisory titles and unverified premises', () => {
      // Advisory title demotion P1 -> P2
      expect(calibratePreflightSeverity('warning', 'Code style: naming conventions in vars', 'Variable should be camelCase')).toBe('P2');
      expect(calibratePreflightSeverity('P1', 'Formatting: trailing whitespace cleanup', 'Clean up spacing')).toBe('P2');
      expect(calibratePreflightSeverity('P1', 'Documentation typo in comment', 'Spelling error')).toBe('P2');

      // Unverified premise demotion P0/P1 -> P2
      expect(calibratePreflightSeverity('P0', 'Possible race condition', 'Could not confirm if caller holds lock')).toBe('P2');
      expect(calibratePreflightSeverity('blocking', 'Potential leak', 'Unable to verify stream closure without seeing the rest of the file')).toBe('P2');
      expect(calibratePreflightSeverity('P1', 'Missing auth check', 'Assuming that the route is public')).toBe('P2');
      expect(calibratePreflightSeverity('P1', 'Schema drift', 'Cannot verify database column type from diff alone')).toBe('P2');

      // Genuine P0/P1 remain intact
      expect(calibratePreflightSeverity('blocking', 'Authentication bypass vulnerability', 'User role check is completely omitted')).toBe('P0');
      expect(calibratePreflightSeverity('warning', 'Unbounded memory leak in buffer', 'Array grows on every request without eviction')).toBe('P1');
    });

    it('EMP-PRE-07: drops findings with confidence < 0.70', () => {
      const rawText = JSON.stringify([
        {
          title: 'High confidence defect',
          severity: 'P1',
          confidence: 0.85,
        },
        {
          title: 'Speculative borderline defect',
          severity: 'P1',
          confidence: 0.69,
        },
        {
          title: 'Low confidence guess',
          severity: 'P1',
          confidence: 0.30,
        },
      ]);

      const parsed = parseModelPersonaFindings(rawText, 'cisco-cdr');
      expect(parsed).toHaveLength(1);
      expect(parsed[0].title).toBe('High confidence defect');
    });
  });

  // =========================================================================
  // SECTION 2: generate_fix_diff Stress Testing
  // =========================================================================
  describe('generate_fix_diff stress testing', () => {

    it('EMP-FIX-01: synthesizeUnifiedDiff handles multi-line replacement with valid unidiff-zero git apply', () => {
      const filePath = 'src/billing/calculator.ts';
      const startLine = 20;
      const originalLines = 'const rate = 0.05;\nconst tax = 0.10;\nreturn amount * (rate + tax);';
      const replacementLines = 'const rate = computeDynamicRate(account);\nreturn amount * rate;';

      const patch = synthesizeUnifiedDiff(filePath, startLine, originalLines, replacementLines);
      expect(patch).toContain(`--- a/${filePath}\n+++ b/${filePath}\n@@ -20,3 +20,2 @@\n`);
      expect(patch).toContain('-const rate = 0.05;\n-const tax = 0.10;\n-return amount * (rate + tax);');
      expect(patch).toContain('+const rate = computeDynamicRate(account);\n+return amount * rate;');

      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });

    it('EMP-FIX-02: synthesizeUnifiedDiff handles pure addition (0 original lines)', () => {
      const filePath = 'src/auth/guard.ts';
      const startLine = 15;
      const originalLines = '';
      const replacementLines = 'if (!user.isAuthenticated()) {\n  throw new UnauthorizedError();\n}';

      const patch = synthesizeUnifiedDiff(filePath, startLine, originalLines, replacementLines);
      expect(patch).toContain(`--- a/${filePath}\n+++ b/${filePath}\n@@ -15,0 +15,3 @@\n`);
      const bodyLines = patch.split('\n').slice(3);
      expect(bodyLines.some(l => l.startsWith('-'))).toBe(false);
      expect(patch).toContain('+if (!user.isAuthenticated()) {\n+  throw new UnauthorizedError();\n+}');

      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });

    it('EMP-FIX-03: synthesizeUnifiedDiff handles pure deletion (0 replacement lines)', () => {
      const filePath = 'src/utils/debug.ts';
      const startLine = 5;
      const originalLines = 'console.log("DEBUG_RAW_PAYLOAD:", payload);';
      const replacementLines = '';

      const patch = synthesizeUnifiedDiff(filePath, startLine, originalLines, replacementLines);
      expect(patch).toContain(`--- a/${filePath}\n+++ b/${filePath}\n@@ -5,1 +5,0 @@\n`);
      expect(patch).toContain('-console.log("DEBUG_RAW_PAYLOAD:", payload);');
      const bodyLines = patch.split('\n').slice(3);
      expect(bodyLines.some(l => l.startsWith('+'))).toBe(false);

      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });

    it('EMP-FIX-04: test applying synthesized diffs via git apply --unidiff-zero --check and standard git apply --check in actual repo', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'git-apply-test-challenger-'));
      try {
        execSync('git init', { cwd: tempDir, stdio: 'ignore' });
        execSync('git config user.name "Challenger" && git config user.email "challenger@test.com"', { cwd: tempDir, stdio: 'ignore' });

        const fileContent = 'line1\nline2\noldLineA\noldLineB\nline5\n';
        writeFileSync(join(tempDir, 'sample.ts'), fileContent);
        execSync('git add sample.ts && git commit -m "initial"', { cwd: tempDir, stdio: 'ignore' });

        // Synthesize 0-context diff
        const patch = synthesizeUnifiedDiff('sample.ts', 3, 'oldLineA\noldLineB', 'newLineA\nnewLineB\nnewLineC');
        writeFileSync(join(tempDir, 'fix.patch'), patch);

        // 1. git apply --unidiff-zero --check must succeed
        let unidiffZeroSuccess = false;
        try {
          execSync('git apply --unidiff-zero --check fix.patch', { cwd: tempDir, stdio: 'pipe' });
          unidiffZeroSuccess = true;
        } catch {
          unidiffZeroSuccess = false;
        }
        expect(unidiffZeroSuccess).toBe(true);

        // 2. Standard git apply --check: 0-context unidiffs without context lines fail standard git apply
        // when file has surrounding lines because git apply expects standard -U3 context lines
        let standardApplySuccess = false;
        try {
          execSync('git apply --check fix.patch', { cwd: tempDir, stdio: 'pipe' });
          standardApplySuccess = true;
        } catch {
          standardApplySuccess = false;
        }
        expect(standardApplySuccess).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('EMP-FIX-05 [BUG CONFIRMATION]: generate_fix_diff MUST preserve pure deletion when replacementCode is empty string even if suggested_fix is present', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-del-1',
              payload: {
                findings: [
                  {
                    finding_id: 'find-del-101',
                    file_path: 'src/utils/debug.ts',
                    line_start: 5,
                    line_end: 5,
                    originalCode: 'console.log("DEBUG_RAW_PAYLOAD:", payload);',
                    replacementCode: '', // Intended deletion!
                    suggested_fix: 'Recommended fix implementation', // Default or advisory fix description!
                  },
                ],
              },
            },
          ],
        }),
      };

      const tool = createGenerateFixDiffTool({ queryableDatabase: mockDb });
      const res: any = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: 'find-del-101',
      });

      const data = JSON.parse(res.content[0].text);

      // Demonstrating the bug empirically:
      // Due to the bug in generateFixDiff.ts lines 276-281:
      // (typeof matchedFinding.replacementCode === 'string' && matchedFinding.replacementCode) || ...
      // an empty string '' evaluates to falsy and falls back to suggested_fix ('Recommended fix implementation')!
      console.log('EMP-FIX-05 Generated patch:\n' + data.patch);
      console.log('EMP-FIX-05 Replacement lines: "' + data.replacement_lines + '"');

      // The tool incorrectly emitted:
      // data.replacement_lines === 'Recommended fix implementation'
      // instead of:
      // data.replacement_lines === ''
      expect(data.replacement_lines).toBe('');
      expect(data.patch).toContain('@@ -5,1 +5,0 @@');
      expect(data.patch).not.toContain('+Recommended fix implementation');
    });

    it('EMP-FIX-06: generate_fix_diff AST line anchor accuracy matches finding line_start', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-ast-1',
              payload: {
                findings: [
                  {
                    finding_id: 'find-ast-202',
                    file_path: 'src/service.ts',
                    line_start: 42,
                    line_end: 43,
                    originalCode: 'const a = 1;\nconst b = 2;',
                    replacementCode: 'const a = 10;\nconst b = 20;',
                  },
                ],
              },
            },
          ],
        }),
      };

      const tool = createGenerateFixDiffTool({ queryableDatabase: mockDb });
      const res: any = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: 'find-ast-202',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.patch).toContain('@@ -42,2 +42,2 @@');
    });
  });
});
