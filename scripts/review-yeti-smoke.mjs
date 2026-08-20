import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const EXPECTED_TRANSPORT_ORDER = Object.freeze([
  'fireworks',
  'ollama',
  'openrouter-fallback',
]);

const DEFAULT_POLICY_PATH = resolve(fileURLToPath(new URL('../policy/review-yeti.json', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 30_000;
export const EXPECTED_OPENROUTER_ROUTING = Object.freeze({
  allow_fallbacks: true,
  require_parameters: true,
  quantizations: ['bf16', 'fp16'],
  sort: 'throughput',
  preferred_min_throughput: { p90: 40 },
  preferred_max_latency: { p99: 3 },
  data_collection: 'deny',
  ignore: ['fireworks', 'open-inference', 'akashml', 'morph'],
});

// The action hard-bans a set of OpenRouter provider slugs that were returning degraded endpoint
// health, and `resolveProviderRouting` throws outright — before any persona runs — if routing
// *selects* one of them via `only`/`order`. A policy can therefore be structurally valid, pass
// every shape assertion here, and still fatally crash the panel on the first call.
//
// That is not hypothetical: pinning `only: ['fireworks']` shipped green and took down review for
// every consumer repo, because nothing in this suite exercised the selection path. Pinning is
// also independently unwanted -- `only`/`order` freeze routing against a provider list that
// changes underneath us, which is why routing is left to OpenRouter's own selection.
//
// Rejecting the keys outright is deliberately stricter than mirroring the action's ban list:
// duplicating that list here would drift the moment the action edits it, and a stale copy would
// re-open exactly this hole.
const FORBIDDEN_ROUTING_SELECTORS = Object.freeze(['only', 'order']);

export function validatePolicy(policy) {
  if (policy?.schema !== 'exampleorg.review-policy.v1') {
    throw new Error('unsupported Review Yeti policy schema');
  }

  const transports = policy.review_yeti?.transports;
  if (!Array.isArray(transports) || transports.length === 0) {
    throw new Error('Review Yeti policy must define transports');
  }

  const budget = policy.review_yeti?.budget;
  const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
  for (const [label, value] of [
    ['lane_deadline_ms', Number(budget?.lane_deadline_ms)],
    ['max_investigation_turns', Number(budget?.max_investigation_turns)],
    ['openrouter_max_attempts', Number(policy.review_yeti?.openrouter_max_attempts)],
  ]) {
    if (!positiveSafeInteger(value)) throw new Error(`Review Yeti ${label} must be a positive safe integer`);
  }

  const names = transports.map((transport) => transport.name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TRANSPORT_ORDER)) {
    throw new Error(`Review Yeti transport order must be ${EXPECTED_TRANSPORT_ORDER.join(' -> ')}`);
  }

  for (const transport of transports) {
    if (!transport.name || !transport.base_url || !transport.api_key_env || !transport.model || !['openai', 'openrouter'].includes(transport.compat)) {
      throw new Error(`transport ${transport.name || '<unnamed>'} is incomplete`);
    }
    if (!positiveSafeInteger(transport.timeout_ms) || !positiveSafeInteger(transport.connect_timeout_ms)) {
      throw new Error(`transport ${transport.name} timeout budgets must be positive safe integers`);
    }
    if (transport.connect_timeout_ms > transport.timeout_ms) {
      throw new Error(`transport ${transport.name} connect timeout must not exceed timeout`);
    }
    if (transport.stream !== true) throw new Error(`transport ${transport.name} must stream`);
  }

  // Fireworks must NOT pin reasoning_effort. Measured ablation 2026-08-20, live,
  // deepseek-v4-flash-0731, N=8 reps x 9 fixtures x 3 arms, errored runs counted as failures:
  //   arm       recall               errors      median latency
  //   none      0.275 [0.16-0.43]     3/72 (4%)     6.6s
  //   unset     0.750 [0.60-0.86]     7/72 (10%)   43.1s   <- best, and what this asserts
  //   max       0.425 [0.29-0.58]    25/72 (35%)   83.3s
  // `max` lost on detection with non-overlapping CIs against unset AND carried 3.5x the failure
  // rate. Its median reasoning output was *lower* than unset's (837 vs 2,902 chars) -- consistent
  // with blowing past the per-attempt budget mid-thought rather than reasoning further. The
  // previous rule required exactly the worst-performing arm.
  if (transports[0].reasoning_effort !== undefined) {
    throw new Error('Fireworks must not pin reasoning_effort; measured ablation favours the provider default');
  }
  if (transports[0].perf_metrics_in_response !== true) {
    throw new Error('Fireworks must report performance metrics');
  }
  if (transports[0].structured_output !== 'strict') throw new Error('Fireworks must use strict investigation output');
  if (transports[1].reasoning_effort !== 'high') throw new Error('Ollama must use high reasoning');

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

  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');
  if (JSON.stringify(openrouter?.provider_routing) !== JSON.stringify(EXPECTED_OPENROUTER_ROUTING)) {
    throw new Error('OpenRouter routing must require full-precision quants, throughput floors, and fallback');
  }
  if (openrouter?.allow_banned_providers !== undefined) {
    throw new Error('OpenRouter must not re-enable a hard-banned provider');
  }
  // Same measured ablation as the fireworks rule above (2026-08-20, live, N=8x9x3, errored runs
  // counted as failures): `max` scored recall 0.425 [0.29-0.58] with 25/72 errors, versus unset at
  // 0.750 [0.60-0.86] with 7/72. Non-overlapping CIs, 3.5x the failure rate. Pinning `max` here
  // required exactly the worst-measured arm.
  if (openrouter?.reasoning_effort !== undefined) {
    throw new Error('OpenRouter must not pin reasoning_effort; measured ablation favours the provider default');
  }
  if (openrouter?.model !== 'deepseek/deepseek-v4-flash-0731') throw new Error('OpenRouter must use the approved structured-output fallback model');
  if (openrouter?.structured_output !== 'strict') throw new Error('OpenRouter must use strict investigation output');
  if (openrouter?.quarantine_on_timeout !== false) throw new Error('OpenRouter must own timeout rerouting');
  if (policy.review_yeti?.openrouter_max_attempts !== '2') throw new Error('each transport must retain one retry');
  if (policy.review_yeti?.openrouter_stream !== 'true') throw new Error('OpenRouter must use streaming for provider attribution');
  if (openrouter?.timeout_ms !== Number(policy.review_yeti?.openrouter_timeout_ms)) {
    throw new Error('OpenRouter transport timeout must match the central request timeout');
  }
  const maxAttempts = Number(policy.review_yeti?.openrouter_max_attempts);
  const maxInvestigationTurns = Number(budget.max_investigation_turns);
  const transportTimeoutSum = transports.reduce((sum, transport) => sum + transport.timeout_ms, 0);
  const worstCaseLaneMs = transportTimeoutSum * maxAttempts * maxInvestigationTurns;
  if (Number(budget.lane_deadline_ms) < worstCaseLaneMs) {
    throw new Error('lane deadline must cover the bounded transport, retry, and investigation-turn envelope');
  }

  return transports;
}

export function loadPolicy(policyPath = process.env.REVIEW_YETI_POLICY_PATH || DEFAULT_POLICY_PATH) {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  validatePolicy(policy);
  return policy;
}

export function buildRequest(transport) {
  const request = {
    model: transport.model,
    messages: [
      { role: 'system', content: 'You are a Review Yeti transport smoke test. Do not inspect files.' },
      { role: 'user', content: 'Return exactly {"ok":true,"review":"SMOKE_OK"} as a JSON object.' },
    ],
    temperature: 0,
    max_tokens: 128,
    stream: transport.stream === true,
    ...(transport.structured_output === 'none' ? {} : { response_format: { type: 'json_object' } }),
  };

  if (transport.provider_routing) {
    request.provider = transport.provider_routing;
  }
  if (transport.reasoning_effort) {
    if (transport.compat === 'openrouter') request.reasoning = { effort: transport.reasoning_effort };
    else request.reasoning_effort = transport.reasoning_effort;
  }
  if (transport.perf_metrics_in_response === true) request.perf_metrics_in_response = true;

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
      return {
        name: transport.name,
        status: 'unhealthy',
        code: `http_${response.status}`,
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
  const loadedPolicy = policy || loadPolicy(policyPath);
  const transports = validatePolicy(loadedPolicy);
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
    log(`[Review Yeti smoke] ${result.name}: ${result.status}${timing}${http}${ttft}${result.code ? ` (${result.code})` : ''}`);
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
      `- Configured order: ${EXPECTED_TRANSPORT_ORDER.join(' -> ')}`,
      '- Secret values are intentionally omitted.',
      '',
    ].join('\n'));
  }

  return { results, healthy };
}

