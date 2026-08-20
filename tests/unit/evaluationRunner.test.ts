import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  EvaluationRunner,
  calculateMetrics,
  estimateCost,
  formatMarkdownReport,
  formatJSONReport,
  MODEL_PRICING_TABLE,
  Finding,
  EvaluationMetrics,
  ScenarioEvaluationResult,
  ComparativeBenchmarkReport,
} from '../../src/evaluation/evaluationRunner.ts';
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
      // (10,000 / 1,000,000) * 2.0 + (2,000 / 1,000,000) * 6.0 = 0.02 + 0.012 = 0.032
      expect(cost).toBe(0.032);
    });

    it('estimates cost accurately for DeepSeek v4 Flash', () => {
      const cost = estimateCost('deepseek/deepseek-v4-flash-0731:high', 10_000, 10_000);
      // (10,000 / 1M) * 0.14 + (10,000 / 1M) * 0.28 = 0.0014 + 0.0028 = 0.0042
      expect(cost).toBe(0.0042);
    });

    it('estimates cost accurately for Gemini 3.7 Flash', () => {
      const cost = estimateCost('google/gemini-3.7-flash:high', 10_000, 1_000);
      // (10,000 / 1M) * 0.15 + (1,000 / 1M) * 0.60 = 0.0015 + 0.0006 = 0.0021
      expect(cost).toBe(0.0021);
    });

    it('estimates cost accurately for Qwen 3.8 27B', () => {
      const cost = estimateCost('qwen/qwen-3.8-27b:high', 10_000, 2_000);
      // (10,000 / 1M) * 0.35 + (2,000 / 1M) * 0.80 = 0.0035 + 0.0016 = 0.0051
      expect(cost).toBe(0.0051);
    });

    it('estimates cost with default fallback for unlisted models', () => {
      const cost = estimateCost('anthropic/claude-3.7-sonnet', 10_000, 1_000);
      // Fallback ($0.50 / $1.50): (10,000 / 1M) * 0.50 + (1,000 / 1M) * 1.50 = 0.005 + 0.0015 = 0.0065
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

    it('successfully executes benchmark suite across all 94 registered scenarios', async () => {
      const models = ['openai/gpt-5.6-luna', 'anthropic/claude-3.7-sonnet'];
      const allScenarios = getAllScenarios();
      expect(allScenarios.length).toBe(94);

      const report = await runner.runBenchmarkSuite(models, allScenarios);
      expect(report.scenarios.length).toBe(94);
      expect(report.detailedResults.length).toBe(188); // 2 models * 94 scenarios
      expect(report.summary['openai/gpt-5.6-luna'].totalScenarios).toBe(94);
      expect(report.summary['anthropic/claude-3.7-sonnet'].totalScenarios).toBe(94);

      const md = formatMarkdownReport(report);
      expect(md).toContain('94');
    });
  });
});

