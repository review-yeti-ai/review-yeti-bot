#!/usr/bin/env node

/**
 * Release Baseline Comparison & Automated Regression Gate
 * scripts/compare-release-baselines.mjs
 *
 * Compares candidate benchmark matrix JSON against historical release baselines (e.g. v1, v2)
 * in eval-baselines/, evaluates zero-tolerance & thresholded mathematical quality gates across
 * 6 core dimensions, and outputs formatted Markdown / JSON diff reports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_THRESHOLDS = {
  maxRecallDrop: 0.00,        // Zero-tolerance on recall drop (> 0.00 => FAIL)
  maxAccuracyDrop: 0.0,       // Zero-tolerance on accuracy drop (> 0.0% => FAIL)
  maxSnrDropDb: 1.50,         // SNR degradation > 1.50 dB => FAIL
  maxF1Drop: 0.02,            // F1 score drop > 0.02 => FAIL
  maxTtftIncreaseMs: 50,      // TTFT increase > 50ms AND > 25% => FAIL
  maxTtftIncreasePct: 0.25,   // 25% relative surge
  maxCostIncreasePct: 20.0,   // Cost surge > 20% without recall gain => FAIL
  disallowNewFn: true,        // Any new false negatives on common baseline => FAIL
  disallowNewFp: true,        // Any new false positives on common baseline => FAIL
  maxOmittedFilesAllowed: 0,  // Zero-tolerance on omitted/dropped files (> 0 => FAIL)
  minCoveragePct: 100.0,      // Minimum 100% file coverage (< 100.0% => FAIL)
  disallowOmittedFiles: true, // Disallow any dropped files across all partitions
  strict: true,               // Exit 1 on regression in CLI
  warnOnly: false,            // Exit 0 on regression (alias for --no-strict)
  verbose: false,
};

export const DEFAULT_MODELS = [
  'deepseek/deepseek-v4-flash-0731:high',
  'openrouter/5.6-luna-high',
  'qwen/qwen-3.8-27b:high',
  'google/gemini-3.7-flash:high',
];

export const DEFAULT_V5_MODELS = [
  'deepseek/deepseek-v4-flash-0731:low',
  'deepseek/deepseek-v4-flash-0731:high',
  'openrouter/5.6-luna-high',
  'qwen/qwen-3.8-27b:high',
  'google/gemini-3.7-flash:high',
];

/**
 * Normalizes model identifiers and handles legacy/router aliases.
 */
export function normalizeModelIdentifier(model) {
  if (!model || typeof model !== 'string') return '';
  const trimmed = model.trim();
  const aliases = {
    'openai/gpt-5.6-luna': 'openrouter/5.6-luna-high',
    'openrouter/openai/gpt-5.6-luna': 'openrouter/5.6-luna-high',
    '5.6-luna-high': 'openrouter/5.6-luna-high',
    'deepseek/deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731:high',
    'deepseek-v4-flash-0731:high': 'deepseek/deepseek-v4-flash-0731:high',
    'deepseek/deepseek-v4-flash-0731:low': 'deepseek/deepseek-v4-flash-0731:low',
    'deepseek-v4-flash-0731:low': 'deepseek/deepseek-v4-flash-0731:low',
    'deepseek-v4-flash:low': 'deepseek/deepseek-v4-flash-0731:low',
    'accounts/fireworks/models/deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731:low',
    'qwen/qwen3.8-27b:high': 'qwen/qwen-3.8-27b:high',
    'qwen/qwen-3.8-27b': 'qwen/qwen-3.8-27b:high',
    'google/gemini-3.7-flash': 'google/gemini-3.7-flash:high',
    'gemini-3.7-flash:high': 'google/gemini-3.7-flash:high',
  };
  if (aliases[trimmed]) return aliases[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [k, v] of Object.entries(aliases)) {
    if (lower === k.toLowerCase()) return v;
  }
  return trimmed;
}

/**
 * Checks if two model identifier strings refer to the same underlying model.
 */
export function areModelsEquivalent(m1, m2) {
  if (!m1 || !m2) return false;
  if (m1 === m2) return true;
  const n1 = normalizeModelIdentifier(m1);
  const n2 = normalizeModelIdentifier(m2);
  if (n1 === n2) return true;

  const baseName = (m) => {
    const norm = normalizeModelIdentifier(m);
    if (norm.endsWith(':low')) return norm;
    return norm
      .replace(/^(openrouter\/|openai\/|google\/|deepseek\/|qwen\/|accounts\/fireworks\/models\/)/, '')
      .replace(/:high$/, '')
      .toLowerCase();
  };

  return baseName(m1) === baseName(m2);
}

/**
 * Parses raw CLI arguments into typed options dictionary with default thresholds.
 */
