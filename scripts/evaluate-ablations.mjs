#!/usr/bin/env node
/**
 * Cap and reasoning-budget ablations for the testing-charter persona.
 *
 * Two independent, paired-design sweeps over the SAME fixtures
 * (tests/fixtures/testing-charter/evaluation-matrix.json), SAME persona ('testing'), SAME model,
 * SAME bounded-investigation engine (runPersonaInvestigation via reviewWithBoundedInvestigation --
 * the path that actually ships), and SAME transient-failure recovery (scripts/evaluate-testing-
 * charter.mjs's --fallback-models fix, duplicated here since this script is a sibling CLI, not an
 * importer of that file's private main()):
 *
 *   --mode cap        Varies ONLY the number word in the live charter's "report at most the
 *                      THREE highest-impact test gaps" sentence (ONE/TWO/THREE) -- a single-token
 *                      substitution, nothing else in the charter text changes. Answers: does the
 *                      <=3-findings cap bound recall, or is something else the bottleneck?
 *
 *   --mode reasoning   Varies ONLY modelOptions.reasoningEffort ('none' / unset / 'max') against
 *                      the fixed, unmodified live charter (cap stays at its shipped value, THREE).
 *                      Answers: does more reasoning budget buy detection, or just latency?
 *
 * Per-run instrumentation beyond what evaluate-testing-charter.mjs's gradeRun/summarizeArm
 * already report (both module-private, so the matching logic below is a deliberate small
 * duplication of already-public structural rules -- see findingMatchesFixture/findingAnchors --
 * not a second grading policy that could drift):
 *   - hitRank: 1-based index of the first finding in the model's own findings array that matches
 *     the fixture, or null if never matched. Tests "top-N evidence-backed concepts" (rank low)
 *     against "first N things the model thought of" (rank scattered) -- the cap's whole premise.
 *   - slotsFilled: whether the run actually used all `cap` available finding slots. If few runs
 *     fill even a low cap, the cap is not the bottleneck regardless of what raising it does to
 *     recall -- the cheap, decisive check the operator asked for before spending more on this.
 *   - reasoningChars/reasoningChunks/reasoningMs: from src/evaluation/streamTiming.js's
 *     first-content event (added alongside this script) -- a character-length proxy for how much
 *     reasoning preceded the first content byte, since no transport in this codebase surfaces a
 *     provider-reported reasoning-token count.
 *
 * Evidence tooling is disabled in this harness (reviewWithBoundedInvestigation's own doc comment:
 * every fixture is self-contained by design), so tool-call count is always 0 here -- reported as
 * a measured zero under that explicit constraint, not silently omitted, but it is NOT evidence
 * that reasoning never uses tools in production; it is evidence that this harness never offers one.
 *
 * Offline by default: no OPENROUTER_API_KEY -> not_run, no evidence claimed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { runPersonaInvestigation: runBoundedPersonaInvestigation } = require(path.join(root, 'src/review/reviewInvestigation.js'));
const { HARD_BANNED_PROVIDER_SLUGS } = require(path.join(root, '.github/workflows/pipelines/openRouterPolicy.js'));
const { createReviewUnitManifest } = require(path.join(root, 'src/review/reviewUnitManifest.js'));
const { sha256 } = require(path.join(root, 'src/review/reviewCore.js'));
const { withStreamTiming } = require(path.join(root, 'src/evaluation/streamTiming.js'));

const EVAL_HARNESS_DIGEST = sha256('evaluate-ablations.mjs');
const DEFAULT_FIXTURE = 'tests/fixtures/testing-charter/evaluation-matrix.json';
// See scripts/evaluate-testing-charter.mjs's DEFAULT_FALLBACK_MODELS doc comment: the testing
// persona's own primary model is deepseek/deepseek-v4-flash-0731, so reusing it as its own
// fallback nets zero redundancy (reviewWithModel dedupes [cfg.model, ...fallbackModels]).
const DEFAULT_FALLBACK_MODELS = ['anthropic/claude-sonnet-4'];
const CAP_WORDS = { 1: 'ONE', 2: 'TWO', 3: 'THREE' };
// Whitespace-tolerant: the live charter template literal hard-wraps this sentence
// ("at most the THREE\nhighest-impact test gaps"), so a literal-string match on a single space
// would silently miss it. \s+ matches the real newline+indentation without caring about its
// exact shape.
const CAP_PHRASE_PATTERN = /at most the THREE\s+highest-impact test gaps/;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(name);
}

function buildDiffTextFromFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((file) => `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n${file.patch}`)
    .join('\n');
}

/** Same adapter shape as evaluate-testing-charter.mjs's reviewWithBoundedInvestigation -- see
 * that file for the full rationale (real manifest ids, evidence disabled by design, etc). */
