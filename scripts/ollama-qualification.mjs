#!/usr/bin/env node

/**
 * One-time, read-only Ollama qualification.
 *
 * This command is deliberately not part of the reusable review workflow. It verifies one
 * immutable PR coordinate, then runs a small paired fixture set through the current production
 * transport plan and an Ollama-only plan in parallel. Neither arm can publish a comment, check,
 * review verdict, merge decision, or provider mutation. The baseline remains authoritative.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadPolicy, validatePolicy } from './review-yeti-smoke.mjs';

export const QUALIFICATION_SCHEMA = 'review-yeti.ollama-qualification.v5';
export const QUALIFY_CONFIRMATION = 'QUALIFY';
export const CANDIDATE_PROFILE = 'ollama-high-150s-49152-evaluation';
export const BASELINE_PROFILE = 'current-production';
export const CANDIDATE_TIMEOUT_MS = 150_000;
export const CANDIDATE_MAX_OUTPUT_TOKENS = 49_152;
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
  if (profile === BASELINE_PROFILE) return transports.map((transport) => ({ ...transport }));
  if (profile === CANDIDATE_PROFILE) {
    const ollama = transports.find((transport) => transport.name === 'ollama');
    if (!ollama) throw new Error('policy does not define the Ollama transport');
    return [{
      ...ollama,
      timeout_ms: CANDIDATE_TIMEOUT_MS,
      max_tokens: CANDIDATE_MAX_OUTPUT_TOKENS,
    }];
  }
  throw new Error(`unsupported qualification profile: ${profile}`);
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

function runChild({ command, args, cwd, env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve({ exitCode: 1 });
      return;
    }
    child.once('error', () => resolve({ exitCode: 1 }));
    child.once('close', (code) => resolve({ exitCode: Number.isInteger(code) ? code : 1 }));
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
  const numericCosts = rows.map((row) => Number(row.usage?.costUSD)).filter(Number.isFinite);
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
  for (const row of rows) {
    incrementCount(outputShapes, safeDiagnosticEnum(row.outputShape, OUTPUT_SHAPES));
    incrementCount(finishReasons, safeDiagnosticEnum(row.finishReason, FINISH_REASONS));
    incrementCount(responseModes, safeDiagnosticEnum(row.responseMode, RESPONSE_MODES));
    incrementCount(findingsSources, safeDiagnosticEnum(row.findingsSource, FINDINGS_SOURCES));
    incrementCount(contentSizeBuckets, safeDiagnosticEnum(row.contentSizeBucket, RESPONSE_SIZE_BUCKETS));
    incrementCount(reasoningSizeBuckets, safeDiagnosticEnum(row.reasoningSizeBucket, RESPONSE_SIZE_BUCKETS));
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
    response_attempt_outcomes: responseAttemptOutcomes,
    first_attempt_output_shapes: firstAttemptOutputShapes,
    first_attempt_finish_reasons: firstAttemptFinishReasons,
    first_attempt_failure_classes: firstAttemptFailureClasses,
    first_attempt_reasoning_efforts: firstAttemptReasoningEfforts,
    first_attempt_max_output_tokens: firstAttemptMaxOutputTokens,
    fixture_outcomes: summarizeFixtureOutcomes(rows),
    latency_ms_median: percentile(latencies, 0.5),
    latency_ms_p95: percentile(latencies, 0.95),
    cost_usd: numericCosts.length === rows.length ? Number(numericCosts.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : null,
  };
}

function readEvaluation(pathname, exitCode) {
  try {
    return summarizeEvaluation(JSON.parse(readFileSync(pathname, 'utf8')), exitCode);
  } catch {
    return summarizeEvaluation(null, exitCode);
  }
}

export function buildCandidateQualityGate(candidate = {}) {
  const outcomes = Array.isArray(candidate.fixture_outcomes) ? candidate.fixture_outcomes : [];
  const fixtureIds = outcomes.map((entry) => String(entry?.fixture_id || ''));
  const uniqueFixtureIds = new Set(fixtureIds);
  const fixtureSetComplete = fixtureIds.length === FIXTURE_IDS.length
    && uniqueFixtureIds.size === FIXTURE_IDS.length
    && FIXTURE_IDS.every((fixtureId) => uniqueFixtureIds.has(fixtureId));
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
      && attempts.length <= MAX_RESPONSE_ATTEMPTS
      && attempts.every((attempt, index) => (
        attempt?.attempt === index + 1
        && RESPONSE_ATTEMPT_OUTCOMES.has(attempt?.outcome)
        && attempt?.transport === 'ollama'
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
  const requestContractObserved = responseAttemptTelemetryComplete
    && candidate.profile === CANDIDATE_PROFILE
    && outcomes.every((entry) => (
      entry.response_attempts[0]?.reasoning_effort === 'high'
      && entry.response_attempts[0]?.max_output_tokens === CANDIDATE_MAX_OUTPUT_TOKENS
    ));
  const stableCandidateOutputs = outputTelemetryComplete && responseAttemptTelemetryComplete && outcomes.every((entry) => {
    const sourcePresent = entry.findings_source === 'content'
      ? entry.content_present === true && entry.content_size_bucket !== 'empty'
      : entry.findings_source === 'reasoning'
        ? entry.reasoning_present === true && entry.reasoning_size_bucket !== 'empty'
        : false;
    return entry.output_shape === 'direct_json_object'
      && entry.finish_reason === 'stop'
      && entry.response_mode === 'stream'
      && sourcePresent;
  });
  const passed = candidate.rows === FIXTURE_IDS.length
    && candidate.defect_runs === EXPECTED_DEFECT_RUNS
    && candidate.detected_defect_runs === EXPECTED_DEFECT_RUNS
    && candidate.clean_runs === EXPECTED_CLEAN_RUNS
    && candidate.false_positive_runs === 0
    && fixtureSetComplete
    && fixtureOutcomesComplete
    && malformedOutputRecoveries === 0
    && attemptTelemetryConsistent
    && requestContractObserved
    && stableCandidateOutputs;
  return {
    required_rows: FIXTURE_IDS.length,
    required_defect_detections: EXPECTED_DEFECT_RUNS,
    required_clean_false_positives: 0,
    required_malformed_output_recoveries: 0,
    fixture_set_complete: fixtureSetComplete,
    output_telemetry_complete: outputTelemetryComplete,
    response_attempt_telemetry_complete: responseAttemptTelemetryComplete,
    response_attempt_telemetry_consistent: attemptTelemetryConsistent,
    required_first_attempt_reasoning_effort: 'high',
    required_first_attempt_max_output_tokens: CANDIDATE_MAX_OUTPUT_TOKENS,
    request_contract_observed: requestContractObserved,
    required_output_shape: 'direct_json_object',
    required_finish_reason: 'stop',
    required_response_mode: 'stream',
    stable_candidate_outputs: stableCandidateOutputs,
    observed_malformed_output_recoveries: malformedOutputRecoveries,
    passed,
  };
}

export function buildBaselineQualityGate(baseline = {}) {
  const outcomes = Array.isArray(baseline.fixture_outcomes) ? baseline.fixture_outcomes : [];
  const fixtureIds = outcomes.map((entry) => String(entry?.fixture_id || ''));
  const uniqueFixtureIds = new Set(fixtureIds);
  const fixtureSetComplete = fixtureIds.length === FIXTURE_IDS.length
    && uniqueFixtureIds.size === FIXTURE_IDS.length
    && FIXTURE_IDS.every((fixtureId) => uniqueFixtureIds.has(fixtureId));
  const fixtureOutcomesValid = outcomes.every((entry) => {
    const fixtureId = String(entry?.fixture_id || '');
    const expectedCategory = EXPECTED_FIXTURE_CATEGORIES.get(fixtureId);
    if (expectedCategory === 'defect') {
      return entry?.category === 'defect' && (entry?.outcome === 'detected' || entry?.outcome === 'miss');
    }
    return expectedCategory === 'clean' && entry?.category === 'clean' && entry?.outcome === 'clean';
  });
  const passed = baseline.rows === FIXTURE_IDS.length
    && baseline.defect_runs === EXPECTED_DEFECT_RUNS
    && baseline.clean_runs === EXPECTED_CLEAN_RUNS
    && baseline.false_positive_runs === 0
    && fixtureSetComplete
    && fixtureOutcomesValid;
  return {
    required_rows: FIXTURE_IDS.length,
    required_clean_false_positives: 0,
    fixture_set_complete: fixtureSetComplete,
    passed,
  };
}

export function buildQualificationReceipt({ input, policy, baseline, candidate, now = new Date().toISOString(), runId = 'manual' }) {
  const policyDigest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const complete = baseline.status === 'completed' && candidate.status === 'completed'
    && baseline.errored_runs === 0 && candidate.errored_runs === 0;
  const baselineQualityGate = buildBaselineQualityGate(baseline);
  const candidateQualityGate = buildCandidateQualityGate(candidate);
  const candidateNotWorseOnDefectRecall = Number(candidate.detected_defect_runs) >= Number(baseline.detected_defect_runs);
  const candidateQualityEligible = complete
    && baselineQualityGate.passed
    && candidateQualityGate.passed
    && candidateNotWorseOnDefectRecall;
  const candidateTransport = buildTransportHandoff(policy, CANDIDATE_PROFILE)[0];
  return {
    schema: QUALIFICATION_SCHEMA,
    mode: 'one-time-parallel-qualification',
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
    candidate_request_contract: {
      transport: 'ollama',
      timeout_ms: candidateTransport.timeout_ms,
      connect_timeout_ms: candidateTransport.connect_timeout_ms,
      reasoning_effort: candidateTransport.reasoning_effort,
      max_output_tokens: candidateTransport.max_tokens,
      repetitions: 1,
      concurrency: 1,
    },
    fixture_ids: [...FIXTURE_IDS],
    max_requests_per_arm: FIXTURE_IDS.length,
    authoritative_arm: 'baseline',
    publication: 'none',
    provider_mutation: 'none',
    promotion_gate: 'manual_review_required',
    baseline_quality_gate: baselineQualityGate,
    candidate_quality_gate: candidateQualityGate,
    candidate_not_worse_on_defect_recall: candidateNotWorseOnDefectRecall,
    candidate_eligible_for_next_step: candidateQualityEligible,
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
  now,
  runId,
} = {}) {
  const validated = validateQualificationInput(input);
  const loadedPolicy = policy || loadPolicy();
  validatePolicy(loadedPolicy);
  await verifyPullRequest({ ...validated, token, fetchImpl });
  const targetDir = path.resolve(outputDir || process.env.RUNNER_TEMP || '.', 'ollama-qualification');
  mkdirSync(targetDir, { recursive: true });
  const fixture = fixturePath || path.join(validated.botRoot, 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json');
  const jobs = [
    { arm: 'baseline', profile: BASELINE_PROFILE, output: path.join(targetDir, 'baseline.json') },
    { arm: 'candidate', profile: CANDIDATE_PROFILE, output: path.join(targetDir, 'candidate.json') },
  ].map(({ arm, profile, output }) => {
    const handoff = buildTransportHandoff(loadedPolicy, profile);
    const env = buildArmEnvironment({ baseEnv: process.env, handoff, arm, botSha: validated.botSha, fixturePath: fixture });
    const args = [
      path.join(validated.botRoot, 'scripts/evaluate-verified-publication.mjs'),
      'lanes', '--arm', arm, '--fixture', fixture, '--fixtures', FIXTURE_IDS.join(','),
      '--repetitions', '1', '--concurrency', '1', '--out', output,
    ];
    return runChild({ command: process.execPath, args, cwd: validated.botRoot, env, spawnImpl })
      .then(({ exitCode }) => ({ arm, profile, output, exitCode }));
  });
  const [baselineRun, candidateRun] = await Promise.all(jobs);
  const baseline = { profile: baselineRun.profile, ...readEvaluation(baselineRun.output, baselineRun.exitCode) };
  const candidate = { profile: candidateRun.profile, ...readEvaluation(candidateRun.output, candidateRun.exitCode) };
  const receipt = buildQualificationReceipt({ input: validated, policy: loadedPolicy, baseline, candidate, now, runId });
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
  console.log(`[Ollama qualification] receipt=${result.receiptPath} digest=${result.digest}`);
  console.log(`[Ollama qualification] baseline=${result.receipt.arms.baseline.status} candidate=${result.receipt.arms.candidate.status} `
    + `baseline_failure_classes=${JSON.stringify(result.receipt.arms.baseline.failure_classes)} `
    + `candidate_failure_classes=${JSON.stringify(result.receipt.arms.candidate.failure_classes)} `
    + `baseline_failure_providers=${JSON.stringify(result.receipt.arms.baseline.failure_classes_by_provider)} `
    + `candidate_failure_providers=${JSON.stringify(result.receipt.arms.candidate.failure_classes_by_provider)} `
    + 'authoritative=baseline publication=none');
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, [
      `receipt-path=${result.receiptPath}`,
      `receipt-digest=${result.digest}`,
      `candidate-eligible=${String(result.receipt.candidate_eligible_for_next_step)}`,
    ].join('\n') + '\n', { flag: 'a' });
  }
  if (!result.receipt.candidate_eligible_for_next_step) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`::error::Ollama qualification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