export function parseCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const thresholds = { ...DEFAULT_THRESHOLDS };

  const options = {
    baseline: 'eval-baselines/model-benchmark-matrix-v1.json',
    candidate: null,
    output: null,
    format: 'markdown',
    json: false,
    models: null,
    categories: null,
    scenarios: null,
    thresholdsPath: null,
    thresholds,
    strict: true,
    warnOnly: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--baseline=')) {
      options.baseline = arg.slice('--baseline='.length);
    } else if (arg === '--baseline' && i + 1 < args.length) {
      options.baseline = args[++i];
    } else if (arg.startsWith('--candidate=')) {
      options.candidate = arg.slice('--candidate='.length);
    } else if (arg === '--candidate' && i + 1 < args.length) {
      options.candidate = args[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    } else if (arg === '--output' && i + 1 < args.length) {
      options.output = args[++i];
    } else if (arg.startsWith('--format=')) {
      options.format = arg.slice('--format='.length).toLowerCase();
    } else if (arg === '--format' && i + 1 < args.length) {
      options.format = args[++i].toLowerCase();
    } else if (arg === '--json') {
      options.json = true;
      options.format = 'json';
    } else if (arg.startsWith('--models=')) {
      options.models = arg.slice('--models='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--models' && i + 1 < args.length) {
      options.models = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--categories=') || arg.startsWith('--category=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : '';
      options.categories = val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if ((arg === '--categories' || arg === '--category') && i + 1 < args.length) {
      options.categories = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--scenarios=') || arg.startsWith('--scenario=')) {
      const val = arg.includes('=') ? arg.split('=')[1] : '';
      options.scenarios = val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if ((arg === '--scenarios' || arg === '--scenario') && i + 1 < args.length) {
      options.scenarios = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--thresholds=')) {
      options.thresholdsPath = arg.slice('--thresholds='.length);
    } else if (arg === '--thresholds' && i + 1 < args.length) {
      options.thresholdsPath = args[++i];
    } else if (arg.startsWith('--max-recall-drop=')) {
      options.thresholds.maxRecallDrop = Number(arg.slice('--max-recall-drop='.length));
    } else if (arg === '--max-recall-drop' && i + 1 < args.length) {
      options.thresholds.maxRecallDrop = Number(args[++i]);
    } else if (arg.startsWith('--max-accuracy-drop=')) {
      options.thresholds.maxAccuracyDrop = Number(arg.slice('--max-accuracy-drop='.length));
    } else if (arg === '--max-accuracy-drop' && i + 1 < args.length) {
      options.thresholds.maxAccuracyDrop = Number(args[++i]);
    } else if (arg.startsWith('--max-snr-drop-db=')) {
      options.thresholds.maxSnrDropDb = Number(arg.slice('--max-snr-drop-db='.length));
    } else if (arg === '--max-snr-drop-db' && i + 1 < args.length) {
      options.thresholds.maxSnrDropDb = Number(args[++i]);
    } else if (arg.startsWith('--max-f1-drop=')) {
      options.thresholds.maxF1Drop = Number(arg.slice('--max-f1-drop='.length));
    } else if (arg === '--max-f1-drop' && i + 1 < args.length) {
      options.thresholds.maxF1Drop = Number(args[++i]);
    } else if (arg.startsWith('--max-ttft-increase-ms=') || arg.startsWith('--max-ttft-spike-ms=')) {
      const val = arg.split('=')[1];
      options.thresholds.maxTtftIncreaseMs = Number(val);
    } else if ((arg === '--max-ttft-increase-ms' || arg === '--max-ttft-spike-ms') && i + 1 < args.length) {
      options.thresholds.maxTtftIncreaseMs = Number(args[++i]);
    } else if (arg.startsWith('--max-ttft-increase-pct=') || arg.startsWith('--max-ttft-spike-pct=')) {
      const val = arg.split('=')[1];
      options.thresholds.maxTtftIncreasePct = Number(val);
    } else if (arg.startsWith('--max-cost-increase-pct=') || arg.startsWith('--max-cost-spike-pct=')) {
      const val = arg.split('=')[1];
      options.thresholds.maxCostIncreasePct = Number(val);
    } else if ((arg === '--max-cost-increase-pct' || arg === '--max-cost-spike-pct') && i + 1 < args.length) {
      options.thresholds.maxCostIncreasePct = Number(args[++i]);
    } else if (arg === '--disallow-new-fn') {
      options.thresholds.disallowNewFn = true;
    } else if (arg === '--no-disallow-new-fn' || arg === '--disallow-new-fn=false') {
      options.thresholds.disallowNewFn = false;
    } else if (arg.startsWith('--disallow-new-fn=')) {
      options.thresholds.disallowNewFn = arg.slice('--disallow-new-fn='.length) === 'true';
    } else if (arg === '--disallow-new-fp') {
      options.thresholds.disallowNewFp = true;
    } else if (arg === '--no-disallow-new-fp' || arg === '--disallow-new-fp=false') {
      options.thresholds.disallowNewFp = false;
    } else if (arg.startsWith('--disallow-new-fp=')) {
      options.thresholds.disallowNewFp = arg.slice('--disallow-new-fp='.length) === 'true';
    } else if (arg.startsWith('--max-omitted-files=')) {
      options.thresholds.maxOmittedFilesAllowed = Number(arg.slice('--max-omitted-files='.length));
    } else if (arg === '--max-omitted-files' && i + 1 < args.length) {
      options.thresholds.maxOmittedFilesAllowed = Number(args[++i]);
    } else if (arg.startsWith('--min-coverage-pct=') || arg.startsWith('--min-coverage=')) {
      const val = arg.split('=')[1];
      options.thresholds.minCoveragePct = Number(val);
    } else if ((arg === '--min-coverage-pct' || arg === '--min-coverage') && i + 1 < args.length) {
      options.thresholds.minCoveragePct = Number(args[++i]);
    } else if (arg === '--disallow-omitted-files') {
      options.thresholds.disallowOmittedFiles = true;
    } else if (arg === '--no-disallow-omitted-files' || arg === '--disallow-omitted-files=false') {
      options.thresholds.disallowOmittedFiles = false;
    } else if (arg.startsWith('--disallow-omitted-files=')) {
      options.thresholds.disallowOmittedFiles = arg.slice('--disallow-omitted-files='.length) === 'true';
    } else if (arg === '--strict') {
      options.strict = true;
      options.thresholds.strict = true;
    } else if (arg === '--no-strict' || arg === '--strict=false') {
      options.strict = false;
      options.thresholds.strict = false;
    } else if (arg === '--warn-only') {
      options.warnOnly = true;
      options.strict = false;
      options.thresholds.warnOnly = true;
      options.thresholds.strict = false;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
      options.thresholds.verbose = true;
    }
  }

  // If a custom thresholds file was supplied, merge it
  if (options.thresholdsPath) {
    try {
      const resolved = path.isAbsolute(options.thresholdsPath)
        ? options.thresholdsPath
        : path.resolve(process.cwd(), options.thresholdsPath);
      if (fs.existsSync(resolved)) {
        const custom = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
        options.thresholds = { ...options.thresholds, ...custom };
      }
    } catch (_) {}
  }

  // Auto-infer format from output path if not explicitly json
  if (options.output && !options.json) {
    if (options.output.endsWith('.json')) {
      options.format = 'json';
    } else if (options.output.endsWith('.md')) {
      options.format = 'markdown';
    }
  }

  return options;
}

/**
 * Ingests and validates benchmark matrix data from file path or raw object.
 */
export function loadBenchmarkMatrix(input) {
  if (!input) {
    throw new Error('Benchmark matrix input is required');
  }

  if (typeof input === 'object' && input !== null) {
    if (!input.summary && !input.detailedResults && !input.models) {
      throw new Error('Invalid benchmark matrix schema: missing models or summary');
    }
    return input;
  }

  if (typeof input === 'string') {
    const fullPath = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Baseline file not found: ${input} (resolved to ${fullPath})`);
    }

    let parsed;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse JSON matrix from ${input}: ${err.message}`);
    }

    if (!parsed || (typeof parsed !== 'object') || (!parsed.summary && !parsed.detailedResults && !parsed.models)) {
      throw new Error(`Invalid benchmark matrix schema in ${input}: missing models or summary`);
    }

    return parsed;
  }

  throw new Error(`Unsupported input type for benchmark matrix: ${typeof input}`);
}

/**
 * Calculates mathematical deltas across all 6 core dimensions for a single model.
 */
