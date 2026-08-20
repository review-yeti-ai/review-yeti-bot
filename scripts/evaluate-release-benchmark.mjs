#!/usr/bin/env node

/**
 * Standardized Per-Release Benchmark Harness
 * scripts/evaluate-release-benchmark.mjs
 *
 * Executes comprehensive benchmark evaluation across the approved 4-model roster:
 * - deepseek/deepseek-v4-flash-0731:high
 * - openrouter/5.6-luna-high (normalized: openai/gpt-5.6-luna)
 * - qwen/qwen-3.8-27b:high
 * - google/gemini-3.7-flash:high
 *
 * Measures all 6 core evaluation dimensions across all 60+ scenarios in src/evaluation/scenarios.ts:
 * 1. Signal-to-Noise Ratio (SNR linear & dB)
 * 2. Time-to-First-Token (TTFT in ms)
 * 3. Tokens In / Out (Prompt, Completion, Total)
 * 4. Findings Accuracy, Precision, Recall, F1 Score, and Verdict Accuracy
 * 5. Multi-turn Tool-calling Turn Depth
 * 6. Cost Efficiency ($TP / USD)
 *
 * Supports deterministic offline replay (--offline), live OpenRouter execution (--live),
 * baseline persistence (--save-baseline=<ver>), baseline comparison (--compare-baseline=<path>),
 * and automated quality gate enforcement (--fail-on-regression).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const {
  EvaluationRunner,
  formatMarkdownReport,
  formatJSONReport,
} = require('../src/evaluation/evaluationRunner');
const {
  getAllScenarios,
  getScenarioById,
  getScenariosByCategory,
  getScenarioCategories,
} = require('../src/evaluation/scenarios');
const { normalizeOpenRouterModel } = require('../src/gateway/openRouterClient');

// Approved 4-Model Benchmark Roster
export const DEFAULT_MODELS = [
  'deepseek/deepseek-v4-flash-0731:high',
  'openrouter/5.6-luna-high',
  'qwen/qwen-3.8-27b:high',
  'google/gemini-3.7-flash:high',
];

/**
 * Parse CLI arguments into typed options dictionary.
 */
export function parseCliArgs(argv) {
  const args = argv.slice(2);
  const options = {
    live: args.includes('--live'),
    offline: args.includes('--offline') || !args.includes('--live'),
    json: args.includes('--json'),
    failOnRegression: args.includes('--fail-on-regression'),
    formatDigest: args.includes('--format-digest'),
    extractDigestFrom: null,
    repository: process.env.GITHUB_REPOSITORY || null,
    help: args.includes('--help') || args.includes('-h'),
    output: null,
    saveBaseline: null,
    compareBaseline: null,
    models: DEFAULT_MODELS,
    scenarios: null,
    category: null,
    apiKey: process.env.OPENROUTER_API_KEY || null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    } else if (arg === '--output' && i + 1 < args.length) {
      options.output = args[++i];
    } else if (arg.startsWith('--save-baseline=')) {
      options.saveBaseline = arg.slice('--save-baseline='.length);
    } else if (arg === '--save-baseline' && i + 1 < args.length) {
      options.saveBaseline = args[++i];
    } else if (arg.startsWith('--compare-baseline=')) {
      options.compareBaseline = arg.slice('--compare-baseline='.length);
    } else if (arg === '--compare-baseline' && i + 1 < args.length) {
      options.compareBaseline = args[++i];
    } else if (arg.startsWith('--models=')) {
      options.models = arg
        .slice('--models='.length)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    } else if (arg === '--models' && i + 1 < args.length) {
      options.models = args[++i]
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--scenarios=')) {
      options.scenarios = arg
        .slice('--scenarios='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--scenarios' && i + 1 < args.length) {
      options.scenarios = args[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--category=')) {
      options.category = arg.slice('--category='.length).trim();
    } else if (arg === '--category' && i + 1 < args.length) {
      options.category = args[++i].trim();
    } else if (arg.startsWith('--api-key=')) {
      options.apiKey = arg.slice('--api-key='.length).trim();
    } else if (arg === '--api-key' && i + 1 < args.length) {
      options.apiKey = args[++i].trim();
    } else if (arg.startsWith('--extract-digest-from=')) {
      options.extractDigestFrom = arg.slice('--extract-digest-from='.length).trim();
    } else if (arg === '--extract-digest-from' && i + 1 < args.length) {
      options.extractDigestFrom = args[++i].trim();
    } else if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length).trim();
    } else if (arg === '--repository' && i + 1 < args.length) {
      options.repository = args[++i].trim();
    }
  }

  return options;
}

