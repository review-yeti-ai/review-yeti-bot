'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');
const { classifyReviewFile } = require('./reviewIgnorePolicy');

const SCHEMA_VERSION = 'review-unit-manifest-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/iu;
const TERMINAL_STATUSES = new Set(['completed', 'reused', 'failed', 'waived']);
const COVERED_STATUSES = new Set(['completed', 'reused', 'waived', 'excluded', 'oversized']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function canonicalPath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//u, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) return null;
  return normalized;
}

function displayPath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/^\.\//u, '').trim() : '';
}

function normalizedRange(file) {
  const source = object(file?.range);
  const number = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const start = number(source.start ?? file?.startLine ?? file?.line ?? file?.newLine ?? file?.oldLine);
  const end = number(source.end ?? file?.endLine) || start;
  return { side: String(source.side ?? file?.side ?? 'RIGHT').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT', start, end: Math.max(start, end) };
}

function contentDigest(file) {
  const raw = typeof file?.content === 'string' ? file.content : typeof file?.patch === 'string' ? file.patch : '';
  return sha256(raw);
}

function blobDigest(file) {
  const candidate = [file?.blobSha, file?.blob_sha, file?.newSha, file?.sha, file?.contentHash]
    .find((value) => typeof value === 'string' && value.trim());
  return candidate ? String(candidate).trim().toLowerCase() : contentDigest(file);
}

function stableReviewUnitId(input = {}) {
  const path = canonicalPath(input.path);
  if (!path) throw new TypeError('review unit path must be a canonical relative path');
  const policyDigest = String(input.policyDigest || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(policyDigest)) throw new TypeError('review unit policyDigest must be a SHA-256 digest');
  const range = normalizedRange(input);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    path,
    range,
    contentDigest: typeof input.contentDigest === 'string' && input.contentDigest ? input.contentDigest : contentDigest(input),
    blobDigest: typeof input.blobDigest === 'string' && input.blobDigest ? input.blobDigest : blobDigest(input),
    policyDigest,
  };
  return `ru_${sha256(canonicalJson(payload))}`;
}

