#!/usr/bin/env node

/**
 * One-time, read-only Fireworks/Ollama operational-route comparison.
 *
 * This command is deliberately not part of the reusable review workflow. It verifies one
 * immutable PR coordinate, then runs the same paired fixture set and prompt identity through one
 * Fireworks-only plan and one Ollama-only plan in parallel. Neither arm can publish a comment,
 * check, review verdict, merge decision, or provider mutation. Production remains authoritative.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadPolicy, validatePolicy } from './review-yeti-smoke.mjs';

export const QUALIFICATION_SCHEMA = 'review-yeti.ollama-qualification.v7';
export const QUALIFY_CONFIRMATION = 'QUALIFY';
export const BASELINE_PROFILE = 'fireworks-high-150s-24576-control';
export const CANDIDATE_PROFILE = 'ollama-high-150s-24576-evaluation';
export const COMPARISON_EVALUATION_ARM = 'candidate';
export const COMPARISON_TIMEOUT_MS = 150_000;
export const COMPARISON_CONNECT_TIMEOUT_MS = 30_000;
export const COMPARISON_MAX_OUTPUT_TOKENS = 24_576;
export const COMPARISON_REASONING_EFFORT = 'high';
// This is a parent-process wall-clock guard, not a provider timeout. The child evaluator's
// streaming inactivity timer can reset while a provider keeps sending deltas, so the parent must
// still kill a hung arm before the workflow's 15-minute hard ceiling.
export const QUALIFICATION_CHILD_TIMEOUT_MS = 8 * 60_000;
const COMPARISON_REPETITIONS = 1;
const COMPARISON_CONCURRENCY = 1;
const MAX_MODEL_ATTEMPTS_PER_PRIMARY = 2;
const FIXTURE_CONTRACT = Object.freeze([
  ['vacuous-default-value-test', 'defect'],
  ['format-evadable-absence-guard', 'defect'],
  ['dual-cause-diagnostic-named-for-one', 'defect'],
  ['clean-behavioural-guard', 'clean'],
  ['clean-rename-only', 'clean'],
  ['active-skip-marker-left-in-suite', 'defect'],
  ['shared-module-state-order-dependent-test', 'defect'],
  ['table-driven-consolidation-preserves-coverage', 'clean'],
  ['function-scoped-fixture-avoids-shared-state', 'clean'],
  ['elixir-second-error-cause-untested', 'defect'],
  ['elixir-both-error-causes-covered', 'clean'],
  ['java-fixed-sleep-for-asynchronous-state', 'defect'],
  ['java-condition-wait-for-asynchronous-state', 'clean'],
]);
export const FIXTURE_IDS = Object.freeze(FIXTURE_CONTRACT.map(([fixtureId]) => fixtureId));
const EXPECTED_FIXTURE_CATEGORIES = new Map(FIXTURE_CONTRACT);
const EXPECTED_DEFECT_RUNS = FIXTURE_CONTRACT.filter(([, category]) => category === 'defect').length;
const EXPECTED_CLEAN_RUNS = FIXTURE_IDS.length - EXPECTED_DEFECT_RUNS;

const SHA_PATTERN = /^[a-f0-9]{40,64}$/iu;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PROFILE_KEY_NAMES = Object.freeze([
  'FIREWORKS_PR_REVIEW_API_KEY',
  'FIREWORKS_API_KEY',
  'OLLAMA_PR_REVIEW_API_KEY',
  'OLLAMA_API_KEY',
  'OPENROUTER_REVIEW_FLEET_KEY',
  'OPENROUTER_PR_REVIEW_API_KEY',
  'OPENROUTER_API_KEY',
]);
const OUTPUT_SHAPES = new Set(['direct_json_object', 'direct_json_array', 'fenced_json_object', 'fenced_json_array', 'embedded_json_object', 'valid_json_wrong_shape', 'truncated_json', 'no_json', 'empty_content']);
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'other', 'missing']);
const RESPONSE_MODES = new Set(['stream', 'buffered']);
const FINDINGS_SOURCES = new Set(['content', 'reasoning', 'none']);
const RESPONSE_SIZE_BUCKETS = new Set(['empty', 'tiny', 'small', 'medium', 'large', 'oversize']);
const OUTPUT_CONTRACT_MODES = new Set(['json_object', 'json_schema', 'prompt_validated_json', 'unknown']);
const OUTPUT_CONTRACT_SUPPORT = new Set(['accepted', 'rejected', 'unreported']);
const RESPONSE_ATTEMPT_OUTCOMES = new Set(['parsed', 'malformed_output', 'http_error', 'provider_error', 'transport_error']);
const RESPONSE_ATTEMPT_PROVIDERS = new Set(['fireworks', 'ollama', 'openrouter', 'anthropic', 'gemini', 'openai', 'default']);
const RESPONSE_ATTEMPT_FAILURE_CLASSES = new Set([
  'http_429',
  'http_4xx',
  'http_5xx',
  'timeout',
  'transient_socket',
  'provider_rate_limit',
  'provider_error',
  'malformed_output',
  'unknown',
]);
const RESPONSE_ATTEMPT_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'missing', 'other']);
const MAX_RESPONSE_ATTEMPTS = 8;

export function normalizeChildTimeoutMs(value = QUALIFICATION_CHILD_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > QUALIFICATION_CHILD_TIMEOUT_MS) {
    throw new Error(`childTimeoutMs must be an integer between 1 and ${QUALIFICATION_CHILD_TIMEOUT_MS}ms`);
  }
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function validateQualificationInput(input = {}) {
  if (input.confirm !== QUALIFY_CONFIRMATION) {
    throw new Error(`confirm must equal ${QUALIFY_CONFIRMATION}`);
  }
  if (!REPOSITORY_PATTERN.test(String(input.repository || ''))) {
    throw new Error('repository must be owner/name');
  }
  const prNumber = positiveInteger(input.prNumber, 'prNumber');
  for (const [label, value] of [['baseSha', input.baseSha], ['headSha', input.headSha], ['botSha', input.botSha], ['centralSha', input.centralSha]]) {
    if (!SHA_PATTERN.test(String(value || ''))) throw new Error(`${label} must be a full commit SHA`);
  }
  if (String(input.baseSha).toLowerCase() === String(input.headSha).toLowerCase()) {
    throw new Error('baseSha and headSha must differ');
  }
  if (!input.botRoot || !path.isAbsolute(String(input.botRoot))) {
    throw new Error('botRoot must be an absolute checkout path');
  }
  return {
    ...input,
    repository: String(input.repository),
    prNumber,
    baseSha: String(input.baseSha),
    headSha: String(input.headSha),
    botSha: String(input.botSha),
    centralSha: String(input.centralSha),
    botRoot: String(input.botRoot),
  };
}

export function buildTransportHandoff(policy, profile) {
  const transports = validatePolicy(policy);
  const transportName = profile === BASELINE_PROFILE
    ? 'fireworks'
    : profile === CANDIDATE_PROFILE
      ? 'ollama'
      : null;
  if (!transportName) throw new Error(`unsupported qualification profile: ${profile}`);
  const selected = transports.find((transport) => transport.name === transportName);
  if (!selected) throw new Error(`policy does not define the ${transportName} transport`);
  return [{
    ...selected,
    timeout_ms: COMPARISON_TIMEOUT_MS,
    connect_timeout_ms: COMPARISON_CONNECT_TIMEOUT_MS,
    max_tokens: COMPARISON_MAX_OUTPUT_TOKENS,
    reasoning_effort: COMPARISON_REASONING_EFFORT,
    stream: true,
  }];
}

export async function verifyPullRequest({ repository, prNumber, baseSha, headSha, token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('a read-only GitHub token is required for exact-head verification');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response?.ok) throw new Error(`exact-head verification failed (http_${response?.status || 'unknown'})`);
  const payload = await response.json();
  const observedBase = payload?.base?.sha;
  const observedHead = payload?.head?.sha;
  if (observedBase !== baseSha || observedHead !== headSha) {
    throw new Error('exact-head verification failed: the pull request base/head no longer match the requested coordinates');
  }
  return { repository, prNumber, baseSha, headSha };
}

export function buildArmEnvironment({ baseEnv = process.env, handoff, arm, botSha, fixturePath }) {
  const activeKeyEnvs = new Set(handoff.map((transport) => transport.api_key_env));
  const environment = {
    ...baseEnv,
    GITHUB_ACTIONS: 'false',
    VITEST: 'true',
    PR_DIFF: 'qualification-fixture',
    REVIEW_YETI_TRANSPORTS: JSON.stringify(handoff),
    REVIEW_YETI_TRANSPORT_PLAN_B64: '',
    REVIEW_YETI_MAX_CONCURRENCY: '1',
    QUALIFICATION_ARM: arm,
    QUALIFICATION_BOT_SHA: botSha,
    QUALIFICATION_FIXTURE: fixturePath,
  };
  // The child is a read-only fixture runner. Remove unrelated provider keys so an accidental
  // transport expansion cannot silently spend against another provider.
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

export function runChild({
  command,
  args,
  cwd,
  env,
  spawnImpl = spawn,
  timeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS,
  killGraceMs = 5_000,
}) {
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
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      finish({ exitCode: 1 });
      return;
    }
    child.once('error', () => finish({ exitCode: 1 }));
    child.once('close', (code) => finish({ exitCode: Number.isInteger(code) ? code : 1 }));
    if (effectiveTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        console.error(`::error::qualification arm exceeded hard wall-clock limit (${effectiveTimeoutMs}ms); terminating child`);
        try {
          child.kill('SIGTERM');
        } catch (_) {}
        const grace = Number.isFinite(killGraceMs) && killGraceMs >= 0 ? killGraceMs : 5_000;
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
          finish({ exitCode: 124 });
        }, grace);
      }, effectiveTimeoutMs);
    }
  });
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function classifyFailure(row = {}) {
  const text = `${row.error || ''} ${row.failureClass || ''} ${row.errorCode || ''}`.toLowerCase();
  if (!text.trim()) return 'unknown_error';
  if (/401|403|unauthori[sz]ed|forbidden|api.?key|credential/u.test(text)) return 'auth';
  if (/429|rate.?limit|quota|capacity|throttl/u.test(text)) return 'rate_limit';
  if (/5\d\d|upstream|bad.?gateway|service.?unavailable/u.test(text)) return 'upstream_5xx';
  if (/timeout|timed.?out|abort|stall|connect/u.test(text)) return 'timeout_or_connect';
  if (/parse|json|structured|findings|format|empty.?response/u.test(text)) return 'invalid_output';
  if (/fetch|network|socket|econn|enotfound|dns|tls/u.test(text)) return 'network';
  return 'provider_error';
}

function safeDiagnosticLabel(value, fallback = 'unknown') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/u.test(normalized)) return fallback;
  if (normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') return fallback;
  return normalized;
}

function safeDiagnosticStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : null;
}

function incrementNestedCount(target, key, label) {
  const bucket = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : (target[key] = {});
  bucket[label] = (bucket[label] || 0) + 1;
}

function safeLatency(value) {
  const latency = Number(value);
  return Number.isSafeInteger(latency) && latency >= 0 && latency <= 600_000 ? latency : null;
}

function safeAttemptCount(value) {
  const attempts = Number(value);
  return Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= 100 ? attempts : null;
}

function safeTokenCount(value) {
  const tokens = Number(value);
  return Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 1_000_000 ? tokens : null;
}

function safeRetryReasons(value) {
  if (!Array.isArray(value)) return [];
  return value.map((reason) => safeDiagnosticLabel(reason, '')).filter(Boolean).slice(0, 8);
}

function safeDiagnosticEnum(value, allowedValues) {
  return typeof value === 'string' && allowedValues.has(value) ? value : null;
}

function safeOutputContract(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    policy_declared: safeDiagnosticEnum(value.policyDeclared, OUTPUT_CONTRACT_MODES) || 'unknown',
    request_observed: safeDiagnosticEnum(value.requestObserved, OUTPUT_CONTRACT_MODES) || 'unknown',
    provider_supported: safeDiagnosticEnum(value.providerSupported, OUTPUT_CONTRACT_SUPPORT) || 'unreported',
    terminal_parsed: value.terminalParsed === true,
  };
}

function safeResponseAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RESPONSE_ATTEMPTS).map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const attempt = safeAttemptCount(entry.attempt);
    const outcome = safeDiagnosticEnum(entry.outcome, RESPONSE_ATTEMPT_OUTCOMES);
    if (attempt === null || attempt < 1 || !outcome) return null;
    const result = { attempt, outcome };
    const provider = safeDiagnosticEnum(entry.provider, RESPONSE_ATTEMPT_PROVIDERS);
    if (provider) result.provider = provider;
    const transport = safeDiagnosticEnum(entry.transport, RESPONSE_ATTEMPT_PROVIDERS);
    if (transport) result.transport = transport;
    const latency = safeLatency(entry.latencyMs);
    if (latency !== null) result.latency_ms = latency;
    const responseStatus = safeDiagnosticStatus(entry.responseStatus);
    if (responseStatus) result.response_status = responseStatus;
    const failureClass = safeDiagnosticEnum(entry.failureClass, RESPONSE_ATTEMPT_FAILURE_CLASSES);
    if (failureClass) result.failure_class = failureClass;
    const reasoningEffort = safeDiagnosticEnum(entry.reasoningEffort, RESPONSE_ATTEMPT_REASONING_EFFORTS);
    if (reasoningEffort) result.reasoning_effort = reasoningEffort;
    const maxOutputTokens = safeTokenCount(entry.maxOutputTokens);
    if (maxOutputTokens !== null) result.max_output_tokens = maxOutputTokens;
    const outputTokens = safeTokenCount(entry.outputTokens);
    if (outputTokens !== null) result.output_tokens = outputTokens;
    const outputShape = safeDiagnosticEnum(entry.outputShape, OUTPUT_SHAPES);
    if (outputShape) result.output_shape = outputShape;
    const finishReason = safeDiagnosticEnum(entry.finishReason, FINISH_REASONS);
    if (finishReason) result.finish_reason = finishReason;
    const responseMode = safeDiagnosticEnum(entry.responseMode, RESPONSE_MODES);
    if (responseMode) result.response_mode = responseMode;
    const findingsSource = safeDiagnosticEnum(entry.findingsSource, FINDINGS_SOURCES);
    if (findingsSource) result.findings_source = findingsSource;
    if (typeof entry.contentPresent === 'boolean') result.content_present = entry.contentPresent;
    if (typeof entry.reasoningPresent === 'boolean') result.reasoning_present = entry.reasoningPresent;
    const contentSizeBucket = safeDiagnosticEnum(entry.contentSizeBucket, RESPONSE_SIZE_BUCKETS);
    if (contentSizeBucket) result.content_size_bucket = contentSizeBucket;
    const reasoningSizeBucket = safeDiagnosticEnum(entry.reasoningSizeBucket, RESPONSE_SIZE_BUCKETS);
    if (reasoningSizeBucket) result.reasoning_size_bucket = reasoningSizeBucket;
    const outputContract = safeOutputContract(entry.outputContract);
    if (outputContract) result.output_contract = outputContract;
    return result;
  }).filter(Boolean);
}

function incrementCount(target, value) {
  if (value) target[value] = (target[value] || 0) + 1;
}

/**
 * Preserve enough per-fixture evidence to explain quality variance without retaining findings,
 * prompts, response bodies, or provider exception text.  Fixture ids and transport labels are
 * bounded allowlisted-shaped strings; outcome is derived from the already graded booleans.
 */
