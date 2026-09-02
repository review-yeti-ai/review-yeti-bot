import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { checkDeadTransportEnvelope } from './lane-deadline-invariant.mjs';
import {
  EXAMPLE_API_REPOSITORY,
  EXAMPLE_API_TRANSPORT_ORDER,
  resolvePolicyForRepository,
} from './repository-policy.mjs';
import { validateTransportEnvelope } from './transport-envelope.mjs';

export {
  EXAMPLE_API_REPOSITORY,
  EXAMPLE_API_TRANSPORT_ORDER,
  resolvePolicyForRepository,
} from './repository-policy.mjs';

export const EXPECTED_TRANSPORT_ORDER = Object.freeze([
  'openrouter-primary',
  'synthetic',
]);
export const EXPECTED_CONFIGURED_TRANSPORT_ORDER = Object.freeze([
  'openrouter-primary',
  'gemini',
  'ollama',
  'synthetic',
  'fireworks',
]);
export const EXPECTED_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const EXPECTED_GEMINI_MODEL = 'gemini-3.7-flash';
export const EXPECTED_SYNTHETIC_BASE_URL = 'https://api.synthetic.new/openai/v1';
export const EXPECTED_SYNTHETIC_MODEL = 'hf:zai-org/GLM-5.3-Flash';
export const SYNTHETIC_REQUESTS_PER_PACK = 500;
const SYNTHETIC_QUOTA_PATH = '/v2/quotas';
const DEFAULT_QUOTA_TIMEOUT_MS = 5_000;

