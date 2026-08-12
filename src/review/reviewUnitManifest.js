'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');
const { classifyReviewFile, matchReviewGlob } = require('./reviewIgnorePolicy');

const SCHEMA_VERSION = 'review-unit-manifest-v1';
const DISPATCH_PLAN_VERSION = 'review-dispatch-plan-v1';
const DISPATCH_POLICY_VERSION = 'review-dispatch-policy-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/iu;
const TERMINAL_STATUSES = new Set(['completed', 'reused', 'failed', 'waived']);
const COVERED_STATUSES = new Set(['completed', 'reused', 'waived', 'excluded', 'oversized']);
const MODEL_DISPATCH_FIELDS = new Set([
  'assignment', 'assignments', 'bundle', 'bundles', 'file', 'files', 'limit', 'limits',
  'persona', 'personas', 'policy', 'policies', 'route', 'routes', 'rule', 'rules', 'tool',
  'tools', 'unit', 'units', 'waiver', 'waivers',
]);

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

function positivePatternMatches(path, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const normalized = String(pattern || '').trim();
    return normalized && !normalized.startsWith('!') && matchReviewGlob(normalized, path);
  });
}

function patternList(value) {
  return Array.isArray(value) ? value : [];
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

  const generatedPatterns = [...patternList(policy.generatedPatterns), ...patternList(policy.generated_patterns)];
  const vendorPatterns = [...patternList(policy.vendorPatterns), ...patternList(policy.vendor_patterns)];
  const maximum = Number(policy.maxFileDiffChars ?? policy.max_file_diff_chars);
  const configuredPatterns = [...patternList(policy.exclude ?? policy.excludes), ...generatedPatterns, ...vendorPatterns];
  const standardIgnore = classifyReviewFile(file, configuredPatterns, Number.isSafeInteger(maximum) && maximum > 0 ? maximum : undefined);
  if (standardIgnore.kind === 'skipped') {
    const reason = standardIgnore.category === 'configured'
      ? positivePatternMatches(path, vendorPatterns) ? 'vendored'
        : positivePatternMatches(path, generatedPatterns) ? 'generated'
          : 'policy_configured'
      : standardIgnore.category;
    return { status: 'excluded', reason, path, ...(reason === 'binary' ? { change: 'binary' } : {}) };
  }
  if (standardIgnore.kind === 'oversized') return { status: 'oversized', reason: 'per_file_limit', path, diffChars: standardIgnore.diffChars };
  const size = typeof file.patch === 'string' ? file.patch.length : typeof file.content === 'string' ? file.content.length : 0;
  if (Number.isSafeInteger(maximum) && maximum > 0 && size > maximum) return { status: 'oversized', reason: 'per_file_limit', path, diffChars: size };

  const gitlink = isGitlink(file);
  if (gitlink) {
    if (file.submoduleIgnored === true) return { status: 'excluded', reason: 'submodule_ignored', path, change: 'gitlink' };
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deterministicPathKey(path, unitId) {
  const normalized = canonicalPath(path);
  return normalized ? `${normalized.toLowerCase()}\0${normalized}\0${unitId}` : `~\0${String(path || '')}\0${unitId}`;
}

function sourceFileSortKey(file) {
  const path = canonicalPath(file?.path);
  const shown = path || displayPath(file?.path);
  return canonicalJson({
    pathKey: path ? `${path.toLowerCase()}\0${path}` : `~\0${shown}`,
    previousPath: canonicalPath(file?.previousPath ?? file?.previous_path) || '',
    range: normalizedRange(file),
    contentDigest: contentDigest(file),
    blobDigest: blobDigest(file),
  });
}

function rejectModelDispatchOverrides(modelOutput) {
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = String(key).replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase().replace(/_/gu, '');
      const protectedField = [...MODEL_DISPATCH_FIELDS].find((field) => field.replace(/_/gu, '') === normalized);
      if (protectedField) throw new TypeError(`model output may not change ${protectedField}`);
      visit(child);
    }
  };
  visit(modelOutput);
}

