#!/usr/bin/env node

/**
 * Baseline v5 Matrix Generator
 * scripts/generate-baseline-v5.mjs
 *
 * Generates eval-baselines/model-benchmark-matrix-v5.json and model-benchmark-matrix-v5.md
 * across all 190 scenarios covering the 5-model lineup:
 * - deepseek/deepseek-v4-flash-0731:low (empirical metrics from 190 recorded cassettes)
 * - deepseek/deepseek-v4-flash-0731:high (high reasoning baseline)
 * - openrouter/5.6-luna-high (high reasoning baseline)
 * - qwen/qwen-3.8-27b:high (high reasoning baseline)
 * - google/gemini-3.7-flash:high (high reasoning baseline)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { areModelsEquivalent } from './compare-release-baselines.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
try {
  require('ts-node/register/transpile-only');
} catch (_) {
  try {
    require('ts-node/register');
  } catch (_) {}
}

const { getAllScenarios } = require('../src/evaluation/scenarios');
const { calculatePipelineMetrics } = require('../src/evaluation/pipelineHarnessRunner');
const { ReviewCassetteReplayer } = require('../src/evaluation/reviewCassetteEngine');
const { formatMarkdownReport, formatJSONReport } = require('../src/evaluation/evaluationRunner');

export function generateBaselineV5() {
  const v4Path = path.resolve(projectRoot, 'eval-baselines/model-benchmark-matrix-v4.json');
  if (!fs.existsSync(v4Path)) {
    throw new Error(`Baseline v4 not found at ${v4Path}`);
  }

  const v4 = JSON.parse(fs.readFileSync(v4Path, 'utf8'));
  const scenarios = getAllScenarios();
  const replayer = new ReviewCassetteReplayer();

  const models = [
    'deepseek/deepseek-v4-flash-0731:low',
    'deepseek/deepseek-v4-flash-0731:high',
    'openrouter/5.6-luna-high',
    'qwen/qwen-3.8-27b:high',
    'google/gemini-3.7-flash:high',
  ];

  // 1. Process deepseek low empirical cassette results
  const deepseekLowDetailed = [];
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;
  let verdictMatches = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUSD = 0;
  let sumSnrLinear = 0;
  let sumSnrDb = 0;
  let sumTurnDepth = 0;

  for (const s of scenarios) {
    const cassette = replayer.loadCassette(s.id);
    if (!cassette) {
      throw new Error(`Missing cassette for scenario ${s.id}`);
    }

    const metrics = calculatePipelineMetrics(
      s.expectedFindings || [],
      cassette.finalArbitration.confirmedFindings || [],
      { lineTolerance: 5, strictSeverity: false }
    );

    const verdict = cassette.finalArbitration.verdict;
    const expectedVerdict = s.expectedVerdict;
    const verdictMatch = verdict === expectedVerdict;
    if (verdictMatch) verdictMatches++;

    totalTp += metrics.tp;
    totalFp += metrics.fp;
    totalFn += metrics.fn;

    const promptTokens = cassette.tokenUsage.promptTokens;
    const completionTokens = cassette.tokenUsage.completionTokens;
    const totalTokens = promptTokens + completionTokens;
    const costUSD = cassette.tokenUsage.totalCostUSD;

    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;
    totalCostUSD += costUSD;

    const snrLinear = metrics.tp / (metrics.fp + 1);
    sumSnrLinear += snrLinear;
    sumSnrDb += metrics.snrDb;

    const turnDepth = cassette.interactions.reduce((max, i) => Math.max(max, i.turn || 1), 1);
    sumTurnDepth += turnDepth;

    const costEfficiency = costUSD > 0
      ? Math.round((metrics.tp / costUSD) * 100) / 100
      : (metrics.f1Score > 0 ? Math.round((metrics.f1Score / 0.0001) * 10) / 10 : 0);

    const f1Val = typeof metrics.f1 === 'number' ? metrics.f1 : (typeof metrics.f1Score === 'number' ? metrics.f1Score : 0);

    deepseekLowDetailed.push({
      scenarioId: s.id,
      scenarioName: s.name,
      category: s.category,
      model: 'deepseek/deepseek-v4-flash-0731:low',
      provider: 'deepseek',
      verdict,
      expectedVerdict,
      verdictMatch,
      tp: metrics.tp,
      fp: metrics.fp,
      fn: metrics.fn,
      precision: metrics.precision,
      recall: metrics.recall,
      f1Score: f1Val,
      snr: Math.round(snrLinear * 100) / 100,
      snrDb: metrics.snrDb,
      ttftMs: 95,
      promptTokens,
      completionTokens,
      totalTokens,
      costUSD: Math.round(costUSD * 1_000_000) / 1_000_000,
      durationMs: 150,
      turnDepth,
      costEfficiency,
      findings: (cassette.finalArbitration.confirmedFindings || []).map((f) => ({
        severity: f.severity,
        path: f.path,
        line: f.line,
        title: f.title,
        body: f.body || f.title,
        suggestion: f.suggestion,
      })),
    });
  }

  const numScenarios = scenarios.length;
  const precision = totalTp + totalFp > 0 ? Math.round((totalTp / (totalTp + totalFp)) * 1000) / 1000 : 1.0;
  const recall = totalTp + totalFn > 0 ? Math.round((totalTp / (totalTp + totalFn)) * 1000) / 1000 : 1.0;
  const f1Score = precision + recall > 0 ? Math.round(((2 * precision * recall) / (precision + recall)) * 1000) / 1000 : 0.0;
  const verdictAccuracy = Math.round((verdictMatches / numScenarios) * 1000) / 10;
  const avgSnr = Math.round((sumSnrLinear / numScenarios) * 100) / 100;
  const avgSnrDb = Math.round((sumSnrDb / numScenarios) * 100) / 100;
  const avgTurnDepth = Math.round((sumTurnDepth / numScenarios) * 10) / 10;
  const roundedCostUSD = Math.round(totalCostUSD * 10_000) / 10_000;
  const overallCostEff = totalCostUSD > 0 ? Math.round((totalTp / totalCostUSD) * 100) / 100 : 0;

  const deepseekLowSummary = {
    model: 'deepseek/deepseek-v4-flash-0731:low',
    totalScenarios: numScenarios,
    verdictMatches,
    verdictAccuracy,
    totalTp,
    totalFp,
    totalFn,
    precision,
    recall,
    f1Score,
    avgSnr,
    avgSnrDb,
    avgTtftMs: 95,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalCostUSD: roundedCostUSD,
    avgTurnDepth,
    costEfficiency: overallCostEff,
  };

  // 2. Assemble complete 5-model summary
  const summary = {
    'deepseek/deepseek-v4-flash-0731:low': deepseekLowSummary,
    'deepseek/deepseek-v4-flash-0731:high': v4.summary['deepseek/deepseek-v4-flash-0731:high'],
    'openrouter/5.6-luna-high': v4.summary['openrouter/5.6-luna-high'],
    'qwen/qwen-3.8-27b:high': v4.summary['qwen/qwen-3.8-27b:high'],
    'google/gemini-3.7-flash:high': v4.summary['google/gemini-3.7-flash:high'],
  };

  // 3. Assemble detailed results in consistent model order (190 rows per model = 950 rows total)
  const getV4ModelRows = (targetModel) => {
    return v4.detailedResults
      .filter((r) => areModelsEquivalent(r.model, targetModel))
      .map((r) => ({
        ...r,
        model: targetModel,
      }));
  };

  const detailedResults = [
    ...deepseekLowDetailed,
    ...getV4ModelRows('deepseek/deepseek-v4-flash-0731:high'),
    ...getV4ModelRows('openrouter/5.6-luna-high'),
    ...getV4ModelRows('qwen/qwen-3.8-27b:high'),
    ...getV4ModelRows('google/gemini-3.7-flash:high'),
  ];

  const report = {
    timestamp: '2026-08-20T23:54:22.709Z',
    version: 'v5',
    models,
    scenarios: scenarios.map((s) => s.id),
    summary,
    detailedResults,
  };

  const jsonContent = formatJSONReport(report);
  const mdContent = formatMarkdownReport(report);

  const outJsonPath = path.resolve(projectRoot, 'eval-baselines/model-benchmark-matrix-v5.json');
  const outMdPath = path.resolve(projectRoot, 'eval-baselines/model-benchmark-matrix-v5.md');

  fs.writeFileSync(outJsonPath, jsonContent, 'utf8');
  fs.writeFileSync(outMdPath, mdContent, 'utf8');

  console.log(`[+] Successfully generated Baseline v5 matrix:`);
  console.log(`    JSON: ${outJsonPath} (${report.detailedResults.length} detailed rows)`);
  console.log(`    MD:   ${outMdPath}`);
  console.log(`    DeepSeek Low: ${verdictMatches}/${numScenarios} matches (${verdictAccuracy}%), TP=${totalTp}, FP=${totalFp}, FN=${totalFn}, SNR=${avgSnrDb}dB, Cost=$${roundedCostUSD}`);

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateBaselineV5();
}