const DEFAULT_POLICY_PATH = resolve(fileURLToPath(new URL('../policy/review-yeti.json', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 30_000;
export const EXPECTED_OPENROUTER_ROUTING = Object.freeze({
  allow_fallbacks: true,
  require_parameters: true,
  ignore: ['morph', 'fireworks'],
  sort: 'throughput',
  preferred_min_throughput: { p90: 40 },
  preferred_max_latency: { p99: 3 },
  data_collection: 'deny',
});
export const EXPECTED_OPENROUTER_MODELS = Object.freeze([
  'deepseek/deepseek-v4-flash-0731',
  'z-ai/glm-5.3-flash',
]);
export const EXPECTED_OPENROUTER_MODEL = EXPECTED_OPENROUTER_MODELS[0];

// Provider selectors freeze routing against an endpoint list that changes underneath us. The
// policy may retain a narrowly-scoped account safety exclusion for a provider with a verified
// outage, while all other endpoint eligibility remains OpenRouter's live decision. Rejecting
// only/order outright is deliberately stricter than validating a duplicated allowlist here.
const FORBIDDEN_ROUTING_SELECTORS = Object.freeze(['only', 'order']);

export function getEnabledTransports(policy) {
  const transports = policy?.review_yeti?.transports;
  return Array.isArray(transports) ? transports.filter((transport) => transport.enabled === true) : [];
}

export function validatePolicy(policy, repository = '') {
  policy = resolvePolicyForRepository(policy, repository);
  if (policy?.schema !== 'exampleorg.review-policy.v1') {
    throw new Error('unsupported Review Yeti policy schema');
  }

  const transports = policy.review_yeti?.transports;
  if (!Array.isArray(transports) || transports.length === 0) {
    throw new Error('Review Yeti policy must define transports');
  }

  const budget = policy.review_yeti?.budget;
  const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
  if (!['ordered', 'striped'].includes(policy.review_yeti?.dispatch_mode)) {
    throw new Error('Review Yeti dispatch_mode must be ordered or striped');
  }
  for (const [label, value] of [
    ['lane_deadline_ms', Number(budget?.lane_deadline_ms)],
    ['max_investigation_turns', Number(budget?.max_investigation_turns)],
    ['openrouter_max_attempts', Number(policy.review_yeti?.openrouter_max_attempts)],
  ]) {
    if (!positiveSafeInteger(value)) throw new Error(`Review Yeti ${label} must be a positive safe integer`);
  }
  const centralStallMs = Number(policy.review_yeti?.stall_ms);
  if (!positiveSafeInteger(centralStallMs)) {
    throw new Error('review_yeti.stall_ms must be a positive integer string');
  }

  const names = transports.map((transport) => transport.name);
  if (new Set(names).size !== names.length) throw new Error('transport names must be unique');
  for (const transport of transports) {
    if (typeof transport.enabled !== 'boolean') {
      throw new Error(`transport ${transport.name || '<unnamed>'} enabled must be a boolean`);
    }
  }
  const enabledTransports = getEnabledTransports(policy);
  const enabledNames = enabledTransports.map((transport) => transport.name);
  if (transports.some((transport) => transport.name === 'fireworks' && transport.enabled === true)) {
    throw new Error('Fireworks transport is disabled');
  }
  const expectedOrder = repository === EXAMPLE_API_REPOSITORY
    ? EXAMPLE_API_TRANSPORT_ORDER
    : EXPECTED_TRANSPORT_ORDER;
  if (JSON.stringify(enabledNames) !== JSON.stringify(expectedOrder)) {
    throw new Error(`Review Yeti transport order must be ${expectedOrder.join(' -> ')}`);
  }
  const expectedDispatchMode = repository === EXAMPLE_API_REPOSITORY ? 'ordered' : 'striped';
  if (policy.review_yeti.dispatch_mode !== expectedDispatchMode) {
    throw new Error(`Review Yeti dispatch_mode must be ${expectedDispatchMode} for ${repository || 'the default policy'}`);
  }

  for (const transport of transports) {
    if (!transport.name || !transport.base_url || !transport.api_key_env || !transport.model || !['openai', 'openrouter'].includes(transport.compat)) {
      throw new Error(`transport ${transport.name || '<unnamed>'} is incomplete`);
    }
    for (const key of ['timeout_ms', 'connect_timeout_ms', 'ttft_ms', 'stall_ms']) {
      if (!positiveSafeInteger(transport[key])) {
        throw new Error(`transport ${transport.name} ${key} must be a positive safe integer`);
      }
    }
    if (transport.max_tokens !== undefined && !positiveSafeInteger(Number(transport.max_tokens))) {
      throw new Error(`transport ${transport.name} max_tokens must be a positive safe integer when declared`);
    }
    for (const key of ['connect_timeout_ms', 'ttft_ms', 'stall_ms']) {
      if (transport[key] > transport.timeout_ms) {
        throw new Error(`transport ${transport.name} ${key} must not exceed timeout_ms`);
      }
    }
    validateTransportEnvelope(transport);
    if (transport.stream !== true) throw new Error(`transport ${transport.name} must stream`);
  }

  const gemini = transports.find((transport) => transport.name === 'gemini');
  const synthetic = transports.find((transport) => transport.name === 'synthetic');
  const ollama = transports.find((transport) => transport.name === 'ollama');
  const fireworks = transports.find((transport) => transport.name === 'fireworks');
  const openrouter = transports.find((transport) => transport.name === 'openrouter-primary');
  if (!gemini || !ollama || !synthetic || !fireworks || !openrouter
      || (repository !== EXAMPLE_API_REPOSITORY && openrouter.enabled !== true)) {
    throw new Error('policy must define OpenRouter, Gemini, Ollama, and Synthetic transports');
  }

  if (gemini.base_url !== EXPECTED_GEMINI_BASE_URL
      || gemini.api_key_env !== 'GEMINI_API_KEY'
      || gemini.model !== EXPECTED_GEMINI_MODEL
      || gemini.compat !== 'openai'
      || gemini.structured_output !== 'strict'
      || gemini.reasoning_effort !== 'high') {
    throw new Error('Gemini must use the pinned Google OpenAI-compatible endpoint/model with strict high-reasoning output');
  }
  if (synthetic.base_url !== EXPECTED_SYNTHETIC_BASE_URL
      || synthetic.api_key_env !== 'SYNTHETIC_API_KEY'
      || synthetic.model !== EXPECTED_SYNTHETIC_MODEL
      || synthetic.compat !== 'openai'
      || synthetic.max_in_flight !== 5
      || synthetic.concurrency_scope !== 'model'
      || synthetic.quota_probe !== 'synthetic-v2'
      || synthetic.structured_output !== 'strict'
      || synthetic.reasoning_effort !== 'high') {
    throw new Error('Synthetic must use the pinned endpoint/model, a five-pack per-model ceiling, quota-bounded admission, and strict high-reasoning output');
  }
  if (fireworks.base_url !== 'https://api.fireworks.ai/inference/v1'
      || fireworks.api_key_env !== 'FIREWORKS_PR_REVIEW_API_KEY'
      || fireworks.model !== 'accounts/fireworks/models/deepseek-v4-flash-0731'
      || fireworks.compat !== 'openai'
      || fireworks.structured_output !== 'strict'
      || fireworks.perf_metrics_in_response !== true
      || fireworks.reasoning_effort !== 'high') {
    throw new Error('Fireworks must remain declared with its existing disabled transport contract');
  }

  if (ollama.reasoning_effort !== 'high') throw new Error('Ollama must use high reasoning');
  if (ollama.max_in_flight !== 1
      || ollama.concurrency_scope !== 'provider'
      || ollama.capacity_wait_timeout_ms !== 30000
      || ollama.dispatch_weight !== 1) {
    throw new Error('Ollama must use one provider-scoped slot and a bounded 30-second admission wait');
  }

  // Checked BEFORE the exact-shape comparison below. That comparison would also reject a pinned
  // policy, but only with a generic "routing must leave selection to OpenRouter" message, which
  // says nothing about which key is at fault or why it is fatal. It also applies to every
  // transport, not just the fallback: any transport that pins a provider can select a hard-banned
  // slug and crash the panel before a single persona runs.
  for (const transport of transports) {
    for (const selector of FORBIDDEN_ROUTING_SELECTORS) {
      if (transport.provider_routing?.[selector] !== undefined) {
        throw new Error(
          `transport ${transport.name} pins provider routing via "${selector}"; `
          + 'routing must be left to OpenRouter so a hard-banned provider can never be selected',
        );
      }
    }
  }

  if (JSON.stringify(openrouter?.provider_routing) !== JSON.stringify(EXPECTED_OPENROUTER_ROUTING)) {
    throw new Error('OpenRouter routing must delegate provider selection, preserve the blocked-provider exclusions, and keep throughput floors/fallbacks');
  }
  if (openrouter?.allow_banned_providers !== undefined) {
    throw new Error('OpenRouter must not re-enable a hard-banned provider');
  }
  if (openrouter?.plugins !== undefined) {
    throw new Error('OpenRouter explicit model fallback must not use auto-router plugins');
  }
  if (openrouter?.model !== EXPECTED_OPENROUTER_MODEL
      || JSON.stringify(openrouter?.models) !== JSON.stringify(EXPECTED_OPENROUTER_MODELS.slice(1))) {
    throw new Error('OpenRouter must use only the approved DeepSeek V4 Flash 0731 primary and GLM-5.3 Flash fallback models');
  }
  if (openrouter?.dispatch_weight !== 2
      || openrouter?.max_in_flight !== 2
      || openrouter?.concurrency_scope !== 'provider'
      || openrouter?.capacity_wait_timeout_ms !== 180000) {
    throw new Error('OpenRouter must use bounded 2:1 striping with two provider-scoped slots and a 180-second admission wait');
  }
  // The approved route leaves reasoning selection to the model/provider contract; pinning `max`
  // would force a previously measured worst-performing arm.
  if (openrouter?.reasoning_effort === 'max') {
    throw new Error("OpenRouter must not use reasoning_effort 'max'; measured ablation: recall 0.425 vs 0.750 and 3.5x the errors");
  }
  if (openrouter?.structured_output !== 'strict') throw new Error('OpenRouter must use strict investigation output');
  for (const transport of enabledTransports) {
    if (transport.quarantine_on_timeout !== false) {
      throw new Error(`active transport ${transport.name} must keep timeouts lane-local`);
    }
  }
  if (policy.review_yeti?.openrouter_max_attempts !== '2') throw new Error('each transport must retain one retry');
  if (policy.review_yeti?.openrouter_stream !== 'true') throw new Error('OpenRouter must use streaming for provider attribution');
  if (openrouter?.timeout_ms !== Number(policy.review_yeti?.openrouter_timeout_ms)) {
    throw new Error('OpenRouter transport timeout must match the central request timeout');
  }
  if (openrouter?.ttft_ms !== Number(policy.review_yeti?.openrouter_ttft_ms)) {
    throw new Error('OpenRouter transport TTFT must match the central request TTFT');
  }
  if (openrouter?.stall_ms !== centralStallMs) {
    throw new Error('OpenRouter transport stall must match the central stall timeout');
  }
  const maxAttempts = Number(policy.review_yeti?.openrouter_max_attempts);
  const maxInvestigationTurns = Number(budget.max_investigation_turns);
  // Shared with emit-policy.mjs via lane-deadline-invariant.mjs so the two enforcement points
  // cannot drift again (this copy has already drifted from the primary once: first missing
  // stall_ms validation, then missing lane_overhead_ms in the arithmetic entirely).
  checkDeadTransportEnvelope({
    transports: enabledTransports,
    maxAttempts,
    maxInvestigationTurns,
    laneOverheadMs: Number(budget.lane_overhead_ms),
    laneDeadlineMs: Number(budget.lane_deadline_ms),
  });

  return enabledTransports;
}

export function loadPolicy(
  policyPath = process.env.REVIEW_YETI_POLICY_PATH || DEFAULT_POLICY_PATH,
  repository = process.env.REVIEW_REPOSITORY || '',
) {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const resolved = resolvePolicyForRepository(policy, repository);
  validatePolicy(resolved, repository);
  return resolved;
}

export function buildRequest(transport) {
  const isGemini = transport.name === 'gemini' || transport.base_url === EXPECTED_GEMINI_BASE_URL;
  const request = {
    model: transport.model,
    messages: [
      { role: 'system', content: 'You are a Review Yeti transport smoke test. Do not inspect files.' },
      { role: 'user', content: 'Return exactly {"ok":true,"review":"SMOKE_OK"} as a JSON object.' },
    ],
    // Reasoning models can spend the first part of a short probe budget on hidden thought
    // tokens. 128 caused Gemini 3.7 Flash to finish with `length` before emitting JSON even
    // though the endpoint was healthy. Keep the probe bounded, but leave enough room for the
    // terminal object so a valid provider is not falsely admitted as unhealthy.
    max_tokens: 512,
    stream: transport.stream === true,
    ...(transport.structured_output === 'none' ? {} : { response_format: { type: 'json_object' } }),
    // Gemini 3.7's compatibility layer documents temperature/top-k/top-p as deprecated. Keep
    // the direct Gemini probe on the documented request shape while retaining deterministic
    // sampling for the other OpenAI-compatible transports.
    ...(isGemini ? {} : { temperature: 0 }),
  };

  if (transport.provider_routing) {
    request.provider = transport.provider_routing;
  }
  if (Array.isArray(transport.models)) {
    request.models = transport.models;
  }
  if (transport.reasoning_effort) {
    if (transport.compat === 'openrouter') request.reasoning = { effort: transport.reasoning_effort };
    else request.reasoning_effort = transport.reasoning_effort;
  }
  if (transport.perf_metrics_in_response === true) request.perf_metrics_in_response = true;
  if (Array.isArray(transport.plugins)) request.plugins = transport.plugins;

  return request;
}

function extractJsonObject(content) {
  if (typeof content !== 'string') return null;
  const unwrapped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unwrapped.indexOf('{');
  const end = unwrapped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(unwrapped.slice(start, end + 1));
  } catch {
    return null;
  }
}

function responseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return content;
}

const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/iu;

function safeErrorCode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SAFE_ERROR_CODE.test(normalized) ? normalized : null;
}

