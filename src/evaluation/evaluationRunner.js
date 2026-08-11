'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  createEvaluationRequest,
  createEvaluationReceipt,
  normalizeEvaluationStatus,
  normalizeUsage,
} = require('./evaluationContracts');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadFixture(fixturePath, readFile = fs.readFileSync) {
  const absolutePath = path.resolve(fixturePath);
  const raw = readFile(absolutePath, 'utf8');
  return { absolutePath, raw, matrix: JSON.parse(raw), digest: sha256(raw) };
}

function safeSummary(value) {
  if (!value || typeof value !== 'object') return {};
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return {}; }
}

function resultScenarioRows(result = {}) {
  if (Array.isArray(result.scenarioResults)) return result.scenarioResults;
  if (Array.isArray(result.scenarios)) {
    const failures = new Set(Array.isArray(result.failures) ? result.failures : []);
    return result.scenarios.map((id) => ({ id, status: failures.has(id) ? 'FAIL' : 'PASS' }));
  }
  if (Array.isArray(result.rows)) {
    return result.rows.filter((row) => row?.arm === 'candidate').map((row) => ({
      id: `${row.fixtureId || 'fixture'}-r${row.repetition || 1}`,
      status: row.decision === row.expectedDecision ? 'PASS' : 'FAIL',
      expected: row.expectedDecision,
      latencyMs: row.latencyMs,
      usage: row.usage,
    }));
  }
  return [{ id: 'overall', status: result.status === 'pass' || result.status === 'complete' ? 'PASS' : result.status }];
}

function resultUsage(result = {}) {
  if (result.usage) return normalizeUsage(result.usage);
  const source = result.candidate || result.baseline;
  if (!source) return normalizeUsage();
  return normalizeUsage({
    promptTokens: source.promptTokens,
    completionTokens: source.completionTokens,
    costUSD: source.costUSD,
  });
}

function resultStatus(result = {}, mode) {
  if (mode === 'live') {
    if (result.status !== 'complete') return 'INCONCLUSIVE';
    return result.promotionReady === false ? 'BLOCKED' : 'PASS';
  }
  return normalizeEvaluationStatus(result.status);
}

function receiptFromResult(request, result, options = {}) {
  const scenarioResults = resultScenarioRows(result).map((scenario) => ({
    ...scenario,
    status: normalizeEvaluationStatus(scenario.status),
    expected: scenario.expected === undefined ? undefined : normalizeEvaluationStatus(scenario.expected),
  }));
  const summary = safeSummary(result);
  delete summary.rows;
  return createEvaluationReceipt({
    request,
    status: resultStatus(result, request.mode),
    scenarioResults,
    summary,
    usage: resultUsage(result),
    provider: options.provider || process.env.OPENROUTER_PROVIDER,
    model: options.model || process.env.OPENROUTER_MODEL,
    error: options.error,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
  });
}

async function importScript(scriptPath) {
  return import(pathToFileURL(scriptPath).href);
}

async function defaultOfflineEvaluator(matrix, request) {
  if (matrix?.schemaVersion === 'review-intelligence-eval-v1') {
    const evaluator = await importScript(path.resolve(__dirname, '../../scripts/evaluate-review-intelligence.mjs'));
    const inputs = evaluator.loadOfflineEvaluationInputs(matrix, { root: path.resolve(__dirname, '../..') });
    return evaluator.evaluateOfflinePromotionMatrix(matrix, inputs);
  }
  if (Array.isArray(matrix?.fixtures)) {
    const evaluator = await importScript(path.resolve(__dirname, '../../scripts/evaluate-dependency-investigation.mjs'));
    return evaluator.evaluateDependencyMatrix(matrix);
  }
  if (Array.isArray(matrix?.cases)) {
    const evaluator = await importScript(path.resolve(__dirname, '../../scripts/evaluate-memory-providers.mjs'));
    return evaluator.evaluateCorpus({ providerId: 'fixture', cases: matrix.cases });
  }
  throw new Error('unsupported evaluation fixture schema');
}

async function defaultLiveEvaluator(matrix, request, options = {}) {
  if (!process.env.OPENROUTER_API_KEY && !options.apiKey) {
    return { status: 'not_run', reason: 'provider_unavailable' };
  }
  if (!Array.isArray(matrix?.fixtures)) return { status: 'not_run', reason: 'live_evaluator_unavailable_for_fixture' };
  const evaluator = await importScript(path.resolve(__dirname, '../../scripts/evaluate-dependency-investigation-live.mjs'));
  return evaluator.evaluateLive(matrix, {
    repetitions: request.repetitions,
    concurrency: request.concurrency,
    maxInvestigationTurns: 2,
    modelOptions: {
      apiKey: options.apiKey || process.env.OPENROUTER_API_KEY,
      baseUrl: options.baseUrl || process.env.OPENROUTER_BASE_URL,
      model: options.model || process.env.OPENROUTER_MODEL,
      maxAttempts: 1,
      maxTokens: options.maxTokens || 8192,
      timeoutMs: options.timeoutMs || Number(process.env.OPENROUTER_TIMEOUT_MS || 30_000),
      openRouterPolicy: {
        allowedModels: [],
        fallbackModels: [],
        ignoredProviders: ['deepinfra'],
        providerRouting: { ignore: ['deepinfra'] },
        timeoutMs: options.timeoutMs || Number(process.env.OPENROUTER_TIMEOUT_MS || 30_000),
        stream: false,
      },
    },
  });
}

