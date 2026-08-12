'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');

const REVIEW_DISPATCH_SCHEMA_VERSION = 'review-dispatch-run.v1';
const INVESTIGATION_SCHEMA_VERSION = 'review-investigation-summary-v1';
const MANIFEST_SCHEMA_VERSION = 'review-unit-manifest-v1';
const COMMIT_SHA = /^[a-f0-9]{40,64}$/iu;
const DIGEST = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;
const PROVIDER_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const UNIT_ID = /^ru_[a-f0-9]{64}$/u;
const VERDICTS = new Set(['SHIP', 'FIX_FIRST', 'BLOCK', 'NO_VERDICT']);
const REVIEW_STATUSES = new Set(['SHIP', 'FIX_FIRST', 'BLOCK', 'PARTIAL_REVIEW', 'INCOMPLETE_REVIEW']);
const COVERAGE_STATUSES = new Set(['complete', 'partial', 'incomplete', 'unknown']);
const GATE_DECISIONS = new Set(['PASS', 'BLOCKED']);
const MANIFEST_UNIT_STATUSES = new Set(['selected', 'completed', 'reused', 'failed', 'waived', 'excluded', 'oversized', 'unreviewable']);
const MANIFEST_RANGE_SIDES = new Set(['LEFT', 'RIGHT']);
const MANIFEST_SUMMARY_KEYS = new Set([
  'total',
  'selected',
  'completed',
  'reused',
  'failed',
  'waived',
  'excluded',
  'oversized',
  'unreviewable',
  'uncovered',
  'shipEligible',
]);
const STAGE_KEYS = new Set(['dispatch', 'investigation', 'arbitration']);
const STAGE_STATUSES = new Set(['not_run', 'completed', 'partial', 'failed']);
const FORBIDDEN_KEYS = new Set([
  'raw_secret',
  'secret',
  'password',
  'credential',
  'credentials',
  'api_key',
  'authorization',
  'access_token',
  'refresh_token',
  'bearer_token',
  'prompt',
  'raw_prompt',
  'system_prompt',
  'user_prompt',
  'tool_output',
  'source',
  'raw_source',
  'source_text',
  'provider_error',
  'provider_error_payload',
  'error_payload',
  'error_response',
  'raw_error',
  'stack',
  'trace',
  'hidden_reasoning',
  'reasoning',
  'chain_of_thought',
  'thoughts',
]);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function normalizeFieldName(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/gu, '_')
    .toLowerCase();
}

function errorPath(path, suffix) {
  return path ? `${path}.${suffix}` : suffix;
}

function validateAllowedKeys(value, allowedKeys, path, errors) {
  const object = plainObject(value);
  if (!object) {
    errors.push(`${path} must be an object`);
    return null;
  }
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) errors.push(`${errorPath(path, key)} is not allowed`);
  }
  return object;
}

function scanForbiddenFields(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenFields(entry, `${path}[${index}]`, errors));
    return;
  }
  const object = plainObject(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    const currentPath = errorPath(path, key);
    if (FORBIDDEN_KEYS.has(normalizeFieldName(key))) errors.push(`${currentPath} is not allowed`);
    scanForbiddenFields(entry, currentPath, errors);
  }
}

function requiredEnum(value, values, path, errors) {
  if (!values.has(value)) errors.push(`${path} must be one of: ${[...values].join(', ')}`);
}

function requiredBoolean(value, path, errors) {
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
}