// Keep provider diagnostics bounded and structured. Never copy provider messages, URLs, or
// response bodies into logs or outputs: those fields can contain secrets or arbitrary user text.
export function classifyHttpFailure(status, payload = {}) {
  const providerError = payload?.error;
  const errorCode = safeErrorCode(
    typeof providerError === 'object' && providerError !== null
      ? (providerError.code ?? providerError.type)
      : null,
  );
  let failureClass = 'provider_error';
  if (status === 401 || status === 403) failureClass = 'auth';
  else if (status === 404) failureClass = 'not_found';
  else if (status === 408) failureClass = 'timeout_or_connect';
  else if (status === 429) failureClass = 'rate_limit';
  else if (status >= 500 && status <= 599) failureClass = 'upstream_5xx';
  return { failureClass, errorCode };
}

async function readChatCompletion(response) {
  const contentType = typeof response.headers?.get === 'function'
    ? (response.headers.get('content-type') || '')
    : '';
  if (!contentType.includes('event-stream')) {
    return response.json();
  }

  const text = typeof response.text === 'function' ? await response.text() : '';
  const pieces = [];
  let last = null;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      last = JSON.parse(data);
      const delta = last?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') pieces.push(delta);
    } catch {
      // ignore a truncated SSE chunk
    }
  }
  if (typeof last?.choices?.[0]?.message?.content === 'string') return last;
  if (pieces.length > 0) {
    return { choices: [{ message: { content: pieces.join('') } }] };
  }
  throw new Error('empty_sse');
}