export function calculateDeltas(candSummary = {}, baseSummary = {}, options = {}) {
  const base = baseSummary || {};
  const cand = candSummary || {};

  const baseScenarios = Number(base.totalScenarios) || 1;
  const candScenarios = Number(cand.totalScenarios) || 1;

  // Recall
  const baseRecall = Number(base.recall ?? 0);
  const candRecall = Number(cand.recall ?? 0);
  const deltaRecall = Math.round((candRecall - baseRecall) * 1000) / 1000;

  // Verdict Accuracy
  const baseAcc = Number(base.verdictAccuracy ?? 0);
  const candAcc = Number(cand.verdictAccuracy ?? 0);
  const deltaAcc = Math.round((candAcc - baseAcc) * 10) / 10;

  // Precision
  const basePrecision = Number(base.precision ?? 0);
  const candPrecision = Number(cand.precision ?? 0);
  const deltaPrecision = Math.round((candPrecision - basePrecision) * 1000) / 1000;

  // F1 Score
  const baseF1 = Number(base.f1Score ?? 0);
  const candF1 = Number(cand.f1Score ?? 0);
  const deltaF1 = Math.round((candF1 - baseF1) * 1000) / 1000;

  // SNR (dB)
  const baseSnrDb = Number(base.avgSnrDb ?? 0);
  const candSnrDb = Number(cand.avgSnrDb ?? 0);
  const deltaSnrDb = Math.round((candSnrDb - baseSnrDb) * 100) / 100;

  // TTFT (ms)
  const baseTtft = Number(base.avgTtftMs ?? 0);
  const candTtft = Number(cand.avgTtftMs ?? 0);
  const deltaTtft = candTtft - baseTtft;
  const ttftPercentChange = baseTtft > 0 ? Math.round(((deltaTtft / baseTtft) * 100) * 10) / 10 : 0;

  // Cost (USD)
  const baseCost = Number(base.totalCostUSD ?? 0);
  const candCost = Number(cand.totalCostUSD ?? 0);
  const deltaCost = Math.round((candCost - baseCost) * 10000) / 10000;

  // Normalized Average Cost per Scenario
  const baseAvgCost = baseScenarios > 0 ? baseCost / baseScenarios : 0;
  const candAvgCost = candScenarios > 0 ? candCost / candScenarios : 0;
  const rawCostSurge = baseAvgCost > 0 ? ((candAvgCost - baseAvgCost) / baseAvgCost) * 100 : 0;
  const normalizedCostDeltaPct = Math.round(rawCostSurge * 100) / 100;

  // Cost Efficiency
  const baseCostEff = Number(base.costEfficiency ?? 0);
  const candCostEff = Number(cand.costEfficiency ?? 0);
  const deltaCostEff = Math.round((candCostEff - baseCostEff) * 100) / 100;

  // TP, FP, FN
  const baseTp = Number(base.totalTp ?? 0);
  const candTp = Number(cand.totalTp ?? 0);
  const baseFp = Number(base.totalFp ?? 0);
  const candFp = Number(cand.totalFp ?? 0);
  const baseFn = Number(base.totalFn ?? 0);
  const candFn = Number(cand.totalFn ?? 0);

  const deltaTp = candTp - baseTp;
  const deltaFp = candFp - baseFp;
  const deltaFn = candFn - baseFn;

  // Omitted Files & Coverage
  const baseOmitted = Number(base.totalOmittedFiles ?? base.omittedFiles ?? 0);
  const candOmitted = Number(cand.totalOmittedFiles ?? cand.omittedFiles ?? 0);
  const deltaOmitted = candOmitted - baseOmitted;

  const baseCoverage = Number(base.coveragePct ?? base.coveragePercentage ?? 100.0);
  const candCoverage = Number(cand.coveragePct ?? cand.coveragePercentage ?? 100.0);
  const deltaCoverage = Math.round((candCoverage - baseCoverage) * 10) / 10;

  const basePartitions = Number(base.totalPartitions ?? base.partitionsCount ?? 1);
  const candPartitions = Number(cand.totalPartitions ?? cand.partitionsCount ?? 1);
  const deltaPartitions = candPartitions - basePartitions;

  const baseCompactionPct = Number(base.avgCompactionReductionPct ?? base.compactionReductionPct ?? 0);
  const candCompactionPct = Number(cand.avgCompactionReductionPct ?? cand.compactionReductionPct ?? 0);
  const deltaCompactionPct = Math.round((candCompactionPct - baseCompactionPct) * 10) / 10;

  return {
    model: cand.model || base.model || 'unknown',
    status: 'PASS',
    violations: [],
    totalScenarios: { baseline: baseScenarios, candidate: candScenarios, delta: candScenarios - baseScenarios },
    verdictAccuracy: { baseline: baseAcc, candidate: candAcc, delta: deltaAcc },
    recall: { baseline: baseRecall, candidate: candRecall, delta: deltaRecall },
    precision: { baseline: basePrecision, candidate: candPrecision, delta: deltaPrecision },
    f1Score: { baseline: baseF1, candidate: candF1, delta: deltaF1 },
    avgSnrDb: { baseline: baseSnrDb, candidate: candSnrDb, delta: deltaSnrDb },
    avgTtftMs: { baseline: baseTtft, candidate: candTtft, delta: deltaTtft, percentChange: ttftPercentChange },
    totalCostUSD: { baseline: baseCost, candidate: candCost, delta: deltaCost },
    normalizedAvgCostUSD: { baseline: baseAvgCost, candidate: candAvgCost, delta: candAvgCost - baseAvgCost, percentChange: normalizedCostDeltaPct },
    normalizedCostDeltaPct,
    costEfficiency: { baseline: baseCostEff, candidate: candCostEff, delta: deltaCostEff },
    totalTp: { baseline: baseTp, candidate: candTp, delta: deltaTp },
    totalFp: { baseline: baseFp, candidate: candFp, delta: deltaFp },
    totalFn: { baseline: baseFn, candidate: candFn, delta: deltaFn },
    newFnCount: Math.max(0, deltaFn),
    newFpCount: Math.max(0, deltaFp),
    omittedFiles: { baseline: baseOmitted, candidate: candOmitted, delta: deltaOmitted },
    coveragePct: { baseline: baseCoverage, candidate: candCoverage, delta: deltaCoverage },
    partitionsCount: { baseline: basePartitions, candidate: candPartitions, delta: deltaPartitions },
    compactionReductionPct: { baseline: baseCompactionPct, candidate: candCompactionPct, delta: deltaCompactionPct },
    omittedFilesCount: candOmitted,
    coveragePercent: candCoverage,
  };
}

/**
 * Detailed per-scenario comparisons between candidate and baseline.
 */
