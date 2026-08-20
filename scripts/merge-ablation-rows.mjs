#!/usr/bin/env node
/**
 * Merges row-dumps from multiple evaluate-ablations.mjs --out runs (used to split one ablation's
 * repetitions across several sequential invocations that each fit a bounded wall-clock budget)
 * and recomputes arms/perFixture summaries over the combined row set -- the same summarizeArm/
 * summarizeByFixture this repo's own harness uses, not a second aggregation implementation.
 *
 *   node scripts/merge-ablation-rows.mjs --out merged.json batch1.json batch2.json ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeArm, summarizeByFixture } from './evaluate-ablations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputs = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith('--') && all[index - 1] !== '--out' && all[index - 1] !== '--fixture');
const outputPath = argument('--out', '');
const fixturePath = path.resolve(root, argument('--fixture', 'tests/fixtures/testing-charter/evaluation-matrix.json'));
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixtures;

if (!inputs.length) {
  console.error('usage: merge-ablation-rows.mjs --out merged.json batch1.json batch2.json ...');
  process.exit(1);
}

const reports = inputs.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
const mode = reports[0].mode;
const model = reports[0].model;
for (const report of reports) {
  if (report.mode !== mode) throw new Error(`mode mismatch: ${report.mode} vs ${mode}`);
}
const rows = reports.flatMap((report) => report.rows || []);
const armIds = [...new Set(rows.map((row) => row.arm))];
const totalRepetitions = reports.reduce((sum, report) => sum + Number(report.repetitions || 0), 0);
const totalWallClockMs = reports.reduce((sum, report) => sum + Number(report.wallClockMs || 0), 0);

const merged = {
  schemaVersion: 'ablation-eval-report-v1',
  mode,
  fixture: reports[0].fixture,
  model,
  fallbackModels: reports[0].fallbackModels,
  repetitions: totalRepetitions,
  batches: inputs.length,
  wallClockMs: totalWallClockMs,
  arms: armIds.map((armId) => summarizeArm(rows, armId, model)),
  perFixture: summarizeByFixture(rows, fixtures, armIds),
};

if (outputPath) {
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify({ ...merged, rows }, null, 2)}\n`);
}
console.log(JSON.stringify(merged, null, 2));
