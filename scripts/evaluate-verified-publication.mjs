#!/usr/bin/env node
/**
 * Three-arm verified-publication evaluation over the verified-publication fixture corpus.
 *
 *   baseline  — the frozen pre-depth-probe testing charter, production lane path (live lanes).
 *   candidate — the current testing charter, production lane path (live lanes).
 *   verified  — the SAME candidate lane rows, with the independent falsification stage
 *               (src/review/findingFalsification.js) applied to each row's findings before
 *               grading. Only CONFIRM survives; REFUTE and ABSTAIN withhold.
 *
 * The verified arm is deliberately paired with the candidate arm rather than re-running lanes:
 * the product stage runs on lane outputs, not on fresh lanes, and pairing measures the
 * verifier's marginal effect on identical hypotheses instead of burying it in lane variance.
 *
 * Grading stays structural (expectedPaths + mustMatch concept groups) — no LLM grades an LLM
 * anywhere in this harness. The falsification stage is a product stage; its model calls are the
 * thing under measurement, not the measurement itself.
 *
 * Provenance note (2026-08-21 refit): this harness originally rode on the bounded-investigation
 * testing-charter harness (scripts/evaluate-testing-charter.mjs at 70bc8a6) and its fixtures at
 * tests/fixtures/testing-charter/. That subsystem was retired on main along with
 * openRouterPolicy.js (and its HARD_BANNED_PROVIDER_SLUGS ignore-list, superseded by central
 * transport failover — PRs #217/#218). Lanes now run the production reviewWithModel path from
 * the current pipeline; the summarizeArm/summarizePerFixture reporting shapes and the fixture
 * corpus are vendored here (fixtures relocated to eval-baselines/verified-publication-fixtures/)
 * so the harness is self-contained. TTFT columns from the retired harness are dropped rather
 * than reported as nulls: the refit lane path does not measure them.
 *
 * Offline by default: without a configured provider transport, `lanes` and `verify` exit 0
 * with not_run.
 *
 * Usage (each phase is a separate bounded invocation so shards stay under CI/agent timeouts):
 *   node scripts/evaluate-verified-publication.mjs lanes --arm baseline --fixtures <id,...> --out out/b1.json
 *   node scripts/evaluate-verified-publication.mjs lanes --arm candidate --fixtures <id,...> --out out/c1.json
 *   node scripts/evaluate-verified-publication.mjs verify --lanes out/c1.json,out/c2.json --out out/verified.json
 *   node scripts/evaluate-verified-publication.mjs report --rows out/b1.json,out/c1.json,out/verified.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { runFindingFalsification } = require(path.join(root, 'src/review/findingFalsification.js'));

const DEFAULT_FIXTURE = 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json';
const DEFAULT_BASELINE_CHARTER = 'eval-baselines/verified-publication-fixtures/baseline-charter.txt';

function argument(name, fallback, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

/**
 * Same structural detection contract as the retired testing-charter harness (anchor to an
 * expected path AND satisfy every mustMatch concept group). The shapes are pinned by
 * tests/unit/verifiedPublicationEval.test.ts so drift breaks red.
 */
export function findingMatchesFixture(finding, fixture) {
  const anchored = fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected));
  if (!anchored) return false;
  const text = [finding.title, finding.body, finding.suggestion].filter(Boolean).join('\n').toLowerCase();
  return fixture.mustMatch.every((group) => group.some((token) => text.includes(token)));
}

function findingAnchors(finding, fixture) {
  return fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected));
}

export function gradeFindings(fixture, findings, errored) {
  // Same hit / valid_suggestion / noise labels the retired harness's classifyFindings assigned,
  // so a re-graded verified row replaces (never inherits) its candidate row's SNR inputs.
  const classifications = errored ? [] : findings.map((finding) => {
    if (fixture.category === 'clean') return 'noise';
    if (findingMatchesFixture(finding, fixture)) return 'hit';
    if (findingAnchors(finding, fixture)) return 'valid_suggestion';
    return 'noise';
  });
  const counts = {
    hits: classifications.filter((label) => label === 'hit').length,
    validSuggestions: classifications.filter((label) => label === 'valid_suggestion').length,
    noise: classifications.filter((label) => label === 'noise').length,
  };
  if (fixture.category === 'clean') {
    return { errored, falsePositive: !errored && findings.length > 0, detected: false, anchored: false, findings: findings.length, ...counts };
  }
  return {
    errored,
    falsePositive: false,
    detected: !errored && findings.some((finding) => findingMatchesFixture(finding, fixture)),
    anchored: !errored && findings.some((finding) => findingAnchors(finding, fixture)),
    findings: findings.length,
    ...counts,
  };
}

