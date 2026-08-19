#!/usr/bin/env node
// Aggregates review-run-report.v1 JSON files into reviewer-noise metrics:
// per-persona flake rate + failure-class histogram, severity distribution,
// cross-persona finding overlap, and re-roll verdict variance by diff digest.
//
// Usage:
//   node scripts/run-report-summary.mjs <report.json|dir> [more...]
//
// Reports can be harvested from CI logs (`[RunReport] {...}` lines) or from
// the run-report-path artifact each action run emits.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { aggregateRunReports, RUN_REPORT_VERSION } = require('../src/telemetry/runReport.js');

function collectReportFiles(target) {
  const stats = fs.statSync(target);
  if (stats.isDirectory()) {
    return fs.readdirSync(target)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(target, name));
  }
  return [target];
}

function readReports(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.jsonl')) {
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: run-report-summary.mjs <report.json|reports-dir> [more...]');
  process.exit(2);
}

const reports = targets.flatMap(collectReportFiles).flatMap(readReports);
const skipped = reports.filter((report) => report?.schemaVersion !== RUN_REPORT_VERSION).length;
const summary = aggregateRunReports(reports);

console.log(`# Review Yeti run-report summary (${summary.reportCount} runs${skipped ? `, ${skipped} skipped` : ''})`);
console.log('');
console.log('| Persona | Runs | Failed | Failure rate | P0 | P1 | P2 | Failure classes |');
console.log('|---|---|---|---|---|---|---|---|');
for (const persona of summary.personas) {
  const classes = Object.entries(persona.failureClasses)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label}:${count}`)
    .join(', ') || '-';
  console.log(`| ${persona.persona} | ${persona.runs} | ${persona.failed} | ${(persona.failureRate * 100).toFixed(1)}% | ${persona.severity.P0} | ${persona.severity.P1} | ${persona.severity.P2} | ${classes} |`);
}
console.log('');
console.log(`Verdicts: ${Object.entries(summary.verdicts).map(([verdict, count]) => `${verdict}=${count}`).join(' ') || 'none'}`);
console.log(`Finding overlap: ${summary.overlap.totalOverlapFiles}/${summary.overlap.totalFlaggedFiles} flagged files cited by >1 persona`);
console.log(`Re-roll groups (same diff digest): ${summary.rerolls.groups}; with inconsistent verdicts: ${summary.rerolls.inconsistentVerdictGroups}`);
