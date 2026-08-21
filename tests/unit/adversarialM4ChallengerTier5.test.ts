import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  EvaluationRunner,
  calculateMetrics,
  estimateCost,
  formatMarkdownReport,
  formatJSONReport,
  Finding,
  ExpectedFinding,
  ComparativeBenchmarkReport,
  MODEL_PRICING_TABLE,
} from '../../src/evaluation/evaluationRunner';
import {
  getAllScenarios,
  getScenarioById,
  getScenariosByCategory,
  getScenarioCategories,
  getScenariosByPersona,
  formatUnifiedDiff,
  EvaluationScenario,
} from '../../src/evaluation/scenarios';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_MODELS,
  normalizeModelIdentifier,
  areModelsEquivalent,
  parseCliArgs as parseCompareCliArgs,
  loadBenchmarkMatrix,
  calculateDeltas,
  calculateScenarioDeltas,
  evaluateModelGate,
  evaluateQualityGate,
  compareBaselines,
  formatMarkdownReport as formatCompareMarkdownReport,
  formatJsonReport as formatCompareJsonReport,
  main as mainCompare,
} from '../../scripts/compare-release-baselines.mjs';
import {
  parseCliArgs as parseEvaluateCliArgs,
  resolveScenarios,
  evaluateRegressionGate as evaluateBenchmarkRegressionGate,
  formatComparisonMarkdown,
  main as mainEvaluate,
} from '../../scripts/evaluate-release-benchmark.mjs';

