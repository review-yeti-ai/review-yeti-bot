#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runEvaluation, loadFixture, compareEvaluationReceipts } = require('../evaluation/evaluationRunner.js');
const { listEvaluationReceipts, readEvaluationReceipt, renderEvaluationReport, writeEvaluationReceipt } = require('../evaluation/evaluationArtifacts.js');

const DEFAULT_FIXTURE = 'tests/fixtures/review-intelligence/offline-promotion-matrix.json';

function gitSha(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(); }
  catch (_) { return 'a'.repeat(40); }
}

function write(output, text) {
  output.write(`${text}\n`);
}

function usage() {
  return [
    'Review Yeti Evaluation TUI',
    '',
    'Commands: r [fixture]  offline run',
    '          l [fixture] --yes  confirmed live run',
    '          c <baseline.json> <candidate.json>  compare',
    '          q  quit',
    '',
  ].join('\n');
}

function fallbackTable(rows) {
  if (!rows.length) return 'No evaluation receipts found.';
  return [
    '| Completed | Status | Mode | Fixture |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.completedAt} | ${row.status} | ${row.mode} | ${row.fixtureId} |`),
  ].join('\n');
}

function defaultDependencies() {
  return {
    input: process.stdin,
    output: process.stdout,
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

async function executeFixture(command, dependencies, fixturePath, mode) {
  const absoluteFixture = path.resolve(dependencies.cwd, fixturePath || DEFAULT_FIXTURE);
  const fixture = dependencies.loadFixture(absoluteFixture);
  const request = {
    mode,
    repository: dependencies.repository || process.env.GITHUB_REPOSITORY || 'local/repository',
    sourceSha: dependencies.sourceSha || process.env.GITHUB_SHA || gitSha(dependencies.cwd),
    fixtureId: path.basename(absoluteFixture, path.extname(absoluteFixture)),
    fixtureDigest: fixture.digest,
    fixturePath: fixture.absolutePath,
    repetitions: 1,
    concurrency: 1,
  };
  write(dependencies.output, `Run configuration: mode=${mode} fixture=${request.fixtureId}`);
  const receipt = await dependencies.runEvaluation(request, dependencies);
  const artifacts = dependencies.writeEvaluationReceipt(receipt, { directory: dependencies.directory || path.join(dependencies.cwd, '.review-yeti/evaluations') });
  write(dependencies.output, `Progress: ${receipt.status}`);
  write(dependencies.output, dependencies.renderEvaluationReport(receipt));
  write(dependencies.output, `Receipt: ${artifacts.jsonPath}`);
  return receipt.status === 'PASS' ? 0 : receipt.status === 'INCONCLUSIVE' ? 3 : 1;
}

export async function runEvaluationTui(supplied = {}) {
  const dependencies = { ...defaultDependencies(), ...supplied };
  const input = dependencies.input;
  const output = dependencies.output;
  const directory = dependencies.directory || path.join(dependencies.cwd, '.review-yeti/evaluations');
  const rows = dependencies.listEvaluationReceipts(directory);
  if (!input?.isTTY || !output?.isTTY) {
    write(output, fallbackTable(rows));
    return 0;
  }

  write(output, usage());
  write(output, fallbackTable(rows));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let exitCode = 0;
  try {
    for await (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) { write(output, usage()); continue; }
      const parts = line.split(/\s+/u);
      const command = parts.shift().toLowerCase();
      if (command === 'q' || command === 'quit' || command === 'exit') break;
      if (command === 'r') {
        try { exitCode = await executeFixture(command, dependencies, parts[0], 'offline'); }
        catch (error) { write(output, `Run failed: ${error.message}`); exitCode = 1; }
        continue;
      }
      if (command === 'l') {
        if (!parts.includes('--yes')) { write(output, 'Live evaluation requires: l <fixture> --yes'); exitCode = 2; continue; }
        try { exitCode = await executeFixture(command, dependencies, parts.find((part) => part !== '--yes'), 'live'); }
        catch (error) { write(output, `Run failed: ${error.message}`); exitCode = 1; }
        continue;
      }
      if (command === 'c') {
        if (parts.length < 2) { write(output, 'Compare requires: c <baseline.json> <candidate.json>'); exitCode = 2; continue; }
        try {
          const comparison = dependencies.compareEvaluationReceipts(
            dependencies.readEvaluationReceipt(path.resolve(dependencies.cwd, parts[0])),
            dependencies.readEvaluationReceipt(path.resolve(dependencies.cwd, parts[1])),
          );
          write(output, 'Comparison');
          write(output, dependencies.renderEvaluationReport(comparison));
          exitCode = comparison.status === 'PASS' ? 0 : comparison.status === 'INCONCLUSIVE' ? 3 : 1;
        } catch (error) { write(output, `Compare failed: ${error.message}`); exitCode = 1; }
        continue;
      }
      write(output, usage());
    }
  } finally {
    lines.close();
  }
  return exitCode;
}

if (process.argv[1]?.endsWith('evaluationTui.mjs')) process.exitCode = await runEvaluationTui();