export async function reviewWithBoundedInvestigation(persona, files, prContext = {}, sessionContext = {}, modelOptions = {}) {
  const identity = {
    repository: prContext.repo || 'owner/repository',
    prNumber: Number(prContext.prNumber) || 1,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    configDigest: EVAL_HARNESS_DIGEST,
    policyDigest: EVAL_HARNESS_DIGEST,
    diffDigest: EVAL_HARNESS_DIGEST,
  };
  const evidenceRegistry = { capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable' }) };
  const manifestUnits = createReviewUnitManifest({
    identity,
    trustedRules: { maxFileDiffChars: 5_000, generatedPatterns: [], vendorPatterns: [] },
    policy: { maxFileDiffChars: 5_000 },
    files: (Array.isArray(files) ? files : []).map((file) => ({ path: file.path, patch: file.patch })),
  }).units;
  const manifest = `<review_units>${JSON.stringify(manifestUnits)}</review_units>`;
  try {
    const run = await runBoundedPersonaInvestigation({
      identity,
      persona,
      manifest,
      diffFiles: files,
      diffText: buildDiffTextFromFiles(files),
      evidenceRegistry,
      modelTurn: (turnArgs) => pipeline.callPersonaModelTurn({
        persona,
        prContext,
        sessionContext,
        messages: turnArgs.messages,
        options: modelOptions,
        turn: turnArgs.turn,
        finalOnly: turnArgs.finalOnly,
        signal: turnArgs.signal,
      }),
    });
    const terminal = run.executionReceipt?.termination;
    return {
      decision: run.personaResult.decision,
      findings: run.personaResult.findings,
      usage: run.personaResult.usage,
      model: run.personaResult.model,
      provider: run.personaResult.provider,
      ...(terminal && terminal !== 'completed' ? { error: terminal } : {}),
    };
  } catch (error) {
    return { decision: 'ERROR', error: error?.message || 'call_failed', findings: [] };
  }
}

// --- structural grading (deliberately duplicated from evaluate-testing-charter.mjs's
// module-private gradeRun/findingMatchesFixture/findingAnchors -- see this file's header) ---
function findingText(finding = {}) {
  return [finding.title, finding.body, finding.suggestion].filter(Boolean).join('\n').toLowerCase();
}
function findingAnchors(finding, fixture) {
  return fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected));
}
function findingMatchesFixture(finding, fixture) {
  if (!findingAnchors(finding, fixture)) return false;
  const text = findingText(finding);
  return fixture.mustMatch.every((group) => group.some((token) => text.includes(token)));
}
function classifyFinding(finding, fixture) {
  if (fixture.category === 'clean') return 'noise';
  if (findingMatchesFixture(finding, fixture)) return 'hit';
  if (findingAnchors(finding, fixture)) return 'valid_suggestion';
  return 'noise';
}

function rate(hits, total) {
  return total ? Number((hits / total).toFixed(4)) : null;
}
function wilson(hits, total) {
  if (!total) return null;
  const z = 1.96;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Number(Math.max(0, centre - spread).toFixed(4)), Number(Math.min(1, centre + spread).toFixed(4))];
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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function buildTimedModelOptions(modelOptions) {
  const timing = {
    firstChunkMs: null, firstChunkKind: null, firstContentMs: null,
    reasoningChars: null, reasoningChunks: null,
  };
  if (typeof modelOptions.modelClient === 'function') return { modelOptions, timing };
  const baseFetch = modelOptions.fetchImplementation || modelOptions.fetchImpl || globalThis.fetch;
  if (typeof baseFetch !== 'function') return { modelOptions, timing };
  const fetchImplementation = withStreamTiming(baseFetch, {
    onTiming: (event) => {
      if (event.type === 'firstChunk' && timing.firstChunkMs === null) {
        timing.firstChunkMs = event.elapsedMs;
        timing.firstChunkKind = event.kind;
      } else if (event.type === 'firstContent' && timing.firstContentMs === null) {
        timing.firstContentMs = event.elapsedMs;
        timing.reasoningChars = event.reasoningChars ?? 0;
        timing.reasoningChunks = event.reasoningChunks ?? 0;
      }
    },
  });
  return { modelOptions: { ...modelOptions, fetchImplementation }, timing };
}

