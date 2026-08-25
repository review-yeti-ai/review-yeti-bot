'use strict';

// Rank 4 step 1: this manifest is validated as a credential-free contract,
// but is intentionally not consulted by resolveModelConfig yet. Wiring it into
// request construction is a later field-family change with its own parity
// evidence and immutable release.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROFILE_MANIFEST_PATH = path.resolve(__dirname, '../../../src/config/review-execution-profiles.json');
const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_IDS = new Set(['openrouter-primary', 'fireworks-breakglass', 'ollama-evaluation']);
const PROFILE_KEYS = Object.freeze([
  'id', 'transport', 'base_url_class', 'model', 'compatibility_mode', 'timeouts',
  'streaming', 'structured_output', 'reasoning', 'request_extensions', 'routing',
  'privacy', 'retry', 'quarantine', 'active',
]);
const BASE_URL_CLASSES = new Set([
  'openrouter-gateway',
  'direct-fireworks-openai-compatible',
  'direct-ollama-cloud-openai-compatible',
]);
const TRANSPORT_BY_PROFILE = Object.freeze({
  'openrouter-primary': 'openrouter',
  'fireworks-breakglass': 'fireworks',
  'ollama-evaluation': 'ollama',
});

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function rejectUnknownKeys(value, allowedKeys, label) {
  assertPlainObject(value, label);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) throw new Error(`${label} contains unknown key(s): ${unknownKeys.join(', ')}`);
}

function normalizeProfileId(value) {
  if (typeof value !== 'string' || !PROFILE_IDS.has(value.trim())) {
    throw new Error(`execution profile id must be one of: ${[...PROFILE_IDS].join(', ')}`);
  }
  return value.trim();
}

function normalizeProfile(profile) {
  assertPlainObject(profile, 'execution profile');
  rejectUnknownKeys(profile, PROFILE_KEYS, 'execution profile');

  const id = normalizeProfileId(profile.id);
  if (profile.transport !== TRANSPORT_BY_PROFILE[id]) throw new Error(`execution profile ${id} has the wrong transport`);
  if (!BASE_URL_CLASSES.has(profile.base_url_class)) throw new Error(`execution profile ${id} has an unapproved base_url_class`);
  if (id === 'openrouter-primary' && profile.base_url_class !== 'openrouter-gateway') throw new Error('openrouter-primary must use the OpenRouter gateway class');
  if (id === 'fireworks-breakglass' && profile.base_url_class !== 'direct-fireworks-openai-compatible') throw new Error('fireworks-breakglass must use the Fireworks direct class');
  if (id === 'ollama-evaluation' && profile.base_url_class !== 'direct-ollama-cloud-openai-compatible') throw new Error('ollama-evaluation must use the Ollama direct class');

  const model = typeof profile.model === 'string' ? profile.model.trim() : '';
  if (!model || model.length > 200 || /[\x00-\x1F\x7F]/.test(model) || /(?:^|[^a-z0-9])(?:bearer\s+|sk-(?:proj-)?|gh[ps]_|github_pat_|xox[baprs]-)[a-z0-9]/i.test(model)) {
    throw new Error(`execution profile ${id} model must be a bounded, credential-free identifier`);
  }

  rejectUnknownKeys(profile.timeouts, ['connect_ms', 'request_ms', 'stall_ms', 'ttft_ms'], `execution profile ${id}.timeouts`);
  for (const key of ['connect_ms', 'request_ms', 'stall_ms', 'ttft_ms']) {
    if (!Number.isSafeInteger(profile.timeouts[key]) || profile.timeouts[key] < 500 || profile.timeouts[key] > 600000) {
      throw new Error(`execution profile ${id}.timeouts.${key} must be an integer from 500 through 600000`);
    }
  }
  if (profile.streaming !== true) throw new Error(`execution profile ${id} must require streaming`);
  if (!['strict', 'runtime-default-uncharacterized'].includes(profile.structured_output)) throw new Error(`execution profile ${id} has an unsupported structured_output mode`);

  rejectUnknownKeys(profile.reasoning, ['effort', 'wire_shape'], `execution profile ${id}.reasoning`);
  if (!['high', 'runtime-default-uncharacterized'].includes(profile.reasoning.effort)) throw new Error(`execution profile ${id} has an unsupported reasoning effort`);
  if (!['reasoning.effort', 'reasoning_effort'].includes(profile.reasoning.wire_shape)) throw new Error(`execution profile ${id} has an unsupported reasoning wire shape`);
  if (profile.transport === 'openrouter' && profile.reasoning.wire_shape !== 'reasoning.effort') throw new Error('OpenRouter must use reasoning.effort');
  if (profile.transport !== 'openrouter' && profile.reasoning.wire_shape !== 'reasoning_effort') throw new Error('Direct providers must use reasoning_effort');

  rejectUnknownKeys(profile.request_extensions, ['perf_metrics_in_response'], `execution profile ${id}.request_extensions`);
  if (typeof profile.request_extensions.perf_metrics_in_response !== 'boolean') throw new Error(`execution profile ${id} perf_metrics_in_response must be boolean`);

  rejectUnknownKeys(profile.routing, ['mode', 'ignore_providers', 'provider'], `execution profile ${id}.routing`);
  if (!['direct', 'gateway-delegated'].includes(profile.routing.mode)) throw new Error(`execution profile ${id} has an unsupported routing mode`);
  if (!Array.isArray(profile.routing.ignore_providers) || profile.routing.ignore_providers.some((value) => typeof value !== 'string')) throw new Error(`execution profile ${id}.routing.ignore_providers must be strings`);
  if (profile.routing.provider !== null) {
    rejectUnknownKeys(profile.routing.provider, ['data_collection'], `execution profile ${id}.routing.provider`);
    if (profile.routing.provider.data_collection !== 'deny') throw new Error(`execution profile ${id} provider data collection must be deny`);
  }
  if (profile.transport === 'openrouter' && profile.routing.mode !== 'gateway-delegated') throw new Error('OpenRouter must use gateway-delegated routing');
  if (profile.transport !== 'openrouter' && profile.routing.mode !== 'direct') throw new Error('Direct providers must use direct routing');

  rejectUnknownKeys(profile.privacy, ['data_collection'], `execution profile ${id}.privacy`);
  if (!['deny', 'not-declared'].includes(profile.privacy.data_collection)) throw new Error(`execution profile ${id} has an unsupported privacy mode`);
  rejectUnknownKeys(profile.retry, ['max_attempts', 'classification'], `execution profile ${id}.retry`);
  if (profile.retry.max_attempts !== 2 || profile.retry.classification !== 'runtime-owned-uncharacterized') throw new Error(`execution profile ${id} must retain the bounded current retry contract`);
  rejectUnknownKeys(profile.quarantine, ['on_timeout'], `execution profile ${id}.quarantine`);
  if (typeof profile.quarantine.on_timeout !== 'boolean' && profile.quarantine.on_timeout !== 'runtime-default-uncharacterized') throw new Error(`execution profile ${id} has an unsupported quarantine mode`);
  if (typeof profile.active !== 'boolean') throw new Error(`execution profile ${id} active must be boolean`);
  if (id === 'openrouter-primary' && profile.active !== true) throw new Error('openrouter-primary must be the active profile definition');
  if (id !== 'openrouter-primary' && profile.active !== false) throw new Error(`execution profile ${id} must remain inactive until explicit promotion`);

  return {
    id,
    transport: profile.transport,
    base_url_class: profile.base_url_class,
    model,
    compatibility_mode: profile.compatibility_mode,
    timeouts: { ...profile.timeouts },
    streaming: true,
    structured_output: profile.structured_output,
    reasoning: { ...profile.reasoning },
    request_extensions: { ...profile.request_extensions },
    routing: {
      mode: profile.routing.mode,
      ignore_providers: [...profile.routing.ignore_providers],
      provider: profile.routing.provider === null ? null : { ...profile.routing.provider },
    },
    privacy: { ...profile.privacy },
    retry: { ...profile.retry },
    quarantine: { ...profile.quarantine },
    active: profile.active,
  };
}