function requiredInteger(value, minimum, maximum, path, errors) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${path} must be an integer between ${minimum} and ${maximum}`);
    return false;
  }
  return true;
}

function requiredDigest(value, path, errors) {
  if (!DIGEST.test(String(value || '').trim().toLowerCase())) errors.push(`${path} must be a SHA-256 digest`);
}

function optionalIsoTimestamp(value, path, errors) {
  if (value === undefined) return;
  const timestamp = typeof value === 'string' ? value : '';
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) errors.push(`${path} must be an ISO timestamp`);
}

function normalizeRepository(value) {
  const repository = String(value || '').trim().toLowerCase();
  if (!REPOSITORY.test(repository)) throw new TypeError('identity.repository must be owner/repository');
  return repository;
}

function normalizeCommitSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!COMMIT_SHA.test(sha)) throw new TypeError(`${label} must be a 40-64 character commit SHA`);
  return sha;
}

function normalizeDigest(value, label) {
  const digest = String(value || '').trim().toLowerCase();
  if (!DIGEST.test(digest)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return digest;
}

function normalizeIdentity(value = {}) {
  const source = plainObject(value) || {};
  const prNumber = Number(source.prNumber);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new TypeError('identity.prNumber must be a positive integer');
  return {
    repository: normalizeRepository(source.repository),
    prNumber,
    baseSha: normalizeCommitSha(source.baseSha, 'identity.baseSha'),
    headSha: normalizeCommitSha(source.headSha, 'identity.headSha'),
    configDigest: normalizeDigest(source.configDigest, 'identity.configDigest'),
    policyDigest: normalizeDigest(source.policyDigest, 'identity.policyDigest'),
    diffDigest: normalizeDigest(source.diffDigest, 'identity.diffDigest'),
  };
}

function normalizeUsage(value) {
  const source = plainObject(value);
  if (!source) return undefined;
  const promptTokens = boundedInteger(source.promptTokens, 0, 100_000_000, 'usage.promptTokens');
  const completionTokens = boundedInteger(source.completionTokens, 0, 100_000_000, 'usage.completionTokens');
  const totalTokens = promptTokens + completionTokens;
  const result = { promptTokens, completionTokens, totalTokens };
  if (source.costUSD !== undefined && source.costUSD !== null && source.costUSD !== '') {
    const cost = Number(source.costUSD);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1_000_000) throw new TypeError('usage.costUSD must be a non-negative finite cost');
    result.costUSD = Number(cost.toFixed(6));
  }
  return result;
}

function normalizeStages(value) {
  const source = plainObject(value);
  if (!source) return undefined;
  const keys = Object.keys(source);
  if (!keys.length) return undefined;
  for (const key of keys) {
    if (!STAGE_KEYS.has(key)) throw new TypeError(`stages.${key} is not allowed`);
    if (!STAGE_STATUSES.has(source[key])) throw new TypeError(`stages.${key} must be one of: ${[...STAGE_STATUSES].join(', ')}`);
  }
  return Object.fromEntries(keys.sort().map((key) => [key, source[key]]));
}

function normalizeLatency(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedInteger(value, 0, 86_400_000, 'latencyMs');
}

function normalizeInvestigation(value = {}) {
  const source = plainObject(value) || {};
  if (source.schemaVersion !== INVESTIGATION_SCHEMA_VERSION) {
    throw new TypeError(`investigationSummary.schemaVersion must be ${INVESTIGATION_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    laneCount: boundedInteger(source.laneCount, 0, 256, 'investigationSummary.laneCount'),
    evidenceReceipts: boundedInteger(source.evidenceReceipts, 0, 10_000, 'investigationSummary.evidenceReceipts'),
    complete: source.complete === true,
  };
}

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeMetrics(value = {}) {
  const source = plainObject(value) || {};
  const p0 = boundedInteger(source.p0Count ?? 0, 0, 100_000, 'metrics.p0Count');
  const p1 = boundedInteger(source.p1Count ?? 0, 0, 100_000, 'metrics.p1Count');
  const p2 = boundedInteger(source.p2Count ?? 0, 0, 100_000, 'metrics.p2Count');
  const total = source.totalFindings === undefined
    ? p0 + p1 + p2
    : boundedInteger(source.totalFindings, 0, 100_000, 'metrics.totalFindings');
  if (total !== p0 + p1 + p2) throw new TypeError('metrics.totalFindings must equal the sum of p0Count, p1Count, and p2Count');
  return { total, p0, p1, p2 };
}