/** Grades one row with the cap/rank/slot-fill instrumentation the two ablations need. */
function gradeAblationRow(fixture, result, cap) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const errored = result?.decision === 'ERROR' || Boolean(result?.error);
  const classifications = errored ? [] : findings.map((finding) => classifyFinding(finding, fixture));
  const hits = classifications.filter((label) => label === 'hit').length;
  const validSuggestions = classifications.filter((label) => label === 'valid_suggestion').length;
  const noise = classifications.filter((label) => label === 'noise').length;
  const hitIndex = errored ? -1 : findings.findIndex((finding) => findingMatchesFixture(finding, fixture));
  return {
    errored,
    error: result?.error,
    findings: findings.length,
    hits,
    validSuggestions,
    noise,
    detected: fixture.category === 'defect' && !errored && hits > 0,
    falsePositive: fixture.category === 'clean' && !errored && findings.length > 0,
    anchored: !errored && findings.some((finding) => findingAnchors(finding, fixture)),
    hitRank: hitIndex >= 0 ? hitIndex + 1 : null,
    // >= not === : a run that reported one MORE than cap is an output-contract breach (tracked
    // separately below), not evidence the slot was left empty.
    slotsFilled: !errored && findings.length >= cap,
    outputContractBreach: !errored && findings.length > cap,
  };
}

async function evaluateAblation(fixtures, { repetitions, concurrency, arms, modelOptionsBase }) {
  const jobs = [];
  for (const arm of arms) {
    for (const fixture of fixtures) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) jobs.push({ arm, fixture, repetition });
    }
  }
  const rows = await mapWithConcurrency(jobs, concurrency, async ({ arm, fixture, repetition }) => {
    const startedAt = Date.now();
    const rowOptions = {
      ...modelOptionsBase,
      ...(arm.reasoningEffort !== undefined ? { reasoningEffort: arm.reasoningEffort } : {}),
    };
    const { modelOptions: timedOptions, timing } = buildTimedModelOptions(rowOptions);
    let result;
    try {
      result = await reviewWithBoundedInvestigation(
        { ...arm.persona, charter: arm.charter },
        fixture.files,
        { repo: 'review-yeti-ai/review-yeti-bot', prNumber: `ablation-${arm.id}-${repetition}-${fixture.id}`, title: fixture.title },
        null,
        timedOptions,
      );
    } catch (error) {
      result = { decision: 'ERROR', error: error?.message || 'call_failed', findings: [] };
    }
    const graded = gradeAblationRow(fixture, result, arm.cap ?? 3);
    return {
      arm: arm.id,
      fixtureId: fixture.id,
      category: fixture.category,
      repetition,
      latencyMs: Date.now() - startedAt,
      firstChunkMs: timing.firstChunkMs,
      firstChunkKind: timing.firstChunkKind,
      firstContentMs: timing.firstContentMs,
      reasoningChars: timing.reasoningChars,
      reasoningChunks: timing.reasoningChunks,
      usage: result?.usage || {},
      model: result?.model,
      provider: result?.provider,
      ...graded,
      findingTitles: (Array.isArray(result?.findings) ? result.findings : []).map((finding) => `${finding.path}:${finding.line} ${finding.title}`),
    };
  });
  return rows;
}

