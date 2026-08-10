'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');
const { parsePatchAnchors } = require('./findingPublication');

const SCHEMA_VERSION = 'finding-verification-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/iu;
const DIGEST = /^[a-f0-9]{64}$/iu;
const MODES = new Set(['report_only', 'enforce']);
const RECEIPT_REASONS = new Set([
  'ok', 'invalid_finding', 'invalid_path', 'unknown_path', 'ambiguous_path', 'invalid_side',
  'invalid_line', 'ambiguous_side', 'invalid_anchor', 'unusable_patch', 'content_hash_mismatch',
  'content_hash_unavailable', 'snapshot_missing', 'identity_invalid', 'identity_mismatch',
  'snapshot_mismatch', 'duplicate_claim', 'anchor_conflict', 'invalid_claim',
]);

function canonicalPath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//u, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const repository = String(value.repository || '').trim().toLowerCase();
  const prNumber = Number(value.prNumber);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository) || !Number.isSafeInteger(prNumber) || prNumber < 1) return null;
  const normalized = { repository, prNumber };
  for (const field of ['baseSha', 'headSha']) {
    const sha = String(value[field] || '').trim().toLowerCase();
    if (!COMMIT_SHA.test(sha)) return null;
    normalized[field] = sha;
  }
  for (const field of ['configDigest', 'policyDigest']) {
    const digest = String(value[field] || '').trim().toLowerCase();
    if (!DIGEST.test(digest)) return null;
    normalized[field] = digest;
  }
  return normalized;
}

function sameIdentity(left, right) {
  return Boolean(left && right && canonicalJson(left) === canonicalJson(right));
}

function isGitlink(file) {
  return Boolean(file && (file.isSubmodule === true || file.submoduleCandidate === true
    || [file.mode, file.oldMode, file.newMode, file.old_mode, file.new_mode]
      .some((mode) => String(mode || '') === '160000')));
}

function isBinary(file) {
  return Boolean(file && (file.binary === true || file.isBinary === true
    || /(?:^|\n)(?:Binary files|GIT binary patch)/u.test(String(file.patch || ''))));
}

function isPatchless(file) {
  return file?.patch === undefined || file?.patch === null || (typeof file.patch === 'string' && !file.patch.trim());
}

function exactSnapshotFile(snapshot, path) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const candidates = Array.isArray(snapshot.files)
    ? snapshot.files
    : snapshot.files && typeof snapshot.files === 'object'
      ? Object.values(snapshot.files)
      : snapshot.byPath && typeof snapshot.byPath === 'object'
        ? Object.values(snapshot.byPath)
        : [];
  return candidates.find((file) => canonicalPath(file?.path) === path) || null;
}

function normalizedHash(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DIGEST.test(raw) ? raw : null;
}

function snapshotContentHash(file) {
  if (!file || typeof file !== 'object') return null;
  for (const key of ['contentHash', 'content_hash', 'sha256', 'hash']) {
    const candidate = normalizedHash(file[key]);
    if (candidate) return candidate;
  }
  return typeof file.content === 'string' ? sha256(file.content) : null;
}

function findingContentHash(finding) {
  return normalizedHash(finding?.contentHash ?? finding?.content_hash);
}

function normalizedClaim(finding) {
  const title = typeof finding?.title === 'string' ? finding.title.replace(/\s+/gu, ' ').trim().toLowerCase() : '';
  const body = typeof finding?.body === 'string' ? finding.body.replace(/\s+/gu, ' ').trim().toLowerCase() : '';
  if (!title || !body) return null;
  return sha256(canonicalJson({ title, body }));
}

function receipt({ status, reasonCode, identityDigest, path, side, line, subjectType, claimFingerprint, findingKey }) {
  // This is deliberately an allowlist. Model prose, author/provider/source metadata, and raw
  // snapshot content must never cross the verifier boundary into a persisted receipt.
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    verifierVersion: SCHEMA_VERSION,
    status,
    reasonCode: RECEIPT_REASONS.has(reasonCode) ? reasonCode : 'invalid_finding',
    ...(identityDigest ? { identityDigest } : {}),
    ...(path ? { path } : {}),
    ...(side ? { side } : {}),
    ...(Number.isSafeInteger(line) ? { line } : {}),
    ...(subjectType ? { subjectType } : {}),
    ...(claimFingerprint ? { claimFingerprint } : {}),
    ...(findingKey ? { findingKey } : {}),
  });
}

