#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runEvaluation, loadFixture, compareEvaluationReceipts } = require('../evaluation/evaluationRunner.js');
const { listEvaluationReceipts, readEvaluationReceipt, renderEvaluationReport, writeEvaluationReceipt } = require('../evaluation/evaluationArtifacts.js');

export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2, INCONCLUSIVE: 3 });

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || fallback) : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function format(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function help() {
  return [
    'Review Yeti evaluation toolkit',
    '',
    'Commands:',
    '  review-yeti eval run --fixture <path> [--mode offline|live] [--yes]',
    '  review-yeti eval list [--directory <path>]',
    '  review-yeti eval compare --baseline <receipt> --candidate <receipt>',
    '  review-yeti eval report --receipt <receipt> [--format json|markdown|table]',
    '  review-yeti eval tui [--directory <path>]',
    '',
    'Live mode is always explicit and requires --yes. Offline mode never calls a provider.',
  ].join('\n');
}

function gitValue(args, cwd, fallback) {
  if (args) return args;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || fallback; }
  catch (_) { return fallback; }
}

function exitCodeForStatus(status) {
  if (status === 'PASS') return EXIT_CODES.PASS;
  if (status === 'INCONCLUSIVE') return EXIT_CODES.INCONCLUSIVE;
  return EXIT_CODES.FAIL;
}

function tableRows(rows) {
  if (!rows.length) return 'No evaluation receipts found.';
  return [
    '| Completed | Status | Mode | Fixture | Source SHA |',
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.completedAt} | ${row.status} | ${row.mode} | ${row.fixtureId} | ${row.sourceSha} |`),
  ].join('\n');
}

function defaultDependencies() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    runEvaluation,
    loadFixture,
    compareEvaluationReceipts,
    listEvaluationReceipts,
    readEvaluationReceipt,
    renderEvaluationReport,
    writeEvaluationReceipt,
  };
}

export async function runEvaluationCli(argv = process.argv.slice(2), supplied = {}) {
  const dependencies = { ...defaultDependencies(), ...supplied };
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const writeOut = (value) => stdout.write(`${value}\n`);
  const writeErr = (value) => stderr.write(`${value}\n`);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { writeOut(help()); return EXIT_CODES.PASS; }
  if (argv[0] !== 'eval') { writeErr('Usage: review-yeti eval <run|list|compare|report|tui>'); return EXIT_CODES.USAGE; }
  const command = argv[1];
  const args = argv.slice(2);
  if (!command || command === '--help' || command === '-h') { writeOut(help()); return EXIT_CODES.PASS; }

  if (command === 'list') {
    const rows = dependencies.listEvaluationReceipts(option(args, '--directory', path.join(dependencies.cwd, '.review-yeti/evaluations')));
    if (option(args, '--format') === 'json') writeOut(format(rows));
    else writeOut(tableRows(rows));
    return EXIT_CODES.PASS;
  }

  if (command === 'report') {
    const receiptPath = option(args, '--receipt');
    if (!receiptPath) { writeErr('--receipt is required'); return EXIT_CODES.USAGE; }
    try {
      const receipt = dependencies.readEvaluationReceipt(path.resolve(dependencies.cwd, receiptPath));
      writeOut(option(args, '--format') === 'json' ? format(receipt) : dependencies.renderEvaluationReport(receipt));
      return exitCodeForStatus(receipt.status);
    } catch (error) {
      writeErr(`Unable to read receipt: ${error.message}`);
      return EXIT_CODES.USAGE;
    }
  }

  if (command === 'compare') {
    const baselinePath = option(args, '--baseline');
    const candidatePath = option(args, '--candidate');
    if (!baselinePath || !candidatePath) { writeErr('--baseline and --candidate are required'); return EXIT_CODES.USAGE; }
    try {
      const comparison = dependencies.compareEvaluationReceipts(
        dependencies.readEvaluationReceipt(path.resolve(dependencies.cwd, baselinePath)),
        dependencies.readEvaluationReceipt(path.resolve(dependencies.cwd, candidatePath)),
      );
      writeOut(option(args, '--format') === 'json' ? format(comparison) : dependencies.renderEvaluationReport(comparison));
      return exitCodeForStatus(comparison.status);
    } catch (error) {
      writeErr(`Unable to compare receipts: ${error.message}`);
      return EXIT_CODES.USAGE;
    }
  }

  if (command === 'tui') {
    const { runEvaluationTui } = await import('../tui/evaluationTui.mjs');
    return runEvaluationTui({ ...dependencies, directory: option(args, '--directory') });
  }

  if (command !== 'run') { writeErr(`Unknown eval command: ${command}`); return EXIT_CODES.USAGE; }
  const fixturePath = option(args, '--fixture');
  if (!fixturePath) { writeErr('--fixture is required'); return EXIT_CODES.USAGE; }
  const mode = option(args, '--mode', 'offline');
  if (mode === 'live' && !hasFlag(args, '--yes')) {
    writeErr('Live evaluation makes provider calls. Re-run with --mode live --yes to confirm.');
    return EXIT_CODES.USAGE;
  }
  let fixture;
  try { fixture = dependencies.loadFixture(path.resolve(dependencies.cwd, fixturePath)); }
  catch (error) { writeErr(`Unable to load fixture: ${error.message}`); return EXIT_CODES.USAGE; }
  const sourceSha = option(args, '--source-sha', dependencies.sourceSha || process.env.GITHUB_SHA || gitValue(undefined, dependencies.cwd, 'a'.repeat(40)));
  const repository = option(args, '--repository', dependencies.repository || process.env.GITHUB_REPOSITORY || 'local/repository');
  const fixtureId = option(args, '--fixture-id', path.basename(fixture.absolutePath, path.extname(fixture.absolutePath)));
  const request = {
    mode,
    repository,
    sourceSha,
    fixtureId,
    fixtureDigest: fixture.digest,
    fixturePath: fixture.absolutePath,
    baselinePath: option(args, '--baseline'),
    repetitions: Number(option(args, '--repetitions', '1')),
    concurrency: Number(option(args, '--concurrency', '1')),
    outputDir: option(args, '--output-dir'),
  };
  writeErr(`Evaluation started: mode=${mode} fixture=${fixtureId} source=${sourceSha}`);
  const receipt = await dependencies.runEvaluation(request, dependencies);
  const artifacts = dependencies.writeEvaluationReceipt(receipt, { directory: request.outputDir || path.join(dependencies.cwd, '.review-yeti/evaluations') });
  const baselinePath = option(args, '--baseline');
  let comparison;
  if (baselinePath) {
    comparison = dependencies.compareEvaluationReceipts(dependencies.readEvaluationReceipt(path.resolve(dependencies.cwd, baselinePath)), receipt);
  }
  if (option(args, '--format') === 'json') writeOut(format({ receipt, artifacts, comparison }));
  else {
    writeOut(dependencies.renderEvaluationReport(receipt));
    if (comparison) writeOut(dependencies.renderEvaluationReport(comparison));
  }
  writeErr(`Evaluation completed: status=${receipt.status} receipt=${artifacts.jsonPath}`);
  return comparison ? exitCodeForStatus(comparison.status) : exitCodeForStatus(receipt.status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await runEvaluationCli();
  process.exitCode = exitCode;
}
