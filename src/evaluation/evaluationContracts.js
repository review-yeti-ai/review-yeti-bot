'use strict';

const crypto = require('node:crypto');

const EVALUATION_SCHEMA_VERSION = 'review-yeti-evaluation-v1';
const EVALUATOR_VERSION = 'manual-toolkit-v1';
const MODES = new Set(['offline', 'live']);
const STATUSES = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(candidate)));
}

function requiredString(value, name, pattern = null) {
  const normalized = String(value || '').trim();
  if (!normalized || (pattern && !pattern.test(normalized))) throw new Error(`${name} is required`);
  return normalized;
}

function safeIdentifier(value, fallback = 'unknown') {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/iu.test(normalized)) return fallback;
  if (/(?:api[_-]?key|authorization|bearer|password|secret|token|credential)/iu.test(normalized)) return fallback;
  return normalized;
}

function normalizeEvaluationStatus(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[- ]/gu, '_');
  if (normalized === 'PASS' || normalized === 'PASSED' || normalized === 'SHIP') return 'PASS';
  if (normalized === 'FAIL' || normalized === 'FAILED' || normalized === 'ERROR') return 'FAIL';
  if (normalized === 'BLOCK' || normalized === 'BLOCKED' || normalized === 'FIX_FIRST') return 'BLOCKED';
  if (normalized === 'INCONCLUSIVE' || normalized === 'NOT_RUN' || normalized === 'UNAVAILABLE') return 'INCONCLUSIVE';
  return 'INCONCLUSIVE';
}

function normalizeUsage(value) {
  const source = plainObject(value);
  if (!source) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUSD: null };
  const promptTokens = boundedInteger(source.promptTokens, 0, 0, 100_000_000);
  const completionTokens = boundedInteger(source.completionTokens, 0, 0, 100_000_000);
  const totalTokens = promptTokens + completionTokens;
  const costUSD = typeof source.costUSD === 'number' && Number.isFinite(source.costUSD) && source.costUSD >= 0
    ? Number(Math.min(source.costUSD, 1_000_000).toFixed(6))
    : null;
  return { promptTokens, completionTokens, totalTokens, costUSD };
}

function normalizeIdentity(value = {}) {
  const source = plainObject(value) || {};
  return {
    repository: requiredString(source.repository || 'local/repository', 'repository', /^[^/\s]+\/[^/\s]+$/u),
    sourceSha: requiredString(source.sourceSha, 'sourceSha', /^[a-f0-9]{7,64}$/iu).toLowerCase(),
    fixtureId: requiredString(source.fixtureId, 'fixtureId', /^[a-z0-9][a-z0-9._/-]{0,127}$/iu),
    fixtureDigest: requiredString(source.fixtureDigest, 'fixtureDigest', /^[a-f0-9]{64}$/iu).toLowerCase(),
  };
}

function createEvaluationRequest(input = {}) {
  const source = plainObject(input) || {};
  const mode = source.mode === undefined ? 'offline' : String(source.mode).trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error(`unsupported evaluation mode: ${mode}`);
  const identity = normalizeIdentity(source);
  return Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    evaluatorVersion: safeIdentifier(source.evaluatorVersion, EVALUATOR_VERSION),
    mode,
    ...identity,
    fixturePath: source.fixturePath ? String(source.fixturePath) : undefined,
    baselinePath: source.baselinePath ? String(source.baselinePath) : undefined,
    repetitions: boundedInteger(source.repetitions, 1, 1, 10),
    concurrency: boundedInteger(source.concurrency, 1, 1, 8),
    outputDir: source.outputDir ? String(source.outputDir) : undefined,
    requestedAt: source.requestedAt ? new Date(source.requestedAt).toISOString() : new Date().toISOString(),
  });
}

function createEvaluationReceipt(input = {}) {
  const source = plainObject(input) || {};
  const request = createEvaluationRequest(source.request || source);
  const scenarioResults = Array.isArray(source.scenarioResults) ? source.scenarioResults.map((scenario) => ({
    id: safeIdentifier(typeof scenario === 'string' ? scenario : scenario?.id, 'unknown'),
    status: normalizeEvaluationStatus(typeof scenario === 'string' ? 'PASS' : scenario?.status),
    expected: typeof scenario === 'string' || scenario?.expected === undefined ? undefined : normalizeEvaluationStatus(scenario.expected),
    errorClass: typeof scenario === 'string' || !scenario?.errorClass ? undefined : safeIdentifier(scenario.errorClass, 'unknown'),
    latencyMs: typeof scenario === 'string' || !Number.isFinite(Number(scenario?.latencyMs)) ? undefined : Math.max(0, Math.floor(Number(scenario.latencyMs))),
    usage: normalizeUsage(typeof scenario === 'string' ? undefined : scenario?.usage),
  })) : [];
  const status = normalizeEvaluationStatus(source.status || (scenarioResults.length && scenarioResults.every((scenario) => scenario.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE'));
  return Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    evaluatorVersion: request.evaluatorVersion,
    runId: source.runId ? safeIdentifier(source.runId, '') : crypto.randomUUID(),
    status,
    request,
    identity: {
      repository: request.repository,
      sourceSha: request.sourceSha,
      fixtureId: request.fixtureId,
      fixtureDigest: request.fixtureDigest,
    },
    scenarioResults,
    summary: plainObject(source.summary) || {},
    usage: normalizeUsage(source.usage),
    provider: source.provider ? safeIdentifier(source.provider, 'unknown') : undefined,
    model: source.model ? safeIdentifier(source.model, 'unknown') : undefined,
    startedAt: source.startedAt ? new Date(source.startedAt).toISOString() : new Date().toISOString(),
    completedAt: source.completedAt ? new Date(source.completedAt).toISOString() : new Date().toISOString(),
    error: source.error ? safeIdentifier(source.error, 'unknown') : undefined,
  });
}

module.exports = {
  EVALUATION_SCHEMA_VERSION,
  EVALUATOR_VERSION,
  MODES,
  STATUSES,
  createEvaluationRequest,
  createEvaluationReceipt,
  normalizeEvaluationStatus,
  normalizeUsage,
};
