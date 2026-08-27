#!/usr/bin/env node

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PI_AI_VERSION,
  PI_CODING_AGENT_VERSION,
  PI_ENGINE_VERSION,
  PI_MODEL,
  PI_ROW_TIMEOUT_MS,
  buildPiIntent,
  buildPiRuntimeTask,
} from './pi-openrouter-qualification.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireAbsolute(value, label) {
  if (!path.isAbsolute(String(value || ''))) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

function packageVersion(requireFromRuntime, packageName) {
  const packagePath = requireFromRuntime.resolve(`${packageName}/package.json`);
  return JSON.parse(readFileSync(packagePath, 'utf8')).version;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'openrouter' ? 'openrouter' : null;
}

function normalizeModel(value, provider) {
  const model = String(value || '').trim();
  if (!model) return null;
  if (model === PI_MODEL) return model;
  if (provider === 'openrouter' && !model.startsWith('openrouter/')) return `openrouter/${model}`;
  return model;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function readTaskResult(runRoot, task) {
  const resultPath = path.resolve(runRoot, task.files.result);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  return { resultPath, result };
}

function resultArtifactPath(resultPath, result, artifactName) {
  const artifactRef = result?.artifacts?.[artifactName];
  if (typeof artifactRef !== 'string' || path.isAbsolute(artifactRef) || artifactRef.split('/').includes('..')) {
    throw new Error(`invalid ${artifactName} artifact reference`);
  }
  return path.resolve(path.dirname(resultPath), artifactRef);
}

function mapControlFindings(control) {
  const findings = Array.isArray(control?.findings) ? control.findings : [];
  return findings.slice(0, 3).flatMap((finding) => {
    const evidence = Array.isArray(finding?.evidence) ? finding.evidence : [];
    const anchor = evidence.find((entry) => typeof entry?.file === 'string' && entry.file.trim());
    if (!anchor || typeof finding?.claim !== 'string' || !finding.claim.trim()) return [];
    return [{
      path: anchor.file,
      line: Number.isInteger(Number(anchor.line_start)) ? Number(anchor.line_start) : 1,
      title: finding.claim,
      body: finding.claim,
      suggestion: '',
    }];
  });
}

async function runRow(input) {
  const ctMetaRoot = requireAbsolute(input.ctMetaRoot, 'ctMetaRoot');
  const piRuntimeRoot = requireAbsolute(input.piRuntimeRoot, 'piRuntimeRoot');
  const requireFromRuntime = createRequire(path.join(piRuntimeRoot, 'package.json'));
  const versions = {
    workflow: packageVersion(requireFromRuntime, '@agwab/pi-workflow'),
    codingAgent: packageVersion(requireFromRuntime, '@earendil-works/pi-coding-agent'),
    ai: packageVersion(requireFromRuntime, '@earendil-works/pi-ai'),
  };
  if (versions.workflow !== PI_ENGINE_VERSION || versions.codingAgent !== PI_CODING_AGENT_VERSION || versions.ai !== PI_AI_VERSION) {
    throw new Error('Pi runtime version drift');
  }

  const engineEntry = requireFromRuntime.resolve('@agwab/pi-workflow');
  const { runWorkflowSpec, waitForRun } = await import(pathToFileURL(engineEntry).href);
  const generatorPath = path.join(ctMetaRoot, 'plugins/ct-workflow/pi-package/runtime/workflow-generator.mjs');
  const { writeWorkflowCandidate } = await import(pathToFileURL(generatorPath).href);
  const runRoot = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'pi-openrouter-row-'));
  const startedAt = Date.now();
  try {
    const intent = buildPiIntent();
    const generated = writeWorkflowCandidate(intent, path.join(runRoot, 'workflows'));
    const candidateRoot = path.join(runRoot, 'workflows', intent.name);
    const generationReceipt = JSON.parse(readFileSync(path.join(candidateRoot, 'workflow-generation-receipt.json'), 'utf8'));
    const taskText = buildPiRuntimeTask({ fixture: input.fixture, charter: input.charter });
    let terminal;
    try {
      const launched = await runWorkflowSpec(path.join(candidateRoot, 'spec.json'), runRoot, { task: taskText });
      terminal = launched.status === 'running'
        ? await waitForRun(runRoot, launched.runId, PI_ROW_TIMEOUT_MS - 5_000)
        : launched;
    } catch {
      terminal = null;
    }

    const task = terminal?.tasks?.find((entry) => entry.stageId === 'audit') || terminal?.tasks?.[0];
    let control;
    let resultEnvelope;
    let terminalParsed = false;
    if (task?.status === 'completed') {
      try {
        const loadedResult = readTaskResult(runRoot, task);
        resultEnvelope = loadedResult.result;
        control = JSON.parse(readFileSync(resultArtifactPath(loadedResult.resultPath, resultEnvelope, 'control'), 'utf8'));
        terminalParsed = resultEnvelope?.outputValidation?.valid === true;
      } catch {}
    }
    const observedProvider = normalizeProvider(task?.usage?.provider || task?.usage?.attempts?.at(-1)?.provider);
    const observedModel = normalizeModel(task?.usage?.model || task?.usage?.attempts?.at(-1)?.model || task?.runtime?.model, observedProvider || 'openrouter');
    const usage = task?.usage?.aggregate || task?.usage || {};
    const repairAttempts = Number.isInteger(Number(task?.outputRetry?.attempts)) ? Number(task.outputRetry.attempts) : 0;
    const localRepairCount = Number.isInteger(Number(resultEnvelope?.outputValidation?.repairCount))
      ? Number(resultEnvelope.outputValidation.repairCount)
      : 0;
    return {
      fixtureId: String(input.fixtureId || ''),
      repetition: Number(input.repetition),
      provider: 'openrouter',
      observedProvider,
      model: PI_MODEL,
      observedModel,
      firstAttemptParseable: terminalParsed && repairAttempts === 0 && localRepairCount === 0,
      repairAttempts,
      localRepairCount,
      repairReason: task?.outputRetry?.reason || null,
      launchRetries: Number.isInteger(Number(task?.launchRetry?.attempts)) ? Number(task.launchRetry.attempts) : 0,
      terminalParsed,
      terminalStatus: terminal?.status || 'failed',
      terminalStatusDetail: task?.statusDetail || null,
      errored: terminal?.status !== 'completed' || !terminalParsed,
      timedOut: false,
      latencyMs: Date.now() - startedAt,
      inputTokens: numericOrNull(usage.inputTokens),
      outputTokens: numericOrNull(usage.outputTokens),
      costUsd: numericOrNull(usage.costUsd),
      usageAttempts: Array.isArray(task?.usage?.attempts) ? task.usage.attempts.length : numericOrNull(usage.attempts),
      promptSha256: `sha256:${await digestHex(taskText)}`,
      intentSha256: generationReceipt.intent_sha256,
      specSha256: generationReceipt.spec_sha256,
      resultSchemaSha256: generationReceipt.result_schema_sha256,
      findings: terminalParsed ? mapControlFindings(control) : [],
      generatedFiles: generated.files.length,
    };
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

async function digestHex(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(String(value)).digest('hex');
}

async function main() {
  const inputPath = requireAbsolute(argument('--input'), 'input');
  const outputPath = requireAbsolute(argument('--out'), 'out');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const row = await runRow(input);
  writeFileSync(outputPath, `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
  if (row.errored) process.exitCode = 1;
}

main().catch(() => {
  process.exitCode = 1;
});