export function calculateScenarioDeltas(candResults = [], baseResults = [], options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const baseMap = new Map();
  for (const r of baseResults) {
    const key = `${normalizeModelIdentifier(r.model)}::${r.scenarioId}`;
    baseMap.set(key, r);
  }

  const scenarioDeltas = [];

  for (const cr of candResults) {
    if (options.scenarios && options.scenarios.length > 0 && !options.scenarios.includes(cr.scenarioId)) {
      continue;
    }
    if (options.categories && options.categories.length > 0 && !options.categories.includes(cr.category)) {
      continue;
    }
    if (options.models && options.models.length > 0) {
      const match = options.models.some((m) => areModelsEquivalent(m, cr.model));
      if (!match) continue;
    }

    const key = `${normalizeModelIdentifier(cr.model)}::${cr.scenarioId}`;
    const br = baseMap.get(key);

    const candMatch = cr.verdictMatch ?? (cr.verdict === cr.expectedVerdict);
    const candTp = Number(cr.tp ?? 0);
    const candFp = Number(cr.fp ?? 0);
    const candFn = Number(cr.fn ?? 0);
    const candSnrDb = Number(cr.snrDb ?? 0);
    const candF1 = Number(cr.f1Score ?? 0);

    if (br) {
      const baseMatch = br.verdictMatch ?? (br.verdict === br.expectedVerdict);
      const baseTp = Number(br.tp ?? 0);
      const baseFp = Number(br.fp ?? 0);
      const baseFn = Number(br.fn ?? 0);
      const baseSnrDb = Number(br.snrDb ?? 0);
      const baseF1 = Number(br.f1Score ?? 0);

      let verdictMatchDelta = 'MAINTAINED';
      if (!baseMatch && candMatch) verdictMatchDelta = 'IMPROVED';
      else if (baseMatch && !candMatch) verdictMatchDelta = 'REGRESSED';

      const tpDelta = candTp - baseTp;
      const fpDelta = candFp - baseFp;
      const fnDelta = candFn - baseFn;
      const snrDbDelta = Math.round((candSnrDb - baseSnrDb) * 100) / 100;
      const f1Delta = Math.round((candF1 - baseF1) * 1000) / 1000;

      const violations = [];
      if (verdictMatchDelta === 'REGRESSED') {
        violations.push(`Verdict regressed: ${br.verdict} -> ${cr.verdict} (expected: ${cr.expectedVerdict})`);
      }
      if (thresholds.disallowNewFn && fnDelta > 0) {
        violations.push(`New false negatives: +${fnDelta} (base: ${baseFn}, cand: ${candFn})`);
      }
      if (thresholds.disallowNewFp && fpDelta > 0) {
        violations.push(`New false positives: +${fpDelta} (base: ${baseFp}, cand: ${candFp})`);
      }

      const isRegression = violations.length > 0;

      scenarioDeltas.push({
        scenarioId: cr.scenarioId,
        scenarioName: cr.scenarioName || cr.scenarioId,
        category: cr.category,
        model: cr.model,
        expectedVerdict: cr.expectedVerdict,
        baselineVerdict: br.verdict,
        candidateVerdict: cr.verdict,
        verdictMatchBaseline: baseMatch,
        verdictMatchCandidate: candMatch,
        verdictMatchDelta,
        tpDelta,
        fpDelta,
        fnDelta,
        newFn: Math.max(0, fnDelta),
        newFp: Math.max(0, fpDelta),
        snrDbDelta,
        f1Delta,
        baseSnrDb,
        candSnrDb,
        baseF1,
        candF1,
        isRegression,
        verdictChanged: br.verdict !== cr.verdict,
        regression: isRegression,
        violations,
      });
    } else {
      // New scenario in candidate catalog expansion
      scenarioDeltas.push({
        scenarioId: cr.scenarioId,
        scenarioName: cr.scenarioName || cr.scenarioId,
        category: cr.category,
        model: cr.model,
        expectedVerdict: cr.expectedVerdict,
        baselineVerdict: null,
        candidateVerdict: cr.verdict,
        verdictMatchBaseline: null,
        verdictMatchCandidate: candMatch,
        verdictMatchDelta: 'NEW_SCENARIO',
        tpDelta: candTp,
        fpDelta: candFp,
        fnDelta: candFn,
        newFn: candFn,
        newFp: candFp,
        snrDbDelta: 0,
        f1Delta: 0,
        baseSnrDb: null,
        candSnrDb,
        baseF1: null,
        candF1,
        isRegression: false,
        verdictChanged: false,
        regression: false,
        violations: [],
      });
    }
  }

  return scenarioDeltas;
}

/**
 * Evaluates mathematical regression rules for a single model delta.
 */
