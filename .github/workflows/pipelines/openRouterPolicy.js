'use strict';

const DEFAULT_PROVIDER_ROUTING = Object.freeze({
  allow_fallbacks: true,
  require_parameters: true,
  quantizations: Object.freeze(['fp16', 'bf16']),
  sort: 'throughput',
  preferred_min_throughput: Object.freeze({ p90: 40 }),
  preferred_max_latency: Object.freeze({ p99: 3 }),
});

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
 *      OPENROUTER_TIMEOUT_MS / OPENROUTER_FALLBACK_MODELS /
 *      OPENROUTER_STRUCTURED_OUTPUT);
 *   2. The base-owned `.review-yeti.yaml` github_action.openrouter block
 *      (allowed_models / cost_quality_tradeoff / data_collection /
 *      ignore_providers / provider_routing / timeout_ms / fallback_models /
 *      structured_output);
 *   3. Defaults (no allowlist, no tradeoff, no data-collection header,
 *      full-precision throughput routing with fallbacks, no built-in provider
 *      exclusions, timeout_ms=30000, stream=true).
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
 *   ttftMs: number,
 *   maxAttempts: number,
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
  const envTtft = env.OPENROUTER_TTFT_MS;
  const envMaxAttempts = env.OPENROUTER_MAX_ATTEMPTS;
  const envFallbackModels = splitCsv(env.OPENROUTER_FALLBACK_MODELS);
  const envStructuredOutput = typeof env.OPENROUTER_STRUCTURED_OUTPUT === 'string'
    ? env.OPENROUTER_STRUCTURED_OUTPUT.trim()
    : '';

  // 2. Config fallback.
  const cfgAllowed = Array.isArray(cfgOr.allowed_models) ? cfgOr.allowed_models : splitCsv(cfgOr.allowed_models);
  const cfgTradeoff = Number(cfgOr.cost_quality_tradeoff);
  const cfgData = cfgOr.data_collection;
  const cfgIgnored = Array.isArray(cfgOr.ignore_providers)
    ? cfgOr.ignore_providers
    : splitCsv(cfgOr.ignore_providers ?? cfgOr.ignoreProviders);
  const cfgTimeout = cfgOr.timeout_ms ?? cfgOr.timeoutMs ?? cfgOr.timeout_ms;
  const cfgMaxAttempts = cfgOr.max_attempts ?? cfgOr.maxAttempts;
  const cfgModel = typeof cfgOr.model === 'string' ? cfgOr.model.trim() : '';
  const cfgFallbackModels = Array.isArray(cfgOr.fallback_models)
    ? cfgOr.fallback_models
    : (Array.isArray(cfgOr.fallbackModels) ? cfgOr.fallbackModels : splitCsv(cfgOr.fallback_models ?? cfgOr.fallbackModels));
  const cfgStructuredOutput = cfgOr.structured_output ?? cfgOr.structuredOutput;
  const cfgProviderRouting = cfgOr.provider_routing ?? cfgOr.providerRouting;

  // 3. Defaults — 30s per request is the product default.
  const DEFAULT_TIMEOUT_MS = 30_000;

  let allowedModels = (envAllowed.length > 0 ? envAllowed : cfgAllowed) || [];
  let tradeoff = (envTradeoff !== undefined && envTradeoff !== '' ? Number(envTradeoff) : (Number.isFinite(cfgTradeoff) ? cfgTradeoff : undefined));
  let dataCollection = (envData && envData !== '' ? envData : cfgData);
  const ignoredProviders = [...new Set([
    ...(envIgnored.length > 0 ? envIgnored : cfgIgnored),
  ].map(normalizeProviderSlug))]
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

  // ttft_ms: time-to-first-token deadline. This is now the authoritative "is the provider
  // talking to us" budget and drives the stream path's connect timer. Default 30s; clamped
  // 500ms..timeoutMs.
  // Env OPENROUTER_TTFT_MS wins over github_action.openrouter.ttft_ms.
  const DEFAULT_TTFT_MS = 30_000;
  const cfgTtft = cfgOr.ttft_ms ?? cfgOr.ttftMs;
  let ttftMs = DEFAULT_TTFT_MS;
  if (envTtft !== undefined && envTtft !== '') {
    const n = Number(envTtft);
    if (Number.isFinite(n)) ttftMs = n;
  } else if (cfgTtft !== undefined && cfgTtft !== '') {
    const n = Number(cfgTtft);
    if (Number.isFinite(n)) ttftMs = n;
  }
  ttftMs = Math.max(500, Math.min(timeoutMs, Math.round(ttftMs)));

  // max_attempts: action env > yaml > 2 (1 initial attempt + 1 retry, REL-271 operator
  // directive "1 retry max per lane"). Clamped 1..5 -- this is an attempt cap, not a budget, so
  // the ceiling only needs to rule out runaway configuration, not model a specific latency math.
  const DEFAULT_MAX_ATTEMPTS = 2;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  if (envMaxAttempts !== undefined && envMaxAttempts !== '') {
    const n = Number(envMaxAttempts);
    if (Number.isFinite(n)) maxAttempts = n;
  } else if (cfgMaxAttempts !== undefined && cfgMaxAttempts !== '') {
    const n = Number(cfgMaxAttempts);
    if (Number.isFinite(n)) maxAttempts = n;
  }
  maxAttempts = Math.max(1, Math.min(5, Math.trunc(maxAttempts)));

  // Streaming is a review-path invariant. It is not configurable: every provider request uses
  // the SSE transport implemented by review-pipeline.js.
  // The `stream` property remains in the returned policy as a positive capability marker for
  // callers and receipts; it is always true and is never read from legacy configuration.
  const stream = true;

  if (!Array.isArray(allowedModels)) allowedModels = [];
  const fallbackModels = [...new Set((envFallbackModels.length > 0 ? envFallbackModels : cfgFallbackModels)
    .map((model) => String(model).trim())
    .filter(Boolean))];
  if (tradeoff === undefined || !Number.isFinite(tradeoff)) tradeoff = undefined;
  if (tradeoff !== undefined) tradeoff = Math.max(0, Math.min(10, Math.round(tradeoff)));
  if (dataCollection !== 'allow' && dataCollection !== 'deny') dataCollection = undefined;

  const structuredOutputRaw = envStructuredOutput || cfgStructuredOutput;
  let structuredOutput;

  if (structuredOutputRaw !== undefined && structuredOutputRaw !== null && structuredOutputRaw !== '') {
    const normalizedStructuredOutput = String(structuredOutputRaw).trim().toLowerCase();
    if (!['strict', 'none'].includes(normalizedStructuredOutput)) {
      throw new Error('OpenRouter structured output must be "strict" or "none" when configured');
    }

    structuredOutput = normalizedStructuredOutput;
  }

  // model: action/env OPENROUTER_MODEL > yaml github_action.openrouter.model > undefined (caller default)
  const model = envModel || cfgModel || undefined;

  // GitHub composite actions materialize an explicitly supplied `{}` input as a non-empty
  // environment string. Treat that value as "not configured" so a legacy caller cannot erase
  // the certified trusted YAML route and silently broaden provider selection to every endpoint.
  // Any non-empty object remains an explicit action override and is validated below.
  const emptyProviderRoutingInput = isEmptyProviderRoutingObject(envProviderRouting);
  const configuredProviderRouting = emptyProviderRoutingInput
    ? cfgProviderRouting
    : (envProviderRouting || cfgProviderRouting);
  const usesDefaultProviderRouting = isEmptyProviderRoutingValue(configuredProviderRouting);
  const providerRouting = resolveProviderRouting(
    usesDefaultProviderRouting
      ? DEFAULT_PROVIDER_ROUTING
      : configuredProviderRouting,
    envIgnored.length > 0 ? envIgnored : cfgIgnored,
  );

  // Prefer endpoints that answer quickly. This is not a higher total budget — it tells
  // OpenRouter to avoid providers whose historical latency exceeds the time-to-first-token
  // window (ttft_ms), not the (now largely superseded) connect timeout.
  // Callers can still override via OPENROUTER_PROVIDER_ROUTING / YAML provider_routing.
  let finalRouting = providerRouting && typeof providerRouting === 'object' ? { ...providerRouting } : { ignore: ignoredProviders };
  if (finalRouting.preferred_max_latency === undefined) {
    finalRouting.preferred_max_latency = ttftMs / 1000;
  } else if (usesDefaultProviderRouting && Number.isFinite(finalRouting.preferred_max_latency?.p99)) {
    finalRouting.preferred_max_latency = {
      ...finalRouting.preferred_max_latency,
      p99: Math.min(finalRouting.preferred_max_latency.p99, ttftMs / 1000),
    };
  }
  if (!Array.isArray(finalRouting.ignore)) {
    finalRouting.ignore = ignoredProviders;
  } else {
    finalRouting.ignore = [...new Set([...(finalRouting.ignore || []), ...ignoredProviders])];
  }
  // Strict schemas must never silently downgrade to a provider that ignores the requested
  // response format. OpenRouter will fail the request when the closed cohort cannot honor it;
  // the lane then remains incomplete and arbitration remains blocked.
  if (structuredOutput === 'strict') finalRouting.require_parameters = true;
  for (const candidateModel of [model, ...fallbackModels].filter(Boolean)) {
    validateFixedModelProviderCompatibility(candidateModel, finalRouting);
  }

  return {
    allowedModels,
    costQualityTradeoff: tradeoff,
    dataCollection,
    ignoredProviders,
    timeoutMs,
    ttftMs,
    maxAttempts,
    stream,
    ...(structuredOutput ? { structuredOutput } : {}),
    model,
    fallbackModels,
    providerRouting: finalRouting,
  };
}

