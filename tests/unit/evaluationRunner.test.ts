import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  EvaluationRunner,
  WorkspaceToolExecutor,
  parseToolCall,
  calculateMetrics,
  estimateCost,
  getSimulatedProfile,
  deterministicScore,
  formatMarkdownReport,
  formatJSONReport,
  MODEL_PRICING_TABLE,
  Finding,
  EvaluationMetrics,
  ScenarioEvaluationResult,
  ComparativeBenchmarkReport,
} from '../../src/evaluation/evaluationRunner';
import {
  getAllScenarios,
  getScenarioById,
  getScenariosByCategory,
  EvaluationScenario,
  ExpectedFinding,
} from '../../src/evaluation/scenarios';
import { createCassetteFetch } from '../support/cassetteFetch';

describe('Evaluation Runner & Comparative Metrics Engine', () => {
  const rootRepoDir = path.resolve(__dirname, '../..');
  const telecomWorkspaceRoot = path.resolve(rootRepoDir, 'tests/fixtures/workspaces/telecom-call-engine');

  // =========================================================================
  // 1. METRICS CALCULATION (SNR, ACCURACY, PRECISION, RECALL, F1)
  // =========================================================================
  describe('calculateMetrics()', () => {
    it('calculates perfect 1.0 precision, recall, and F1 for exact finding matches', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'security',
          severity: 'P0',
          path: 'src/controllers/userController.ts',
          line: 42,
          title: 'SQL injection in search query',
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P0',
          path: 'src/controllers/userController.ts',
          line: 42,
          title: 'SQL injection in search query',
          body: 'Unsanitized query parameters allow SQL injection.',
        },
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1Score).toBe(1.0);
      expect(metrics.snr).toBe(1.0); // TP / (FP + 1) = 1 / 1 = 1.0
      expect(metrics.snrDb).toBe(10.0); // 10 * log10(1 / 0.1) = 10.0
      expect(metrics.matchedFindings.length).toBe(1);
      expect(metrics.unmatchedActual.length).toBe(0);
      expect(metrics.unmatchedExpected.length).toBe(0);
    });

    it('correctly calculates metrics with false positives and false negatives', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'security',
          severity: 'P0',
          path: 'src/auth/jwt.ts',
          line: 15,
          title: 'Hardcoded JWT secret',
        },
        {
          personaId: 'security',
          severity: 'P1',
          path: 'src/auth/roles.ts',
          line: 50,
          title: 'Missing admin permission check',
        },
      ];

      const actual: Finding[] = [
        // True positive (matches jwt.ts line 15)
        {
          severity: 'P0',
          path: 'src/auth/jwt.ts',
          line: 16, // within default tolerance of 5 lines
          title: 'Hardcoded secret detected',
          body: 'Secret is in plaintext',
        },
        // False positive 1
        {
          severity: 'P2',
          path: 'src/utils/logger.ts',
          line: 10,
          title: 'Prefer structured logging',
          body: 'Formatting issue',
        },
        // False positive 2
        {
          severity: 'P2',
          path: 'src/auth/jwt.ts',
          line: 99,
          title: 'Style nit: rename variable',
          body: 'Variable naming',
        },
      ];

      const metrics = calculateMetrics(expected, actual, { lineTolerance: 5 });
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(2);
      expect(metrics.fn).toBe(1); // missed roles.ts line 50
      expect(metrics.precision).toBe(Math.round((1 / 3) * 1000) / 1000); // 0.333
      expect(metrics.recall).toBe(0.5); // 1 / 2
      expect(metrics.f1Score).toBe(0.4); // 2 * (1/3 * 0.5) / (1/3 + 0.5) = 0.4
      expect(metrics.snr).toBe(Math.round((1 / (2 + 1)) * 100) / 100); // 0.33
      expect(metrics.snrDb).toBe(Math.round(10 * Math.log10(1 / 2) * 100) / 100); // -3.01 dB
    });

    it('handles clean diff with zero expected findings and zero actual findings', () => {
      const metrics = calculateMetrics([], []);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1Score).toBe(1.0);
      expect(metrics.snr).toBe(0.0);
      expect(metrics.snrDb).toBe(20.0); // Baseline clean score
    });

    it('matches findings with titlePattern regex', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'performance',
          severity: 'P1',
          path: 'src/services/userService.ts',
          line: 80,
          title: 'N+1 query pattern',
          titlePattern: /n\+1|loop.*query/i,
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P1',
          path: 'src/services/userService.ts',
          line: 82,
          title: 'Database query inside loop detected',
          body: 'Iterating over users and querying db each time',
        },
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(0);
    });

    it('rejects match when line is outside lineTolerance', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'architecture',
          severity: 'P1',
          path: 'src/domain/order.ts',
          line: 20,
          title: 'Layering violation',
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P1',
          path: 'src/domain/order.ts',
          line: 80, // Delta = 60 > lineTolerance 5
          title: 'Layering violation',
          body: 'Domain importing controller',
        },
      ];

      const metrics = calculateMetrics(expected, actual, { lineTolerance: 5 });
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(1);
      expect(metrics.fn).toBe(1);
    });

    it('enforces strict severity when strictSeverity option is enabled', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'security',
          severity: 'P0',
          path: 'src/api/auth.ts',
          line: 10,
          title: 'Critical auth bypass',
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P2', // Mismatched severity
          path: 'src/api/auth.ts',
          line: 10,
          title: 'Critical auth bypass',
          body: 'Auth issue',
        },
      ];

      const looseMetrics = calculateMetrics(expected, actual, { strictSeverity: false });
      expect(looseMetrics.tp).toBe(1);

      const strictMetrics = calculateMetrics(expected, actual, { strictSeverity: true });
      expect(strictMetrics.tp).toBe(0);
      expect(strictMetrics.fp).toBe(1);
      expect(strictMetrics.fn).toBe(1);
    });
  });

  // =========================================================================
  // 2. COST ESTIMATION
  // =========================================================================
  describe('estimateCost()', () => {
    it('estimates cost accurately for OpenRouter 5.6 Luna High', () => {
      const cost = estimateCost('openai/gpt-5.6-luna', 10_000, 2_000);
      expect(cost).toBe(0.032);
    });

    it('estimates cost accurately for DeepSeek v4 Flash', () => {
      const cost = estimateCost('deepseek/deepseek-v4-flash-0731:high', 10_000, 10_000);
      expect(cost).toBe(0.0042);
    });

    it('estimates cost accurately for Gemini 3.7 Flash', () => {
      const cost = estimateCost('google/gemini-3.7-flash:high', 10_000, 1_000);
      expect(cost).toBe(0.0021);
    });

    it('estimates cost accurately for Qwen 3.8 27B', () => {
      const cost = estimateCost('qwen/qwen-3.8-27b:high', 10_000, 2_000);
      expect(cost).toBe(0.0051);
    });

    it('estimates cost with default fallback for unlisted models', () => {
      const cost = estimateCost('anthropic/claude-3.7-sonnet', 10_000, 1_000);
      expect(cost).toBe(0.0065);
    });

    it('estimates cost for model aliases such as openrouter/5.6-luna-high', () => {
      const cost1 = estimateCost('openrouter/5.6-luna-high', 5_000, 1_000);
      const cost2 = estimateCost('openai/gpt-5.6-luna', 5_000, 1_000);
      expect(cost1).toBe(cost2);
    });
  });

  // =========================================================================
  // 3. SINGLE SCENARIO EVALUATION (OFFLINE & MOCK)
  // =========================================================================
  describe('EvaluationRunner.runScenario()', () => {
    const runner = new EvaluationRunner({ offline: true });
    const allScenarios = getAllScenarios();

    it('evaluates security multi-tenant isolation scenario in offline mode', async () => {
      const scenario = getScenarioById('sec-multi-tenant-isolation');
      expect(scenario).toBeDefined();

      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario!);

      expect(result.scenarioId).toBe('sec-multi-tenant-isolation');
      expect(result.model).toBe('openai/gpt-5.6-luna');
      expect(result.verdict).toBe('BLOCK');
      expect(result.expectedVerdict).toBe('BLOCK');
      expect(result.verdictMatch).toBe(true);

      // Verify all 6 comparative dimensions
      expect(result.tp).toBeGreaterThanOrEqual(1);
      expect(result.precision).toBeGreaterThanOrEqual(0.8);
      expect(result.recall).toBe(1.0);
      expect(result.f1Score).toBeGreaterThanOrEqual(0.8);
      expect(result.snr).toBeGreaterThan(0);
      expect(result.snrDb).toBeGreaterThan(0);
      expect(result.ttftMs).toBeGreaterThan(0);
      expect(result.promptTokens).toBeGreaterThan(0);
      expect(result.completionTokens).toBeGreaterThan(0);
      expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
      expect(result.costUSD).toBeGreaterThan(0);
      expect(result.turnDepth).toBeGreaterThanOrEqual(1);
      expect(result.costEfficiency).toBeGreaterThan(0);
    });

    it('supports custom mockAdapter for fine-grained scenario assertions', async () => {
      const scenario = getScenarioById('sec-sql-injection');
      expect(scenario).toBeDefined();

      const mockResult = await runner.runScenario('custom/mock-model', scenario!, {
        mockAdapter: async (_modelId, _scen) => ({
          findings: [
            {
              severity: 'P0',
              path: 'src/repositories/searchRepository.ts',
              line: 15,
              title: 'SQL injection in raw query',
              body: 'Unsanitized user input interpolated into query string',
            },
          ],
          verdict: 'BLOCK',
          ttftMs: 110,
          promptTokens: 1_200,
          completionTokens: 350,
          turnDepth: 3,
          costUSD: 0.0045,
        }),
      });

      expect(mockResult.model).toBe('custom/mock-model');
      expect(mockResult.verdict).toBe('BLOCK');
      expect(mockResult.verdictMatch).toBe(true);
      expect(mockResult.tp).toBe(1);
      expect(mockResult.fp).toBe(0);
      expect(mockResult.fn).toBe(0);
      expect(mockResult.f1Score).toBe(1.0);
      expect(mockResult.snr).toBe(1.0);
      expect(mockResult.ttftMs).toBe(110);
      expect(mockResult.promptTokens).toBe(1_200);
      expect(mockResult.completionTokens).toBe(350);
      expect(mockResult.turnDepth).toBe(3);
      expect(mockResult.costUSD).toBe(0.0045);
      expect(mockResult.costEfficiency).toBeGreaterThan(100);
    });

    it('evaluates clean multi-feature SHIP scenario producing zero findings', async () => {
      const scenario = getScenarioById('clean-multi-feature-ship');
      expect(scenario).toBeDefined();

      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario!);
      expect(result.verdict).toBe('SHIP');
      expect(result.expectedVerdict).toBe('SHIP');
      expect(result.verdictMatch).toBe(true);
      expect(result.tp).toBe(0);
      expect(result.fp).toBe(0);
      expect(result.fn).toBe(0);
      expect(result.f1Score).toBe(1.0);
      expect(result.snrDb).toBe(20.0);
    });

    it('evaluates multi-turn scenario with author nit feedback suppression', async () => {
      const scenario = getScenarioById('multiturn-author-rejected-nit');
      expect(scenario).toBeDefined();

      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario!);
      expect(result.verdict).toBe('SHIP');
      expect(result.verdictMatch).toBe(true);
      expect(result.turnDepth).toBeGreaterThanOrEqual(2);
    });

    it('evaluates evidence requirement scenario and passes evidence gate', async () => {
      const scenario = getScenarioById('evidence-deterministic-tool-verification');
      expect(scenario).toBeDefined();

      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario!);
      expect(result.verdict).toBe('SHIP');
      expect(result.evidenceGatePassed).toBe(true);
    });

    it('supports streaming fetch implementation in offline/replay mode', async () => {
      const mockFetch = async () => {
        const streamData = [
          'data: {"model":"openai/gpt-5.6-luna","choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":550,"completion_tokens":40,"total_tokens":590},"cost":0.0013}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(streamData, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const scenario = getScenarioById('clean-multi-feature-ship')!;
      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario, {
        offline: false,
        apiKey: 'synthetic-test-key',
        fetchImplementation: mockFetch as any,
      });

      expect(result.verdict).toBe('SHIP');
      expect(result.verdictMatch).toBe(true);
      expect(result.promptTokens).toBe(550);
      expect(result.completionTokens).toBe(40);
      expect(result.costUSD).toBe(0.0013);
    });
  });

  // =========================================================================
  // 4. COMPARATIVE BENCHMARK SUITE EXECUTION
  // =========================================================================
  describe('EvaluationRunner.runBenchmarkSuite()', () => {
    const runner = new EvaluationRunner({ offline: true });

    it('runs comparative benchmark suite across Luna High and baseline models', async () => {
      const models = [
        'openai/gpt-5.6-luna',
        'anthropic/claude-3.7-sonnet',
        'deepseek/deepseek-r1',
        'openai/gpt-4o',
        'google/gemini-2.5-pro',
      ];

      const scenarios = getAllScenarios().slice(0, 5);
      const report = await runner.runBenchmarkSuite(models, scenarios, { offline: true });

      expect(report.timestamp).toBeDefined();
      expect(report.models).toEqual(models);
      expect(report.scenarios.length).toBe(5);
      expect(report.detailedResults.length).toBe(models.length * scenarios.length);

      // Verify each model has summary metrics
      for (const model of models) {
        const summary = report.summary[model];
        expect(summary).toBeDefined();
        expect(summary.model).toBe(model);
        expect(summary.totalScenarios).toBe(5);
        expect(summary.verdictAccuracy).toBeGreaterThanOrEqual(0);
        expect(summary.verdictAccuracy).toBeLessThanOrEqual(100);
        expect(summary.precision).toBeGreaterThanOrEqual(0);
        expect(summary.recall).toBeGreaterThanOrEqual(0);
        expect(summary.f1Score).toBeGreaterThanOrEqual(0);
        expect(summary.avgSnr).toBeGreaterThanOrEqual(0);
        expect(summary.avgTtftMs).toBeGreaterThan(0);
        expect(summary.totalTokens).toBeGreaterThan(0);
        expect(summary.totalCostUSD).toBeGreaterThan(0);
        expect(summary.avgTurnDepth).toBeGreaterThanOrEqual(1);
      }

      // Verify Luna High exhibits superior or top-tier metrics
      const lunaSummary = report.summary['openai/gpt-5.6-luna'];
      expect(lunaSummary.f1Score).toBeGreaterThanOrEqual(0.95);
      expect(lunaSummary.verdictAccuracy).toBe(100);
    });

    it('handles empty scenario suite safely without division-by-zero errors', async () => {
      const report = await runner.runBenchmarkSuite(['openai/gpt-5.6-luna'], []);
      expect(report.scenarios.length).toBe(0);
      expect(report.detailedResults.length).toBe(0);

      const summary = report.summary['openai/gpt-5.6-luna'];
      expect(summary.totalScenarios).toBe(0);
      expect(summary.verdictAccuracy).toBe(0);
      expect(summary.f1Score).toBe(0);
      expect(summary.avgSnr).toBe(0);
      expect(summary.totalCostUSD).toBe(0);
    });
  });

  // =========================================================================
  // 5. REPORT FORMATTING (MARKDOWN & JSON)
  // =========================================================================
  describe('Report Formatters', () => {
    const runner = new EvaluationRunner({ offline: true });

    it('formats Markdown report with all 6 comparative dimensions and clean table', async () => {
      const models = ['openai/gpt-5.6-luna', 'anthropic/claude-3.7-sonnet'];
      const scenarios = getAllScenarios().slice(0, 3);
      const report = await runner.runBenchmarkSuite(models, scenarios);

      const markdown = formatMarkdownReport(report);
      expect(typeof markdown).toBe('string');
      expect(markdown).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(markdown).toContain('## 1. Executive Summary & Comparative Matrix');
      expect(markdown).toContain('## 2. Key Comparative Dimensions');
      expect(markdown).toContain('## 3. Scenario-by-Scenario Detailed Breakdown');

      // Check all 6 metric column headers in the table
      expect(markdown).toContain('Verdict Acc (%)');
      expect(markdown).toContain('Precision');
      expect(markdown).toContain('Recall');
      expect(markdown).toContain('F1 Score');
      expect(markdown).toContain('Avg SNR (dB)');
      expect(markdown).toContain('TTFT (ms)');
      expect(markdown).toContain('Turn Depth');
      expect(markdown).toContain('Total Tokens');
      expect(markdown).toContain('Cost (USD)');
      expect(markdown).toContain('Cost Eff (TP/$)');

      // Check model rows
      expect(markdown).toContain('`openai/gpt-5.6-luna`');
      expect(markdown).toContain('`anthropic/claude-3.7-sonnet`');
    });

    it('formats JSON report into valid structured JSON string', async () => {
      const models = ['openai/gpt-5.6-luna', 'deepseek/deepseek-r1'];
      const scenarios = getAllScenarios().slice(0, 2);
      const report = await runner.runBenchmarkSuite(models, scenarios);

      const jsonStr = formatJSONReport(report);
      expect(typeof jsonStr).toBe('string');

      const parsed = JSON.parse(jsonStr) as ComparativeBenchmarkReport;
      expect(parsed.timestamp).toBe(report.timestamp);
      expect(parsed.models).toEqual(models);
      expect(parsed.scenarios.length).toBe(2);
      expect(parsed.summary['openai/gpt-5.6-luna']).toBeDefined();
      expect(parsed.summary['deepseek/deepseek-r1']).toBeDefined();
      expect(parsed.detailedResults.length).toBe(4);
    });

    it('runner instance methods formatMarkdownReport and formatJSONReport match standalone functions', async () => {
      const models = ['openai/gpt-5.6-luna'];
      const scenarios = getAllScenarios().slice(0, 2);
      const report = await runner.runBenchmarkSuite(models, scenarios);

      expect(runner.formatMarkdownReport(report)).toBe(formatMarkdownReport(report));
      expect(runner.formatJSONReport(report)).toBe(formatJSONReport(report));
    });

    it('successfully executes benchmark suite across all registered scenarios', async () => {
      const models = ['openai/gpt-5.6-luna', 'anthropic/claude-3.7-sonnet'];
      const allScenarios = getAllScenarios();
      expect(allScenarios.length).toBeGreaterThanOrEqual(94);

      const report = await runner.runBenchmarkSuite(models, allScenarios);
      expect(report.scenarios.length).toBe(allScenarios.length);
      expect(report.detailedResults.length).toBe(2 * allScenarios.length);
      expect(report.summary['openai/gpt-5.6-luna'].totalScenarios).toBe(allScenarios.length);
      expect(report.summary['anthropic/claude-3.7-sonnet'].totalScenarios).toBe(allScenarios.length);

      const md = formatMarkdownReport(report);
      expect(md).toContain(String(allScenarios.length));
    });
  });

  // =========================================================================
  // 6. WORKSPACE TOOL EXECUTOR & TELECOM WORKSPACE MOUNTING
  // =========================================================================
  describe('WorkspaceToolExecutor (telecom-call-engine mounting)', () => {
    const executor = new WorkspaceToolExecutor(telecomWorkspaceRoot);

    it('correctly reads full file with line numbers', async () => {
      const content = await executor.fileRead('README.md');
      expect(content).toContain('1: # Generic Telecom Call Engine');
      expect(content).toContain('sip_signaling_service');
    });

    it('correctly slices line ranges in fileRead', async () => {
      const content = await executor.fileRead('README.md', 1, 3);
      const lines = content.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe('1: # Generic Telecom Call Engine');
      expect(lines[1]).toBe('2: ');
      expect(lines[2]).toContain('3: A standard-compliant');
    });

    it('returns error message for non-existent workspace files', async () => {
      const result = await executor.fileRead('sip_signaling_service/src/missing_file.ts');
      expect(result).toContain('Error: File not found in workspace: sip_signaling_service/src/missing_file.ts');
    });

    it('returns error message when path is a directory', async () => {
      const result = await executor.fileRead('sip_signaling_service');
      expect(result).toContain('Error: Path is a directory, not a file: sip_signaling_service');
    });

    it('strictly enforces path traversal prevention and throws error on ../ attempts', async () => {
      await expect(executor.fileRead('../../package.json')).rejects.toThrow('Access denied: path traversal outside workspace root');
      await expect(executor.fileRead('/etc/passwd')).rejects.toThrow('Access denied: path traversal outside workspace root');
      await expect(executor.fileRead('sip_signaling_service/../../../../outside.txt')).rejects.toThrow('Access denied');
    });

    it('searches code patterns across workspace via codeSearch', async () => {
      const results = await executor.codeSearch('RFC 3261');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBeDefined();
      expect(results[0].line).toBeGreaterThan(0);
      expect(results[0].match).toContain('RFC 3261');
    });

    it('searches code with file glob filtering', async () => {
      const tsResults = await executor.codeSearch('DialogManager', '*.ts');
      expect(tsResults.length).toBeGreaterThan(0);
      for (const res of tsResults) {
        expect(res.path.endsWith('.ts')).toBe(true);
      }
    });

    it('locates class and interface symbols via symbolLookup', async () => {
      const dialogSyms = await executor.symbolLookup('DialogManager');
      expect(dialogSyms.length).toBeGreaterThan(0);
      expect(dialogSyms[0].path).toContain('dialogManager.ts');
      expect(dialogSyms[0].kind).toBe('class');

      const portSyms = await executor.symbolLookup('PortAllocator');
      expect(portSyms.length).toBeGreaterThan(0);
      expect(portSyms[0].path).toContain('portAllocator.ts');
      expect(portSyms[0].kind).toBe('class');

      const ratingSyms = await executor.symbolLookup('TariffRatingEngine');
      expect(ratingSyms.length).toBeGreaterThan(0);
      expect(ratingSyms[0].path).toContain('tariffRatingEngine.ts');
      expect(ratingSyms[0].kind).toBe('class');

      const devSyms = await executor.symbolLookup('DeviceRegistry');
      expect(devSyms.length).toBeGreaterThan(0);
      expect(devSyms[0].path).toContain('deviceRegistry.ts');
      expect(devSyms[0].kind).toBe('class');
    });

    it('dispatches tool calls seamlessly via executeTool', async () => {
      // 1. file_read
      const readOutput = await executor.executeTool('file_read', {
        path: 'sip_signaling_service/src/dialogManager.ts',
        startLine: 1,
        endLine: 5,
      });
      expect(readOutput).toContain('1: /**');
      expect(readOutput).toContain('Dialog Manager');

      // 2. code_search
      const searchOutput = await executor.executeTool('code_search', {
        pattern: 'PortAllocator',
        fileGlob: '*.ts',
        maxResults: 5,
      });
      expect(searchOutput).toContain('portAllocator.ts');

      // 3. symbol_lookup
      const symbolOutput = await executor.executeTool('symbol_lookup', {
        symbolName: 'JitterBuffer',
      });
      expect(symbolOutput).toContain('jitterBuffer.ts');
      expect(symbolOutput).toContain('[class]');

      // 4. Unknown tool handling
      const unknownOutput = await executor.executeTool('invalid_tool', {});
      expect(unknownOutput).toContain('Error: Unknown tool "invalid_tool"');
    });

    it('resolves workspaceRoot automatically in EvaluationRunner', () => {
      const runner = new EvaluationRunner();
      const defaultRoot = runner.resolveWorkspaceRoot();
      expect(fs.existsSync(defaultRoot)).toBe(true);

      const customRunner = new EvaluationRunner({ workspaceRoot: telecomWorkspaceRoot });
      expect(customRunner.resolveWorkspaceRoot()).toBe(telecomWorkspaceRoot);
      const customExec = customRunner.getWorkspaceExecutor();
      expect(customExec.getWorkspaceRoot()).toBe(telecomWorkspaceRoot);
    });
  });

  // =========================================================================
  // 7. PARSE TOOL CALL LLM OUTPUT PARSER
  // =========================================================================
  describe('parseToolCall()', () => {
    it('parses standard JSON tool call format', () => {
      const raw = '{"tool": "file_read", "args": {"path": "sip_signaling_service/src/dialogManager.ts", "startLine": 1, "endLine": 10}}';
      const parsed = parseToolCall(raw);
      expect(parsed).toEqual({
        tool: 'file_read',
        args: {
          path: 'sip_signaling_service/src/dialogManager.ts',
          startLine: 1,
          endLine: 10,
        },
      });
    });

    it('parses tool calls wrapped in markdown code fence', () => {
      const raw = 'Let me inspect the dialog manager:\n```json\n{"tool": "code_search", "args": {"pattern": "DialogState"}}\n```';
      const parsed = parseToolCall(raw);
      expect(parsed).toEqual({
        tool: 'code_search',
        args: { pattern: 'DialogState' },
      });
    });

    it('parses bracket syntax [TOOL_CALL: name(args)]', () => {
      const raw = '[TOOL_CALL: symbol_lookup({"symbolName": "PortAllocator"})]';
      const parsed = parseToolCall(raw);
      expect(parsed).toEqual({
        tool: 'symbol_lookup',
        args: { symbolName: 'PortAllocator' },
      });
    });

    it('parses OpenAI tool_calls array format', () => {
      const raw = '{"tool_calls": [{"name": "file_read", "arguments": {"path": "README.md"}}]}';
      const parsed = parseToolCall(raw);
      expect(parsed).toEqual({
        tool: 'file_read',
        args: { path: 'README.md' },
      });
    });

    it('returns null for final review findings JSON (not a tool call)', () => {
      const raw = '{"findings": [{"severity": "P0", "path": "src/a.ts", "line": 10, "title": "Critical flaw"}]}';
      expect(parseToolCall(raw)).toBeNull();
    });

    it('returns null for standard conversational plain text', () => {
      expect(parseToolCall('The PR looks good to me, clean implementation.')).toBeNull();
      expect(parseToolCall('')).toBeNull();
    });
  });

  // =========================================================================
  // 8. MULTI-TURN LIVE SCENARIO INTERACTION LOOP
  // =========================================================================
  describe('Multi-Turn Interactive Live Scenario Execution', () => {
    it('executes 2-turn conversation: turn 1 tool query -> tool execution on workspace -> turn 2 final findings', async () => {
      let turnNumber = 0;

      const mockMultiTurnFetch = async (input: any, init: any): Promise<Response> => {
        turnNumber++;
        const body = JSON.parse(init.body);
        const messages = body.messages;

        if (turnNumber === 1) {
          // Model requests file_read tool
          const streamData = [
            'data: {"model":"openai/gpt-5.6-luna","choices":[{"delta":{"content":"{\\"tool\\":\\"file_read\\",\\"args\\":{\\"path\\":\\"sip_signaling_service/src/dialogManager.ts\\",\\"startLine\\":1,\\"endLine\\":5}}"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":500,"completion_tokens":40,"total_tokens":540},"cost":0.0012}\n\n',
            'data: [DONE]\n\n',
          ].join('');
          return new Response(streamData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        } else {
          // Verify user message contained [TOOL_RESULT: file_read]
          const lastMsg = messages[messages.length - 1].content;
          expect(lastMsg).toContain('[TOOL_RESULT: file_read]');
          expect(lastMsg).toContain('SIP Dialog Manager');

          // Model provides final findings
          const streamData = [
            'data: {"model":"openai/gpt-5.6-luna","choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":650,"completion_tokens":45,"total_tokens":695},"cost":0.0015}\n\n',
            'data: [DONE]\n\n',
          ].join('');
          return new Response(streamData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
      };

      const runner = new EvaluationRunner({
        offline: false,
        apiKey: 'test-key',
        fetchImplementation: mockMultiTurnFetch as any,
        workspaceRoot: telecomWorkspaceRoot,
      });

      const scenario = getScenarioById('clean-multi-feature-ship')!;
      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario);

      expect(result.turnDepth).toBe(2);
      expect(result.promptTokens).toBe(1150); // 500 + 650
      expect(result.completionTokens).toBe(85); // 40 + 45
      expect(result.totalTokens).toBe(1235);
      expect(result.costUSD).toBe(0.0027); // 0.0012 + 0.0015
      expect(result.verdict).toBe('SHIP');
      expect(result.verdictMatch).toBe(true);
    });

    it('enforces maxTurns limit and terminates multi-turn loop cleanly', async () => {
      let turnNumber = 0;

      const infiniteLoopFetch = async (): Promise<Response> => {
        turnNumber++;
        const streamData = [
          'data: {"choices":[{"delta":{"content":"{\\"tool\\":\\"code_search\\",\\"args\\":{\\"pattern\\":\\"DialogManager\\"}}"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":300,"completion_tokens":30,"total_tokens":330},"cost":0.0008}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(streamData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };

      const runner = new EvaluationRunner({
        offline: false,
        apiKey: 'test-key',
        maxTurns: 3,
        fetchImplementation: infiniteLoopFetch as any,
        workspaceRoot: telecomWorkspaceRoot,
      });

      const scenario = getScenarioById('clean-multi-feature-ship')!;
      const result = await runner.runScenario('openai/gpt-5.6-luna', scenario);

      expect(result.turnDepth).toBe(3);
      expect(turnNumber).toBe(3);
      expect(result.totalTokens).toBe(990); // 330 * 3
    });
  });

  // =========================================================================
  // 9. APPROVED 4-MODEL OFFLINE SIMULATION CALIBRATION
  // =========================================================================
  describe('Approved 4-Model Offline Simulation Calibration', () => {
    const approvedModels = [
      'deepseek/deepseek-v4-flash-0731:high',
      'openrouter/5.6-luna-high',
      'qwen/qwen-3.8-27b:high',
      'google/gemini-3.7-flash:high',
    ];

    it('verifies calibrated simulation profiles for all 4 approved models', () => {
      for (const model of approvedModels) {
        const profile = getSimulatedProfile(model);
        expect(profile.discoveryRate).toBeGreaterThanOrEqual(0.98);
        expect(profile.ttftBase).toBeGreaterThanOrEqual(100);
        expect(profile.ttftBase).toBeLessThanOrEqual(150);
        expect(profile.turnDepth).toBe(3);
        expect(profile.promptFactor).toBeGreaterThanOrEqual(1.0);
        expect(profile.completionFactor).toBeGreaterThanOrEqual(1.0);
      }
    });

    it('produces deterministic scores via FNV-1a hash', () => {
      const score1 = deterministicScore('openai/gpt-5.6-luna', 'sec-multi-tenant-isolation', 0);
      const score2 = deterministicScore('openai/gpt-5.6-luna', 'sec-multi-tenant-isolation', 0);
      expect(score1).toBe(score2);
      expect(score1).toBeGreaterThanOrEqual(0.0);
      expect(score1).toBeLessThan(1.0);

      const score3 = deterministicScore('openai/gpt-5.6-luna', 'sec-multi-tenant-isolation', 1);
      expect(score3).not.toBe(score1);
    });

    it('evaluates all 4 approved models across benchmark scenarios with calibrated metrics', async () => {
      const runner = new EvaluationRunner({ offline: true, workspaceRoot: telecomWorkspaceRoot });
      const scenarios = getAllScenarios().slice(0, 4);

      for (const model of approvedModels) {
        const report = await runner.runBenchmarkSuite([model], scenarios);
        const summary = report.summary[model];

        expect(summary.totalScenarios).toBe(4);
        expect(summary.precision).toBeGreaterThanOrEqual(0.9);
        expect(summary.recall).toBeGreaterThanOrEqual(0.95);
        expect(summary.f1Score).toBeGreaterThanOrEqual(0.95);
        expect(summary.avgSnr).toBeGreaterThanOrEqual(0);
        expect(summary.avgTtftMs).toBeGreaterThan(90);
        expect(summary.totalCostUSD).toBeGreaterThan(0);
        expect(summary.avgTurnDepth).toBeGreaterThanOrEqual(1.0);
      }
    });
  });
});