export function evaluateModelGate(modelDelta, thresholds = DEFAULT_THRESHOLDS) {
  const activeThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const violations = [];
  const model = modelDelta.model;

  // Gate 1: Recall Degradation (Drop > maxRecallDrop => FAIL)
  const maxRecallDrop = Number(activeThresholds.maxRecallDrop ?? 0.00);
  if (modelDelta.recall.delta < -maxRecallDrop - 0.00001) {
    violations.push(`Recall drop: ${modelDelta.recall.delta.toFixed(3)} (base: ${modelDelta.recall.baseline.toFixed(3)}, cand: ${modelDelta.recall.candidate.toFixed(3)}, max permissible drop: ${maxRecallDrop.toFixed(3)})`);
  }

  // Gate 2: Verdict Accuracy Degradation (Drop > maxAccuracyDrop => FAIL)
  const maxAccDrop = Number(activeThresholds.maxAccuracyDrop ?? 0.0);
  if (modelDelta.verdictAccuracy.delta < -maxAccDrop - 0.0001) {
    violations.push(`Accuracy drop: ${modelDelta.verdictAccuracy.delta.toFixed(1)}% (base: ${modelDelta.verdictAccuracy.baseline.toFixed(1)}%, cand: ${modelDelta.verdictAccuracy.candidate.toFixed(1)}%, max permissible drop: ${maxAccDrop.toFixed(1)}%)`);
  }

  // Gate 3: SNR Degradation (Drop > maxSnrDropDb => FAIL)
  const maxSnrDropDb = Number(activeThresholds.maxSnrDropDb ?? 1.50);
  if (modelDelta.avgSnrDb.delta < -maxSnrDropDb - 0.0001) {
    violations.push(`SNR degradation: ${modelDelta.avgSnrDb.delta.toFixed(2)} dB (base: ${modelDelta.avgSnrDb.baseline.toFixed(2)} dB, cand: ${modelDelta.avgSnrDb.candidate.toFixed(2)} dB, max permissible drop: ${maxSnrDropDb.toFixed(2)} dB)`);
  }

  // Gate 4: F1 Score Drop (Drop > maxF1Drop => FAIL)
  const maxF1Drop = Number(activeThresholds.maxF1Drop ?? 0.02);
  if (modelDelta.f1Score.delta < -maxF1Drop - 0.0001) {
    violations.push(`F1 drop: ${modelDelta.f1Score.delta.toFixed(3)} (base: ${modelDelta.f1Score.baseline.toFixed(3)}, cand: ${modelDelta.f1Score.candidate.toFixed(3)}, max permissible drop: ${maxF1Drop.toFixed(3)})`);
  }

  // Gate 5: TTFT Latency Surge (Delta > 50ms AND Ratio > 25%)
  const maxTtftMs = Number(activeThresholds.maxTtftIncreaseMs ?? 50);
  const maxTtftRatio = Number(activeThresholds.maxTtftIncreasePct ?? 0.25);
  const deltaTtft = modelDelta.avgTtftMs.delta;
  const ttftRatio = modelDelta.avgTtftMs.baseline > 0 ? deltaTtft / modelDelta.avgTtftMs.baseline : 0;
  if (deltaTtft > maxTtftMs && ttftRatio > maxTtftRatio) {
    violations.push(`TTFT latency spike: +${deltaTtft}ms (+${(ttftRatio * 100).toFixed(1)}%) (max permissible: +${maxTtftMs}ms and +${(maxTtftRatio * 100).toFixed(0)}%)`);
  }

  // Gate 6: Cost Inflation Surge (Normalized Cost > 20% AND Recall Delta <= 0)
  const maxCostPct = Number(activeThresholds.maxCostIncreasePct ?? 20.0);
  const normalizedCostPct = modelDelta.normalizedCostDeltaPct;
  if (normalizedCostPct > maxCostPct && modelDelta.recall.delta <= 0.0001) {
    violations.push(`Cost inflation without recall gain: +${normalizedCostPct.toFixed(1)}% (max permissible: +${maxCostPct.toFixed(1)}%)`);
  }

  // Gate 7: Defect Loss (New False Negatives on Common Baseline Scenarios)
  if (activeThresholds.disallowNewFn && modelDelta.newFnCount > 0) {
    violations.push(`New false negatives: +${modelDelta.newFnCount}`);
  }

  // Gate 8: False Positive Noise (New False Positives)
  if (activeThresholds.disallowNewFp && modelDelta.newFpCount > 0) {
    violations.push(`New false positives: +${modelDelta.newFpCount}`);
  }

  // Gate 9: Zero Omitted Files (Zero-Loss Guarantee)
  const maxOmitted = Number(activeThresholds.maxOmittedFilesAllowed ?? 0);
  const candOmitted = Number(modelDelta.omittedFiles?.candidate ?? modelDelta.omittedFilesCount ?? 0);
  if (activeThresholds.disallowOmittedFiles && candOmitted > maxOmitted) {
    violations.push(`Omitted files detected: ${candOmitted} (max permissible: ${maxOmitted}, 100% coverage required)`);
  }

  // Gate 10: 100% File Review Coverage Guarantee
  const minCoverage = Number(activeThresholds.minCoveragePct ?? 100.0);
  const candCoverage = Number(modelDelta.coveragePct?.candidate ?? modelDelta.coveragePercent ?? 100.0);
  if (candCoverage < minCoverage - 0.001) {
    violations.push(`Coverage drop below required minimum: ${candCoverage.toFixed(1)}% (minimum required: ${minCoverage.toFixed(1)}%)`);
  }

  const passed = violations.length === 0;
  const status = passed ? 'PASS' : 'REGRESSION';

  return {
    model,
    passed,
    status,
    violations,
  };
}

/**
 * Evaluates the full quality gate across all model deltas.
 */
export function evaluateQualityGate(deltas = [], thresholds = DEFAULT_THRESHOLDS) {
  const activeThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  let allPassed = true;
  let totalBreaches = 0;
  const modelResults = {};

  for (const delta of deltas) {
    if (delta.status === 'SKIPPED') {
      modelResults[delta.model] = { model: delta.model, passed: true, status: 'SKIPPED', violations: delta.violations || [] };
      continue;
    }
    const gateRes = evaluateModelGate(delta, activeThresholds);
    modelResults[delta.model] = gateRes;
    delta.status = gateRes.status;
    delta.violations = gateRes.violations;
    if (!gateRes.passed) {
      allPassed = false;
      totalBreaches += gateRes.violations.length;
    }
  }

  return {
    passed: allPassed,
    hasRegressions: !allPassed,
    totalBreaches,
    modelResults,
  };
}

/**
 * Core baseline comparison pipeline: ingests matrices, calculates deltas, evaluates gates.
 */
