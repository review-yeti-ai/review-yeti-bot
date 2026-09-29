#!/usr/bin/env node

/**
 * Review Yeti Concurrency Scaling, Rightsizing & Streaming Continuation Architecture E2E Test Runner
 * Architecture Requirements R1 to R6 (2026-09-28T14:03:29Z)
 * Location: tests/e2e/run-concurrency-scaling-e2e.mjs
 *
 * Executes the 4-Tier E2E test suite:
 * - Tier 1: Feature Coverage (F1 to F6 in isolation, 30 tests)
 * - Tier 2: Boundary & Corner Cases (F1 to F6 boundaries, 30 tests)
 * - Tier 3: Cross-Feature Combinations (8 pairwise interactions)
 * - Tier 4: Real-World Workload Scenarios (6 end-to-end workflows)
 * Total: 74 Tests
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

// ANSI Colors
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const gray = (s) => `\x1b[90m${s}\x1b[0m`;

console.log(bold(cyan('\n========================================================================')));
console.log(bold(cyan('  Review Yeti Concurrency Scaling & Streaming Continuation E2E Runner')));
console.log(bold(cyan('  R1–R6: Worker Rightsizing, Ephemeral emptyDir & Resumption Multiplexer')));
console.log(bold(cyan('========================================================================\n')));

console.log(gray(`Repository Root: ${REPO_ROOT}`));
console.log(gray(`Target Suite:    tests/e2e/concurrencyScalingE2E.test.ts\n`));

const startTime = Date.now();

// Execute Vitest with JSON reporter
const child = spawnSync('npx', ['vitest', 'run', 'tests/e2e/concurrencyScalingE2E.test.ts', '--reporter=json'], {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
  env: { ...process.env, CI: '1', NODE_ENV: 'test' },
});

const stdout = child.stdout || '';
const stderr = child.stderr || '';

const jsonStart = stdout.indexOf('{"numTotalTestSuites":');
if (jsonStart === -1) {
  console.error(red('Failed to locate Vitest JSON output in stdout:'));
  console.error(stdout);
  if (stderr) console.error(red('Stderr:'), stderr);
  process.exit(1);
}

let resultData;
try {
  resultData = JSON.parse(stdout.slice(jsonStart));
} catch (e) {
  console.error(red(`Failed to parse Vitest JSON report: ${e.message}`));
  process.exit(1);
}

const suite = resultData.testResults?.[0];
const assertions = suite?.assertionResults || [];

const tierResults = {
  'Tier 1 (Feature Coverage)': { passed: 0, failed: 0, total: 30, tests: [] },
  'Tier 2 (Boundary & Corner Cases)': { passed: 0, failed: 0, total: 30, tests: [] },
  'Tier 3 (Cross-Feature Combinations)': { passed: 0, failed: 0, total: 8, tests: [] },
  'Tier 4 (Real-World Workload Scenarios)': { passed: 0, failed: 0, total: 6, tests: [] },
};

let currentTierHeader = '';

for (const assertion of assertions) {
  const ancestors = assertion.ancestorTitles || [];
  let tierKey = 'Tier 1 (Feature Coverage)';
  if (ancestors.some((a) => a.includes('Tier 2'))) {
    tierKey = 'Tier 2 (Boundary & Corner Cases)';
  } else if (ancestors.some((a) => a.includes('Tier 3'))) {
    tierKey = 'Tier 3 (Cross-Feature Combinations)';
  } else if (ancestors.some((a) => a.includes('Tier 4'))) {
    tierKey = 'Tier 4 (Real-World Workload Scenarios)';
  }

  if (tierKey !== currentTierHeader) {
    currentTierHeader = tierKey;
    console.log(bold(`\n--- ${currentTierHeader} ---`));
  }

  const passed = assertion.status === 'passed';
  const durationMs = Math.round(assertion.duration || 0);

  if (passed) {
    tierResults[tierKey].passed++;
    console.log(`  ${green('✓')} ${assertion.title} ${gray(`(${durationMs}ms)`)}`);
  } else {
    tierResults[tierKey].failed++;
    console.log(`  ${red('✗')} ${assertion.title} ${gray(`(${durationMs}ms)`)}`);
    if (assertion.failureMessages?.length > 0) {
      console.log(red(`    ${assertion.failureMessages.join('\n    ')}`));
    }
  }

  tierResults[tierKey].tests.push({
    title: assertion.title,
    status: assertion.status,
    durationMs,
  });
}

const totalPassed = Object.values(tierResults).reduce((sum, t) => sum + t.passed, 0);
const totalFailed = Object.values(tierResults).reduce((sum, t) => sum + t.failed, 0);
const totalExpected = Object.values(tierResults).reduce((sum, t) => sum + t.total, 0);
const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

console.log(bold(cyan('\n========================================================================')));
console.log(bold(cyan('     Review Yeti Concurrency Scaling E2E Execution Summary')));
console.log(bold(cyan('========================================================================')));

for (const [name, stats] of Object.entries(tierResults)) {
  const pct = ((stats.passed / stats.total) * 100).toFixed(1);
  const statusStr = stats.passed === stats.total ? green(`${stats.passed} / ${stats.total} passed (${pct}%)`) : red(`${stats.passed} / ${stats.total} passed (${pct}%)`);
  console.log(`  ${name.padEnd(42)}: ${statusStr}`);
}

console.log(bold('------------------------------------------------------------------------'));
const overallPct = ((totalPassed / totalExpected) * 100).toFixed(1);
const overallStr = totalPassed === totalExpected
  ? green(`${totalPassed} / ${totalExpected} passed (${overallPct}%)`)
  : red(`${totalPassed} / ${totalExpected} passed (${overallPct}%)`);
console.log(`  ${bold('Total E2E Tests'.padEnd(42))}: ${bold(overallStr)}`);
console.log(`  ${'Total Duration'.padEnd(42)}: ${elapsedSec}s`);
console.log(`  ${'Final Exit Code'.padEnd(42)}: ${totalFailed === 0 ? green('0 (SUCCESS)') : red('1 (FAILURE)')}`);
console.log(bold(cyan('========================================================================\n')));

// Emit JSON summary block for CI and telemetry
const jsonReport = {
  suite: 'concurrencyScalingE2E',
  status: totalFailed === 0 && totalPassed === totalExpected ? 'PASSED' : 'FAILED',
  timestamp: new Date().toISOString(),
  durationSeconds: parseFloat(elapsedSec),
  metrics: {
    tier1: { passed: tierResults['Tier 1 (Feature Coverage)'].passed, total: 30 },
    tier2: { passed: tierResults['Tier 2 (Boundary & Corner Cases)'].passed, total: 30 },
    tier3: { passed: tierResults['Tier 3 (Cross-Feature Combinations)'].passed, total: 8 },
    tier4: { passed: tierResults['Tier 4 (Real-World Workload Scenarios)'].passed, total: 6 },
    overall: { passed: totalPassed, failed: totalFailed, total: totalExpected },
  },
};

console.log(bold('JSON Execution Report:'));
console.log(JSON.stringify(jsonReport, null, 2));

if (totalFailed > 0 || totalPassed !== totalExpected) {
  process.exit(1);
} else {
  process.exit(0);
}
