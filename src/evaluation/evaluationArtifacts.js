'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EVALUATION_SCHEMA_VERSION } = require('./evaluationContracts');

function safeFilename(value) {
  return String(value || 'evaluation').replace(/[^a-z0-9._-]/giu, '-').slice(0, 120) || 'evaluation';
}

function defaultDirectory() {
  return path.resolve(process.cwd(), '.review-yeti/evaluations');
}

function renderEvaluationReport(value) {
  const receipt = value?.candidate && value?.baseline ? value : value || {};
  if (receipt.candidate && receipt.baseline || (Array.isArray(receipt.failures) && receipt.metrics)) {
    return [
      '# Review Yeti Evaluation Comparison',
      '',
      `- Status: **${receipt.status || 'INCONCLUSIVE'}**`,
      `- Failures: ${(receipt.failures || []).join(', ') || 'none'}`,
      '',
      '| Metric | Baseline | Candidate |',
      '|---|---:|---:|',
      ...Object.keys(receipt.metrics || {}).map((key) => `| ${key} | ${receipt.metrics[key] ?? 'n/a'} | |`),
      '',
    ].join('\n');
  }
  const usage = receipt.usage || {};
  const summary = receipt.summary || {};
  const scenarios = Array.isArray(receipt.scenarioResults) ? receipt.scenarioResults : [];
  return [
    '# Review Yeti Evaluation',
    '',
    `- Status: **${receipt.status || 'INCONCLUSIVE'}**`,
    `- Repository: \`${receipt.identity?.repository || 'unknown'}\``,
    `- Source SHA: \`${receipt.identity?.sourceSha || 'unknown'}\``,
    `- Fixture: \`${receipt.identity?.fixtureId || 'unknown'}\``,
    `- Mode: \`${receipt.request?.mode || 'unknown'}\``,
    `- Scenarios: ${scenarios.length}`,
    `- Tokens: ${usage.totalTokens ?? 0}`,
    `- Cost (USD): ${usage.costUSD ?? 'unavailable'}`,
    '',
    '## Summary',
    '',
    ...Object.entries(summary).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected | Latency (ms) |',
    '|---|---|---|---:|',
    ...scenarios.map((scenario) => `| ${scenario.id} | ${scenario.status} | ${scenario.expected || 'n/a'} | ${scenario.latencyMs ?? 'n/a'} |`),
    '',
  ].join('\n');
}

function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function writeEvaluationReceipt(receipt, { directory = defaultDirectory() } = {}) {
  if (!receipt || receipt.schemaVersion !== EVALUATION_SCHEMA_VERSION || !receipt.runId) throw new Error('invalid evaluation receipt');
  const targetDirectory = path.resolve(directory);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const stamp = safeFilename(receipt.completedAt || new Date().toISOString()).replace(/:/gu, '-');
  const stem = `${stamp}-${safeFilename(receipt.identity?.fixtureId)}-${safeFilename(receipt.runId)}`;
  const jsonPath = path.join(targetDirectory, `${stem}.json`);
  const markdownPath = path.join(targetDirectory, `${stem}.md`);
  writeAtomic(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
  writeAtomic(markdownPath, `${renderEvaluationReport(receipt)}\n`);
  return { jsonPath, markdownPath };
}

function readEvaluationReceipt(filePath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (!parsed || parsed.schemaVersion !== EVALUATION_SCHEMA_VERSION || !parsed.identity?.sourceSha || !parsed.request?.mode) throw new Error('invalid evaluation receipt');
  return parsed;
}

function listEvaluationReceipts(directory = defaultDirectory()) {
  const targetDirectory = path.resolve(directory);
  if (!fs.existsSync(targetDirectory)) return [];
  return fs.readdirSync(targetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(targetDirectory, entry.name);
      try {
        const receipt = readEvaluationReceipt(filePath);
        return {
          filePath,
          runId: receipt.runId,
          status: receipt.status,
          mode: receipt.request.mode,
          fixtureId: receipt.identity.fixtureId,
          sourceSha: receipt.identity.sourceSha,
          completedAt: receipt.completedAt,
        };
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
}

module.exports = {
  defaultDirectory,
  listEvaluationReceipts,
  readEvaluationReceipt,
  renderEvaluationReport,
  writeEvaluationReceipt,
};