export function summarizeFixtureOutcomes(rows = []) {
  return rows.slice(0, 64).map((row, index) => {
    const category = row.category === 'defect' || row.category === 'clean' ? row.category : 'unknown';
    const outcome = row.errored
      ? 'error'
      : category === 'defect'
        ? (row.detected ? 'detected' : 'miss')
        : category === 'clean'
          ? (row.falsePositive ? 'false_positive' : 'clean')
          : 'unknown';
    const fixtureId = safeDiagnosticLabel(row.fixtureId, `row-${index + 1}`);
    const result = { fixture_id: fixtureId, category, outcome };
    const latency = safeLatency(row.latencyMs);
    if (latency !== null) result.latency_ms = latency;
    const provider = safeDiagnosticLabel(row.provider, '');
    if (provider) result.provider = provider;
    const transport = safeDiagnosticLabel(row.transport, '');
    if (transport) result.transport = transport;
    const responseStatus = safeDiagnosticStatus(row.responseStatus);
    if (responseStatus) result.response_status = responseStatus;
    const errorCode = safeDiagnosticLabel(row.errorCode, '');
    if (errorCode) result.error_code = errorCode;
    const attemptCount = safeAttemptCount(row.attemptCount);
    if (attemptCount !== null) result.attempt_count = attemptCount;
    const retryReasons = safeRetryReasons(row.retryReasons);
    if (retryReasons.length > 0) result.retry_reasons = retryReasons;
    const outputShape = safeDiagnosticEnum(row.outputShape, OUTPUT_SHAPES);
    if (outputShape) result.output_shape = outputShape;
    const finishReason = safeDiagnosticEnum(row.finishReason, FINISH_REASONS);
    if (finishReason) result.finish_reason = finishReason;
    const responseMode = safeDiagnosticEnum(row.responseMode, RESPONSE_MODES);
    if (responseMode) result.response_mode = responseMode;
    const findingsSource = safeDiagnosticEnum(row.findingsSource, FINDINGS_SOURCES);
    if (findingsSource) result.findings_source = findingsSource;
    if (typeof row.contentPresent === 'boolean') result.content_present = row.contentPresent;
    if (typeof row.reasoningPresent === 'boolean') result.reasoning_present = row.reasoningPresent;
    const contentSizeBucket = safeDiagnosticEnum(row.contentSizeBucket, RESPONSE_SIZE_BUCKETS);
    if (contentSizeBucket) result.content_size_bucket = contentSizeBucket;
    const reasoningSizeBucket = safeDiagnosticEnum(row.reasoningSizeBucket, RESPONSE_SIZE_BUCKETS);
    if (reasoningSizeBucket) result.reasoning_size_bucket = reasoningSizeBucket;
    const outputContract = safeOutputContract(row.outputContract);
    if (outputContract) result.output_contract = outputContract;
    const responseAttempts = safeResponseAttempts(row.responseAttempts);
    if (responseAttempts.length > 0) result.response_attempts = responseAttempts;
    return result;
  });
}

