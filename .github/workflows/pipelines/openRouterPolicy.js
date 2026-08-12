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
 *      OPENROUTER_TIMEOUT_MS / OPENROUTER_STREAM / OPENROUTER_FALLBACK_MODELS /
 *      OPENROUTER_STRUCTURED_OUTPUT);
 *   2. The base-owned `.review-yeti.yaml` github_action.openrouter block
 *      (allowed_models / cost_quality_tradeoff / data_collection /
 *      ignore_providers / provider_routing / timeout_ms / stream / fallback_models /
 *      structured_output);
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
  // Providers the OPERATOR has explicitly re-permitted. The hard-ban list below is a safety
  // default for callers that pass no policy of their own; it must not silently override an
  // operator who has deliberately allow-listed a provider upstream (e.g. an OpenRouter
  // workspace guardrail running in only-allow mode). Without this escape hatch the two
  // policies intersect to nothing and every request 404s with "No endpoints available".
  const envAllowBanned = splitCsv(env.OPENROUTER_ALLOW_BANNED_PROVIDERS);
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
  const cfgStream = cfgOr.stream;
  const cfgModel = typeof cfgOr.model === 'string' ? cfgOr.model.trim() : '';
  const cfgFallbackModels = Array.isArray(cfgOr.fallback_models)
    ? cfgOr.fallback_models
    : (Array.isArray(cfgOr.fallbackModels) ? cfgOr.fallbackModels : splitCsv(cfgOr.fallback_models ?? cfgOr.fallbackModels));
  const cfgStructuredOutput = cfgOr.structured_output ?? cfgOr.structuredOutput;
  const cfgProviderRouting = cfgOr.provider_routing ?? cfgOr.providerRouting;

  // 3. Defaults — 60s per request is the product default.
  const DEFAULT_TIMEOUT_MS = 30_000;

  let allowedModels = (envAllowed.length > 0 ? envAllowed : cfgAllowed) || [];
  let tradeoff = (envTradeoff !== undefined && envTradeoff !== '' ? Number(envTradeoff) : (Number.isFinite(cfgTradeoff) ? cfgTradeoff : undefined));
  let dataCollection = (envData && envData !== '' ? envData : cfgData);
  // The hard-banned list excludes all known degraded endpoint variants. The base slug excludes
  // provider tags such as deepinfra/fp4 and decart/fp4 as well. `openrouter` is the fallback
  // route label emitted when OpenRouter cannot identify a downstream provider.
  const cfgAllowBanned = Array.isArray(cfgOr.allow_banned_providers)
    ? cfgOr.allow_banned_providers
    : splitCsv(cfgOr.allow_banned_providers ?? cfgOr.allowBannedProviders);
  const allowBanned = new Set(
    (envAllowBanned.length > 0 ? envAllowBanned : (cfgAllowBanned || []))
      .map(normalizeProviderSlug).filter(Boolean),
  );
  const effectiveHardBanned = HARD_BANNED_PROVIDER_SLUGS.filter((slug) => !allowBanned.has(slug));
  const ignoredProviders = [...new Set([
    ...effectiveHardBanned,
    ...(envIgnored.length > 0 ? envIgnored : cfgIgnored),
  ].map(normalizeProviderSlug))]
    .filter(Boolean)
    .filter((slug) => !allowBanned.has(slug));

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

  const structuredOutputRaw = envStructuredOutput || cfgStructuredOutput;
  let structuredOutput;

  if (structuredOutputRaw !== undefined && structuredOutputRaw !== null && structuredOutputRaw !== '') {
    if (String(structuredOutputRaw).trim().toLowerCase() !== 'strict') {
      throw new Error('OpenRouter structured output must be "strict" when configured');
    }

    structuredOutput = 'strict';
  }

  // model: action/env OPENROUTER_MODEL > yaml github_action.openrouter.model > undefined (caller default)
  const model = envModel || cfgModel || undefined;

  // GitHub composite actions materialize an explicitly supplied `{}` input as a non-empty
  // environment string. Treat that value as "not configured" so a legacy caller cannot erase
  // the certified trusted YAML route and silently broaden provider selection to every endpoint.
  // Any non-empty object remains an explicit action override and is validated below.
  const emptyProviderRoutingInput = isEmptyProviderRoutingObject(envProviderRouting);
  const providerRouting = resolveProviderRouting(
    emptyProviderRoutingInput ? cfgProviderRouting : (envProviderRouting || cfgProviderRouting),
    envIgnored.length > 0 ? envIgnored : cfgIgnored,
    [...allowBanned],
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
    connectTimeoutMs,
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

function resolveProviderRouting(raw, configuredIgnoredProviders, allowBannedProviders) {
  const providerRouting = normalizeProviderRouting(raw, typeof raw === 'string' ? 'action input' : 'config');
  const allowBanned = new Set((allowBannedProviders || []).map(normalizeProviderSlug).filter(Boolean));
  const selectedProviders = [...(providerRouting.order || []), ...(providerRouting.only || [])];
  // An operator who explicitly re-permits a provider may also route to it. Without this the
  // guard rejects the operator's own allow-list as "hard-banned".
  const forbidden = selectedProviders
    .filter((p) => isHardBannedProvider(p) && !allowBanned.has(providerBaseSlug(p)));
  if (forbidden.length > 0) {
    throw new Error(`OpenRouter provider routing cannot select hard-banned provider(s): ${forbidden.join(', ')}`);
  }
  const ignoredProviders = [...new Set([
    ...HARD_BANNED_PROVIDER_SLUGS.filter((slug) => !allowBanned.has(slug)),
    ...(configuredIgnoredProviders || []),
    ...(providerRouting.ignore || []),
  ].map(normalizeProviderSlug))]
    .filter(Boolean)
    .filter((slug) => !allowBanned.has(slug));
  return { ...providerRouting, ignore: ignoredProviders };
}

function isHardBannedProvider(provider) {
  const slug = providerBaseSlug(provider);
  return HARD_BANNED_PROVIDER_SLUGS.includes(slug);
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
 * Direct-gateway ids are deliberately namespaced (`fireworks-direct`, not
 * `fireworks`) so they can never collide with OpenRouter provider slugs such
 * as the hard-banned `fireworks` OpenRouter endpoint.
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

module.exports = {
  resolveOpenRouterPolicy,
  resolveGatewayIdentity,
  FIXED_MODEL_PROVIDER_COMPATIBILITY,
  validateFixedModelProviderCompatibility,
  HARD_BANNED_PROVIDER_SLUGS,
  normalizeProviderSlug,
  isProviderAllowedByRouting,
  closedProviderCohort,
  isIgnoredProvider,
  DEFAULT_OPENROUTER_TIMEOUT_MS: 30_000,
};
