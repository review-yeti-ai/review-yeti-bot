'use strict';

/**
 * openRouterPolicy.js
 * Resolves the enforced OpenRouter routing + client policy for a review request.
 *
 * Shared by the composite-action pipeline (review-pipeline.js) and its unit tests.
 *
 * Precedence (high → low):
 *   1. Explicit action inputs (env OPENROUTER_ALLOWED_MODELS /
 *      OPENROUTER_COST_QUALITY_TRADEOFF / OPENROUTER_DATA_COLLECTION /
 *      OPENROUTER_IGNORE_PROVIDERS / OPENROUTER_PROVIDER_ROUTING /
 *      OPENROUTER_TIMEOUT_MS / OPENROUTER_STREAM / OPENROUTER_FALLBACK_MODELS);
 *   2. The base-owned `.review-yeti.yaml` github_action.openrouter block
 *      (allowed_models / cost_quality_tradeoff / data_collection /
 *      ignore_providers / provider_routing / timeout_ms / stream / fallback_models);
 *   3. Defaults (no allowlist, no tradeoff, no data-collection header,
 *      deepinfra, the openrouter fallback route, and known degraded providers
 *      ignored, timeout_ms=30000, stream=false).
 *
 * @param {object|undefined} localConfig  Parsed local config, or an object whose
 *    `parsed` field holds the parse result (as produced by the pipeline).
 * @param {object} env  Environment to read action inputs from (defaults to process.env).
 * @returns {{
 *   allowedModels: string[],
 *   costQualityTradeoff: (number|undefined),
 *   dataCollection: ('allow'|'deny'|undefined),
 *   ignoredProviders: string[],
 *   timeoutMs: number,
 *   stream: boolean,
 *   fallbackModels: string[],
 *   providerRouting: object,
 * }}
 */