function normalizePersonas({ personasCompleted, personasTotal } = {}) {
  const total = boundedInteger(personasTotal, 1, 64, 'personasTotal');
  const completed = boundedInteger(personasCompleted, 0, total, 'personasCompleted');
  return { completed, total };
}

function normalizeManifestUnitRange(value = {}) {
  const source = plainObject(value) || {};
  const side = String(source.side || '').trim().toUpperCase();
  if (!MANIFEST_RANGE_SIDES.has(side)) throw new TypeError('manifest.units[].range.side must be LEFT or RIGHT');
  const start = boundedInteger(source.start, 0, 10_000_000, 'manifest.units[].range.start');
  const end = boundedInteger(source.end, start, 10_000_000, 'manifest.units[].range.end');
  return { side, start, end };
}

function normalizeManifestUnit(value = {}) {
  const source = plainObject(value) || {};
  const path = String(source.path || '').replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
  if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) {
    throw new TypeError('manifest.units[].path must be a canonical relative path');
  }
  const unit = {
    id: String(source.id || '').trim(),
    path,
    range: normalizeManifestUnitRange(source.range),
    contentDigest: normalizeDigest(source.contentDigest, 'manifest.units[].contentDigest'),
    blobDigest: normalizeDigest(source.blobDigest, 'manifest.units[].blobDigest'),
    status: String(source.status || '').trim(),
  };
  if (!UNIT_ID.test(unit.id)) throw new TypeError('manifest.units[].id must be a review unit identifier');
  if (!MANIFEST_UNIT_STATUSES.has(unit.status)) throw new TypeError('manifest.units[].status is not allowlisted');
  if (source.reason !== undefined) unit.reason = String(source.reason).trim();
  if (source.change !== undefined) unit.change = String(source.change).trim();
  if (source.diffChars !== undefined) unit.diffChars = boundedInteger(source.diffChars, 0, 2_000_000, 'manifest.units[].diffChars');
  return unit;
}

function normalizeManifestSummary(value = {}, units, coverage) {
  const source = plainObject(value) || {};
  const summary = {};
  for (const key of MANIFEST_SUMMARY_KEYS) {
    if (key === 'shipEligible') {
      summary[key] = source[key] === undefined ? coverage.shipEligible : Boolean(source[key]);
      continue;
    }
    if (key === 'total') {
      summary[key] = source[key] === undefined ? units.length : boundedInteger(source[key], 0, 100_000, `manifest.summary.${key}`);
      continue;
    }
    if (key === 'uncovered') {
      summary[key] = source[key] === undefined ? coverage.uncovered : boundedInteger(source[key], 0, 100_000, `manifest.summary.${key}`);
      continue;
    }
    if (source[key] !== undefined) summary[key] = boundedInteger(source[key], 0, 100_000, `manifest.summary.${key}`);
  }
  if (summary.total !== units.length) throw new TypeError('manifest.summary.total must equal manifest.units.length');
  if (summary.uncovered !== coverage.uncovered) throw new TypeError('manifest.summary.uncovered must equal manifest.coverage.uncovered');
  return summary;
}

function normalizeManifestCoverage(value = {}, units) {
  const source = plainObject(value) || {};
  const uncoveredPaths = Array.isArray(source.uncoveredPaths) ? source.uncoveredPaths.map((entry) => String(entry).trim()) : [];
  const failedPaths = Array.isArray(source.failedPaths) ? source.failedPaths.map((entry) => String(entry).trim()) : [];
  const uncovered = source.uncovered !== undefined ? boundedInteger(source.uncovered, 0, 100_000, 'manifest.coverage.uncovered') : uncoveredPaths.length;
  return {
    complete: source.complete === true,
    shipEligible: source.shipEligible === true,
    uncoveredPaths,
    failedPaths,
    uncovered,
  };
}