function matches(path, patterns) {
  const normalized = String(path || '').toLowerCase();
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const raw = String(pattern || '').trim().replace(/^\.\//u, '').toLowerCase();
    if (!raw) return false;
    const expression = raw.split('**').map((part) => part.split('*').map((piece) => piece.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${expression}$`, 'iu').test(normalized);
  });
}

function isGitlink(file) {
  return file?.isSubmodule === true || [file?.mode, file?.oldMode, file?.newMode, file?.old_mode, file?.new_mode]
    .some((mode) => String(mode || '') === '160000');
}

function hasMeaningfulPatch(file) {
  const patch = typeof file?.patch === 'string' ? file.patch : '';
  return /^(?:\+[^+]|-[^-])/mu.test(patch);
}

/**
 * Classifies a changed file using only trusted policy and immutable diff metadata. It deliberately
 * accepts no model output: model prose cannot choose, waive, or redefine a review unit.
 */
function classifyReviewUnitFile(file = {}, trustedPolicy = {}) {
  const policy = object(trustedPolicy);
  const path = canonicalPath(file.path);
  if (!path) return { status: 'unreviewable', reason: 'invalid_path', path: displayPath(file.path) };
  if (file.pathAlias === true || file.aliasOf || file.pathAmbiguous === true) return { status: 'unreviewable', reason: 'path_alias', path };
  if (file.unreviewable === true) return { status: 'unreviewable', reason: String(file.unreviewableReason || 'unreviewable'), path };

  const binary = file.binary === true || /(^|\n)Binary files .* differ(?:\n|$)/iu.test(String(file.patch || ''));
  if (binary) return { status: 'excluded', reason: 'binary', path, change: 'binary' };
  const generatedPatterns = [...(policy.generatedPatterns || []), ...(policy.generated_patterns || [])];
  const vendorPatterns = [...(policy.vendorPatterns || []), ...(policy.vendor_patterns || [])];
  if (matches(path, generatedPatterns) || /(?:^|\/)(?:generated|gen)(?:\/|$)|\.generated\./iu.test(path)) return { status: 'excluded', reason: 'generated', path };
  if (matches(path, vendorPatterns) || /(?:^|\/)(?:vendor|third_party)(?:\/|$)/iu.test(path)) return { status: 'excluded', reason: 'vendored', path };
  if (matches(path, policy.exclude || policy.excludes || [])) return { status: 'excluded', reason: 'policy_excluded', path };

  const maximum = Number(policy.maxFileDiffChars ?? policy.max_file_diff_chars);
  const standardIgnore = classifyReviewFile(file, [], Number.isSafeInteger(maximum) && maximum > 0 ? maximum : undefined);
  if (standardIgnore.kind === 'skipped') return { status: 'excluded', reason: standardIgnore.category === 'generated' ? 'generated' : `policy_${standardIgnore.category}`, path };
  if (standardIgnore.kind === 'oversized') return { status: 'oversized', reason: 'per_file_limit', path, diffChars: standardIgnore.diffChars };
  const size = typeof file.patch === 'string' ? file.patch.length : typeof file.content === 'string' ? file.content.length : 0;
  if (Number.isSafeInteger(maximum) && maximum > 0 && size > maximum) return { status: 'oversized', reason: 'per_file_limit', path, diffChars: size };

  const gitlink = isGitlink(file);
  if (gitlink) {
    if (file.unresolvedSubmodule === true || file.submoduleResolved === false) return { status: 'unreviewable', reason: 'unresolved_submodule', path, change: 'gitlink' };
    if (file.submoduleUrlChanged === true || (file.oldSubmoduleUrl && file.newSubmoduleUrl && file.oldSubmoduleUrl !== file.newSubmoduleUrl)) return { status: 'unreviewable', reason: 'submodule_url_changed', path, change: 'gitlink' };
    const pins = [file.oldSha, file.newSha].filter((value) => value !== undefined && value !== null && value !== '');
    if (pins.length === 0 || pins.some((value) => !COMMIT_SHA.test(String(value)))) return { status: 'unreviewable', reason: 'unpinned_submodule', path, change: 'gitlink' };
  }

  const changeStatus = String(file.status || file.changeStatus || '').toLowerCase();
  if ((changeStatus === 'renamed' || file.previousPath || file.previous_path) && !hasMeaningfulPatch(file)) return { status: 'unreviewable', reason: 'rename_only', path, change: 'renamed' };

  const requested = String(file.unitStatus || file.reviewUnitStatus || '').toLowerCase();
  if (requested === 'waived') {
    if (policy.allowWaived === true || policy.allow_waived === true) return { status: 'waived', reason: 'trusted_waiver', path };
    return { status: 'failed', reason: 'waiver_not_trusted', path };
  }
  if (TERMINAL_STATUSES.has(requested)) return { status: requested, path };
  return { status: 'selected', path, ...(gitlink ? { change: 'gitlink' } : changeStatus === 'removed' || file.deleted === true ? { change: 'deleted' } : {}) };
}

function normalizeIdentity(value) {
  const identity = object(value);
  const repository = String(identity.repository || '').trim().toLowerCase();
  const prNumber = Number(identity.prNumber);
  const hashes = ['baseSha', 'headSha', 'configDigest', 'policyDigest', 'diffDigest'];
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new TypeError('review unit identity.repository must be owner/repository');
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new TypeError('review unit identity.prNumber must be a positive integer');
  const normalized = { repository, prNumber };
  for (const field of hashes) {
    const value = String(identity[field] || '').trim().toLowerCase();
    const valid = field.endsWith('Sha') ? COMMIT_SHA.test(value) : /^[a-f0-9]{64}$/u.test(value);
    if (!valid) throw new TypeError(`review unit identity.${field} must be an immutable digest`);
    normalized[field] = value;
  }
  return normalized;
}

function createReviewUnitManifest({ identity, files, trustedRules, policy, now } = {}) {
  const exactIdentity = normalizeIdentity(identity);
  // `policy` is identity metadata only; trusted rules win every executable classification field.
  const trustedPolicy = { ...object(policy), ...object(trustedRules), policyDigest: exactIdentity.policyDigest };
  const sourceFiles = Array.isArray(files) ? files : [];
  const caseCounts = new Map();
  for (const file of sourceFiles) {
    const path = canonicalPath(file?.path);
    if (path) caseCounts.set(path.toLowerCase(), (caseCounts.get(path.toLowerCase()) || 0) + 1);
  }
  const units = sourceFiles.map((file) => {
    let classification = classifyReviewUnitFile(file, trustedPolicy);
    const normalized = canonicalPath(file?.path);
    if (normalized && caseCounts.get(normalized.toLowerCase()) > 1) classification = { status: 'unreviewable', reason: 'case_collision', path: normalized };
    const path = classification.path || displayPath(file?.path);
    const range = normalizedRange(file);
    const idInput = { path: normalized || `invalid/${sha256(path)}`, range, contentDigest: contentDigest(file), blobDigest: blobDigest(file), policyDigest: exactIdentity.policyDigest };
    return Object.freeze({
      id: stableReviewUnitId(idInput),
      path,
      range,
      contentDigest: idInput.contentDigest,
      blobDigest: idInput.blobDigest,
      status: classification.status,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.change ? { change: classification.change } : {}),
      ...(classification.diffChars !== undefined ? { diffChars: classification.diffChars } : {}),
    });
  });
  const statusCounts = Object.fromEntries([...new Set([...TERMINAL_STATUSES, 'selected', 'excluded', 'oversized', 'unreviewable'])]
    .map((status) => [status, units.filter((unit) => unit.status === status).length]));
  const uncovered = units.filter((unit) => !COVERED_STATUSES.has(unit.status));
  const coverage = Object.freeze({
    complete: uncovered.length === 0,
    shipEligible: uncovered.length === 0,
    uncoveredPaths: uncovered.map((unit) => unit.path),
    failedPaths: units.filter((unit) => unit.status === 'failed').map((unit) => unit.path),
  });
  const timestamp = typeof now === 'function' ? now() : now;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    identity: Object.freeze(exactIdentity),
    policyDigest: exactIdentity.policyDigest,
    ...(Number.isFinite(timestamp) ? { createdAt: new Date(timestamp).toISOString() } : {}),
    units: Object.freeze(units),
    coverage,
    summary: Object.freeze({ total: units.length, ...statusCounts, uncovered: uncovered.length, shipEligible: coverage.shipEligible }),
  });
}

module.exports = { SCHEMA_VERSION, createReviewUnitManifest, stableReviewUnitId, classifyReviewUnitFile };