export function compareBaselines(candInput, baseInput, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  if (options.maxRecallDrop !== undefined) thresholds.maxRecallDrop = Number(options.maxRecallDrop);
  if (options.maxAccuracyDrop !== undefined) thresholds.maxAccuracyDrop = Number(options.maxAccuracyDrop);
  if (options.maxSnrDropDb !== undefined) thresholds.maxSnrDropDb = Number(options.maxSnrDropDb);
  if (options.maxF1Drop !== undefined) thresholds.maxF1Drop = Number(options.maxF1Drop);
  if (options.maxTtftIncreaseMs !== undefined) thresholds.maxTtftIncreaseMs = Number(options.maxTtftIncreaseMs);
  if (options.maxCostIncreasePct !== undefined) thresholds.maxCostIncreasePct = Number(options.maxCostIncreasePct);
  if (options.disallowNewFn !== undefined) thresholds.disallowNewFn = options.disallowNewFn === true || options.disallowNewFn === 'true';
  if (options.disallowNewFp !== undefined) thresholds.disallowNewFp = options.disallowNewFp === true || options.disallowNewFp === 'true';
  if (options.maxOmittedFilesAllowed !== undefined) thresholds.maxOmittedFilesAllowed = Number(options.maxOmittedFilesAllowed);
  if (options.minCoveragePct !== undefined) thresholds.minCoveragePct = Number(options.minCoveragePct);
  if (options.disallowOmittedFiles !== undefined) thresholds.disallowOmittedFiles = options.disallowOmittedFiles === true || options.disallowOmittedFiles === 'true';
  if (options.strict !== undefined) thresholds.strict = options.strict;
  if (options.warnOnly !== undefined) thresholds.warnOnly = options.warnOnly;

  const baseMatrix = loadBenchmarkMatrix(baseInput);
  const candMatrix = loadBenchmarkMatrix(candInput);

  let targetModels = options.models && options.models.length > 0
    ? options.models
    : (candMatrix.models || Object.keys(candMatrix.summary || {}));

  if (!targetModels || targetModels.length === 0) {
    targetModels = DEFAULT_MODELS;
  }

  const baseSummaries = baseMatrix.summary || {};
  const candSummaries = candMatrix.summary || {};

  const summaryDeltas = [];
  const modelDeltas = {};
  const breaches = [];

  for (const targetModel of targetModels) {
    const candKey = Object.keys(candSummaries).find((k) => areModelsEquivalent(k, targetModel));
    const candSummary = candKey ? candSummaries[candKey] : null;

    const baseKey = Object.keys(baseSummaries).find((k) => areModelsEquivalent(k, targetModel));
    const baseSummary = baseKey ? baseSummaries[baseKey] : null;

    if (!candSummary && !baseSummary) {
      continue;
    }

    if (!baseSummary) {
      const deltaObj = {
        model: targetModel,
        status: 'SKIPPED',
        reason: 'Not present in baseline',
        violations: [],
      };
      summaryDeltas.push(deltaObj);
      modelDeltas[targetModel] = deltaObj;
      continue;
    }

    if (!candSummary) {
      const deltaObj = {
        model: targetModel,
        status: 'SKIPPED',
        reason: 'Missing in candidate results',
        violations: [`Model ${targetModel} missing in candidate results`],
      };
      summaryDeltas.push(deltaObj);
      modelDeltas[targetModel] = deltaObj;
      breaches.push({
        model: targetModel,
        rule: 'Model Missing',
        severity: 'HIGH',
        message: `Model ${targetModel} missing in candidate results`,
      });
      continue;
    }

    const candDetails = (candMatrix.detailedResults || []).filter((r) => areModelsEquivalent(r.model, targetModel));
    const baseDetails = (baseMatrix.detailedResults || []).filter((r) => areModelsEquivalent(r.model, targetModel));

    const delta = calculateDeltas(candSummary, baseSummary, options);

    if (candDetails.length > 0 && baseDetails.length > 0) {
      const baseFnMap = new Map(baseDetails.map((r) => [r.scenarioId, Number(r.fn ?? 0)]));
      const baseFpMap = new Map(baseDetails.map((r) => [r.scenarioId, Number(r.fp ?? 0)]));
      let newCommonFns = 0;
      let newCommonFps = 0;
      for (const cr of candDetails) {
        const bFn = baseFnMap.get(cr.scenarioId);
        if (typeof bFn === 'number' && Number(cr.fn ?? 0) > bFn) {
          newCommonFns += (Number(cr.fn ?? 0) - bFn);
        }
        const bFp = baseFpMap.get(cr.scenarioId);
        if (typeof bFp === 'number' && Number(cr.fp ?? 0) > bFp) {
          newCommonFps += (Number(cr.fp ?? 0) - bFp);
        }
      }
      delta.newFnCount = newCommonFns;
      delta.newFpCount = newCommonFps;

      // When scenario counts differ (e.g. catalog expansion), evaluate gate metrics on common baseline scenarios
      const baseScenarioIds = new Set(baseDetails.map((r) => r.scenarioId));
      const commonCandDetails = candDetails.filter((r) => baseScenarioIds.has(r.scenarioId));
      if (commonCandDetails.length > 0 && candDetails.length !== baseDetails.length) {
        let commonTp = 0;
        let commonFp = 0;
        let commonFn = 0;
        let commonMatches = 0;
        let commonSnrDbSum = 0;
        let commonTtftSum = 0;

        for (const cr of commonCandDetails) {
          commonTp += Number(cr.tp ?? 0);
          commonFp += Number(cr.fp ?? 0);
          commonFn += Number(cr.fn ?? 0);
          const isMatch = cr.verdictMatch ?? (cr.verdict === cr.expectedVerdict);
          if (isMatch) commonMatches++;
          commonSnrDbSum += Number(cr.snrDb ?? 0);
          commonTtftSum += Number(cr.ttftMs ?? 0);
        }

        const commonCount = commonCandDetails.length;
        const commonRecall = commonTp + commonFn > 0 ? commonTp / (commonTp + commonFn) : 1.0;
        const commonPrecision = commonTp + commonFp > 0 ? commonTp / (commonTp + commonFp) : 1.0;
        const commonF1 = commonPrecision + commonRecall > 0 ? (2 * commonPrecision * commonRecall) / (commonPrecision + commonRecall) : 1.0;
        const commonAcc = (commonMatches / commonCount) * 100;
        const commonAvgSnrDb = commonSnrDbSum / commonCount;
        const commonAvgTtft = commonTtftSum / commonCount;

        delta.recall.delta = Math.round((commonRecall - delta.recall.baseline) * 1000) / 1000;
        delta.verdictAccuracy.delta = Math.round((commonAcc - delta.verdictAccuracy.baseline) * 10) / 10;
        delta.f1Score.delta = Math.round((commonF1 - delta.f1Score.baseline) * 1000) / 1000;
        delta.avgSnrDb.delta = Math.round((commonAvgSnrDb - delta.avgSnrDb.baseline) * 100) / 100;
        delta.avgTtftMs.delta = Math.round(commonAvgTtft - delta.avgTtftMs.baseline);
      }
    }

    const gate = evaluateModelGate(delta, thresholds);
    delta.status = gate.status;
    delta.violations = gate.violations;

    for (const v of gate.violations) {
      breaches.push({
        model: targetModel,
        rule: v.split(':')[0],
        severity: v.includes('Recall') || v.includes('Accuracy') || v.includes('False Negatives') ? 'CRITICAL' : 'HIGH',
        message: v,
      });
    }

    summaryDeltas.push(delta);
    modelDeltas[targetModel] = delta;
  }

  const scenarioDeltas = calculateScenarioDeltas(
    candMatrix.detailedResults || [],
    baseMatrix.detailedResults || [],
    { ...options, thresholds }
  );

  for (const sd of scenarioDeltas) {
    if (sd.isRegression) {
      for (const v of sd.violations) {
        breaches.push({
          model: sd.model,
          scenarioId: sd.scenarioId,
          rule: 'Scenario Regression',
          severity: 'HIGH',
          message: `Scenario ${sd.scenarioId} (${sd.model}): ${v}`,
        });
      }
    }
  }

  const hasRegressions = summaryDeltas.some((d) => d.status === 'REGRESSION') || scenarioDeltas.some((sd) => sd.isRegression);
  const passed = !hasRegressions;
  const totalBreaches = breaches.length;

  return {
    timestamp: new Date().toISOString(),
    baselineFile: typeof baseInput === 'string' ? baseInput : (baseMatrix.version || 'in-memory-baseline'),
    candidateFile: typeof candInput === 'string' ? candInput : (candMatrix.version || 'in-memory-candidate'),
    passed,
    hasRegressions,
    totalBreaches,
    thresholds,
    summaryDeltas,
    modelDeltas,
    scenarioDeltas,
    breaches,
  };
}

/**
 * Formats Markdown release comparison and regression gate report.
 */