export function summarizeArm(rows, armId, expectedModel) {
  const selected = rows.filter((row) => row.arm === armId);
  const defects = selected.filter((row) => row.category === 'defect');
  const clean = selected.filter((row) => row.category === 'clean');
  const usage = selected.reduce((total, row) => ({
    promptTokens: total.promptTokens + Number(row.usage?.promptTokens || 0),
    completionTokens: total.completionTokens + Number(row.usage?.completionTokens || 0),
    costUSD: total.costUSD + Number(row.usage?.costUSD || 0),
  }), { promptTokens: 0, completionTokens: 0, costUSD: 0 });
  const detectedCount = defects.filter((row) => row.detected).length;
  const totalHits = selected.reduce((sum, row) => sum + Number(row.hits || 0), 0);
  const totalValid = selected.reduce((sum, row) => sum + Number(row.validSuggestions || 0), 0);
  const totalNoise = selected.reduce((sum, row) => sum + Number(row.noise || 0), 0);
  const failureClasses = {};
  for (const row of selected) {
    if (!row.errored) continue;
    failureClasses[row.error || 'unknown'] = (failureClasses[row.error || 'unknown'] || 0) + 1;
  }
  const nonPrimaryModelRuns = selected.filter((row) => !row.errored && row.model && expectedModel && row.model !== expectedModel).length;
  const ranks = selected.filter((row) => Number.isInteger(row.hitRank)).map((row) => row.hitRank);
  const rankCounts = {};
  for (const rank of ranks) rankCounts[rank] = (rankCounts[rank] || 0) + 1;
  const eligibleForSlots = selected.filter((row) => !row.errored);
  const firstChunkKindCounts = { reasoning: 0, content: 0, other: 0 };
  for (const row of selected) {
    if (row.firstChunkKind && firstChunkKindCounts[row.firstChunkKind] !== undefined) firstChunkKindCounts[row.firstChunkKind] += 1;
  }
  const reasoningCharSeries = numericSeries(selected, 'reasoningChars');
  return {
    arm: armId,
    runs: selected.length,
    erroredRuns: selected.filter((row) => row.errored).length,
    failureClasses,
    nonPrimaryModelRuns,
    defectRuns: defects.length,
    detected: detectedCount,
    detectionRate: rate(detectedCount, defects.length),
    detectionRate95: wilson(detectedCount, defects.length),
    anchoredRate: rate(defects.filter((row) => row.anchored).length, defects.length),
    cleanRuns: clean.length,
    falsePositives: clean.filter((row) => row.falsePositive).length,
    falsePositiveRate: rate(clean.filter((row) => row.falsePositive).length, clean.length),
    falsePositiveRate95: wilson(clean.filter((row) => row.falsePositive).length, clean.length),
    hits: totalHits,
    validSuggestions: totalValid,
    noise: totalNoise,
    precision: rate(totalHits, totalHits + totalNoise),
    snr: totalNoise === 0 ? null : Number(((totalHits + totalValid) / totalNoise).toFixed(3)),
    snrUnbounded: totalNoise === 0 && (totalHits + totalValid) > 0,
    findingsPerRun: selected.length ? Number((selected.reduce((sum, row) => sum + row.findings, 0) / selected.length).toFixed(3)) : null,
    outputContractBreaches: selected.filter((row) => row.outputContractBreach).length,
    slotsFilledRate: rate(eligibleForSlots.filter((row) => row.slotsFilled).length, eligibleForSlots.length),
    slotsFilledN: eligibleForSlots.length,
    hitRankCounts: rankCounts,
    hitRankMedian: ranks.length ? median([...ranks].sort((a, b) => a - b)) : null,
    hitsNeverRanked: defects.filter((row) => !row.errored && row.hits === 0).length,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUSD: Number(usage.costUSD.toFixed(6)),
    latencyMsMedian: median(numericSeries(selected, 'latencyMs')),
    latencyMsP95: p95(numericSeries(selected, 'latencyMs')),
    firstChunkMsMedian: median(numericSeries(selected, 'firstChunkMs')),
    firstContentMsMedian: median(numericSeries(selected, 'firstContentMs')),
    firstContentMsP95: p95(numericSeries(selected, 'firstContentMs')),
    firstChunkKindCounts,
    reasoningCharsMedian: median(reasoningCharSeries),
    reasoningCharsP95: p95(reasoningCharSeries),
    reasoningCharsMeasured: reasoningCharSeries.length,
  };
}