function claimStoreGet(store, key) {
  return store instanceof Map ? store.get(key) : store instanceof Set ? store.has(key) : undefined;
}

function claimStoreSet(store, key, value) {
  if (store instanceof Map) store.set(key, value);
  else if (store instanceof Set) store.add(key);
}

/**
 * Verifies one model finding using only an immutable PR snapshot and exact review identity.
 * The return value is a redacted receipt; it contains no model prose or attribution.
 */
function verifyFinding({ finding, changedFiles, exactBlobSnapshot, identity, mode = 'report_only', seenClaims } = {}) {
  const effectiveMode = MODES.has(mode) ? mode : 'report_only';
  const exactIdentity = normalizeIdentity(identity);
  if (!exactIdentity) return receipt({ status: 'needs_review', reasonCode: 'identity_invalid' });
  const identityDigest = sha256(canonicalJson(exactIdentity));
  const snapshotIdentity = normalizeIdentity(exactBlobSnapshot?.identity);
  if (!snapshotIdentity || !sameIdentity(exactIdentity, snapshotIdentity)) {
    return receipt({ status: 'needs_review', reasonCode: exactBlobSnapshot ? 'identity_mismatch' : 'snapshot_missing', identityDigest });
  }
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return receipt({ status: 'rejected', reasonCode: 'invalid_finding', identityDigest });
  }
  const path = canonicalPath(finding.path);
  if (!path) return receipt({ status: 'rejected', reasonCode: 'invalid_path', identityDigest });
  if (!Array.isArray(changedFiles)) return receipt({ status: 'needs_review', reasonCode: 'snapshot_missing', identityDigest, path });
  const matchingFiles = changedFiles.filter((file) => canonicalPath(file?.path) === path);
  if (matchingFiles.length === 0) return receipt({ status: 'rejected', reasonCode: 'unknown_path', identityDigest, path });
  if (matchingFiles.length !== 1) return receipt({ status: 'needs_review', reasonCode: 'ambiguous_path', identityDigest, path });
  const changed = matchingFiles[0];
  const snapshotFile = exactSnapshotFile(exactBlobSnapshot, path);
  if (!snapshotFile) return receipt({ status: 'needs_review', reasonCode: 'snapshot_missing', identityDigest, path });
  if (typeof changed.patch === 'string' && typeof snapshotFile.patch === 'string' && changed.patch !== snapshotFile.patch) {
    return receipt({ status: 'needs_review', reasonCode: 'snapshot_mismatch', identityDigest, path });
  }

  const sideProvided = finding.side !== undefined && finding.side !== null;
  let side = sideProvided ? String(finding.side).toUpperCase() : 'RIGHT';
  if (side !== 'RIGHT' && side !== 'LEFT') return receipt({ status: 'rejected', reasonCode: 'invalid_side', identityDigest, path });
  const line = Number(finding.line);
  if (!Number.isSafeInteger(line) || line < 1) return receipt({ status: 'rejected', reasonCode: 'invalid_line', identityDigest, path, side });

  const suppliedHash = findingContentHash(finding);
  if (suppliedHash) {
    const actualHash = snapshotContentHash(snapshotFile);
    if (!actualHash) return receipt({ status: 'needs_review', reasonCode: 'content_hash_unavailable', identityDigest, path, side, line });
    if (actualHash !== suppliedHash) return receipt({ status: 'rejected', reasonCode: 'content_hash_mismatch', identityDigest, path, side, line });
  }

  let subjectType;
  if (isBinary(changed) || isGitlink(changed) || isPatchless(changed)) {
    subjectType = 'file';
  } else if (typeof changed.patch !== 'string') {
    return receipt({ status: 'needs_review', reasonCode: 'unusable_patch', identityDigest, path, side, line });
  } else {
    const anchors = parsePatchAnchors(changed.patch);
    if (!anchors.hasHunks) return receipt({ status: 'needs_review', reasonCode: 'unusable_patch', identityDigest, path, side, line });
    if (!sideProvided && anchors.right.has(line) && anchors.left.has(line)) {
      return receipt({ status: 'needs_review', reasonCode: 'ambiguous_side', identityDigest, path, side, line });
    }
    if (!sideProvided && !anchors.right.has(line) && anchors.left.has(line)) side = 'LEFT';
    if (!(side === 'LEFT' ? anchors.left : anchors.right).has(line)) {
      return receipt({ status: 'rejected', reasonCode: 'invalid_anchor', identityDigest, path, side, line });
    }
    subjectType = 'line';
  }

  const claimFingerprint = normalizedClaim(finding);
  if (!claimFingerprint) return receipt({ status: 'rejected', reasonCode: 'invalid_claim', identityDigest, path, side, line, subjectType });
  const anchorKey = `${path}|${subjectType === 'file' ? 'FILE' : `${side}:${line}`}`;
  const findingKey = `fv_${sha256(canonicalJson({ schemaVersion: SCHEMA_VERSION, identityDigest, anchorKey, claimFingerprint }))}`;
  if (seenClaims) {
    if (claimStoreGet(seenClaims, `claim:${claimFingerprint}`)) {
      return receipt({ status: 'rejected', reasonCode: 'duplicate_claim', identityDigest, path, side, line, subjectType, claimFingerprint, findingKey });
    }
    const priorAtAnchor = claimStoreGet(seenClaims, `anchor:${anchorKey}`);
    if (priorAtAnchor && priorAtAnchor !== claimFingerprint) {
      return receipt({ status: 'needs_review', reasonCode: 'anchor_conflict', identityDigest, path, side, line, subjectType, claimFingerprint, findingKey });
    }
    claimStoreSet(seenClaims, `claim:${claimFingerprint}`, findingKey);
    claimStoreSet(seenClaims, `anchor:${anchorKey}`, claimFingerprint);
  }
  return receipt({ status: 'accepted', reasonCode: 'ok', identityDigest, path, side, line, subjectType, claimFingerprint, findingKey, mode: effectiveMode });
}

