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
/**
 * A third funded destination, pinned by digest rather than plaintext.
 *
 * This repository is public, and the operator's hygiene rule bars first-party hostnames from it.
 * The allowlist above cannot simply gain a fourth string without publishing that hostname, and it
 * must NOT become env-configurable -- "whatever a repository variable says" is not an exfiltration
 * control, which is the whole point of the comment above.
 *
 * Pinning the SHA-256 of the normalized base URL keeps both properties: the allowlist stays closed
 * (only one exact URL matches, and changing it still requires a reviewed commit), while the
 * hostname stays out of public source, greps, and code search.
 *
 * Honest about what this is NOT: the destination is a public DNS name, so the digest is guessable
 * by anyone who thinks to try it. This is hygiene, not secrecy. It buys absence from the public
 * source tree, not confidentiality of the endpoint.
 */
const ALLOWED_REVIEW_BASE_URL_DIGESTS = Object.freeze([
  'ca8309dbe7eb85c5c7da280d48572eb44d159c1244ebea3548b82784cbc27c53',
]);

function digestBaseUrl(baseUrl) {
  return crypto.createHash('sha256').update(baseUrl).digest('hex');
}

/**
 * Built as a factory purely so the digest branch is testable. The suite cannot exercise it against
 * the production pin without hardcoding the very hostname the pin exists to keep out of this public
 * repository, so tests build a predicate over their own URL and digest instead. The exported
 * production predicate stays bound to the frozen constants, so this is a testing seam, not a
 * widening of the control.
 */
function createReviewBaseUrlAllowlist(baseUrls, digests) {
  const urlSet = new Set(baseUrls);
  const digestSet = new Set(digests);
  const isAllowed = function isAllowed(baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) return false;
    if (urlSet.has(baseUrl)) return true;
    return digestSet.has(digestBaseUrl(baseUrl));
  };
  // Surfaced so the suite can assert the production predicate is actually WIRED to the production
  // pins. Without this, emptying the digest list at the call site leaves the exported constant
  // intact and every test still passes while the destination silently stops being admitted --
  // verified: that mutation was green across the whole file before this existed.
  isAllowed.plaintextCount = urlSet.size;
  isAllowed.pinnedDigestCount = digestSet.size;
  return isAllowed;
}

const isAllowedReviewBaseUrl = createReviewBaseUrlAllowlist(
  ALLOWED_REVIEW_BASE_URLS,
  ALLOWED_REVIEW_BASE_URL_DIGESTS,
);
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
  // The digest-pinned destination namespaces models by the provider it fronts. Same flash-class
  // model family as the entries above, reached by a third name on a third destination.
  'neuralwatt/glm-5.3-flash',
  'neuralwatt/deepseek-v4-flash',
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

  if (!isAllowedReviewBaseUrl(normalized.base_url)) {
    throw new Error(
      `Review policy base url must normalize exactly to one of: ${ALLOWED_REVIEW_BASE_URLS.join(', ')}`
        + `, or match one of ${ALLOWED_REVIEW_BASE_URL_DIGESTS.length} digest-pinned destination(s)`,
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

  // Runs AFTER the auto-model conversion above, which is why there is no auto-model guard here:
  // that block rewrites `merged.model` to the direct primary, so the pseudo-model cannot reach
  // this point. A guard for it would be unreachable, and an unreachable guard invites a test that
  // asserts nothing. The auto path's resolved shape is pinned by its own test instead.
  //
  // Selecting a model while forbidding it is incoherent, and the two values come from different
  // places: `model` from an action input, `allowed_models` from the manifest default. So a
  // destination whose model id is absent from that default throws here and every lane fails with
  // zero findings, even though the destination allowlist, the guard script and the workflow are
  // each individually correct. The current opencode configuration avoids this only by coincidence
  // -- its bare model id happens to appear in the manifest's list.
  //
  // This does NOT widen the security control. Which models may be used at all is enforced by
  // CANONICAL_ALLOWED_MODEL_SET below, and the destination by the base-url pin. `allowed_models`
  // is the per-request routing set, so it must follow the selected model, not contradict it.
  const explicitAllowedModels = inputOverlay.allowed_models !== undefined
    || (trustedPolicy && trustedPolicy.allowed_models !== undefined);
  if (
    !explicitAllowedModels
    && typeof merged.model === 'string'
    && Array.isArray(merged.allowed_models)
    && !merged.allowed_models.includes(merged.model)
  ) {
    merged.allowed_models = [merged.model, ...merged.allowed_models];
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
  ALLOWED_REVIEW_BASE_URLS,
  ALLOWED_REVIEW_BASE_URL_DIGESTS,
  createReviewBaseUrlAllowlist,
  isAllowedReviewBaseUrl,
  resolveOpenRouterReviewPolicy,
  validateOpenRouterReviewPolicy,
  buildOpenRouterRequestOptions,
};
