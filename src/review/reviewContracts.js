'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');

const REVIEW_IDENTITY_VERSION = 'review-identity-v1';
const REVIEW_EVENT_SINK_VERSION = 'review-event-sink-v1';
const REVIEW_TELEMETRY_SINK_VERSION = 'review-telemetry-sink-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u;

function requiredRepository(value) {
  const repository = String(value || '').trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error('repository must be an owner/name identifier');
  }
  return repository;
}

function requiredPrNumber(value) {
  const prNumber = Number(value);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error('prNumber must be a positive integer');
  }
  return prNumber;
}

function requiredCommitSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`${label} must be a 40-64 character commit SHA`);
  }
  return sha;
}

function digest(value) {
  return sha256(typeof value === 'string' ? value : canonicalJson(value || {}));
}

/**
 * Immutable coordinates for one review. IDs intentionally contain no branch names, authors,
 * prompts, credentials, or model transcripts, so they are safe to persist in receipts.
 */
function createReviewIdentity({ repository, prNumber, baseSha, headSha, trustedConfig, effectivePolicy } = {}) {
  return Object.freeze({
    schemaVersion: REVIEW_IDENTITY_VERSION,
    repository: requiredRepository(repository),
    prNumber: requiredPrNumber(prNumber),
    baseSha: requiredCommitSha(baseSha, 'baseSha'),
    headSha: requiredCommitSha(headSha, 'headSha'),
    configDigest: digest(trustedConfig),
    policyDigest: digest(effectivePolicy),
  });
}

function reviewIdentityDigest(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('review identity is required');
  }
  return sha256(canonicalJson(identity));
}

function createNoopReviewEventSink() {
  return Object.freeze({
    schemaVersion: REVIEW_EVENT_SINK_VERSION,
    async emit() {},
  });
}

function createNoopReviewTelemetrySink() {
  return Object.freeze({
    schemaVersion: REVIEW_TELEMETRY_SINK_VERSION,
    async emit() {},
  });
}

module.exports = {
  REVIEW_IDENTITY_VERSION,
  REVIEW_EVENT_SINK_VERSION,
  REVIEW_TELEMETRY_SINK_VERSION,
  createReviewIdentity,
  reviewIdentityDigest,
  createNoopReviewEventSink,
  createNoopReviewTelemetrySink,
};
