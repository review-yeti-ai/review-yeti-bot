#!/usr/bin/env node
/**
 * REL-1074. Turn a test plan (scripts/ci/select-vitest-tests.mjs --out) into GitHub Actions job
 * outputs, or with --summary into a step-summary table.
 *
 *   node scripts/ci/plan-outputs.mjs plan.json >> "$GITHUB_OUTPUT"
 *   node scripts/ci/plan-outputs.mjs --summary plan.json >> "$GITHUB_STEP_SUMMARY"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The full suite always uses every shard; an incremental run uses as many as its size earns. */
export const FULL_SHARDS = 4;

export function shardCount(plan) {
  if (plan.mode === 'full') return FULL_SHARDS;
  const files = plan.tests.length;
  if (files === 0) return 0;
  if (files <= 25) return 1;
  if (files <= 80) return 2;
  if (files <= 160) return 3;
  return FULL_SHARDS;
}

export function planOutputs(plan) {
  if (!['full', 'subset', 'none'].includes(plan.mode)) throw new Error(`unknown plan mode '${plan.mode}'`);
  const shards = shardCount(plan);
  if (!Array.isArray(plan.postgresExcludes)) throw new Error('plan has no postgresExcludes list');
  return {
    mode: plan.mode,
    'shard-count': String(shards),
    shards: JSON.stringify(Array.from({ length: shards }, (_, index) => index + 1)),
    // The full suite runs from Vitest's own include globs, so it needs no file list.
    tests: JSON.stringify(plan.mode === 'full' ? [] : plan.tests),
    'postgres-tests': JSON.stringify(plan.postgresTests),
    // Postgres-backed files never run in the plain shards: there is no database there.
    'exclude-tests': JSON.stringify(plan.postgresExcludes),
    'reaper-acceptance': String(Boolean(plan.reaperAcceptance)),
  };
}

export function planSummary(plan) {
  const outputs = planOutputs(plan);
  const lines = [
    '## Test plan',
    '',
    `| mode | reason | changed files | Vitest files | Postgres files | shards |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `| ${plan.mode} | ${String(plan.reason).replace(/\|/gu, '\\|')} | ${plan.changed.length} | ${plan.mode === 'full' ? 'all' : plan.tests.length} | ${plan.postgresTests.length} | ${outputs['shard-count']} |`,
    '',
  ];
  if (plan.mode !== 'full' && plan.tests.length) {
    lines.push('<details><summary>Selected test files</summary>', '', ...plan.tests.map((file) => `- \`${file}\``), '', '</details>', '');
  }
  if (plan.changed.length) {
    lines.push('<details><summary>Changed files</summary>', '', ...plan.changed.map((file) => `- \`${file}\``), '', '</details>', '');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const summary = args[0] === '--summary';
  const file = summary ? args[1] : args[0];
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (summary) {
    process.stdout.write(planSummary(plan));
    return;
  }
  for (const [key, value] of Object.entries(planOutputs(plan))) {
    if (/[\r\n]/u.test(value)) throw new Error(`output ${key} must be a single line`);
    process.stdout.write(`${key}=${value}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