function resolveOpenRouterPolicy(localConfig, env) {
  if (env === undefined) env = (typeof process !== 'undefined' ? process.env : {});
  const parsed = localConfig?.parsed && typeof localConfig.parsed === 'object'
    ? localConfig.parsed
    : (localConfig && typeof localConfig === 'object' ? localConfig : {});
  const githubAction = parsed.github_action && typeof parsed.github_action === 'object'
    ? parsed.github_action
    : {};
  const cfgOr = githubAction.openrouter && typeof githubAction.openrouter === 'object'
    ? githubAction.openrouter
    : (parsed.openrouter && typeof parsed.openrouter === 'object' ? parsed.openrouter : {});

  const splitCsv = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);

  // 1. Explicit action inputs win.
  const envModel = typeof env.OPENROUTER_MODEL === 'string' ? env.OPENROUTER_MODEL.trim() : '';
  const envAllowed = splitCsv(env.OPENROUTER_ALLOWED_MODELS);
  const envTradeoff = env.OPENROUTER_COST_QUALITY_TRADEOFF;
  const envData = env.OPENROUTER_DATA_COLLECTION;
  const envIgnored = splitCsv(env.OPENROUTER_IGNORE_PROVIDERS);
  const envProviderRouting = typeof env.OPENROUTER_PROVIDER_ROUTING === 'string'
    ? env.OPENROUTER_PROVIDER_ROUTING.trim()
    : '';
  const envTimeout = env.OPENROUTER_TIMEOUT_MS;
  const envStream = env.OPENROUTER_STREAM;
  const envFallbackModels = splitCsv(env.OPENROUTER_FALLBACK_MODELS);

  // 2. Config fallback.
  const cfgAllowed = Array.isArray(cfgOr.allowed_models) ? cfgOr.allowed_models : splitCsv(cfgOr.allowed_models);
  const cfgTradeoff = Number(cfgOr.cost_quality_tradeoff);
  const cfgData = cfgOr.data_collection;
  const cfgIgnored = Array.isArray(cfgOr.ignore_providers)
    ? cfgOr.ignore_providers
    : splitCsv(cfgOr.ignore_providers ?? cfgOr.ignoreProviders);
  const cfgTimeout = cfgOr.timeout_ms ?? cfgOr.timeoutMs ?? cfgOr.timeout_ms;
  const cfgStream = cfgOr.stream;
  const cfgModel = typeof cfgOr.model === 'string' ? cfgOr.model.trim() : '';
  const cfgFallbackModels = Array.isArray(cfgOr.fallback_models)
    ? cfgOr.fallback_models
    : (Array.isArray(cfgOr.fallbackModels) ? cfgOr.fallbackModels : splitCsv(cfgOr.fallback_models ?? cfgOr.fallbackModels));
  const cfgProviderRouting = cfgOr.provider_routing ?? cfgOr.providerRouting;

  // 3. Defaults — 60s per request is the product default.
  const DEFAULT_TIMEOUT_MS = 30_000;

  let allowedModels = (envAllowed.length > 0 ? envAllowed : cfgAllowed) || [];
  let tradeoff = (envTradeoff !== undefined && envTradeoff !== '' ? Number(envTradeoff) : (Number.isFinite(cfgTradeoff) ? cfgTradeoff : undefined));
  let dataCollection = (envData && envData !== '' ? envData : cfgData);
  // The hard-banned list excludes all known degraded endpoint variants. The base slug excludes
  // provider tags such as deepinfra/fp4 and decart/fp4 as well. `openrouter` is the fallback
  // route label emitted when OpenRouter cannot identify a downstream provider.
  const ignoredProviders = [...new Set([
    ...HARD_BANNED_PROVIDER_SLUGS,
    ...(envIgnored.length > 0 ? envIgnored : cfgIgnored),
  ])]
    .map((provider) => String(provider).trim().toLowerCase())
    .filter(Boolean);

  // timeout_ms: action env > yaml > 30000. Clamp 500ms..600_000ms.
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (envTimeout !== undefined && envTimeout !== '') {
    const n = Number(envTimeout);
    if (Number.isFinite(n)) timeoutMs = n;
  } else if (cfgTimeout !== undefined && cfgTimeout !== '') {
    const n = Number(cfgTimeout);
    if (Number.isFinite(n)) timeoutMs = n;
  }
  timeoutMs = Math.max(500, Math.min(600_000, Math.round(timeoutMs)));

  // connect_timeout_ms: max wait for HTTP headers / first byte. Separate from the total
  // response budget so a hung TCP handshake cannot burn the whole review window.
  // Default 8s; clamped 500ms..timeoutMs. Env OPENROUTER_CONNECT_TIMEOUT_MS wins.
  const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
  let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  const envConnect = env.OPENROUTER_CONNECT_TIMEOUT_MS;
  const cfgConnect = cfgOr.connect_timeout_ms ?? cfgOr.connectTimeoutMs;
  if (envConnect !== undefined && envConnect !== '') {
    const n = Number(envConnect);
    if (Number.isFinite(n)) connectTimeoutMs = n;
  } else if (cfgConnect !== undefined && cfgConnect !== '') {
    const n = Number(cfgConnect);
    if (Number.isFinite(n)) connectTimeoutMs = n;
  }
  connectTimeoutMs = Math.max(500, Math.min(timeoutMs, Math.round(connectTimeoutMs)));

  // stream: action env > yaml > false.
  let stream = false;
  if (envStream !== undefined && envStream !== '') {
    stream = !['0', 'false', 'no', 'off'].includes(String(envStream).trim().toLowerCase());
  } else if (cfgStream !== undefined && cfgStream !== null && cfgStream !== '') {
    if (typeof cfgStream === 'boolean') stream = cfgStream;
    else stream = !['0', 'false', 'no', 'off'].includes(String(cfgStream).trim().toLowerCase());
  }

  if (!Array.isArray(allowedModels)) allowedModels = [];
  const fallbackModels = [...new Set((envFallbackModels.length > 0 ? envFallbackModels : cfgFallbackModels)
    .map((model) => String(model).trim())
    .filter(Boolean))];
  if (tradeoff === undefined || !Number.isFinite(tradeoff)) tradeoff = undefined;
  if (tradeoff !== undefined) tradeoff = Math.max(0, Math.min(10, Math.round(tradeoff)));
  if (dataCollection !== 'allow' && dataCollection !== 'deny') dataCollection = undefined;

  // model: action/env OPENROUTER_MODEL > yaml github_action.openrouter.model > undefined (caller default)
  const model = envModel || cfgModel || undefined;

  const providerRouting = resolveProviderRouting(
    envProviderRouting || cfgProviderRouting,
    envIgnored.length > 0 ? envIgnored : cfgIgnored,
  );

  // Prefer endpoints that answer quickly. This is not a higher total budget — it tells
  // OpenRouter to avoid providers whose historical latency exceeds the connect window.
  // Callers can still override via OPENROUTER_PROVIDER_ROUTING / YAML provider_routing.
  let finalRouting = providerRouting && typeof providerRouting === 'object' ? { ...providerRouting } : { ignore: ignoredProviders };
  if (finalRouting.preferred_max_latency === undefined) {
    finalRouting.preferred_max_latency = connectTimeoutMs;
  }
  if (!Array.isArray(finalRouting.ignore)) {
    finalRouting.ignore = ignoredProviders;
  } else {
    finalRouting.ignore = [...new Set([...(finalRouting.ignore || []), ...ignoredProviders])];
  }

  return {
    allowedModels,
    costQualityTradeoff: tradeoff,
    dataCollection,
    ignoredProviders,
    timeoutMs,
    connectTimeoutMs,
    stream,
    model,
    fallbackModels,
    providerRouting: finalRouting,
  };
}

