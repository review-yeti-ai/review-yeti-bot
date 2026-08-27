#!/usr/bin/env node

/**
 * One-time, read-only OpenRouter qualification probe.
 *
 * This is deliberately separate from the Fireworks/Ollama comparison. It runs one direct
 * OpenRouter transport over a small fixture slice, writes only sanitized evidence, and cannot
 * publish a review, mutate policy, or authorize a provider switch.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadPolicy, validatePolicy } from './review-yeti-smoke.mjs';

export const QUALIFICATION_SCHEMA = 'review-yeti.openrouter-qualification.v1';
export const QUALIFY_CONFIRMATION = 'QUALIFY';
export const OPENROUTER_PROFILE = 'openrouter-direct-90s-24576-evaluation';
export const OPENROUTER_TRANSPORT = 'openrouter-fallback';
export const COMPARISON_EVALUATION_ARM = 'candidate';
export const OPENROUTER_TIMEOUT_MS = 90_000;
export const OPENROUTER_CONNECT_TIMEOUT_MS = 30_000;
export const OPENROUTER_MAX_OUTPUT_TOKENS = 24_576;
export const OPENROUTER_REASONING_EFFORT = 'high';
export const QUALIFICATION_CHILD_TIMEOUT_MS = 8 * 60_000;
// The gateway route is OpenRouter, but its response may identify the resolved
// upstream adapter as OpenInference. Keep this allowlist narrow so attribution
// remains fail-closed for every other provider label.
const OPENROUTER_RESPONSE_PROVIDERS = Object.freeze(['openrouter', 'openinference']);
export const FIXTURE_IDS = Object.freeze([
  'vacuous-default-value-test',
  'format-evadable-absence-guard',
  'clean-behavioural-guard',
]);
const PROFILE_KEY_NAMES = Object.freeze([
  'FIREWORKS_PR_REVIEW_API_KEY',
  'FIREWORKS_API_KEY',
  'OLLAMA_PR_REVIEW_API_KEY',
  'OLLAMA_API_KEY',
  'OPENROUTER_REVIEW_FLEET_KEY',
  'OPENROUTER_PR_REVIEW_API_KEY',
  'OPENROUTER_API_KEY',
]);
const SHA_PATTERN = /^[a-f0-9]{40,64}$/iu;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG_PATTERN = /^v1\.\d+\.\d+$/u;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/iu;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function normalizeChildTimeoutMs(value = QUALIFICATION_CHILD_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > QUALIFICATION_CHILD_TIMEOUT_MS) {
    throw new Error(`childTimeoutMs must be an integer between 1 and ${QUALIFICATION_CHILD_TIMEOUT_MS}ms`);
  }
  return parsed;
}

export function validateQualificationInput(input = {}) {
  if (input.confirm !== QUALIFY_CONFIRMATION) throw new Error(`confirm must equal ${QUALIFY_CONFIRMATION}`);
  if (!REPOSITORY_PATTERN.test(String(input.repository || ''))) throw new Error('repository must be owner/name');
  const prNumber = positiveInteger(input.prNumber, 'prNumber');
  for (const [label, value] of [['baseSha', input.baseSha], ['headSha', input.headSha], ['botSha', input.botSha], ['centralSha', input.centralSha]]) {
    if (!SHA_PATTERN.test(String(value || ''))) throw new Error(`${label} must be a full commit SHA`);
  }
  if (!RELEASE_TAG_PATTERN.test(String(input.botReleaseTag || ''))) throw new Error('botReleaseTag must be a v1.x.y release tag');
  if (String(input.baseSha).toLowerCase() === String(input.headSha).toLowerCase()) throw new Error('baseSha and headSha must differ');
  if (!path.isAbsolute(String(input.botRoot || ''))) throw new Error('botRoot must be an absolute checkout path');
  return {
    ...input,
    repository: String(input.repository),
    prNumber,
    baseSha: String(input.baseSha).toLowerCase(),
    headSha: String(input.headSha).toLowerCase(),
    botSha: String(input.botSha).toLowerCase(),
    centralSha: String(input.centralSha).toLowerCase(),
    botReleaseTag: String(input.botReleaseTag),
    botRoot: String(input.botRoot),
  };
}

export function buildTransportHandoff(policy) {
  const transports = validatePolicy(policy);
  const selected = transports.find((transport) => transport.name === OPENROUTER_TRANSPORT);
  if (!selected) throw new Error(`policy does not define the ${OPENROUTER_TRANSPORT} transport`);
  return [{
    ...selected,
    name: OPENROUTER_TRANSPORT,
    timeout_ms: OPENROUTER_TIMEOUT_MS,
    connect_timeout_ms: OPENROUTER_CONNECT_TIMEOUT_MS,
    max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
    reasoning_effort: OPENROUTER_REASONING_EFFORT,
    stream: true,
  }];
}

export async function verifyPullRequest({ repository, prNumber, baseSha, headSha, token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('a read-only GitHub token is required for exact-head verification');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
  });
  if (!response?.ok) throw new Error(`exact-head verification failed (http_${response?.status || 'unknown'})`);
  const payload = await response.json();
  if (String(payload?.base?.sha || '').toLowerCase() !== String(baseSha || '').toLowerCase()
    || String(payload?.head?.sha || '').toLowerCase() !== String(headSha || '').toLowerCase()) {
    throw new Error('exact-head verification failed: pull request coordinates changed');
  }
  return { repository, prNumber, baseSha, headSha };
}

export async function verifyBotRelease({ botSha, botReleaseTag, token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('a read-only GitHub token is required for bot release verification');
  if (!SHA_PATTERN.test(String(botSha || ''))) throw new Error('botSha must be a full commit SHA');
  if (!RELEASE_TAG_PATTERN.test(String(botReleaseTag || ''))) throw new Error('botReleaseTag must be a v1.x.y release tag');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const refResponse = await fetchImpl(`https://api.github.com/repos/review-yeti-ai/review-yeti-bot/git/ref/tags/${botReleaseTag}`, { headers });
  if (!refResponse?.ok) throw new Error(`bot release verification failed (http_${refResponse?.status || 'unknown'})`);
  const ref = await refResponse.json();
  let resolvedSha = ref?.object?.sha;
  if (ref?.object?.type === 'tag' && resolvedSha) {
    const tagResponse = await fetchImpl(`https://api.github.com/repos/review-yeti-ai/review-yeti-bot/git/tags/${resolvedSha}`, { headers });
    if (!tagResponse?.ok) throw new Error(`bot annotated tag verification failed (http_${tagResponse?.status || 'unknown'})`);
    resolvedSha = (await tagResponse.json())?.object?.sha;
  }
  if (String(resolvedSha || '').toLowerCase() !== String(botSha).toLowerCase()) {
    throw new Error(`bot release ${botReleaseTag} does not resolve to the requested botSha`);
  }
  const commitResponse = await fetchImpl(`https://api.github.com/repos/review-yeti-ai/review-yeti-bot/commits/${botSha}`, { headers });
  if (!commitResponse?.ok) throw new Error(`bot commit verification failed (http_${commitResponse?.status || 'unknown'})`);
  const commit = await commitResponse.json();
  if (commit?.commit?.verification?.verified !== true) throw new Error('bot release commit signature is not verified');
  return { botSha: String(botSha).toLowerCase(), botReleaseTag: String(botReleaseTag) };
}

export function buildArmEnvironment({ baseEnv = process.env, handoff, botSha, fixturePath }) {
  const activeKeyEnvs = new Set(handoff.map((transport) => transport.api_key_env));
  const environment = {
    ...baseEnv,
    GITHUB_ACTIONS: 'false',
    VITEST: 'true',
    PR_DIFF: 'qualification-fixture',
    REVIEW_YETI_TRANSPORTS: JSON.stringify(handoff),
    REVIEW_YETI_TRANSPORT_PLAN_B64: '',
    REVIEW_YETI_MAX_CONCURRENCY: '1',
    QUALIFICATION_ARM: 'openrouter',
    QUALIFICATION_BOT_SHA: botSha,
    QUALIFICATION_FIXTURE: fixturePath,
  };
  for (const keyName of PROFILE_KEY_NAMES) {
    if (!activeKeyEnvs.has(keyName)) delete environment[keyName];
  }
  delete environment.GITHUB_EVENT_PATH;
  delete environment.GITHUB_OUTPUT;
  delete environment.GITHUB_STEP_SUMMARY;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  delete environment.QUALIFICATION_GH_TOKEN;
  return environment;
}

export function runChild({ command, args, cwd, env, spawnImpl = spawn, timeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS, killGraceMs = 5_000 }) {
  const effectiveTimeoutMs = normalizeChildTimeoutMs(timeoutMs);
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, timedOut });
    };
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
      });
    } catch {
      finish({ exitCode: 1 });
      return;
    }
    child.once('error', () => {
      if (timedOut) return;
      finish({ exitCode: 1 });
    });
    child.once('close', (code) => {
      if (timedOut) return;
      finish({ exitCode: Number.isInteger(code) ? code : 1 });
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.error(`::error::OpenRouter qualification exceeded hard wall-clock limit (${effectiveTimeoutMs}ms)`);
      const signalProcessGroup = (signal) => {
        if (process.platform !== 'win32' && Number.isInteger(child?.pid) && child.pid > 0) {
          try { process.kill(-child.pid, signal); return; } catch {}
        }
        try { child.kill(signal); } catch {}
      };
      signalProcessGroup('SIGTERM');
      const grace = Number.isFinite(killGraceMs) && killGraceMs >= 0 ? killGraceMs : 5_000;
      killTimer = setTimeout(() => {
        signalProcessGroup('SIGKILL');
        finish({ exitCode: 124 });
      }, grace);
    }, effectiveTimeoutMs);
  });
}

function safeLabel(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return LABEL_PATTERN.test(normalized) ? normalized : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

export function summarizeRows(rows, exitCode) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const latencies = safeRows.map((row) => Number(row?.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const fixtureOutcomes = safeRows.slice(0, FIXTURE_IDS.length).map((row) => ({
    fixture_id: safeLabel(row?.fixtureId),
    category: row?.category === 'defect' || row?.category === 'clean' ? row.category : 'unknown',
    outcome: row?.errored ? 'error' : row?.category === 'defect' ? (row.detected ? 'detected' : 'miss') : row?.falsePositive ? 'false_positive' : 'clean',
    provider: safeLabel(row?.provider),
    transport: safeLabel(row?.transport),
    response_status: Number.isInteger(Number(row?.responseStatus)) ? Number(row.responseStatus) : null,
    attempt_count: Number.isInteger(Number(row?.attemptCount)) ? Number(row.attemptCount) : null,
  }));
  const responseAttempts = safeRows.flatMap((row) => Array.isArray(row?.responseAttempts) ? row.responseAttempts : []);
  const positivePrompt = safeRows.map((row) => Number(row?.usage?.promptTokens)).filter((value) => Number.isFinite(value) && value > 0);
  const positiveCompletion = safeRows.map((row) => Number(row?.usage?.completionTokens)).filter((value) => Number.isFinite(value) && value > 0);
  const positiveCosts = safeRows.map((row) => Number(row?.usage?.costUSD)).filter((value) => Number.isFinite(value) && value > 0);
  const providerAttributionValid = safeRows.every((row) => {
    if (!OPENROUTER_RESPONSE_PROVIDERS.includes(row?.provider) || row?.transport !== OPENROUTER_TRANSPORT) return false;
    const attempts = Array.isArray(row?.responseAttempts) ? row.responseAttempts : [];
    return attempts.every((attempt) => attempt?.provider === 'openrouter' && attempt?.transport === OPENROUTER_TRANSPORT);
  });
  const fixtureSetValid = safeRows.length === FIXTURE_IDS.length
    && new Set(safeRows.map((row) => row?.fixtureId)).size === FIXTURE_IDS.length
    && FIXTURE_IDS.every((fixtureId) => safeRows.some((row) => row?.fixtureId === fixtureId));
  const tokenTelemetryStatus = positivePrompt.length === safeRows.length && positiveCompletion.length === safeRows.length ? 'complete' : positivePrompt.length || positiveCompletion.length ? 'partial' : 'unavailable';
  const costTelemetryStatus = positiveCosts.length === safeRows.length ? 'complete' : positiveCosts.length ? 'partial' : 'unavailable';
  const malformedOutputRecoveries = safeRows.filter((row) => Array.isArray(row?.responseAttempts) && row.responseAttempts.some((attempt) => attempt?.outcome === 'malformed_output')).length;
  return {
    status: exitCode === 0 && safeRows.length > 0 ? 'completed' : 'failed',
    exit_code: exitCode,
    rows: safeRows.length,
    errored_runs: safeRows.filter((row) => row?.errored).length,
    detected_defect_runs: safeRows.filter((row) => row?.category === 'defect' && row?.detected).length,
    false_positive_runs: safeRows.filter((row) => row?.category === 'clean' && row?.falsePositive).length,
    malformed_output_recoveries: malformedOutputRecoveries,
    provider_attribution_valid: providerAttributionValid,
    fixture_set_valid: fixtureSetValid,
    latency_ms_median: percentile(latencies, 0.5),
    latency_ms_p95: percentile(latencies, 0.95),
    response_attempts: responseAttempts.length,
    recovery_attempts: responseAttempts.filter((attempt) => Number(attempt?.attempt) > 1).length,
    token_telemetry_status: tokenTelemetryStatus,
    prompt_tokens: tokenTelemetryStatus === 'complete' ? positivePrompt.reduce((sum, value) => sum + value, 0) : null,
    completion_tokens: tokenTelemetryStatus === 'complete' ? positiveCompletion.reduce((sum, value) => sum + value, 0) : null,
    cost_telemetry_status: costTelemetryStatus,
    cost_usd: costTelemetryStatus === 'complete' ? Number(positiveCosts.reduce((sum, value) => sum + value, 0).toFixed(6)) : null,
    fixture_outcomes: fixtureOutcomes,
  };
}

function readEvaluation(pathname, exitCode) {
  try {
    return summarizeRows(JSON.parse(readFileSync(pathname, 'utf8')).rows, exitCode);
  } catch {
    return summarizeRows([], exitCode);
  }
}

export function buildQualificationReceipt({ input, policy, handoff, evaluation, childTimedOut, childTimeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS, now = new Date().toISOString(), runId = 'manual' }) {
  const policyDigest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const contract = {
    transport: OPENROUTER_TRANSPORT,
    provider: 'openrouter',
    model: handoff[0].model,
    timeout_ms: handoff[0].timeout_ms,
    connect_timeout_ms: handoff[0].connect_timeout_ms,
    child_timeout_ms: normalizeChildTimeoutMs(childTimeoutMs),
    max_output_tokens: handoff[0].max_tokens,
    reasoning_effort: handoff[0].reasoning_effort,
    stream: handoff[0].stream === true,
    repetitions: 1,
    concurrency: 1,
  };
  const integrity = {
    exact_bot_sha_bound: SHA_PATTERN.test(String(input.botSha || '')),
    fixture_set_valid: evaluation.fixture_set_valid === true,
    provider_attribution_valid: evaluation.provider_attribution_valid === true,
    request_contract_valid: contract.stream && contract.max_output_tokens === OPENROUTER_MAX_OUTPUT_TOKENS && contract.reasoning_effort === OPENROUTER_REASONING_EFFORT,
    child_completed: childTimedOut !== true && evaluation.status === 'completed',
  };
  integrity.passed = Object.values(integrity).every(Boolean);
  return {
    schema: QUALIFICATION_SCHEMA,
    mode: 'one-time-manual-openrouter-probe',
    created_at: now,
    run_id: String(runId),
    exact_target: { repository: input.repository, pr_number: input.prNumber, base_sha: input.baseSha, head_sha: input.headSha },
    implementation_refs: { central_action_sha: input.centralSha, review_yeti_bot_sha: input.botSha, review_yeti_bot_release_tag: input.botReleaseTag },
    policy_sha256: policyDigest,
    fixture_ids: [...FIXTURE_IDS],
    prompt_contract: { evaluator_arm: COMPARISON_EVALUATION_ARM, charter: 'current-testing', synthetic_prompt_identity: 'single-fixed-fixture-contract' },
    request_contract: contract,
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

export async function runQualification({ input, policy, token, outputDir, fixturePath, fetchImpl = globalThis.fetch, spawnImpl = spawn, childTimeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS, now, runId } = {}) {
  const validated = validateQualificationInput(input);
  const loadedPolicy = policy || loadPolicy();
  const handoff = buildTransportHandoff(loadedPolicy);
  await verifyPullRequest({ ...validated, token, fetchImpl });
  await verifyBotRelease({ botSha: validated.botSha, botReleaseTag: validated.botReleaseTag, token, fetchImpl });
  const targetDir = path.resolve(outputDir || process.env.RUNNER_TEMP || '.', 'openrouter-qualification');
  mkdirSync(targetDir, { recursive: true });
  const fixture = fixturePath || path.join(validated.botRoot, 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json');
  const output = path.join(targetDir, 'openrouter-lanes.json');
  const env = buildArmEnvironment({ baseEnv: process.env, handoff, botSha: validated.botSha, fixturePath: fixture });
  const args = [
    path.join(validated.botRoot, 'scripts/evaluate-verified-publication.mjs'),
    'lanes', '--arm', COMPARISON_EVALUATION_ARM, '--fixture', fixture, '--fixtures', FIXTURE_IDS.join(','),
    '--repetitions', '1', '--concurrency', '1', '--out', output,
  ];
  console.log(`[openrouter qualification] dispatching one direct arm; child_timeout_ms=${normalizeChildTimeoutMs(childTimeoutMs)}`);
  const child = await runChild({ command: process.execPath, args, cwd: validated.botRoot, env, spawnImpl, timeoutMs: childTimeoutMs });
  const evaluation = readEvaluation(output, child.exitCode);
  const receipt = buildQualificationReceipt({ input: validated, policy: loadedPolicy, handoff, evaluation, childTimedOut: child.timedOut, childTimeoutMs, now, runId });
  const receiptPath = path.join(targetDir, 'openrouter-qualification-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const digest = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  return { receipt, receiptPath, digest };
}

async function main() {
  const result = await runQualification({
    input: {
      confirm: process.env.QUALIFY_CONFIRM,
      repository: process.env.QUALIFY_REPOSITORY,
      prNumber: process.env.QUALIFY_PR_NUMBER,
      baseSha: process.env.QUALIFY_BASE_SHA,
      headSha: process.env.QUALIFY_HEAD_SHA,
      botSha: process.env.QUALIFY_BOT_SHA,
      botReleaseTag: process.env.QUALIFY_BOT_RELEASE_TAG,
      centralSha: process.env.QUALIFY_CENTRAL_SHA,
      botRoot: process.env.QUALIFY_BOT_ROOT,
    },
    token: process.env.QUALIFICATION_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    outputDir: process.env.RUNNER_TEMP,
    runId: process.env.GITHUB_RUN_ID || 'manual',
  });
  console.log(`[OpenRouter qualification] receipt=${result.receiptPath} digest=${result.digest} status=${result.receipt.evaluation.status} integrity=${result.receipt.integrity_gate.passed} authoritative=none production-authority=unchanged publication=none`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `receipt-path=${result.receiptPath}\nreceipt-digest=${result.digest}\nintegrity=${String(result.receipt.integrity_gate.passed)}\n`, { flag: 'a' });
  }
  if (!result.receipt.integrity_gate.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`::error::OpenRouter qualification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
