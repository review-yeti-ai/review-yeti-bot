'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');

const POLICY_VERSION = 'trusted-review-policy-v1';
const DISPATCH_POLICY_VERSION = 'review-dispatch-policy-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u;
const BOUNDED_ID = /^[a-z0-9][a-z0-9._:-]{0,119}$/iu;
const DISPATCH_MODES = new Set(['baseline', 'shadow', 'enforce']);
const CHANGE_TYPES = new Set(['added', 'changed', 'copied', 'deleted', 'gitlink', 'modified', 'removed', 'renamed']);
const MAX_DISPATCH_RULES = 128;
const MAX_RULE_PATHS = 64;
const PROTECTED_INPUTS = new Map([
  ['provider', 'provider'],
  ['endpoint', 'endpoint'],
  ['credentialEnv', 'credential'],
  ['credential-env', 'credential'],
  ['tools', 'tools'],
  ['rules', 'rules'],
  ['dispatch', 'dispatch'],
  ['routes', 'routes'],
  ['files', 'files'],
  ['personas', 'personas'],
  ['bundles', 'bundles'],
  ['waivers', 'waivers'],
  ['policy', 'policy'],
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

function rejectUnknownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label}.${field} is not allowed`);
  }
}

function normalizeBoundedId(value, label) {
  const normalized = String(value || '').trim();
  if (!BOUNDED_ID.test(normalized)) throw new Error(`${label} must be a bounded identifier`);
  return normalized;
}

function normalizeRulePath(value, label, { exact = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a relative path${exact ? '' : ' glob'}`);
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
  if (!normalized || normalized.length > 240 || normalized.startsWith('/') || normalized.includes('\0')
    || normalized.split('/').includes('..') || normalized.startsWith('!')) {
    throw new Error(`${label} must be a canonical relative path${exact ? '' : ' glob'}`);
  }
  if (exact && /[*?\[\]{}]/u.test(normalized)) throw new Error(`${label} must be an exact path`);
  return normalized;
}

function normalizeRulePaths(value, label, options = {}) {
  if (!Array.isArray(value) || value.length < (options.minimum || 1) || value.length > MAX_RULE_PATHS) {
    throw new Error(`${label} must be a finite path list`);
  }
  const paths = value.map((entry, index) => normalizeRulePath(entry, `${label}[${index}]`, options));
  if (new Set(paths.map((entry) => entry.toLowerCase())).size !== paths.length) {
    throw new Error(`${label} must not contain duplicate or case-colliding paths`);
  }
  return options.exact ? paths.sort((left, right) => left.localeCompare(right)) : paths;
}

function normalizeSpecialistRule(value, index) {
  const source = asObject(value);
  const label = `review_intelligence.dispatch.specialist_rules[${index}]`;
  if (!source) throw new Error(`${label} must be a plain object`);
  rejectUnknownFields(source, new Set(['id', 'persona', 'paths', 'changes']), label);
  const changes = source.changes === undefined ? [] : source.changes;
  if (!Array.isArray(changes) || changes.length > CHANGE_TYPES.size) throw new Error(`${label}.changes must be a finite list`);
  const normalizedChanges = changes.map((entry) => String(entry || '').trim().toLowerCase());
  if (normalizedChanges.some((entry) => !CHANGE_TYPES.has(entry)) || new Set(normalizedChanges).size !== normalizedChanges.length) {
    throw new Error(`${label}.changes contains an invalid or duplicate change type`);
  }
  return Object.freeze({
    id: normalizeBoundedId(source.id, `${label}.id`),
    persona: normalizeBoundedId(source.persona, `${label}.persona`),
    paths: Object.freeze(normalizeRulePaths(source.paths, `${label}.paths`)),
    changes: Object.freeze(normalizedChanges),
  });
}

