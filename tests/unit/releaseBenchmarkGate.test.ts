import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_MODELS,
  DEFAULT_V5_MODELS,
  normalizeModelIdentifier,
  areModelsEquivalent,
  parseCliArgs,
  loadBenchmarkMatrix,
  calculateDeltas,
  calculateScenarioDeltas,
  evaluateModelGate,
  evaluateQualityGate,
  compareBaselines,
  formatMarkdownReport,
  formatJsonReport,
  showHelp,
  main,
} from '../../scripts/compare-release-baselines.mjs';

describe('Release Regression Quality Gate (scripts/compare-release-baselines.mjs)', () => {
  const rootRepoDir = path.resolve(__dirname, '../..');
  const v1BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v1.json');
  const v2BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v2.json');
  const v3BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v3.json');
  const v4BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v4.json');
  const v5BaselinePath = path.join(rootRepoDir, 'eval-baselines/model-benchmark-matrix-v5.json');
  const tempDir = path.join(rootRepoDir, 'tests/fixtures/temp-benchmark-gate');

  beforeEach(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // In-memory mock helpers
  const createMockSummary = (overrides = {}) => ({
    model: 'deepseek/deepseek-v4-flash-0731:high',
    totalScenarios: 20,
    verdictMatches: 20,
    verdictAccuracy: 100,
    totalTp: 18,
    totalFp: 0,
    totalFn: 0,
    precision: 1.0,
    recall: 1.0,
    f1Score: 1.0,
    avgSnr: 0.9,
    avgSnrDb: 11.65,
    avgTtftMs: 105,
    totalPromptTokens: 13786,
    totalCompletionTokens: 1970,
    totalTokens: 15756,
    totalCostUSD: 0.0025,
    avgTurnDepth: 1.2,
    costEfficiency: 7200,
    ...overrides,
  });

  const createMockMatrix = (summaryOverrides = {}, detailedResults = []) => ({
    timestamp: '2026-08-20T17:15:13.875Z',
    version: 'v1',
    models: [
      'deepseek/deepseek-v4-flash-0731:high',
      'openrouter/5.6-luna-high',
      'qwen/qwen-3.8-27b:high',
      'google/gemini-3.7-flash:high',
    ],
    scenarios: ['sec-multi-tenant-isolation', 'sec-committed-secret'],
    summary: {
      'deepseek/deepseek-v4-flash-0731:high': createMockSummary(summaryOverrides['deepseek/deepseek-v4-flash-0731:high']),
      'openrouter/5.6-luna-high': createMockSummary({
        model: 'openrouter/5.6-luna-high',
        totalCostUSD: 0.0412,
        costEfficiency: 436.89,
        avgTtftMs: 135,
        ...summaryOverrides['openrouter/5.6-luna-high'],
      }),
      'qwen/qwen-3.8-27b:high': createMockSummary({
        model: 'qwen/qwen-3.8-27b:high',
        verdictMatches: 19,
        verdictAccuracy: 95,
        totalTp: 17,
        totalFn: 1,
        recall: 0.944,
        f1Score: 0.971,
        avgSnrDb: 10.65,
        avgTtftMs: 140,
        totalCostUSD: 0.0067,
        costEfficiency: 2537.31,
        ...summaryOverrides['qwen/qwen-3.8-27b:high'],
      }),
      'google/gemini-3.7-flash:high': createMockSummary({
        model: 'google/gemini-3.7-flash:high',
        totalCostUSD: 0.0032,
        costEfficiency: 5625,
        avgTtftMs: 115,
        ...summaryOverrides['google/gemini-3.7-flash:high'],
      }),
    },
    detailedResults,
  });

  // =========================================================================
  // SUITE 1: CLI ARGUMENT PARSING & THRESHOLD CONFIGURATION
  // =========================================================================
  describe('1. CLI Argument Parsing & Threshold Configuration (parseCliArgs)', () => {
    it('1.1 defaults to strict mode, markdown format, and canonical thresholds', () => {
      const options = parseCliArgs(['node', 'compare.mjs']);
      expect(options.strict).toBe(true);
      expect(options.warnOnly).toBe(false);
      expect(options.json).toBe(false);
      expect(options.format).toBe('markdown');
      expect(options.thresholds.maxRecallDrop).toBe(DEFAULT_THRESHOLDS.maxRecallDrop);
      expect(options.thresholds.maxAccuracyDrop).toBe(0.0);
      expect(options.thresholds.maxSnrDropDb).toBe(1.50);
      expect(options.thresholds.maxF1Drop).toBe(0.02);
      expect(options.thresholds.maxTtftIncreaseMs).toBe(50);
      expect(options.thresholds.maxCostIncreasePct).toBe(20.0);
      expect(options.thresholds.disallowNewFn).toBe(true);
      expect(options.thresholds.disallowNewFp).toBe(true);
    });

    it('1.2 parses --baseline and --candidate paths in equal and space notations', () => {
      const opt1 = parseCliArgs(['node', 'compare.mjs', '--baseline=base.json', '--candidate=cand.json']);
      expect(opt1.baseline).toBe('base.json');
      expect(opt1.candidate).toBe('cand.json');

      const opt2 = parseCliArgs(['node', 'compare.mjs', '--baseline', 'base2.json', '--candidate', 'cand2.json']);
      expect(opt2.baseline).toBe('base2.json');
      expect(opt2.candidate).toBe('cand2.json');
    });

    it('1.3 parses --json and --format=json/markdown flags and auto-infers from output extension', () => {
      const optJson = parseCliArgs(['node', 'compare.mjs', '--json']);
      expect(optJson.json).toBe(true);
      expect(optJson.format).toBe('json');

      const optFmt = parseCliArgs(['node', 'compare.mjs', '--format=markdown', '--output=diff.md']);
      expect(optFmt.format).toBe('markdown');
      expect(optFmt.output).toBe('diff.md');

      const optAutoJson = parseCliArgs(['node', 'compare.mjs', '--output=diff.json']);
      expect(optAutoJson.format).toBe('json');
    });

    it('1.4 parses model, category, and scenario filter lists', () => {
      const options = parseCliArgs([
        'node',
        'compare.mjs',
        '--models=deepseek/deepseek-v4-flash-0731:high,openrouter/5.6-luna-high',
        '--categories=security,architecture',
        '--scenarios=sec-multi-tenant-isolation,sec-sql-injection',
      ]);
      expect(options.models).toEqual([
        'deepseek/deepseek-v4-flash-0731:high',
        'openrouter/5.6-luna-high',
      ]);
      expect(options.categories).toEqual(['security', 'architecture']);
      expect(options.scenarios).toEqual(['sec-multi-tenant-isolation', 'sec-sql-injection']);
    });

    it('1.5 parses individual numerical threshold override flags', () => {
      const options = parseCliArgs([
        'node',
        'compare.mjs',
        '--max-recall-drop=0.05',
        '--max-accuracy-drop=2.5',
        '--max-snr-drop-db=2.0',
        '--max-f1-drop=0.04',
        '--max-ttft-increase-ms=100',
        '--max-ttft-increase-pct=0.35',
        '--max-cost-increase-pct=30.0',
      ]);
      expect(options.thresholds.maxRecallDrop).toBe(0.05);
      expect(options.thresholds.maxAccuracyDrop).toBe(2.5);
      expect(options.thresholds.maxSnrDropDb).toBe(2.0);
      expect(options.thresholds.maxF1Drop).toBe(0.04);
      expect(options.thresholds.maxTtftIncreaseMs).toBe(100);
      expect(options.thresholds.maxTtftIncreasePct).toBe(0.35);
      expect(options.thresholds.maxCostIncreasePct).toBe(30.0);
    });

    it('1.6 parses boolean enforcement flags (--disallow-new-fn, --disallow-new-fp, --strict, --warn-only)', () => {
      const opt1 = parseCliArgs(['node', 'compare.mjs', '--no-disallow-new-fn', '--no-disallow-new-fp', '--no-strict']);
      expect(opt1.thresholds.disallowNewFn).toBe(false);
      expect(opt1.thresholds.disallowNewFp).toBe(false);
      expect(opt1.strict).toBe(false);

      const opt2 = parseCliArgs(['node', 'compare.mjs', '--warn-only', '--verbose']);
      expect(opt2.warnOnly).toBe(true);
      expect(opt2.strict).toBe(false);
      expect(opt2.verbose).toBe(true);
    });

    it('1.7 loads external threshold overrides from JSON file (--thresholds=<path>)', () => {
      const customThresholdsPath = path.join(tempDir, 'custom-thresholds.json');
      fs.writeFileSync(
        customThresholdsPath,
        JSON.stringify({
          maxRecallDrop: 0.08,
          maxSnrDropDb: 3.5,
          maxCostIncreasePct: 50.0,
        }),
        'utf-8'
      );

      const options = parseCliArgs(['node', 'compare.mjs', `--thresholds=${customThresholdsPath}`]);
      expect(options.thresholds.maxRecallDrop).toBe(0.08);
      expect(options.thresholds.maxSnrDropDb).toBe(3.5);
      expect(options.thresholds.maxCostIncreasePct).toBe(50.0);
      expect(options.thresholds.maxF1Drop).toBe(DEFAULT_THRESHOLDS.maxF1Drop);
    });

    it('1.8 handles --help and -h flags', () => {
      expect(parseCliArgs(['node', 'compare.mjs', '--help']).help).toBe(true);
      expect(parseCliArgs(['node', 'compare.mjs', '-h']).help).toBe(true);
    });

    it('1.9 correctly normalizes and distinguishes deepseek low and high reasoning identifiers', () => {
      expect(normalizeModelIdentifier('deepseek/deepseek-v4-flash-0731:low')).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(normalizeModelIdentifier('deepseek-v4-flash-0731:low')).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(normalizeModelIdentifier('accounts/fireworks/models/deepseek-v4-flash-0731')).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(normalizeModelIdentifier('deepseek/deepseek-v4-flash-0731')).toBe('deepseek/deepseek-v4-flash-0731:high');
      expect(areModelsEquivalent('deepseek/deepseek-v4-flash-0731:low', 'deepseek-v4-flash-0731:low')).toBe(true);
      expect(areModelsEquivalent('deepseek/deepseek-v4-flash-0731:low', 'accounts/fireworks/models/deepseek-v4-flash-0731')).toBe(true);
      expect(areModelsEquivalent('deepseek/deepseek-v4-flash-0731:low', 'deepseek/deepseek-v4-flash-0731:high')).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 2: INGESTION & VALIDATION
  // =========================================================================
  describe('2. Baseline & Candidate Matrix Ingestion & Validation (loadBenchmarkMatrix)', () => {
    it('2.1 ingests valid baseline matrix JSON from relative and absolute paths', () => {
      const matrix1 = loadBenchmarkMatrix('eval-baselines/model-benchmark-matrix-v1.json');
      expect(matrix1.models).toContain('deepseek/deepseek-v4-flash-0731:high');
      expect(matrix1.summary).toBeDefined();

      const matrix2 = loadBenchmarkMatrix(v1BaselinePath);
      expect(matrix2.models.length).toBe(4);
    });

    it('2.2 accepts in-memory matrix object directly without file I/O', () => {
      const raw = createMockMatrix();
      const loaded = loadBenchmarkMatrix(raw);
      expect(loaded).toBe(raw);
    });

    it('2.3 throws descriptive error if file does not exist', () => {
      expect(() => loadBenchmarkMatrix('eval-baselines/non-existent-matrix.json')).toThrow(
        /Baseline file not found/
      );
    });

    it('2.4 throws descriptive error if file contains invalid JSON syntax', () => {
      const corruptFile = path.join(tempDir, 'corrupt.json');
      fs.writeFileSync(corruptFile, '{ invalid json: [', 'utf-8');
      expect(() => loadBenchmarkMatrix(corruptFile)).toThrow(/Failed to parse JSON matrix/);
    });

    it('2.5 validates required matrix schema fields (models, summary, detailedResults)', () => {
      expect(() => loadBenchmarkMatrix({ somethingElse: 123 })).toThrow(
        /Invalid benchmark matrix schema/
      );
    });

    it('2.6 throws descriptive error if input is null or undefined', () => {
      expect(() => loadBenchmarkMatrix(null)).toThrow(/Benchmark matrix input is required/);
    });

    it('2.7 ingests canonical v3 baseline matrix JSON with 94 scenarios and 376 detailed results', () => {
      expect(fs.existsSync(v3BaselinePath)).toBe(true);
      const v3 = loadBenchmarkMatrix(v3BaselinePath);
      expect(v3.version).toBe('v3');
      expect(v3.models).toEqual(DEFAULT_MODELS);
      expect(v3.scenarios.length).toBe(94);
      expect(v3.detailedResults.length).toBe(376);
      for (const model of DEFAULT_MODELS) {
        expect(v3.summary[model]).toBeDefined();
        expect(v3.summary[model].totalScenarios).toBe(94);
      }
    });

    it('2.8 ingests canonical v5 baseline matrix JSON with 190 scenarios, 5 models, and 950 detailed results', () => {
      expect(fs.existsSync(v5BaselinePath)).toBe(true);
      const v5 = loadBenchmarkMatrix(v5BaselinePath);
      expect(v5.version).toBe('v5');
      expect(v5.models).toEqual(DEFAULT_V5_MODELS);
      expect(v5.scenarios.length).toBe(190);
      expect(v5.detailedResults.length).toBe(950);
      for (const model of DEFAULT_V5_MODELS) {
        expect(v5.summary[model]).toBeDefined();
        expect(v5.summary[model].totalScenarios).toBe(190);
      }
      expect(v5.summary['deepseek/deepseek-v4-flash-0731:low'].verdictMatches).toBe(175);
      expect(v5.summary['deepseek/deepseek-v4-flash-0731:low'].totalTp).toBe(136);
      expect(v5.summary['deepseek/deepseek-v4-flash-0731:low'].totalFp).toBe(0);
      expect(v5.summary['deepseek/deepseek-v4-flash-0731:low'].totalFn).toBe(14);
    });
  });

  // =========================================================================
  // SUITE 3: MODEL RESOLUTION, NORMALIZATION & SCOPING
  // =========================================================================
  describe('3. Model Resolution, Normalization & Scoping', () => {
    it('3.1 matches models with exact identifiers', () => {
      const baseMatrix = createMockMatrix();
      const candMatrix = createMockMatrix();
      const report = compareBaselines(candMatrix, baseMatrix);
      expect(report.summaryDeltas.length).toBe(4);
      expect(report.summaryDeltas.map((d: any) => d.model)).toContain('qwen/qwen-3.8-27b:high');
    });

    it('3.2 normalizes model aliases (e.g. openrouter/5.6-luna-high vs openai/gpt-5.6-luna)', () => {
      expect(normalizeModelIdentifier('openai/gpt-5.6-luna')).toBe('openrouter/5.6-luna-high');
      expect(normalizeModelIdentifier('5.6-luna-high')).toBe('openrouter/5.6-luna-high');
      expect(normalizeModelIdentifier('deepseek/deepseek-v4-flash-0731')).toBe('deepseek/deepseek-v4-flash-0731:high');
      expect(areModelsEquivalent('openai/gpt-5.6-luna', 'openrouter/5.6-luna-high')).toBe(true);

      const base = createMockMatrix();
      const cand = createMockMatrix();
      // Replace candidate's summary key with alias
      cand.summary['openai/gpt-5.6-luna'] = { ...cand.summary['openrouter/5.6-luna-high'], model: 'openai/gpt-5.6-luna' };
      delete cand.summary['openrouter/5.6-luna-high'];

      const report = compareBaselines(cand, base);
      const luna = report.summaryDeltas.find((d: any) => areModelsEquivalent(d.model, 'openrouter/5.6-luna-high'));
      expect(luna).toBeDefined();
      expect(luna.status).toBe('PASS');
    });

    it('3.3 handles candidate model missing in baseline (marked SKIPPED with 0 violations)', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix();
      cand.summary['experimental/new-model'] = createMockSummary({ model: 'experimental/new-model' });
      cand.models.push('experimental/new-model');

      const report = compareBaselines(cand, base);
      const exp = report.summaryDeltas.find((d: any) => d.model === 'experimental/new-model');
      expect(exp).toBeDefined();
      expect(exp.status).toBe('SKIPPED');
      expect(exp.reason).toContain('Not present in baseline');
      expect(exp.violations.length).toBe(0);
    });

    it('3.4 handles baseline model missing in candidate (marked SKIPPED with missing violation)', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix();
      delete cand.summary['google/gemini-3.7-flash:high'];

      const report = compareBaselines(cand, base, { models: DEFAULT_MODELS });
      const gemini = report.summaryDeltas.find((d: any) => d.model === 'google/gemini-3.7-flash:high');
      expect(gemini).toBeDefined();
      expect(gemini.status).toBe('SKIPPED');
      expect(gemini.violations.some((v: string) => v.includes('missing in candidate'))).toBe(true);
    });

    it('3.5 scopes comparison to subset specified by --models filter', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix();
      const report = compareBaselines(cand, base, {
        models: ['deepseek/deepseek-v4-flash-0731:high'],
      });
      expect(report.summaryDeltas.length).toBe(1);
      expect(report.summaryDeltas[0].model).toBe('deepseek/deepseek-v4-flash-0731:high');
    });
  });

  // =========================================================================
  // SUITE 4: MATHEMATICAL QUALITY GATE RULES & REGRESSION DETECTION
  // =========================================================================
  describe('4. Mathematical Quality Gate Rules & Regression Detection (evaluateModelGate)', () => {
    it('4.1 Parity Baseline: Identical metrics result in clean PASS with 0 violations', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix();
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(true);
      expect(report.hasRegressions).toBe(false);
      expect(report.totalBreaches).toBe(0);
      for (const d of report.summaryDeltas) {
        expect(d.status).toBe('PASS');
        expect(d.violations.length).toBe(0);
      }
    });

    it('4.2 Candidate Improvement: Higher metrics result in clean PASS with positive deltas', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix({
        'qwen/qwen-3.8-27b:high': {
          recall: 0.98,
          verdictAccuracy: 98.4,
          avgSnrDb: 11.7,
          f1Score: 0.99,
          avgTtftMs: 130, // faster
        },
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(true);
      const qwen = report.summaryDeltas.find((d: any) => d.model === 'qwen/qwen-3.8-27b:high');
      expect(qwen.status).toBe('PASS');
      expect(qwen.recall.delta).toBeGreaterThan(0);
      expect(qwen.verdictAccuracy.delta).toBeGreaterThan(0);
      expect(qwen.avgSnrDb.delta).toBeGreaterThan(0);
    });

    it('4.3 Gate 1: Drops in Recall exceeding threshold trigger REGRESSION', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { recall: 0.95 }, // -0.050 drop
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      expect(report.hasRegressions).toBe(true);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('REGRESSION');
      expect(ds.violations.some((v: string) => v.includes('Recall drop'))).toBe(true);
    });

    it('4.4 Gate 1 Override: Recall drop within relaxed threshold passes cleanly', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { recall: 0.96 }, // -0.040 drop
      });
      const report = compareBaselines(cand, base, { maxRecallDrop: 0.05 });

      expect(report.passed).toBe(true);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('PASS');
    });

    it('4.5 Gate 2: Drops in Verdict Accuracy exceeding threshold trigger REGRESSION', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix({
        'openrouter/5.6-luna-high': { verdictAccuracy: 95.0 }, // -5.0% drop
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      const luna = report.summaryDeltas.find((d: any) => d.model === 'openrouter/5.6-luna-high');
      expect(luna.status).toBe('REGRESSION');
      expect(luna.violations.some((v: string) => v.includes('Accuracy drop'))).toBe(true);
    });

    it('4.6 Gate 3: SNR degradation exceeding max-snr-drop-db (1.50 dB) triggers REGRESSION', () => {
      const base = createMockMatrix({
        'google/gemini-3.7-flash:high': { avgSnrDb: 12.0 },
      });
      const cand = createMockMatrix({
        'google/gemini-3.7-flash:high': { avgSnrDb: 10.4 }, // -1.6 dB drop (> 1.5 dB)
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      const gemini = report.summaryDeltas.find((d: any) => d.model === 'google/gemini-3.7-flash:high');
      expect(gemini.status).toBe('REGRESSION');
      expect(gemini.violations.some((v: string) => v.includes('SNR degradation'))).toBe(true);
    });

    it('4.7 Gate 4: Drops in F1 score exceeding max-f1-drop (0.02) trigger REGRESSION', () => {
      const base = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { f1Score: 1.0 },
      });
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { f1Score: 0.97 }, // -0.030 drop
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('REGRESSION');
      expect(ds.violations.some((v: string) => v.includes('F1 drop'))).toBe(true);
    });

    it('4.8 Gate 5: TTFT surge exceeding both absolute (>50ms) and relative (>25%) thresholds triggers REGRESSION', () => {
      const base = createMockMatrix({
        'qwen/qwen-3.8-27b:high': { avgTtftMs: 100 },
      });
      const cand = createMockMatrix({
        'qwen/qwen-3.8-27b:high': { avgTtftMs: 160 }, // +60ms (+60%)
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      const qwen = report.summaryDeltas.find((d: any) => d.model === 'qwen/qwen-3.8-27b:high');
      expect(qwen.status).toBe('REGRESSION');
      expect(qwen.violations.some((v: string) => v.includes('TTFT latency spike'))).toBe(true);
    });

    it('4.9 Gate 5 Latency Guard: TTFT increase above 50ms but <= 25% passes without violation', () => {
      const base = createMockMatrix({
        'qwen/qwen-3.8-27b:high': { avgTtftMs: 400 },
      });
      const cand = createMockMatrix({
        'qwen/qwen-3.8-27b:high': { avgTtftMs: 460 }, // +60ms (+15% <= 25%)
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(true);
      const qwen = report.summaryDeltas.find((d: any) => d.model === 'qwen/qwen-3.8-27b:high');
      expect(qwen.status).toBe('PASS');
    });

    it('4.10 Gate 6: Cost inflation > 20% without recall improvement triggers REGRESSION', () => {
      const base = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalCostUSD: 0.0020, recall: 1.0 },
      });
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalCostUSD: 0.0030, recall: 1.0 }, // +50% cost, 0 recall delta
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('REGRESSION');
      expect(ds.violations.some((v: string) => v.includes('Cost inflation without recall gain'))).toBe(true);
    });

    it('4.11 Gate 6 Justified Cost: Cost inflation > 20% with positive recall gain passes cleanly', () => {
      const base = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalCostUSD: 0.0020, recall: 0.85 },
      });
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalCostUSD: 0.0030, recall: 0.95 }, // +50% cost, +0.10 recall
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(true);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('PASS');
    });

    it('4.12 Gate 7: Defect loss (new False Negatives) triggers REGRESSION', () => {
      const base = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalFn: 0 },
      });
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalFn: 1 },
      });
      const report = compareBaselines(cand, base, { disallowNewFn: true });

      expect(report.passed).toBe(false);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('REGRESSION');
      expect(ds.violations.some((v: string) => v.includes('New false negatives'))).toBe(true);
    });

    it('4.13 Gate 8: New False Positives trigger REGRESSION when disallowNewFp is enabled', () => {
      const base = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalFp: 0 },
      });
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { totalFp: 2 },
      });
      const report = compareBaselines(cand, base, { disallowNewFp: true });

      expect(report.passed).toBe(false);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('REGRESSION');
      expect(ds.violations.some((v: string) => v.includes('New false positives'))).toBe(true);
    });

    it('4.14 Compound Violations: Captures and reports multiple simultaneous gate breaches', () => {
      const base = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { recall: 1.0, verdictAccuracy: 100, avgSnrDb: 12.0 },
      });
      const cand = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { recall: 0.90, verdictAccuracy: 90, avgSnrDb: 9.0 },
      });
      const report = compareBaselines(cand, base);

      expect(report.passed).toBe(false);
      const ds = report.summaryDeltas.find((d: any) => d.model === 'deepseek/deepseek-v4-flash-0731:high');
      expect(ds.status).toBe('REGRESSION');
      expect(ds.violations.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // SUITE 5: PER-SCENARIO DETAILED REGRESSION ANALYSIS
  // =========================================================================
  describe('5. Per-Scenario Detailed Regression Analysis (calculateScenarioDeltas)', () => {
    it('5.1 identifies specific scenario verdict flips (BLOCK -> SHIP as REGRESSED)', () => {
      const baseDetails = [
        {
          scenarioId: 'sec-multi-tenant-isolation',
          category: 'security',
          model: 'deepseek/deepseek-v4-flash-0731:high',
          verdict: 'BLOCK',
          expectedVerdict: 'BLOCK',
          verdictMatch: true,
          tp: 1,
          fp: 0,
          fn: 0,
          snrDb: 10.0,
        },
      ];
      const candDetails = [
        {
          scenarioId: 'sec-multi-tenant-isolation',
          category: 'security',
          model: 'deepseek/deepseek-v4-flash-0731:high',
          verdict: 'SHIP',
          expectedVerdict: 'BLOCK',
          verdictMatch: false,
          tp: 0,
          fp: 0,
          fn: 1,
          snrDb: -10.0,
        },
      ];

      const deltas = calculateScenarioDeltas(candDetails, baseDetails);
      expect(deltas.length).toBe(1);
      expect(deltas[0].verdictMatchDelta).toBe('REGRESSED');
      expect(deltas[0].isRegression).toBe(true);
      expect(deltas[0].fnDelta).toBe(1);
    });

    it('5.2 detects missed finding regressions on a specific scenario', () => {
      const baseDetails = [
        {
          scenarioId: 'perf-n-plus-one-query',
          category: 'performance',
          model: 'qwen/qwen-3.8-27b:high',
          verdict: 'FIX_FIRST',
          expectedVerdict: 'FIX_FIRST',
          verdictMatch: true,
          tp: 2,
          fp: 0,
          fn: 0,
          snrDb: 13.01,
        },
      ];
      const candDetails = [
        {
          scenarioId: 'perf-n-plus-one-query',
          category: 'performance',
          model: 'qwen/qwen-3.8-27b:high',
          verdict: 'FIX_FIRST',
          expectedVerdict: 'FIX_FIRST',
          verdictMatch: true,
          tp: 1,
          fp: 0,
          fn: 1, // Missed 1 finding
          snrDb: 10.0,
        },
      ];

      const deltas = calculateScenarioDeltas(candDetails, baseDetails, {
        thresholds: { disallowNewFn: true },
      });
      expect(deltas[0].newFn).toBe(1);
      expect(deltas[0].isRegression).toBe(true);
      expect(deltas[0].violations.some((v: string) => v.includes('New false negatives'))).toBe(true);
    });

    it('5.3 correctly handles scenario expansions (new scenarios in candidate marked NEW_SCENARIO)', () => {
      const baseDetails = [
        {
          scenarioId: 'sec-multi-tenant-isolation',
          category: 'security',
          model: 'deepseek/deepseek-v4-flash-0731:high',
          verdict: 'BLOCK',
          expectedVerdict: 'BLOCK',
          verdictMatch: true,
          tp: 1,
          fp: 0,
          fn: 0,
        },
      ];
      const candDetails = [
        {
          scenarioId: 'sec-multi-tenant-isolation',
          category: 'security',
          model: 'deepseek/deepseek-v4-flash-0731:high',
          verdict: 'BLOCK',
          expectedVerdict: 'BLOCK',
          verdictMatch: true,
          tp: 1,
          fp: 0,
          fn: 0,
        },
        {
          scenarioId: 'elixir-ecto-unscoped-tenant-query',
          category: 'security',
          model: 'deepseek/deepseek-v4-flash-0731:high',
          verdict: 'BLOCK',
          expectedVerdict: 'BLOCK',
          verdictMatch: true,
          tp: 1,
          fp: 0,
          fn: 0,
        },
      ];

      const deltas = calculateScenarioDeltas(candDetails, baseDetails);
      expect(deltas.length).toBe(2);
      expect(deltas[0].verdictMatchDelta).toBe('MAINTAINED');
      expect(deltas[1].verdictMatchDelta).toBe('NEW_SCENARIO');
      expect(deltas[1].isRegression).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 6: REPORT FORMATTING
  // =========================================================================
  describe('6. Report Formatting (formatMarkdownReport & formatJsonReport)', () => {
    it('6.1 formats Markdown report with executive summary table, badges, and delta columns', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix();
      const comparison = compareBaselines(cand, base);
      const md = formatMarkdownReport(comparison);

      expect(md).toContain('# 🚀 ct-review-bot Release Baseline Comparison & Regression Gate');
      expect(md).toContain('**Gate Verdict**: ✅ **ALL GATES PASSED (0 Breaches)**');
      expect(md).toContain('## 🚦 1. Model Quality Gate Summary');
      expect(md).toContain('## 📊 2. Comparative Performance Matrix');
      expect(md).toContain('## ⚙️ 4. Active Quality Gate Thresholds');
    });

    it('6.2 formats signed delta metrics (+0.000, -0.050, +1.5 dB, +$0.0015)', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix({
        'qwen/qwen-3.8-27b:high': {
          recall: 0.98,
          verdictAccuracy: 98.4,
          avgSnrDb: 11.66,
        },
      });
      const comparison = compareBaselines(cand, base);
      const md = formatMarkdownReport(comparison);

      expect(md).toContain('+0.036'); // delta recall
      expect(md).toContain('+3.4%');  // delta acc
      expect(md).toContain('+1.01 dB'); // delta snr
    });

    it('6.3 formats scenario regression table when regressions occur', () => {
      const base = createMockMatrix(
        {},
        [
          {
            scenarioId: 'sec-multi-tenant-isolation',
            category: 'security',
            model: 'deepseek/deepseek-v4-flash-0731:high',
            verdict: 'BLOCK',
            expectedVerdict: 'BLOCK',
            verdictMatch: true,
            tp: 1,
            fp: 0,
            fn: 0,
            snrDb: 10.0,
          },
        ]
      );
      const cand = createMockMatrix(
        { 'deepseek/deepseek-v4-flash-0731:high': { recall: 0.90 } },
        [
          {
            scenarioId: 'sec-multi-tenant-isolation',
            category: 'security',
            model: 'deepseek/deepseek-v4-flash-0731:high',
            verdict: 'SHIP',
            expectedVerdict: 'BLOCK',
            verdictMatch: false,
            tp: 0,
            fp: 0,
            fn: 1,
            snrDb: -10.0,
          },
        ]
      );
      const comparison = compareBaselines(cand, base);
      const md = formatMarkdownReport(comparison);

      expect(md).toContain('## 🔍 3. Scenario Regressions & Defect Deltas');
      expect(md).toContain('`sec-multi-tenant-isolation`');
    });

    it('6.4 formats JSON report containing full structured schema and comparison metadata', () => {
      const base = createMockMatrix();
      const cand = createMockMatrix();
      const comparison = compareBaselines(cand, base);
      const jsonStr = formatJsonReport(comparison);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.passed).toBe(true);
      expect(parsed.hasRegressions).toBe(false);
      expect(parsed.thresholds).toBeDefined();
      expect(parsed.summaryDeltas.length).toBe(4);
      expect(parsed.modelDeltas).toBeDefined();
    });

    it('6.5 showHelp logs command reference without errors', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      showHelp();
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toContain('compare-release-baselines.mjs');
      spy.mockRestore();
    });
  });

  // =========================================================================
  // SUITE 7: CLI ORCHESTRATION & REAL BASELINE INTEGRATION
  // =========================================================================
  describe('7. CLI Orchestration & Real Baseline Verification (main)', () => {
    it('7.1 verifies canonical v1 baseline against itself passes 100% with exit code 0', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v1BaselinePath}`,
        `--candidate=${v1BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
    });

    it('7.2 verifies canonical v2 benchmark matrix against v1 baseline passes cleanly', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v1BaselinePath}`,
        `--candidate=${v2BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
    });

    it('7.3 exits with code 1 in --strict mode when regression is detected', async () => {
      const regressedCandPath = path.join(tempDir, 'regressed-cand.json');
      const regressedMatrix = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { recall: 0.90 },
      });
      fs.writeFileSync(regressedCandPath, JSON.stringify(regressedMatrix), 'utf-8');

      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v1BaselinePath}`,
        `--candidate=${regressedCandPath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.comparison.hasRegressions).toBe(true);
    });

    it('7.4 exits with code 0 in --warn-only mode even when regressions are present', async () => {
      const regressedCandPath = path.join(tempDir, 'regressed-cand-warn.json');
      const regressedMatrix = createMockMatrix({
        'deepseek/deepseek-v4-flash-0731:high': { recall: 0.90 },
      });
      fs.writeFileSync(regressedCandPath, JSON.stringify(regressedMatrix), 'utf-8');

      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v1BaselinePath}`,
        `--candidate=${regressedCandPath}`,
        '--warn-only',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.hasRegressions).toBe(true);
    });

    it('7.5 writes formatted output to file when --output=<path> is specified', async () => {
      const outReportPath = path.join(tempDir, 'output-diff.md');
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v1BaselinePath}`,
        `--candidate=${v1BaselinePath}`,
        `--output=${outReportPath}`,
      ]);
      expect(res.exitCode).toBe(0);
      expect(fs.existsSync(outReportPath)).toBe(true);
      const content = fs.readFileSync(outReportPath, 'utf-8');
      expect(content).toContain('# 🚀 ct-review-bot Release Baseline Comparison');
    });

    it('7.6 returns error exit code 1 when required candidate argument is missing', async () => {
      const res = await main(['node', 'compare.mjs']);
      expect(res.exitCode).toBe(1);
      expect(res.error).toContain('Missing candidate');
    });

    it('7.7 returns error exit code 2 when baseline or candidate file is not found', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        '--baseline=non-existent-base.json',
        '--candidate=non-existent-cand.json',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.error).toBeDefined();
    });

    it('7.8 handles --help flag cleanly returning exitCode 0', async () => {
      const res = await main(['node', 'compare.mjs', '--help']);
      expect(res.exitCode).toBe(0);
      expect(res.help).toBe(true);
    });

    it('7.9 verifies canonical v3 benchmark matrix (94 scenarios) against v2 baseline (62 scenarios) passes cleanly with 0 breaches', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v2BaselinePath}`,
        `--candidate=${v3BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
      expect(res.comparison.totalBreaches).toBe(0);
      for (const d of res.comparison.summaryDeltas) {
        expect(d.status).toBe('PASS');
        expect(d.violations.length).toBe(0);
      }
    });

    it('7.10 verifies canonical v3 benchmark matrix against itself passes 100% with exit code 0 and 0 breaches', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v3BaselinePath}`,
        `--candidate=${v3BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
      expect(res.comparison.totalBreaches).toBe(0);
    });

    it('7.11 verifies canonical v3 benchmark matrix against v1 baseline passes cleanly', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v1BaselinePath}`,
        `--candidate=${v3BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
    });

    it('7.12 verifies canonical Baseline v5 matrix against Baseline v4 matrix passes cleanly with 0 breaches and deepseek low skipped', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v4BaselinePath}`,
        `--candidate=${v5BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
      expect(res.comparison.totalBreaches).toBe(0);
      expect(res.comparison.modelDeltas['deepseek/deepseek-v4-flash-0731:low'].status).toBe('SKIPPED');
      for (const model of ['deepseek/deepseek-v4-flash-0731:high', 'openrouter/5.6-luna-high', 'qwen/qwen-3.8-27b:high', 'google/gemini-3.7-flash:high']) {
        expect(res.comparison.modelDeltas[model].status).toBe('PASS');
        expect(res.comparison.modelDeltas[model].violations.length).toBe(0);
      }
    });

    it('7.13 verifies canonical Baseline v5 matrix against itself passes 100% with exit code 0 and 0 breaches across all 5 models', async () => {
      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v5BaselinePath}`,
        `--candidate=${v5BaselinePath}`,
        '--strict',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.comparison.passed).toBe(true);
      expect(res.comparison.hasRegressions).toBe(false);
      expect(res.comparison.totalBreaches).toBe(0);
      for (const d of res.comparison.summaryDeltas) {
        expect(d.status).toBe('PASS');
        expect(d.violations.length).toBe(0);
      }
    });

    it('7.14 verifies candidate evaluation with Baseline v5 candidate outputs clean Markdown and JSON reports', async () => {
      const mdOut = path.join(tempDir, 'v5-comparison-report.md');
      const jsonOut = path.join(tempDir, 'v5-comparison-report.json');

      const res = await main([
        'node',
        'compare.mjs',
        `--baseline=${v5BaselinePath}`,
        `--candidate=${v5BaselinePath}`,
        `--output=${mdOut}`,
        '--strict',
      ]);

      expect(res.exitCode).toBe(0);
      expect(fs.existsSync(mdOut)).toBe(true);
      const md = fs.readFileSync(mdOut, 'utf-8');
      expect(md).toContain('ALL GATES PASSED (0 Breaches)');
      expect(md).toContain('deepseek/deepseek-v4-flash-0731:low');
    });
  });

  // =========================================================================
  // SUITE 8: ZERO OMITTED FILES & 100% COVERAGE QUALITY GATES
  // =========================================================================
  describe('8. Zero Omitted Files & 100% Review Coverage Quality Gates', () => {
    it('8.1 flags regression breach when candidate model contains omitted files', () => {
      const base = createMockSummary({ totalScenarios: 10 });
      const cand = createMockSummary({
        totalScenarios: 10,
        totalOmittedFiles: 2,
        coveragePct: 80.0,
      });

      const deltas = calculateDeltas(cand, base);
      expect(deltas.omittedFiles.candidate).toBe(2);
      expect(deltas.coveragePct.candidate).toBe(80.0);

      const gate = evaluateModelGate(deltas, { ...DEFAULT_THRESHOLDS, disallowOmittedFiles: true, maxOmittedFilesAllowed: 0 });
      expect(gate.passed).toBe(false);
      expect(gate.status).toBe('REGRESSION');
      expect(gate.violations.some((v) => v.includes('Omitted files detected: 2'))).toBe(true);
      expect(gate.violations.some((v) => v.includes('Coverage drop below required minimum: 80.0%'))).toBe(true);
    });

    it('8.2 passes cleanly when candidate achieves 100% coverage and 0 omitted files', () => {
      const base = createMockSummary({ totalScenarios: 10, totalOmittedFiles: 0, coveragePct: 100.0 });
      const cand = createMockSummary({ totalScenarios: 10, totalOmittedFiles: 0, coveragePct: 100.0 });

      const deltas = calculateDeltas(cand, base);
      expect(deltas.omittedFiles.candidate).toBe(0);
      expect(deltas.coveragePct.candidate).toBe(100.0);

      const gate = evaluateModelGate(deltas, DEFAULT_THRESHOLDS);
      expect(gate.passed).toBe(true);
      expect(gate.status).toBe('PASS');
      expect(gate.violations.length).toBe(0);
    });

    it('8.3 respects custom --max-omitted-files and --min-coverage-pct CLI overrides', () => {
      const base = createMockSummary({ totalScenarios: 10 });
      const cand = createMockSummary({
        totalScenarios: 10,
        totalOmittedFiles: 1,
        coveragePct: 95.0,
      });

      const deltas = calculateDeltas(cand, base);

      // Default thresholds fail on 1 omitted file / 95% coverage
      const strictGate = evaluateModelGate(deltas, DEFAULT_THRESHOLDS);
      expect(strictGate.passed).toBe(false);

      // Relaxed thresholds pass
      const relaxedGate = evaluateModelGate(deltas, {
        ...DEFAULT_THRESHOLDS,
        maxOmittedFilesAllowed: 2,
        minCoveragePct: 90.0,
      });
      expect(relaxedGate.passed).toBe(true);
    });

    it('8.4 parses --max-omitted-files, --min-coverage-pct, and --disallow-omitted-files in parseCliArgs', () => {
      const options = parseCliArgs([
        'node',
        'compare.mjs',
        '--max-omitted-files=3',
        '--min-coverage-pct=92.5',
        '--no-disallow-omitted-files',
      ]);
      expect(options.thresholds.maxOmittedFilesAllowed).toBe(3);
      expect(options.thresholds.minCoveragePct).toBe(92.5);
      expect(options.thresholds.disallowOmittedFiles).toBe(false);
    });
  });
});

