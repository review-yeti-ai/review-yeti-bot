#!/usr/bin/env node

/**
 * One-time, read-only OpenRouter qualification through the reviewed Pi workflow engine.
 *
 * This runner intentionally does not publish reviews, mutate central policy, or activate Pi.
 * It executes the same three synthetic Review Yeti fixtures twice, with at most three Pi rows
 * live at once, and writes one sanitized evidence receipt.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { verifyBotRelease, verifyPullRequest } from './openrouter-qualification.mjs';

export const PI_QUALIFICATION_SCHEMA = 'review-yeti.pi-openrouter-qualification.v1';
export const PI_QUALIFICATION_CONFIRMATION = 'QUALIFY_PI';
export const PI_AUTHORING_SHA = '13914bb18eceac4a222525dd84e57cb0594dd0ba';
export const PI_ENGINE_VERSION = '0.12.0';
export const PI_CODING_AGENT_VERSION = '0.84.2';
export const PI_AI_VERSION = '0.84.2';
export const PI_MODEL = 'openrouter/deepseek/deepseek-v4-flash-0731';
export const PI_REASONING_EFFORT = 'high';
export const PI_QUALIFICATION_CONCURRENCY = 3;
export const PI_WORKFLOW_CONCURRENCY = 1;
export const PI_QUALIFICATION_TIMEOUT_MS = 10 * 60_000;
export const PI_ROW_TIMEOUT_MS = 285_000;
export const PI_STAGE_TIMEOUT_MS = 270_000;
export const PI_HEARTBEAT_MS = 15_000;
export const PI_MAX_REPETITIONS = 2;
export const FIXTURE_IDS = Object.freeze([
  'vacuous-default-value-test',
  'format-evadable-absence-guard',
  'clean-behavioural-guard',
]);

const SHA_PATTERN = /^[a-f0-9]{40,64}$/iu;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG_PATTERN = /^v1\.\d+\.\d+$/u;
const SAFE_LABEL_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/iu;
const PROVIDER_ENV_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'FIREWORKS_PR_REVIEW_API_KEY',
  'GEMINI_API_KEY',
  'OLLAMA_API_KEY',
  'OLLAMA_PR_REVIEW_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_PR_REVIEW_API_KEY',
  'OPENROUTER_REVIEW_FLEET_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
]);

if (PI_ROW_TIMEOUT_MS * Math.ceil((FIXTURE_IDS.length * PI_MAX_REPETITIONS) / PI_QUALIFICATION_CONCURRENCY) > PI_QUALIFICATION_TIMEOUT_MS) {
  throw new Error('Pi row budget exceeds the ten-minute qualification deadline');
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function safeLabel(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SAFE_LABEL_PATTERN.test(normalized) ? normalized : null;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function normalizeRepetitions(value = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > PI_MAX_REPETITIONS) {
    throw new Error(`repetitions must be an integer between 1 and ${PI_MAX_REPETITIONS}`);
  }
  return parsed;
}

export function normalizePiQualificationInput(input = {}) {
  if (input.confirm !== PI_QUALIFICATION_CONFIRMATION) {
    throw new Error(`confirm must equal ${PI_QUALIFICATION_CONFIRMATION}`);
  }
  if (!REPOSITORY_PATTERN.test(String(input.repository || ''))) throw new Error('repository must be owner/name');
  const prNumber = positiveInteger(input.prNumber, 'prNumber');
  const repetitions = normalizeRepetitions(input.repetitions);
  for (const [label, value] of [
    ['baseSha', input.baseSha],
    ['headSha', input.headSha],
    ['botSha', input.botSha],
    ['centralSha', input.centralSha],
    ['ctMetaSha', input.ctMetaSha],
  ]) {
    if (!SHA_PATTERN.test(String(value || ''))) throw new Error(`${label} must be a full commit SHA`);
  }
  if (String(input.ctMetaSha).toLowerCase() !== PI_AUTHORING_SHA) {
    throw new Error(`ctMetaSha must equal the reviewed authoring SHA ${PI_AUTHORING_SHA}`);
  }
  if (!RELEASE_TAG_PATTERN.test(String(input.botReleaseTag || ''))) {
    throw new Error('botReleaseTag must be a v1.x.y release tag');
  }
  if (String(input.baseSha).toLowerCase() === String(input.headSha).toLowerCase()) {
    throw new Error('baseSha and headSha must differ');
  }
  for (const [label, value] of [
    ['botRoot', input.botRoot],
    ['ctMetaRoot', input.ctMetaRoot],
    ['piRuntimeRoot', input.piRuntimeRoot],
  ]) {
    if (!path.isAbsolute(String(value || ''))) throw new Error(`${label} must be an absolute path`);
  }
  return {
    ...input,
    repository: String(input.repository),
    prNumber,
    baseSha: String(input.baseSha).toLowerCase(),
    headSha: String(input.headSha).toLowerCase(),
    botSha: String(input.botSha).toLowerCase(),
    centralSha: String(input.centralSha).toLowerCase(),
    ctMetaSha: String(input.ctMetaSha).toLowerCase(),
    botReleaseTag: String(input.botReleaseTag),
    botRoot: String(input.botRoot),
    ctMetaRoot: String(input.ctMetaRoot),
    piRuntimeRoot: String(input.piRuntimeRoot),
    repetitions,
    model: PI_MODEL,
    piEngineVersion: PI_ENGINE_VERSION,
    piCodingAgentVersion: PI_CODING_AGENT_VERSION,
  };
}

export function buildPiIntent() {
  return {
    schema_version: 'ct-pi-workflow-intent.v1',
    name: 'review-yeti-pi-qualification',
    description: 'Manual read-only Review Yeti output-reliability qualification through Pi.',
    goal: 'Review the supplied synthetic pull-request diff under the supplied testing charter. Report only evidence-backed test-quality defects and avoid speculative findings.',
    topology: 'read-only-audit',
    trigger: 'manual',
    authority: 'evidence-only',
    publication: 'none',
    model: PI_MODEL,
    reasoning_effort: PI_REASONING_EFFORT,
    tools: ['read'],
    limits: {
      prompt_max_chars: 50_000,
      output_digest_max_chars: 10_000,
      agent_timeout_ms: PI_STAGE_TIMEOUT_MS,
      run_timeout_ms: PI_STAGE_TIMEOUT_MS,
      max_concurrency: PI_WORKFLOW_CONCURRENCY,
      max_findings: 3,
    },
  };
}

export function buildPiRuntimeTask({ fixture, charter }) {
  if (!fixture || typeof fixture.title !== 'string' || !Array.isArray(fixture.files)) {
    throw new Error('fixture must contain a title and changed files');
  }
  const changedFiles = fixture.files.map((file) => {
    const pathname = String(file?.path || '').trim();
    const patchText = String(file?.patch || '');
    if (!pathname || !patchText) throw new Error('each fixture file must contain path and patch');
    return [`FILE: ${pathname}`, 'PATCH:', patchText].join('\n');
  }).join('\n\n');
  return [
    'Review this synthetic pull-request change as the testing reviewer.',
    'The supplied title and patches are the complete review scope. Do not search outside this synthetic scope.',
    'Do not invent missing repository context. Return zero findings when the change is sound.',
    '',
    `Pull request title: ${fixture.title}`,
    '',
    'Testing reviewer charter:',
    String(charter || '').trim(),
    '',
    'Changed files:',
    changedFiles,
  ].join('\n');
}

function expectedFixturePairs(repetitions) {
  return new Set(FIXTURE_IDS.flatMap((fixtureId) => (
    Array.from({ length: repetitions }, (_, index) => JSON.stringify([fixtureId, index + 1]))
  )));
}

function fixtureSetIsValid(rows, repetitions) {
  const expected = expectedFixturePairs(repetitions);
  const observed = new Set();
  for (const row of rows) {
    const pair = JSON.stringify([row?.fixtureId, Number(row?.repetition)]);
    if (!expected.has(pair) || observed.has(pair)) return false;
    observed.add(pair);
  }
  return rows.length === expected.size && observed.size === expected.size;
}

function telemetryStatus(rows, keys) {
  const presentRows = rows.filter((row) => keys.every((key) => optionalNumber(row?.[key]) !== null)).length;
  if (rows.length > 0 && presentRows === rows.length) return 'complete';
  return presentRows > 0 ? 'partial' : 'unavailable';
}

export function summarizePiRows(rows, { repetitions = 1 } = {}) {
  const expectedRepetitions = normalizeRepetitions(repetitions);
  const safeRows = Array.isArray(rows) ? rows : [];
  const latencies = safeRows.map((row) => optionalNumber(row?.latencyMs)).filter((value) => value !== null).sort((a, b) => a - b);
  const providerAttributionValid = safeRows.length > 0 && safeRows.every((row) => row?.provider === 'openrouter' && row?.model === PI_MODEL);
  const fixtureSetValid = fixtureSetIsValid(safeRows, expectedRepetitions);
  const tokenTelemetryStatus = telemetryStatus(safeRows, ['inputTokens', 'outputTokens']);
  const costTelemetryStatus = telemetryStatus(safeRows, ['costUsd']);
  const fixtureOutcomes = safeRows.map((row) => ({
    fixture_id: safeLabel(row?.fixtureId),
    repetition: Number.isInteger(Number(row?.repetition)) ? Number(row.repetition) : null,
    category: row?.category === 'defect' || row?.category === 'clean' ? row.category : 'unknown',
    outcome: row?.errored ? 'error' : row?.category === 'defect' ? (row?.detected ? 'detected' : 'miss') : row?.falsePositive ? 'false_positive' : 'clean',
    first_attempt_parseable: row?.firstAttemptParseable === true,
    repair_attempts: Number.isInteger(Number(row?.repairAttempts)) ? Number(row.repairAttempts) : null,
    local_repair_count: Number.isInteger(Number(row?.localRepairCount)) ? Number(row.localRepairCount) : null,
    terminal_parsed: row?.terminalParsed === true,
    terminal_status: safeLabel(row?.terminalStatus),
    terminal_status_detail: safeLabel(row?.terminalStatusDetail),
    repair_reason: safeLabel(row?.repairReason),
    failure_class: safeLabel(row?.failureClass),
    launch_retries: Number.isInteger(Number(row?.launchRetries)) ? Number(row.launchRetries) : null,
    provider: safeLabel(row?.provider),
    observed_provider: safeLabel(row?.observedProvider),
    model: safeLabel(row?.model),
    latency_ms: optionalNumber(row?.latencyMs),
    input_tokens: optionalNumber(row?.inputTokens),
    output_tokens: optionalNumber(row?.outputTokens),
    cost_usd: optionalNumber(row?.costUsd),
    usage_attempts: Number.isInteger(Number(row?.usageAttempts)) ? Number(row.usageAttempts) : null,
    prompt_sha256: /^sha256:[a-f0-9]{64}$/u.test(String(row?.promptSha256 || '')) ? row.promptSha256 : null,
  }));
  return {
    status: fixtureSetValid ? 'completed' : 'incomplete',
    rows: safeRows.length,
    errored_runs: safeRows.filter((row) => row?.errored).length,
    detected_defect_runs: safeRows.filter((row) => row?.category === 'defect' && row?.detected).length,
    false_positive_runs: safeRows.filter((row) => row?.category === 'clean' && row?.falsePositive).length,
    first_attempt_parseable_runs: safeRows.filter((row) => row?.firstAttemptParseable).length,
    repaired_runs: safeRows.filter((row) => (Number(row?.repairAttempts) > 0 || Number(row?.localRepairCount) > 0) && row?.terminalParsed).length,
    model_repaired_runs: safeRows.filter((row) => Number(row?.repairAttempts) > 0 && row?.terminalParsed).length,
    locally_repaired_runs: safeRows.filter((row) => Number(row?.localRepairCount) > 0 && row?.terminalParsed).length,
    repair_attempts: safeRows.reduce((sum, row) => sum + (Number.isInteger(Number(row?.repairAttempts)) ? Number(row.repairAttempts) : 0), 0),
    local_repairs: safeRows.reduce((sum, row) => sum + (Number.isInteger(Number(row?.localRepairCount)) ? Number(row.localRepairCount) : 0), 0),
    terminal_parsed_runs: safeRows.filter((row) => row?.terminalParsed).length,
    provider_attribution_valid: providerAttributionValid,
    fixture_set_valid: fixtureSetValid,
    latency_ms_median: percentile(latencies, 0.5),
    latency_ms_p95: percentile(latencies, 0.95),
    token_telemetry_status: tokenTelemetryStatus,
    input_tokens: tokenTelemetryStatus === 'complete' ? safeRows.reduce((sum, row) => sum + Number(row.inputTokens), 0) : null,
    output_tokens: tokenTelemetryStatus === 'complete' ? safeRows.reduce((sum, row) => sum + Number(row.outputTokens), 0) : null,
    cost_telemetry_status: costTelemetryStatus,
    cost_usd: costTelemetryStatus === 'complete' ? Number(safeRows.reduce((sum, row) => sum + Number(row.costUsd), 0).toFixed(6)) : null,
    fixture_outcomes: fixtureOutcomes,
  };
}

function repeatedPromptIdentityIsValid(rows, repetitions) {
  if (repetitions === 1) return rows.every((row) => /^sha256:[a-f0-9]{64}$/u.test(String(row?.promptSha256 || '')));
  return FIXTURE_IDS.every((fixtureId) => {
    const selected = rows.filter((row) => row?.fixtureId === fixtureId);
    return selected.length === repetitions
      && selected.every((row) => row?.promptSha256 === selected[0]?.promptSha256)
      && /^sha256:[a-f0-9]{64}$/u.test(String(selected[0]?.promptSha256 || ''));
  });
}

function generatedArtifactIdentityIsValid(rows) {
  const keys = ['intentSha256', 'specSha256', 'resultSchemaSha256'];
  return rows.length > 0 && keys.every((key) => {
    const first = rows[0]?.[key];
    return /^sha256:[a-f0-9]{64}$/u.test(String(first || '')) && rows.every((row) => row?.[key] === first);
  });
}

export function buildPiQualificationReceipt({ input, rows, runId = 'manual', now = new Date().toISOString() }) {
  const repetitions = normalizeRepetitions(input.repetitions);
  const evaluation = summarizePiRows(rows, { repetitions });
  const integrity = {
    exact_refs_bound: [input.centralSha, input.ctMetaSha, input.botSha].every((value) => SHA_PATTERN.test(String(value || ''))),
    fixture_set_valid: evaluation.fixture_set_valid === true,
    provider_attribution_valid: evaluation.provider_attribution_valid === true,
    generated_artifact_identity_valid: generatedArtifactIdentityIsValid(rows),
    prompt_repetition_identity_valid: repeatedPromptIdentityIsValid(rows, repetitions),
    execution_contract_valid: PI_QUALIFICATION_CONCURRENCY === 3
      && PI_WORKFLOW_CONCURRENCY === 1
      && PI_ROW_TIMEOUT_MS * Math.ceil((FIXTURE_IDS.length * repetitions) / PI_QUALIFICATION_CONCURRENCY) <= PI_QUALIFICATION_TIMEOUT_MS,
  };
  integrity.passed = Object.values(integrity).every(Boolean);
  return {
    schema: PI_QUALIFICATION_SCHEMA,
    mode: 'one-time-manual-pi-openrouter-probe',
    created_at: now,
    run_id: String(runId),
    exact_target: {
      repository: input.repository,
      pr_number: input.prNumber,
      base_sha: input.baseSha,
      head_sha: input.headSha,
    },
    implementation_refs: {
      central_action_sha: input.centralSha,
      example_meta_pi_authoring_sha: input.ctMetaSha,
      review_yeti_bot_sha: input.botSha,
      review_yeti_bot_release_tag: input.botReleaseTag,
      pi_workflow_version: PI_ENGINE_VERSION,
      pi_coding_agent_version: PI_CODING_AGENT_VERSION,
      pi_ai_version: PI_AI_VERSION,
    },
    generated_contract: {
      intent_sha256: rows[0]?.intentSha256 || null,
      spec_sha256: rows[0]?.specSha256 || null,
      result_schema_sha256: rows[0]?.resultSchemaSha256 || null,
    },
    fixture_ids: [...FIXTURE_IDS],
    prompt_contract: {
      charter: 'current-testing',
      fixture_grading_metadata_excluded: true,
      same_prompt_within_fixture_repetitions: integrity.prompt_repetition_identity_valid,
      residual_difference: 'Pi authoring prompt and local control schema replace Review Yeti provider-native structured output; model, testing charter, titles, and changed-file patches are held constant.',
    },
    request_contract: {
      provider: 'openrouter',
      model: PI_MODEL,
      reasoning_effort: PI_REASONING_EFFORT,
      output_contract: 'pi-local-schema-and-targeted-repair',
      row_timeout_ms: PI_ROW_TIMEOUT_MS,
      qualification_timeout_ms: PI_QUALIFICATION_TIMEOUT_MS,
      repetitions,
      outer_concurrency: PI_QUALIFICATION_CONCURRENCY,
      workflow_max_concurrency: PI_WORKFLOW_CONCURRENCY,
      max_findings: 3,
      token_limit_status: 'unsupported-by-reviewed-pi-spec',
    },
    integrity_gate: integrity,
    authoritative_arm: 'none',
    production_authority: 'unchanged',
    activation_authorized: false,
    publication: 'none',
    provider_mutation: 'none',
    promotion_gate: 'manual_review_required',
    decision: 'evidence_only',
    evaluation,
  };
}

export function buildPiChildEnvironment({ baseEnv = process.env, openRouterApiKey }) {
  const environment = { ...baseEnv, OPENROUTER_API_KEY: openRouterApiKey };
  for (const key of PROVIDER_ENV_KEYS) delete environment[key];
  environment.OPENROUTER_API_KEY = openRouterApiKey;
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'QUALIFICATION_GH_TOKEN', 'GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) {
    delete environment[key];
  }
  return environment;
}

export function runPiRowChild({ args, cwd, env, timeoutMs = PI_ROW_TIMEOUT_MS, spawnImpl = spawn, killGraceMs = 5_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PI_ROW_TIMEOUT_MS) {
    throw new Error(`row timeout must be between 1 and ${PI_ROW_TIMEOUT_MS}ms`);
  }
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timeoutTimer;
    let killTimer;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve({ exitCode, timedOut });
    };
    try {
      child = spawnImpl(process.execPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
      });
    } catch {
      finish(1);
      return;
    }
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(Number.isInteger(code) ? code : 1));
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      const signalGroup = (signal) => {
        if (process.platform !== 'win32' && Number.isInteger(child?.pid) && child.pid > 0) {
          try { process.kill(-child.pid, signal); return; } catch {}
        }
        try { child.kill(signal); } catch {}
      };
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        finish(124);
      }, killGraceMs);
    }, timeoutMs);
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return output;
}

function fallbackRow(job, { timedOut = false } = {}) {
  return {
    fixtureId: job.fixture.id,
    repetition: job.repetition,
    provider: 'openrouter',
    model: PI_MODEL,
    firstAttemptParseable: false,
    repairAttempts: 0,
    localRepairCount: 0,
    terminalParsed: false,
    errored: true,
    timedOut,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    findings: [],
    failureClass: timedOut ? 'row_timeout' : 'row_process_failed',
  };
}

export async function runPiQualification({
  input,
  token,
  openRouterApiKey,
  outputDir,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  now,
  runId,
} = {}) {
  const validated = normalizePiQualificationInput(input);
  if (!openRouterApiKey) throw new Error('OpenRouter qualification credential is required');
  await verifyPullRequest({ ...validated, token, fetchImpl });
  await verifyBotRelease({ botSha: validated.botSha, botReleaseTag: validated.botReleaseTag, token, fetchImpl });

  const targetDir = path.resolve(outputDir || process.env.RUNNER_TEMP || '.', 'openrouter-qualification');
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const matrixPath = path.join(validated.botRoot, 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json');
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const fixtures = FIXTURE_IDS.map((fixtureId) => matrix.fixtures.find((fixture) => fixture.id === fixtureId));
  if (fixtures.some((fixture) => !fixture)) throw new Error('Pi qualification fixture set is incomplete');

  const require = createRequire(import.meta.url);
  const pipeline = require(path.join(validated.botRoot, '.github/workflows/pipelines/review-pipeline.js'));
  const persona = pipeline.PERSONA_CHARTERS.find((entry) => entry.id === (matrix.personaId || 'testing'));
  if (!persona) throw new Error('testing persona charter is unavailable');
  const { gradeFindings } = await import(pathToFileURL(path.join(validated.botRoot, 'scripts/evaluate-verified-publication.mjs')).href);

  const jobs = fixtures.flatMap((fixture) => (
    Array.from({ length: validated.repetitions }, (_, index) => ({ fixture, repetition: index + 1 }))
  ));
  const childEnvironment = buildPiChildEnvironment({ baseEnv: process.env, openRouterApiKey });
  const qualificationStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Date.now() - qualificationStartedAt;
    console.log(`::notice::Pi OpenRouter qualification active; elapsed=${Math.round(elapsed / 1000)}s remaining=${Math.max(0, Math.round((PI_QUALIFICATION_TIMEOUT_MS - elapsed) / 1000))}s hard_deadline=${PI_QUALIFICATION_TIMEOUT_MS}ms`);
  }, PI_HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  let childRows;
  try {
    childRows = await mapWithConcurrency(jobs, PI_QUALIFICATION_CONCURRENCY, async (job, index) => {
      const elapsed = Date.now() - qualificationStartedAt;
      const remaining = PI_QUALIFICATION_TIMEOUT_MS - elapsed - 5_000;
      if (remaining < 1) return fallbackRow(job, { timedOut: true });
      const childInputPath = path.join(targetDir, `pi-row-${index + 1}-input.json`);
      const childOutputPath = path.join(targetDir, `pi-row-${index + 1}-result.json`);
      const childInput = {
        fixture: { title: job.fixture.title, files: job.fixture.files },
        fixtureId: job.fixture.id,
        repetition: job.repetition,
        charter: persona.charter,
        ctMetaRoot: validated.ctMetaRoot,
        piRuntimeRoot: validated.piRuntimeRoot,
      };
      writeFileSync(childInputPath, `${JSON.stringify(childInput)}\n`, { mode: 0o600 });
      const child = await runPiRowChild({
        args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-pi-qualification-row.mjs'), '--input', childInputPath, '--out', childOutputPath],
        cwd: targetDir,
        env: childEnvironment,
        timeoutMs: Math.min(PI_ROW_TIMEOUT_MS, remaining),
        spawnImpl,
      });
      let row = fallbackRow(job, { timedOut: child.timedOut });
      try {
        row = JSON.parse(readFileSync(childOutputPath, 'utf8'));
      } catch {}
      const findings = Array.isArray(row.findings) ? row.findings : [];
      const grade = gradeFindings(job.fixture, findings, Boolean(row.errored));
      return { ...row, fixtureId: job.fixture.id, repetition: job.repetition, category: job.fixture.category, ...grade, findings: undefined };
    });
  } finally {
    clearInterval(heartbeat);
  }

  const receipt = buildPiQualificationReceipt({ input: validated, rows: childRows, runId, now });
  const receiptPath = path.join(targetDir, 'pi-openrouter-qualification-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { receipt, receiptPath, digest: sha256(JSON.stringify(receipt)) };
}

async function main() {
  const result = await runPiQualification({
    input: {
      confirm: process.env.QUALIFY_CONFIRM,
      repository: process.env.QUALIFY_REPOSITORY,
      prNumber: process.env.QUALIFY_PR_NUMBER,
      baseSha: process.env.QUALIFY_BASE_SHA,
      headSha: process.env.QUALIFY_HEAD_SHA,
      botSha: process.env.QUALIFY_BOT_SHA,
      botReleaseTag: process.env.QUALIFY_BOT_RELEASE_TAG,
      centralSha: process.env.QUALIFY_CENTRAL_SHA,
      ctMetaSha: process.env.QUALIFY_EXAMPLE_META_SHA,
      botRoot: process.env.QUALIFY_BOT_ROOT,
      ctMetaRoot: process.env.QUALIFY_EXAMPLE_META_ROOT,
      piRuntimeRoot: process.env.QUALIFY_PI_RUNTIME_ROOT,
      repetitions: process.env.QUALIFY_REPETITIONS,
    },
    token: process.env.QUALIFICATION_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    outputDir: process.env.RUNNER_TEMP,
    runId: process.env.GITHUB_RUN_ID || 'manual',
  });
  console.log(`[Pi OpenRouter qualification] receipt=${result.receiptPath} digest=${result.digest} status=${result.receipt.evaluation.status} integrity=${result.receipt.integrity_gate.passed} authoritative=none production-authority=unchanged publication=none`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `receipt-path=${result.receiptPath}\nreceipt-digest=${result.digest}\nintegrity=${String(result.receipt.integrity_gate.passed)}\n`, { flag: 'a' });
  }
  if (!result.receipt.integrity_gate.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`::error::Pi OpenRouter qualification failed: ${safeLabel(error?.code) || 'qualification_error'}`);
    process.exitCode = 1;
  });
}
