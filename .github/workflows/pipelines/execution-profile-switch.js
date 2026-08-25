'use strict';

// This module is a credential-free contract for a future central activation
// control plane. It is intentionally not imported by review-pipeline.js: a
// valid request cannot select a provider, alter a live action, or create a
// canary until a separately reviewed activation mechanism consumes it.
const { resolveExecutionProfile } = require('./execution-profile.js');

const SWITCH_SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 16 * 1024;
const REQUEST_KEYS = Object.freeze([
  'schema_version',
  'operation',
  'profile_id',
  'profile_digest',
  'repository',
  'pr_number',
  'base_sha',
  'head_sha',
  'previous_profile_id',
  'previous_profile_digest',
  'transport_plan_digest',
  'requested_by',
  'reason',
]);
const OPERATIONS = new Set(['prepare', 'activate']);
const SHA256_RE = /^[0-9a-f]{64}$/iu;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/iu;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function rejectUnknownKeys(value, allowedKeys, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown key(s): ${unknown.join(', ')}`);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`${label} contains a forbidden key: ${key}`);
    }
  }
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /[\x00-\x1F\x7F]/u.test(value)) {
    throw new Error(`${label} must be a bounded, control-free string`);
  }
  if (/(?:^|[^a-z0-9])(?:bearer\s+|sk-(?:proj-)?|gh[ps]_|github_pat_|xox[baprs]-)[a-z0-9]/iu.test(value)) {
    throw new Error(`${label} must not contain credential-shaped data`);
  }
  return value.trim();
}

function exactSha(value, label, expression) {
  const normalized = boundedText(value, label, expression === COMMIT_SHA_RE ? 40 : 64).toLowerCase();
  if (!expression.test(normalized)) throw new Error(`${label} must be an exact ${expression === COMMIT_SHA_RE ? '40' : '64'}-character hexadecimal digest`);
  return normalized;
}

function decodeManualProfileSwitchRequest(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('manual profile switch request must be base64 JSON');
  if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BYTES) throw new Error('manual profile switch request is too large');
  if (!/^[A-Za-z0-9+/_=-]+$/u.test(value)) throw new Error('manual profile switch request must be base64 JSON');

  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch (_) {
    throw new Error('manual profile switch request is not valid base64 JSON');
  }
  if (!decoded || Buffer.byteLength(decoded, 'utf8') > MAX_REQUEST_BYTES) throw new Error('manual profile switch request is empty or too large');

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (_) {
    throw new Error('manual profile switch request is not valid base64 JSON');
  }
  rejectUnknownKeys(parsed, REQUEST_KEYS, 'manual profile switch request');
  return parsed;
}

function normalizeManualProfileSwitchRequest(request, currentContext) {
  rejectUnknownKeys(request, REQUEST_KEYS, 'manual profile switch request');
  assertPlainObject(currentContext, 'current pull request context');

  if (request.schema_version !== SWITCH_SCHEMA_VERSION) {
    throw new Error(`manual profile switch schema_version must be ${SWITCH_SCHEMA_VERSION}`);
  }
  if (typeof request.operation !== 'string' || !OPERATIONS.has(request.operation)) {
    throw new Error('manual profile switch operation must be prepare or activate');
  }

  const repository = boundedText(request.repository, 'manual profile switch repository', 200);
  if (!REPOSITORY_RE.test(repository)) throw new Error('manual profile switch repository must be owner/name');
  const currentRepository = boundedText(currentContext.repository, 'current pull request repository', 200);
  if (repository !== currentRepository) throw new Error('manual profile switch repository does not match the current pull request');

  const prNumber = boundedText(String(request.pr_number), 'manual profile switch pr_number', 20);
  if (!/^[1-9][0-9]{0,9}$/u.test(prNumber)) throw new Error('manual profile switch pr_number must be a positive decimal number');
  if (prNumber !== boundedText(String(currentContext.pr_number), 'current pull request number', 20)) {
    throw new Error('manual profile switch pr_number does not match the current pull request');
  }

  const baseSha = exactSha(request.base_sha, 'manual profile switch base_sha', COMMIT_SHA_RE);
  const headSha = exactSha(request.head_sha, 'manual profile switch head_sha', COMMIT_SHA_RE);
  if (baseSha !== exactSha(currentContext.base_sha, 'current pull request base_sha', COMMIT_SHA_RE)) {
    throw new Error('manual profile switch base_sha does not match the current pull request');
  }
  if (headSha !== exactSha(currentContext.head_sha, 'current pull request head_sha', COMMIT_SHA_RE)) {
    throw new Error('manual profile switch head_sha does not match the current pull request');
  }

  const target = resolveExecutionProfile(request.profile_id);
  const previous = resolveExecutionProfile(request.previous_profile_id);
  const profileDigest = exactSha(request.profile_digest, 'manual profile switch profile_digest', SHA256_RE);
  const previousDigest = exactSha(request.previous_profile_digest, 'manual profile switch previous_profile_digest', SHA256_RE);
  if (profileDigest !== target.profile_digest) throw new Error('manual profile switch profile_digest does not match the immutable profile');
  if (previousDigest !== previous.profile_digest) throw new Error('manual profile switch previous_profile_digest does not match the immutable profile');
  if (previous.active !== true) throw new Error(`manual profile switch previous profile ${previous.id} is not active`);
  if (target.id === previous.id) throw new Error('manual profile switch must change the selected profile');
  if (request.operation === 'activate' && target.active !== true) {
    throw new Error(`manual profile switch cannot activate inactive profile ${target.id}`);
  }

  const transportPlanDigest = request.transport_plan_digest === undefined
    ? null
    : exactSha(request.transport_plan_digest, 'manual profile switch transport_plan_digest', SHA256_RE);
  const requestedBy = boundedText(request.requested_by, 'manual profile switch requested_by', 200);
  const reason = boundedText(request.reason, 'manual profile switch reason', 500);

  return Object.freeze({
    schema_version: SWITCH_SCHEMA_VERSION,
    operation: request.operation,
    profile_id: target.id,
    profile_digest: profileDigest,
    repository,
    pr_number: prNumber,
    base_sha: baseSha,
    head_sha: headSha,
    previous_profile_id: previous.id,
    previous_profile_digest: previousDigest,
    transport_plan_digest: transportPlanDigest,
    requested_by: requestedBy,
    reason,
  });
}

function validateManualProfileSwitchRequest(value, currentContext) {
  const request = typeof value === 'string' ? decodeManualProfileSwitchRequest(value) : value;
  if (request === null) return null;
  return normalizeManualProfileSwitchRequest(request, currentContext);
}

module.exports = {
  MAX_REQUEST_BYTES,
  REQUEST_KEYS,
  SWITCH_SCHEMA_VERSION,
  decodeManualProfileSwitchRequest,
  normalizeManualProfileSwitchRequest,
  validateManualProfileSwitchRequest,
};