/**
 * Display help message.
 */
export function showHelp() {
  console.log(`
Review Yeti Release Benchmark Harness
Usage: node scripts/evaluate-release-benchmark.mjs [options]

Options:
  --offline                     Run deterministic offline simulation (default)
  --live                        Run live evaluation via OpenRouter client
  --models=<csv>                Target model identifiers (default: approved 4-model roster)
  --scenarios=<csv>             Filter by scenario ID or slug substring
  --category=<name>             Filter by scenario category (e.g. security, database)
  --output=<path>               Output file path (.json or .md)
  --json                        Emit structured JSON to stdout
  --save-baseline=<version>     Persist matrix into eval-baselines/model-benchmark-matrix-<version>.json and .md
  --compare-baseline=<path>     Compare candidate results against baseline file
  --fail-on-regression          Exit with non-zero code if quality gate regressions detected
  --format-digest               Emit release notes benchmark digest to stdout
  --extract-digest-from=<path>  Extract and format release notes digest from existing markdown report
  --repository=<owner/repo>     GitHub repository name (defaults to GITHUB_REPOSITORY or calltelemetry/ct-review-bot)
  --api-key=<key>               OpenRouter API key for live execution
  --help, -h                    Show this help message

Approved 4-Model Roster:
  ${DEFAULT_MODELS.join('\n  ')}

Available Scenario Categories:
  ${getScenarioCategories().join(', ')}
`);
}

/**
 * Resolve scenario set based on category and scenario filters.
 */
export function resolveScenarios(options) {
  let scenarios = getAllScenarios();

  if (options.category) {
    const catScenarios = getScenariosByCategory(options.category);
    if (catScenarios.length === 0) {
      console.warn(
        `[!] Warning: No scenarios found for category "${options.category}". Valid categories: ${getScenarioCategories().join(', ')}`
      );
    }
    scenarios = catScenarios;
  }

  if (options.scenarios && options.scenarios.length > 0) {
    scenarios = scenarios.filter((s) =>
      options.scenarios.some((target) => s.id === target || s.id.includes(target))
    );
  }

  return scenarios;
}

/**
 * Compare candidate benchmark report against baseline JSON and detect quality gate regressions.
 */