function normalizedDispatchPolicy(value) {
  const source = object(value);
  const baseline = object(source.baseline);
  const specialistRules = Array.isArray(source.specialistRules) ? source.specialistRules : [];
  const bundleRules = Array.isArray(source.bundleRules) ? source.bundleRules : [];
  const policy = {
    schemaVersion: source.schemaVersion || DISPATCH_POLICY_VERSION,
    mode: String(source.mode || 'baseline'),
    baseline: {
      persona: String(baseline.persona || 'baseline'),
      ruleId: String(baseline.ruleId || 'core-baseline'),
    },
    specialistRules: specialistRules.map((rule) => ({
      id: String(rule?.id || ''),
      persona: String(rule?.persona || ''),
      paths: Array.isArray(rule?.paths) ? rule.paths.map(String) : [],
      changes: Array.isArray(rule?.changes) ? rule.changes.map((change) => String(change).toLowerCase()) : [],
    })),
    bundleRules: bundleRules.map((rule) => ({
      id: String(rule?.id || ''),
      bundleKey: String(rule?.bundleKey || ''),
      paths: Array.isArray(rule?.paths) ? rule.paths.map(String).sort(compareText) : [],
    })),
  };
  if (policy.schemaVersion !== DISPATCH_POLICY_VERSION) throw new TypeError('trusted dispatch policy schema is invalid');
  if (!['baseline', 'shadow', 'enforce'].includes(policy.mode)) throw new TypeError('trusted dispatch policy mode is invalid');
  if (!policy.baseline.persona || !policy.baseline.ruleId) throw new TypeError('trusted dispatch baseline is invalid');
  if (policy.specialistRules.some((rule) => !rule.id || !rule.persona || rule.paths.length === 0)) {
    throw new TypeError('trusted dispatch specialist rule is invalid');
  }
  if (policy.bundleRules.some((rule) => !rule.id || !rule.bundleKey || rule.paths.length < 2
    || rule.paths.some((path) => !canonicalPath(path) || /[*?\[\]{}]/u.test(path)))) {
    throw new TypeError('trusted dispatch bundle rule must contain an explicit finite exact path set');
  }
  return policy;
}

function stableDispatchUnitId(input = {}) {
  const exactIdentity = normalizeIdentity(input.identity);
  const policyDigest = String(input.policyDigest || exactIdentity.policyDigest).trim().toLowerCase();
  if (policyDigest !== exactIdentity.policyDigest) throw new TypeError('dispatch unit policyDigest must match immutable identity');
  const fileUnitIds = Array.isArray(input.fileUnitIds) ? [...input.fileUnitIds].map(String).sort(compareText) : [];
  if (fileUnitIds.length === 0 || fileUnitIds.some((id) => !/^ru_[a-f0-9]{64}$/u.test(id))) {
    throw new TypeError('dispatch unit requires stable review unit ids');
  }
  const payload = {
    schemaVersion: DISPATCH_PLAN_VERSION,
    identity: exactIdentity,
    policyDigest,
    persona: String(input.persona || ''),
    ruleId: String(input.ruleId || ''),
    bundleKey: input.bundleKey ? String(input.bundleKey) : null,
    status: String(input.status || ''),
    fileUnitIds,
  };
  if (!payload.persona || !payload.ruleId || !payload.status) throw new TypeError('dispatch unit assignment is incomplete');
  return `ru_${sha256(canonicalJson(payload))}`;
}

function manifestDigestPayload(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    identity: manifest.identity,
    policyDigest: manifest.policyDigest,
    units: manifest.units,
    coverage: manifest.coverage,
    summary: manifest.summary,
  };
}

function fileChange(entry) {
  if (entry.unit.change === 'gitlink') return 'gitlink';
  if (entry.unit.change === 'deleted') return 'removed';
  return String(entry.file?.status || entry.file?.changeStatus || 'modified').trim().toLowerCase();
}

function firstSpecialistRule(entry, dispatch) {
  const current = canonicalPath(entry.file?.path);
  const previous = canonicalPath(entry.file?.previousPath ?? entry.file?.previous_path);
  for (const candidatePath of [current, previous]) {
    if (!candidatePath) continue;
    for (const rule of dispatch.specialistRules) {
      const changeMatches = rule.changes.length === 0 || rule.changes.includes(fileChange(entry));
      if (changeMatches && rule.paths.some((pattern) => matchReviewGlob(pattern, candidatePath))) return rule;
    }
  }
  return null;
}

function dispatchUnit({ entries, identity, persona, ruleId, bundleKey }) {
  const orderedEntries = [...entries].sort((left, right) => compareText(deterministicPathKey(left.unit.path, left.unit.id), deterministicPathKey(right.unit.path, right.unit.id)));
  const files = orderedEntries.map((entry) => entry.unit.path);
  const statuses = [...new Set(orderedEntries.map((entry) => entry.unit.status))];
  const status = statuses.length === 1 ? statuses[0] : 'unreviewable';
  const omissionReason = status === 'selected' ? undefined : statuses.length === 1
    ? orderedEntries[0].unit.reason || status
    : 'mixed_unreviewable_bundle';
  return Object.freeze({
    id: stableDispatchUnitId({
      identity,
      policyDigest: identity.policyDigest,
      persona,
      ruleId,
      bundleKey,
      status,
      fileUnitIds: orderedEntries.map((entry) => entry.unit.id),
    }),
    status,
    files: Object.freeze(files),
    persona,
    ruleId,
    ...(bundleKey ? { bundleKey } : {}),
    ...(omissionReason ? { omissionReason } : {}),
  });
}

/**
 * Compiles immutable dispatch assignments from the existing trusted manifest. Model output is
 * accepted only to enforce the negative boundary: it can never route, bundle, waive, or select.
 */