export function summarizeEvaluation(payload, exitCode) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const defects = rows.filter((row) => row.category === 'defect');
  const clean = rows.filter((row) => row.category === 'clean');
  const latencies = rows.map((row) => Number(row.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const positivePromptTokens = rows.map((row) => Number(row.usage?.promptTokens)).filter((value) => Number.isFinite(value) && value > 0);
  const positiveCompletionTokens = rows.map((row) => Number(row.usage?.completionTokens)).filter((value) => Number.isFinite(value) && value > 0);
  const positiveCosts = rows.map((row) => Number(row.usage?.costUSD)).filter((value) => Number.isFinite(value) && value > 0);
  const tokenTelemetryStatus = rows.length > 0
    && positivePromptTokens.length === rows.length
    && positiveCompletionTokens.length === rows.length
    ? 'complete'
    : positivePromptTokens.length > 0 || positiveCompletionTokens.length > 0
      ? 'partial'
      : 'unavailable';
  const costTelemetryStatus = rows.length > 0 && positiveCosts.length === rows.length
    ? 'complete'
    : positiveCosts.length > 0
      ? 'partial'
      : 'unavailable';
  const erroredRuns = rows.filter((row) => row.errored).length;
  const failureClasses = {};
  const failureClassesByProvider = {};
  const responseStatuses = {};
  const errorCodes = {};
  const outputShapes = {};
  const finishReasons = {};
  const responseModes = {};
  const findingsSources = {};
  const contentSizeBuckets = {};
  const reasoningSizeBuckets = {};
  const responseAttemptOutcomes = {};
  const firstAttemptOutputShapes = {};
  const firstAttemptFinishReasons = {};
  const firstAttemptFailureClasses = {};
  const firstAttemptReasoningEfforts = {};
  const firstAttemptMaxOutputTokens = {};
  const outputContractPolicyDeclared = {};
  const outputContractRequestObserved = {};
  const outputContractProviderSupported = {};
  const outputContractTerminalParsed = {};
  let outputContractTelemetryRows = 0;
  for (const row of rows) {
    incrementCount(outputShapes, safeDiagnosticEnum(row.outputShape, OUTPUT_SHAPES));
    incrementCount(finishReasons, safeDiagnosticEnum(row.finishReason, FINISH_REASONS));
    incrementCount(responseModes, safeDiagnosticEnum(row.responseMode, RESPONSE_MODES));
    incrementCount(findingsSources, safeDiagnosticEnum(row.findingsSource, FINDINGS_SOURCES));
    incrementCount(contentSizeBuckets, safeDiagnosticEnum(row.contentSizeBucket, RESPONSE_SIZE_BUCKETS));
    incrementCount(reasoningSizeBuckets, safeDiagnosticEnum(row.reasoningSizeBucket, RESPONSE_SIZE_BUCKETS));
    const outputContract = safeOutputContract(row.outputContract);
    if (outputContract) {
      outputContractTelemetryRows += 1;
      incrementCount(outputContractPolicyDeclared, outputContract.policy_declared);
      incrementCount(outputContractRequestObserved, outputContract.request_observed);
      incrementCount(outputContractProviderSupported, outputContract.provider_supported);
      incrementCount(outputContractTerminalParsed, String(outputContract.terminal_parsed));
    }
    const attempts = safeResponseAttempts(row.responseAttempts);
    for (const attempt of attempts) incrementCount(responseAttemptOutcomes, attempt.outcome);
    const firstAttempt = attempts[0];
    if (firstAttempt) {
      incrementCount(firstAttemptOutputShapes, firstAttempt.output_shape);
      incrementCount(firstAttemptFinishReasons, firstAttempt.finish_reason);
      incrementCount(firstAttemptFailureClasses, firstAttempt.failure_class);
      incrementCount(firstAttemptReasoningEfforts, firstAttempt.reasoning_effort);
      if (firstAttempt.max_output_tokens !== undefined) {
        incrementCount(firstAttemptMaxOutputTokens, String(firstAttempt.max_output_tokens));
      }
    }
  }
  for (const row of rows.filter((entry) => entry.errored)) {
    const label = classifyFailure(row);
    failureClasses[label] = (failureClasses[label] || 0) + 1;
    // Direct transports may not return a provider name on an error. Preserve the configured
    // transport as the bounded attribution fallback so a 404/401 cannot be reported only as
    // "unknown" in the qualification receipt.
    const provider = safeDiagnosticLabel(row.provider, '');
    const transport = safeDiagnosticLabel(row.transport, '');
    incrementNestedCount(failureClassesByProvider, provider || transport || 'unknown', label);
    const status = safeDiagnosticStatus(row.responseStatus);
    if (status) responseStatuses[status] = (responseStatuses[status] || 0) + 1;
    const errorCode = safeDiagnosticLabel(row.errorCode, '');
    if (errorCode) errorCodes[errorCode] = (errorCodes[errorCode] || 0) + 1;
  }
  return {
    exit_code: exitCode,
    status: exitCode === 0 && rows.length > 0 ? 'completed' : 'failed',
    rows: rows.length,
    errored_runs: erroredRuns,
    defect_runs: defects.length,
    detected_defect_runs: defects.filter((row) => row.detected).length,
    clean_runs: clean.length,
    false_positive_runs: clean.filter((row) => row.falsePositive).length,
    failure_classes: failureClasses,
    failure_classes_by_provider: failureClassesByProvider,
    response_statuses: responseStatuses,
    error_codes: errorCodes,
    output_shapes: outputShapes,
    finish_reasons: finishReasons,
    response_modes: responseModes,
    findings_sources: findingsSources,
    content_size_buckets: contentSizeBuckets,
    reasoning_size_buckets: reasoningSizeBuckets,
    output_contract_telemetry_status: rows.length > 0 && outputContractTelemetryRows === rows.length
      ? 'complete'
      : outputContractTelemetryRows > 0
        ? 'partial'
        : 'unavailable',
    output_contract_policy_declared: outputContractPolicyDeclared,
    output_contract_request_observed: outputContractRequestObserved,
    output_contract_provider_supported: outputContractProviderSupported,
    output_contract_terminal_parsed: outputContractTerminalParsed,
    response_attempt_outcomes: responseAttemptOutcomes,
    first_attempt_output_shapes: firstAttemptOutputShapes,
    first_attempt_finish_reasons: firstAttemptFinishReasons,
    first_attempt_failure_classes: firstAttemptFailureClasses,
    first_attempt_reasoning_efforts: firstAttemptReasoningEfforts,
    first_attempt_max_output_tokens: firstAttemptMaxOutputTokens,
    fixture_outcomes: summarizeFixtureOutcomes(rows),
    latency_ms_median: percentile(latencies, 0.5),
    latency_ms_p95: percentile(latencies, 0.95),
    token_telemetry_status: tokenTelemetryStatus,
    prompt_tokens: tokenTelemetryStatus === 'complete'
      ? positivePromptTokens.reduce((sum, value) => sum + value, 0)
      : null,
    completion_tokens: tokenTelemetryStatus === 'complete'
      ? positiveCompletionTokens.reduce((sum, value) => sum + value, 0)
      : null,
    cost_telemetry_status: costTelemetryStatus,
    cost_usd: costTelemetryStatus === 'complete'
      ? Number(positiveCosts.reduce((sum, cost) => sum + cost, 0).toFixed(6))
      : null,
  };
}

function readEvaluation(pathname, exitCode) {
  try {
    return summarizeEvaluation(JSON.parse(readFileSync(pathname, 'utf8')), exitCode);
  } catch {
    return summarizeEvaluation(null, exitCode);
  }
}

function buildArmQualityGate(arm = {}, expectedProfile, expectedTransport) {
  const outcomes = Array.isArray(arm.fixture_outcomes) ? arm.fixture_outcomes : [];
  const fixtureIds = outcomes.map((entry) => String(entry?.fixture_id || ''));
  const uniqueFixtureIds = new Set(fixtureIds);
  const fixtureSetComplete = fixtureIds.length === FIXTURE_IDS.length
    && uniqueFixtureIds.size === FIXTURE_IDS.length
    && FIXTURE_IDS.every((fixtureId) => uniqueFixtureIds.has(fixtureId));
  const fixtureCategoriesValid = outcomes.every((entry) => (
    EXPECTED_FIXTURE_CATEGORIES.get(String(entry?.fixture_id || '')) === entry?.category
  ));
  const malformedOutputRecoveries = outcomes.filter((entry) => (
    Array.isArray(entry?.response_attempts)
      && entry.response_attempts.some((attempt) => attempt?.outcome === 'malformed_output')
  )).length;
  const fixtureOutcomesComplete = outcomes.every((entry) => {
    const fixtureId = String(entry?.fixture_id || '');
    const expectedCategory = EXPECTED_FIXTURE_CATEGORIES.get(fixtureId);
    const expectedOutcome = expectedCategory === 'defect' ? 'detected' : 'clean';
    return expectedCategory !== undefined && entry?.category === expectedCategory && entry?.outcome === expectedOutcome;
  });
  const outputTelemetryComplete = outcomes.every((entry) => (
    OUTPUT_SHAPES.has(entry?.output_shape)
    && FINISH_REASONS.has(entry?.finish_reason)
    && RESPONSE_MODES.has(entry?.response_mode)
    && FINDINGS_SOURCES.has(entry?.findings_source)
    && typeof entry?.content_present === 'boolean'
    && typeof entry?.reasoning_present === 'boolean'
    && RESPONSE_SIZE_BUCKETS.has(entry?.content_size_bucket)
    && RESPONSE_SIZE_BUCKETS.has(entry?.reasoning_size_bucket)
  ));
  const responseAttemptTelemetryComplete = outcomes.every((entry) => {
    const attempts = Array.isArray(entry?.response_attempts) ? entry.response_attempts : [];
    const lastAttempt = attempts.at(-1);
    return attempts.length >= 1
      && attempts.length <= MAX_MODEL_ATTEMPTS_PER_PRIMARY
      && attempts.every((attempt, index) => (
        attempt?.attempt === index + 1
        && RESPONSE_ATTEMPT_OUTCOMES.has(attempt?.outcome)
        && attempt?.provider === expectedTransport
        && attempt?.transport === expectedTransport
        && Number.isSafeInteger(attempt?.latency_ms)
        && attempt.latency_ms >= 0
        && RESPONSE_ATTEMPT_REASONING_EFFORTS.has(attempt?.reasoning_effort)
        && Number.isSafeInteger(attempt?.max_output_tokens)
        && attempt.max_output_tokens > 0
        && RESPONSE_MODES.has(attempt?.response_mode)
        && FINISH_REASONS.has(attempt?.finish_reason)
        && (
          attempt.outcome === 'parsed' || attempt.outcome === 'malformed_output'
            ? OUTPUT_SHAPES.has(attempt?.output_shape)
              && FINDINGS_SOURCES.has(attempt?.findings_source)
              && typeof attempt?.content_present === 'boolean'
              && typeof attempt?.reasoning_present === 'boolean'
              && RESPONSE_SIZE_BUCKETS.has(attempt?.content_size_bucket)
              && RESPONSE_SIZE_BUCKETS.has(attempt?.reasoning_size_bucket)
              && attempt?.response_status === '200'
            : attempt.outcome === 'http_error'
              ? typeof attempt?.response_status === 'string'
              : RESPONSE_ATTEMPT_FAILURE_CLASSES.has(attempt?.failure_class)
        )
      ))
      && lastAttempt?.outcome === 'parsed'
      && lastAttempt?.output_shape === entry.output_shape
      && lastAttempt?.finish_reason === entry.finish_reason
      && lastAttempt?.response_mode === entry.response_mode
      && lastAttempt?.findings_source === entry.findings_source;
  });
  const attemptTelemetryConsistent = responseAttemptTelemetryComplete && outcomes.every((entry) => {
    const attempts = entry.response_attempts;
    const retriedMalformedOutput = attempts.some((attempt) => attempt.outcome === 'malformed_output');
    return retriedMalformedOutput === (Array.isArray(entry.retry_reasons) && entry.retry_reasons.includes('malformed_output'));
  });
  const firstAttemptContractObserved = responseAttemptTelemetryComplete
    && arm.profile === expectedProfile
    && outcomes.every((entry) => (
      entry.response_attempts[0]?.provider === expectedTransport
      && entry.response_attempts[0]?.transport === expectedTransport
      && entry.response_attempts[0]?.reasoning_effort === COMPARISON_REASONING_EFFORT
      && entry.response_attempts[0]?.max_output_tokens === COMPARISON_MAX_OUTPUT_TOKENS
    ));
  const terminalParseabilityComplete = responseAttemptTelemetryComplete && outcomes.every((entry) => {
    const lastAttempt = entry.response_attempts.at(-1);
    const sourcePresent = entry.findings_source === 'content'
      ? entry.content_present === true && entry.content_size_bucket !== 'empty'
      : entry.findings_source === 'reasoning'
        ? entry.reasoning_present === true && entry.reasoning_size_bucket !== 'empty'
        : false;
    return lastAttempt?.outcome === 'parsed'
      && entry.output_shape === 'direct_json_object'
      && entry.response_mode === 'stream'
      && sourcePresent;
  });
  const finishReasonTelemetryComplete = responseAttemptTelemetryComplete && outcomes.every((entry) => (
    entry.response_attempts.every((attempt) => attempt.finish_reason !== 'missing')
  ));
  const integrityPassed = arm.status === 'completed'
    && arm.exit_code === 0
    && arm.rows === FIXTURE_IDS.length
    && arm.errored_runs === 0
    && arm.defect_runs === EXPECTED_DEFECT_RUNS
    && arm.clean_runs === EXPECTED_CLEAN_RUNS
    && fixtureSetComplete
    && fixtureCategoriesValid
    && outputTelemetryComplete
    && attemptTelemetryConsistent
    && firstAttemptContractObserved
    && terminalParseabilityComplete;
  const passed = integrityPassed
    && arm.detected_defect_runs === EXPECTED_DEFECT_RUNS
    && arm.false_positive_runs === 0
    && fixtureSetComplete
    && fixtureOutcomesComplete
    && malformedOutputRecoveries === 0
    && terminalParseabilityComplete;
  return {
    required_profile: expectedProfile,
    required_transport: expectedTransport,
    required_rows: FIXTURE_IDS.length,
    required_defect_detections: EXPECTED_DEFECT_RUNS,
    required_clean_false_positives: 0,
    required_malformed_output_recoveries: 0,
    fixture_set_complete: fixtureSetComplete,
    fixture_categories_valid: fixtureCategoriesValid,
    output_telemetry_complete: outputTelemetryComplete,
    response_attempt_telemetry_complete: responseAttemptTelemetryComplete,
    response_attempt_telemetry_consistent: attemptTelemetryConsistent,
    required_first_attempt_reasoning_effort: COMPARISON_REASONING_EFFORT,
    required_first_attempt_max_output_tokens: COMPARISON_MAX_OUTPUT_TOKENS,
    first_attempt_contract_observed: firstAttemptContractObserved,
    required_output_shape: 'direct_json_object',
    required_response_mode: 'stream',
    terminal_parseability_complete: terminalParseabilityComplete,
    finish_reason_telemetry_complete: finishReasonTelemetryComplete,
    observed_malformed_output_recoveries: malformedOutputRecoveries,
    integrity_passed: integrityPassed,
    passed,
  };
}

export function buildCandidateQualityGate(candidate = {}) {
  return buildArmQualityGate(candidate, CANDIDATE_PROFILE, 'ollama');
}

export function buildBaselineQualityGate(baseline = {}) {
  return buildArmQualityGate(baseline, BASELINE_PROFILE, 'fireworks');
}

export function buildQualificationReceipt({
  input,
  policy,
  baseline,
  candidate,
  childTimeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS,
  now = new Date().toISOString(),
  runId = 'manual',
}) {
  const effectiveChildTimeoutMs = normalizeChildTimeoutMs(childTimeoutMs);
  const policyDigest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const baselineQualityGate = buildBaselineQualityGate(baseline);
  const candidateQualityGate = buildCandidateQualityGate(candidate);
  const comparisonIntegrityGate = {
    baseline_integrity_passed: baselineQualityGate.integrity_passed,
    candidate_integrity_passed: candidateQualityGate.integrity_passed,
    prompt_contract_equal: true,
    exact_bot_sha_bound: SHA_PATTERN.test(String(input.botSha || '')),
    passed: baselineQualityGate.integrity_passed
      && candidateQualityGate.integrity_passed
      && SHA_PATTERN.test(String(input.botSha || '')),
  };
  const candidateNotWorseOnDefectRecall = Number(candidate.detected_defect_runs) >= Number(baseline.detected_defect_runs);
  const candidateQualityEligibleForAggregate = comparisonIntegrityGate.passed
    && candidateQualityGate.passed
    && candidateNotWorseOnDefectRecall;
  const baselineTransport = buildTransportHandoff(policy, BASELINE_PROFILE)[0];
  const candidateTransport = buildTransportHandoff(policy, CANDIDATE_PROFILE)[0];
  const commonRequestContract = {
    timeout_ms: COMPARISON_TIMEOUT_MS,
    connect_timeout_ms: COMPARISON_CONNECT_TIMEOUT_MS,
    child_timeout_ms: effectiveChildTimeoutMs,
    reasoning_effort: COMPARISON_REASONING_EFFORT,
    max_output_tokens: COMPARISON_MAX_OUTPUT_TOKENS,
    stream: true,
    repetitions: COMPARISON_REPETITIONS,
    concurrency: COMPARISON_CONCURRENCY,
  };
  const armRequestContract = (transport) => ({
    transport: transport.name,
    model_sha256: createHash('sha256').update(String(transport.model || '')).digest('hex'),
    ...commonRequestContract,
  });
  return {
    schema: QUALIFICATION_SCHEMA,
    mode: 'one-time-manual-provider-comparison',
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
      review_yeti_bot_sha: input.botSha,
    },
    policy_sha256: policyDigest,
    baseline_profile: BASELINE_PROFILE,
    candidate_profile: CANDIDATE_PROFILE,
    prompt_contract: {
      evaluator_arm: COMPARISON_EVALUATION_ARM,
      charter: 'current-testing',
      synthetic_prompt_identity_equal: true,
      exact_bot_sha_bound: true,
    },
    common_request_contract: commonRequestContract,
    contract_evidence: {
      attempt_observed: ['provider', 'transport', 'reasoning_effort', 'max_output_tokens', 'response_mode'],
      handoff_only_not_runtime_observed: ['timeout_ms', 'connect_timeout_ms', 'model_sha256'],
      prompt_identity: 'central_spawn_contract',
    },
    baseline_request_contract: armRequestContract(baselineTransport),
    candidate_request_contract: armRequestContract(candidateTransport),
    route_sampling_residual: {
      comparison_scope: 'configured_operational_routes',
      same_sampler_claim_allowed: false,
      contract: 'provider_specific_defaults_from_exact_bot_sha',
      values_observed_in_receipt: false,
    },
    fixture_ids: [...FIXTURE_IDS],
    planned_primary_requests_per_arm: FIXTURE_IDS.length * COMPARISON_REPETITIONS,
    max_model_attempts_per_arm: FIXTURE_IDS.length * COMPARISON_REPETITIONS * MAX_MODEL_ATTEMPTS_PER_PRIMARY,
    minimum_independent_runs_for_decision: 3,
    independent_runs_in_receipt: 1,
    authoritative_arm: 'none',
    production_authority: 'unchanged',
    activation_authorized: false,
    single_run_decision: 'evidence_only',
    publication: 'none',
    provider_mutation: 'none',
    promotion_gate: 'manual_review_required',
    comparison_integrity_gate: comparisonIntegrityGate,
    baseline_quality_gate: baselineQualityGate,
    candidate_quality_gate: candidateQualityGate,
    candidate_not_worse_on_defect_recall: candidateNotWorseOnDefectRecall,
    candidate_quality_eligible_for_aggregate: candidateQualityEligibleForAggregate,
    arms: { baseline, candidate },
  };
}

