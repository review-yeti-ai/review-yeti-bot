'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');

const POLICY_VERSION = 'trusted-review-policy-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u;
const PROTECTED_INPUTS = new Map([
  ['provider', 'provider'],
  ['endpoint', 'endpoint'],
  ['credentialEnv', 'credential'],
  ['credential-env', 'credential'],
  ['tools', 'tools'],
  ['rules', 'rules'],
]);
const LIMIT_INPUTS = new Map([
  ['maxDiffChars', 'maxDiffChars'],
  ['maxFileDiffChars', 'maxFileDiffChars'],
  ['maxPersonas', 'maxPersonas'],
]);

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function asBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function inputIsPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function exactCommitRef(value, label) {
  const ref = String(value || '').trim().toLowerCase();
  if (!COMMIT_SHA.test(ref)) throw new Error(`${label} must be a 40-64 character commit SHA`);
  return ref;
}

function policyDigest(policy) {
  return sha256(canonicalJson(policy));
}

function finalize(policy) {
  const result = { ...policy };
  result.policyDigest = policyDigest(result);
  return Object.freeze(result);
}

function disabledPolicy({ raw, baseRef, status, reason }) {
  return finalize({
    schemaVersion: POLICY_VERSION,
    status,
    reason,
    enabled: false,
    trustedBaseRef: baseRef,
    configDigest: sha256(String(raw || '')),
    limits: {},
  });
}

/**
 * Rejects caller-selected refs. A PR review must use the exact base snapshot, not merely a
 * branch that currently happens to point at it. This makes a malicious `config-ref` impossible
 * to race between config retrieval and policy resolution.
 */
function validateTrustedConfigRef(configRef, baseRef, headRef) {
  const base = exactCommitRef(baseRef, 'baseRef');
  const head = exactCommitRef(headRef, 'headRef');
  if (!inputIsPresent(configRef)) return base;
  const requested = exactCommitRef(configRef, 'config-ref');
  if (requested === head || requested !== base) {
    throw new Error('config-ref must resolve to the pull request base SHA');
  }
  return base;
}

function normalizeLimit(value, label) {
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value.trim()) ? Number(value.trim()) : NaN);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function normalizeLimits(rawLimits) {
  const source = asObject(rawLimits) || {};
  const limits = {};
  const fieldMap = {
    max_diff_chars: 'maxDiffChars',
    max_file_diff_chars: 'maxFileDiffChars',
    max_personas: 'maxPersonas',
  };
  for (const [sourceField, targetField] of Object.entries(fieldMap)) {
    if (source[sourceField] !== undefined) limits[targetField] = normalizeLimit(source[sourceField], `review_intelligence.limits.${sourceField}`);
  }
  return limits;
}

function normalizeCapabilities(value) {
  const source = asObject(value);
  if (!source) throw new Error('review_intelligence.capabilities must be a plain object');
  const result = {};
  if (typeof source.provider !== 'string' || !source.provider.trim()) {
    throw new Error('review_intelligence.capabilities.provider must be a non-empty string');
  }
  result.provider = source.provider.trim().toLowerCase();
  if (typeof source.endpoint !== 'string') {
    throw new Error('review_intelligence.capabilities.endpoint must be an absolute https URL');
  }
  const endpoint = source.endpoint.trim();
  let parsed;
  try { parsed = new URL(endpoint); } catch (_) { throw new Error('review_intelligence.capabilities.endpoint must be an absolute https URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('review_intelligence.capabilities.endpoint must be an absolute https URL');
  }
  result.endpoint = parsed.toString().replace(/\/$/u, '');
  for (const field of ['tools', 'rules']) {
    if (source[field] !== undefined) {
      if (!Array.isArray(source[field]) || source[field].some((entry) => typeof entry !== 'string' || !entry.trim())) {
        throw new Error(`review_intelligence.capabilities.${field} must be a list of non-empty strings`);
      }
      result[field] = [...source[field]].map((entry) => entry.trim()).sort();
    }
  }
  return result;
}

function applyActionInputReductions(policy, actionInputs) {
  const inputs = asObject(actionInputs) || {};
  for (const [key, field] of PROTECTED_INPUTS) {
    if (inputIsPresent(inputs[key])) throw new Error(`Action input may not change ${field}`);
  }
  if (inputIsPresent(inputs.configRef) || inputIsPresent(inputs['config-ref'])) {
    throw new Error('Action input may not change config-ref');
  }
  if (inputIsPresent(inputs.enabled)) {
    const enabled = asBoolean(inputs.enabled);
    if (enabled === null) throw new Error('Action input enabled must be boolean');
    if (enabled) throw new Error('Action input enabled may not enable review intelligence');
    policy.enabled = false;
    policy.status = 'disabled_by_action';
  }
  for (const [inputName, limitName] of LIMIT_INPUTS) {
    if (!inputIsPresent(inputs[inputName])) continue;
    if (policy.limits[limitName] === undefined) throw new Error(`Action input ${inputName} has no trusted limit to reduce`);
    const requested = normalizeLimit(inputs[inputName], `Action input ${inputName}`);
    if (requested > policy.limits[limitName]) throw new Error(`Action input ${inputName} may only reduce the trusted limit`);
    policy.limits[limitName] = requested;
  }
  return policy;
}

/**
 * Resolves only the opt-in Review Intelligence v1 policy. Its output is report-only at this
 * stage; legacy pipeline policy remains the execution authority when the block is absent.
 */
function resolveTrustedReviewPolicy({ trustedConfig, baseRef, headRef, configRef, actionInputs } = {}) {
  const base = validateTrustedConfigRef(configRef, baseRef, headRef);
  const raw = trustedConfig?.raw;
  if (trustedConfig?.parseError || (typeof raw === 'string' && raw.length > 0 && !asObject(trustedConfig?.parsed))) {
    return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'trusted_config_parse_failed' });
  }
  const parsed = asObject(trustedConfig?.parsed) || {};
  const intelligence = parsed.review_intelligence;
  if (intelligence === undefined) return disabledPolicy({ raw, baseRef: base, status: 'disabled', reason: 'not_configured' });
  if (!asObject(intelligence) || intelligence.version !== 1) {
    return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_contract' });
  }
  if (intelligence.limits !== undefined && !asObject(intelligence.limits)) {
    return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_limits' });
  }
  if (intelligence.capabilities !== undefined && !asObject(intelligence.capabilities)) {
    return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_capabilities' });
  }

  let limits;
  try {
    limits = normalizeLimits(intelligence.limits);
  } catch (_) {
    return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_limits' });
  }
  let capabilities;
  if (intelligence.capabilities !== undefined) {
    try {
      capabilities = normalizeCapabilities(intelligence.capabilities);
    } catch (_) {
      return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_capabilities' });
    }
  }

  const enabled = intelligence.enabled === true;
  const policy = {
    schemaVersion: POLICY_VERSION,
    status: enabled ? 'enabled' : 'disabled',
    enabled,
    trustedBaseRef: base,
    configDigest: sha256(String(raw || '')),
    limits,
  };
  if (capabilities) policy.capabilities = capabilities;
  return finalize(applyActionInputReductions(policy, actionInputs));
}

module.exports = { POLICY_VERSION, resolveTrustedReviewPolicy, validateTrustedConfigRef };