const TELEMETRY_LABEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/iu;
const TELEMETRY_RESERVED_LABELS = new Set(['__proto__', 'constructor', 'prototype']);
const TELEMETRY_ENUMS = Object.freeze({
  outputShape: new Set(['direct_json_object', 'direct_json_array', 'fenced_json_object', 'fenced_json_array', 'embedded_json_object', 'valid_json_wrong_shape', 'truncated_json', 'no_json', 'empty_content']),
  finishReason: new Set(['stop', 'length', 'content_filter', 'tool_calls', 'other', 'missing']),
  responseMode: new Set(['stream', 'buffered']),
  findingsSource: new Set(['content', 'reasoning', 'none']),
  contentSizeBucket: new Set(['empty', 'tiny', 'small', 'medium', 'large', 'oversize']),
  reasoningSizeBucket: new Set(['empty', 'tiny', 'small', 'medium', 'large', 'oversize']),
  timeoutKind: new Set(['request', 'ttft', 'inactivity', 'total']),
});
const OUTPUT_CONTRACT_MODES = new Set(['json_object', 'json_schema', 'prompt_validated_json', 'unknown']);
const OUTPUT_CONTRACT_SUPPORT = new Set(['accepted', 'rejected', 'unreported']);
const ATTEMPT_OUTCOMES = new Set(['parsed', 'malformed_output', 'http_error', 'provider_error', 'transport_error']);
// OpenRouter may report the resolved upstream adapter separately from the gateway transport.
// OpenInference is a legitimate response-reported label seen in the retained evaluation
// corpus and must survive the sanitized attempt boundary for attribution checks.
const ATTEMPT_PROVIDERS = new Set(['fireworks', 'ollama', 'openrouter', 'openrouter-fallback', 'openinference', 'anthropic', 'gemini', 'openai', 'default']);
const ATTEMPT_FAILURE_CLASSES = new Set([
  'http_429',
  'http_4xx',
  'http_5xx',
  'timeout',
  'transient_socket',
  'provider_rate_limit',
  'provider_error',
  'malformed_output',
  'unknown',
]);
const ATTEMPT_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'missing', 'other']);
const MAX_RESPONSE_ATTEMPTS = 8;

function safeTelemetryLabel(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!TELEMETRY_LABEL_PATTERN.test(normalized) || TELEMETRY_RESERVED_LABELS.has(normalized)) return null;
  return normalized;
}

function safeBoundedInteger(value, minimum, maximum) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function captureOutputContract(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    policyDeclared: OUTPUT_CONTRACT_MODES.has(value.policyDeclared) ? value.policyDeclared : 'unknown',
    requestObserved: OUTPUT_CONTRACT_MODES.has(value.requestObserved) ? value.requestObserved : 'unknown',
    providerSupported: OUTPUT_CONTRACT_SUPPORT.has(value.providerSupported) ? value.providerSupported : 'unreported',
    terminalParsed: value.terminalParsed === true,
  };
}

function captureResponseAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RESPONSE_ATTEMPTS).map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const attempt = safeBoundedInteger(entry.attempt, 1, 100);
    if (attempt === null || !ATTEMPT_OUTCOMES.has(entry.outcome)) return null;
    const captured = { attempt, outcome: entry.outcome };
    for (const key of ['transport', 'provider']) {
      if (ATTEMPT_PROVIDERS.has(entry[key])) captured[key] = entry[key];
    }
    const latencyMs = safeBoundedInteger(entry.latencyMs, 0, 86_400_000);
    if (latencyMs !== null) captured.latencyMs = latencyMs;
    const responseStatus = safeBoundedInteger(entry.responseStatus, 100, 599);
    if (responseStatus !== null) captured.responseStatus = responseStatus;
    if (ATTEMPT_FAILURE_CLASSES.has(entry.failureClass)) captured.failureClass = entry.failureClass;
    if (ATTEMPT_REASONING_EFFORTS.has(entry.reasoningEffort)) captured.reasoningEffort = entry.reasoningEffort;
    for (const key of ['maxOutputTokens', 'outputTokens']) {
      const tokens = safeBoundedInteger(entry[key], 0, 1_000_000);
      if (tokens !== null) captured[key] = tokens;
    }
    for (const [key, allowedValues] of Object.entries(TELEMETRY_ENUMS)) {
      if (allowedValues.has(entry[key])) captured[key] = entry[key];
    }
    for (const key of ['contentPresent', 'reasoningPresent']) {
      if (typeof entry[key] === 'boolean') captured[key] = entry[key];
    }
    const outputContract = captureOutputContract(entry.outputContract);
    if (outputContract) captured.outputContract = outputContract;
    return captured;
  }).filter(Boolean);
}

/**
 * Retain only bounded, schema-shaped lane telemetry for offline qualification artifacts.
 * Provider response bodies and exception text stay in the lane runner only; this output is
 * consumed by the central qualification receipt, which aggregates it again before publication.
 */
export function captureLaneTelemetry(result = {}) {
  const telemetry = {};
  for (const key of ['provider', 'transport', 'failureClass', 'errorCode']) {
    const value = safeTelemetryLabel(result[key]);
    if (value) telemetry[key] = value;
  }
  const responseStatus = Number(result.responseStatus);
  if (Number.isInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599) {
    telemetry.responseStatus = responseStatus;
  }
  const attemptCount = Number(result.attemptCount);
  if (Number.isInteger(attemptCount) && attemptCount >= 0 && attemptCount <= 100) {
    telemetry.attemptCount = attemptCount;
  }
  if (Array.isArray(result.retryReasons)) {
    const retryReasons = result.retryReasons.map(safeTelemetryLabel).filter(Boolean).slice(0, 8);
    if (retryReasons.length > 0) telemetry.retryReasons = retryReasons;
  }
  for (const [key, allowedValues] of Object.entries(TELEMETRY_ENUMS)) {
    if (allowedValues.has(result[key])) telemetry[key] = result[key];
  }
  for (const key of ['contentPresent', 'reasoningPresent']) {
    if (typeof result[key] === 'boolean') telemetry[key] = result[key];
  }
  const outputContract = captureOutputContract(result.outputContract);
  if (outputContract) telemetry.outputContract = outputContract;
  const responseAttempts = captureResponseAttempts(result.responseAttempts);
  if (responseAttempts.length > 0) telemetry.responseAttempts = responseAttempts;
  return telemetry;
}

/** Wilson 95% interval, matching the retired harness's own reporting. */
export function wilson(hits, total) {
  if (!total) return null;
  const z = 1.96;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Number(Math.max(0, centre - spread).toFixed(4)), Number(Math.min(1, centre + spread).toFixed(4))];
}

// ---------------------------------------------------------------------------
// Reporting shapes vendored from the retired testing-charter harness (70bc8a6),
// minus the TTFT columns the refit lane path does not measure.
// ---------------------------------------------------------------------------

function rate(hits, total) {
  return total ? Number((hits / total).toFixed(4)) : null;
}