export async function runQualification({
  input,
  policy,
  token,
  outputDir,
  fixturePath,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  childTimeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS,
  now,
  runId,
} = {}) {
  const validated = validateQualificationInput(input);
  const effectiveChildTimeoutMs = normalizeChildTimeoutMs(childTimeoutMs);
  const loadedPolicy = policy || loadPolicy();
  validatePolicy(loadedPolicy);
  await verifyPullRequest({ ...validated, token, fetchImpl });
  const targetDir = path.resolve(outputDir || process.env.RUNNER_TEMP || '.', 'ollama-qualification');
  mkdirSync(targetDir, { recursive: true });
  const fixture = fixturePath || path.join(validated.botRoot, 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json');
  const armDispatches = [
    { arm: 'baseline', profile: BASELINE_PROFILE, output: path.join(targetDir, 'baseline.json') },
    { arm: 'candidate', profile: CANDIDATE_PROFILE, output: path.join(targetDir, 'candidate.json') },
  ].map(({ arm, profile, output }) => {
    const handoff = buildTransportHandoff(loadedPolicy, profile);
    const env = buildArmEnvironment({ baseEnv: process.env, handoff, arm, botSha: validated.botSha, fixturePath: fixture });
    const args = [
      path.join(validated.botRoot, 'scripts/evaluate-verified-publication.mjs'),
      'lanes', '--arm', COMPARISON_EVALUATION_ARM, '--fixture', fixture, '--fixtures', FIXTURE_IDS.join(','),
      '--repetitions', String(COMPARISON_REPETITIONS), '--concurrency', String(COMPARISON_CONCURRENCY), '--out', output,
    ];
    return () => runChild({
      command: process.execPath,
      args,
      cwd: validated.botRoot,
      env,
      spawnImpl,
      timeoutMs: effectiveChildTimeoutMs,
    }).then((child) => ({ arm, profile, output, ...child }));
  });
  // Start both provider-pinned arms explicitly and concurrently. The parent owns the hard
  // wall-clock deadline; each child remains isolated from the other arm's credentials.
  console.log(`[qualification] dispatching arms in parallel; child_timeout_ms=${effectiveChildTimeoutMs}`);
  const [baselineRun, candidateRun] = await Promise.all(armDispatches.map((dispatch) => dispatch()));
  const baseline = {
    profile: baselineRun.profile,
    child_timed_out: baselineRun.timedOut === true,
    ...readEvaluation(baselineRun.output, baselineRun.exitCode),
  };
  const candidate = {
    profile: candidateRun.profile,
    child_timed_out: candidateRun.timedOut === true,
    ...readEvaluation(candidateRun.output, candidateRun.exitCode),
  };
  const receipt = buildQualificationReceipt({ input: validated, policy: loadedPolicy, baseline, candidate, childTimeoutMs: effectiveChildTimeoutMs, now, runId });
  const receiptPath = path.join(targetDir, 'ollama-qualification-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { receipt, receiptPath, digest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') };
}