export function formatMarkdownReport(comparison, options = {}) {
  const {
    baselineFile,
    candidateFile,
    timestamp,
    passed,
    hasRegressions,
    totalBreaches,
    summaryDeltas = [],
    scenarioDeltas = [],
    thresholds = DEFAULT_THRESHOLDS,
  } = comparison;

  const sign = (num, decimals = 3) => {
    if (num === null || num === undefined || Number.isNaN(num)) return '—';
    const val = Number(num);
    const formatted = val.toFixed(decimals);
    return val > 0 ? `+${formatted}` : formatted;
  };

  const signAcc = (num) => {
    if (num === null || num === undefined || Number.isNaN(num)) return '—';
    const val = Number(num);
    const formatted = val.toFixed(1);
    return val > 0 ? `+${formatted}%` : `${formatted}%`;
  };

  const signCost = (deltaUSD, deltaPct) => {
    const dVal = Number(deltaUSD || 0);
    const signPrefix = dVal >= 0 ? '+$' : '-$';
    const formattedVal = `${signPrefix}${Math.abs(dVal).toFixed(4)}`;
    if (deltaPct !== undefined && deltaPct !== null) {
      const pVal = Number(deltaPct);
      const pFormatted = pVal >= 0 ? `+${pVal.toFixed(1)}%` : `${pVal.toFixed(1)}%`;
      return `${formattedVal} (${pFormatted})`;
    }
    return formattedVal;
  };

  const statusBadge = !hasRegressions
    ? '✅ **ALL GATES PASSED (0 Breaches)**'
    : `❌ **REGRESSION DETECTED (${totalBreaches} Breach${totalBreaches === 1 ? '' : 'es'})**`;

  let md = `# 🚀 ct-review-bot Release Baseline Comparison & Regression Gate\n\n`;
  md += `**Baseline Version**: \`${baselineFile}\`  \n`;
  md += `**Candidate Version**: \`${candidateFile}\`  \n`;
  md += `**Timestamp**: \`${timestamp}\`  \n`;
  md += `**Gate Verdict**: ${statusBadge}\n\n`;
  md += `---\n\n`;

  md += `## 🚦 1. Model Quality Gate Summary\n\n`;
  md += `| Model | Status | Δ Recall | Δ Verdict Acc | Δ F1 Score | Δ SNR (dB) | Δ TTFT | Δ Cost | Violations |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;

  for (const d of summaryDeltas) {
    if (d.status === 'SKIPPED') {
      md += `| \`${d.model}\` | ⚪ SKIPPED | — | — | — | — | — | — | ${d.reason || 'Skipped'} |\n`;
      continue;
    }
    const statusIcon = d.status === 'PASS' ? '🟢 PASS' : '🔴 FAIL';
    const dRecall = sign(d.recall?.delta, 3);
    const dAcc = signAcc(d.verdictAccuracy?.delta);
    const dF1 = sign(d.f1Score?.delta, 3);
    const dSnr = `${sign(d.avgSnrDb?.delta, 2)} dB`;
    const dTtft = `${d.avgTtftMs?.delta >= 0 ? `+${d.avgTtftMs?.delta}` : d.avgTtftMs?.delta} ms`;
    const dCost = signCost(d.totalCostUSD?.delta, d.normalizedCostDeltaPct);
    const violationsText = d.violations && d.violations.length > 0 ? d.violations.join('; ') : '—';

    md += `| \`${d.model}\` | ${statusIcon} | ${dRecall} | ${dAcc} | ${dF1} | ${dSnr} | ${dTtft} | ${dCost} | ${violationsText} |\n`;
  }
  md += `\n`;

  md += `## 📊 2. Comparative Performance Matrix (Baseline $\\rightarrow$ Candidate)\n\n`;
  md += `| Model | Scenarios | Verdict Acc (%) | Recall | F1 Score | Avg SNR (dB) | TTFT (ms) | Total Cost ($) | Cost Eff (TP/$) |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;

  for (const d of summaryDeltas) {
    if (d.status === 'SKIPPED') continue;
    const scenStr = `${d.totalScenarios?.baseline} $\\rightarrow$ ${d.totalScenarios?.candidate}`;
    const accStr = `${d.verdictAccuracy?.baseline?.toFixed(1)}% $\\rightarrow$ ${d.verdictAccuracy?.candidate?.toFixed(1)}% (${signAcc(d.verdictAccuracy?.delta)})`;
    const recStr = `${d.recall?.baseline?.toFixed(3)} $\\rightarrow$ ${d.recall?.candidate?.toFixed(3)} (${sign(d.recall?.delta, 3)})`;
    const f1Str = `${d.f1Score?.baseline?.toFixed(3)} $\\rightarrow$ ${d.f1Score?.candidate?.toFixed(3)} (${sign(d.f1Score?.delta, 3)})`;
    const snrStr = `${d.avgSnrDb?.baseline?.toFixed(1)} $\\rightarrow$ ${d.avgSnrDb?.candidate?.toFixed(1)} dB (${sign(d.avgSnrDb?.delta, 2)})`;
    const ttftStr = `${d.avgTtftMs?.baseline} $\\rightarrow$ ${d.avgTtftMs?.candidate} ms (${d.avgTtftMs?.delta >= 0 ? `+${d.avgTtftMs?.delta}` : d.avgTtftMs?.delta})`;
    const costStr = `$${d.totalCostUSD?.baseline?.toFixed(4)} $\\rightarrow$ $${d.totalCostUSD?.candidate?.toFixed(4)}`;
    const effStr = `${d.costEfficiency?.baseline?.toFixed(1)} $\\rightarrow$ ${d.costEfficiency?.candidate?.toFixed(1)} (${sign(d.costEfficiency?.delta, 1)})`;

    md += `| \`${d.model}\` | ${scenStr} | ${accStr} | ${recStr} | ${f1Str} | ${snrStr} | ${ttftStr} | ${costStr} | ${effStr} |\n`;
  }
  md += `\n`;

  const regressedScenarios = scenarioDeltas.filter((sd) => sd.isRegression);
  if (regressedScenarios.length > 0) {
    md += `## 🔍 3. Scenario Regressions & Defect Deltas\n\n`;
    md += `| Scenario ID | Model | Expected | Base Verdict | Cand Verdict | Δ TP | Δ FP | Δ FN | Δ SNR (dB) | Violations |\n`;
    md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
    for (const sd of regressedScenarios) {
      md += `| \`${sd.scenarioId}\` | \`${sd.model}\` | ${sd.expectedVerdict} | ${sd.baselineVerdict || '—'} | ${sd.candidateVerdict} | ${sd.tpDelta >= 0 ? `+${sd.tpDelta}` : sd.tpDelta} | ${sd.fpDelta >= 0 ? `+${sd.fpDelta}` : sd.fpDelta} | ${sd.fnDelta >= 0 ? `+${sd.fnDelta}` : sd.fnDelta} | ${sign(sd.snrDbDelta, 2)} dB | ${sd.violations.join('; ')} |\n`;
    }
    md += `\n`;
  } else {
    md += `## 🔍 3. Scenario-Level Regressions & Defect Deltas\n\n`;
    md += `*(No regressions detected across evaluated scenarios)*\n\n`;
  }

  md += `## ⚙️ 4. Active Quality Gate Thresholds\n\n`;
  md += `| Gate Dimension | Max Permissible Tolerance | Enforcement |\n`;
  md += `| :--- | :---: | :---: |\n`;
  md += `| **Max Recall Drop** | ${Number(thresholds.maxRecallDrop ?? 0).toFixed(3)} | Zero Tolerance |\n`;
  md += `| **Max Verdict Accuracy Drop** | ${Number(thresholds.maxAccuracyDrop ?? 0).toFixed(1)}% | Zero Tolerance |\n`;
  md += `| **Max SNR Degradation** | ${Number(thresholds.maxSnrDropDb ?? 1.5).toFixed(2)} dB | Thresholded |\n`;
  md += `| **Max F1 Score Drop** | ${Number(thresholds.maxF1Drop ?? 0.02).toFixed(3)} | Thresholded |\n`;
  md += `| **Max TTFT Latency Increase** | +${thresholds.maxTtftIncreaseMs ?? 50} ms (and > ${((thresholds.maxTtftIncreasePct ?? 0.25) * 100).toFixed(0)}%) | Compound Latency |\n`;
  md += `| **Max Cost Increase (without Recall gain)** | +${Number(thresholds.maxCostIncreasePct ?? 20).toFixed(1)}% | Cost Guard |\n`;
  md += `| **Disallow New False Negatives** | ${thresholds.disallowNewFn ? 'Enabled (0 new FN)' : 'Disabled'} | Defect Invariance |\n`;
  md += `| **Disallow New False Positives** | ${thresholds.disallowNewFp ? 'Enabled (0 new FP)' : 'Disabled'} | Noise Guard |\n`;
  md += `| **Max Omitted Files Allowed** | ${thresholds.maxOmittedFilesAllowed ?? 0} (Zero Dropped Files) | Zero-Loss Guard |\n`;
  md += `| **Min Review Coverage %** | ${Number(thresholds.minCoveragePct ?? 100.0).toFixed(1)}% | 100% Coverage Guard |\n`;
  md += `| **Disallow Omitted Files** | ${thresholds.disallowOmittedFiles !== false ? 'Enabled (0 omitted)' : 'Disabled'} | Full Fidelity Guard |\n`;
  md += `| **Strict Mode** | ${thresholds.strict ? 'Enabled (Exit 1 on breach)' : 'Disabled (Warn Only)'} | CI Enforcement |\n\n`;

  return md;
}

