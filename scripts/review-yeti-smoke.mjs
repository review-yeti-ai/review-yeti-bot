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
  quantizations: ['fp8', 'bf16'],
  sort: 'throughput',
  preferred_min_throughput: { p90: 40 },
  preferred_max_latency: { p99: 3 },
  data_collection: 'deny',
});

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

  const openrouter = transports.find((transport) => transport.name === 'openrouter-fallback');
  if (JSON.stringify(openrouter?.provider_routing) !== JSON.stringify(EXPECTED_OPENROUTER_ROUTING)) {
    throw new Error('OpenRouter routing must enforce the approved full-quantization performance policy');
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

export async function probeTransport(transport, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!apiKey) return { name: transport.name, status: 'missing' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

    if (!response.ok) return { name: transport.name, status: 'unhealthy', code: `http_${response.status}` };

    const payload = await response.json();
    const result = extractJsonObject(responseContent(payload));
    if (result?.ok !== true || result.review !== 'SMOKE_OK') {
      return { name: transport.name, status: 'unhealthy', code: 'invalid_response' };
    }

    return { name: transport.name, status: 'healthy' };
  } catch (error) {
    return {
      name: transport.name,
      status: 'unhealthy',
      code: error?.name === 'AbortError' ? 'timeout' : 'request_error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSmoke({ policy, policyPath, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, log = console.log } = {}) {
  const loadedPolicy = policy || loadPolicy(policyPath);
  const transports = validatePolicy(loadedPolicy);
  const results = [];

  for (const transport of transports) {
    const result = await probeTransport(transport, env[transport.api_key_env], fetchImpl, timeoutMs);
    results.push(result);
    log(`[Review Yeti smoke] ${result.name}: ${result.status}${result.code ? ` (${result.code})` : ''}`);
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
