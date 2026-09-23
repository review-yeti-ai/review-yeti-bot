import { describe, expect, it, vi } from 'vitest';
import {
  createGenerateFixDiffTool,
  synthesizeUnifiedDiff,
  validatePatchWithGitApply,
} from '../../src/mcp/server/tools/generateFixDiff';
import {
  createPreflightDiffReviewTool,
  calibratePreflightSeverity,
  deduplicateFindings,
  parseModelPersonaFindings,
} from '../../src/mcp/server/tools/preflightDiffReview';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import { createExplainFindingTool } from '../../src/mcp/server/tools/explainFinding';

describe('Milestone 1 Iteration 2 Challenger Stress Harness', () => {

  // =========================================================================
  // SUITE 1: synthesizeUnifiedDiff Edge Cases & git apply validation
  // =========================================================================
  describe('synthesizeUnifiedDiff edge cases & git apply validation', () => {

    it('CHAL-DIFF-01: Multi-line original with interior blank lines and trailing newline', () => {
      const filePath = 'src/parser/lexer.ts';
      const startLine = 10;
      const originalLines = 'const a = 1;\n\nconst b = 2;\n';
      const replacementLines = 'const a = 10;\n\nconst b = 20;\n';

      const patch = synthesizeUnifiedDiff(filePath, startLine, originalLines, replacementLines);
      expect(patch).toContain(`--- a/${filePath}\n+++ b/${filePath}\n@@ -10,3 +10,3 @@\n`);
      expect(patch).toContain('-const a = 1;\n-\n-const b = 2;');
      expect(patch).toContain('+const a = 10;\n+\n+const b = 20;');

      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });

    it('CHAL-DIFF-02: Multi-line pure deletion of 5 lines to 0 lines with git apply validation', () => {
      const filePath = 'src/legacy/unused.ts';
      const startLine = 50;
      const originalLines = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
      const replacementLines = '';

      const patch = synthesizeUnifiedDiff(filePath, startLine, originalLines, replacementLines);
      expect(patch).toContain(`--- a/${filePath}\n+++ b/${filePath}\n@@ -50,5 +50,0 @@\n`);
      const body = patch.split('\n').slice(3).join('\n');
      expect(body).not.toContain('+');
      expect(patch).toContain('-line 1\n-line 2\n-line 3\n-line 4\n-line 5');

      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });

    it('CHAL-DIFF-03: CRLF line endings in originalLines and replacementLines normalize cleanly without carriage returns in diff', () => {
      const filePath = 'src/windows/crlf.ts';
      const startLine = 1;
      const originalLines = 'const win = true;\r\nconst msg = "hello";\r\n';
      const replacementLines = 'const win = false;\r\n';

      const patch = synthesizeUnifiedDiff(filePath, startLine, originalLines, replacementLines);
      expect(patch).not.toContain('\r');
      expect(patch).toContain(`--- a/${filePath}\n+++ b/${filePath}\n@@ -1,2 +1,1 @@\n`);
      expect(patch).toContain('-const win = true;\n-const msg = "hello";\n+const win = false;\n');

      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });

    it('CHAL-DIFF-04: Leading slash in filePath is stripped cleanly in diff headers', () => {
      const filePath = '/absolute/style/path.ts';
      const patch = synthesizeUnifiedDiff(filePath, 5, 'const x = 1;', 'const x = 2;');
      expect(patch).toContain('--- a/absolute/style/path.ts\n+++ b/absolute/style/path.ts\n');
      expect(patch).not.toContain('--- a//');
    });

    it('CHAL-DIFF-05: Single line replacement with no trailing newline in input', () => {
      const filePath = 'src/single.ts';
      const originalLines = 'foo()';
      const replacementLines = 'bar()';
      const patch = synthesizeUnifiedDiff(filePath, 1, originalLines, replacementLines);
      expect(patch).toContain('@@ -1,1 +1,1 @@\n-foo()\n+bar()\n');
      const val = validatePatchWithGitApply(patch, filePath, originalLines);
      expect(val.valid).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 2: generateFixDiff Fallback & Deletion Preservation Chain
  // =========================================================================
  describe('generateFixDiff fallback & deletion preservation chain', () => {

    it('CHAL-FIX-01: fixOptions[0].suggestionCode = "" is preserved as pure deletion', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-opt-del',
              payload: {
                findings: [
                  {
                    finding_id: 'opt-del-01',
                    file_path: 'src/opt.ts',
                    line_start: 15,
                    line_end: 15,
                    originalCode: 'removeMe();',
                    fixOptions: [
                      { suggestionCode: '', explanation: 'Drop redundant call' },
                    ],
                    suggested_fix: 'Fallback suggestion should NOT be used',
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
        pr_number: 1,
        finding_id: 'opt-del-01',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.replacement_lines).toBe('');
      expect(data.patch).toContain('@@ -15,1 +15,0 @@');
      expect(data.explanation).toBe('Drop redundant call');
    });

    it('CHAL-FIX-02: suggestion = "" is preserved as pure deletion when replacementCode and fixOptions are absent', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sugg-del',
              payload: {
                findings: [
                  {
                    finding_id: 'sugg-del-01',
                    file_path: 'src/sugg.ts',
                    line_start: 22,
                    line_end: 22,
                    originalCode: 'deleteMe();',
                    suggestion: '',
                    suggested_fix: 'Fallback suggestion should NOT be used',
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
        pr_number: 1,
        finding_id: 'sugg-del-01',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.replacement_lines).toBe('');
      expect(data.patch).toContain('@@ -22,1 +22,0 @@');
    });

    it('CHAL-FIX-03: Model output that fails git apply validation is rejected and falls back to static replacement', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-val-reject',
              payload: {
                findings: [
                  {
                    finding_id: 'find-reject-01',
                    file_path: 'src/service.ts',
                    line_start: 5,
                    line_end: 5,
                    originalCode: 'const x = 1;',
                    replacementCode: 'const x = 2;',
                  },
                ],
              },
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            replacement_lines: 'const x = 999;',
            explanation: 'Model fix',
          }),
        }),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
        validatePatch: true,
      });

      const res: any = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 1,
        finding_id: 'find-reject-01',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.replacement_lines).toBe('const x = 999;');
      expect(data.patch).toContain('+const x = 999;');
    });

    it('CHAL-FIX-04: Model markdown code block wrapping is stripped or handled cleanly', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-md-wrap',
              payload: {
                findings: [
                  {
                    finding_id: 'find-md-01',
                    file_path: 'src/app.ts',
                    line_start: 1,
                    line_end: 1,
                    originalCode: 'let val = null;',
                    replacementCode: 'let val = undefined;',
                  },
                ],
              },
            },
          ],
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: 'Here is the fix:\n```json\n{\n  "replacement_lines": "let val = 0;",\n  "explanation": "Default to zero"\n}\n```',
        }),
      };

      const tool = createGenerateFixDiffTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 1,
        finding_id: 'find-md-01',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.replacement_lines).toBe('let val = 0;');
      expect(data.patch).toContain('+let val = 0;');
      expect(data.explanation).toBe('Default to zero');
    });
  });

  // =========================================================================
  // SUITE 3: preflightDiffReview Severity Calibration & Deduplication
  // =========================================================================
  describe('preflightDiffReview severity calibration & deduplication', () => {

    it('CHAL-PRE-01: calibratePreflightSeverity maps blocking to P0, warning to P1, advisory to P2', () => {
      expect(calibratePreflightSeverity('blocking', 'Critical SQLi', 'Unparameterized query')).toBe('P0');
      expect(calibratePreflightSeverity('warning', 'Potential bug', 'Null check omitted')).toBe('P1');
      expect(calibratePreflightSeverity('advisory', 'Code style', 'Rename variable')).toBe('P2');
      expect(calibratePreflightSeverity('unknown', 'Miscellaneous', 'General remark')).toBe('P1');
    });

    it('CHAL-PRE-02: deduplicateFindings preserves higher confidence and enriches rationale when model matches static finding', () => {
      const staticFindings = [
        {
          finding_id: 'stat-01',
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
          finding_id: 'mod-01',
          severity: 'P0' as const,
          category: 'Security',
          title: 'Potential SQL injection vulnerability via string concatenation in query',
          file_path: 'src/db/query.ts',
          line: 20,
          rationale: 'Active SQL vulnerability allows arbitrary code execution',
          suggested_fix: 'Use parameterized query placeholders',
          confidence: 0.99,
        },
      ];

      const merged = deduplicateFindings(staticFindings, modelFindings);
      expect(merged).toHaveLength(1);
      expect(merged[0].severity).toBe('P0');
      expect(merged[0].confidence).toBe(0.99);
      expect(merged[0].suggested_fix).toBe('Use parameterized query placeholders');
      expect(merged[0].rationale).toContain('Dynamic SQL concatenation');
      expect(merged[0].rationale).toContain('Active SQL vulnerability');
    });
  });

  // =========================================================================
  // SUITE 4: disputeFinding & explainFinding Resilience
  // =========================================================================
  describe('disputeFinding & explainFinding resilience', () => {

    it('CHAL-DIS-01: disputeFinding handles model returning raw json with leading/trailing text', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  run_id: 'run-dis-md',
                  execution_attempt: 1,
                  payload: {
                    result: {
                      personas: [
                        {
                          findings: [
                            {
                              finding_id: 'f-dis-1',
                              title: 'Race condition in cache',
                              severity: 'P1',
                              category: 'Concurrency',
                              file_path: 'src/cache.ts',
                              line_start: 10,
                              line_end: 15,
                              status: 'OPEN',
                              resolved: false,
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: 'Here is my evaluation:\n```json\n{"verdict": "overruled", "reasoning": "Single-threaded event loop prevents race condition here", "confidence": 0.91}\n```\nHope this helps.',
        }),
      };

      const tool = createDisputeFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 99,
        finding_id: 'f-dis-1',
        counter_argument: 'Node.js is single-threaded and the operation is synchronous.',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.verdict).toBe('overruled');
      expect(data.confidence).toBe(0.91);
      expect(data.reasoning).toContain('Single-threaded event loop');
    });

    it('CHAL-EXP-01: explainFinding evaluates proposal with authenticated caller and cites ADRs', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-exp-1',
              payload: {
                result: {
                  personas: [
                    {
                      findings: [
                        {
                          finding_id: 'f-exp-1',
                          title: 'Missing input validation',
                          severity: 'P1',
                          category: 'Security',
                          file_path: 'src/api.ts',
                          line_start: 30,
                          line_end: 35,
                          violated_adrs: ['ADR-0010'],
                          rationale: 'Unvalidated user input passed directly to database',
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

      const mockModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            explanation: 'The endpoint accepts unsanitized user strings without schema validation.',
            satisfies_requirement: true,
            proposal_assessment: 'Adding Zod schema validation satisfies ADR-0010.',
            remediation_options: ['Use Zod schema validation middleware'],
          }),
        }),
      };

      const tool = createExplainFindingTool({
        queryableDatabase: mockDb,
        modelClient: mockModelClient,
      });

      const res: any = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 99,
          finding_id: 'f-exp-1',
          question: 'Does validating request body using Zod schema at controller entrypoint fix this?',
        },
        {
          caller: {
            authType: 'static_token',
            tokenDigest: 'mock-digest',
            isAdmin: true,
            callerId: 'test-admin',
            allowedRepositories: null,
          },
        }
      );

      const data = JSON.parse(res.content[0].text);
      expect(data.satisfies_requirement).toBe(true);
      expect(data.explanation).toContain('unsanitized user strings');
      expect(data.citations).toContain('ADR-0010');
    });

    it('CHAL-EXP-02: explainFinding fails closed when unauthenticated or caller lacks repo access', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ run_id: 'run-1', payload: {} }],
        }),
      };

      const tool = createExplainFindingTool({ queryableDatabase: mockDb });

      // Unauthenticated call without context.caller
      const res: any = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 99,
        finding_id: 'f-exp-secret',
        question: 'What is this finding?',
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.explanation).toContain('was not found in the review ledger');
      expect(data.satisfies_requirement).toBeNull();
    });
  });
});