/**
 * Formats JSON release comparison report.
 */
export function formatJsonReport(comparison) {
  return JSON.stringify(comparison, null, 2);
}

/**
 * Displays CLI usage and flag reference.
 */
export function showHelp() {
  console.log(`
Usage:
  node scripts/compare-release-baselines.mjs --baseline=<path> --candidate=<path> [options]

Required Options:
  --candidate=<path>            Path to candidate benchmark matrix JSON file.

Comparison Options:
  --baseline=<path>             Path to baseline benchmark matrix JSON file.
                                (Default: eval-baselines/model-benchmark-matrix-v1.json)
  --output=<path>               Output file path (.md or .json)
  --format=<markdown|json>      Diff report format (Default: markdown)
  --json                        Convenience flag for raw JSON output to stdout
  --models=<csv>                Filter to specific model IDs
  --categories=<csv>            Filter scenario breakdown to specific categories
  --scenarios=<csv>             Filter scenario breakdown to specific scenario IDs
  --thresholds=<path>           Path to custom JSON file overriding thresholds

Mathematical Gate Threshold Overrides:
  --max-recall-drop=<num>       Max permissible recall drop (Default: 0.00)
  --max-accuracy-drop=<num>     Max permissible accuracy % drop (Default: 0.0)
  --max-snr-drop-db=<num>       Max permissible SNR degradation in dB (Default: 1.50)
  --max-f1-drop=<num>           Max permissible F1 drop (Default: 0.02)
  --max-ttft-increase-ms=<num>  Max permissible TTFT increase in ms (Default: 50)
  --max-cost-increase-pct=<num> Max permissible cost surge % without recall gain (Default: 20.0)
  --disallow-new-fn[=bool]      Fail on any new false negatives (Default: true)
  --disallow-new-fp[=bool]      Fail on any new false positives (Default: true)
  --max-omitted-files=<num>     Max permissible omitted files count (Default: 0)
  --min-coverage-pct=<num>      Min permissible review coverage percentage (Default: 100.0)
  --disallow-omitted-files[=b]  Disallow dropped files across partitions (Default: true)

Execution Control:
  --strict                      Exit with code 1 on regression breaches (Default: true)
  --warn-only                   Report breaches as warnings, exit 0 (alias for --no-strict)
  --verbose, -v                 Log detailed execution messages
  --help, -h                    Display this help message
`);
}

/**
 * Main CLI orchestrator.
 */
export async function main(argv = process.argv) {
  const options = parseCliArgs(argv);

  if (options.help) {
    showHelp();
    return { exitCode: 0, help: true };
  }

  if (!options.candidate) {
    console.error('[!] Missing required argument: --candidate=<path>');
    console.error('    Use --help for usage instructions.');
    return { exitCode: 1, error: 'Missing candidate path' };
  }

  let comparison;
  try {
    comparison = compareBaselines(options.candidate, options.baseline, options);
  } catch (err) {
    console.error(`[!] Failed to compare baselines: ${err.message}`);
    return { exitCode: 2, error: err.message };
  }

  const markdown = formatMarkdownReport(comparison, options);
  const json = formatJsonReport(comparison);

  if (options.output) {
    const outPath = path.isAbsolute(options.output)
      ? options.output
      : path.resolve(process.cwd(), options.output);
    const parentDir = path.dirname(outPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const content = options.format === 'json' ? json : markdown;
    fs.writeFileSync(outPath, content, 'utf-8');
    if (options.verbose) {
      console.log(`[+] Wrote comparison report to ${outPath}`);
    }
  }

  if (options.json) {
    console.log(json);
  } else if (!options.output) {
    console.log(markdown);
  }

  let exitCode = 0;
  if (comparison.hasRegressions) {
    if (options.warnOnly || !options.strict) {
      exitCode = 0;
      console.warn(`\n[!] Warning: ${comparison.totalBreaches} quality gate regression(s) detected, but --warn-only/--no-strict was set.`);
    } else {
      exitCode = 1;
      console.error(`\n[!] Release Regression Gate Failed: ${comparison.totalBreaches} breach(es) detected.`);
    }
  } else {
    exitCode = 0;
  }

  return {
    exitCode,
    report: comparison,
    comparison,
    markdown,
    json,
  };
}

// Standalone CLI execution guard
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv)
    .then(({ exitCode }) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((err) => {
      console.error('[!] Release baseline comparison failed:', err);
      process.exit(1);
    });
}
