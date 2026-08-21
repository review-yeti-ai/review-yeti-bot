#!/usr/bin/env node

/**
 * Testing Charter Benchmark Evaluator
 * scripts/evaluate-testing-charter.mjs
 *
 * Runs evaluation scenarios across reviewer models including OpenRouter 5.6 Luna High
 * and baseline models (Claude 3.7 Sonnet, DeepSeek R1, GPT-4o, Gemini 2.5 Pro).
 *
 * Measures SNR, TTFT, Token Usage, Accuracy/Precision/Recall/F1, Turn Depth, and Cost Efficiency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
  getScenariosByCategory,
} = require('../src/evaluation/scenarios');

// Parse CLI arguments
const args = process.argv.slice(2);
const isLive = args.includes('--live');
const isOffline = args.includes('--offline') || !isLive;
const isJsonOutput = args.includes('--json');
const outputFileArg = args.find((a) => a.startsWith('--output='));
const outputPath = outputFileArg ? outputFileArg.split('=')[1] : null;

const modelsArg = args.find((a) => a.startsWith('--models='));
const categoryArg = args.find((a) => a.startsWith('--category='));

// Default model suite: DSv4 Flash, Luna, Qwen 3.8 27B, and Gemini 3.7 Flash (all High)
const DEFAULT_MODELS = [
  'deepseek/deepseek-v4-flash-0731:high',
  'openrouter/5.6-luna-high',
  'qwen/qwen-3.8-27b:high',
  'google/gemini-3.7-flash:high',
];

const targetModels = modelsArg
  ? modelsArg.split('=')[1].split(',').map((m) => m.trim())
  : DEFAULT_MODELS;

// Target scenarios: by category or testing charter or all
let targetScenarios;
if (categoryArg) {
  const cat = categoryArg.split('=')[1].trim();
  targetScenarios = getScenariosByCategory(cat);
} else {
  // Test charter scenarios plus key core scenarios
  const testingScenarios = getScenariosByCategory('testing');
  const allScenarios = getAllScenarios();
  targetScenarios = testingScenarios.length > 0 ? allScenarios : allScenarios;
}

async function main() {
  console.log(`\n=================================================================`);
  console.log(` Review Yeti Benchmark Runner — Testing Charter Evaluation`);
  console.log(` Mode: ${isOffline ? 'Deterministic Offline Replay' : 'Live OpenRouter Execution'}`);
  console.log(` Models (${targetModels.length}): ${targetModels.join(', ')}`);
  console.log(` Scenarios (${targetScenarios.length}): ${targetScenarios.map((s) => s.id).join(', ')}`);
  console.log(`=================================================================\n`);

  const runner = new EvaluationRunner({
    offline: isOffline,
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const report = await runner.runBenchmarkSuite(targetModels, targetScenarios, {
    offline: isOffline,
  });

  const markdown = formatMarkdownReport(report);
  const json = formatJSONReport(report);

  if (outputPath) {
    const ext = path.extname(outputPath).toLowerCase();
    const content = ext === '.json' ? json : markdown;
    fs.writeFileSync(outputPath, content, 'utf8');
    console.log(`Report successfully written to: ${outputPath}`);
  }

  if (isJsonOutput) {
    console.log(json);
  } else {
    console.log(markdown);
  }

  console.log(`\n[✓] Testing Charter benchmark evaluation completed successfully.`);
}

main().catch((err) => {
  console.error('[!] Evaluation execution failed:', err);
  process.exit(1);
});