export function evaluateRegressionGate(candidateReport, baselinePath) {
  const resolvedPath = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Baseline file not found at: ${resolvedPath}`);
  }

  const baselineRaw = fs.readFileSync(resolvedPath, 'utf8');
  const baseline = JSON.parse(baselineRaw);
  const diffs = [];
  let hasRegressions = false;

  for (const model of candidateReport.models) {
    const cand = candidateReport.summary[model];

    // Lookup baseline summary by exact model, normalized alias, or case-insensitive matching
    let base = baseline.summary?.[model];
    if (!base) {
      const normalizedCandidate = normalizeOpenRouterModel(model);
      base = baseline.summary?.[normalizedCandidate];
      if (!base && baseline.summary) {
        for (const [key, val] of Object.entries(baseline.summary)) {
          if (normalizeOpenRouterModel(key) === normalizedCandidate) {
            base = val;
            break;
          }
        }
      }
    }

    if (!cand || !base) {
      diffs.push({
        model,
        status: 'SKIPPED',
        reason: !base ? 'Not present in baseline' : 'Missing in candidate results',
        dRecall: 0,
        dAccuracy: 0,
        dF1: 0,
        dSnrDb: 0,
        dTtft: 0,
        dCost: 0,
        violations: [],
      });
      continue;
    }

    let dRecall = Math.round((cand.recall - base.recall) * 1000) / 1000;
    let dAccuracy = Math.round((cand.verdictAccuracy - base.verdictAccuracy) * 10) / 10;
    let dF1 = Math.round((cand.f1Score - base.f1Score) * 1000) / 1000;
    let dSnrDb = Math.round((cand.avgSnrDb - base.avgSnrDb) * 100) / 100;
    let dTtft = cand.avgTtftMs - base.avgTtftMs;
    const dCost = Math.round((cand.totalCostUSD - base.totalCostUSD) * 10000) / 10000;
    let dFn = cand.totalFn - base.totalFn;

    const candDetails = (candidateReport.detailedResults || []).filter(
      (r) => r.model === model || normalizeOpenRouterModel(r.model) === normalizeOpenRouterModel(model)
    );
    const baseDetails = (baseline.detailedResults || []).filter(
      (r) => r.model === model || normalizeOpenRouterModel(r.model) === normalizeOpenRouterModel(model)
    );

    if (candDetails.length > 0 && baseDetails.length > 0 && candDetails.length !== baseDetails.length) {
      const baseScenarioIds = new Set(baseDetails.map((r) => r.scenarioId));
      const commonCandDetails = candDetails.filter((r) => baseScenarioIds.has(r.scenarioId));
      if (commonCandDetails.length > 0) {
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

        dRecall = Math.round((commonRecall - base.recall) * 1000) / 1000;
        dAccuracy = Math.round((commonAcc - base.verdictAccuracy) * 10) / 10;
        dF1 = Math.round((commonF1 - base.f1Score) * 1000) / 1000;
        dSnrDb = Math.round((commonAvgSnrDb - base.avgSnrDb) * 100) / 100;
        dTtft = Math.round(commonAvgTtft - base.avgTtftMs);

        const baseFnMap = new Map(baseDetails.map((r) => [r.scenarioId, Number(r.fn ?? 0)]));
        let newCommonFns = 0;
        for (const cr of commonCandDetails) {
          const bFn = baseFnMap.get(cr.scenarioId);
          if (typeof bFn === 'number' && Number(cr.fn ?? 0) > bFn) {
            newCommonFns += (Number(cr.fn ?? 0) - bFn);
          }
        }
        dFn = newCommonFns;
      }
    }

    const violations = [];
    if (dRecall < 0) {
      violations.push(`Recall drop: ${dRecall.toFixed(3)}`);
    }
    if (dAccuracy < 0) {
      violations.push(`Accuracy drop: ${dAccuracy.toFixed(1)}%`);
    }
    if (dF1 < -0.02) {
      violations.push(`F1 drop: ${dF1.toFixed(3)}`);
    }
    if (dSnrDb < -1.5) {
      violations.push(`SNR degradation: ${dSnrDb.toFixed(2)} dB`);
    }
    if (dFn > 0 && cand.totalScenarios <= base.totalScenarios) {
      violations.push(`New false negatives: +${dFn}`);
    }
    if (dTtft > 50 && base.avgTtftMs > 0 && dTtft / base.avgTtftMs > 0.25) {
      violations.push(`TTFT latency spike: +${dTtft}ms`);
    }

    // Cost inflation check: per-scenario normalized if scenario counts differ
    const candAvgCost = cand.totalScenarios > 0 ? cand.totalCostUSD / cand.totalScenarios : 0;
    const baseAvgCost = base.totalScenarios > 0 ? base.totalCostUSD / base.totalScenarios : 0;
    if (baseAvgCost > 0 && (candAvgCost - baseAvgCost) / baseAvgCost > 0.20 && dRecall <= 0) {
      violations.push(`Cost inflation without recall gain: +${Math.round(((candAvgCost - baseAvgCost) / baseAvgCost) * 100)}%`);
    }

    const isRegression = violations.length > 0;
    if (isRegression) {
      hasRegressions = true;
    }

    diffs.push({
      model,
      status: isRegression ? 'REGRESSION' : 'PASS',
      violations,
      dRecall,
      dAccuracy,
      dF1,
      dSnrDb,
      dTtft,
      dCost,
    });
  }

  return {
    baselinePath: resolvedPath,
    hasRegressions,
    diffs,
  };
}

/**
 * Format baseline regression comparison into a clean Markdown table.
 */
export function formatComparisonMarkdown(comparison, baselinePath) {
  const lines = [
    '',
    '## Release Baseline Comparison Report',
    `**Baseline File**: \`${baselinePath}\``,
    '',
    '| Model | Status | Δ Recall | Δ Verdict Acc | Δ F1 Score | Δ SNR (dB) | Δ TTFT | Δ Cost | Violations |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
  ];

  for (const d of comparison.diffs) {
    const icon = d.status === 'PASS' ? '✅ PASS' : d.status === 'SKIPPED' ? '⚠️ SKIP' : '❌ FAIL';
    const recallStr = d.dRecall >= 0 ? `+${d.dRecall.toFixed(3)}` : `${d.dRecall.toFixed(3)}`;
    const accStr = d.dAccuracy >= 0 ? `+${d.dAccuracy.toFixed(1)}%` : `${d.dAccuracy.toFixed(1)}%`;
    const f1Str = d.dF1 >= 0 ? `+${d.dF1.toFixed(3)}` : `${d.dF1.toFixed(3)}`;
    const snrStr = d.dSnrDb >= 0 ? `+${d.dSnrDb.toFixed(1)} dB` : `${d.dSnrDb.toFixed(1)} dB`;
    const ttftStr = d.dTtft >= 0 ? `+${d.dTtft} ms` : `${d.dTtft} ms`;
    const costStr = d.dCost >= 0 ? `+$${d.dCost.toFixed(4)}` : `-$${Math.abs(d.dCost).toFixed(4)}`;
    const violStr = d.violations && d.violations.length > 0 ? d.violations.join('; ') : '—';

    lines.push(
      `| \`${d.model}\` | ${icon} | ${recallStr} | ${accStr} | ${f1Str} | ${snrStr} | ${ttftStr} | ${costStr} | ${violStr} |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Extract Executive Summary table markdown from full benchmark markdown report.
 */
export function extractExecutiveSummaryTable(markdownContent) {
  if (!markdownContent || typeof markdownContent !== 'string') {
    return '';
  }
  const tableMatch = markdownContent.match(
    /## 1\. Executive Summary & Comparative Matrix\s+([\s\S]*?)(?=\n## 2\.|\n#|$)/
  );
  return tableMatch ? tableMatch[1].trim() : '';
}

/**
 * Format benchmark digest block for GitHub Release notes.
 */
export function formatReleaseDigest(markdownContent, options = {}) {
  const version = options.version || (options.saveBaseline ? options.saveBaseline : 'latest');
  const repository =
    options.repository || process.env.GITHUB_REPOSITORY || 'calltelemetry/ct-review-bot';
  const table = extractExecutiveSummaryTable(markdownContent);

  const lines = [
    `## 🚀 Review Yeti Model Evaluation Matrix (${version})`,
    '',
    table || '*No executive summary table available.*',
    '',
    '### 📦 Evaluation Artifacts & Reports',
    `- 📊 **Full Benchmark Report (.md)**: [Download model-benchmark-matrix-${version}.md](https://github.com/${repository}/releases/download/${version}/model-benchmark-matrix-${version}.md)`,
    `- 🔢 **Benchmark Matrix Schema (.json)**: [Download model-benchmark-matrix-${version}.json](https://github.com/${repository}/releases/download/${version}/model-benchmark-matrix-${version}.json)`,
    '',
    '> *Generated automatically by the `evaluate-release-benchmark` regression quality gate suite.*',
  ];

  return lines.join('\n');
}

