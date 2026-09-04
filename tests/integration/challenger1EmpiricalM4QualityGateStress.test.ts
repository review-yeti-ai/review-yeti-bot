/**
 * Milestone M4 Empirical Adversarial Challenger Test Suite
 * Location: tests/integration/challenger1EmpiricalM4QualityGateStress.test.ts
 *
 * Adversarially challenges scripts/compare-release-baselines.mjs and eval-baselines/model-benchmark-matrix-v5.json:
 * - Stress-tests zero-tolerance and thresholded gates (recall, accuracy, SNR, F1, TTFT, cost surge, new FN, new FP).
 * - Tests boundary conditions, edge cases, model alias resolution, and catalog expansion.
 * - Tests CLI modes (--strict, --warn-only, --json, custom thresholds file).
 * - Audits Baseline v5 matrix schema, detailed results, and DeepSeek Low empirical metrics.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareBaselines,
  calculateDeltas,
  calculateScenarioDeltas,
  evaluateModelGate,
  evaluateQualityGate,
  loadBenchmarkMatrix,
  normalizeModelIdentifier,
  areModelsEquivalent,
  parseCliArgs,
  formatMarkdownReport,
  formatJsonReport,
  main,
  DEFAULT_THRESHOLDS,
  DEFAULT_MODELS,
  DEFAULT_V5_MODELS,
} from '../../scripts/compare-release-baselines.mjs';

// scripts/compare-release-baselines.mjs is untyped runtime JS (out of this worker's file
// scope to annotate). It returns per-model deltas that are, at runtime, one of two shapes
// (a fully-evaluated delta or a SKIPPED stub) via a dynamically-keyed object, which TS's
// checked-JS inference cannot express with an index signature. These mirror the exact
// object literals returned by calculateDeltas()/compareBaselines() so tests can narrow to
// the branch they know applies at each call site.
interface MetricDelta {
  baseline: number;
  candidate: number;
  delta: number;
  percentChange?: number;
}

interface ModelDeltaFull {
  model: string;
  status: string;
  violations: string[];
  totalScenarios: { baseline: number; candidate: number; delta: number };
  verdictAccuracy: MetricDelta;
  recall: MetricDelta;
  precision: MetricDelta;
  f1Score: MetricDelta;
  avgSnrDb: MetricDelta;
  avgTtftMs: MetricDelta;
  totalCostUSD: MetricDelta;
  normalizedAvgCostUSD: MetricDelta;
  normalizedCostDeltaPct: number;
  costEfficiency: MetricDelta;
  totalTp: MetricDelta;
  totalFp: MetricDelta;
  totalFn: MetricDelta;
  newFnCount: number;
  newFpCount: number;
  omittedFiles: { baseline: number; candidate: number; delta: number };
  coveragePct: { baseline: number; candidate: number; delta: number };
  partitionsCount: { baseline: number; candidate: number; delta: number };
  compactionReductionPct: { baseline: number; candidate: number; delta: number };
  omittedFilesCount: number;
  coveragePercent: number;
}

interface ModelDeltaSkipped {
  model: string;
  status: string;
  reason?: string;
  violations: string[];
}

type ModelDeltaEntry = ModelDeltaFull | ModelDeltaSkipped;

interface ScenarioDelta {
  scenarioId: string;
  model: string;
  isRegression: boolean;
  newFn: number;
  newFp: number;
  violations: string[];
}

interface ComparisonResult {
  timestamp: string;
  baselineFile: string;
  candidateFile: string;
  passed: boolean;
  hasRegressions: boolean;
  totalBreaches: number;
  thresholds: Record<string, unknown>;
  summaryDeltas: ModelDeltaEntry[];
  modelDeltas: Record<string, ModelDeltaEntry>;
  scenarioDeltas: ScenarioDelta[];
  breaches: Array<{ model: string; rule: string; severity: string; message: string }>;
}

interface MainSuccessResult {
  exitCode: number;
  report: ComparisonResult;
  comparison: ComparisonResult;
  markdown: string;
  json: string;
}

function asComparison(result: unknown): ComparisonResult {
  return result as ComparisonResult;
}

function asFullDelta(entry: ModelDeltaEntry | undefined): ModelDeltaFull {
  return entry as ModelDeltaFull;
}

function asSkippedDelta(entry: ModelDeltaEntry | undefined): ModelDeltaSkipped {
  return entry as ModelDeltaSkipped;
}

describe('Milestone M4 Empirical Adversarial Challenge: Quality Gate & Baseline v5', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const tempDir = path.resolve(rootDir, 'node_modules/.cache/challenger1-m4-test');
  const baselineV1Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v1.json');
  const baselineV4Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v4.json');
  const baselineV5Path = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v5.json');
  const baselineV5MdPath = path.join(rootDir, 'eval-baselines/model-benchmark-matrix-v5.md');

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // SUITE 1: CANONICAL BASELINE V5 MATRIX AUDIT & INTEGRITY VERIFICATION
  // =========================================================================
  describe('Suite 1: Canonical Baseline v5 Matrix Audit & Parity Invariant', () => {
    it('AUDIT_1.1 — Baseline v5 JSON & MD Artifact Existence and Schema Conformance', () => {
      expect(fs.existsSync(baselineV5Path)).toBe(true);
      expect(fs.existsSync(baselineV5MdPath)).toBe(true);

      const v5 = JSON.parse(fs.readFileSync(baselineV5Path, 'utf8'));
      expect(v5.version).toBe('v5');
      expect(v5.timestamp).toBeDefined();
      expect(v5.models).toEqual(DEFAULT_V5_MODELS);
      expect(v5.scenarios).toHaveLength(190);
      expect(v5.detailedResults).toHaveLength(190 * 5); // 950 entries

      // Verify MD matches
      const mdContent = fs.readFileSync(baselineV5MdPath, 'utf8');
      expect(mdContent).toContain('**Total Scenarios**: 190');
      expect(mdContent).toContain('deepseek/deepseek-v4-flash-0731:low');
      expect(mdContent).toContain('92.1%');
    });

    it('AUDIT_1.2 — DeepSeek V4 Flash Low Empirical Metrics Invariants', () => {
      const v5 = JSON.parse(fs.readFileSync(baselineV5Path, 'utf8'));
      const dLow = v5.summary['deepseek/deepseek-v4-flash-0731:low'];

      expect(dLow).toBeDefined();
      expect(dLow.totalScenarios).toBe(190);
      expect(dLow.verdictMatches).toBe(175);
      expect(dLow.verdictAccuracy).toBeCloseTo(92.1, 1);
      expect(dLow.totalTp).toBe(136);
      expect(dLow.totalFp).toBe(0);
      expect(dLow.totalFn).toBe(14);
      expect(dLow.precision).toBe(1.0);
      expect(dLow.recall).toBeCloseTo(0.907, 3);
      expect(dLow.f1Score).toBeCloseTo(0.951, 3);
      expect(dLow.avgSnrDb).toBeCloseTo(10.7, 1);
      expect(dLow.avgTtftMs).toBe(95);
      expect(dLow.totalTokens).toBe(1140232);
      expect(dLow.totalCostUSD).toBeCloseTo(0.1699, 4);
      expect(dLow.avgTurnDepth).toBe(2);
      expect(dLow.costEfficiency).toBeCloseTo(800.32, 2);

      // Verify detailed results for DeepSeek Low
      const dLowDetails = v5.detailedResults.filter((r: any) => r.model === 'deepseek/deepseek-v4-flash-0731:low');
      expect(dLowDetails).toHaveLength(190);
      const matches = dLowDetails.filter((r: any) => r.verdictMatch).length;
      expect(matches).toBe(175);
      const sumTp = dLowDetails.reduce((sum: number, r: any) => sum + r.tp, 0);
      expect(sumTp).toBe(136);
      const sumFn = dLowDetails.reduce((sum: number, r: any) => sum + r.fn, 0);
      expect(sumFn).toBe(14);
    });

    it('AUDIT_1.3 — Parity Check: v5 vs v5 Self-Comparison Passes with 0 Breaches', () => {
      const comparison = asComparison(compareBaselines(baselineV5Path, baselineV5Path, { strict: true }));

      expect(comparison.passed).toBe(true);
      expect(comparison.hasRegressions).toBe(false);
      expect(comparison.totalBreaches).toBe(0);
      expect(comparison.breaches).toHaveLength(0);

      for (const summaryDeltaEntry of comparison.summaryDeltas) {
        const summaryDelta = asFullDelta(summaryDeltaEntry);
        expect(summaryDelta.status).toBe('PASS');
        expect(summaryDelta.violations).toHaveLength(0);
        expect(summaryDelta.recall.delta).toBe(0);
        expect(summaryDelta.verdictAccuracy.delta).toBe(0);
        expect(summaryDelta.f1Score.delta).toBe(0);
        expect(summaryDelta.avgSnrDb.delta).toBe(0);
        expect(summaryDelta.avgTtftMs.delta).toBe(0);
        expect(summaryDelta.newFnCount).toBe(0);
        expect(summaryDelta.newFpCount).toBe(0);
      }
    });

    it('AUDIT_1.4 — Forward Compatibility Check: v5 Candidate vs v4 Baseline Passes', () => {
      const comparison = asComparison(compareBaselines(baselineV5Path, baselineV4Path, { strict: true }));

      expect(comparison.passed).toBe(true);
      expect(comparison.hasRegressions).toBe(false);
      expect(comparison.totalBreaches).toBe(0);

      // DeepSeek Low should be marked SKIPPED (not in baseline v4)
      const dLowDelta = asSkippedDelta(comparison.modelDeltas['deepseek/deepseek-v4-flash-0731:low']);
      expect(dLowDelta).toBeDefined();
      expect(dLowDelta.status).toBe('SKIPPED');
      expect(dLowDelta.reason).toContain('Not present in baseline');

      // The other 4 models must all PASS
      const highModels = DEFAULT_MODELS;
      for (const m of highModels) {
        expect(comparison.modelDeltas[m].status).toBe('PASS');
      }
    });
  });

  // =========================================================================
  // SUITE 2: INTENTIONAL METRIC REGRESSIONS & ZERO-TOLERANCE THRESHOLDS
  // =========================================================================
  describe('Suite 2: Intentional Metric Regressions Stress Harness', () => {
    let baselineData: any;

    beforeAll(() => {
      baselineData = JSON.parse(fs.readFileSync(baselineV5Path, 'utf8'));
    });

    it('GATE_2.1 — Recall Degradation Gate: Fails on Any Recall Drop (> 0.00)', () => {
      const candidate = JSON.parse(JSON.stringify(baselineData));
      // Inject slight recall drop on Gemini: 1.000 -> 0.999
      candidate.summary['google/gemini-3.7-flash:high'].recall = 0.999;
      // Also adjust detailed result to reflect the dropped recall
      const geminiDetail = candidate.detailedResults.find(
        (r: any) => r.model === 'google/gemini-3.7-flash:high' && r.tp > 0
      );
      if (geminiDetail) {
        geminiDetail.tp -= 1;
        geminiDetail.fn += 1;
      }

      const res = asComparison(compareBaselines(candidate, baselineData, { strict: true }));
      expect(res.passed).toBe(false);
      expect(res.hasRegressions).toBe(true);
      expect(res.totalBreaches).toBeGreaterThanOrEqual(1);

      const geminiDelta = res.modelDeltas['google/gemini-3.7-flash:high'];
      expect(geminiDelta.status).toBe('REGRESSION');
      expect(geminiDelta.violations.some((v: string) => v.includes('Recall drop'))).toBe(true);

      // Verify custom threshold override works
      const relaxedRes = asComparison(compareBaselines(candidate, baselineData, {
        strict: true,
        thresholds: { maxRecallDrop: 0.01 },
      }));
      // Should not breach recall gate with 0.01 tolerance
      const geminiRelaxed = relaxedRes.modelDeltas['google/gemini-3.7-flash:high'];
      expect(geminiRelaxed.violations.some((v: string) => v.includes('Recall drop'))).toBe(false);
    });

    it('GATE_2.2 — Verdict Accuracy Degradation Gate: Fails on Accuracy Drop (> 0.0%)', () => {
      const candidate = JSON.parse(JSON.stringify(baselineData));
      // Inject accuracy drop on Luna High: 100.0% -> 98.9%
      candidate.summary['openrouter/5.6-luna-high'].verdictAccuracy = 98.9;

      const res = asComparison(compareBaselines(candidate, baselineData, { strict: true }));
      expect(res.passed).toBe(false);

      const lunaDelta = res.modelDeltas['openrouter/5.6-luna-high'];
      expect(lunaDelta.status).toBe('REGRESSION');
      expect(lunaDelta.violations.some((v: string) => v.includes('Accuracy drop'))).toBe(true);
    });

    it('GATE_2.3 — SNR Degradation Gate: Permissive at <= 1.50 dB, Fails at > 1.50 dB', () => {
      const candidatePass = JSON.parse(JSON.stringify(baselineData));
      const baseSnr = baselineData.summary['qwen/qwen-3.8-27b:high'].avgSnrDb;
      // Drop by exactly 1.50 dB (allowed)
      candidatePass.summary['qwen/qwen-3.8-27b:high'].avgSnrDb = baseSnr - 1.50;

      const resPass = asComparison(compareBaselines(candidatePass, baselineData, { strict: true }));
      const qwenPassDelta = resPass.modelDeltas['qwen/qwen-3.8-27b:high'];
      expect(qwenPassDelta.violations.some((v: string) => v.includes('SNR degradation'))).toBe(false);

      // Drop by 1.51 dB (breach)
      const candidateFail = JSON.parse(JSON.stringify(baselineData));
      candidateFail.summary['qwen/qwen-3.8-27b:high'].avgSnrDb = baseSnr - 1.51;

      const resFail = asComparison(compareBaselines(candidateFail, baselineData, { strict: true }));
      expect(resFail.passed).toBe(false);
      const qwenFailDelta = resFail.modelDeltas['qwen/qwen-3.8-27b:high'];
      expect(qwenFailDelta.status).toBe('REGRESSION');
      expect(qwenFailDelta.violations.some((v: string) => v.includes('SNR degradation: -1.51 dB'))).toBe(true);
    });

    it('GATE_2.4 — F1 Score Degradation Gate: Permissive at <= 0.02, Fails at > 0.02', () => {
      const candidatePass = JSON.parse(JSON.stringify(baselineData));
      const baseF1 = baselineData.summary['deepseek/deepseek-v4-flash-0731:high'].f1Score;
      // Drop by 0.020 (allowed)
      candidatePass.summary['deepseek/deepseek-v4-flash-0731:high'].f1Score = baseF1 - 0.020;

      const resPass = asComparison(compareBaselines(candidatePass, baselineData, { strict: true }));
      const passDelta = resPass.modelDeltas['deepseek/deepseek-v4-flash-0731:high'];
      expect(passDelta.violations.some((v: string) => v.includes('F1 drop'))).toBe(false);

      // Drop by 0.021 (breach)
      const candidateFail = JSON.parse(JSON.stringify(baselineData));
      candidateFail.summary['deepseek/deepseek-v4-flash-0731:high'].f1Score = baseF1 - 0.021;

      const resFail = asComparison(compareBaselines(candidateFail, baselineData, { strict: true }));
      expect(resFail.passed).toBe(false);
      const failDelta = resFail.modelDeltas['deepseek/deepseek-v4-flash-0731:high'];
      expect(failDelta.status).toBe('REGRESSION');
      expect(failDelta.violations.some((v: string) => v.includes('F1 drop: -0.021'))).toBe(true);
    });

    it('GATE_2.5 — TTFT Latency Surge Gate: Compound Condition (> 50ms AND > 25%)', () => {
      const baseTtft = baselineData.summary['google/gemini-3.7-flash:high'].avgTtftMs; // e.g. 115ms

      // Scenario A: Delta > 50ms AND Ratio > 25% => FAIL (+65ms, +56.5%)
      const candA = JSON.parse(JSON.stringify(baselineData));
      candA.summary['google/gemini-3.7-flash:high'].avgTtftMs = baseTtft + 65;
      const resA = asComparison(compareBaselines(candA, baselineData, { strict: true }));
      expect(resA.passed).toBe(false);
      expect(resA.modelDeltas['google/gemini-3.7-flash:high'].violations.some((v: string) => v.includes('TTFT latency spike'))).toBe(true);

      // Scenario B: Delta <= 50ms BUT Ratio > 25% => PASS (+40ms, +34.8%)
      const candB = JSON.parse(JSON.stringify(baselineData));
      candB.summary['google/gemini-3.7-flash:high'].avgTtftMs = baseTtft + 40;
      const resB = asComparison(compareBaselines(candB, baselineData, { strict: true }));
      expect(resB.modelDeltas['google/gemini-3.7-flash:high'].violations.some((v: string) => v.includes('TTFT latency spike'))).toBe(false);

      // Scenario C: Delta > 50ms BUT Ratio <= 25% on a high-latency baseline => PASS
      const highBase = JSON.parse(JSON.stringify(baselineData));
      highBase.summary['google/gemini-3.7-flash:high'].avgTtftMs = 300;
      const candC = JSON.parse(JSON.stringify(highBase));
      candC.summary['google/gemini-3.7-flash:high'].avgTtftMs = 360; // delta +60ms, ratio +20%
      const resC = asComparison(compareBaselines(candC, highBase, { strict: true }));
      expect(resC.modelDeltas['google/gemini-3.7-flash:high'].violations.some((v: string) => v.includes('TTFT latency spike'))).toBe(false);
    });

    it('GATE_2.6 — Cost Surge Gate: Normalized Cost Surge (> 20%) without Recall Gain', () => {
      const baseCost = baselineData.summary['openrouter/5.6-luna-high'].totalCostUSD;

      // Scenario A: Cost surge +25% with zero recall change => FAIL
      const candA = JSON.parse(JSON.stringify(baselineData));
      candA.summary['openrouter/5.6-luna-high'].totalCostUSD = baseCost * 1.25;
      const resA = asComparison(compareBaselines(candA, baselineData, { strict: true }));
      expect(resA.passed).toBe(false);
      expect(resA.modelDeltas['openrouter/5.6-luna-high'].violations.some((v: string) => v.includes('Cost inflation without recall gain'))).toBe(true);

      // Scenario B: Cost surge +25% WITH recall gain (+0.05 on deepseek low) => PASS cost guard
      const candB = JSON.parse(JSON.stringify(baselineData));
      candB.summary['deepseek/deepseek-v4-flash-0731:low'].totalCostUSD =
        baselineData.summary['deepseek/deepseek-v4-flash-0731:low'].totalCostUSD * 1.25;
      candB.summary['deepseek/deepseek-v4-flash-0731:low'].recall =
        baselineData.summary['deepseek/deepseek-v4-flash-0731:low'].recall + 0.05;
      const resB = asComparison(compareBaselines(candB, baselineData, { strict: true }));
      expect(resB.modelDeltas['deepseek/deepseek-v4-flash-0731:low'].violations.some((v: string) => v.includes('Cost inflation'))).toBe(false);

      // Scenario C: Cost surge +19% with zero recall change => PASS
      const candC = JSON.parse(JSON.stringify(baselineData));
      candC.summary['openrouter/5.6-luna-high'].totalCostUSD = baseCost * 1.19;
      const resC = asComparison(compareBaselines(candC, baselineData, { strict: true }));
      expect(resC.modelDeltas['openrouter/5.6-luna-high'].violations.some((v: string) => v.includes('Cost inflation'))).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 3: SCENARIO-LEVEL DEFECT INVARIANCE & NOISE TRAPS
  // =========================================================================
  describe('Suite 3: Fine-Grained Scenario Regressions & Defect Deltas', () => {
    let baselineData: any;

    beforeAll(() => {
      baselineData = JSON.parse(fs.readFileSync(baselineV5Path, 'utf8'));
    });

    it('GATE_3.1 — New False Negatives: Injected Missed Defect Triggers Gate & Breach', () => {
      const candidate = JSON.parse(JSON.stringify(baselineData));
      // Inject FN into deepseek-v4-flash-0731:high on scenario telecom-haystack-sip-dropped-tenant
      const detail = candidate.detailedResults.find(
        (r: any) => r.model === 'deepseek/deepseek-v4-flash-0731:high' && r.scenarioId === 'telecom-haystack-sip-dropped-tenant'
      );
      expect(detail).toBeDefined();
      detail.fn = 1;
      detail.tp = 0;
      detail.verdict = 'SHIP'; // Expected BLOCK
      detail.verdictMatch = false;

      const res = asComparison(compareBaselines(candidate, baselineData, { strict: true }));
      expect(res.passed).toBe(false);

      // Check summary delta
      const delta = asFullDelta(res.modelDeltas['deepseek/deepseek-v4-flash-0731:high']);
      expect(delta.newFnCount).toBe(1);
      expect(delta.violations.some((v: string) => v.includes('New false negatives: +1'))).toBe(true);

      // Check scenario deltas
      const scenDelta = res.scenarioDeltas.find(
        (sd) => sd.model === 'deepseek/deepseek-v4-flash-0731:high' && sd.scenarioId === 'telecom-haystack-sip-dropped-tenant'
      );
      expect(scenDelta).toBeDefined();
      expect(scenDelta!.isRegression).toBe(true);
      expect(scenDelta!.newFn).toBe(1);
      expect(scenDelta!.violations.some((v: string) => v.includes('New false negatives'))).toBe(true);
      expect(scenDelta!.violations.some((v: string) => v.includes('Verdict regressed'))).toBe(true);

      // Test flag override: --no-disallow-new-fn
      const disabledFnRes = asComparison(compareBaselines(candidate, baselineData, {
        strict: true,
        thresholds: { disallowNewFn: false, maxRecallDrop: 0.05, maxAccuracyDrop: 1.0 },
      }));
      const disabledDelta = disabledFnRes.modelDeltas['deepseek/deepseek-v4-flash-0731:high'];
      expect(disabledDelta.violations.some((v: string) => v.includes('New false negatives'))).toBe(false);
    });

    it('GATE_3.2 — New False Positives: Injected False Alarm Triggers Gate & Breach', () => {
      const candidate = JSON.parse(JSON.stringify(baselineData));
      // Inject FP into openrouter/5.6-luna-high on clean scenario clean-multi-feature-ship
      const detail = candidate.detailedResults.find(
        (r: any) => r.model === 'openrouter/5.6-luna-high' && r.scenarioId === 'clean-multi-feature-ship'
      );
      expect(detail).toBeDefined();
      detail.fp = 2;
      detail.verdict = 'BLOCK'; // Expected SHIP
      detail.verdictMatch = false;

      const res = asComparison(compareBaselines(candidate, baselineData, { strict: true }));
      expect(res.passed).toBe(false);

      const delta = asFullDelta(res.modelDeltas['openrouter/5.6-luna-high']);
      expect(delta.newFpCount).toBe(2);
      expect(delta.violations.some((v: string) => v.includes('New false positives: +2'))).toBe(true);

      // Check scenario deltas
      const scenDelta = res.scenarioDeltas.find(
        (sd) => sd.model === 'openrouter/5.6-luna-high' && sd.scenarioId === 'clean-multi-feature-ship'
      );
      expect(scenDelta).toBeDefined();
      expect(scenDelta!.isRegression).toBe(true);
      expect(scenDelta!.newFp).toBe(2);
    });

    it('GATE_3.3 — Multiple Concurrent Breaches Across Models Accumulate Correctly', () => {
      const candidate = JSON.parse(JSON.stringify(baselineData));

      // Model 1 (DeepSeek High): 1 recall drop + 1 accuracy drop
      candidate.summary['deepseek/deepseek-v4-flash-0731:high'].recall = 0.95;
      candidate.summary['deepseek/deepseek-v4-flash-0731:high'].verdictAccuracy = 95.0;

      // Model 2 (Luna High): 1 SNR drop
      candidate.summary['openrouter/5.6-luna-high'].avgSnrDb =
        baselineData.summary['openrouter/5.6-luna-high'].avgSnrDb - 2.5;

      // Model 3 (Gemini Flash): 1 cost surge
      candidate.summary['google/gemini-3.7-flash:high'].totalCostUSD =
        baselineData.summary['google/gemini-3.7-flash:high'].totalCostUSD * 1.50;

      const res = asComparison(compareBaselines(candidate, baselineData, { strict: true }));
      expect(res.passed).toBe(false);
      expect(res.hasRegressions).toBe(true);

      expect(res.modelDeltas['deepseek/deepseek-v4-flash-0731:high'].violations.length).toBeGreaterThanOrEqual(2);
      expect(res.modelDeltas['openrouter/5.6-luna-high'].violations.length).toBeGreaterThanOrEqual(1);
      expect(res.modelDeltas['google/gemini-3.7-flash:high'].violations.length).toBeGreaterThanOrEqual(1);
      expect(res.totalBreaches).toBe(res.breaches.length);
    });
  });

  // =========================================================================
  // SUITE 4: EDGE CASES, MODEL ALIASES & PATHOLOGICAL INPUTS
  // =========================================================================
  describe('Suite 4: Edge Cases, Model Aliases & Pathological Inputs', () => {
    let baselineData: any;

    beforeAll(() => {
      baselineData = JSON.parse(fs.readFileSync(baselineV5Path, 'utf8'));
    });

    it('EDGE_4.1 — Model Alias Resolution: Canonicalizes Fireworks and Short Aliases', () => {
      expect(normalizeModelIdentifier('accounts/fireworks/models/deepseek-v4-flash-0731')).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(normalizeModelIdentifier('deepseek-v4-flash-0731:low')).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(normalizeModelIdentifier('deepseek-v4-flash:low')).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(normalizeModelIdentifier('openai/gpt-5.6-luna')).toBe('openrouter/5.6-luna-high');
      expect(normalizeModelIdentifier('5.6-luna-high')).toBe('openrouter/5.6-luna-high');
      expect(normalizeModelIdentifier('qwen/qwen3.8-27b:high')).toBe('qwen/qwen-3.8-27b:high');
      expect(normalizeModelIdentifier('gemini-3.7-flash:high')).toBe('google/gemini-3.7-flash:high');

      expect(areModelsEquivalent('accounts/fireworks/models/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-0731:low')).toBe(true);
      expect(areModelsEquivalent('openai/gpt-5.6-luna', 'openrouter/5.6-luna-high')).toBe(true);
      expect(areModelsEquivalent('deepseek/deepseek-v4-flash-0731:low', 'deepseek/deepseek-v4-flash-0731:high')).toBe(false);
    });

    it('EDGE_4.2 — Catalog Expansion Asymmetry: Common Baseline Scenario Extraction', () => {
      // Compare v5 candidate (190 scenarios) against v1 baseline (20 scenarios)
      const comparison = asComparison(compareBaselines(baselineV5Path, baselineV1Path, { strict: true }));

      expect(comparison.passed).toBe(true);
      expect(comparison.hasRegressions).toBe(false);

      // Verify that delta calculations were done on common baseline scenarios
      const dHigh = asFullDelta(comparison.modelDeltas['deepseek/deepseek-v4-flash-0731:high']);
      expect(dHigh.totalScenarios.baseline).toBe(20);
      expect(dHigh.totalScenarios.candidate).toBe(190);
      expect(dHigh.status).toBe('PASS');
    });

    it('EDGE_4.3 — Missing Model in Candidate: Generates Breach Record and Violation', () => {
      const candidatePartial = JSON.parse(JSON.stringify(baselineData));
      // Delete Luna High from summary
      delete candidatePartial.summary['openrouter/5.6-luna-high'];

      const res = asComparison(compareBaselines(candidatePartial, baselineData, { strict: true }));
      
      const lunaDelta = res.modelDeltas['openrouter/5.6-luna-high'];
      expect(lunaDelta).toBeDefined();
      expect(lunaDelta.status).toBe('SKIPPED');
      expect(lunaDelta.violations.some((v: string) => v.includes('missing in candidate results'))).toBe(true);
      expect(res.breaches.some((b: any) => b.model === 'openrouter/5.6-luna-high' && b.rule === 'Model Missing')).toBe(true);
      expect(res.totalBreaches).toBe(1);
    });

    it('EDGE_4.4 — Unknown Model in Candidate: Marked SKIPPED Gracefully', () => {
      const candidateUnknown = JSON.parse(JSON.stringify(baselineData));
      candidateUnknown.models.push('custom/unlisted-prototype-model');
      candidateUnknown.summary['custom/unlisted-prototype-model'] = {
        model: 'custom/unlisted-prototype-model',
        totalScenarios: 10,
        verdictAccuracy: 100,
        recall: 1.0,
      };

      const res = asComparison(compareBaselines(candidateUnknown, baselineData, { strict: true }));
      const customDelta = asSkippedDelta(res.modelDeltas['custom/unlisted-prototype-model']);
      expect(customDelta).toBeDefined();
      expect(customDelta.status).toBe('SKIPPED');
      expect(customDelta.reason).toContain('Not present in baseline');
    });

    it('EDGE_4.5 — Malformed / Missing File Handling and Invalid Schemas', () => {
      // Non-existent file
      expect(() => loadBenchmarkMatrix('/path/to/nonexistent/matrix.json')).toThrow(/Baseline file not found/);

      // Invalid JSON file
      const malformedPath = path.join(tempDir, 'malformed.json');
      fs.writeFileSync(malformedPath, '{ "timestamp": "2026-08-20', 'utf8');
      expect(() => loadBenchmarkMatrix(malformedPath)).toThrow(/Failed to parse JSON matrix/);

      // Invalid schema (empty object)
      const emptySchemaPath = path.join(tempDir, 'empty.json');
      fs.writeFileSync(emptySchemaPath, '{}', 'utf8');
      expect(() => loadBenchmarkMatrix(emptySchemaPath)).toThrow(/Invalid benchmark matrix schema/);

      // Null or empty input
      expect(() => loadBenchmarkMatrix(null)).toThrow(/Benchmark matrix input is required/);
    });

    it('EDGE_4.6 — Mathematical Zero & Extreme Value Boundary Safety', () => {
      // Empty summaries
      const deltas = calculateDeltas({}, {});
      expect(deltas.recall.delta).toBe(0);
      expect(deltas.verdictAccuracy.delta).toBe(0);
      expect(Number.isFinite(deltas.normalizedAvgCostUSD.percentChange)).toBe(true);
      expect(Number.isFinite(deltas.avgTtftMs.percentChange)).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 5: CLI EXECUTION MODES & WORKFLOW INTEGRATION
  // =========================================================================
  describe('Suite 5: CLI Execution Modes & Workflow Integration', () => {
    const scriptPath = path.join(rootDir, 'scripts/compare-release-baselines.mjs');

    it('CLI_5.1 — Strict Mode: Exits 0 on Parity, Exits 1 on Regression', async () => {
      // 1. Parity run -> exitCode 0
      const passResult = (await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${baselineV5Path}`,
        '--strict',
      ])) as unknown as MainSuccessResult;
      expect(passResult.exitCode).toBe(0);
      expect(passResult.report.passed).toBe(true);

      // 2. Regression run with synthetic candidate -> exitCode 1
      const regressedPath = path.join(tempDir, 'cli-regressed-candidate.json');
      const v5Data = JSON.parse(fs.readFileSync(baselineV5Path, 'utf8'));
      v5Data.summary['google/gemini-3.7-flash:high'].recall = 0.85; // Regression
      fs.writeFileSync(regressedPath, JSON.stringify(v5Data, null, 2), 'utf8');

      const failResult = (await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${regressedPath}`,
        '--strict',
      ])) as unknown as MainSuccessResult;
      expect(failResult.exitCode).toBe(1);
      expect(failResult.report.passed).toBe(false);
      expect(failResult.report.hasRegressions).toBe(true);
    });

    it('CLI_5.2 — Warn-Only Mode: Logs Warnings and Exits 0 Despite Regressions', async () => {
      const regressedPath = path.join(tempDir, 'cli-regressed-candidate.json');
      const warnResult = (await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${regressedPath}`,
        '--warn-only',
      ])) as unknown as MainSuccessResult;
      expect(warnResult.exitCode).toBe(0);
      expect(warnResult.report.hasRegressions).toBe(true);
    });

    it('CLI_5.3 — Output File Generation: Markdown and JSON Formats', async () => {
      const mdOut = path.join(tempDir, 'output-report.md');
      const jsonOut = path.join(tempDir, 'output-report.json');

      // Markdown output
      await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${baselineV5Path}`,
        `--output=${mdOut}`,
        '--format=markdown',
      ]);
      expect(fs.existsSync(mdOut)).toBe(true);
      const md = fs.readFileSync(mdOut, 'utf8');
      expect(md).toContain('# 🚀 ct-review-bot Release Baseline Comparison');
      expect(md).toContain('ALL GATES PASSED');

      // JSON output
      await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${baselineV5Path}`,
        `--output=${jsonOut}`,
        '--format=json',
      ]);
      expect(fs.existsSync(jsonOut)).toBe(true);
      const jsonParsed = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
      expect(jsonParsed.passed).toBe(true);
      expect(jsonParsed.summaryDeltas.length).toBe(5);
    });

    it('CLI_5.4 — Custom Thresholds JSON File Loading', async () => {
      const customThreshPath = path.join(tempDir, 'custom-thresholds.json');
      fs.writeFileSync(
        customThreshPath,
        JSON.stringify({
          maxRecallDrop: 0.20,
          maxAccuracyDrop: 20.0,
        }),
        'utf8'
      );

      const regressedPath = path.join(tempDir, 'cli-regressed-candidate.json');
      // Candidate with 0.85 recall (drop 0.15, which is <= 0.20)
      const res = (await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${regressedPath}`,
        `--thresholds=${customThreshPath}`,
        '--strict',
      ])) as unknown as MainSuccessResult;
      expect(res.exitCode).toBe(0);
      expect(res.report.passed).toBe(true);
    });

    it('CLI_5.5 — Model, Category, and Scenario Filtering Flags', async () => {
      const res = (await main([
        'node',
        scriptPath,
        `--baseline=${baselineV5Path}`,
        `--candidate=${baselineV5Path}`,
        '--models=openrouter/5.6-luna-high,google/gemini-3.7-flash:high',
        '--category=security',
        '--strict',
      ])) as unknown as MainSuccessResult;

      expect(res.exitCode).toBe(0);
      expect(res.report.summaryDeltas).toHaveLength(2);
      expect(res.report.summaryDeltas.map((d: any) => d.model)).toContain('openrouter/5.6-luna-high');
      expect(res.report.summaryDeltas.map((d: any) => d.model)).toContain('google/gemini-3.7-flash:high');
    });

    it('CLI_5.6 — CLI Help Flag Output', async () => {
      const res = await main(['node', scriptPath, '--help']);
      expect(res.exitCode).toBe(0);
      expect(res.help).toBe(true);
    });
  });
});
