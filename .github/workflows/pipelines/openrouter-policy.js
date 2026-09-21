'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.resolve(__dirname, '../../../src/config/openrouter-review-policy.json');
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
/**
 * Closed allowlist of review destinations. This is an exfiltration control, not configuration:
 * the review pipeline ships private diffs to a third-party model, so the destination is pinned
 * and the model allowlisted, with data_collection forced to deny.
 *
 * It is a LIST rather than a single constant because the fleet now has two funded transports.
 * It is emphatically NOT an "any https URL" check -- a compromised or mistyped base URL is
 * precisely what this stops, and the guard is worth more than the convenience of adding a third
 * destination without review.
 */
const ALLOWED_REVIEW_BASE_URLS = Object.freeze([OPENROUTER_BASE_URL, OPENCODE_BASE_URL]);
const OPENROUTER_AUTO_MODEL = 'openrouter/auto';
const OPENROUTER_DIRECT_PRIMARY_MODEL = 'z-ai/glm-5.3-flash';
const OPENROUTER_DIRECT_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash-0731';
const CANONICAL_ALLOWED_MODELS = Object.freeze([
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-0731',
  'openai/gpt-5.6-luna',
  'moonshotai/kimi-k2.6',
  'tencent/hy3',
  'z-ai/glm-5.2',
  'google/gemini-3.5-flash-lite',
  // opencode serves bare model ids rather than vendor-namespaced ones. Same model family as the
  // OpenRouter entries above, reached by a different name on a different destination.
  'glm-5.3-flash',
  'deepseek-v4-flash-0731',
]);
const CANONICAL_ALLOWED_MODEL_SET = new Set(CANONICAL_ALLOWED_MODELS);
const POLICY_KEYS = Object.freeze([
  'base_url',
  'model',
  'allowed_models',
  'data_collection',
  'cost_quality_tradeoff',
]);
const RESOLVED_POLICY_KEYS = new Set([...POLICY_KEYS, 'policy_fingerprint']);

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