/**
 * Merge or append benchmark digest into existing GitHub Release notes cleanly.
 */
export function mergeReleaseNotes(existingNotes, benchmarkDigest) {
  const rawNotes = (existingNotes || '').trim();
  if (!rawNotes) {
    return benchmarkDigest;
  }

  // If previous digest exists, strip it out cleanly
  if (rawNotes.includes('Review Yeti Model Evaluation Matrix')) {
    let cleanedNotes = rawNotes
      .replace(/## 🚀 Review Yeti Model Evaluation Matrix[\s\S]*?(?=\n## (?!🚀)|$)/g, '')
      .trim();

    // Strip trailing markdown horizontal rules ('---' or '***')
    cleanedNotes = cleanedNotes.replace(/(?:\r?\n\s*[-*_]{3,}\s*)+$/, '').trim();

    if (!cleanedNotes) {
      return benchmarkDigest;
    }
    return `${cleanedNotes}\n\n---\n\n${benchmarkDigest}`;
  }

  // Strip trailing markdown horizontal rules if already present
  const baseNotes = rawNotes.replace(/(?:\r?\n\s*[-*_]{3,}\s*)+$/, '').trim();
  if (!baseNotes) {
    return benchmarkDigest;
  }
  return `${baseNotes}\n\n---\n\n${benchmarkDigest}`;
}

/**
 * Main execution flow.
 */
export async function main(argv = process.argv) {
  const options = parseCliArgs(argv);

  if (options.help) {
    showHelp();
    return { exitCode: 0 };
  }

  // Fast path: Extract digest directly from existing markdown report
  if (options.extractDigestFrom) {
    const targetPath = path.isAbsolute(options.extractDigestFrom)
      ? options.extractDigestFrom
      : path.resolve(process.cwd(), options.extractDigestFrom);
    if (!fs.existsSync(targetPath)) {
      console.error(`[!] Error: File not found: ${targetPath}`);
      return { exitCode: 1 };
    }
    const content = fs.readFileSync(targetPath, 'utf8');
    const versionMatch = path.basename(targetPath).match(/model-benchmark-matrix-(.+)\.md/);
    const inferredVersion = versionMatch ? versionMatch[1] : 'latest';
    const digest = formatReleaseDigest(content, {
      version: options.saveBaseline || inferredVersion,
      repository: options.repository,
    });
    console.log(digest);
    return { exitCode: 0, digest };
  }

  const targetScenarios = resolveScenarios(options);
  if (targetScenarios.length === 0) {
    console.error('[!] Error: No evaluation scenarios matched the specified filters.');
    return { exitCode: 1 };
  }

  if (options.live && !options.apiKey) {
    console.error(
      '[!] Error: --live mode requires OPENROUTER_API_KEY environment variable or --api-key flag.'
    );
    return { exitCode: 1 };
  }

  if (!options.json) {
    console.log(`\n=================================================================`);
    console.log(` Review Yeti Release Benchmark Harness`);
    console.log(` Mode: ${options.offline ? 'Deterministic Offline Replay' : 'Live OpenRouter Execution'}`);
    console.log(` Target Models (${options.models.length}): ${options.models.join(', ')}`);
    console.log(` Target Scenarios (${targetScenarios.length}): ${targetScenarios.map((s) => s.id).join(', ')}`);
    console.log(`=================================================================\n`);
  }

  const runner = new EvaluationRunner({
    offline: options.offline,
    apiKey: options.apiKey,
  });

  const baseReport = await runner.runBenchmarkSuite(options.models, targetScenarios, {
    offline: options.offline,
  });

  const report = {
    timestamp: baseReport.timestamp,
    ...(options.saveBaseline ? { version: options.saveBaseline } : {}),
    models: baseReport.models,
    scenarios: baseReport.scenarios,
    summary: baseReport.summary,
    detailedResults: baseReport.detailedResults,
  };

  const markdownReport = formatMarkdownReport(report);
  const jsonReport = formatJSONReport(report);
  const digest = formatReleaseDigest(markdownReport, {
    version: options.saveBaseline || 'latest',
    repository: options.repository,
  });

  // Baseline Persistence
  if (options.saveBaseline) {
    const baselinesDir = path.resolve(projectRoot, 'eval-baselines');
    if (!fs.existsSync(baselinesDir)) {
      fs.mkdirSync(baselinesDir, { recursive: true });
    }
    const jsonBaselinePath = path.join(
      baselinesDir,
      `model-benchmark-matrix-${options.saveBaseline}.json`
    );
    const mdBaselinePath = path.join(
      baselinesDir,
      `model-benchmark-matrix-${options.saveBaseline}.md`
    );

    fs.writeFileSync(jsonBaselinePath, jsonReport, 'utf8');
    fs.writeFileSync(mdBaselinePath, markdownReport, 'utf8');
    if (!options.json) {
      console.log(`[✓] Baseline matrix saved to:`);
      console.log(`    - ${jsonBaselinePath}`);
      console.log(`    - ${mdBaselinePath}\n`);
    }
  }

  // Custom File Output
  if (options.output) {
    const outPath = path.isAbsolute(options.output)
      ? options.output
      : path.resolve(process.cwd(), options.output);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const content = path.extname(outPath).toLowerCase() === '.json' ? jsonReport : markdownReport;
    fs.writeFileSync(outPath, content, 'utf8');
    if (!options.json) {
      console.log(`[✓] Output report written to: ${outPath}\n`);
    }
  }

  // Baseline Comparison
  let comparison = null;
  let comparisonMarkdown = '';
  if (options.compareBaseline) {
    const compPath = path.isAbsolute(options.compareBaseline)
      ? options.compareBaseline
      : path.resolve(process.cwd(), options.compareBaseline);
    comparison = evaluateRegressionGate(report, compPath);
    comparisonMarkdown = formatComparisonMarkdown(comparison, compPath);
  }

  // Terminal Output
  if (options.json) {
    const payload = comparison ? { ...report, baselineComparison: comparison } : report;
    console.log(JSON.stringify(payload, null, 2));
  } else if (options.formatDigest) {
    console.log(digest);
  } else {
    console.log(markdownReport);
    if (comparisonMarkdown) {
      console.log(comparisonMarkdown);
    }
  }

  // Quality Gate Regression Enforcement
  if (options.failOnRegression && comparison) {
    if (comparison.hasRegressions) {
      console.error(
        `\n[❌] REGRESSION QUALITY GATE FAILED: Regressions detected against baseline.`
      );
      return { exitCode: 1, report, comparison, markdownReport, jsonReport, digest };
    } else if (!options.json && !options.formatDigest) {
      console.log(`\n[✓] All regression quality gates passed cleanly.`);
    }
  }

  if (!options.json && !options.formatDigest) {
    console.log(`\n[✓] Release benchmark evaluation completed successfully.`);
  }

  return { exitCode: 0, report, comparison, markdownReport, jsonReport, digest };
}

// Direct Execution Entrypoint
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv)
    .then(({ exitCode }) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((err) => {
      console.error('[!] Evaluation execution failed:', err);
      process.exit(1);
    });
}
