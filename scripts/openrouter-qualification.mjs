#!/usr/bin/env node

/**
 * One-time, read-only OpenRouter qualification probe.
 *
 * It runs one direct OpenRouter transport over a small fixture slice, writes only sanitized
 * evidence, and cannot
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
export const OPENROUTER_TRANSPORT = 'openrouter-primary';
export const COMPARISON_EVALUATION_ARM = 'candidate';
export const OPENROUTER_TIMEOUT_MS = 90_000;
export const OPENROUTER_CONNECT_TIMEOUT_MS = 30_000;
export const OPENROUTER_MAX_OUTPUT_TOKENS = 24_576;
export const OPENROUTER_REASONING_EFFORT = 'high';
export const QUALIFICATION_DEEPSEEK_MODEL = '~deepseek/deepseek-v4-flash-latest';
export const QUALIFICATION_GLM_MODEL = 'z-ai/glm-5.3-flash';
export const QUALIFICATION_MODEL_OVERRIDES = Object.freeze([
  QUALIFICATION_DEEPSEEK_MODEL,
  QUALIFICATION_GLM_MODEL,
]);
// Three fixtures may each use the bounded two-attempt, 90-second request envelope. The declared
// two-repetition run uses three concurrent lanes, so its worst case is two 180-second waves with
// a four-minute margin while leaving the parent workflow below its non-negotiable 15-minute cap.
export const QUALIFICATION_CHILD_TIMEOUT_MS = 10 * 60_000;
export const QUALIFICATION_HEARTBEAT_MS = 15_000;
export const QUALIFICATION_DEFAULT_REPETITIONS = 1;
export const QUALIFICATION_MAX_REPETITIONS = 2;
export const QUALIFICATION_MAX_ATTEMPTS_PER_FIXTURE = 2;
export const QUALIFICATION_CONCURRENCY = 3;
export const QUALIFICATION_ISOLATED_DEFAULT_CONCURRENCY = 1;
export const QUALIFICATION_MAX_CONCURRENCY = 3;
export const QUALIFICATION_BUDGET_MARGIN_MS = 4 * 60_000;
export const QUALIFICATION_OUTPUT_CONTRACT_MODES = Object.freeze(['json_object', 'json_schema']);
export const QUALIFICATION_DEFAULT_OUTPUT_CONTRACT_MODE = 'json_object';
// OpenRouter's documented default routing is health-aware and load-balanced. An explicit `sort`
// mode is a separate control because OpenRouter documents that sorting disables load balancing.
// Keep both profiles in the qualification harness so the routing hypothesis can be tested without
// mutating the central production policy.
export const QUALIFICATION_ROUTING_PROFILES = Object.freeze(['default_uptime', 'throughput_sorted']);
export const QUALIFICATION_DEFAULT_ROUTING_PROFILE = 'default_uptime';
export const QUALIFICATION_SYNTHETIC_PROMPT_IDENTITY = 'single-fixed-fixture-contract';
// The bot's telemetry normalizer reports the canonical OpenRouter transport as
// `openrouter` on response attempts, while the handoff and row-level transport
// retain `openrouter-primary`. Accept both representations only after the row
// itself proves the exact admitted handoff.
const OPENROUTER_ATTEMPT_TRANSPORTS = Object.freeze(['openrouter', OPENROUTER_TRANSPORT]);
export const FIXTURE_IDS = Object.freeze([
  'vacuous-default-value-test',
  'format-evadable-absence-guard',
  'clean-behavioural-guard',
]);

export function normalizeQualificationFixtureId(value = '') {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (!FIXTURE_IDS.includes(normalized)) {
    throw new Error(`fixtureId must be one of ${FIXTURE_IDS.join(', ')}`);
  }
  return normalized;
}

export function normalizeQualificationConcurrency(value, isolated = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return isolated ? QUALIFICATION_ISOLATED_DEFAULT_CONCURRENCY : QUALIFICATION_CONCURRENCY;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > QUALIFICATION_MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer between 1 and ${QUALIFICATION_MAX_CONCURRENCY}`);
  }
  if (!isolated && parsed !== QUALIFICATION_CONCURRENCY) {
    throw new Error('concurrency may only be changed for an isolated fixture');
  }
  return parsed;
}
if (qualificationWorstCaseMs() > QUALIFICATION_CHILD_TIMEOUT_MS - QUALIFICATION_BUDGET_MARGIN_MS) {
  throw new Error('OpenRouter qualification request budget exceeds the ten-minute child deadline');
}
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

export function normalizeQualificationRepetitions(value = QUALIFICATION_DEFAULT_REPETITIONS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > QUALIFICATION_MAX_REPETITIONS) {
    throw new Error(`repetitions must be an integer between 1 and ${QUALIFICATION_MAX_REPETITIONS}`);
  }
  return parsed;
}

// Qualification must be able to test the provider/model's own output ceiling. Do not impose
// another arbitrary harness cap: the provider request, model limits, and the hard child/workflow
// deadlines remain authoritative. Number.isSafeInteger prevents JSON/CLI precision loss.
export function normalizeQualificationMaxTokens(value = OPENROUTER_MAX_OUTPUT_TOKENS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('maxTokens must be a positive safe integer');
  }
  return parsed;
}

// Model overrides are deliberately narrower than provider pins: this harness may qualify the
// explicit model route without becoming a general-purpose production-policy editor. An empty
// value preserves the primary model selected by the committed policy.
export function normalizeQualificationModel(value = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (!QUALIFICATION_MODEL_OVERRIDES.includes(normalized)) {
    throw new Error(`model must be one of ${QUALIFICATION_MODEL_OVERRIDES.join(', ')}`);
  }
  return normalized;
}

// Provider pinning is an investigation-only override. It never changes the committed
// production policy; it is applied only to the one-transport qualification handoff so we can
// distinguish an upstream endpoint problem from OpenRouter's normal load-balanced behavior.
export function normalizeQualificationProviderSlug(value = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (!LABEL_PATTERN.test(normalized)) {
    throw new Error('providerSlug must be a lowercase OpenRouter provider slug');
  }
  return normalized;
}

export function normalizeQualificationOutputContractMode(value = QUALIFICATION_DEFAULT_OUTPUT_CONTRACT_MODE) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!QUALIFICATION_OUTPUT_CONTRACT_MODES.includes(normalized)) {
    throw new Error(`outputContractMode must be one of ${QUALIFICATION_OUTPUT_CONTRACT_MODES.join(', ')}`);
  }
  return normalized;
}

export function normalizeQualificationRoutingProfile(value = QUALIFICATION_DEFAULT_ROUTING_PROFILE) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!QUALIFICATION_ROUTING_PROFILES.includes(normalized)) {
    throw new Error(`routingProfile must be one of ${QUALIFICATION_ROUTING_PROFILES.join(', ')}`);
  }
  return normalized;
}

export function qualificationWorstCaseMs(repetitions = QUALIFICATION_MAX_REPETITIONS) {
  const expectedRepetitions = normalizeQualificationRepetitions(repetitions);
  const lanes = FIXTURE_IDS.length * expectedRepetitions;
  const waves = Math.ceil(lanes / QUALIFICATION_CONCURRENCY);
  return waves * QUALIFICATION_MAX_ATTEMPTS_PER_FIXTURE * OPENROUTER_TIMEOUT_MS;
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
  const repetitions = normalizeQualificationRepetitions(input.repetitions);
  const maxTokens = normalizeQualificationMaxTokens(input.maxTokens ?? input.max_tokens);
  const model = normalizeQualificationModel(input.model);
  const providerSlug = normalizeQualificationProviderSlug(input.providerSlug ?? input.provider_slug);
  const outputContractMode = normalizeQualificationOutputContractMode(
    input.outputContractMode ?? input.output_contract_mode,
  );
  const routingProfile = normalizeQualificationRoutingProfile(
    input.routingProfile ?? input.routing_profile,
  );
  const fixtureId = normalizeQualificationFixtureId(input.fixtureId ?? input.fixture_id);
  const rawConcurrency = input.concurrency ?? input.qualificationConcurrency;
  const concurrency = normalizeQualificationConcurrency(rawConcurrency, Boolean(fixtureId));
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
    repetitions,
    maxTokens,
    model,
    providerSlug,
    outputContractMode,
    routingProfile,
    fixtureId,
    concurrency,
  };
}

export function buildTransportHandoff(
  policy,
  outputContractMode = QUALIFICATION_DEFAULT_OUTPUT_CONTRACT_MODE,
  maxTokens = OPENROUTER_MAX_OUTPUT_TOKENS,
  providerSlug = null,
  routingProfile = QUALIFICATION_DEFAULT_ROUTING_PROFILE,
  model = null,
) {
  const transports = validatePolicy(policy);
  const selected = transports.find((transport) => transport.name === OPENROUTER_TRANSPORT);
  if (!selected) throw new Error(`policy does not define the ${OPENROUTER_TRANSPORT} transport`);
  const normalizedOutputContractMode = normalizeQualificationOutputContractMode(outputContractMode);
  const normalizedMaxTokens = normalizeQualificationMaxTokens(maxTokens);
  const normalizedProviderSlug = normalizeQualificationProviderSlug(providerSlug);
  const normalizedRoutingProfile = normalizeQualificationRoutingProfile(routingProfile);
  const normalizedModel = normalizeQualificationModel(model);
  const selectedRouting = selected.provider_routing || {};
  const delegatedRouting = normalizedRoutingProfile === 'default_uptime'
    ? Object.fromEntries(Object.entries(selectedRouting).filter(([key]) => key !== 'sort'))
    : { ...selectedRouting };
  const handoff = {
    ...selected,
    name: OPENROUTER_TRANSPORT,
    model: normalizedModel || selected.model,
    timeout_ms: OPENROUTER_TIMEOUT_MS,
    connect_timeout_ms: OPENROUTER_CONNECT_TIMEOUT_MS,
    max_tokens: normalizedMaxTokens,
    reasoning_effort: OPENROUTER_REASONING_EFFORT,
    stream: true,
    structured_output_mode: normalizedOutputContractMode,
    provider_routing: delegatedRouting,
  };
  // A single-model qualification override deliberately removes the committed model fallback so
  // the receipt measures that model alone. The normal qualification handoff keeps the explicit
  // two-model OpenRouter fallback list from central policy; no Auto Router plugin is ever added.
  if (normalizedModel) handoff.models = [];
  if (normalizedProviderSlug) {
    const ignoredProviders = new Set([
      ...(Array.isArray(selected.ignore_providers) ? selected.ignore_providers : []),
      ...(Array.isArray(selected.provider_routing?.ignore) ? selected.provider_routing.ignore : []),
    ].map((entry) => String(entry).trim().toLowerCase()));
    if (ignoredProviders.has(normalizedProviderSlug)) {
      throw new Error(`providerSlug ${normalizedProviderSlug} is excluded by the committed policy`);
    }
    const {
      sort: _sort,
      preferred_min_throughput: _preferredMinThroughput,
      preferred_max_latency: _preferredMaxLatency,
      ...delegatedRouting
    } = selectedRouting;
    handoff.provider_routing = {
      ...delegatedRouting,
      order: [normalizedProviderSlug],
      allow_fallbacks: false,
    };
  }
  return [handoff];
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
    let heartbeatTimer = null;
    const startedAt = Date.now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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
    heartbeatTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, effectiveTimeoutMs - elapsedMs);
      console.log(`::notice::OpenRouter qualification arm active; elapsed=${Math.round(elapsedMs / 1000)}s remaining=${Math.round(remainingMs / 1000)}s hard_deadline=${effectiveTimeoutMs}ms`);
    }, QUALIFICATION_HEARTBEAT_MS);
    if (heartbeatTimer?.unref) heartbeatTimer.unref();
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

// Receipt fingerprints must be stable even if a caller constructs an equivalent contract
// with a different object insertion order. Only the sanitized contract and row identity reach
// this serializer; prompt bodies, credentials, and response bodies never do.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256Value(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function buildQualificationRowFingerprints({
  fixtureId,
  repetition,
  syntheticPromptIdentity = QUALIFICATION_SYNTHETIC_PROMPT_IDENTITY,
  requestContract,
  transport,
  upstreamProvider,
} = {}) {
  const sanitizedFixtureId = safeLabel(fixtureId);
  const sanitizedRepetition = Number.isInteger(Number(repetition)) ? Number(repetition) : null;
  const sanitizedPromptIdentity = safeLabel(syntheticPromptIdentity) || QUALIFICATION_SYNTHETIC_PROMPT_IDENTITY;
  const invocationIdentity = sha256Value({
    schema: 'review-yeti.openrouter-qualification.invocation.v1',
    fixture_id: sanitizedFixtureId,
    repetition: sanitizedRepetition,
    synthetic_prompt_identity: sanitizedPromptIdentity,
  });
  const requestFingerprint = sha256Value({
    schema: 'review-yeti.openrouter-qualification.request.v1',
    invocation_identity: invocationIdentity,
    request_contract: requestContract || null,
  });
  const upstreamFingerprint = sha256Value({
    schema: 'review-yeti.openrouter-qualification.upstream.v1',
    invocation_identity: invocationIdentity,
    request_contract: requestContract || null,
    transport: safeLabel(transport),
    upstream_provider: safeLabel(upstreamProvider),
  });
  return {
    invocation_identity: invocationIdentity,
    request_fingerprint: requestFingerprint,
    upstream_fingerprint: upstreamFingerprint,
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function summarizeResponseAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((attempt) => {
    if (!attempt || typeof attempt !== 'object') return null;
    const captured = {};
    for (const key of ['attempt', 'responseStatus', 'latencyMs', 'maxOutputTokens', 'outputTokens']) {
      const number = Number(attempt[key]);
      if (Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000) captured[key] = number;
    }
    for (const key of [
      'outcome', 'transport', 'provider', 'failureClass', 'errorCode', 'outputShape',
      'timeoutKind', 'finishReason', 'responseMode', 'findingsSource', 'contentSizeBucket', 'reasoningSizeBucket',
    ]) {
      const label = safeLabel(attempt[key]);
      if (label) captured[key] = label;
    }
    for (const key of ['contentPresent', 'reasoningPresent']) {
      if (typeof attempt[key] === 'boolean') captured[key] = attempt[key];
    }
    return Object.keys(captured).length > 0 ? captured : null;
  }).filter(Boolean);
}

export function summarizeRows(
  rows,
  exitCode,
  repetitions = QUALIFICATION_DEFAULT_REPETITIONS,
  fixtureIds = FIXTURE_IDS,
) {
  const expectedRepetitions = normalizeQualificationRepetitions(repetitions);
  const expectedFixtureIds = fixtureIds.map((fixtureId) => normalizeQualificationFixtureId(fixtureId)).filter(Boolean);
  if (expectedFixtureIds.length === 0) throw new Error('at least one expected fixture is required');
  const safeRows = Array.isArray(rows) ? rows : [];
  const resolveRowRepetition = (row) => {
    if (Number.isInteger(Number(row?.repetition))) return Number(row.repetition);
    // Preserve the pre-repetition exported helper contract for callers that
    // summarize a single run without a repetition field. Multi-repetition
    // evidence must carry explicit repetition numbers.
    return expectedRepetitions === 1 ? 1 : null;
  };
  const latencies = safeRows.map((row) => Number(row?.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const fixtureOutcomes = safeRows.map((row) => {
    const responseAttempts = summarizeResponseAttempts(row?.responseAttempts);
    const lastAttempt = responseAttempts.at(-1) || {};
    return {
      fixture_id: safeLabel(row?.fixtureId),
      repetition: resolveRowRepetition(row),
      category: row?.category === 'defect' || row?.category === 'clean' ? row.category : 'unknown',
      outcome: row?.errored ? 'error' : row?.category === 'defect' ? (row.detected ? 'detected' : 'miss') : row?.falsePositive ? 'false_positive' : 'clean',
      provider: safeLabel(row?.provider),
      upstream_provider: safeLabel(row?.provider),
      transport: safeLabel(row?.transport),
      response_status: Number.isInteger(Number(row?.responseStatus)) ? Number(row.responseStatus) : null,
      attempt_count: Number.isInteger(Number(row?.attemptCount)) ? Number(row.attemptCount) : null,
      failure_class: safeLabel(row?.failureClass) || safeLabel(lastAttempt.failureClass) || null,
      timeout_kind: safeLabel(row?.timeoutKind) || safeLabel(lastAttempt.timeoutKind) || null,
      error_code: safeLabel(row?.errorCode) || safeLabel(lastAttempt.errorCode) || null,
      output_shape: safeLabel(row?.outputShape) || safeLabel(lastAttempt.outputShape) || null,
      response_attempts: responseAttempts,
    };
  });
  const responseAttempts = safeRows.flatMap((row) => Array.isArray(row?.responseAttempts) ? row.responseAttempts : []);
  const positivePrompt = safeRows.map((row) => Number(row?.usage?.promptTokens)).filter((value) => Number.isFinite(value) && value > 0);
  const positiveCompletion = safeRows.map((row) => Number(row?.usage?.completionTokens)).filter((value) => Number.isFinite(value) && value > 0);
  const positiveCosts = safeRows.map((row) => Number(row?.usage?.costUSD)).filter((value) => Number.isFinite(value) && value > 0);
  const observedPromptTokens = positivePrompt.reduce((sum, value) => sum + value, 0);
  const observedCompletionTokens = positiveCompletion.reduce((sum, value) => sum + value, 0);
  const observedCost = positiveCosts.reduce((sum, value) => sum + value, 0);
  // OpenRouter may report the resolved upstream adapter (for example, Inceptron
  // or DeepInfra) in the row-level provider field. Route attribution is proven
  // by the configured OpenRouter transport on every row and response attempt;
  // the upstream label remains informational telemetry and is not allowlisted.
  const providerAttributionValid = safeRows.every((row) => {
    if (row?.transport !== OPENROUTER_TRANSPORT) return false;
    const attempts = Array.isArray(row?.responseAttempts) ? row.responseAttempts : [];
    return attempts.length > 0 && attempts.every((attempt) => OPENROUTER_ATTEMPT_TRANSPORTS.includes(attempt?.transport));
  });
  const expectedFixturePairs = new Set(expectedFixtureIds.flatMap((fixtureId) => (
    Array.from({ length: expectedRepetitions }, (_, index) => JSON.stringify([fixtureId, index + 1]))
  )));
  const observedFixturePairs = new Set();
  let invalidFixturePair = false;
  for (const row of safeRows) {
    const repetition = resolveRowRepetition(row);
    const pair = JSON.stringify([row?.fixtureId, repetition]);
    if (!expectedFixturePairs.has(pair) || observedFixturePairs.has(pair)) invalidFixturePair = true;
    else observedFixturePairs.add(pair);
  }
  const fixtureSetValid = safeRows.length === expectedFixtureIds.length * expectedRepetitions
    && !invalidFixturePair
    && observedFixturePairs.size === expectedFixturePairs.size;
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
    prompt_tokens_observed: positivePrompt.length > 0 ? observedPromptTokens : null,
    completion_tokens_observed: positiveCompletion.length > 0 ? observedCompletionTokens : null,
    cost_telemetry_status: costTelemetryStatus,
    cost_usd: costTelemetryStatus === 'complete' ? Number(positiveCosts.reduce((sum, value) => sum + value, 0).toFixed(6)) : null,
    cost_usd_observed: positiveCosts.length > 0 ? Number(observedCost.toFixed(6)) : null,
    cost_observation_count: positiveCosts.length,
    fixture_outcomes: fixtureOutcomes,
  };
}

function readEvaluation(pathname, exitCode, repetitions = QUALIFICATION_DEFAULT_REPETITIONS, fixtureIds = FIXTURE_IDS) {
  try {
    return summarizeRows(JSON.parse(readFileSync(pathname, 'utf8')).rows, exitCode, repetitions, fixtureIds);
  } catch {
    return summarizeRows([], exitCode, repetitions, fixtureIds);
  }
}

export function buildQualificationReceipt({ input, policy, handoff, evaluation, childTimedOut, childTimeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS, now = new Date().toISOString(), runId = 'manual' }) {
  const policyDigest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const repetitions = normalizeQualificationRepetitions(input.repetitions);
  const maxTokens = normalizeQualificationMaxTokens(input.maxTokens ?? input.max_tokens);
  const routingProfile = normalizeQualificationRoutingProfile(input.routingProfile ?? input.routing_profile);
  const contract = {
    transport: OPENROUTER_TRANSPORT,
    provider: 'openrouter',
    model: handoff[0].model,
    model_selection: input.model ? 'qualification_override' : 'policy',
    timeout_ms: handoff[0].timeout_ms,
    connect_timeout_ms: handoff[0].connect_timeout_ms,
    child_timeout_ms: normalizeChildTimeoutMs(childTimeoutMs),
    max_output_tokens: handoff[0].max_tokens,
    reasoning_effort: handoff[0].reasoning_effort,
    stream: handoff[0].stream === true,
    structured_output_mode: normalizeQualificationOutputContractMode(handoff[0].structured_output_mode),
    provider_routing: input.providerSlug
      ? {
        mode: 'pinned',
        profile: routingProfile,
        provider_slug: input.providerSlug,
        order: handoff[0].provider_routing?.order || null,
        allow_fallbacks: handoff[0].provider_routing?.allow_fallbacks,
        sort: handoff[0].provider_routing?.sort ?? null,
      }
      : {
        mode: 'delegated',
        profile: routingProfile,
        provider_slug: null,
        order: null,
        allow_fallbacks: handoff[0].provider_routing?.allow_fallbacks ?? null,
        sort: handoff[0].provider_routing?.sort ?? null,
      },
    repetitions,
    concurrency: input.concurrency ?? (input.fixtureId ? QUALIFICATION_ISOLATED_DEFAULT_CONCURRENCY : QUALIFICATION_CONCURRENCY),
  };
  const integrity = {
    exact_bot_sha_bound: SHA_PATTERN.test(String(input.botSha || '')),
    fixture_set_valid: evaluation.fixture_set_valid === true,
    provider_attribution_valid: evaluation.provider_attribution_valid === true,
    request_contract_valid: contract.stream
      && contract.max_output_tokens === maxTokens
      && contract.reasoning_effort === OPENROUTER_REASONING_EFFORT
      && (input.providerSlug
        ? contract.provider_routing.mode === 'pinned'
          && contract.provider_routing.profile === routingProfile
          && JSON.stringify(contract.provider_routing.order) === JSON.stringify([input.providerSlug])
          && contract.provider_routing.allow_fallbacks === false
        : contract.provider_routing.mode === 'delegated'
          && contract.provider_routing.profile === routingProfile
          && (routingProfile === 'default_uptime'
            ? contract.provider_routing.sort === null
            : contract.provider_routing.sort === 'throughput'))
      && QUALIFICATION_OUTPUT_CONTRACT_MODES.includes(contract.structured_output_mode),
    child_completed: childTimedOut !== true && evaluation.status === 'completed',
  };
  integrity.passed = Object.values(integrity).every(Boolean);
  const promptContract = {
    evaluator_arm: COMPARISON_EVALUATION_ARM,
    charter: 'current-testing',
    synthetic_prompt_identity: QUALIFICATION_SYNTHETIC_PROMPT_IDENTITY,
  };
  const receiptEvaluation = Array.isArray(evaluation?.fixture_outcomes)
    ? {
      ...evaluation,
      fixture_outcomes: evaluation.fixture_outcomes.map((outcome) => ({
        ...outcome,
        ...buildQualificationRowFingerprints({
          fixtureId: outcome?.fixture_id,
          repetition: outcome?.repetition,
          syntheticPromptIdentity: promptContract.synthetic_prompt_identity,
          requestContract: contract,
          transport: outcome?.transport,
          upstreamProvider: outcome?.upstream_provider,
        }),
      })),
    }
    : evaluation;
  return {
    schema: QUALIFICATION_SCHEMA,
    mode: 'one-time-manual-openrouter-probe',
    created_at: now,
    run_id: String(runId),
    exact_target: { repository: input.repository, pr_number: input.prNumber, base_sha: input.baseSha, head_sha: input.headSha },
    implementation_refs: { central_action_sha: input.centralSha, review_yeti_bot_sha: input.botSha, review_yeti_bot_release_tag: input.botReleaseTag },
    policy_sha256: policyDigest,
    fixture_ids: input.fixtureId ? [input.fixtureId] : [...FIXTURE_IDS],
    prompt_contract: promptContract,
    request_contract: contract,
    integrity_gate: integrity,
    authoritative_arm: 'none',
    production_authority: 'unchanged',
    activation_authorized: false,
    publication: 'none',
    provider_mutation: 'none',
    promotion_gate: 'manual_review_required',
    decision: 'evidence_only',
    evaluation: receiptEvaluation,
  };
}

export async function runQualification({ input, policy, token, outputDir, fixturePath, fetchImpl = globalThis.fetch, spawnImpl = spawn, childTimeoutMs = QUALIFICATION_CHILD_TIMEOUT_MS, now, runId } = {}) {
  const validated = validateQualificationInput(input);
  const loadedPolicy = policy || loadPolicy();
  const handoff = buildTransportHandoff(
    loadedPolicy,
    validated.outputContractMode,
    validated.maxTokens,
    validated.providerSlug,
    validated.routingProfile,
    validated.model,
  );
  await verifyPullRequest({ ...validated, token, fetchImpl });
  await verifyBotRelease({ botSha: validated.botSha, botReleaseTag: validated.botReleaseTag, token, fetchImpl });
  const targetDir = path.resolve(outputDir || process.env.RUNNER_TEMP || '.', 'openrouter-qualification');
  mkdirSync(targetDir, { recursive: true });
  const fixture = fixturePath || path.join(validated.botRoot, 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json');
  const output = path.join(targetDir, 'openrouter-lanes.json');
  const env = buildArmEnvironment({ baseEnv: process.env, handoff, botSha: validated.botSha, fixturePath: fixture });
  const fixtureIds = validated.fixtureId ? [validated.fixtureId] : FIXTURE_IDS;
  const concurrency = validated.concurrency;
  const args = [
    path.join(validated.botRoot, 'scripts/evaluate-verified-publication.mjs'),
    'lanes', '--arm', COMPARISON_EVALUATION_ARM, '--fixture', fixture, '--fixtures', fixtureIds.join(','),
    '--repetitions', String(validated.repetitions), '--concurrency', String(concurrency), '--out', output,
    '--max-tokens', String(validated.maxTokens),
  ];
  console.log(`[openrouter qualification] dispatching one direct arm; fixtures=${fixtureIds.length} concurrency=${concurrency} repetitions=${validated.repetitions} child_timeout_ms=${normalizeChildTimeoutMs(childTimeoutMs)}`);
  const child = await runChild({ command: process.execPath, args, cwd: validated.botRoot, env, spawnImpl, timeoutMs: childTimeoutMs });
  const evaluation = readEvaluation(output, child.exitCode, validated.repetitions, fixtureIds);
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
      repetitions: process.env.QUALIFY_REPETITIONS,
      maxTokens: process.env.QUALIFY_MAX_TOKENS,
      outputContractMode: process.env.QUALIFY_OUTPUT_CONTRACT_MODE,
      fixtureId: process.env.QUALIFY_FIXTURE_ID,
      concurrency: process.env.QUALIFY_CONCURRENCY,
      providerSlug: process.env.QUALIFY_PROVIDER_SLUG,
      routingProfile: process.env.QUALIFY_ROUTING_PROFILE,
      model: process.env.QUALIFY_MODEL,
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