function numericSeries(rows, key) {
  return rows.map((row) => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
}

function median(sorted) {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function p95(sorted) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
}

/**
 * CR-Bench's signal-to-noise ratio: (hits + valid suggestions) / noise. `noise` counting zero
 * with nonzero signal is a real "no noise observed" result (`ratio: null, unbounded: true`);
 * zero signal and zero noise is genuinely not computable (`ratio: null, unbounded: false`).
 */
function signalToNoiseRatio(hits, validSuggestions, noise) {
  const signal = hits + validSuggestions;
  if (noise === 0) return { ratio: null, unbounded: signal > 0 };
  return { ratio: Number((signal / noise).toFixed(3)), unbounded: false };
}

export function resolveEvalMaxTokens({ argv = process.argv, bounded = false, fallback = 4_096 } = {}) {
  const index = argv.indexOf('--max-tokens');
  const explicit = index >= 0 && argv[index + 1] !== undefined;
  if (bounded && !explicit) return undefined;
  const parsed = explicit ? Number(argv[index + 1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function summarizeArm(rows, armId) {
  const selected = rows.filter((row) => row.arm === armId);
  const defects = selected.filter((row) => row.category === 'defect');
  const clean = selected.filter((row) => row.category === 'clean');
  const usage = selected.reduce((total, row) => ({
    promptTokens: total.promptTokens + Number(row.usage?.promptTokens || 0),
    completionTokens: total.completionTokens + Number(row.usage?.completionTokens || 0),
    costUSD: total.costUSD + Number(row.usage?.costUSD || 0),
  }), { promptTokens: 0, completionTokens: 0, costUSD: 0 });
  const latencies = numericSeries(selected, 'latencyMs');
  const detectedCount = defects.filter((row) => row.detected).length;
  const totalHits = selected.reduce((sum, row) => sum + Number(row.hits || 0), 0);
  const totalValidSuggestions = selected.reduce((sum, row) => sum + Number(row.validSuggestions || 0), 0);
  const totalNoise = selected.reduce((sum, row) => sum + Number(row.noise || 0), 0);
  const snr = signalToNoiseRatio(totalHits, totalValidSuggestions, totalNoise);
  const failureClasses = {};
  for (const row of selected) {
    if (!row.errored) continue;
    const label = row.error || 'unknown';
    failureClasses[label] = (failureClasses[label] || 0) + 1;
  }
  return {
    arm: armId,
    runs: selected.length,
    erroredRuns: selected.filter((row) => row.errored).length,
    failureClasses,
    defectRuns: defects.length,
    detected: detectedCount,
    detectionRate: rate(detectedCount, defects.length),
    detectionRate95: wilson(detectedCount, defects.length),
    anchoredRate: rate(defects.filter((row) => row.anchored).length, defects.length),
    cleanRuns: clean.length,
    falsePositives: clean.filter((row) => row.falsePositive).length,
    falsePositiveRate: rate(clean.filter((row) => row.falsePositive).length, clean.length),
    findingsPerRun: selected.length ? Number((selected.reduce((sum, row) => sum + row.findings, 0) / selected.length).toFixed(3)) : null,
    // The ≤3-findings output contract is a hard rule; a charter change that breaks it is a
    // regression regardless of what it does to detection.
    outputContractBreaches: selected.filter((row) => row.findings > 3).length,
    hits: totalHits,
    validSuggestions: totalValidSuggestions,
    noise: totalNoise,
    // Classic precision (hits / (hits + noise)): valid suggestions are neither counted for nor
    // against it -- they are not the target defect, but they are not wrong, either.
    precision: rate(totalHits, totalHits + totalNoise),
    snr: snr.ratio,
    snrUnbounded: snr.unbounded,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUSD: Number(usage.costUSD.toFixed(6)),
    latencyMsMedian: median(latencies),
    latencyMsP95: p95(latencies),
  };
}

export function summarizePerFixture(rows, fixtures) {
  return fixtures.map((fixture) => {
    const row = (armId) => {
      const selected = rows.filter((entry) => entry.arm === armId && entry.fixtureId === fixture.id);
      const hits = fixture.category === 'clean'
        ? selected.filter((entry) => entry.falsePositive).length
        : selected.filter((entry) => entry.detected).length;
      return { hits, runs: selected.length, rate: rate(hits, selected.length), interval: wilson(hits, selected.length) };
    };
    return { id: fixture.id, category: fixture.category, baseline: row('baseline'), candidate: row('candidate') };
  });
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function loadMatrix(argv = process.argv) {
  const fixturePath = path.resolve(root, argument('--fixture', DEFAULT_FIXTURE, argv));
  const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const only = String(argument('--fixtures', '', argv)).split(',').map((token) => token.trim()).filter(Boolean);
  if (only.length > 0) matrix.fixtures = matrix.fixtures.filter((fixture) => only.includes(fixture.id));
  return { matrix, fixturePath };
}

export function buildModelOptions(argv = process.argv) {
  const model = argument('--model', process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731', argv);
  const maxTokens = resolveEvalMaxTokens({ argv, bounded: true, fallback: 4_096 });
  const configuredTransports = pipeline.resolveModelConfig().transports;
  // Scenario evaluation may deliberately request a larger provider/context envelope than the
  // production policy. Apply an explicit --max-tokens override to every admitted transport so a
  // central handoff's production default cannot silently cap the experiment. The evaluator still
  // owns its hard child deadline; this is not a production routing or timeout override.
  const transports = maxTokens === undefined
    ? configuredTransports
    : configuredTransports.map((transport) => ({
        ...transport,
        maxTokens,
      }));
  return {
    model,
    // The production reviewWithModel boundary only consumes an explicit options.transports
    // handoff. Preserve the central env-resolved plan here; otherwise qualification silently
    // collapses to the first transport as an unnamed buffered "default" request.
    transports,
    // 300s, not the pipeline's 90s transport default: lanes here are buffered (non-streaming)
    // single fetches against a reasoning model whose median full-review completion is ~65-75s
    // with a long tail. Measured 2026-08-21: a 90s cap converted 28-30 of 72 rows per arm into
    // timeout errors -- a harness artifact, not provider weather. Overridable via --timeout-ms.
    timeoutMs: Number(argument('--timeout-ms', 300_000, argv)),
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    // Provider routing note: the retired harness pinned an OpenRouter ignore-list
    // (HARD_BANNED_PROVIDER_SLUGS, retired with openRouterPolicy.js). The current pipeline
    // owns provider failover centrally (dead-provider failover + policy-safe format recovery,
    // PRs #217/#218), so lanes and verifier calls defer to production transport policy here.
  };
}

function rowUsage(result) {
  const cost = Number(result?.cost);
  return {
    promptTokens: Number(result?.inputTokens || 0),
    completionTokens: Number(result?.outputTokens || 0),
    ...(Number.isFinite(cost) ? { costUSD: cost } : {}),
  };
}

function transportsConfigured(env = process.env) {
  try {
    return Boolean(pipeline.resolveModelConfig(env).enabled);
  } catch {
    return false;
  }
}

/**
 * Phase 1: live lanes for one arm over the production lane path (pipeline.reviewWithModel),
 * capturing FULL findings per row in `findingsDetail`.
 */
export async function runLanesArm({ matrix, armId, charter, persona, repetitions, concurrency, modelOptions, reviewImplementation = pipeline.reviewWithModel }) {
  const fixtures = Array.isArray(matrix?.fixtures) ? matrix.fixtures : [];
  if (!fixtures.length) throw new Error('verified-publication matrix contains no fixtures');
  const jobs = [];
  for (const fixture of fixtures) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) jobs.push({ fixture, repetition });
  }
  const rows = await pipeline.mapWithConcurrency(jobs, concurrency, async ({ fixture, repetition }) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await reviewImplementation(
        { ...persona, charter },
        fixture.files,
        { repo: 'review-yeti-ai/review-yeti-bot', prNumber: `testing-charter-${armId}-${repetition}-${fixture.id}`, title: fixture.title },
        null,
        modelOptions,
      );
    } catch (error) {
      result = { decision: 'ERROR', error: error?.message || 'call_failed', findings: [] };
    }
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    const errored = result?.decision === 'ERROR';
    const graded = gradeFindings(fixture, findings, errored);
    return {
      arm: armId,
      fixtureId: fixture.id,
      category: fixture.category,
      repetition,
      latencyMs: Date.now() - startedAt,
      usage: rowUsage(result),
      error: result?.error,
      model: result?.model,
      ...captureLaneTelemetry(result),
      ...graded,
      findingTitles: findings.map((finding) => `${finding.path}:${finding.line} ${finding.title}`),
      findingsDetail: findings,
    };
  });
  return { fixtures, rows };
}

/**
 * Phase 2: apply the falsification stage to captured candidate rows. Errored lane rows pass
 * through unchanged (the verifier never runs on a lane that produced nothing); rows with
 * findings get live verifier calls and are re-graded on the confirmed subset only.
 */
export async function verifyCandidateRows({ rows, matrix, falsifyTurnFactory, armId = 'verified', concurrency = 3 }) {
  const fixturesById = new Map(matrix.fixtures.map((fixture) => [fixture.id, fixture]));
  const verifiedRows = [];
  const verifierStats = { rowsVerified: 0, hypotheses: 0, confirmed: 0, refuted: 0, abstained: 0, unavailable: 0, timedOut: 0, budgetExhausted: 0, neverVerified: 0, verifierLatencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, costUSD: 0 } };
  const perRowOutcomes = [];
  for (const row of rows) {
    const fixture = fixturesById.get(row.fixtureId);
    if (!fixture) continue;
    const findings = Array.isArray(row.findingsDetail) ? row.findingsDetail : [];
    let confirmedFindings = [];
    let verifierLatencyMs = 0;
    let verifierUsage = null;
    let outcomes = [];
    if (!row.errored && findings.length > 0) {
      const startedAt = Date.now();
      const result = await runFindingFalsification({
        findings,
        changedFiles: fixture.files,
        limits: { concurrency },
        falsifyTurn: falsifyTurnFactory({ row, fixture }),
      });
      verifierLatencyMs = Date.now() - startedAt;
      outcomes = result.outcomes.map((entry) => ({ verdict: entry.verdict, reason: entry.reason }));
      confirmedFindings = findings.filter((_finding, index) => result.outcomes[index]?.verdict === 'CONFIRM');
      verifierUsage = result.receipt.usage;
      verifierStats.rowsVerified += 1;
      verifierStats.hypotheses += findings.length;
      verifierStats.confirmed += result.receipt.summary.confirmed;
      verifierStats.refuted += result.receipt.summary.refuted;
      verifierStats.abstained += result.receipt.summary.abstained;
      verifierStats.unavailable += result.receipt.summary.unavailable;
      verifierStats.timedOut += result.receipt.summary.timedOut;
      verifierStats.budgetExhausted += result.receipt.summary.budgetExhausted;
      verifierStats.neverVerified += result.receipt.summary.neverVerified;
      verifierStats.verifierLatencyMs += verifierLatencyMs;
      verifierStats.usage.promptTokens += Number(verifierUsage.promptTokens || 0);
      verifierStats.usage.completionTokens += Number(verifierUsage.completionTokens || 0);
      verifierStats.usage.costUSD += Number(verifierUsage.costUSD || 0);
    }
    const graded = gradeFindings(fixture, confirmedFindings, Boolean(row.errored));
    perRowOutcomes.push({ fixtureId: row.fixtureId, repetition: row.repetition, outcomes });
    verifiedRows.push({
      ...row,
      arm: armId,
      ...graded,
      latencyMs: Number(row.latencyMs || 0) + verifierLatencyMs,
      usage: {
        promptTokens: Number(row.usage?.promptTokens || 0) + Number(verifierUsage?.promptTokens || 0),
        completionTokens: Number(row.usage?.completionTokens || 0) + Number(verifierUsage?.completionTokens || 0),
        costUSD: Number(row.usage?.costUSD || 0) + Number(verifierUsage?.costUSD || 0),
      },
      findingTitles: confirmedFindings.map((finding) => `${finding.path}:${finding.line} ${finding.title}`),
      findingsDetail: confirmedFindings,
      verifierLatencyMs,
    });
  }
  return { rows: verifiedRows, verifierStats, perRowOutcomes };
}

export function buildFalsifyTurnFactory({ modelOptions }) {
  return () => async ({ messages, timeoutMs, signal }) =>
    pipeline.callFalsificationModelTurn({ messages, timeoutMs, signal }, modelOptions);
}

function readShards(listArgument) {
  return String(listArgument || '').split(',').map((token) => token.trim()).filter(Boolean)
    .flatMap((shard) => {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(root, shard), 'utf8'));
      return Array.isArray(parsed.rows) ? parsed.rows : [];
    });
}

