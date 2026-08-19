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
  ignore: ['fireworks', 'open-inference', 'akashml'],
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

  const names = transports.map((transport) => transport.name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TRANSPORT_ORDER)) {
    throw new Error(`Review Yeti transport order must be ${EXPECTED_TRANSPORT_ORDER.join(' -> ')}`);
  }

  for (const transport of transports) {
    if (!transport.name || !transport.base_url || !transport.api_key_env || !transport.model || !['openai', 'openrouter'].includes(transport.compat)) {
      throw new Error(`transport ${transport.name || '<unnamed>'} is incomplete`);
    }
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

  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');
  if (JSON.stringify(openrouter?.provider_routing) !== JSON.stringify(EXPECTED_OPENROUTER_ROUTING)) {
    throw new Error('OpenRouter routing must require full-precision quants, throughput floors, and cheap-host failover');
  }
  if (openrouter?.allow_banned_providers !== undefined) {
    throw new Error('OpenRouter must not re-enable a hard-banned provider');
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
    stream: true,
    response_format: { type: 'json_object' },
  };

  if (transport.provider_routing) {
    request.provider = transport.provider_routing;
  }

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

export async function probeTransport(transport, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!apiKey) return { name: transport.name, status: 'missing' };

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

    if (!response.ok) {
      return {
        name: transport.name,
        status: 'unhealthy',
        code: `http_${response.status}`,
        http: response.status,
        elapsed_ms: elapsed(),
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
      };
    }

    return {
      name: transport.name,
      status: 'healthy',
      http: response.status,
      elapsed_ms: elapsed(),
    };
  } catch (error) {
    return {
      name: transport.name,
      status: 'unhealthy',
      code: error?.name === 'AbortError' ? 'timeout' : 'request_error',
      elapsed_ms: elapsed(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSmoke({ policy, policyPath, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = console.log } = {}) {
  const loadedPolicy = policy || loadPolicy(policyPath);
  const transports = validatePolicy(loadedPolicy);
  const results = [];
  const review = loadedPolicy.review_yeti || {};
  log(
    `[Review Yeti smoke] policy stream=${review.openrouter_stream ?? 'unset'} ` +
      `ttft_ms=${review.openrouter_ttft_ms ?? 'unset'} timeout_ms=${timeoutMs}`,
  );

  for (const transport of transports) {
    const result = await probeTransport(transport, env[transport.api_key_env], fetchImpl, timeoutMs);
    results.push(result);
    const timing = result.elapsed_ms != null ? ` elapsed_ms=${result.elapsed_ms}` : '';
    const http = result.http != null ? ` http=${result.http}` : '';
    log(`[Review Yeti smoke] ${result.name}: ${result.status}${timing}${http}${result.code ? ` (${result.code})` : ''}`);
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

async function main() {
  await runSmoke({ timeoutMs: Number(process.env.REVIEW_YETI_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Review Yeti transport smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