const PROVIDER_ROUTING_KEYS = new Set([
  'order',
  'allow_fallbacks',
  'require_parameters',
  'data_collection',
  'zdr',
  'enforce_distillable_text',
  'only',
  'ignore',
  'quantizations',
  'sort',
  'preferred_min_throughput',
  'preferred_max_latency',
  'max_price',
]);

const PROVIDER_LIST_KEYS = new Set(['order', 'only', 'ignore', 'quantizations']);
// These providers were returning degraded endpoint health while the central runner was
// timing out. Keep the ban in the action itself so callers that explicitly pass only their
// own ignore list cannot accidentally re-enable a known-bad route. Provider routing can still
// add further temporary bans through OPENROUTER_IGNORE_PROVIDERS or trusted YAML.
const HARD_BANNED_PROVIDER_SLUGS = Object.freeze([
  'deepinfra',
  'openrouter',
  'wafer',
  'novita',
  'siliconflow',
  'decart',
  'sail-research',
  'inceptron',
  'fireworks',
  'together',
  'mancer',
  'parasail',
]);
function normalizeProviderList(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`OpenRouter provider routing field ${field} must be an array`);
  }
  return [...new Set(value.map((provider) => {
    if (typeof provider !== 'string' || !provider.trim()) {
      throw new Error(`OpenRouter provider routing field ${field} must contain non-empty strings`);
    }
    return provider.trim().toLowerCase();
  }))];
}

function validateNonNegativeNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`OpenRouter provider routing field ${field} must be a non-negative number`);
  }
}