function armReport(rows, armId) {
  const summary = summarizeArm(rows, armId);
  const clean = rows.filter((row) => row.arm === armId && row.category === 'clean');
  return {
    ...summary,
    falsePositiveRate95: wilson(clean.filter((row) => row.falsePositive).length, clean.length),
  };
}

async function main() {
  const command = process.argv[2];
  const { matrix, fixturePath } = loadMatrix();
  const outPath = argument('--out', '');
  if (command === 'lanes') {
    if (!transportsConfigured()) {
      console.log(JSON.stringify({ status: 'not_run', reason: 'provider_unavailable' }));
      return 0;
    }
    const armId = argument('--arm', 'candidate');
    const persona = pipeline.PERSONA_CHARTERS.find((entry) => entry.id === (matrix.personaId || 'testing'));
    if (!persona) throw new Error(`persona ${matrix.personaId} is not configured`);
    const charter = armId === 'baseline'
      ? fs.readFileSync(path.resolve(root, argument('--baseline-charter', DEFAULT_BASELINE_CHARTER)), 'utf8').trimEnd()
      : persona.charter;
    const { rows } = await runLanesArm({
      matrix,
      armId,
      charter,
      persona,
      repetitions: Number(argument('--repetitions', matrix.repetitions || 8)),
      concurrency: Number(argument('--concurrency', 6)),
      modelOptions: buildModelOptions(),
    });
    const payload = { schemaVersion: 'verified-publication-lanes-v1', arm: armId, fixture: path.relative(root, fixturePath), rows };
    if (outPath) fs.writeFileSync(path.resolve(root, outPath), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ arm: armId, rows: rows.length, errored: rows.filter((row) => row.errored).length }));
    return 0;
  }
  if (command === 'verify') {
    if (!transportsConfigured()) {
      console.log(JSON.stringify({ status: 'not_run', reason: 'provider_unavailable' }));
      return 0;
    }
    const laneRows = readShards(argument('--lanes', ''));
    const { rows, verifierStats, perRowOutcomes } = await verifyCandidateRows({
      rows: laneRows,
      matrix,
      concurrency: Number(argument('--verifier-concurrency', 3)),
      falsifyTurnFactory: buildFalsifyTurnFactory({ modelOptions: buildModelOptions() }),
    });
    const payload = { schemaVersion: 'verified-publication-verify-v1', arm: 'verified', rows, verifierStats, perRowOutcomes };
    if (outPath) fs.writeFileSync(path.resolve(root, outPath), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ rows: rows.length, verifierStats }));
    return 0;
  }
  if (command === 'report') {
    const shardPaths = String(argument('--rows', '')).split(',').map((token) => token.trim()).filter(Boolean);
    const rows = readShards(argument('--rows', ''));
    const arms = [...new Set(rows.map((row) => row.arm))];
    // Carry per-hypothesis verdicts and verifier stats from verify shards into the committed
    // artifact: the 2026-08-21 report dropped them, and the timeout-vs-refute attribution had
    // to be reconstructed from latency fingerprints. Never again.
    const verifierStats = [];
    const perRowOutcomes = [];
    for (const shard of shardPaths) {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(root, shard), 'utf8'));
      if (parsed.verifierStats) verifierStats.push({ arm: parsed.arm, ...parsed.verifierStats });
      if (Array.isArray(parsed.perRowOutcomes)) perRowOutcomes.push(...parsed.perRowOutcomes.map((entry) => ({ arm: parsed.arm, ...entry })));
    }
    const report = {
      schemaVersion: 'verified-publication-report-v1',
      fixture: path.relative(root, fixturePath),
      arms: arms.map((armId) => armReport(rows, armId)),
      perFixture: summarizePerFixture(rows, matrix.fixtures),
      ...(verifierStats.length > 0 ? { verifierStats } : {}),
      ...(perRowOutcomes.length > 0 ? { perRowOutcomes } : {}),
    };
    if (outPath) fs.writeFileSync(path.resolve(root, outPath), `${JSON.stringify({ ...report, rows }, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.error('usage: evaluate-verified-publication.mjs <lanes|verify|report> [options]');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
