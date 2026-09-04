import { timeBudgetMs } from '../support/timeBudget';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  EvaluationRunner,
  WorkspaceToolExecutor,
  parseToolCall,
  calculateMetrics,
  estimateCost,
  formatMarkdownReport,
  formatJSONReport,
  Finding,
  ExpectedFinding,
  ComparativeBenchmarkReport,
} from '../../src/evaluation/evaluationRunner';
import { EvaluationScenario, getAllScenarios, getScenarioById } from '../../src/evaluation/scenarios';

describe('Adversarial Verification Suite: EvaluationRunner & Scenarios', () => {
  const rootRepoDir = path.resolve(__dirname, '../..');
  const telecomWorkspaceRoot = path.resolve(rootRepoDir, 'tests/fixtures/workspaces/telecom-call-engine');

  // =========================================================================
  // 1. DIVISION BY ZERO & SNR / PRECISION / RECALL / F1 EDGE CASES
  // =========================================================================
  describe('1. Division by Zero & Metric Edge Cases', () => {
    it('handles TP=0, FP=0, FN=0 (clean scenario with zero findings)', () => {
      const metrics = calculateMetrics([], []);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1Score).toBe(1.0);
      expect(metrics.snr).toBe(0.0);
      expect(metrics.snrDb).toBe(20.0);
      expect(Number.isFinite(metrics.precision)).toBe(true);
      expect(Number.isFinite(metrics.recall)).toBe(true);
      expect(Number.isFinite(metrics.f1Score)).toBe(true);
      expect(Number.isFinite(metrics.snr)).toBe(true);
      expect(Number.isFinite(metrics.snrDb)).toBe(true);
    });

    it('handles TP=0, FP=0, FN>0 (missed all expected defects)', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/a.ts', line: 10, title: 'Bug 1' },
        { personaId: 'sec', severity: 'P1', path: 'src/b.ts', line: 20, title: 'Bug 2' },
      ];
      const actual: Finding[] = [];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(2);
      expect(metrics.precision).toBe(0.0);
      expect(metrics.recall).toBe(0.0);
      expect(metrics.f1Score).toBe(0.0);
      expect(metrics.snr).toBe(0.0);
      expect(metrics.snrDb).toBe(-10.0); // 10 * log10(0.01 / 0.1) = -10 dB
      expect(Number.isFinite(metrics.precision)).toBe(true);
      expect(Number.isFinite(metrics.recall)).toBe(true);
      expect(Number.isFinite(metrics.f1Score)).toBe(true);
      expect(Number.isFinite(metrics.snrDb)).toBe(true);
    });

    it('handles TP=0, FP>0, FN=0 (hallucinated findings on clean PR)', () => {
      const expected: ExpectedFinding[] = [];
      const actual: Finding[] = [
        { severity: 'P2', path: 'src/clean.ts', line: 5, title: 'Hallucination 1' },
        { severity: 'P2', path: 'src/clean.ts', line: 15, title: 'Hallucination 2' },
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(2);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBe(0.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1Score).toBe(0.0);
      expect(metrics.snr).toBe(0.0); // 0 / (2 + 1) = 0
      expect(metrics.snrDb).toBe(-23.01); // 10 * log10(0.01 / 2) = -23.01 dB
      expect(Number.isFinite(metrics.snrDb)).toBe(true);
    });

    it('handles TP=0, FP>0, FN>0 (missed expected defect and flagged unrelated file)', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/auth.ts', line: 10, title: 'Real bug' },
      ];
      const actual: Finding[] = [
        { severity: 'P2', path: 'src/other.ts', line: 50, title: 'Noise' },
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(1);
      expect(metrics.fn).toBe(1);
      expect(metrics.precision).toBe(0.0);
      expect(metrics.recall).toBe(0.0);
      expect(metrics.f1Score).toBe(0.0);
      expect(metrics.snr).toBe(0.0);
      expect(metrics.snrDb).toBe(-20.0); // 10 * log10(0.01 / 1) = -20 dB
    });

    it('handles completely undefined or null finding arrays gracefully', () => {
      const metrics1 = calculateMetrics(undefined, undefined);
      expect(metrics1.tp).toBe(0);
      expect(metrics1.fp).toBe(0);
      expect(metrics1.fn).toBe(0);

      const metrics2 = calculateMetrics([] as any, undefined as any);
      expect(metrics2.tp).toBe(0);
      expect(metrics2.fp).toBe(0);
    });
  });

  // =========================================================================
  // 2. EMPTY SCENARIOS & MODELS ARRAYS
  // =========================================================================
  describe('2. Empty Scenarios & Models Arrays in Benchmark Suite', () => {
    const runner = new EvaluationRunner({ offline: true });

    it('handles empty models array', async () => {
      const scenarios = getAllScenarios().slice(0, 2);
      const report = await runner.runBenchmarkSuite([], scenarios);

      expect(report.models).toEqual([]);
      expect(report.scenarios.length).toBe(2);
      expect(Object.keys(report.summary).length).toBe(0);
      expect(report.detailedResults.length).toBe(0);

      const markdown = formatMarkdownReport(report);
      expect(markdown).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(markdown).toContain('**Evaluated Models**: ');
      expect(markdown).toContain('**Total Scenarios**: 2');

      const jsonStr = formatJSONReport(report);
      const roundtrip = JSON.parse(jsonStr);
      expect(roundtrip.models).toEqual([]);
    });

    it('handles empty scenarios array', async () => {
      const models = ['openai/gpt-5.6-luna', 'anthropic/claude-3.7-sonnet'];
      const report = await runner.runBenchmarkSuite(models, []);

      expect(report.models).toEqual(models);
      expect(report.scenarios).toEqual([]);
      expect(report.detailedResults.length).toBe(0);

      for (const model of models) {
        const s = report.summary[model];
        expect(s).toBeDefined();
        expect(s.totalScenarios).toBe(0);
        expect(s.verdictAccuracy).toBe(0);
        expect(s.f1Score).toBe(0);
        expect(s.avgSnr).toBe(0);
        expect(s.avgSnrDb).toBe(0);
        expect(s.avgTtftMs).toBe(0);
        expect(s.totalTokens).toBe(0);
        expect(s.totalCostUSD).toBe(0);
        expect(s.costEfficiency).toBe(0);
      }

      const markdown = formatMarkdownReport(report);
      expect(markdown).toContain('`openai/gpt-5.6-luna`');
      expect(markdown).toContain('**0.0%**');

      const jsonStr = formatJSONReport(report);
      expect(() => JSON.parse(jsonStr)).not.toThrow();
    });

    it('handles both empty models AND empty scenarios arrays', async () => {
      const report = await runner.runBenchmarkSuite([], []);
      expect(report.models).toEqual([]);
      expect(report.scenarios).toEqual([]);
      expect(report.detailedResults).toEqual([]);
      expect(Object.keys(report.summary).length).toBe(0);

      const markdown = formatMarkdownReport(report);
      expect(markdown).toBeDefined();
      const parsed = JSON.parse(formatJSONReport(report));
      expect(parsed.models).toEqual([]);
      expect(parsed.scenarios).toEqual([]);
    });
  });

  // =========================================================================
  // 3. LARGE FINDINGS LISTS, MALFORMED PATHS, INVALID SEVERITY, IRREGULAR PATTERNS
  // =========================================================================
  describe('3. Robustness against Malformed & Large Findings Data', () => {
    it('scales to 5,000 findings without performance collapse or crash', () => {
      const expected: ExpectedFinding[] = Array.from({ length: 50 }, (_, i) => ({
        personaId: 'security',
        severity: 'P1',
        path: `src/module_${i % 10}.ts`,
        line: 10 + (i * 2),
        title: `Defect ${i}`,
      }));

      const actual: Finding[] = Array.from({ length: 5000 }, (_, i) => ({
        severity: 'P1',
        path: `src/module_${i % 10}.ts`,
        line: 10 + (i * 2),
        title: `Candidate ${i}`,
      }));

      const start = Date.now();
      const metrics = calculateMetrics(expected, actual, { lineTolerance: 5 });
      const elapsed = Date.now() - start;

      expect(metrics.tp).toBe(50);
      expect(metrics.fp).toBe(4950);
      expect(metrics.fn).toBe(0);
      expect(metrics.recall).toBe(1.0);
      expect(elapsed).toBeLessThan(timeBudgetMs(1000)); // Must complete within 1 second
    });

    it('handles path normalization: Windows backslashes, leading ./, case variations, trailing spaces', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'security',
          severity: 'P0',
          path: 'src/Controllers/Auth.ts',
          line: 25,
          title: 'Auth flaw',
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P0',
          path: ' .\\src\\controllers\\auth.ts  ',
          line: 25,
          title: 'Auth flaw',
        },
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(0);
    });

    it('handles malformed / undefined / empty paths without crashing', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'sec',
          severity: 'P0',
          path: '',
          title: 'No path expected',
        },
      ];

      const actual: Finding[] = [
        { severity: 'P0', path: undefined, title: 'No path actual' },
        { severity: 'P1', path: '', title: 'Empty string path' },
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(1);
    });

    it('handles invalid lines (NaN, -1, Infinity, 0, undefined)', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/test.ts', line: 10, title: 'Valid line' },
      ];

      const actual: Finding[] = [
        { severity: 'P0', path: 'src/test.ts', line: NaN, title: 'NaN line' },
        { severity: 'P0', path: 'src/test.ts', line: -50, title: 'Negative line' },
        { severity: 'P0', path: 'src/test.ts', line: Infinity, title: 'Infinity line' },
        { severity: 'P0', path: 'src/test.ts', line: undefined, title: 'Undefined line' },
      ];

      expect(() => calculateMetrics(expected, actual)).not.toThrow();
      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(3);
    });

    it('handles special regex characters in titlePattern safely without ReDoS or crash', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'perf',
          severity: 'P1',
          path: 'src/query.ts',
          line: 10,
          titlePattern: 'SELECT * FROM (users|accounts) WHERE [id]=?',
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P1',
          path: 'src/query.ts',
          line: 10,
          title: 'Flagged query: SELECT * FROM users WHERE [id]=?',
        },
      ];

      expect(() => calculateMetrics(expected, actual)).not.toThrow();
    });

    it('handles invalid / custom severity strings in loose vs strict mode', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/app.ts', line: 10 },
      ];

      const actual: Finding[] = [
        { severity: 'CRITICAL' as any, path: 'src/app.ts', line: 10 },
      ];

      const loose = calculateMetrics(expected, actual, { strictSeverity: false });
      expect(loose.tp).toBe(1);

      const strict = calculateMetrics(expected, actual, { strictSeverity: true });
      expect(strict.tp).toBe(0);
      expect(strict.fp).toBe(1);
    });
  });

  // =========================================================================
  // 4. EXTREME TTFT, TOKENS, AND COST CALCULATIONS
  // =========================================================================
  describe('4. Extreme TTFT, Token Counts, and Cost Telemetry', () => {
    const runner = new EvaluationRunner({ offline: true });

    it('handles zero tokens and zero cost without division by zero in cost efficiency', async () => {
      const scenario = getScenarioById('sec-multi-tenant-isolation')!;

      const res = await runner.runScenario('openai/gpt-5.6-luna', scenario, {
        mockAdapter: () => ({
          findings: [
            {
              severity: 'P0',
              path: 'src/repositories/memberRepository.ts',
              line: 14,
              title: 'Missing tenant isolation predicate in database query',
              body: 'Missing tenant isolation predicate',
            },
          ],
          promptTokens: 0,
          completionTokens: 0,
          costUSD: 0,
          ttftMs: 0,
        }),
      });

      expect(res.costUSD).toBe(0);
      expect(res.promptTokens).toBe(0);
      expect(res.completionTokens).toBe(0);
      expect(res.totalTokens).toBe(0);
      expect(res.ttftMs).toBe(0);
      expect(res.tp).toBe(1);
      expect(Number.isFinite(res.costEfficiency)).toBe(true);
      expect(res.costEfficiency).toBeGreaterThan(0);
    });

    it('handles massive token counts and cost values gracefully', async () => {
      const scenario = getScenarioById('clean-multi-feature-ship')!;

      const res = await runner.runScenario('openai/gpt-5.6-luna', scenario, {
        mockAdapter: () => ({
          findings: [],
          promptTokens: 10_000_000,
          completionTokens: 5_000_000,
          costUSD: 50.0,
          ttftMs: 95_000,
        }),
      });

      expect(res.promptTokens).toBe(10_000_000);
      expect(res.completionTokens).toBe(5_000_000);
      expect(res.totalTokens).toBe(15_000_000);
      expect(res.costUSD).toBe(50.0);
      expect(res.ttftMs).toBe(95_000);
      expect(res.f1Score).toBe(1.0);
      expect(Number.isFinite(res.costEfficiency)).toBe(true);
    });

    it('estimateCost correctly calculates for unknown model using fallback pricing', () => {
      const cost = estimateCost('unknown-vendor/custom-32b-model', 1_000_000, 1_000_000);
      expect(cost).toBe(2.0);
    });
  });

  // =========================================================================
  // 5. OFFLINE STREAMING REPLAY AGAINST MOCK NETWORK DELAYS & JITTER
  // =========================================================================
  describe('5. Offline Streaming Replay with Network Delays & Chunked SSE', () => {
    const runner = new EvaluationRunner({ offline: false });

    it('handles slow multi-chunk streaming with mock network latency and measures TTFT accurately', async () => {
      const chunks = [
        'data: {"model":"openai/gpt-5.6-luna","choices":[{"delta":{"content":"{\\"findings\\": ["}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"severity\\":\\"P0\\",\\"path\\":\\"src/repositories/memberRepository.ts\\",\\"line\\":14,\\"title\\":\\"Missing tenant predicate\\",\\"body\\":\\"Missing orgId check\\"}"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"]}"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1200,"completion_tokens":250,"total_tokens":1450},"cost":0.0039}\n\n',
        'data: [DONE]\n\n',
      ];

      const delayedFetch = async () => {
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for (let i = 0; i < chunks.length; i++) {
              await new Promise((r) => setTimeout(r, 15));
              controller.enqueue(encoder.encode(chunks[i]));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const scenario = getScenarioById('sec-multi-tenant-isolation')!;
      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario, {
        offline: false,
        apiKey: 'test-key',
        fetchImplementation: delayedFetch as any,
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.verdictMatch).toBe(true);
      expect(result.tp).toBeGreaterThanOrEqual(1);
      expect(result.promptTokens).toBe(1200);
      expect(result.completionTokens).toBe(250);
      expect(result.costUSD).toBe(0.0039);
      expect(result.ttftMs).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(result.ttftMs);
    });

    it('handles noisy SSE stream with comments and whitespace chunks', async () => {
      const noisyChunks = [
        ': ping\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\n',
        '\n\n',
        'data: {"usage":{"prompt_tokens":500,"completion_tokens":50,"total_tokens":550}}\n\n',
        'data: [DONE]\n\n',
      ];

      const noisyFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of noisyChunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const scenario = getScenarioById('clean-multi-feature-ship')!;
      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario, {
        offline: false,
        apiKey: 'test-key',
        fetchImplementation: noisyFetch as any,
      });

      expect(result.verdict).toBe('SHIP');
      expect(result.verdictMatch).toBe(true);
      expect(result.tp).toBe(0);
      expect(result.fp).toBe(0);
      expect(result.f1Score).toBe(1.0);
    });
  });

  // =========================================================================
  // 6. MARKDOWN REPORT COLUMN ALIGNMENT & JSON SERIALIZATION ROUNDTRIP
  // =========================================================================
  describe('6. Report Markdown Formatting & JSON Serialization Fidelity', () => {
    const runner = new EvaluationRunner({ offline: true });

    it('verifies Markdown table column count matches header column count exactly across all rows', async () => {
      const models = [
        'openai/gpt-5.6-luna',
        'anthropic/claude-3.7-sonnet',
        'deepseek/deepseek-r1',
        'openai/gpt-4o',
        'google/gemini-2.5-pro',
      ];
      const scenarios = getAllScenarios().slice(0, 4);
      const report = await runner.runBenchmarkSuite(models, scenarios);

      const markdown = formatMarkdownReport(report);
      const lines = markdown.split('\n');

      let inSummaryTable = false;
      let summaryHeaderCols = 0;

      for (const line of lines) {
        if (line.startsWith('| Model |')) {
          inSummaryTable = true;
          summaryHeaderCols = line.split('|').length;
          expect(summaryHeaderCols).toBe(13);
          continue;
        }
        if (inSummaryTable) {
          if (line.trim() === '' || line.startsWith('##')) {
            inSummaryTable = false;
          } else {
            const rowCols = line.split('|').length;
            expect(rowCols).toBe(summaryHeaderCols);
          }
        }
      }

      let inDetailTable = false;
      let detailHeaderCols = 0;

      for (const line of lines) {
        if (line.startsWith('| Scenario ID |')) {
          inDetailTable = true;
          detailHeaderCols = line.split('|').length;
          expect(detailHeaderCols).toBe(15);
          continue;
        }
        if (inDetailTable) {
          if (line.trim() === '' || line.startsWith('##')) {
            inDetailTable = false;
          } else {
            const rowCols = line.split('|').length;
            expect(rowCols).toBe(detailHeaderCols);
          }
        }
      }
    });

    it('verifies JSON serialization round-trips with zero data loss or alteration', async () => {
      const models = ['openai/gpt-5.6-luna', 'anthropic/claude-3.7-sonnet'];
      const scenarios = getAllScenarios().slice(0, 3);
      const report = await runner.runBenchmarkSuite(models, scenarios);

      const jsonString = formatJSONReport(report);
      const deserialized: ComparativeBenchmarkReport = JSON.parse(jsonString);

      expect(deserialized.timestamp).toBe(report.timestamp);
      expect(deserialized.models).toEqual(report.models);
      expect(deserialized.scenarios).toEqual(report.scenarios);
      expect(deserialized.detailedResults.length).toBe(report.detailedResults.length);

      for (const model of models) {
        const origSummary = report.summary[model];
        const deserSummary = deserialized.summary[model];
        expect(deserSummary).toEqual(origSummary);
      }

      for (let i = 0; i < report.detailedResults.length; i++) {
        expect(deserialized.detailedResults[i]).toEqual(report.detailedResults[i]);
      }
    });
  });

  // =========================================================================
  // 7. WORKSPACE PATH TRAVERSAL FUZZING & SECURITY BOUNDARY HARDENING
  // =========================================================================
  describe('7. Workspace Path Traversal Fuzzing & Security Boundary Hardening', () => {
    const executor = new WorkspaceToolExecutor(telecomWorkspaceRoot);

    it('rejects complex directory traversal escape sequences', async () => {
      const maliciousPaths = [
        '../package.json',
        '../../package.json',
        '../../../etc/passwd',
        'sip_signaling_service/../../../../../../etc/shadow',
        '..\\..\\windows\\system32',
        'sub/dir/../../../../../../var/log/syslog',
        '/etc/passwd',
        '/var/run/docker.sock',
      ];

      for (const p of maliciousPaths) {
        await expect(executor.fileRead(p)).rejects.toThrow('Access denied');
      }
    });

    it('handles empty, null, and whitespace paths safely', async () => {
      await expect(executor.fileRead('')).rejects.toThrow('Invalid path');
      await expect(executor.fileRead('   ')).rejects.toThrow('Invalid path');
      await expect(executor.fileRead(null as any)).rejects.toThrow('Invalid path');
      await expect(executor.fileRead(undefined as any)).rejects.toThrow('Invalid path');
    });

    it('handles out-of-bounds startLine and endLine gracefully', async () => {
      // startLine beyond file length
      const res1 = await executor.fileRead('README.md', 9999, 10000);
      expect(res1).toContain('empty');

      // negative and zero startLine normalized to 1
      const res2 = await executor.fileRead('README.md', -5, 2);
      expect(res2).toContain('1: # Generic Telecom Call Engine');
      expect(res2).toContain('2: ');
    });
  });

  // =========================================================================
  // 8. WORKSPACE TOOL BOUNDED EXECUTION & STRESS CONSTRAINTS
  // =========================================================================
  describe('8. Workspace Tool Stress & Bounded Execution Constraints', () => {
    it('enforces custom maxFileSize limit', async () => {
      // Instantiate executor with 50-byte max file size
      const boundedExecutor = new WorkspaceToolExecutor(telecomWorkspaceRoot, { maxFileSize: 50 });
      const res = await boundedExecutor.fileRead('README.md');
      expect(res).toContain('Error: File exceeds maximum allowed size');
    });

    it('safely handles malformed regex patterns in codeSearch without throwing', async () => {
      const executor = new WorkspaceToolExecutor(telecomWorkspaceRoot);
      const malformedPatterns = ['[unclosed-bracket', '(unclosed-group', '***invalid-quantifier', '\\'];

      for (const pattern of malformedPatterns) {
        expect(async () => {
          const res = await executor.codeSearch(pattern);
          expect(Array.isArray(res)).toBe(true);
        }).not.toThrow();
      }
    });

    it('safely escapes special regex characters in symbolLookup', async () => {
      const executor = new WorkspaceToolExecutor(telecomWorkspaceRoot);
      const extremeSymbols = ['*PortAllocator*', 'Dialog(Manager)', '[TariffRatingEngine]', '.*'];

      for (const sym of extremeSymbols) {
        expect(async () => {
          const res = await executor.symbolLookup(sym);
          expect(Array.isArray(res)).toBe(true);
        }).not.toThrow();
      }
    });

    it('executeTool handles unexpected argument shapes safely', async () => {
      const executor = new WorkspaceToolExecutor(telecomWorkspaceRoot);

      // Missing path
      const res1 = await executor.executeTool('file_read', {});
      expect(res1).toContain('Error: Missing "path" argument');

      // Missing pattern
      const res2 = await executor.executeTool('code_search', {});
      expect(res2).toContain('Error: Missing "pattern" argument');

      // Missing symbolName
      const res3 = await executor.executeTool('symbol_lookup', {});
      expect(res3).toContain('Error: Missing "symbolName" argument');
    });
  });

  // =========================================================================
  // 9. ADVERSARIAL MULTI-TURN LOOP STREAMING & ERROR RECOVERY
  // =========================================================================
  describe('9. Adversarial Multi-Turn Loop Streaming & Error Recovery', () => {
    it('recovers gracefully when model requests a non-existent file in turn 1', async () => {
      let turnNumber = 0;

      const errorRecoveryFetch = async (input: any, init: any): Promise<Response> => {
        turnNumber++;
        const body = JSON.parse(init.body);
        const messages = body.messages;

        if (turnNumber === 1) {
          // Model asks for non-existent file
          const streamData = [
            'data: {"choices":[{"delta":{"content":"{\\"tool\\":\\"file_read\\",\\"args\\":{\\"path\\":\\"non_existent_module.ts\\"}}"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":400,"completion_tokens":30,"total_tokens":430},"cost":0.001}\n\n',
            'data: [DONE]\n\n',
          ];
          return new Response(streamData.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        } else {
          // Verify turn 2 received the file not found error message
          const lastMsg = messages[messages.length - 1].content;
          expect(lastMsg).toContain('Error: File not found in workspace: non_existent_module.ts');

          // Model recognizes error and finishes with SHIP verdict findings
          const streamData = [
            'data: {"choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":550,"completion_tokens":40,"total_tokens":590},"cost":0.0012}\n\n',
            'data: [DONE]\n\n',
          ];
          return new Response(streamData.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
      };

      const runner = new EvaluationRunner({
        offline: false,
        apiKey: 'test-key',
        fetchImplementation: errorRecoveryFetch as any,
        workspaceRoot: telecomWorkspaceRoot,
      });

      const scenario = getScenarioById('clean-multi-feature-ship')!;
      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario);

      expect(result.turnDepth).toBe(2);
      expect(result.verdict).toBe('SHIP');
      expect(result.verdictMatch).toBe(true);
    });

    it('parses bracket syntax with unquoted or single string argument', () => {
      const raw = '[TOOL_CALL: file_read(sip_signaling_service/src/dialogManager.ts)]';
      const parsed = parseToolCall(raw);
      expect(parsed).toEqual({
        tool: 'file_read',
        args: { path: 'sip_signaling_service/src/dialogManager.ts' },
      });
    });
  });
});