function validatePercentileMap(value, field) {
  if (typeof value === 'number') {
    validateNonNegativeNumber(value, field);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenRouter provider routing field ${field} must be a number or percentile map`);
  }
  for (const [percentile, threshold] of Object.entries(value)) {
    if (!['p50', 'p75', 'p90', 'p99'].includes(percentile)) {
      throw new Error(`OpenRouter provider routing field ${field} has unsupported percentile ${percentile}`);
    }
    validateNonNegativeNumber(threshold, `${field}.${percentile}`);
  }
}

function normalizeProviderRouting(raw, source) {
  if (raw === undefined || raw === null || raw === '') return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`OPENROUTER_PROVIDER_ROUTING must be valid JSON: ${error.message}`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenRouter provider routing from ${source} must be a JSON object`);
  }

  const unknownKeys = Object.keys(value).filter((key) => !PROVIDER_ROUTING_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`OpenRouter provider routing contains unsupported field(s): ${unknownKeys.join(', ')}`);
  }

  const normalized = {};
  for (const key of PROVIDER_ROUTING_KEYS) {
    if (value[key] === undefined) continue;
    if (PROVIDER_LIST_KEYS.has(key)) {
      normalized[key] = normalizeProviderList(value[key], key);
      continue;
    }
    if (['allow_fallbacks', 'require_parameters', 'zdr', 'enforce_distillable_text'].includes(key)) {
      if (typeof value[key] !== 'boolean') throw new Error(`OpenRouter provider routing field ${key} must be boolean`);
      normalized[key] = value[key];
      continue;
    }
    if (key === 'data_collection') {
      if (value[key] !== 'allow' && value[key] !== 'deny') {
        throw new Error('OpenRouter provider routing field data_collection must be allow or deny');
      }
      normalized[key] = value[key];
      continue;
    }
    if (key === 'sort') {
      if (typeof value[key] === 'string') {
        if (!['price', 'throughput', 'latency'].includes(value[key])) {
          throw new Error('OpenRouter provider routing sort must be price, throughput, or latency');
        }
        normalized[key] = value[key];
      } else if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
        const sortKeys = Object.keys(value[key]);
        if (sortKeys.some((sortKey) => !['by', 'partition'].includes(sortKey))) {
          throw new Error('OpenRouter provider routing sort object supports only by and partition');
        }
        if (!['price', 'throughput', 'latency'].includes(value[key].by)) {
          throw new Error('OpenRouter provider routing sort.by must be price, throughput, or latency');
        }
        if (value[key].partition !== undefined && !['model', 'none'].includes(value[key].partition)) {
          throw new Error('OpenRouter provider routing sort.partition must be model or none');
        }
        normalized[key] = { ...value[key] };
      } else {
        throw new Error('OpenRouter provider routing sort must be a supported string or object');
      }
      continue;
    }
    if (key === 'preferred_min_throughput' || key === 'preferred_max_latency') {
      validatePercentileMap(value[key], key);
      normalized[key] = typeof value[key] === 'object' ? { ...value[key] } : value[key];
      continue;
    }
    if (key === 'max_price') {
      if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
        throw new Error('OpenRouter provider routing field max_price must be an object');
      }
      const priceKeys = Object.keys(value[key]);
      if (priceKeys.some((priceKey) => !['prompt', 'completion', 'request', 'image'].includes(priceKey))) {
        throw new Error('OpenRouter provider routing max_price supports only prompt, completion, request, and image');
      }
      for (const [priceKey, price] of Object.entries(value[key])) validateNonNegativeNumber(price, `max_price.${priceKey}`);
      normalized[key] = { ...value[key] };
    }
  }
  return normalized;
}

function resolveProviderRouting(raw, configuredIgnoredProviders) {
  const providerRouting = normalizeProviderRouting(raw, typeof raw === 'string' ? 'action input' : 'config');
  const selectedProviders = [...(providerRouting.order || []), ...(providerRouting.only || [])];
  const forbidden = selectedProviders.filter(isHardBannedProvider);
  if (forbidden.length > 0) {
    throw new Error(`OpenRouter provider routing cannot select hard-banned provider(s): ${forbidden.join(', ')}`);
  }
  const ignoredProviders = [...new Set([
    ...HARD_BANNED_PROVIDER_SLUGS,
    ...(configuredIgnoredProviders || []),
    ...(providerRouting.ignore || []),
  ])].map((provider) => String(provider).trim().toLowerCase()).filter(Boolean);
  return { ...providerRouting, ignore: ignoredProviders };
}

function isHardBannedProvider(provider) {
  const slug = String(provider).trim().toLowerCase().split('/')[0];
  return HARD_BANNED_PROVIDER_SLUGS.includes(slug);
}

module.exports = {
  resolveOpenRouterPolicy,
  HARD_BANNED_PROVIDER_SLUGS,
  DEFAULT_OPENROUTER_TIMEOUT_MS: 30_000,
};