/**
 * Batch wrapper whose `findings`/`acceptedFindings` are the only raw-finding carriers. The
 * `verifications` and `summary` fields are receipt-safe and can be persisted or published.
 */
function verifyFindings({ findings, changedFiles, exactBlobSnapshot, identity, mode = 'report_only', seenClaims } = {}) {
  const effectiveMode = MODES.has(mode) ? mode : 'report_only';
  const source = Array.isArray(findings) ? findings : [];
  const store = seenClaims instanceof Map || seenClaims instanceof Set ? seenClaims : new Map();
  const verifications = source.map((finding) => verifyFinding({ finding, changedFiles, exactBlobSnapshot, identity, mode: effectiveMode, seenClaims: store }));
  const acceptedIndexes = new Set(verifications.flatMap((result, index) => result.status === 'accepted' ? [index] : []));
  const accepted = source.filter((_, index) => acceptedIndexes.has(index));
  const rejected = verifications.filter((result) => result.status === 'rejected');
  const needsReview = verifications.filter((result) => result.status === 'needs_review');
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    verifierVersion: SCHEMA_VERSION,
    mode: effectiveMode,
    findings: effectiveMode === 'enforce' ? accepted : source,
    acceptedFindings: effectiveMode === 'enforce' ? accepted : source,
    verifications: Object.freeze(verifications),
    summary: Object.freeze({ accepted: accepted.length, rejected: rejected.length, needsReview: needsReview.length, incomplete: effectiveMode === 'enforce' && needsReview.length > 0 }),
  });
}

module.exports = { SCHEMA_VERSION, verifyFinding, verifyFindings };