function isEmptyProviderRoutingObject(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function isEmptyProviderRoutingValue(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  if (typeof raw === 'string') return isEmptyProviderRoutingObject(raw);
  return typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0;
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
// Retained as an empty compatibility export for consumers and evaluation fixtures that imported
// the old symbol. Endpoint health is now delegated to OpenRouter's live routing statistics; the
// action never injects a permanent provider blocklist.
const HARD_BANNED_PROVIDER_SLUGS = Object.freeze([]);

// Fixed-model compatibility is deliberately explicit. This is a compatibility guard, not a
// liveness claim: OpenRouter may add/remove endpoints over time, but a fixed model must never be
// sent to a provider cohort that cannot host it. Keep this list limited to providers approved for
// the model; do not infer compatibility from the model owner's namespace or broaden routing here.
const FIXED_MODEL_PROVIDER_COMPATIBILITY = Object.freeze({
  'openai/gpt-5.6-luna': Object.freeze(['openai', 'azure']),
  'openai/gpt-5.6-luna-20260709': Object.freeze(['openai', 'azure']),
});

function normalizeModelId(model) {
  return String(model || '').trim().toLowerCase();
}

// OpenRouter exposes a stable machine slug (for example `open-inference`) and can return a
// display/provider value (`OpenInference`) on a completion. Keep the request spelling
// canonical, while comparing a separator-insensitive identity so a display name cannot evade
// a configured exclusion. This mapping is deliberately small: unknown provider slugs retain
// their documented spelling instead of being guessed from a display name.
const PROVIDER_SLUG_ALIASES = Object.freeze({
  openinference: 'open-inference',
});

function providerIdentifier(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['slug', 'id', 'name']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return '';
}

function providerIdentityKey(value) {
  const base = providerIdentifier(value).split('/')[0].trim().toLowerCase();
  return base.normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

function normalizeProviderSlug(value) {
  const raw = providerIdentifier(value);
  if (!raw) return '';
  const [base, ...suffix] = raw.split('/');
  const identity = providerIdentityKey(base);
  if (!identity) return '';
  const normalizedBase = PROVIDER_SLUG_ALIASES[identity]
    || base.trim().toLowerCase().replace(/[ _]+/gu, '-');
  const normalizedSuffix = suffix.map((part) => part.trim().toLowerCase()).filter(Boolean);
  return [normalizedBase, ...normalizedSuffix].join('/');
}

function isIgnoredProvider(provider, ignoredProviders) {
  const resolved = normalizeProviderSlug(provider);
  if (!resolved) return false;
  const [resolvedBase] = resolved.split('/');
  return (Array.isArray(ignoredProviders) ? ignoredProviders : []).some((ignored) => {
    const normalized = normalizeProviderSlug(ignored);
    if (!normalized) return false;
    return normalized.includes('/') ? normalized === resolved : normalized === resolvedBase;
  });
}

function providerBaseSlug(provider) {
  return normalizeProviderSlug(provider).split('/')[0];
}

function closedProviderCohort(providerRouting) {
  if (!providerRouting || typeof providerRouting !== 'object') return null;
  const only = Array.isArray(providerRouting.only) ? providerRouting.only : [];
  const order = Array.isArray(providerRouting.order) ? providerRouting.order : [];
  if (only.length > 0) return only;
  if (providerRouting.allow_fallbacks === false && order.length > 0) return order;
  return null;
}

/**
 * Returns whether a resolved downstream provider belongs to the closed trusted cohort.
 * `openrouter` is a transport-level unresolved sentinel, never an actual downstream provider.
 */
function isProviderAllowedByRouting(provider, providerRouting) {
  const resolved = normalizeProviderSlug(provider);
  const cohort = closedProviderCohort(providerRouting);
  // With no closed cohort, retain OpenRouter's normal route selection. The sentinel is still
  // labeled as unresolved by the caller; it is not presented as a concrete downstream vendor.
  if (!cohort) return true;
  if (!resolved || resolved === 'openrouter') return false;
  return cohort.some((candidate) => {
    const allowed = normalizeProviderSlug(candidate);
    if (!allowed) return false;
    return allowed.includes('/') ? allowed === resolved : allowed === providerBaseSlug(resolved);
  });
}

function safeRoutingIdentifier(value, fallback = 'redacted') {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9._/-]{1,100}$/u.test(normalized) ? normalized : fallback;
}

/**
 * Rejects a fixed model when an explicit provider restriction cannot serve it.
 *
 * `only` is the strictest restriction. An `order` list with fallbacks disabled is also a closed
 * cohort, so validate that shape for the same reason. An absent restriction remains untouched:
 * this helper never widens a provider list or turns fallbacks on.
 *
 * @param {string|undefined} model
 * @param {object|undefined} providerRouting
 * @returns {{model: string, compatibleProviders: string[], restrictedProviders: string[]}|undefined}
 */
function validateFixedModelProviderCompatibility(model, providerRouting) {
  const normalizedModel = normalizeModelId(model);
  const compatibleProviders = FIXED_MODEL_PROVIDER_COMPATIBILITY[normalizedModel];
  if (!compatibleProviders || !providerRouting || typeof providerRouting !== 'object') return undefined;

  const only = Array.isArray(providerRouting.only) ? providerRouting.only : [];
  const order = Array.isArray(providerRouting.order) ? providerRouting.order : [];
  const restriction = only.length > 0
    ? { field: 'only', providers: only }
    : (providerRouting.allow_fallbacks === false && order.length > 0
      ? { field: 'order (with allow_fallbacks=false)', providers: order }
      : undefined);
  if (!restriction) return undefined;

  const ignored = new Set((Array.isArray(providerRouting.ignore) ? providerRouting.ignore : [])
    .map(normalizeProviderSlug)
    .filter(Boolean));
  const effectiveCompatibleProviders = restriction.providers.filter((provider) => {
    const normalizedProvider = normalizeProviderSlug(provider);
    const baseProvider = providerBaseSlug(normalizedProvider);
    return compatibleProviders.includes(baseProvider)
      && !ignored.has(normalizedProvider)
      && !ignored.has(baseProvider);
  });
  const unsupportedProviders = restriction.providers.filter((provider) => {
    const normalizedProvider = normalizeProviderSlug(provider);
    const baseProvider = providerBaseSlug(normalizedProvider);
    return !compatibleProviders.includes(baseProvider)
      || ignored.has(normalizedProvider)
      || ignored.has(baseProvider);
  });
  // A closed allowlist is a contract for every provider OpenRouter may select. Checking only
  // that one compatible endpoint exists lets an incompatible or ignored endpoint remain in the
  // cohort and produces exactly the intermittent semantic failures this guard is meant to stop.
  if (effectiveCompatibleProviders.length === restriction.providers.length) return {
    model: normalizedModel,
    compatibleProviders: [...compatibleProviders],
    restrictedProviders: restriction.providers.map((provider) => safeRoutingIdentifier(provider)),
  };

  const restrictedProviders = restriction.providers.map((provider) => safeRoutingIdentifier(provider));
  const ignoredCompatible = compatibleProviders.filter((provider) => ignored.has(provider));
  const unsupported = unsupportedProviders.map((provider) => safeRoutingIdentifier(provider));
  const ignoredNote = ignoredCompatible.length > 0
    ? ` The effective ignore policy also excludes ${ignoredCompatible.join(', ')}.`
    : '';
  throw new Error(
    `OpenRouter fixed-model compatibility check failed: model "${safeRoutingIdentifier(normalizedModel, 'configured-model')}" `
    + `has approved compatible provider(s) ${compatibleProviders.join(' or ')}, but provider.${restriction.field} permits only `
    + `[${restrictedProviders.join(', ')}]. The incompatible or ignored member(s) are [${unsupported.join(', ')}]. `
    + `No permitted provider cohort can safely serve this model.${ignoredNote} `
    + `Set openrouter-provider-routing to an explicit compatible policy such as `
    + `{"only":["openai","azure"],"allow_fallbacks":false} while retaining the current `
    + `data_collection, zdr, and ignore restrictions, or select a model served by the approved `
    + `provider cohort. No provider access was broadened and no fallback was attempted.`,
  );
}

function normalizeProviderList(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`OpenRouter provider routing field ${field} must be an array`);
  }
  return [...new Set(value.map((provider) => {
    if (typeof provider !== 'string' || !provider.trim()) {
      throw new Error(`OpenRouter provider routing field ${field} must contain non-empty strings`);
    }
    return normalizeProviderSlug(provider);
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
  const ignoredProviders = [...new Set([
    ...(configuredIgnoredProviders || []),
    ...(providerRouting.ignore || []),
  ].map(normalizeProviderSlug))]
    .filter(Boolean);
  return { ...providerRouting, ignore: ignoredProviders };
}

/**
 * OPENROUTER_BASE_URL may point at any OpenAI-compatible gateway, not just
 * OpenRouter. OpenRouter-specific request fields (`provider` routing,
 * `session_id` stickiness, auto-router `plugins`) cause hard 400s on some of
 * those gateways — Fireworks rejects them with "Extra inputs are not
 * permitted, field: 'provider'". This resolves the gateway identity so the
 * request builder can attach those fields only on OpenRouter, and so route
 * labels/logs attribute responses to the actual gateway instead of the
 * `openrouter` unknown-route sentinel (which also disables lane retries in
 * reviewInvestigation.retryableProvider).
 *
 * Direct-gateway ids are deliberately namespaced so they cannot collide with
 * OpenRouter provider slugs in routing and retry state.
 *
 * @param {string|undefined} baseUrl
 * @returns {{id: string, isOpenRouter: boolean}}
 */
function resolveGatewayIdentity(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return { id: 'openrouter', isOpenRouter: true };
  let host = '';
  try {
    host = new URL(raw).host.toLowerCase();
  } catch (_) {
    return { id: 'openrouter', isOpenRouter: true };
  }
  if (!host || host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
    return { id: 'openrouter', isOpenRouter: true };
  }
  const KNOWN_DIRECT_GATEWAYS = [
    ['fireworks-direct', /(^|\.)fireworks\.ai$/],
    ['ollama-cloud', /(^|\.)ollama\.com$/],
    ['opencode-zen', /(^|\.)opencode\.ai$/],
  ];
  for (const [id, pattern] of KNOWN_DIRECT_GATEWAYS) {
    if (pattern.test(host)) return { id, isOpenRouter: false };
  }
  // Any other host is assumed to be OpenRouter (or an OpenRouter-compatible
  // proxy in front of it) and keeps full OpenRouter request/routing semantics.
  // Add new direct gateways to KNOWN_DIRECT_GATEWAYS explicitly.
  return { id: 'openrouter', isOpenRouter: true };
}

// ---------------------------------------------------------------------------
// Explicit transport plan (github_action.transports / REVIEW_YETI_TRANSPORTS)
// ---------------------------------------------------------------------------

const TRANSPORT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const TRANSPORT_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;
// A trusted-base config names which env var carries each transport's model
// credential. Never let it name a CI credential — combined with an
// attacker-ish base_url that would exfiltrate the token as an Authorization
// header. Base-ref config is maintainer-trusted, but defense in depth is cheap.
const TRANSPORT_KEY_ENV_DENYLIST = Object.freeze([
  'GITHUB_TOKEN', 'GH_TOKEN', 'REVIEW_YETI_GITHUB_APP_PRIVATE_KEY',
]);
const TRANSPORT_KEY_ENV_DENY_PREFIXES = Object.freeze(['GITHUB_', 'ACTIONS_', 'RUNNER_', 'INPUT_']);
const MAX_TRANSPORTS = 6;
const TRANSPORT_OPENROUTER_ONLY_KEYS = Object.freeze([
  'provider_routing', 'providerRouting', 'ignore_providers', 'ignoreProviders',
  'quarantine_on_timeout', 'quarantineOnTimeout',
  'allow_banned_providers', 'allowBannedProviders', 'data_collection', 'dataCollection',
  'allowed_models', 'allowedModels', 'cost_quality_tradeoff', 'costQualityTradeoff',
]);

/**
 * Resolves the explicit ordered transport plan, if configured.
 *
 * Precedence: env REVIEW_YETI_TRANSPORT_PLAN_B64 (base64 JSON array string), then
 * REVIEW_YETI_TRANSPORTS (JSON array string, action input `transports`) > trusted-base YAML
 * `github_action.transports`. Absent → null,
 * and the legacy single-transport inputs (llm-api-key / llm-base-url / model)
 * apply unchanged.
 *
 * Each entry:
 *   name          required, /^[a-z][a-z0-9-]{0,39}$/, unique
 *   base_url      required, https URL
 *   api_key_env   required, names the env var holding this transport's key;
 *                 must end in _API_KEY or _KEY and may not name a CI credential
 *   model         required, gateway-native model id
 *   compat        'openai' | 'openrouter' (default: detected from base_url)
 *   fallback_models, timeout_ms, structured_output,
 *   reasoning_effort, perf_metrics_in_response
 *                 optional; unset values inherit the global env/action inputs
 *   provider_routing, ignore_providers, quarantine_on_timeout, data_collection,
 *   allowed_models, cost_quality_tradeoff
 *                 OpenRouter-only; rejected on compat 'openai'
 *   allow_banned_providers
 *                 deprecated OpenRouter-only compatibility no-op
 *
 * An entry whose api_key_env is empty at runtime is DROPPED with a warning so
 * a fallback transport can be declared before its secret is provisioned; if no
 * usable transport remains the plan fails closed.
 *
 * @returns {{transports: ReadonlyArray<object>, warnings: ReadonlyArray<string>}|null}
 */
function resolveTransportPlan(localConfig, env) {
  if (env === undefined) env = (typeof process !== 'undefined' ? process.env : {});
  const parsed = localConfig?.parsed && typeof localConfig.parsed === 'object'
    ? localConfig.parsed
    : (localConfig && typeof localConfig === 'object' ? localConfig : {});
  const githubAction = parsed.github_action && typeof parsed.github_action === 'object'
    ? parsed.github_action
    : {};

  let rawEntries = null;
  const envPlanB64 = typeof env.REVIEW_YETI_TRANSPORT_PLAN_B64 === 'string'
    ? env.REVIEW_YETI_TRANSPORT_PLAN_B64.trim()
    : '';
  const envRaw = typeof env.REVIEW_YETI_TRANSPORTS === 'string' ? env.REVIEW_YETI_TRANSPORTS.trim() : '';
  if (envPlanB64) {
    try {
      const decoded = Buffer.from(envPlanB64, 'base64').toString('utf8');
      rawEntries = JSON.parse(decoded);
    } catch (error) {
      throw new Error(`REVIEW_YETI_TRANSPORT_PLAN_B64 must be base64-encoded JSON: ${error.message}`);
    }
  } else if (envRaw) {
    try {
      rawEntries = JSON.parse(envRaw);
    } catch (error) {
      throw new Error(`REVIEW_YETI_TRANSPORTS must be valid JSON: ${error.message}`);
    }
  } else if (githubAction.transports !== undefined) {
    rawEntries = githubAction.transports;
  }
  if (rawEntries === null || rawEntries === undefined) return null;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error('transports must be a non-empty array of transport objects');
  }
  if (rawEntries.length > MAX_TRANSPORTS) {
    throw new Error(`transports supports at most ${MAX_TRANSPORTS} entries`);
  }

  const warnings = [];
  const transports = [];
  const seenNames = new Set();
  for (const [index, rawEntry] of rawEntries.entries()) {
    const raw = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? rawEntry : null;
    if (!raw) throw new Error(`transports[${index}] must be an object`);
    const name = String(raw.name || '').trim();
    if (!TRANSPORT_NAME_PATTERN.test(name)) {
      throw new Error(`transports[${index}].name must match ${TRANSPORT_NAME_PATTERN}`);
    }
    if (seenNames.has(name)) throw new Error(`transports[${index}].name "${name}" is duplicated`);
    seenNames.add(name);

    const baseUrl = String(raw.base_url ?? raw.baseUrl ?? '').trim().replace(/\/+$/u, '');
    let parsedUrl = null;
    try { parsedUrl = new URL(baseUrl); } catch (_) { parsedUrl = null; }
    if (!parsedUrl || parsedUrl.protocol !== 'https:') {
      throw new Error(`transports[${index}] (${name}): base_url must be an https:// URL`);
    }

    const detected = resolveGatewayIdentity(baseUrl);
    const compatRaw = String(raw.compat || '').trim().toLowerCase();
    const compat = compatRaw || (detected.isOpenRouter ? 'openrouter' : 'openai');
    if (compat !== 'openai' && compat !== 'openrouter') {
      throw new Error(`transports[${index}] (${name}): compat must be "openai" or "openrouter"`);
    }
    if (compat === 'openai') {
      for (const key of TRANSPORT_OPENROUTER_ONLY_KEYS) {
        if (raw[key] !== undefined) {
          throw new Error(`transports[${index}] (${name}): ${key} is OpenRouter-only and not valid with compat: openai`);
        }
      }
    }

    const model = String(raw.model || '').trim();
    if (!model || model.length > 200) {
      throw new Error(`transports[${index}] (${name}): model is required (max 200 chars)`);
    }

    const apiKeyEnv = String(raw.api_key_env ?? raw.apiKeyEnv ?? '').trim();
    if (!TRANSPORT_KEY_ENV_PATTERN.test(apiKeyEnv)) {
      throw new Error(`transports[${index}] (${name}): api_key_env must match ${TRANSPORT_KEY_ENV_PATTERN}`);
    }
    if (TRANSPORT_KEY_ENV_DENYLIST.includes(apiKeyEnv)
      || TRANSPORT_KEY_ENV_DENY_PREFIXES.some((prefix) => apiKeyEnv.startsWith(prefix))) {
      throw new Error(`transports[${index}] (${name}): api_key_env may not name a CI credential (${apiKeyEnv})`);
    }
    if (!/(_API_KEY|_KEY)$/u.test(apiKeyEnv)) {
      throw new Error(`transports[${index}] (${name}): api_key_env must end in _API_KEY or _KEY`);
    }
    const apiKey = String(env[apiKeyEnv] || '').trim();
    if (!apiKey) {
      warnings.push(`transports[${index}] (${name}) dropped: env ${apiKeyEnv} is unset or empty`);
      continue;
    }

    const configuredReasoningEffort = raw.reasoning_effort ?? raw.reasoningEffort;
    const reasoningEffort = configuredReasoningEffort === undefined || configuredReasoningEffort === null
      ? undefined
      : String(configuredReasoningEffort).trim().toLowerCase();
    if (reasoningEffort !== undefined && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
      throw new Error(`transports[${index}] (${name}): reasoning_effort must be none, low, medium, high, xhigh, or max`);
    }
    const configuredPerfMetrics = raw.perf_metrics_in_response ?? raw.perfMetricsInResponse;
    if (configuredPerfMetrics !== undefined && typeof configuredPerfMetrics !== 'boolean') {
      throw new Error(`transports[${index}] (${name}): perf_metrics_in_response must be boolean`);
    }
    const configuredQuarantineOnTimeout = raw.quarantine_on_timeout ?? raw.quarantineOnTimeout;
    if (configuredQuarantineOnTimeout !== undefined && typeof configuredQuarantineOnTimeout !== 'boolean') {
      throw new Error(`transports[${index}] (${name}): quarantine_on_timeout must be boolean`);
    }

    // Reuse resolveOpenRouterPolicy for normalization/validation/clamping by
    // synthesizing a per-transport env. Unset per-transport values inherit the
    // caller's global inputs so one shared timeout/stream setting applies.
    const toCsv = (value) => (Array.isArray(value) ? value.join(',') : String(value ?? ''));
    const envLike = {
      OPENROUTER_FALLBACK_MODELS: raw.fallback_models !== undefined || raw.fallbackModels !== undefined
        ? toCsv(raw.fallback_models ?? raw.fallbackModels)
        : '',
      OPENROUTER_TIMEOUT_MS: raw.timeout_ms !== undefined ? String(raw.timeout_ms) : String(env.OPENROUTER_TIMEOUT_MS || ''),
      OPENROUTER_STRUCTURED_OUTPUT: raw.structured_output !== undefined ? String(raw.structured_output) : String(env.OPENROUTER_STRUCTURED_OUTPUT || ''),
      ...(compat === 'openrouter' ? {
        OPENROUTER_PROVIDER_ROUTING: raw.provider_routing !== undefined || raw.providerRouting !== undefined
          ? JSON.stringify(raw.provider_routing ?? raw.providerRouting)
          : String(env.OPENROUTER_PROVIDER_ROUTING || ''),
        OPENROUTER_IGNORE_PROVIDERS: raw.ignore_providers !== undefined || raw.ignoreProviders !== undefined
          ? toCsv(raw.ignore_providers ?? raw.ignoreProviders)
          : String(env.OPENROUTER_IGNORE_PROVIDERS || ''),
        OPENROUTER_DATA_COLLECTION: raw.data_collection !== undefined || raw.dataCollection !== undefined
          ? String(raw.data_collection ?? raw.dataCollection)
          : String(env.OPENROUTER_DATA_COLLECTION || ''),
        OPENROUTER_ALLOW_BANNED_PROVIDERS: raw.allow_banned_providers !== undefined || raw.allowBannedProviders !== undefined
          ? toCsv(raw.allow_banned_providers ?? raw.allowBannedProviders)
          : String(env.OPENROUTER_ALLOW_BANNED_PROVIDERS || ''),
        OPENROUTER_ALLOWED_MODELS: toCsv(raw.allowed_models ?? raw.allowedModels ?? ''),
        OPENROUTER_COST_QUALITY_TRADEOFF: raw.cost_quality_tradeoff !== undefined || raw.costQualityTradeoff !== undefined
          ? String(raw.cost_quality_tradeoff ?? raw.costQualityTradeoff)
          : '',
      } : {}),
    };
    const openRouterPolicy = resolveOpenRouterPolicy(null, envLike);
    validateFixedModelProviderCompatibility(model, openRouterPolicy.providerRouting);

    transports.push(Object.freeze({
      name,
      baseUrl,
      compat,
      model,
      apiKey,
      apiKeyEnv,
      fallbackModels: openRouterPolicy.fallbackModels,
      timeoutMs: openRouterPolicy.timeoutMs,
      reasoningEffort,
      perfMetricsInResponse: configuredPerfMetrics === true,
      quarantineOnTimeout: configuredQuarantineOnTimeout !== false,
      openRouterPolicy,
    }));
  }

  if (transports.length === 0) {
    throw new Error(`transports resolved to zero usable entries (${warnings.join('; ') || 'all entries invalid'})`);
  }
  return Object.freeze({ transports: Object.freeze(transports), warnings: Object.freeze(warnings) });
}

module.exports = {
  resolveOpenRouterPolicy,
  resolveGatewayIdentity,
  resolveTransportPlan,
  FIXED_MODEL_PROVIDER_COMPATIBILITY,
  validateFixedModelProviderCompatibility,
  HARD_BANNED_PROVIDER_SLUGS,
  normalizeProviderSlug,
  isProviderAllowedByRouting,
  closedProviderCohort,
  isIgnoredProvider,
  DEFAULT_OPENROUTER_TIMEOUT_MS: 30_000,
  DEFAULT_OPENROUTER_TTFT_MS: 30_000,
};