export async function probeTransport(
  transport,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttftMs = timeoutMs,
) {
  if (!apiKey) return { name: transport.name, status: 'missing' };

  const started = Date.now();
  const controller = new AbortController();
  let timeoutStage = 'ttft';
  let timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, ttftMs));
  const elapsed = () => Date.now() - started;
  try {
    const response = await fetchImpl(`${transport.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequest(transport)),
      signal: controller.signal,
    });
    const measuredTtftMs = elapsed();
    clearTimeout(timeout);
    timeoutStage = 'response';
    timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs - measuredTtftMs));

    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // A non-JSON error is still classified by HTTP status; body text is intentionally ignored.
      }
      const { failureClass, errorCode } = classifyHttpFailure(response.status, payload);
      return {
        name: transport.name,
        status: 'unhealthy',
        code: `http_${response.status}`,
        failure_class: failureClass,
        ...(errorCode ? { error_code: errorCode } : {}),
        http: response.status,
        elapsed_ms: elapsed(),
        ttft_ms: measuredTtftMs,
      };
    }

    const payload = await readChatCompletion(response);
    const result = extractJsonObject(responseContent(payload));
    if (result?.ok !== true || result.review !== 'SMOKE_OK') {
      return {
        name: transport.name,
        status: 'unhealthy',
        code: 'invalid_response',
        http: response.status,
        elapsed_ms: elapsed(),
        ttft_ms: measuredTtftMs,
      };
    }

    return {
      name: transport.name,
      status: 'healthy',
      http: response.status,
      elapsed_ms: elapsed(),
      ttft_ms: measuredTtftMs,
    };
  } catch (error) {
    return {
      name: transport.name,
      status: 'unhealthy',
      code: error?.name === 'AbortError'
        ? (timeoutStage === 'ttft' ? 'ttft_timeout' : 'timeout')
        : 'request_error',
      failure_class: error?.name === 'AbortError' ? 'timeout_or_connect' : 'network',
      elapsed_ms: elapsed(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSmoke({
  policy,
  policyPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttftMs,
  log = console.log,
} = {}) {
  const repository = env.REVIEW_REPOSITORY || '';
  const loadedPolicy = policy
    ? resolvePolicyForRepository(policy, repository)
    : loadPolicy(policyPath, repository);
  const transports = validatePolicy(loadedPolicy, repository);
  const results = [];
  const review = loadedPolicy.review_yeti || {};
  const effectiveTtftMs = Number(ttftMs ?? review.openrouter_ttft_ms ?? timeoutMs);
  if (!Number.isFinite(effectiveTtftMs) || effectiveTtftMs <= 0) {
    throw new Error('Review Yeti smoke TTFT budget must be a positive number');
  }
  log(
    `[Review Yeti smoke] policy stream=${review.openrouter_stream ?? 'unset'} ` +
      `ttft_ms=${effectiveTtftMs} timeout_ms=${timeoutMs}`,
  );

  for (const transport of transports) {
    const result = await probeTransport(
      transport,
      env[transport.api_key_env],
      fetchImpl,
      timeoutMs,
      effectiveTtftMs,
    );
    results.push(result);
    const timing = result.elapsed_ms != null ? ` elapsed_ms=${result.elapsed_ms}` : '';
    const http = result.http != null ? ` http=${result.http}` : '';
    const ttft = result.ttft_ms != null ? ` ttft_ms=${result.ttft_ms}` : '';
    const failure = result.failure_class ? ` failure_class=${result.failure_class}` : '';
    const errorCode = result.error_code ? ` error_code=${result.error_code}` : '';
    log(`[Review Yeti smoke] ${result.name}: ${result.status}${timing}${http}${ttft}${failure}${errorCode}${result.code ? ` (${result.code})` : ''}`);
  }

  const healthy = results.filter((result) => result.status === 'healthy').map((result) => result.name);
  if (healthy.length === 0) {
    throw new Error('no healthy Review Yeti transport; refusing to run the review panel');
  }

  const unhealthy = results
    .filter((result) => result.status === 'unhealthy')
    .map((result) => `${result.name}${result.code ? ` (${result.code})` : ''}`);
  if (unhealthy.length > 0) {
    log(`[Review Yeti smoke] unhealthy optional transport(s): ${unhealthy.join(', ')}; continuing with healthy transport(s).`);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      '## Review Yeti transport smoke test',
      '',
      `- Healthy transports: ${healthy.join(', ')}`,
      ...(unhealthy.length > 0 ? [`- Unhealthy optional transports: ${unhealthy.join(', ')}`] : []),
      `- Enabled order: ${transports.map((transport) => transport.name).join(' -> ')}`,
      '- Secret values are intentionally omitted.',
      '',
    ].join('\n'));
  }

  return { results, healthy };
}

// Pick the highest-priority healthy transport to seed the action's legacy single-transport
// inputs. The complete healthy subset is emitted separately for per-lane failover.
export function resolveTransport(
  transports,
  healthy,
  order = transports.filter((transport) => transport.enabled === true).map((transport) => transport.name),
) {
  const healthySet = new Set(healthy);
  const enabledTransports = transports.filter((transport) => transport.enabled === true);
  for (const name of order) {
    if (healthySet.has(name)) {
      const transport = enabledTransports.find((candidate) => candidate.name === name);
      if (transport) return transport;
    }
  }
  return null;
}

// A preflight result is an admission decision for this run, not merely telemetry. Keeping an
// unhealthy transport in the action input makes every persona rediscover the same known failure
// and can consume the entire lane deadline before a healthy fallback is reached.
export function selectHealthyTransports(transports, healthy) {
  const healthySet = new Set(healthy);
  return transports.filter((transport) => transport.enabled === true && healthySet.has(transport.name));
}

function syntheticFiveHourLimit(payload) {
  for (const value of [payload?.rollingFiveHourLimit?.max, payload?.subscription?.limit]) {
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

// Synthetic publishes one concurrent request per model per subscription pack and 500 requests in
// the rolling five-hour bucket per pack. Treat the policy value as an upper bound, derive the live
// pack count only from an exact documented multiple, and fail safe to one slot when the advisory
// endpoint is unavailable or its under-development response shape is ambiguous.
export function syntheticCapacityFromQuota(payload, configuredMaxInFlight) {
  const configured = Number(configuredMaxInFlight);
  if (!Number.isSafeInteger(configured) || configured < 1) return 1;
  const fiveHourLimit = syntheticFiveHourLimit(payload);
  if (!Number.isSafeInteger(fiveHourLimit)
      || fiveHourLimit < SYNTHETIC_REQUESTS_PER_PACK
      || fiveHourLimit % SYNTHETIC_REQUESTS_PER_PACK !== 0) {
    return 1;
  }
  const packCount = fiveHourLimit / SYNTHETIC_REQUESTS_PER_PACK;
  return Math.max(1, Math.min(configured, packCount));
}

export function syntheticQuotaUrl(transport) {
  if (transport?.quota_probe !== 'synthetic-v2'
      || transport?.base_url !== EXPECTED_SYNTHETIC_BASE_URL) {
    return null;
  }
  try {
    const providerBaseUrl = new URL(transport.base_url);
    const pinnedBaseUrl = new URL(EXPECTED_SYNTHETIC_BASE_URL);
    if (providerBaseUrl.protocol !== 'https:' || providerBaseUrl.origin !== pinnedBaseUrl.origin) {
      return null;
    }
    return new URL(SYNTHETIC_QUOTA_PATH, providerBaseUrl.origin).toString();
  } catch {
    return null;
  }
}

export async function boundSyntheticCapacity(
  transports,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
) {
  const synthetic = transports.find((transport) => transport.quota_probe === 'synthetic-v2');
  if (!synthetic) return transports;

  let payload = null;
  let source = 'fail-safe';
  const apiKey = env[synthetic.api_key_env];
  const quotaUrl = syntheticQuotaUrl(synthetic);
  if (apiKey && quotaUrl) {
    try {
      const response = await fetchImpl(quotaUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        payload = await response.json();
        source = syntheticFiveHourLimit(payload) === null ? 'fail-safe' : 'live-quota';
      }
    } catch {
      // Quota telemetry must never prevent a healthy provider from being used. The one-slot
      // fail-safe matches the minimum subscription contract and prevents over-admission.
    }
  }

  const maxInFlight = syntheticCapacityFromQuota(payload, synthetic.max_in_flight);
  log(`[Review Yeti smoke] synthetic capacity max_in_flight=${maxInFlight} source=${source}.`);
  return transports.map((transport) => transport === synthetic
    ? { ...transport, max_in_flight: maxInFlight }
    : transport);
}

export function encodeTransportPlan(transports) {
  return Buffer.from(JSON.stringify(transports), 'utf8').toString('base64');
}

async function main() {
  const { results, healthy } = await runSmoke({
    timeoutMs: Number(process.env.REVIEW_YETI_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
  // runSmoke() already throws when `healthy` is empty, so reaching here guarantees at least one
  // resolvable transport -- this never silently degrades to "no transport, run anyway".
  const policy = loadPolicy();
  const transports = validatePolicy(policy, process.env.REVIEW_REPOSITORY || '');
  const resolved = resolveTransport(transports, healthy);
  if (!resolved) throw new Error('no healthy transport could be resolved from a validated policy');
  const healthyTransports = await boundSyntheticCapacity(
    selectHealthyTransports(transports, healthy),
  );

  const expectedOrder = transports.map((transport) => transport.name);
  const degraded = resolved.name !== expectedOrder[0];
  console.log(
    `[Review Yeti smoke] resolved_transport=${resolved.name}${degraded ? ' (DEGRADED: primary transport unhealthy, seeding the panel with the next healthy transport)' : ''}`,
  );

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const outputs = {
      resolved_transport: resolved.name,
      resolved_base_url: resolved.base_url,
      resolved_model: resolved.model,
      resolved_api_key_env: resolved.api_key_env,
      resolved_degraded: String(degraded),
      healthy_transports: JSON.stringify(healthyTransports),
      healthy_transport_plan_b64: encodeTransportPlan(healthyTransports),
    };
    for (const [name, value] of Object.entries(outputs)) {
      appendFileSync(outputPath, `${name}=${value}\n`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY && degraded) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '',
      `> ⚠️ **Degraded**: primary transport (${expectedOrder[0]}) unhealthy this run; the full review panel ran on **${resolved.name}** instead.`,
      '',
    ].join('\n'));
  }

  void results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Review Yeti transport smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
