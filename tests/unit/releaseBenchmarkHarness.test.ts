import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MODELS,
  parseCliArgs,
  resolveScenarios,
  evaluateRegressionGate,
  formatComparisonMarkdown,
  main,
} from '../../scripts/evaluate-release-benchmark.mjs';
import { getAllScenarios } from '../../src/evaluation/scenarios';

describe('Release Benchmark Harness Engine (scripts/evaluate-release-benchmark.mjs)', () => {
  const rootRepoDir = path.resolve(__dirname, '../..');
  const v1BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v1.json');
  const v2BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v2.json');
  const v3BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v3.json');
  const v3MdPath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v3.md');
  const v4BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v4.json');
  const v4MdPath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v4.md');

  // =========================================================================
  // 1. CLI ARGUMENT PARSING
  // =========================================================================
  describe('parseCliArgs()', () => {
    it('defaults to offline mode, default 4-model roster, and all scenarios', () => {
      const options = parseCliArgs(['node', 'evaluate-release-benchmark.mjs']);
      expect(options.offline).toBe(true);
      expect(options.live).toBe(false);
      expect(options.models).toEqual(DEFAULT_MODELS);
      expect(options.scenarios).toBeNull();
      expect(options.category).toBeNull();
      expect(options.json).toBe(false);
      expect(options.failOnRegression).toBe(false);
    });

    it('parses --live and explicit API key', () => {
      const options = parseCliArgs([
        'node',
        'evaluate-release-benchmark.mjs',
        '--live',
        '--api-key=test-api-key',
      ]);
      expect(options.live).toBe(true);
      expect(options.offline).toBe(false);
      expect(options.apiKey).toBe('test-api-key');
    });

    it('parses custom models, category, and scenario filters', () => {
      const options = parseCliArgs([
        'node',
        'evaluate-release-benchmark.mjs',
        '--models=deepseek/deepseek-v4-flash-0731:high,openrouter/5.6-luna-high',
        '--category=security',
        '--scenarios=sec-multi-tenant-isolation,sec-sql-injection',
      ]);
      expect(options.models).toEqual([
        'deepseek/deepseek-v4-flash-0731:high',
        'openrouter/5.6-luna-high',
      ]);
      expect(options.category).toBe('security');
      expect(options.scenarios).toEqual(['sec-multi-tenant-isolation', 'sec-sql-injection']);
    });

    it('parses output paths, baseline flags, and fail-on-regression', () => {
      const options = parseCliArgs([
        'node',
        'evaluate-release-benchmark.mjs',
        '--output=reports/eval.json',
        '--json',
        '--save-baseline=v3',
        '--compare-baseline=eval-baselines/model-benchmark-matrix-v2.json',
        '--fail-on-regression',
      ]);
      expect(options.output).toBe('reports/eval.json');
      expect(options.json).toBe(true);
      expect(options.saveBaseline).toBe('v3');
      expect(options.compareBaseline).toBe('eval-baselines/model-benchmark-matrix-v2.json');
      expect(options.failOnRegression).toBe(true);
    });
  });

  // =========================================================================
  // 2. SCENARIO RESOLUTION
  // =========================================================================
  describe('resolveScenarios()', () => {
    it('resolves all scenarios when no filter is specified', () => {
      const scenarios = resolveScenarios({ category: null, scenarios: null });
      expect(scenarios.length).toBe(190);
    });

    it('filters scenarios by category across expanded scenario suite', () => {
      const secScenarios = resolveScenarios({ category: 'security', scenarios: null });
      expect(secScenarios.length).toBe(38);
      for (const s of secScenarios) {
        expect(s.category).toBe('security');
      }

      const dbScenarios = resolveScenarios({ category: 'database', scenarios: null });
      expect(dbScenarios.length).toBe(16);

      const perfScenarios = resolveScenarios({ category: 'performance', scenarios: null });
      expect(perfScenarios.length).toBe(41);

      const archScenarios = resolveScenarios({ category: 'architecture', scenarios: null });
      expect(archScenarios.length).toBe(64);

      const evidenceScenarios = resolveScenarios({ category: 'evidence', scenarios: null });
      expect(evidenceScenarios.length).toBe(7);

      const multiFileScenarios = resolveScenarios({ category: 'multi_file', scenarios: null });
      expect(multiFileScenarios.length).toBe(12);
    });

    it('filters scenarios by scenario IDs or partial slugs', () => {
      const scenarios = resolveScenarios({
        category: null,
        scenarios: ['sec-multi-tenant-isolation', 'db-destructive'],
      });
      expect(scenarios.length).toBe(2);
      expect(scenarios.map((s) => s.id)).toEqual([
        'sec-multi-tenant-isolation',
        'db-destructive-drop-column',
      ]);
    });
  });

  // =========================================================================
  // 3. REGRESSION GATE EVALUATION
  // =========================================================================
  describe('evaluateRegressionGate()', () => {
    it('verifies candidate run against v1 baseline passes quality gates cleanly', () => {
      expect(fs.existsSync(v1BaselinePath)).toBe(true);
      const v1Content = JSON.parse(fs.readFileSync(v1BaselinePath, 'utf8'));

      // Use v1 data as candidate report
      const candidateReport = {
        timestamp: new Date().toISOString(),
        models: DEFAULT_MODELS,
        scenarios: v1Content.scenarios,
        summary: v1Content.summary,
        detailedResults: v1Content.detailedResults,
      };

      const result = evaluateRegressionGate(candidateReport, v1BaselinePath);
      expect(result.hasRegressions).toBe(false);
      expect(result.diffs.length).toBe(4);

      for (const diff of result.diffs) {
        expect(diff.status).toBe('PASS');
        expect(diff.violations.length).toBe(0);
        expect(diff.dRecall).toBe(0);
        expect(diff.dAccuracy).toBe(0);
        expect(diff.dF1).toBe(0);
      }
    });

    it('verifies candidate 94-scenario run against v2 baseline passes quality gates with 0 regressions', () => {
      expect(fs.existsSync(v2BaselinePath)).toBe(true);
      expect(fs.existsSync(v3BaselinePath)).toBe(true);
      const v3Content = JSON.parse(fs.readFileSync(v3BaselinePath, 'utf8'));

      const result = evaluateRegressionGate(v3Content, v2BaselinePath);
      expect(result.hasRegressions).toBe(false);
      expect(result.diffs.length).toBe(4);

      for (const diff of result.diffs) {
        expect(diff.status).toBe('PASS');
        expect(diff.violations.length).toBe(0);
        expect(diff.dRecall).toBeGreaterThanOrEqual(0);
        expect(diff.dAccuracy).toBeGreaterThanOrEqual(0);
        expect(diff.dF1).toBeGreaterThanOrEqual(-0.02);
      }
    });

    it('detects recall regression and flags violation', () => {
      const v1Content = JSON.parse(fs.readFileSync(v1BaselinePath, 'utf8'));
      const mutatedSummary = JSON.parse(JSON.stringify(v1Content.summary));

      // Simulate recall drop on DeepSeek
      mutatedSummary['deepseek/deepseek-v4-flash-0731:high'].recall = 0.85;

      const candidateReport = {
        timestamp: new Date().toISOString(),
        models: ['deepseek/deepseek-v4-flash-0731:high'],
        scenarios: v1Content.scenarios,
        summary: mutatedSummary,
        detailedResults: [],
      };

      const result = evaluateRegressionGate(candidateReport, v1BaselinePath);
      expect(result.hasRegressions).toBe(true);
      const dsDiff = result.diffs.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(dsDiff?.status).toBe('REGRESSION');
      expect(dsDiff?.violations.some((v: string) => v.includes('Recall drop'))).toBe(true);
    });

    it('detects SNR degradation > 1.5 dB and flags violation', () => {
      const v1Content = JSON.parse(fs.readFileSync(v1BaselinePath, 'utf8'));
      const mutatedSummary = JSON.parse(JSON.stringify(v1Content.summary));

      // Simulate SNR drop from 11.65 to 9.0 dB (delta -2.65 dB)
      mutatedSummary['google/gemini-3.7-flash:high'].avgSnrDb = 9.0;

      const candidateReport = {
        timestamp: new Date().toISOString(),
        models: ['google/gemini-3.7-flash:high'],
        scenarios: v1Content.scenarios,
        summary: mutatedSummary,
        detailedResults: [],
      };

      const result = evaluateRegressionGate(candidateReport, v1BaselinePath);
      expect(result.hasRegressions).toBe(true);
      const geminiDiff = result.diffs.find((d: any) => d.model === 'google/gemini-3.7-flash:high');
      expect(geminiDiff?.status).toBe('REGRESSION');
      expect(geminiDiff?.violations.some((v: string) => v.includes('SNR degradation'))).toBe(true);
    });

    it('formats comparison markdown into clean readable table', () => {
      const v1Content = JSON.parse(fs.readFileSync(v1BaselinePath, 'utf8'));
      const candidateReport = {
        timestamp: new Date().toISOString(),
        models: DEFAULT_MODELS,
        scenarios: v1Content.scenarios,
        summary: v1Content.summary,
        detailedResults: [],
      };

      const result = evaluateRegressionGate(candidateReport, v1BaselinePath);
      const md = formatComparisonMarkdown(result, v1BaselinePath);

      expect(md).toContain('## Release Baseline Comparison Report');
      expect(md).toContain('| Model | Status | Δ Recall | Δ Verdict Acc | Δ F1 Score | Δ SNR (dB) | Δ TTFT | Δ Cost | Violations |');
      expect(md).toContain('`deepseek/deepseek-v4-flash-0731:high`');
      expect(md).toContain('✅ PASS');
    });
  });

  // =========================================================================
  // 4. CANONICAL V2 AND V3 BASELINE ARTIFACT INTEGRITY
  // =========================================================================
  describe('Canonical Baseline Artifacts (v2 & v3)', () => {
    it('confirms model-benchmark-matrix-v2.json exists with 62 scenarios and 4 models', () => {
      expect(fs.existsSync(v2BaselinePath)).toBe(true);
      const v2 = JSON.parse(fs.readFileSync(v2BaselinePath, 'utf8'));

      expect(v2.version).toBe('v2');
      expect(v2.models).toEqual(DEFAULT_MODELS);
      expect(v2.scenarios.length).toBe(62);
      expect(v2.detailedResults.length).toBe(248); // 4 models * 62 scenarios

      for (const model of DEFAULT_MODELS) {
        const s = v2.summary[model];
        expect(s).toBeDefined();
        expect(s.totalScenarios).toBe(62);
        expect(s.verdictAccuracy).toBeGreaterThanOrEqual(95);
        expect(s.precision).toBeGreaterThanOrEqual(0.95);
        expect(s.recall).toBeGreaterThanOrEqual(0.95);
        expect(s.f1Score).toBeGreaterThanOrEqual(0.95);
        expect(s.avgSnrDb).toBeGreaterThan(10);
        expect(s.avgTtftMs).toBeGreaterThan(0);
        expect(s.totalTokens).toBeGreaterThan(40_000);
        expect(s.totalCostUSD).toBeGreaterThan(0);
        expect(s.costEfficiency).toBeGreaterThan(0);
      }
    });

    it('confirms model-benchmark-matrix-v2.md exists and contains executive summary matrix', () => {
      const v2MdPath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v2.md');
      expect(fs.existsSync(v2MdPath)).toBe(true);

      const content = fs.readFileSync(v2MdPath, 'utf8');
      expect(content).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(content).toContain('**Total Scenarios**: 62');
      expect(content).toContain('`deepseek/deepseek-v4-flash-0731:high`');
      expect(content).toContain('`openrouter/5.6-luna-high`');
      expect(content).toContain('`qwen/qwen-3.8-27b:high`');
      expect(content).toContain('`google/gemini-3.7-flash:high`');
    });

    it('confirms canonical model-benchmark-matrix-v3.json exists with 94 scenarios and 4 models', () => {
      expect(fs.existsSync(v3BaselinePath)).toBe(true);
      const v3 = JSON.parse(fs.readFileSync(v3BaselinePath, 'utf8'));

      expect(v3.version).toBe('v3');
      expect(v3.models).toEqual(DEFAULT_MODELS);
      expect(v3.scenarios.length).toBe(94);
      expect(v3.detailedResults.length).toBe(376); // 4 models * 94 scenarios

      for (const model of DEFAULT_MODELS) {
        const s = v3.summary[model];
        expect(s).toBeDefined();
        expect(s.totalScenarios).toBe(94);
        expect(s.verdictAccuracy).toBeGreaterThanOrEqual(95);
        expect(s.precision).toBeGreaterThanOrEqual(0.95);
        expect(s.recall).toBeGreaterThanOrEqual(0.95);
        expect(s.f1Score).toBeGreaterThanOrEqual(0.95);
        expect(s.avgSnrDb).toBeGreaterThan(10);
        expect(s.avgTtftMs).toBeGreaterThan(0);
        expect(s.totalTokens).toBeGreaterThan(70_000);
        expect(s.totalCostUSD).toBeGreaterThan(0);
        expect(s.costEfficiency).toBeGreaterThan(0);
      }
    });

    it('confirms canonical model-benchmark-matrix-v3.md exists and contains executive summary matrix', () => {
      expect(fs.existsSync(v3MdPath)).toBe(true);

      const content = fs.readFileSync(v3MdPath, 'utf8');
      expect(content).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(content).toContain('**Total Scenarios**: 94');
      expect(content).toContain('`deepseek/deepseek-v4-flash-0731:high`');
      expect(content).toContain('`openrouter/5.6-luna-high`');
      expect(content).toContain('`qwen/qwen-3.8-27b:high`');
      expect(content).toContain('`google/gemini-3.7-flash:high`');
    });

    it('confirms canonical model-benchmark-matrix-v4.json exists with 190 scenarios and 4 models', () => {
      expect(fs.existsSync(v4BaselinePath)).toBe(true);
      const v4 = JSON.parse(fs.readFileSync(v4BaselinePath, 'utf8'));

      expect(v4.version).toBe('v4');
      expect(v4.models).toEqual(DEFAULT_MODELS);
      expect(v4.scenarios.length).toBe(190);
      expect(v4.detailedResults.length).toBe(760); // 4 models * 190 scenarios

      for (const model of DEFAULT_MODELS) {
        const s = v4.summary[model];
        expect(s).toBeDefined();
        expect(s.totalScenarios).toBe(190);
        expect(s.verdictAccuracy).toBeGreaterThanOrEqual(95);
        expect(s.precision).toBeGreaterThanOrEqual(0.94);
        expect(s.recall).toBeGreaterThanOrEqual(0.94);
        expect(s.f1Score).toBeGreaterThanOrEqual(0.95);
        expect(s.avgSnrDb).toBeGreaterThan(10);
        expect(s.avgTtftMs).toBeGreaterThan(0);
        expect(s.totalTokens).toBeGreaterThan(140_000);
        expect(s.totalCostUSD).toBeGreaterThan(0);
        expect(s.costEfficiency).toBeGreaterThan(0);
      }
    });

    it('confirms canonical model-benchmark-matrix-v4.md exists and contains executive summary matrix', () => {
      expect(fs.existsSync(v4MdPath)).toBe(true);

      const content = fs.readFileSync(v4MdPath, 'utf8');
      expect(content).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(content).toContain('**Total Scenarios**: 190');
      expect(content).toContain('`deepseek/deepseek-v4-flash-0731:high`');
      expect(content).toContain('`openrouter/5.6-luna-high`');
      expect(content).toContain('`qwen/qwen-3.8-27b:high`');
      expect(content).toContain('`google/gemini-3.7-flash:high`');
    });
  });

  // =========================================================================
  // 5. END-TO-END CLI INTEGRATION EXECUTION
  // =========================================================================
  describe('main() CLI Execution', () => {
    it('executes offline evaluation in memory and returns code 0 with valid report', async () => {
      const result = await main([
        'node',
        'evaluate-release-benchmark.mjs',
        '--offline',
        '--category=evidence',
        '--models=google/gemini-3.7-flash:high',
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.report).toBeDefined();
      expect(result.report!.models).toEqual(['google/gemini-3.7-flash:high']);
      expect(result.report!.scenarios.length).toBe(7);
    });

    it('compares against baseline and enforces quality gate cleanly', async () => {
      const result = await main([
        'node',
        'evaluate-release-benchmark.mjs',
        '--offline',
        `--compare-baseline=${v2BaselinePath}`,
        '--fail-on-regression',
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.comparison?.hasRegressions).toBe(false);
    });
  });
});