// Pick the highest-priority healthy transport to seed the action's legacy single-transport
// inputs. The complete healthy subset is emitted separately for per-lane failover.
export function resolveTransport(transports, healthy, order = EXPECTED_TRANSPORT_ORDER) {
  const healthySet = new Set(healthy);
  for (const name of order) {
    if (healthySet.has(name)) {
      const transport = transports.find((candidate) => candidate.name === name);
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
  return transports.filter((transport) => healthySet.has(transport.name));
}

async function main() {
  const { results, healthy } = await runSmoke({
    timeoutMs: Number(process.env.REVIEW_YETI_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
  // runSmoke() already throws when `healthy` is empty, so reaching here guarantees at least one
  // resolvable transport -- this never silently degrades to "no transport, run anyway".
  const policy = loadPolicy();
  const resolved = resolveTransport(policy.review_yeti.transports, healthy);
  if (!resolved) throw new Error('no healthy transport could be resolved from a validated policy');
  const healthyTransports = selectHealthyTransports(policy.review_yeti.transports, healthy);

  const degraded = resolved.name !== EXPECTED_TRANSPORT_ORDER[0];
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
    };
    for (const [name, value] of Object.entries(outputs)) {
      appendFileSync(outputPath, `${name}=${value}\n`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY && degraded) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '',
      `> ⚠️ **Degraded**: primary transport (${EXPECTED_TRANSPORT_ORDER[0]}) unhealthy this run; the full review panel ran on **${resolved.name}** instead.`,
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