function profileFingerprint(profile) {
  return crypto.createHash('sha256').update(JSON.stringify(profile), 'utf8').digest('hex');
}

function loadExecutionProfileManifest() {
  const manifest = JSON.parse(fs.readFileSync(PROFILE_MANIFEST_PATH, 'utf8'));
  assertPlainObject(manifest, 'execution profile manifest');
  rejectUnknownKeys(manifest, ['schema_version', 'profiles'], 'execution profile manifest');
  if (manifest.schema_version !== PROFILE_SCHEMA_VERSION) throw new Error(`execution profile schema_version must be ${PROFILE_SCHEMA_VERSION}`);
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length !== PROFILE_IDS.size) throw new Error(`execution profile manifest must contain exactly ${PROFILE_IDS.size} profiles`);

  const profiles = {};
  for (const rawProfile of manifest.profiles) {
    const normalized = normalizeProfile(rawProfile);
    if (Object.prototype.hasOwnProperty.call(profiles, normalized.id)) throw new Error(`execution profile ${normalized.id} is duplicated`);
    profiles[normalized.id] = Object.freeze({ ...normalized, profile_digest: profileFingerprint(normalized) });
  }
  for (const id of PROFILE_IDS) if (!Object.prototype.hasOwnProperty.call(profiles, id)) throw new Error(`execution profile manifest is missing ${id}`);
  return Object.freeze(profiles);
}

const EXECUTION_PROFILES = loadExecutionProfileManifest();

function resolveExecutionProfile(profileId) {
  if (profileId === undefined || profileId === null || profileId === '') return EXECUTION_PROFILES['openrouter-primary'];
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    throw new Error('execution profile selection must be an allowlisted profile identifier, not JSON');
  }
  return EXECUTION_PROFILES[normalizeProfileId(profileId)];
}

module.exports = {
  EXECUTION_PROFILES,
  PROFILE_SCHEMA_VERSION,
  loadExecutionProfileManifest,
  normalizeProfile,
  resolveExecutionProfile,
};