describe('Adversarial Tier 5 Verification: CLI Engines, Metrics Formulas & Regression Gates', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const tempDir = path.resolve(rootDir, 'node_modules/.cache/adversarial-tier5-test');
  const baselineV1Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v1.json');
  const baselineV2Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v2.json');

  const APPROVED_MODELS = [
    'deepseek/deepseek-v4-flash-0731:high',
    'openrouter/5.6-luna-high',
    'qwen/qwen-3.8-27b:high',
    'google/gemini-3.7-flash:high',
  ];

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // SECTION 1: MATHEMATICAL FORMULA BOUNDARY VALUE ANALYSIS
  // =========================================================================
  describe('1. Mathematical Formula Boundaries & Edge Conditions', () => {
    it('1.1 Logarithmic SNR Boundary: Clean PR (TP=0, FP=0, Expected=0) yields constant 20.00 dB', () => {
      const metrics = calculateMetrics([], []);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      expect(metrics.snrDb).toBe(20.0);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1Score).toBe(1.0);
    });

    it('1.2 Logarithmic SNR Boundary: TP=50, FP=0 yields exactly 26.99 dB (10*log10(50/0.1))', () => {
      const expected: ExpectedFinding[] = Array.from({ length: 50 }, (_, i) => ({
        personaId: 'security',
        severity: 'P0',
        path: `src/mod_${i}.ts`,
        line: 10 + i,
        title: `Bug ${i}`,
      }));
      const actual: Finding[] = Array.from({ length: 50 }, (_, i) => ({
        severity: 'P0',
        path: `src/mod_${i}.ts`,
        line: 10 + i,
        title: `Bug ${i}`,
      }));

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(50);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      // 10 * log10(50 / 0.1) = 10 * log10(500) = 10 * 2.698970 = 26.99 dB
      expect(metrics.snrDb).toBe(26.99);
    });

    it('1.3 Logarithmic SNR Boundary: TP=1, FP=500 yields exactly -26.99 dB (10*log10(1/500))', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/core.ts', line: 10, title: 'Bug' },
      ];
      const actual: Finding[] = [
        { severity: 'P0', path: 'src/core.ts', line: 10, title: 'Bug' },
        ...Array.from({ length: 500 }, (_, i) => ({
          severity: 'P2' as const,
          path: `src/noise_${i}.ts`,
          line: 1,
          title: `Noise ${i}`,
        })),
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(500);
      expect(metrics.fn).toBe(0);
      // 10 * log10(1 / 500) = 10 * (-2.698970) = -26.99 dB
      expect(metrics.snrDb).toBe(-26.99);
    });

    it('1.4 Logarithmic SNR Boundary: TP=0, FP=500 with missed expected finding yields -46.99 dB (10*log10(0.01/500))', () => {
      const expected: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/core.ts', line: 10, title: 'Bug' },
      ];
      const actual: Finding[] = Array.from({ length: 500 }, (_, i) => ({
        severity: 'P2' as const,
        path: `src/noise_${i}.ts`,
        line: 1,
        title: `Noise ${i}`,
      }));

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(500);
      expect(metrics.fn).toBe(1);
      // 10 * log10(0.01 / 500) = 10 * log10(0.00002) = 10 * (-4.698970) = -46.99 dB
      expect(metrics.snrDb).toBe(-46.99);
    });

    it('1.5 Logarithmic SNR Boundary: Standard ratios (1/1 -> 0 dB, 1/2 -> -3.01 dB, 1/10 -> -10 dB, 10/1 -> 10 dB)', () => {
      // TP=1, FP=1 => 10 * log10(1/1) = 0.00 dB
      const exp1: ExpectedFinding[] = [{ personaId: 'sec', severity: 'P0', path: 'src/a.ts', line: 1 }];
      const act1: Finding[] = [
        { severity: 'P0', path: 'src/a.ts', line: 1 },
        { severity: 'P2', path: 'src/b.ts', line: 1 },
      ];
      expect(calculateMetrics(exp1, act1).snrDb).toBe(0.0);

      // TP=1, FP=2 => 10 * log10(1/2) = -3.01 dB
      const act2: Finding[] = [
        { severity: 'P0', path: 'src/a.ts', line: 1 },
        { severity: 'P2', path: 'src/b.ts', line: 1 },
        { severity: 'P2', path: 'src/c.ts', line: 1 },
      ];
      expect(calculateMetrics(exp1, act2).snrDb).toBe(-3.01);

      // TP=1, FP=10 => 10 * log10(1/10) = -10.00 dB
      const act10: Finding[] = [
        { severity: 'P0', path: 'src/a.ts', line: 1 },
        ...Array.from({ length: 10 }, (_, i) => ({ severity: 'P2' as const, path: `src/noise_${i}.ts`, line: 1 })),
      ];
      expect(calculateMetrics(exp1, act10).snrDb).toBe(-10.0);

      // TP=10, FP=1 => 10 * log10(10/1) = 10.00 dB
      const exp10: ExpectedFinding[] = Array.from({ length: 10 }, (_, i) => ({ personaId: 'sec', severity: 'P0', path: `src/mod_${i}.ts`, line: 1 }));
      const act10_1: Finding[] = [
        ...exp10.map((e) => ({ severity: e.severity, path: e.path, line: e.line })),
        { severity: 'P2', path: 'src/extra.ts', line: 1 },
      ];
      expect(calculateMetrics(exp10, act10_1).snrDb).toBe(10.0);
    });

    it('1.6 Precision, Recall, F1 Mathematical Division by Zero Safety Matrix', () => {
      // 1. All empty: TP=0, FP=0, FN=0 -> Precision=1.0, Recall=1.0, F1=1.0
      const c1 = calculateMetrics([], []);
      expect(c1.precision).toBe(1.0);
      expect(c1.recall).toBe(1.0);
      expect(c1.f1Score).toBe(1.0);

      // 2. Expected empty, Actual has findings: TP=0, FP=3, FN=0 -> Precision=0.0, Recall=1.0, F1=0.0
      const c2 = calculateMetrics([], [{ severity: 'P1', path: 'src/a.ts', line: 1 }]);
      expect(c2.precision).toBe(0.0);
      expect(c2.recall).toBe(1.0);
      expect(c2.f1Score).toBe(0.0);

      // 3. Expected has findings, Actual empty: TP=0, FP=0, FN=2 -> Precision=0.0, Recall=0.0, F1=0.0
      const c3 = calculateMetrics([{ personaId: 'sec', severity: 'P1', path: 'src/a.ts', line: 1 }], []);
      expect(c3.precision).toBe(0.0);
      expect(c3.recall).toBe(0.0);
      expect(c3.f1Score).toBe(0.0);

      // 4. Mismatched: TP=0, FP=1, FN=1 -> Precision=0.0, Recall=0.0, F1=0.0
      const c4 = calculateMetrics(
        [{ personaId: 'sec', severity: 'P1', path: 'src/a.ts', line: 1 }],
        [{ severity: 'P1', path: 'src/b.ts', line: 1 }]
      );
      expect(c4.precision).toBe(0.0);
      expect(c4.recall).toBe(0.0);
      expect(c4.f1Score).toBe(0.0);
    });
  });

  // =========================================================================
  // SECTION 2: QUALITY GATE EXACT MATHEMATICAL THRESHOLD BOUNDARIES
  // =========================================================================
  describe('2. Quality Gate Exact Threshold Boundary Verification', () => {
    const baseSummary = {
      model: 'deepseek/deepseek-v4-flash-0731:high',
      totalScenarios: 20,
      verdictMatches: 20,
      verdictAccuracy: 100,
      totalTp: 20,
      totalFp: 0,
      totalFn: 0,
      precision: 1.0,
      recall: 1.0,
      f1Score: 1.0,
      avgSnr: 1.0,
      avgSnrDb: 12.0,
      avgTtftMs: 100,
      totalPromptTokens: 10000,
      totalCompletionTokens: 2000,
      totalTokens: 12000,
      totalCostUSD: 0.002,
      avgTurnDepth: 1.5,
      costEfficiency: 10000,
    };

    it('2.1 Gate 1 Exact Boundary: Recall drop = 0.000 (PASS) vs -0.001 (FAIL)', () => {
      const dPass = calculateDeltas({ ...baseSummary, recall: 1.000 }, baseSummary);
      expect(evaluateModelGate(dPass).passed).toBe(true);

      const dFail = calculateDeltas({ ...baseSummary, recall: 0.999 }, baseSummary);
      const gateFail = evaluateModelGate(dFail);
      expect(gateFail.passed).toBe(false);
      expect(gateFail.violations.some((v) => v.includes('Recall drop'))).toBe(true);
    });

    it('2.2 Gate 2 Exact Boundary: Accuracy drop = 0.0% (PASS) vs -0.1% (FAIL)', () => {
      const dPass = calculateDeltas({ ...baseSummary, verdictAccuracy: 100.0 }, baseSummary);
      expect(evaluateModelGate(dPass).passed).toBe(true);

      const dFail = calculateDeltas({ ...baseSummary, verdictAccuracy: 99.9 }, baseSummary);
      const gateFail = evaluateModelGate(dFail);
      expect(gateFail.passed).toBe(false);
      expect(gateFail.violations.some((v) => v.includes('Accuracy drop'))).toBe(true);
    });

    it('2.3 Gate 3 Exact Boundary: SNR degradation = -1.50 dB (PASS) vs -1.51 dB (FAIL)', () => {
      const dPass = calculateDeltas({ ...baseSummary, avgSnrDb: 10.50 }, baseSummary); // delta = -1.50 dB
      expect(evaluateModelGate(dPass).passed).toBe(true);

      const dFail = calculateDeltas({ ...baseSummary, avgSnrDb: 10.49 }, baseSummary); // delta = -1.51 dB
      const gateFail = evaluateModelGate(dFail);
      expect(gateFail.passed).toBe(false);
      expect(gateFail.violations.some((v) => v.includes('SNR degradation'))).toBe(true);
    });

    it('2.4 Gate 4 Exact Boundary: F1 drop = -0.020 (PASS) vs -0.021 (FAIL)', () => {
      const dPass = calculateDeltas({ ...baseSummary, f1Score: 0.980 }, baseSummary); // delta = -0.020
      expect(evaluateModelGate(dPass).passed).toBe(true);

      const dFail = calculateDeltas({ ...baseSummary, f1Score: 0.979 }, baseSummary); // delta = -0.021
      const gateFail = evaluateModelGate(dFail);
      expect(gateFail.passed).toBe(false);
      expect(gateFail.violations.some((v) => v.includes('F1 drop'))).toBe(true);
    });

    it('2.5 Gate 5 Exact Boundary: TTFT compound rule (+50ms AND >25%)', () => {
      // 1. +50ms (+50%) -> Pass because deltaTtft not > 50 (it equals 50)
      const d50 = calculateDeltas({ ...baseSummary, avgTtftMs: 150 }, baseSummary);
      expect(evaluateModelGate(d50).passed).toBe(true);

      // 2. +51ms (+51%) -> Fail because >50ms and >25%
      const d51 = calculateDeltas({ ...baseSummary, avgTtftMs: 151 }, baseSummary);
      const gate51 = evaluateModelGate(d51);
      expect(gate51.passed).toBe(false);
      expect(gate51.violations.some((v) => v.includes('TTFT latency spike'))).toBe(true);

      // 3. +80ms on 400ms base (+20% <= 25%) -> Pass
      const base400 = { ...baseSummary, avgTtftMs: 400 };
      const d480 = calculateDeltas({ ...base400, avgTtftMs: 480 }, base400);
      expect(evaluateModelGate(d480).passed).toBe(true);
    });

    it('2.6 Gate 6 Exact Boundary: Cost inflation (+20.0% PASS vs +20.1% FAIL without recall gain)', () => {
      // 1. +20.0% cost with neutral recall -> Pass
      const dPass = calculateDeltas({ ...baseSummary, totalCostUSD: 0.0024, recall: 1.0 }, baseSummary);
      expect(evaluateModelGate(dPass).passed).toBe(true);

      // 2. +20.1% cost with neutral recall -> Fail
      const dFail = calculateDeltas({ ...baseSummary, totalCostUSD: 0.002402, recall: 1.0 }, baseSummary);
      const gateFail = evaluateModelGate(dFail);
      expect(gateFail.passed).toBe(false);
      expect(gateFail.violations.some((v) => v.includes('Cost inflation without recall gain'))).toBe(true);

      // 3. +50.0% cost with positive recall gain -> Pass (justified)
      const baseLowerRecall = { ...baseSummary, recall: 0.90 };
      const dJustified = calculateDeltas({ ...baseLowerRecall, totalCostUSD: 0.0030, recall: 0.95 }, baseLowerRecall);
      expect(evaluateModelGate(dJustified).passed).toBe(true);
    });

    it('2.7 Gate 7 & 8 Defect Loss & Noise Boundaries (FN and FP detection)', () => {
      // FN increase
      const dFn = calculateDeltas({ ...baseSummary, totalFn: 1 }, baseSummary);
      const gateFn = evaluateModelGate(dFn, { disallowNewFn: true });
      expect(gateFn.passed).toBe(false);
      expect(gateFn.violations.some((v) => v.includes('New false negatives'))).toBe(true);

      // FP increase
      const dFp = calculateDeltas({ ...baseSummary, totalFp: 1 }, baseSummary);
      const gateFp = evaluateModelGate(dFp, { disallowNewFp: true });
      expect(gateFp.passed).toBe(false);
      expect(gateFp.violations.some((v) => v.includes('New false positives'))).toBe(true);
    });
  });

  // =========================================================================
  // SECTION 3: CLI SCRIPTS, EXIT CODES & SUBPROCESS EXECUTION
  // =========================================================================
  describe('3. CLI Script Operations, Subprocess Exit Codes & Error Modes', () => {
    it('3.1 compare-release-baselines.mjs: Valid comparison returns Exit Code 0', async () => {
      const res = await mainCompare([
        'node',
        'scripts/compare-release-baselines.mjs',
        `--baseline=${baselineV1Path}`,
        `--candidate=${baselineV1Path}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
    });

    it('3.2 compare-release-baselines.mjs: Regressed candidate with --strict returns Exit Code 1', async () => {
      const regressedCandPath = path.join(tempDir, 'regressed-cand-strict.json');
      const baseMatrix = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));
      const regressedMatrix = JSON.parse(JSON.stringify(baseMatrix));
      regressedMatrix.summary['deepseek/deepseek-v4-flash-0731:high'].recall = 0.85; // Drop from 1.0 to 0.85
      fs.writeFileSync(regressedCandPath, JSON.stringify(regressedMatrix), 'utf8');

      const res = await mainCompare([
        'node',
        'scripts/compare-release-baselines.mjs',
        `--baseline=${baselineV1Path}`,
        `--candidate=${regressedCandPath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.comparison.hasRegressions).toBe(true);
    });

    it('3.3 compare-release-baselines.mjs: Regressed candidate with --no-strict or --warn-only returns Exit Code 0', async () => {
      const regressedCandPath = path.join(tempDir, 'regressed-cand-warn.json');
      const baseMatrix = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));
      const regressedMatrix = JSON.parse(JSON.stringify(baseMatrix));
      regressedMatrix.summary['openrouter/5.6-luna-high'].recall = 0.80;
      fs.writeFileSync(regressedCandPath, JSON.stringify(regressedMatrix), 'utf8');

      const resWarn = await mainCompare([
        'node',
        'scripts/compare-release-baselines.mjs',
        `--baseline=${baselineV1Path}`,
        `--candidate=${regressedCandPath}`,
        '--warn-only',
      ]);
      expect(resWarn.exitCode).toBe(0);
      expect(resWarn.comparison.hasRegressions).toBe(true);

      const resNoStrict = await mainCompare([
        'node',
        'scripts/compare-release-baselines.mjs',
        `--baseline=${baselineV1Path}`,
        `--candidate=${regressedCandPath}`,
        '--no-strict',
      ]);
      expect(resNoStrict.exitCode).toBe(0);
    });

    it('3.4 compare-release-baselines.mjs: Missing required candidate argument returns Exit Code 1', async () => {
      const res = await mainCompare(['node', 'scripts/compare-release-baselines.mjs']);
      expect(res.exitCode).toBe(1);
      expect(res.error).toContain('Missing candidate');
    });

    it('3.5 compare-release-baselines.mjs: Non-existent baseline or candidate file returns Exit Code 2', async () => {
      const res = await mainCompare([
        'node',
        'scripts/compare-release-baselines.mjs',
        '--baseline=non-existent-baseline-file-xyz.json',
        '--candidate=non-existent-candidate-file-xyz.json',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.error).toBeDefined();
    });

    it('3.6 compare-release-baselines.mjs: Malformed JSON candidate file returns Exit Code 2', async () => {
      const malformedPath = path.join(tempDir, 'malformed-matrix.json');
      fs.writeFileSync(malformedPath, '{ broken json: [', 'utf8');

      const res = await mainCompare([
        'node',
        'scripts/compare-release-baselines.mjs',
        `--baseline=${baselineV1Path}`,
        `--candidate=${malformedPath}`,
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.error).toContain('Failed to parse JSON matrix');
    });

    it('3.7 evaluate-release-benchmark.mjs: Composite CLI argument filtering & JSON generation', async () => {
      const res = await mainEvaluate([
        'node',
        'scripts/evaluate-release-benchmark.mjs',
        '--offline',
        '--models=deepseek/deepseek-v4-flash-0731:high,qwen/qwen-3.8-27b:high',
        '--category=evidence',
        '--json',
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.report.models).toEqual([
        'deepseek/deepseek-v4-flash-0731:high',
        'qwen/qwen-3.8-27b:high',
      ]);
      expect(res.report.scenarios.length).toBeGreaterThan(0);
      for (const result of res.report.detailedResults) {
        expect(result.category).toBe('evidence');
      }
    });

    it('3.8 evaluate-release-benchmark.mjs: Inline baseline comparison and fail-on-regression flag', async () => {
      const res = await mainEvaluate([
        'node',
        'scripts/evaluate-release-benchmark.mjs',
        '--offline',
        `--compare-baseline=${baselineV1Path}`,
        '--fail-on-regression',
        '--json',
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.comparison).toBeDefined();
      expect(res.comparison.hasRegressions).toBe(false);
    });

    it('3.9 Direct Subprocess Shell Execution: Real Node CLI execution via execSync', () => {
      const scriptPath = path.join(rootDir, 'scripts/compare-release-baselines.mjs');
      const outJson = path.join(tempDir, 'subproc-diff.json');

      const cmd = `node "${scriptPath}" --baseline="${baselineV1Path}" --candidate="${baselineV1Path}" --output="${outJson}" --json`;
      const stdout = execSync(cmd, { cwd: rootDir, encoding: 'utf8' });

      expect(fs.existsSync(outJson)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
      expect(parsed.passed).toBe(true);
      expect(parsed.summaryDeltas.length).toBe(4);
    });
  });

  // =========================================================================
  // SECTION 4: DETERMINISTIC REPLAY IDEMPOTENCY ACROSS 4-MODEL ROSTER
  // =========================================================================
  describe('4. Deterministic Replay Idempotency across 4 Approved Models', () => {
    it('4.1 100% Bitwise Identical Metrics on Repeated Offline Simulation Runs', async () => {
      const runnerA = new EvaluationRunner({ offline: true });
      const runnerB = new EvaluationRunner({ offline: true });
      const allScenarios = getAllScenarios();

      for (const model of APPROVED_MODELS) {
        for (const scenario of allScenarios.slice(0, 10)) {
          const run1 = await runnerA.runScenario(model, scenario);
          const run2 = await runnerB.runScenario(model, scenario);

          expect(run1.tp).toBe(run2.tp);
          expect(run1.fp).toBe(run2.fp);
          expect(run1.fn).toBe(run2.fn);
          expect(run1.precision).toBe(run2.precision);
          expect(run1.recall).toBe(run2.recall);
          expect(run1.f1Score).toBe(run2.f1Score);
          expect(run1.snr).toBe(run2.snr);
          expect(run1.snrDb).toBe(run2.snrDb);
          expect(run1.ttftMs).toBe(run2.ttftMs);
          expect(run1.promptTokens).toBe(run2.promptTokens);
          expect(run1.completionTokens).toBe(run2.completionTokens);
          expect(run1.totalTokens).toBe(run2.totalTokens);
          expect(run1.costUSD).toBe(run2.costUSD);
          expect(run1.verdict).toBe(run2.verdict);
          expect(run1.verdictMatch).toBe(run2.verdictMatch);
          expect(run1.findings).toEqual(run2.findings);
        }
      }
    });

    it('4.2 Suite-Level Aggregate Metric Invariance across Independent Executions', async () => {
      const runner1 = new EvaluationRunner({ offline: true });
      const runner2 = new EvaluationRunner({ offline: true });
      const scenarios = getAllScenarios().slice(0, 15);

      const suite1 = await runner1.runBenchmarkSuite(APPROVED_MODELS, scenarios, { offline: true });
      const suite2 = await runner2.runBenchmarkSuite(APPROVED_MODELS, scenarios, { offline: true });

      for (const model of APPROVED_MODELS) {
        const s1 = suite1.summary[model];
        const s2 = suite2.summary[model];

        expect(s1.totalScenarios).toBe(s2.totalScenarios);
        expect(s1.verdictAccuracy).toBe(s2.verdictAccuracy);
        expect(s1.precision).toBe(s2.precision);
        expect(s1.recall).toBe(s2.recall);
        expect(s1.f1Score).toBe(s2.f1Score);
        expect(s1.avgSnrDb).toBe(s2.avgSnrDb);
        expect(s1.avgTtftMs).toBe(s2.avgTtftMs);
        expect(s1.totalTokens).toBe(s2.totalTokens);
        expect(s1.totalCostUSD).toBe(s2.totalCostUSD);
        expect(s1.costEfficiency).toBe(s2.costEfficiency);
      }
    });
  });

  // =========================================================================
  // SECTION 5: COMPLEX ADVERSARIAL CASES & BOUNDARY CORRUPTIONS
  // =========================================================================
  describe('5. Complex Adversarial Cases & Boundary Corruptions', () => {
    it('5.1 Multi-Turn Tool Recursion Trap Invariance', async () => {
      const scenario = getScenarioById('adversarial-tool-recursion-trap');
      if (scenario) {
        const runner = new EvaluationRunner({ offline: true });
        const res = await runner.runScenario('deepseek/deepseek-v4-flash-0731:high', scenario);
        expect(res.verdict).toBe(scenario.expectedVerdict);
        expect(res.verdictMatch).toBe(true);
      }
    });

    it('5.2 Prompt Injection Scenario Invariance', async () => {
      const scenario = getScenarioById('adversarial-prompt-injection-pr-body');
      if (scenario) {
        const runner = new EvaluationRunner({ offline: true });
        const res = await runner.runScenario('google/gemini-3.7-flash:high', scenario);
        expect(res.verdict).toBe(scenario.expectedVerdict);
        expect(res.verdictMatch).toBe(true);
      }
    });

    it('5.3 Custom Thresholds File Loading with Deep Merging', () => {
      const customPath = path.join(tempDir, 'deep-merge-thresholds.json');
      fs.writeFileSync(
        customPath,
        JSON.stringify({
          maxRecallDrop: 0.10,
          maxSnrDropDb: 5.0,
        }),
        'utf8'
      );

      const opts = parseCompareCliArgs([
        'node',
        'compare.mjs',
        `--thresholds=${customPath}`,
        '--max-f1-drop=0.05',
      ]);

      expect(opts.thresholds.maxRecallDrop).toBe(0.10);
      expect(opts.thresholds.maxSnrDropDb).toBe(5.0);
      expect(opts.thresholds.maxF1Drop).toBe(0.05); // preserves CLI flag override
      expect(opts.thresholds.maxAccuracyDrop).toBe(0.0); // preserves default
    });
  });
});