function normalizeBundleRule(value, index) {
  const source = asObject(value);
  const label = `review_intelligence.dispatch.bundle_rules[${index}]`;
  if (!source) throw new Error(`${label} must be a plain object`);
  rejectUnknownFields(source, new Set(['id', 'bundle_key', 'bundleKey', 'paths']), label);
  const bundleKey = source.bundle_key ?? source.bundleKey;
  return Object.freeze({
    id: normalizeBoundedId(source.id, `${label}.id`),
    bundleKey: normalizeBoundedId(bundleKey, `${label}.bundle_key`),
    paths: Object.freeze(normalizeRulePaths(source.paths, `${label}.paths`, { exact: true, minimum: 2 })),
  });
}

function oneRuleList(source, fields, nested, label) {
  const present = [];
  for (const field of fields) if (source[field] !== undefined) present.push(source[field]);
  if (nested) for (const field of fields) if (nested[field] !== undefined) present.push(nested[field]);
  if (present.length > 1) throw new Error(`${label} may be declared only once`);
  const result = present[0] ?? [];
  if (!Array.isArray(result) || result.length > MAX_DISPATCH_RULES) throw new Error(`${label} must be a finite rule list`);
  return result;
}

function normalizeDispatch(value) {
  const source = asObject(value);
  if (!source) throw new Error('review_intelligence.dispatch must be a plain object');
  rejectUnknownFields(source, new Set(['mode', 'baseline', 'specialist_rules', 'specialists', 'bundle_rules', 'bundles', 'rules']), 'review_intelligence.dispatch');
  const nestedRules = source.rules === undefined ? null : asObject(source.rules);
  if (source.rules !== undefined && !nestedRules) throw new Error('review_intelligence.dispatch.rules must be a plain object');
  if (nestedRules) rejectUnknownFields(nestedRules, new Set(['specialist_rules', 'specialists', 'bundle_rules', 'bundles']), 'review_intelligence.dispatch.rules');

  const mode = String(source.mode || 'baseline').trim().toLowerCase();
  if (!DISPATCH_MODES.has(mode)) throw new Error('review_intelligence.dispatch.mode is invalid');
  const baseline = source.baseline === undefined ? {} : asObject(source.baseline);
  if (!baseline) throw new Error('review_intelligence.dispatch.baseline must be a plain object');
  rejectUnknownFields(baseline, new Set(['persona', 'rule_id', 'ruleId']), 'review_intelligence.dispatch.baseline');
  const specialistSource = oneRuleList(source, ['specialist_rules', 'specialists'], nestedRules, 'review_intelligence.dispatch.specialist_rules');
  const bundleSource = oneRuleList(source, ['bundle_rules', 'bundles'], nestedRules, 'review_intelligence.dispatch.bundle_rules');
  const specialistRules = specialistSource.map(normalizeSpecialistRule);
  const bundleRules = bundleSource.map(normalizeBundleRule);
  const allRuleIds = [...specialistRules, ...bundleRules].map((rule) => rule.id);
  if (new Set(allRuleIds).size !== allRuleIds.length) throw new Error('review_intelligence.dispatch rule ids must be unique');

  return Object.freeze({
    schemaVersion: DISPATCH_POLICY_VERSION,
    mode,
    baseline: Object.freeze({
      persona: normalizeBoundedId(baseline.persona || 'baseline', 'review_intelligence.dispatch.baseline.persona'),
      ruleId: normalizeBoundedId(baseline.rule_id ?? baseline.ruleId ?? 'core-baseline', 'review_intelligence.dispatch.baseline.rule_id'),
    }),
    specialistRules: Object.freeze(specialistRules),
    bundleRules: Object.freeze(bundleRules),
  });
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
  if (intelligence.dispatch !== undefined && !asObject(intelligence.dispatch)) {
    return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_dispatch' });
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
  let dispatch;
  if (intelligence.dispatch !== undefined) {
    try {
      dispatch = normalizeDispatch(intelligence.dispatch);
    } catch (_) {
      return disabledPolicy({ raw, baseRef: base, status: 'invalid_config', reason: 'invalid_review_intelligence_dispatch' });
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
  if (dispatch) policy.dispatch = dispatch;
  return finalize(applyActionInputReductions(policy, actionInputs));
}

module.exports = { POLICY_VERSION, DISPATCH_POLICY_VERSION, resolveTrustedReviewPolicy, validateTrustedConfigRef };