function metric(summary, name) {
  const value = Number(summary?.[name]);
  return Number.isFinite(value) ? value : null;
}

function compareEvaluationReceipts(baseline, candidate) {
  const failures = [];
  if (!baseline || !candidate) return { status: 'INCONCLUSIVE', failures: ['missing_receipt'], metrics: {} };
  if (baseline.identity?.fixtureDigest !== candidate.identity?.fixtureDigest) failures.push('fixture_mismatch');
  if (baseline.identity?.fixtureId !== candidate.identity?.fixtureId) failures.push('fixture_mismatch');
  if (baseline.status === 'INCONCLUSIVE' || candidate.status === 'INCONCLUSIVE') failures.push('inconclusive_run');
  const baselineSummary = baseline.summary || {};
  const candidateSummary = candidate.summary || {};
  const metrics = {
    baselineAccuracy: metric(baselineSummary, 'expectedDecisionAccuracy'),
    candidateAccuracy: metric(candidateSummary, 'expectedDecisionAccuracy'),
    baselineUnsafeShipRate: metric(baselineSummary, 'unsafeShipRate'),
    candidateUnsafeShipRate: metric(candidateSummary, 'unsafeShipRate'),
    baselineCostUSD: metric(baselineSummary, 'costUSD'),
    candidateCostUSD: metric(candidateSummary, 'costUSD'),
    baselineLatencyMsP95: metric(baselineSummary, 'latencyMsP95'),
    candidateLatencyMsP95: metric(candidateSummary, 'latencyMsP95'),
  };
  if (metrics.candidateUnsafeShipRate !== null && metrics.candidateUnsafeShipRate > 0) failures.push('unsafe_ship');
  if (metrics.baselineAccuracy !== null && metrics.candidateAccuracy !== null && metrics.candidateAccuracy < metrics.baselineAccuracy) failures.push('accuracy_regression');
  if (metrics.baselineCostUSD > 0 && metrics.candidateCostUSD !== null && metrics.candidateCostUSD > metrics.baselineCostUSD * 1.3) failures.push('cost_regression');
  if (metrics.baselineLatencyMsP95 > 0 && metrics.candidateLatencyMsP95 !== null && metrics.candidateLatencyMsP95 > metrics.baselineLatencyMsP95 * 1.5) failures.push('latency_regression');
  if (failures.includes('fixture_mismatch') || failures.includes('inconclusive_run')) return { status: 'INCONCLUSIVE', failures, metrics };
  return { status: failures.length ? 'BLOCKED' : 'PASS', failures, metrics };
}

async function runOfflineEvaluation(input, dependencies = {}) {
  const request = createEvaluationRequest(input);
  const startedAt = new Date().toISOString();
  try {
    const fixture = loadFixture(request.fixturePath, dependencies.readFile || fs.readFileSync);
    const evaluator = dependencies.offlineEvaluator || defaultOfflineEvaluator;
    const result = await evaluator(fixture.matrix, request);
    return receiptFromResult({ ...request, fixtureDigest: fixture.digest, fixtureId: request.fixtureId }, result, { startedAt, completedAt: new Date().toISOString() });
  } catch (error) {
    return createEvaluationReceipt({ request, status: 'FAIL', error: error?.message || 'offline_evaluation_failed', startedAt, completedAt: new Date().toISOString() });
  }
}

async function runLiveEvaluation(input, dependencies = {}) {
  const request = createEvaluationRequest({ ...input, mode: 'live' });
  const startedAt = new Date().toISOString();
  try {
    const fixture = loadFixture(request.fixturePath, dependencies.readFile || fs.readFileSync);
    const evaluator = dependencies.liveEvaluator || defaultLiveEvaluator;
    const result = await evaluator(fixture.matrix, request, dependencies);
    return receiptFromResult({ ...request, fixtureDigest: fixture.digest, fixtureId: request.fixtureId }, result, {
      provider: dependencies.provider,
      model: dependencies.model,
      error: result.status === 'not_run' ? result.reason : undefined,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    return createEvaluationReceipt({ request, status: 'INCONCLUSIVE', error: error?.message || 'live_evaluation_failed', startedAt, completedAt: new Date().toISOString() });
  }
}

async function runEvaluation(input, dependencies = {}) {
  const request = createEvaluationRequest(input);
  return request.mode === 'live' ? runLiveEvaluation(request, dependencies) : runOfflineEvaluation(request, dependencies);
}

module.exports = {
  compareEvaluationReceipts,
  runEvaluation,
  runOfflineEvaluation,
  runLiveEvaluation,
  loadFixture,
};