function createReviewDispatchPlan({ identity, files, trustedRules, trustedPolicy, modelOutput } = {}) {
  rejectModelDispatchOverrides(modelOutput);
  const exactIdentity = normalizeIdentity(identity);
  const policy = object(trustedPolicy);
  if (policy.policyDigest !== undefined && String(policy.policyDigest).trim().toLowerCase() !== exactIdentity.policyDigest) {
    throw new TypeError('trusted dispatch policy digest must match immutable identity');
  }
  const dispatch = normalizedDispatchPolicy(policy.dispatch);
  const sourceFiles = Array.isArray(files) ? [...files].sort((left, right) => compareText(sourceFileSortKey(left), sourceFileSortKey(right))) : [];
  const manifest = createReviewUnitManifest({ identity: exactIdentity, files: sourceFiles, trustedRules, policy: trustedRules });
  const entries = manifest.units.map((unit, index) => ({ file: sourceFiles[index], unit }))
    .sort((left, right) => compareText(deterministicPathKey(left.unit.path, left.unit.id), deterministicPathKey(right.unit.path, right.unit.id)));

  const baselineUnits = [];
  const baselineByFileUnitId = new Map();
  const claimed = new Set();
  const selectedByPath = new Map(entries.filter((entry) => entry.unit.status === 'selected' && canonicalPath(entry.unit.path))
    .map((entry) => [canonicalPath(entry.unit.path), entry]));

  for (const rule of dispatch.bundleRules) {
    const members = rule.paths.map((path) => selectedByPath.get(path));
    if (members.some((entry) => !entry) || members.some((entry) => claimed.has(entry.unit.id))) continue;
    const unit = dispatchUnit({ entries: members, identity: exactIdentity, persona: dispatch.baseline.persona, ruleId: rule.id, bundleKey: rule.bundleKey });
    baselineUnits.push(unit);
    for (const entry of members) {
      claimed.add(entry.unit.id);
      baselineByFileUnitId.set(entry.unit.id, unit);
    }
  }

  for (const entry of entries) {
    if (claimed.has(entry.unit.id)) continue;
    const unit = dispatchUnit({ entries: [entry], identity: exactIdentity, persona: dispatch.baseline.persona, ruleId: dispatch.baseline.ruleId });
    baselineUnits.push(unit);
    baselineByFileUnitId.set(entry.unit.id, unit);
  }
  baselineUnits.sort((left, right) => compareText(deterministicPathKey(left.files[0], left.id), deterministicPathKey(right.files[0], right.id)));

  const specialistByFileUnitId = new Map();
  const specialistUnits = [];
  for (const entry of entries) {
    if (entry.unit.status !== 'selected') continue;
    const rule = firstSpecialistRule(entry, dispatch);
    if (!rule) continue;
    const unit = dispatchUnit({ entries: [entry], identity: exactIdentity, persona: rule.persona, ruleId: rule.id });
    specialistByFileUnitId.set(entry.unit.id, unit);
    specialistUnits.push(unit);
  }
  specialistUnits.sort((left, right) => compareText(`${left.persona}\0${left.ruleId}\0${left.files[0]}\0${left.id}`, `${right.persona}\0${right.ruleId}\0${right.files[0]}\0${right.id}`));

  const units = Object.freeze([...baselineUnits, ...specialistUnits]);
  const assignments = Object.freeze(entries.map((entry) => {
    const baselineUnit = baselineByFileUnitId.get(entry.unit.id);
    const specialistUnit = specialistByFileUnitId.get(entry.unit.id);
    return Object.freeze({
      path: entry.unit.path,
      status: entry.unit.status,
      baselineUnitId: baselineUnit.id,
      specialistUnitIds: Object.freeze(specialistUnit ? [specialistUnit.id] : []),
      ruleIds: Object.freeze([baselineUnit.ruleId, ...(specialistUnit ? [specialistUnit.ruleId] : [])]),
      ...(entry.unit.reason ? { omissionReason: entry.unit.reason } : {}),
      ...(entry.unit.change ? { change: entry.unit.change } : {}),
    });
  }));
  const ruleIds = Object.freeze([...new Set(units.map((unit) => unit.ruleId))]);
  const manifestPayload = manifestDigestPayload(manifest);
  const manifestDigest = sha256(canonicalJson(manifestPayload));
  const planPayload = {
    schemaVersion: DISPATCH_PLAN_VERSION,
    identity: exactIdentity,
    policyDigest: exactIdentity.policyDigest,
    policy: dispatch,
    manifest: manifestPayload,
    manifestDigest,
    units,
    assignments,
  };
  return Object.freeze({
    schemaVersion: DISPATCH_PLAN_VERSION,
    identity: Object.freeze(exactIdentity),
    policyDigest: exactIdentity.policyDigest,
    mode: dispatch.mode,
    manifestDigest,
    manifest,
    units,
    assignments,
    ruleIds,
    planDigest: sha256(canonicalJson(planPayload)),
  });
}

module.exports = {
  SCHEMA_VERSION,
  DISPATCH_PLAN_VERSION,
  createReviewUnitManifest,
  createReviewDispatchPlan,
  stableReviewUnitId,
  stableDispatchUnitId,
  classifyReviewUnitFile,
  rejectModelDispatchOverrides,
};