function manifestDigestPayload(manifest) {
  const { digest, ...payload } = manifest;
  return payload;
}

function normalizeManifest(value = {}, expectedIdentity) {
  const source = plainObject(value) || {};
  if (source.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(`manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  const identity = normalizeIdentity(source.identity);
  if (canonicalJson(identity) !== canonicalJson(expectedIdentity)) {
    throw new TypeError('manifest.identity must exactly match receipt identity');
  }
  const units = Array.isArray(source.units) ? source.units.map((unit) => normalizeManifestUnit(unit)) : [];
  const coverage = normalizeManifestCoverage(source.coverage, units);
  const summary = normalizeManifestSummary(source.summary, units, coverage);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    identity,
    policyDigest: normalizeDigest(source.policyDigest || expectedIdentity.policyDigest, 'manifest.policyDigest'),
    ...(source.createdAt ? { createdAt: new Date(source.createdAt).toISOString() } : {}),
    units,
    coverage,
    summary,
    unitsTotal: boundedInteger(source.unitsTotal ?? units.length, 0, 100_000, 'manifest.unitsTotal'),
    unitsEmitted: boundedInteger(source.unitsEmitted ?? units.length, 0, 100_000, 'manifest.unitsEmitted'),
    unitsOmitted: boundedInteger(source.unitsOmitted ?? 0, 0, 100_000, 'manifest.unitsOmitted'),
  };
  if (manifest.unitsTotal !== units.length) throw new TypeError('manifest.unitsTotal must equal manifest.units.length');
  if (manifest.unitsEmitted !== units.length) throw new TypeError('manifest.unitsEmitted must equal manifest.units.length');
  if (manifest.unitsOmitted !== 0) throw new TypeError('manifest.unitsOmitted must be 0 for a complete manifest artifact');
  manifest.digest = source.digest ? normalizeDigest(source.digest, 'manifest.digest') : sha256(canonicalJson(manifestDigestPayload(manifest)));
  if (manifest.digest !== sha256(canonicalJson(manifestDigestPayload(manifest)))) {
    throw new TypeError('manifest.digest must match the complete manifest artifact');
  }
  return manifest;
}

function normalizeProviderReceipts(providerReceiptIds) {
  const ids = Array.isArray(providerReceiptIds)
    ? [...new Set(providerReceiptIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  if (ids.some((value) => !PROVIDER_RECEIPT_ID.test(value))) {
    throw new TypeError('providerReceiptIds must contain only bounded provider receipt identifiers');
  }
  if (!ids.length) return { count: 0, ids: [] };
  const sortedIds = ids.sort();
  const payload = { count: sortedIds.length, ids: sortedIds };
  return { ...payload, digest: sha256(canonicalJson(payload)) };
}

function providerReceiptsDigestPayload(providerReceipts) {
  const { digest, ...payload } = providerReceipts;
  return payload;
}

function buildReviewDispatchReceipt(input = {}) {
  const source = plainObject(input) || {};
  const identity = normalizeIdentity(source.identity);
  const findings = normalizeMetrics(source.metrics);
  const personas = normalizePersonas(source);
  const manifest = normalizeManifest(source.manifest, identity);
  const investigation = normalizeInvestigation(source.investigationSummary);
  const providerReceipts = normalizeProviderReceipts(source.providerReceiptIds);
  const payload = {
    schemaVersion: REVIEW_DISPATCH_SCHEMA_VERSION,
    identity,
    verdict: requiredBuildEnum(source.verdict, VERDICTS, 'verdict'),
    reviewStatus: requiredBuildEnum(source.reviewStatus, REVIEW_STATUSES, 'reviewStatus'),
    coverageStatus: requiredBuildEnum(source.coverageStatus, COVERAGE_STATUSES, 'coverageStatus'),
    gateDecision: requiredBuildEnum(source.gateDecision, GATE_DECISIONS, 'gateDecision'),
    mergeEligible: source.mergeEligible === true,
    findings,
    personas,
    investigation,
    manifest,
    providerReceipts,
    ...(normalizeStages(source.stages) ? { stages: normalizeStages(source.stages) } : {}),
    ...(normalizeUsage(source.usage) ? { usage: normalizeUsage(source.usage) } : {}),
    ...(normalizeLatency(source.latencyMs) !== undefined ? { latencyMs: normalizeLatency(source.latencyMs) } : {}),
  };
  return { ...payload, receiptDigest: sha256(canonicalJson(payload)) };
}

function requiredBuildEnum(value, values, label) {
  const normalized = String(value || '').trim();
  if (!values.has(normalized)) throw new TypeError(`${label} must be one of: ${[...values].join(', ')}`);
  return normalized;
}

function validateIdentity(value, path, errors, expectedIdentity) {
  const object = validateAllowedKeys(value, new Set(['repository', 'prNumber', 'baseSha', 'headSha', 'configDigest', 'policyDigest', 'diffDigest']), path, errors);
  if (!object) return null;
  const repository = String(object.repository || '').trim().toLowerCase();
  if (!REPOSITORY.test(repository)) errors.push(`${path}.repository must be owner/repository`);
  if (!Number.isSafeInteger(object.prNumber) || object.prNumber < 1) errors.push(`${path}.prNumber must be a positive integer`);
  if (!COMMIT_SHA.test(String(object.baseSha || '').trim().toLowerCase())) errors.push(`${path}.baseSha must be a 40-64 character commit SHA`);
  if (!COMMIT_SHA.test(String(object.headSha || '').trim().toLowerCase())) errors.push(`${path}.headSha must be a 40-64 character commit SHA`);
  requiredDigest(object.configDigest, `${path}.configDigest`, errors);
  requiredDigest(object.policyDigest, `${path}.policyDigest`, errors);
  requiredDigest(object.diffDigest, `${path}.diffDigest`, errors);
  const normalized = {
    repository,
    prNumber: object.prNumber,
    baseSha: String(object.baseSha || '').trim().toLowerCase(),
    headSha: String(object.headSha || '').trim().toLowerCase(),
    configDigest: String(object.configDigest || '').trim().toLowerCase(),
    policyDigest: String(object.policyDigest || '').trim().toLowerCase(),
    diffDigest: String(object.diffDigest || '').trim().toLowerCase(),
  };
  if (expectedIdentity) {
    for (const key of Object.keys(expectedIdentity)) {
      if (normalized[key] !== expectedIdentity[key]) errors.push(`${path}.${key} must exactly match expected identity`);
    }
  }
  return normalized;
}

function validateFindings(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['total', 'p0', 'p1', 'p2']), path, errors);
  if (!object) return;
  requiredInteger(object.total, 0, 100_000, `${path}.total`, errors);
  requiredInteger(object.p0, 0, 100_000, `${path}.p0`, errors);
  requiredInteger(object.p1, 0, 100_000, `${path}.p1`, errors);
  requiredInteger(object.p2, 0, 100_000, `${path}.p2`, errors);
  if (Number.isSafeInteger(object.total) && Number.isSafeInteger(object.p0) && Number.isSafeInteger(object.p1) && Number.isSafeInteger(object.p2)
    && object.total !== object.p0 + object.p1 + object.p2) {
    errors.push(`${path}.total must equal p0 + p1 + p2`);
  }
}

function validatePersonas(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['completed', 'total']), path, errors);
  if (!object) return;
  const totalOk = requiredInteger(object.total, 1, 64, `${path}.total`, errors);
  const completedOk = requiredInteger(object.completed, 0, 64, `${path}.completed`, errors);
  if (totalOk && completedOk && object.completed > object.total) errors.push(`${path}.completed must be less than or equal to ${path}.total`);
}

function validateInvestigation(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['schemaVersion', 'laneCount', 'evidenceReceipts', 'complete']), path, errors);
  if (!object) return;
  if (object.schemaVersion !== INVESTIGATION_SCHEMA_VERSION) errors.push(`${path}.schemaVersion must equal ${INVESTIGATION_SCHEMA_VERSION}`);
  requiredInteger(object.laneCount, 0, 256, `${path}.laneCount`, errors);
  requiredInteger(object.evidenceReceipts, 0, 10_000, `${path}.evidenceReceipts`, errors);
  requiredBoolean(object.complete, `${path}.complete`, errors);
}

function validateManifestRange(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['side', 'start', 'end']), path, errors);
  if (!object) return;
  requiredEnum(object.side, MANIFEST_RANGE_SIDES, `${path}.side`, errors);
  const startOk = requiredInteger(object.start, 0, 10_000_000, `${path}.start`, errors);
  const endOk = requiredInteger(object.end, 0, 10_000_000, `${path}.end`, errors);
  if (startOk && endOk && object.end < object.start) errors.push(`${path}.end must be greater than or equal to ${path}.start`);
}

function validateManifestUnit(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['id', 'path', 'range', 'contentDigest', 'blobDigest', 'status', 'reason', 'change', 'diffChars']), path, errors);
  if (!object) return;
  if (!UNIT_ID.test(String(object.id || '').trim())) errors.push(`${path}.id must be a review unit identifier`);
  const itemPath = String(object.path || '').replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
  if (!itemPath || itemPath.startsWith('/') || itemPath.split('/').includes('..') || itemPath.includes('\0')) errors.push(`${path}.path must be a canonical relative path`);
  validateManifestRange(object.range, `${path}.range`, errors);
  requiredDigest(object.contentDigest, `${path}.contentDigest`, errors);
  requiredDigest(object.blobDigest, `${path}.blobDigest`, errors);
  requiredEnum(object.status, MANIFEST_UNIT_STATUSES, `${path}.status`, errors);
  if (object.diffChars !== undefined) requiredInteger(object.diffChars, 0, 2_000_000, `${path}.diffChars`, errors);
}

function validateManifestCoverage(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['complete', 'shipEligible', 'uncoveredPaths', 'failedPaths', 'uncovered']), path, errors);
  if (!object) return;
  requiredBoolean(object.complete, `${path}.complete`, errors);
  requiredBoolean(object.shipEligible, `${path}.shipEligible`, errors);
  if (!Array.isArray(object.uncoveredPaths)) errors.push(`${path}.uncoveredPaths must be an array`);
  if (!Array.isArray(object.failedPaths)) errors.push(`${path}.failedPaths must be an array`);
  if (object.uncovered !== undefined) requiredInteger(object.uncovered, 0, 100_000, `${path}.uncovered`, errors);
}

function validateManifestSummary(value, path, errors) {
  const object = plainObject(value);
  if (!object) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, entry] of Object.entries(object)) {
    if (!MANIFEST_SUMMARY_KEYS.has(key)) {
      errors.push(`${errorPath(path, key)} is not allowed`);
      continue;
    }
    if (key === 'shipEligible') requiredBoolean(entry, errorPath(path, key), errors);
    else requiredInteger(entry, 0, 100_000, errorPath(path, key), errors);
  }
}

function validateManifest(value, path, errors, expectedIdentity) {
  const object = validateAllowedKeys(
    value,
    new Set(['schemaVersion', 'identity', 'policyDigest', 'createdAt', 'units', 'coverage', 'summary', 'unitsTotal', 'unitsEmitted', 'unitsOmitted', 'digest']),
    path,
    errors,
  );
  if (!object) return;
  if (object.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push(`${path}.schemaVersion must equal ${MANIFEST_SCHEMA_VERSION}`);
  const manifestIdentity = validateIdentity(object.identity, `${path}.identity`, errors, expectedIdentity);
  requiredDigest(object.policyDigest, `${path}.policyDigest`, errors);
  optionalIsoTimestamp(object.createdAt, `${path}.createdAt`, errors);
  if (!Array.isArray(object.units)) errors.push(`${path}.units must be an array`);
  else object.units.forEach((unit, index) => validateManifestUnit(unit, `${path}.units[${index}]`, errors));
  validateManifestCoverage(object.coverage, `${path}.coverage`, errors);
  validateManifestSummary(object.summary, `${path}.summary`, errors);
  requiredInteger(object.unitsTotal, 0, 100_000, `${path}.unitsTotal`, errors);
  requiredInteger(object.unitsEmitted, 0, 100_000, `${path}.unitsEmitted`, errors);
  requiredInteger(object.unitsOmitted, 0, 100_000, `${path}.unitsOmitted`, errors);
  requiredDigest(object.digest, `${path}.digest`, errors);
  if (Array.isArray(object.units) && Number.isSafeInteger(object.unitsTotal) && object.unitsTotal !== object.units.length) {
    errors.push(`${path}.unitsTotal must equal ${path}.units.length`);
  }
  if (Array.isArray(object.units) && Number.isSafeInteger(object.unitsEmitted) && object.unitsEmitted !== object.units.length) {
    errors.push(`${path}.unitsEmitted must equal ${path}.units.length`);
  }
  if (object.unitsOmitted !== 0) errors.push(`${path}.unitsOmitted must be 0 for a complete manifest artifact`);
  if (manifestIdentity && plainObject(value) && DIGEST.test(String(object.digest || '').trim().toLowerCase())) {
    const payload = manifestDigestPayload({
      schemaVersion: object.schemaVersion,
      identity: manifestIdentity,
      policyDigest: String(object.policyDigest || '').trim().toLowerCase(),
      ...(object.createdAt ? { createdAt: object.createdAt } : {}),
      units: object.units,
      coverage: object.coverage,
      summary: object.summary,
      unitsTotal: object.unitsTotal,
      unitsEmitted: object.unitsEmitted,
      unitsOmitted: object.unitsOmitted,
    });
    if (sha256(canonicalJson(payload)) !== String(object.digest || '').trim().toLowerCase()) {
      errors.push(`${path}.digest must match the complete manifest artifact`);
    }
  }
}

function validateProviderReceipts(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['count', 'ids', 'digest']), path, errors);
  if (!object) return;
  requiredInteger(object.count, 0, 1_000, `${path}.count`, errors);
  if (!Array.isArray(object.ids)) errors.push(`${path}.ids must be an array`);
  else if (object.ids.some((entry) => !PROVIDER_RECEIPT_ID.test(String(entry || '').trim()))) errors.push(`${path}.ids must contain only bounded provider receipt identifiers`);
  if (object.count === 0) {
    if (object.digest !== undefined) errors.push(`${path}.digest must be omitted when no provider receipt ids exist`);
  } else {
    requiredDigest(object.digest, `${path}.digest`, errors);
    if (Array.isArray(object.ids) && Number.isSafeInteger(object.count) && object.count !== object.ids.length) {
      errors.push(`${path}.count must equal ${path}.ids.length`);
    }
    if (Array.isArray(object.ids) && DIGEST.test(String(object.digest || '').trim().toLowerCase())) {
      const ids = [...object.ids].map((entry) => String(entry).trim()).sort();
      const payload = providerReceiptsDigestPayload({ count: object.count, ids, digest: object.digest });
      if (sha256(canonicalJson(payload)) !== String(object.digest || '').trim().toLowerCase()) {
        errors.push(`${path}.digest must match the provider receipt id set`);
      }
    }
  }
}

function validateStages(value, path, errors) {
  const object = validateAllowedKeys(value, STAGE_KEYS, path, errors);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) requiredEnum(entry, STAGE_STATUSES, `${path}.${key}`, errors);
}

function validateUsage(value, path, errors) {
  const object = validateAllowedKeys(value, new Set(['promptTokens', 'completionTokens', 'totalTokens', 'costUSD']), path, errors);
  if (!object) return;
  const promptOk = requiredInteger(object.promptTokens, 0, 100_000_000, `${path}.promptTokens`, errors);
  const completionOk = requiredInteger(object.completionTokens, 0, 100_000_000, `${path}.completionTokens`, errors);
  const totalOk = requiredInteger(object.totalTokens, 0, 100_000_000, `${path}.totalTokens`, errors);
  if (object.costUSD !== undefined && (!Number.isFinite(object.costUSD) || object.costUSD < 0 || object.costUSD > 1_000_000)) {
    errors.push(`${path}.costUSD must be a non-negative finite cost`);
  }
  if (promptOk && completionOk && totalOk && object.totalTokens !== object.promptTokens + object.completionTokens) {
    errors.push(`${path}.totalTokens must equal promptTokens + completionTokens`);
  }
}

function validateReviewDispatchReceipt(receipt, expectedIdentityInput) {
  const errors = [];
  const object = plainObject(receipt);
  if (!object) return { valid: false, errors: ['receipt must be an object'] };
  scanForbiddenFields(object, '', errors);
  validateAllowedKeys(
    object,
    new Set(['schemaVersion', 'identity', 'verdict', 'reviewStatus', 'coverageStatus', 'gateDecision', 'mergeEligible', 'findings', 'personas', 'investigation', 'manifest', 'providerReceipts', 'stages', 'usage', 'latencyMs', 'receiptDigest']),
    'receipt',
    errors,
  );
  if (object.schemaVersion !== REVIEW_DISPATCH_SCHEMA_VERSION) errors.push(`schemaVersion must equal ${REVIEW_DISPATCH_SCHEMA_VERSION}`);
  const expectedIdentity = expectedIdentityInput ? normalizeIdentity(expectedIdentityInput) : null;
  const identity = object.identity === undefined
    ? (errors.push('identity is required'), null)
    : validateIdentity(object.identity, 'identity', errors, expectedIdentity);
  requiredEnum(object.verdict, VERDICTS, 'verdict', errors);
  requiredEnum(object.reviewStatus, REVIEW_STATUSES, 'reviewStatus', errors);
  requiredEnum(object.coverageStatus, COVERAGE_STATUSES, 'coverageStatus', errors);
  requiredEnum(object.gateDecision, GATE_DECISIONS, 'gateDecision', errors);
  requiredBoolean(object.mergeEligible, 'mergeEligible', errors);
  validateFindings(object.findings, 'findings', errors);
  validatePersonas(object.personas, 'personas', errors);
  validateInvestigation(object.investigation, 'investigation', errors);
  validateManifest(object.manifest, 'manifest', errors, identity);
  validateProviderReceipts(object.providerReceipts, 'providerReceipts', errors);
  if (object.stages !== undefined) validateStages(object.stages, 'stages', errors);
  if (object.usage !== undefined) validateUsage(object.usage, 'usage', errors);
  if (object.latencyMs !== undefined) requiredInteger(object.latencyMs, 0, 86_400_000, 'latencyMs', errors);
  requiredDigest(object.receiptDigest, 'receiptDigest', errors);
  if (!errors.length) {
    const { receiptDigest, ...payload } = object;
    if (sha256(canonicalJson(payload)) !== String(receiptDigest || '').trim().toLowerCase()) {
      errors.push('receiptDigest must match the review dispatch receipt payload');
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REVIEW_DISPATCH_SCHEMA_VERSION,
  INVESTIGATION_SCHEMA_VERSION,
  buildReviewDispatchReceipt,
  validateReviewDispatchReceipt,
};