async function main() {
  const input = {
    confirm: process.env.QUALIFY_CONFIRM,
    repository: process.env.QUALIFY_REPOSITORY,
    prNumber: process.env.QUALIFY_PR_NUMBER,
    baseSha: process.env.QUALIFY_BASE_SHA,
    headSha: process.env.QUALIFY_HEAD_SHA,
    botSha: process.env.QUALIFY_BOT_SHA,
    centralSha: process.env.QUALIFY_CENTRAL_SHA,
    botRoot: process.env.QUALIFY_BOT_ROOT,
  };
  const result = await runQualification({
    input,
    token: process.env.QUALIFICATION_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    outputDir: process.env.RUNNER_TEMP,
    runId: process.env.GITHUB_RUN_ID || 'manual',
  });
  console.log(`[Fireworks/Ollama comparison] receipt=${result.receiptPath} digest=${result.digest}`);
  console.log(`[Fireworks/Ollama comparison] baseline=${result.receipt.arms.baseline.status} candidate=${result.receipt.arms.candidate.status} `
    + `baseline_failure_classes=${JSON.stringify(result.receipt.arms.baseline.failure_classes)} `
    + `candidate_failure_classes=${JSON.stringify(result.receipt.arms.candidate.failure_classes)} `
    + `baseline_failure_providers=${JSON.stringify(result.receipt.arms.baseline.failure_classes_by_provider)} `
    + `candidate_failure_providers=${JSON.stringify(result.receipt.arms.candidate.failure_classes_by_provider)} `
    + 'authoritative=none production-authority=unchanged publication=none');
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, [
      `receipt-path=${result.receiptPath}`,
      `receipt-digest=${result.digest}`,
      `comparison-integrity=${String(result.receipt.comparison_integrity_gate.passed)}`,
      `candidate-quality-eligible-for-aggregate=${String(result.receipt.candidate_quality_eligible_for_aggregate)}`,
    ].join('\n') + '\n', { flag: 'a' });
  }
  if (!result.receipt.comparison_integrity_gate.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`::error::Fireworks/Ollama comparison failed: ${error.message}`);
    process.exitCode = 1;
  });
}