export function summarizeByFixture(rows, fixtures, armIds) {
  return fixtures.map((fixture) => {
    const perArm = {};
    for (const armId of armIds) {
      const selected = rows.filter((row) => row.arm === armId && row.fixtureId === fixture.id);
      const hits = fixture.category === 'clean'
        ? selected.filter((row) => row.falsePositive).length
        : selected.filter((row) => row.detected).length;
      perArm[armId] = { hits, runs: selected.length, rate: rate(hits, selected.length), interval: wilson(hits, selected.length), errored: selected.filter((r) => r.errored).length };
    }
    return { id: fixture.id, category: fixture.category, ...perArm };
  });
}

function loadPersonaAndCharter() {
  const persona = pipeline.PERSONA_CHARTERS.find((entry) => entry.id === 'testing');
  if (!persona) throw new Error('testing persona is not configured');
  if (!CAP_PHRASE_PATTERN.test(persona.charter)) {
    throw new Error(`cap phrase ${CAP_PHRASE_PATTERN} not found in live testing charter -- charter text has drifted, update CAP_PHRASE_PATTERN`);
  }
  return persona;
}

function capCharter(liveCharter, cap) {
  const word = CAP_WORDS[cap];
  if (!word) throw new Error(`unsupported cap ${cap}`);
  // Replace only the number word, preserving the exact surrounding whitespace/wrap the live
  // charter uses -- a single-token substitution, not a rewrite of the sentence.
  return liveCharter.replace(CAP_PHRASE_PATTERN, (matched) => matched.replace('THREE', word));
}

async function main() {
  const mode = argument('--mode', '');
  if (mode !== 'cap' && mode !== 'reasoning') {
    console.error('usage: evaluate-ablations.mjs --mode cap|reasoning [--repetitions N] [--concurrency N] [--out path.json]');
    return 1;
  }
  const fixturePath = path.resolve(root, argument('--fixture', DEFAULT_FIXTURE));
  const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const fixtures = matrix.fixtures;
  const persona = loadPersonaAndCharter();
  const repetitions = Number(argument('--repetitions', 8));
  const concurrency = Number(argument('--concurrency', 6));
  const model = argument('--model', process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731');
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.log(JSON.stringify({ status: 'not_run', reason: 'provider_unavailable', detail: 'OPENROUTER_API_KEY is required; no ablation evidence claimed' }, null, 2));
    return 0;
  }

  const fallbackModelsArg = argument('--fallback-models', '');
  const fallbackModels = fallbackModelsArg === 'none'
    ? []
    : fallbackModelsArg === ''
      ? DEFAULT_FALLBACK_MODELS
      : fallbackModelsArg.split(',').map((entry) => entry.trim()).filter(Boolean);

  const modelOptionsBase = {
    apiKey,
    model,
    maxAttempts: Number(argument('--max-attempts', 2)),
    timeoutMs: Number(argument('--timeout-ms', 90_000)),
    openRouterPolicy: {
      allowedModels: [],
      fallbackModels,
      ignoredProviders: [...HARD_BANNED_PROVIDER_SLUGS],
      providerRouting: { ignore: [...HARD_BANNED_PROVIDER_SLUGS] },
      timeoutMs: 90_000,
      stream: true,
    },
  };

  let arms;
  if (mode === 'cap') {
    arms = [1, 2, 3].map((cap) => ({ id: `cap${cap}`, cap, persona, charter: capCharter(persona.charter, cap) }));
  } else {
    arms = [
      { id: 'reasoning-minimal', reasoningEffort: 'none', persona, charter: persona.charter },
      { id: 'reasoning-current', reasoningEffort: undefined, persona, charter: persona.charter },
      { id: 'reasoning-higher', reasoningEffort: 'max', persona, charter: persona.charter },
    ];
  }

  const startedAt = Date.now();
  const rows = await evaluateAblation(fixtures, { repetitions, concurrency, arms, modelOptionsBase });
  const wallClockMs = Date.now() - startedAt;

  const report = {
    schemaVersion: 'ablation-eval-report-v1',
    mode,
    fixture: path.relative(root, fixturePath),
    model,
    fallbackModels,
    repetitions,
    concurrency,
    wallClockMs,
    arms: arms.map((arm) => summarizeArm(rows, arm.id, model)),
    perFixture: summarizeByFixture(rows, fixtures, arms.map((arm) => arm.id)),
  };
  const outputPath = argument('--out', '');
  if (outputPath) {
    fs.writeFileSync(path.resolve(root, outputPath), `${JSON.stringify({ ...report, rows }, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