const DEFAULT_OPENROUTER_REVIEW_POLICY = Object.freeze(loadManifest());

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function rejectUnknownKeys(policy, allowedKeys = POLICY_KEYS) {
  const unknownKeys = Object.keys(policy).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown OpenRouter review policy key(s): ${unknownKeys.join(', ')}`);
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('OpenRouter review policy base_url must be a non-empty string');
  }
  return value.trim().replace(/\/+$/, '');
}

function normalizeAllowedModels(value) {
  if (!Array.isArray(value)) {
    throw new Error('OpenRouter review policy allowed_models must be an array');
  }
  if (value.length === 0) {
    throw new Error('OpenRouter review policy allowed_models must be a non-empty subset of the canonical approved model set');
  }

  const normalized = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('OpenRouter review policy allowed_models entries must be non-empty strings');
    }
    return entry.trim();
  });

  if (new Set(normalized).size !== normalized.length) {
    throw new Error('OpenRouter review policy allowed_models must not contain duplicates');
  }

  for (const model of normalized) {
    if (!CANONICAL_ALLOWED_MODEL_SET.has(model)) {
      throw new Error(`OpenRouter review policy allowed_models entry "${model}" is not in the canonical approved model set`);
    }
  }

  return CANONICAL_ALLOWED_MODELS.filter((model) => normalized.includes(model));
}

function normalizePolicyShape(policy) {
  assertPlainObject(policy, 'OpenRouter review policy');
  rejectUnknownKeys(policy);

  const normalized = {
    base_url: normalizeBaseUrl(policy.base_url),
    model: typeof policy.model === 'string' ? policy.model.trim() : policy.model,
    allowed_models: normalizeAllowedModels(policy.allowed_models),
    data_collection: policy.data_collection,
    cost_quality_tradeoff: policy.cost_quality_tradeoff,
  };

  return normalized;
}

function buildPolicyFingerprint(policy) {
  const fingerprintSource = JSON.stringify({
    base_url: policy.base_url,
    model: policy.model,
    allowed_models: policy.allowed_models,
    data_collection: policy.data_collection,
    cost_quality_tradeoff: policy.cost_quality_tradeoff,
  });

  return crypto.createHash('sha256').update(fingerprintSource).digest('hex');
}

function validateOpenRouterReviewPolicy(policy) {
  assertPlainObject(policy, 'OpenRouter review policy');
  rejectUnknownKeys(policy, POLICY_KEYS);

  const normalized = normalizePolicyShape(policy);

  if (!ALLOWED_REVIEW_BASE_URLS.includes(normalized.base_url)) {
    throw new Error(
      `Review policy base url must normalize exactly to one of: ${ALLOWED_REVIEW_BASE_URLS.join(', ')}`,
    );
  }

  if (normalized.model !== OPENROUTER_AUTO_MODEL && !CANONICAL_ALLOWED_MODEL_SET.has(normalized.model)) {
    throw new Error(`OpenRouter review policy model "${normalized.model}" must be ${OPENROUTER_AUTO_MODEL} or one of the canonical approved model IDs`);
  }

  if (normalized.model !== OPENROUTER_AUTO_MODEL && !normalized.allowed_models.includes(normalized.model)) {
    throw new Error(`OpenRouter review policy model "${normalized.model}" must be present in allowed_models when not using ${OPENROUTER_AUTO_MODEL}`);
  }

  if (normalized.data_collection !== 'deny') {
    throw new Error('OpenRouter review policy data_collection may only be "deny"');
  }

  if (!Number.isInteger(normalized.cost_quality_tradeoff) || normalized.cost_quality_tradeoff < 0 || normalized.cost_quality_tradeoff > 10) {
    throw new Error('OpenRouter review policy cost_quality_tradeoff must be an integer from 0 through 10');
  }

  return {
    ...normalized,
    policy_fingerprint: buildPolicyFingerprint(normalized),
  };
}

function actionInputValue(actionInputs, ...keys) {
  if (!actionInputs || typeof actionInputs !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(actionInputs, key) && actionInputs[key] !== undefined && actionInputs[key] !== '') {
      return actionInputs[key];
    }
  }
  return undefined;
}

function trustedPolicyBlock(trustedConfig) {
  const block = trustedConfig?.github_action?.openrouter;
  if (block === undefined) return undefined;
  assertPlainObject(block, 'trusted github_action.openrouter policy');
  rejectUnknownKeys(block);
  return block;
}

function coerceAllowedModelsInput(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  throw new Error('OpenRouter review policy allowed_models input must be an array or comma-separated string');
}

function resolveOpenRouterReviewPolicy({ actionInputs, trustedConfig } = {}) {
  const manifestDefaults = DEFAULT_OPENROUTER_REVIEW_POLICY;
  const trustedPolicy = trustedPolicyBlock(trustedConfig);
  const inputOverlay = {
    base_url: actionInputValue(actionInputs, 'llm-base-url', 'llm_base_url', 'base_url'),
    model: actionInputValue(actionInputs, 'model'),
    allowed_models: coerceAllowedModelsInput(actionInputValue(actionInputs, 'allowed-models', 'allowed_models')),
    data_collection: actionInputValue(actionInputs, 'data-collection', 'data_collection'),
    cost_quality_tradeoff: actionInputValue(actionInputs, 'cost-quality-tradeoff', 'cost_quality_tradeoff'),
  };

  const merged = {
    ...manifestDefaults,
    ...(trustedPolicy || {}),
    ...Object.fromEntries(Object.entries(inputOverlay).filter(([, value]) => value !== undefined)),
  };

  // Keep legacy callers safe while removing Auto Router from the active route. A stale trusted
  // config that still names the alias is converted to the explicit two-model direct pair before
  // validation, so it cannot reintroduce gateway-side model selection.
  if (merged.model === OPENROUTER_AUTO_MODEL) {
    merged.model = OPENROUTER_DIRECT_PRIMARY_MODEL;
    merged.allowed_models = [OPENROUTER_DIRECT_PRIMARY_MODEL, OPENROUTER_DIRECT_FALLBACK_MODEL];
  }

  if (merged.cost_quality_tradeoff !== undefined && typeof merged.cost_quality_tradeoff !== 'number') {
    const parsed = Number(merged.cost_quality_tradeoff);
    merged.cost_quality_tradeoff = Number.isNaN(parsed) ? merged.cost_quality_tradeoff : parsed;
  }

  return validateOpenRouterReviewPolicy(merged);
}

function buildOpenRouterRequestOptions(policy) {
  const candidate = policy && typeof policy === 'object'
    ? Object.fromEntries(
        Object.entries(policy).filter(([key]) => POLICY_KEYS.includes(key))
      )
    : policy;
  const validated = validateOpenRouterReviewPolicy(candidate);

  const requestOptions = {
    baseUrl: validated.base_url,
    model: validated.model,
    policyFingerprint: validated.policy_fingerprint,
    provider: {
      data_collection: validated.data_collection,
    },
    // The checked-in production policy is direct-model. Only an explicitly requested legacy
    // auto-router policy may carry the plugin, so a direct transport can never inherit it.
    ...(validated.model === OPENROUTER_AUTO_MODEL ? {
      plugins: [
        {
          id: 'auto-router',
          allowed_models: validated.allowed_models,
          cost_quality_tradeoff: validated.cost_quality_tradeoff,
        },
      ],
    } : {}),
  };

  return requestOptions;
}

module.exports = {
  DEFAULT_OPENROUTER_REVIEW_POLICY,
  resolveOpenRouterReviewPolicy,
  validateOpenRouterReviewPolicy,
  buildOpenRouterRequestOptions,
};
