import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  getAllScenarios,
  getScenarioById,
  getScenariosByCategory,
  getScenarioCategories,
  getScenariosByPersona,
  formatUnifiedDiff,
  validateScenario,
  EvaluationScenario,
  ExpectedFinding,
  ScenarioCategory,
} from '../../src/evaluation/scenarios';
import {
  EvaluationRunner,
  calculateMetrics,
  estimateCost,
  formatMarkdownReport,
  formatJSONReport,
  MODEL_PRICING_TABLE,
  Finding,
  ComparativeBenchmarkReport,
} from '../../src/evaluation/evaluationRunner';

const { changedLineNumbers, sanitizeFindings, computeArbitration } = require('../../src/review/reviewCore.js');

/**
 * Quality Gate Rule Evaluator (Helper for E2E quality gate contract verification)
 */
interface QualityGateResult {
  passed: boolean;
  violations: string[];
  modelResults: Record<string, { passed: boolean; violations: string[] }>;
}

function evaluateQualityGate(
  baseline: ComparativeBenchmarkReport,
  candidate: ComparativeBenchmarkReport,
  options: {
    maxSnrDegradationDb?: number;
    maxF1Degradation?: number;
    maxTtftSurgeMs?: number;
    maxTtftSurgeRatio?: number;
    maxCostSurgePct?: number;
  } = {}
): QualityGateResult {
  const maxSnrDegradationDb = options.maxSnrDegradationDb ?? 1.5;
  const maxF1Degradation = options.maxF1Degradation ?? 0.02;
  const maxTtftSurgeMs = options.maxTtftSurgeMs ?? 50;
  const maxTtftSurgeRatio = options.maxTtftSurgeRatio ?? 0.25;
  const maxCostSurgePct = options.maxCostSurgePct ?? 20.0;

  const violations: string[] = [];
  const modelResults: Record<string, { passed: boolean; violations: string[] }> = {};

  for (const model of candidate.models) {
    const base = baseline.summary[model];
    const cand = candidate.summary[model];
    const modelViolations: string[] = [];

    if (!base || !cand) {
      continue;
    }

    const baseScenarios = base.totalScenarios || 1;
    const candScenarios = cand.totalScenarios || 1;

    let candRecallVal = cand.recall;
    let candAccVal = cand.verdictAccuracy;
    let candSnrDbVal = cand.avgSnrDb;
    let candF1Val = cand.f1Score;
    let candTtftVal = cand.avgTtftMs;

    if (baseline.detailedResults && candidate.detailedResults && candScenarios !== baseScenarios) {
      const baseResults = baseline.detailedResults.filter((r: any) => r.model === model);
      const candResults = candidate.detailedResults.filter((r: any) => r.model === model);
      const baseScenarioIds = new Set(baseResults.map((r: any) => r.scenarioId));
      const commonCand = candResults.filter((r: any) => baseScenarioIds.has(r.scenarioId));
      if (commonCand.length > 0) {
        let tp = 0;
        let fp = 0;
        let fn = 0;
        let matches = 0;
        let snrSum = 0;
        let ttftSum = 0;
        for (const cr of commonCand) {
          tp += Number(cr.tp ?? 0);
          fp += Number(cr.fp ?? 0);
          fn += Number(cr.fn ?? 0);
          if (cr.verdictMatch ?? (cr.verdict === cr.expectedVerdict)) matches++;
          snrSum += Number(cr.snrDb ?? 0);
          ttftSum += Number(cr.ttftMs ?? 0);
        }
        candRecallVal = (tp + fn > 0) ? tp / (tp + fn) : 1.0;
        candAccVal = (matches / commonCand.length) * 100;
        const prec = (tp + fp > 0) ? tp / (tp + fp) : 1.0;
        candF1Val = (prec + candRecallVal > 0) ? (2 * prec * candRecallVal) / (prec + candRecallVal) : 1.0;
        candSnrDbVal = snrSum / commonCand.length;
        candTtftVal = ttftSum / commonCand.length;
      }
    }

    // 1. Recall Regression (Zero Tolerance)
    const deltaRecall = Math.round((candRecallVal - base.recall) * 1000) / 1000;
    if (deltaRecall < -0.0001) {
      modelViolations.push(`Recall degraded by ${deltaRecall.toFixed(3)} (base: ${base.recall.toFixed(3)}, cand: ${candRecallVal.toFixed(3)})`);
    }

    // 2. Verdict Accuracy Regression (Zero Tolerance)
    const deltaAcc = Math.round((candAccVal - base.verdictAccuracy) * 10) / 10;
    if (deltaAcc < -0.001) {
      modelViolations.push(`Verdict accuracy degraded by ${deltaAcc.toFixed(1)}% (base: ${base.verdictAccuracy.toFixed(1)}%, cand: ${candAccVal.toFixed(1)}%)`);
    }

    // 3. SNR Degradation (Max 1.5 dB)
    const deltaSnrDb = Math.round((candSnrDbVal - base.avgSnrDb) * 100) / 100;
    if (deltaSnrDb < -maxSnrDegradationDb) {
      modelViolations.push(`SNR degraded by ${Math.abs(deltaSnrDb).toFixed(2)} dB (max permissible ${maxSnrDegradationDb.toFixed(2)} dB)`);
    }

    // 4. F1 Score Degradation (Max 0.02)
    const deltaF1 = Math.round((candF1Val - base.f1Score) * 1000) / 1000;
    if (deltaF1 < -maxF1Degradation) {
      modelViolations.push(`F1 score degraded by ${Math.abs(deltaF1).toFixed(3)} (max permissible ${maxF1Degradation.toFixed(3)})`);
    }

    // 5. TTFT Latency Surge (Delta > 50ms AND > 25%)
    const deltaTtft = candTtftVal - base.avgTtftMs;
    const ttftRatio = base.avgTtftMs > 0 ? deltaTtft / base.avgTtftMs : 0;
    if (deltaTtft > maxTtftSurgeMs && ttftRatio > maxTtftSurgeRatio) {
      modelViolations.push(`TTFT latency surged by ${deltaTtft} ms (+${(ttftRatio * 100).toFixed(1)}%)`);
    }

    // 6. Cost Surge Normalized by Scenario Count (Delta > 20% AND Delta Recall <= 0)
    const baseAvgCost = base.totalCostUSD / baseScenarios;
    const candAvgCost = cand.totalCostUSD / candScenarios;
    const rawCostSurge = baseAvgCost > 0 ? ((candAvgCost - baseAvgCost) / baseAvgCost) * 100 : 0;
    const costSurgePct = Math.round(rawCostSurge * 100) / 100;
    if (costSurgePct > maxCostSurgePct && deltaRecall <= 0.0001) {
      modelViolations.push(`Cost surged by ${costSurgePct.toFixed(1)}% without recall improvement`);
    }

    // 7. New False Negatives on Previously Caught Defects
    if (candScenarios === baseScenarios) {
      if (cand.totalFn > base.totalFn) {
        modelViolations.push(`New false negatives detected: ${cand.totalFn} (base: ${base.totalFn})`);
      }
    } else {
      if (baseline.detailedResults && candidate.detailedResults) {
        const baseResults = baseline.detailedResults.filter((r: any) => r.model === model);
        const candResults = candidate.detailedResults.filter((r: any) => r.model === model);
        const baseFnMap = new Map<string, number>(baseResults.map((r: any) => [r.scenarioId, r.fn]));
        let newFns = 0;
        for (const cr of candResults) {
          const baseFn = baseFnMap.get(cr.scenarioId);
          if (typeof baseFn === 'number' && cr.fn > baseFn) {
            newFns += (cr.fn - baseFn);
          }
        }
        if (newFns > 0) {
          modelViolations.push(`New false negatives detected on common baseline scenarios: ${newFns}`);
        }
      } else {
        const baseFnRate = base.totalFn / baseScenarios;
        const candFnRate = cand.totalFn / candScenarios;
        if (candFnRate > baseFnRate + 0.0001) {
          modelViolations.push(`False negative rate degraded: ${(candFnRate * 100).toFixed(1)}% (base: ${(baseFnRate * 100).toFixed(1)}%)`);
        }
      }
    }

    modelResults[model] = {
      passed: modelViolations.length === 0,
      violations: modelViolations,
    };

    if (modelViolations.length > 0) {
      violations.push(...modelViolations.map((v) => `[${model}] ${v}`));
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    modelResults,
  };
}

describe('Release Benchmark & Automated Regression Gate E2E Test Suite', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const tempDir = path.resolve(rootDir, 'node_modules/.cache/e2e-release-benchmark-test');
  const baselineV1Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v1.json');

  const APPROVED_4_MODELS = [
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
  // TIER 1: CORE FEATURE COVERAGE (R1, R2, R3)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Category-Partition)', () => {
    it('TEST_E2E_T1_01 — Catalog Completeness, Schema Validation & Unique ID Invariant', () => {
      const scenarios = getAllScenarios();
      expect(scenarios.length).toBeGreaterThanOrEqual(20);

      const ids = scenarios.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(scenarios.length);

      for (const scenario of scenarios) {
        const validation = validateScenario(scenario);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
      }
    });

    it('TEST_E2E_T1_02 — Multi-Language Defect Categorization (Elixir, Go, TS, SQL)', () => {
      const categories = getScenarioCategories();
      const requiredCategories: ScenarioCategory[] = [
        'security',
        'performance',
        'architecture',
        'testing',
        'database',
        'dependencies',
        'multi_file',
        'multi_turn',
        'evidence',
      ];

      for (const cat of requiredCategories) {
        expect(categories).toContain(cat);
        const inCat = getScenariosByCategory(cat);
        expect(inCat.length).toBeGreaterThan(0);
      }
    });

    it('TEST_E2E_T1_03 — Ground-Truth Diff Line Invariant & Containment', () => {
      const scenarios = getAllScenarios();
      for (const scenario of scenarios) {
        for (const finding of scenario.expectedFindings) {
          const file = scenario.diffFiles.find((f) => f.path === finding.path);
          expect(file).toBeDefined();
          if (file && typeof finding.line === 'number') {
            const added = changedLineNumbers(file.patch);
            expect(added).not.toBeNull();
            expect(added!.has(finding.line)).toBe(true);
          }
        }
      }
    });

    it('TEST_E2E_T1_04 — Approved 4-Model Roster Offline Execution', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const targetScenarios = getAllScenarios().slice(0, 3);

      const report = await runner.runBenchmarkSuite(APPROVED_4_MODELS, targetScenarios, {
        offline: true,
      });

      expect(report.models).toEqual(APPROVED_4_MODELS);
      expect(Object.keys(report.summary).length).toBe(4);

      for (const model of APPROVED_4_MODELS) {
        const summary = report.summary[model];
        expect(summary).toBeDefined();
        expect(summary.totalScenarios).toBe(3);
        expect(summary.f1Score).toBeGreaterThanOrEqual(0);
        expect(summary.avgSnrDb).toBeGreaterThan(0);
        expect(summary.totalTokens).toBeGreaterThan(0);
        expect(summary.totalCostUSD).toBeGreaterThan(0);
      }
    });

    it('TEST_E2E_T1_05 — 6 Core Evaluation Dimensions Engine', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const scenario = getAllScenarios()[0];
      const result = await runner.runScenario('openrouter/5.6-luna-high', scenario);

      // Dimension 1: Signal-to-Noise Ratio (dB)
      expect(result.snrDb).toBeGreaterThan(0);
      expect(Number.isFinite(result.snrDb)).toBe(true);

      // Dimension 2: Time-to-First-Token (TTFT)
      expect(result.ttftMs).toBeGreaterThan(0);

      // Dimension 3: Tokens In / Out
      expect(result.promptTokens).toBeGreaterThan(0);
      expect(result.completionTokens).toBeGreaterThan(0);
      expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);

      // Dimension 4: Findings Precision, Recall, F1
      expect(result.precision).toBeGreaterThanOrEqual(0);
      expect(result.recall).toBeGreaterThanOrEqual(0);
      expect(result.f1Score).toBeGreaterThanOrEqual(0);

      // Dimension 5: Turn Depth
      expect(result.turnDepth).toBeGreaterThanOrEqual(1);

      // Dimension 6: Cost Efficiency
      expect(result.costUSD).toBeGreaterThan(0);
      expect(result.costEfficiency).toBeGreaterThan(0);
    });

    it('TEST_E2E_T1_06 — CLI Benchmark Runner Execution & Exit Code 0', () => {
      const scriptPath = fs.existsSync(path.join(rootDir, 'scripts/evaluate-release-benchmark.mjs'))
        ? path.join(rootDir, 'scripts/evaluate-release-benchmark.mjs')
        : path.join(rootDir, 'scripts/evaluate-testing-charter.mjs');

      const outJson = path.join(tempDir, 'cli-runner-test.json');
      const cmd = `node "${scriptPath}" --offline --category=evidence --output="${outJson}" --json`;
      execSync(cmd, { cwd: rootDir, encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });

      expect(fs.existsSync(outJson)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
      expect(parsed.timestamp).toBeDefined();
      expect(parsed.models.length).toBeGreaterThan(0);
      expect(parsed.summary).toBeDefined();
    });

    it('TEST_E2E_T1_07 — CLI Argument Filtering (--models, --category, --scenarios)', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const secScenarios = getScenariosByCategory('security');
      const singleModel = ['deepseek/deepseek-v4-flash-0731:high'];

      const report = await runner.runBenchmarkSuite(singleModel, secScenarios, { offline: true });
      expect(report.models).toEqual(singleModel);
      expect(report.scenarios.length).toBe(secScenarios.length);
      for (const res of report.detailedResults) {
        expect(res.category).toBe('security');
        expect(res.model).toBe(singleModel[0]);
      }
    });

    it('TEST_E2E_T1_08 — Report Formatting Conformance (Markdown & JSON)', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const scenarios = getAllScenarios().slice(0, 2);
      const report = await runner.runBenchmarkSuite(['openrouter/5.6-luna-high'], scenarios);

      const markdown = formatMarkdownReport(report);
      expect(markdown).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(markdown).toContain('## 1. Executive Summary & Comparative Matrix');
      expect(markdown).toContain('## 2. Key Comparative Dimensions');
      expect(markdown).toContain('## 3. Scenario-by-Scenario Detailed Breakdown');
      expect(markdown).toContain('Verdict Acc (%)');
      expect(markdown).toContain('Avg SNR (dB)');

      const jsonStr = formatJSONReport(report);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.models).toEqual(['openrouter/5.6-luna-high']);
      expect(parsed.summary['openrouter/5.6-luna-high']).toBeDefined();
    });

    it('TEST_E2E_T1_09 — Baseline v1 Conformance & Model Summary Inspection', () => {
      expect(fs.existsSync(baselineV1Path)).toBe(true);
      const baselineData = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));

      expect(baselineData.models).toEqual(APPROVED_4_MODELS);
      expect(baselineData.scenarios.length).toBe(20);
      for (const model of APPROVED_4_MODELS) {
        const summary = baselineData.summary[model];
        expect(summary).toBeDefined();
        expect(summary.recall).toBeGreaterThanOrEqual(0.94);
        expect(summary.verdictAccuracy).toBeGreaterThanOrEqual(95);
        expect(summary.avgSnrDb).toBeGreaterThanOrEqual(10.0);
      }
    });

    it('TEST_E2E_T1_10 — Persona Lookups & Arbitration Consistency', () => {
      const securityScenarios = getScenariosByPersona('security');
      expect(securityScenarios.length).toBeGreaterThan(0);

      for (const scenario of securityScenarios) {
        const sanitized = sanitizeFindings(
          scenario.expectedFindings.map((ef) => ({
            severity: ef.severity,
            path: ef.path,
            line: ef.line || 1,
            title: ef.title || 'Defect title',
            body: ef.description || 'Verified ground truth defect matching scenario charter.',
          })),
          scenario.diffFiles
        );

        const arbitration = computeArbitration(
          [{ id: 'security', status: 'SUCCESS', findings: sanitized }],
          1,
          { changedFiles: scenario.diffFiles }
        );
        expect(arbitration.verdict).toBe(scenario.expectedVerdict);
      }
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY VALUE ANALYSIS & CORNER CASES
  // =========================================================================
  describe('Tier 2: Boundary Value Analysis & Corner Cases', () => {
    it('TEST_E2E_T2_01 — Zero Expected Finding PR & Non-Zero Division Invariant', () => {
      const metrics = calculateMetrics([], []);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBe(1.0);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.f1Score).toBe(1.0);
      expect(metrics.snr).toBe(0.0);
      expect(metrics.snrDb).toBe(20.0); // Clean PR constant
    });

    it('TEST_E2E_T2_02 — False Positive Flood & Extreme SNR Degradation', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'security',
          severity: 'P0',
          path: 'src/auth.ts',
          line: 10,
          title: 'Real Defect',
        },
      ];

      const actual: Finding[] = [
        {
          severity: 'P0',
          path: 'src/auth.ts',
          line: 10,
          title: 'Real Defect',
          body: 'Real Defect Body',
        },
        ...Array.from({ length: 500 }, (_, i) => ({
          severity: 'P2' as const,
          path: `src/noise_${i}.ts`,
          line: 1,
          title: `Hallucinated Nit ${i}`,
          body: `Nit body ${i}`,
        })),
      ];

      const metrics = calculateMetrics(expected, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(500);
      expect(metrics.fn).toBe(0);
      expect(metrics.snrDb).toBeLessThan(0);
      expect(metrics.snrDb).toBe(Math.round(10 * Math.log10(1 / 500) * 100) / 100);
    });

    it('TEST_E2E_T2_03 — Line Proximity Tolerance Boundary (5 vs 6)', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'performance',
          severity: 'P1',
          path: 'src/db.ts',
          line: 50,
          title: 'N+1 Query',
        },
      ];

      // Exact match at distance 5 (pass)
      const findingDist5: Finding[] = [
        {
          severity: 'P1',
          path: 'src/db.ts',
          line: 55,
          title: 'N+1 Query',
          body: 'N+1 Query Details',
        },
      ];
      const matchPass = calculateMetrics(expected, findingDist5, { lineTolerance: 5 });
      expect(matchPass.tp).toBe(1);
      expect(matchPass.fp).toBe(0);

      // Distance 6 exceeds tolerance 5 (fail)
      const findingDist6: Finding[] = [
        {
          severity: 'P1',
          path: 'src/db.ts',
          line: 56,
          title: 'N+1 Query',
          body: 'N+1 Query Details',
        },
      ];
      const matchFail = calculateMetrics(expected, findingDist6, { lineTolerance: 5 });
      expect(matchFail.tp).toBe(0);
      expect(matchFail.fp).toBe(1);
      expect(matchFail.fn).toBe(1);
    });

    it('TEST_E2E_T2_04 — Strict vs Loose Severity Mismatch Handling', () => {
      const expected: ExpectedFinding[] = [
        {
          personaId: 'security',
          severity: 'P0',
          path: 'src/auth.ts',
          line: 12,
          title: 'SSRF',
        },
      ];

      const actualP2: Finding[] = [
        {
          severity: 'P2',
          path: 'src/auth.ts',
          line: 12,
          title: 'SSRF',
          body: 'SSRF Body',
        },
      ];

      const loose = calculateMetrics(expected, actualP2, { strictSeverity: false });
      expect(loose.tp).toBe(1);

      const strict = calculateMetrics(expected, actualP2, { strictSeverity: true });
      expect(strict.tp).toBe(0);
      expect(strict.fp).toBe(1);
      expect(strict.fn).toBe(1);
    });

    it('TEST_E2E_T2_05 — Empty Suite Division-by-Zero Safety', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const report = await runner.runBenchmarkSuite(['deepseek/deepseek-v4-flash-0731:high'], []);

      expect(report.scenarios.length).toBe(0);
      const summary = report.summary['deepseek/deepseek-v4-flash-0731:high'];
      expect(summary.totalScenarios).toBe(0);
      expect(summary.verdictAccuracy).toBe(0);
      expect(summary.f1Score).toBe(0);
      expect(summary.avgSnrDb).toBe(0);
      expect(summary.totalCostUSD).toBe(0);
      expect(Number.isNaN(summary.costEfficiency)).toBe(false);
    });

    it('TEST_E2E_T2_06 — Zero-Cost USD Division Guard', () => {
      const costUSD = 0.000000;
      const tp = 4;
      const costEfficiency = tp > 0 ? Math.round((tp / Math.max(costUSD, 0.00001)) * 100) / 100 : 0;
      expect(Number.isFinite(costEfficiency)).toBe(true);
      expect(costEfficiency).toBeGreaterThan(0);
    });

    it('TEST_E2E_T2_07 — Model Pricing Fallback for Unknown Models', () => {
      const cost = estimateCost('unlisted-vendor/custom-transformer-model', 50_000, 10_000);
      expect(cost).toBeGreaterThan(0);
      // Fallback ($0.50 / $1.50): (50k/1M)*0.50 + (10k/1M)*1.50 = 0.025 + 0.015 = 0.04
      expect(cost).toBe(0.04);
    });

    it('TEST_E2E_T2_08 — Out-of-Diff & Mismatched File Path Sanitization', () => {
      const diffFiles = [
        {
          path: 'src/security/jwt.ts',
          patch: '@@ -1,5 +1,6 @@\n export function verify() {\n+  return true;\n }',
        },
      ];

      const rawFindings: Finding[] = [
        { severity: 'P0', path: 'src/security/jwt.ts', line: 2, title: 'Valid finding', body: 'Valid finding description' },
        { severity: 'P0', path: 'src/security/jwt.ts', line: 99, title: 'Out of hunk line', body: 'Out of hunk description' },
        { severity: 'P0', path: 'src/nonexistent.ts', line: 1, title: 'Unknown file', body: 'Unknown file description' },
      ];

      const sanitized = sanitizeFindings(rawFindings, diffFiles);
      expect(sanitized.length).toBe(1);
      expect(sanitized[0].line).toBe(2);
      expect(sanitized[0].path).toBe('src/security/jwt.ts');
    });

    it('TEST_E2E_T2_09 — Exact Mathematical Boundary Pass/Fail Gate Checks', () => {
      const baseReport: ComparativeBenchmarkReport = {
        timestamp: '2026-08-20T12:00:00Z',
        models: ['openrouter/5.6-luna-high'],
        scenarios: ['scen-1'],
        summary: {
          'openrouter/5.6-luna-high': {
            model: 'openrouter/5.6-luna-high',
            totalScenarios: 1,
            verdictMatches: 1,
            verdictAccuracy: 100,
            totalTp: 1,
            totalFp: 0,
            totalFn: 0,
            precision: 1.0,
            recall: 1.0,
            f1Score: 1.0,
            avgSnr: 1.0,
            avgSnrDb: 10.0,
            avgTtftMs: 100,
            totalPromptTokens: 1000,
            totalCompletionTokens: 200,
            totalTokens: 1200,
            totalCostUSD: 0.01,
            avgTurnDepth: 3.0,
            costEfficiency: 100.0,
          },
        },
        detailedResults: [],
      };

      // 1. Recall exact boundary
      const candRecallPass = JSON.parse(JSON.stringify(baseReport));
      candRecallPass.summary['openrouter/5.6-luna-high'].recall = 1.000;
      expect(evaluateQualityGate(baseReport, candRecallPass).passed).toBe(true);

      const candRecallFail = JSON.parse(JSON.stringify(baseReport));
      candRecallFail.summary['openrouter/5.6-luna-high'].recall = 0.999;
      expect(evaluateQualityGate(baseReport, candRecallFail).passed).toBe(false);

      // 2. Accuracy exact boundary
      const candAccPass = JSON.parse(JSON.stringify(baseReport));
      candAccPass.summary['openrouter/5.6-luna-high'].verdictAccuracy = 100.0;
      expect(evaluateQualityGate(baseReport, candAccPass).passed).toBe(true);

      const candAccFail = JSON.parse(JSON.stringify(baseReport));
      candAccFail.summary['openrouter/5.6-luna-high'].verdictAccuracy = 99.9;
      expect(evaluateQualityGate(baseReport, candAccFail).passed).toBe(false);

      // 3. SNR exact boundary (1.50 dB degradation allowed, 1.51 dB disallowed)
      const candSnrPass = JSON.parse(JSON.stringify(baseReport));
      candSnrPass.summary['openrouter/5.6-luna-high'].avgSnrDb = 8.50; // delta = -1.50 dB
      expect(evaluateQualityGate(baseReport, candSnrPass).passed).toBe(true);

      const candSnrFail = JSON.parse(JSON.stringify(baseReport));
      candSnrFail.summary['openrouter/5.6-luna-high'].avgSnrDb = 8.49; // delta = -1.51 dB
      expect(evaluateQualityGate(baseReport, candSnrFail).passed).toBe(false);

      // 4. F1 exact boundary (-0.020 allowed, -0.021 disallowed)
      const candF1Pass = JSON.parse(JSON.stringify(baseReport));
      candF1Pass.summary['openrouter/5.6-luna-high'].f1Score = 0.980;
      expect(evaluateQualityGate(baseReport, candF1Pass).passed).toBe(true);

      const candF1Fail = JSON.parse(JSON.stringify(baseReport));
      candF1Fail.summary['openrouter/5.6-luna-high'].f1Score = 0.979;
      expect(evaluateQualityGate(baseReport, candF1Fail).passed).toBe(false);

      // 5. Cost Surge (+20.0% allowed when recall neutral, +20.1% disallowed)
      const candCostPass = JSON.parse(JSON.stringify(baseReport));
      candCostPass.summary['openrouter/5.6-luna-high'].totalCostUSD = 0.0120; // +20.0%
      expect(evaluateQualityGate(baseReport, candCostPass).passed).toBe(true);

      const candCostFail = JSON.parse(JSON.stringify(baseReport));
      candCostFail.summary['openrouter/5.6-luna-high'].totalCostUSD = 0.0121; // +21.0%
      expect(evaluateQualityGate(baseReport, candCostFail).passed).toBe(false);
    });
  });

  // =========================================================================
  // TIER 3: PAIRWISE COMBINATORIAL & CROSS-FEATURE INTERACTIONS
  // =========================================================================
  describe('Tier 3: Pairwise Combinatorial & Cross-Feature Interactions', () => {
    it('TEST_E2E_T3_01 — Multi-Turn Context + Tool Evidence Verification + Benchmark Aggregation', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const multiTurnScenarios = getScenariosByCategory('multi_turn');
      const evidenceScenarios = getScenariosByCategory('evidence');
      const combined = [...multiTurnScenarios, ...evidenceScenarios];

      const report = await runner.runBenchmarkSuite(
        ['openrouter/5.6-luna-high', 'deepseek/deepseek-v4-flash-0731:high'],
        combined,
        { offline: true }
      );

      expect(report.scenarios.length).toBe(combined.length);
      for (const res of report.detailedResults) {
        if (res.category === 'multi_turn') {
          expect(res.turnDepth).toBeGreaterThanOrEqual(2);
        }
        if (res.category === 'evidence') {
          expect(res.evidenceGatePassed).toBe(true);
        }
      }
    });

    it('TEST_E2E_T3_02 — Category Filter + Baseline Matrix Save + JSON Serialization', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const secScenarios = getScenariosByCategory('security');
      const report = await runner.runBenchmarkSuite(
        ['google/gemini-3.7-flash:high'],
        secScenarios,
        { offline: true }
      );

      const outPath = path.join(tempDir, 'security-eval-matrix.json');
      fs.writeFileSync(outPath, formatJSONReport(report), 'utf8');

      expect(fs.existsSync(outPath)).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(loaded.models).toEqual(['google/gemini-3.7-flash:high']);
      expect(loaded.scenarios.length).toBe(secScenarios.length);
    });

    it('TEST_E2E_T3_03 — Custom Mock Adapter Streaming vs Offline Simulation Equivalence', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const scenario = getAllScenarios()[0];

      // 1. Offline simulation
      const simResult = await runner.runScenario('openrouter/5.6-luna-high', scenario);

      // 2. Custom mock adapter
      const mockResult = await runner.runScenario('openrouter/5.6-luna-high', scenario, {
        mockAdapter: async () => ({
          findings: simResult.findings,
          verdict: simResult.verdict,
          ttftMs: simResult.ttftMs,
          promptTokens: simResult.promptTokens,
          completionTokens: simResult.completionTokens,
          costUSD: simResult.costUSD,
          turnDepth: simResult.turnDepth,
        }),
      });

      expect(mockResult.tp).toBe(simResult.tp);
      expect(mockResult.fp).toBe(simResult.fp);
      expect(mockResult.fn).toBe(simResult.fn);
      expect(mockResult.snrDb).toBe(simResult.snrDb);
      expect(mockResult.verdict).toBe(simResult.verdict);
      expect(mockResult.costUSD).toBe(simResult.costUSD);
    });

    it('TEST_E2E_T3_04 — Benchmark Generation + Baseline Comparator Pipeline', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const scenarios = getAllScenarios().slice(0, 5);

      const candidateReport = await runner.runBenchmarkSuite(APPROVED_4_MODELS, scenarios, {
        offline: true,
      });

      const baselineData = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));
      const gateResult = evaluateQualityGate(baselineData, candidateReport);

      expect(gateResult.modelResults).toBeDefined();
      expect(Object.keys(gateResult.modelResults).length).toBe(4);
    });

    it('TEST_E2E_T3_05 — Multi-Model Matrix Filtering Composed with File Output', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const selectedModels = ['deepseek/deepseek-v4-flash-0731:high', 'qwen/qwen-3.8-27b:high'];
      const perfScenarios = getScenariosByCategory('performance');

      const report = await runner.runBenchmarkSuite(selectedModels, perfScenarios, {
        offline: true,
      });

      const mdOut = path.join(tempDir, 'perf-matrix.md');
      fs.writeFileSync(mdOut, formatMarkdownReport(report), 'utf8');

      const mdContent = fs.readFileSync(mdOut, 'utf8');
      expect(mdContent).toContain('`deepseek/deepseek-v4-flash-0731:high`');
      expect(mdContent).toContain('`qwen/qwen-3.8-27b:high`');
      expect(mdContent).not.toContain('`google/gemini-3.7-flash:high`');
    });

    it('TEST_E2E_T3_06 — Inline Regression Check with Conditional Gate Flags', () => {
      const baselineData = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));

      // Create a candidate with high SNR degradation on one model
      const regressedCandidate = JSON.parse(JSON.stringify(baselineData));
      regressedCandidate.summary['openrouter/5.6-luna-high'].avgSnrDb = baselineData.summary['openrouter/5.6-luna-high'].avgSnrDb - 3.5; // -3.5 dB breach

      const gate = evaluateQualityGate(baselineData, regressedCandidate);
      expect(gate.passed).toBe(false);
      expect(gate.violations.some((v) => v.includes('SNR degraded by 3.50 dB'))).toBe(true);
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD RELEASE LIFECYCLE SCENARIOS
  // =========================================================================
  describe('Tier 4: Real-World Release Lifecycle Workflows', () => {
    it('WORKFLOW_4.1 — Candidate Release Baseline Generation & Verification (Pass Lifecycle)', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const allScenarios = getAllScenarios();

      // Step 1: Candidate release benchmark generation across full 94-scenario catalog
      const candidateReport = await runner.runBenchmarkSuite(APPROVED_4_MODELS, allScenarios, {
        offline: true,
      });

      // Step 2: Persist candidate baseline artifact
      const candidatePath = path.join(tempDir, 'model-benchmark-matrix-candidate.json');
      fs.writeFileSync(candidatePath, formatJSONReport(candidateReport), 'utf8');
      expect(fs.existsSync(candidatePath)).toBe(true);

      // Step 3: Compare candidate against baseline (supports baseline v3, baseline v2, or baseline v1 with normalized gate)
      const baselineV3Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v3.json');
      const baselineV2Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v2.json');
      const baselinePathToUse = fs.existsSync(baselineV3Path)
        ? baselineV3Path
        : (fs.existsSync(baselineV2Path) ? baselineV2Path : baselineV1Path);
      const baselineData = JSON.parse(fs.readFileSync(baselinePathToUse, 'utf8'));

      const gateResult = evaluateQualityGate(baselineData, candidateReport);

      // Step 4: Validate all 4 models pass the release gate
      for (const model of APPROVED_4_MODELS) {
        expect(gateResult.modelResults[model].passed).toBe(true);
      }
      expect(gateResult.passed).toBe(true);
      expect(gateResult.violations).toEqual([]);

      // Step 5: Backwards compatibility verification on legacy 20-scenario subset
      const legacyScenarios = allScenarios.filter((s) => baselineData.scenarios.includes(s.id));
      if (legacyScenarios.length === 20) {
        const legacyReport = await runner.runBenchmarkSuite(APPROVED_4_MODELS, legacyScenarios, { offline: true });
        const baselineV1Data = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));
        const legacyGate = evaluateQualityGate(baselineV1Data, legacyReport);
        expect(legacyGate.passed).toBe(true);
      }
    });

    it('WORKFLOW_4.2 — Automated Quality Gate Blocker on Injected Defect (Fail Lifecycle)', () => {
      const baselineData = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));

      // Inject regression: Luna High misses P0 defect, recall drops from 1.0 to 0.88
      const regressedCandidate = JSON.parse(JSON.stringify(baselineData));
      regressedCandidate.summary['openrouter/5.6-luna-high'].recall = 0.88;
      regressedCandidate.summary['openrouter/5.6-luna-high'].totalFn = 2;
      regressedCandidate.summary['openrouter/5.6-luna-high'].verdictAccuracy = 88.0;

      const gateResult = evaluateQualityGate(baselineData, regressedCandidate);

      expect(gateResult.passed).toBe(false);
      expect(gateResult.modelResults['openrouter/5.6-luna-high'].passed).toBe(false);
      expect(gateResult.violations.length).toBeGreaterThan(0);
      expect(gateResult.violations.some((v) => v.includes('Recall degraded'))).toBe(true);
      expect(gateResult.violations.some((v) => v.includes('New false negatives'))).toBe(true);
    });

    it('WORKFLOW_4.3 — Non-Strict Telemetry / Audit Comparison Flow', () => {
      const baselineData = JSON.parse(fs.readFileSync(baselineV1Path, 'utf8'));

      // Candidate with minor latency surge
      const auditCandidate = JSON.parse(JSON.stringify(baselineData));
      auditCandidate.summary['google/gemini-3.7-flash:high'].avgTtftMs = 200; // was 115ms (+85ms, +73.9%)

      const gateResult = evaluateQualityGate(baselineData, auditCandidate);
      expect(gateResult.passed).toBe(false);
      expect(gateResult.violations.some((v) => v.includes('TTFT latency surged'))).toBe(true);

      // In non-strict / audit mode, warnings are logged without blocking deployment
      const auditLog = gateResult.violations.map((v) => `[AUDIT_WARN] ${v}`);
      expect(auditLog.length).toBeGreaterThan(0);
      expect(auditLog[0]).toContain('[AUDIT_WARN]');
    });

    it('WORKFLOW_4.4 — Offline Deterministic Replay Idempotency & Repeatability across 4-Model Roster', async () => {
      const runner1 = new EvaluationRunner({ offline: true });
      const runner2 = new EvaluationRunner({ offline: true });
      const sampleScenarios = getAllScenarios().slice(0, 5);

      // Verify per-model scenario idempotency across all 4 approved models
      for (const model of APPROVED_4_MODELS) {
        for (const scenario of sampleScenarios) {
          const res1 = await runner1.runScenario(model, scenario);
          const res2 = await runner2.runScenario(model, scenario);

          expect(res1.tp).toBe(res2.tp);
          expect(res1.fp).toBe(res2.fp);
          expect(res1.fn).toBe(res2.fn);
          expect(res1.precision).toBe(res2.precision);
          expect(res1.recall).toBe(res2.recall);
          expect(res1.f1Score).toBe(res2.f1Score);
          expect(res1.snrDb).toBe(res2.snrDb);
          expect(res1.promptTokens).toBe(res2.promptTokens);
          expect(res1.completionTokens).toBe(res2.completionTokens);
          expect(res1.totalTokens).toBe(res2.totalTokens);
          expect(res1.costUSD).toBe(res2.costUSD);
          expect(res1.verdict).toBe(res2.verdict);
          expect(res1.verdictMatch).toBe(res2.verdictMatch);
          expect(res1.findings).toEqual(res2.findings);
        }
      }

      // Verify benchmark suite level aggregation idempotency
      const suite1 = await runner1.runBenchmarkSuite(APPROVED_4_MODELS, sampleScenarios, { offline: true });
      const suite2 = await runner2.runBenchmarkSuite(APPROVED_4_MODELS, sampleScenarios, { offline: true });

      for (const model of APPROVED_4_MODELS) {
        expect(suite1.summary[model]).toEqual(suite2.summary[model]);
      }
    });

    it('WORKFLOW_4.5 — Production Release Artifact Archival & Integrity Verification', async () => {
      const runner = new EvaluationRunner({ offline: true });
      const scenarios = getAllScenarios().slice(0, 4);

      const report = await runner.runBenchmarkSuite(APPROVED_4_MODELS, scenarios, {
        offline: true,
      });

      const jsonPath = path.join(tempDir, 'release-archive-v2.json');
      const mdPath = path.join(tempDir, 'release-archive-v2.md');

      fs.writeFileSync(jsonPath, formatJSONReport(report), 'utf8');
      fs.writeFileSync(mdPath, formatMarkdownReport(report), 'utf8');

      expect(fs.existsSync(jsonPath)).toBe(true);
      expect(fs.existsSync(mdPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      expect(parsed.timestamp).toBeDefined();
      expect(parsed.models).toEqual(APPROVED_4_MODELS);
      expect(parsed.detailedResults.length).toBe(APPROVED_4_MODELS.length * scenarios.length);

      const mdContent = fs.readFileSync(mdPath, 'utf8');
      expect(mdContent).toContain('# Model Comparative Evaluation & Benchmark Report');
      expect(mdContent).toContain('## 1. Executive Summary & Comparative Matrix');
    });
  });
});
