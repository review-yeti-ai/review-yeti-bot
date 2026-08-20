#!/usr/bin/env node
/**
 * Testing-charter detection evaluation.
 *
 * Measures whether the testing persona reports the seeded semantic test defects in
 * tests/fixtures/testing-charter/evaluation-matrix.json, and whether it stays quiet on the
 * clean controls in the same matrix.
 *
 * Two arms run against identical fixtures:
 *   baseline  — the charter text frozen in tests/fixtures/testing-charter/baseline-charter.txt,
 *               captured immediately before the depth-probe rewrite.
 *   candidate — the charter currently compiled into PERSONA_CHARTERS.
 *
 * Detection is graded structurally, never by asking a model to grade a model: a fixture counts
 * as detected in a repetition when some finding anchors to one of the fixture's expected paths
 * AND every `mustMatch` concept group matches the finding text. Requiring every group is what
 * separates "names the actual defect mechanism" from "says the tests could be better".
 *
 * Offline by default: with no OPENROUTER_API_KEY this exits 0 and reports not_run rather than
 * claiming evidence it does not have.
 *
 *   node scripts/evaluate-testing-charter.mjs --repetitions 8 --concurrency 5
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

// Fixed, valid-shaped placeholders -- createReviewUnitManifest's identity requires 64-hex digests
// for configDigest/policyDigest/diffDigest, but nothing in this harness ever checks them against
// anything else (unlike the real pipeline's trusted-policy digests). Any constant, valid digest
// produces stable, real-shaped review-unit ids; what matters is the shape, not the value.
const EVAL_HARNESS_DIGEST = sha256('evaluate-testing-charter.mjs');

const DEFAULT_FIXTURE = 'tests/fixtures/testing-charter/evaluation-matrix.json';
const DEFAULT_BASELINE_CHARTER = 'tests/fixtures/testing-charter/baseline-charter.txt';

/**
 * Renders a unified-diff blob from fixture `{path, patch}` entries, matching the header shape
 * GitHub/`git diff` output uses (`file.patch` fixtures carry only the hunk body). This is only a
 * fallback for `buildInvestigationMessages`'s legacy `diffText` string path -- the primary path
 * below hands it `diffFiles` directly, which is what production actually does.
 */
function buildDiffTextFromFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((file) => `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n${file.patch}`)
    .join('\n');
}

/**
 * `reviewWithModel`-shaped adapter (same `(persona, files, prContext, sessionContext,
 * modelOptions)` signature `evaluateTestingCharter` already accepts as an injectable
 * `reviewWithModel`) that instead drives the actual bounded investigation engine --
 * `runPersonaInvestigation` from src/review/reviewInvestigation.js, fed by
 * `buildInvestigationMessages` (reviewInvestigationPrompt.js) via the SAME `diffFiles` input shape
 * and the SAME `callPersonaModelTurn` turn dispatcher production uses.
 *
 * This is what makes the measurement mean something: `reviewWithModel` (the function this script
 * called before) is the legacy single-shot path. `runPersonaInvestigation` here is what actually
 * ships on every real PR review (review-pipeline.js's `boundedMode` branch). A charter or
 * prompt change validated only against the legacy path could pass this eval while doing nothing,
 * or the wrong thing, on the path that is production default.
 *
 * Evidence tooling is deliberately disabled (`capabilities.enabled: false`): every fixture in
 * this matrix is self-contained by design ("everything needed to resolve it is inside the
 * supplied diff, so a miss is a reasoning/attention failure, not a missing-evidence failure" --
 * see the matrix's own `notes`), so a real evidence registry would add nothing but a repo
 * checkout this harness does not have. `runPersonaInvestigation`'s own evidence-disabled carve-out
 * (findings marked `unverified: true` but retained, no evidence_receipt_ids required) is exactly
 * the behavior this needs.
 *
 * `modelOptions.modelClient`, when supplied, flows straight through to `callPersonaModelTurn` and
 * makes this run fully offline against a scripted response -- no network, no OPENROUTER_API_KEY.
 * `modelOptions.apiKey`/`model`/`transportPlan` flow through the same way for a live run.
 */
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
  // Found live (legacy-cutover's repro, three original defect fixtures, 3/3 failed on first
  // turn): a bare `{path}` manifest with no `id` field let the model echo a path-shaped string
  // (e.g. "ru_tests/test_workflow_guard.py") back as a finding's unit_id, which requiredId()'s
  // format check (no `/` allowed) hard-rejects as malformed_response. Real production unit ids
  // are always `ru_<64-hex-sha256>` (reviewUnitManifest.js's stableReviewUnitId) -- reusing the
  // real manifest builder here, not a hand-rolled shape, is what actually eliminates that gap
  // rather than papering over one specific symptom of it.
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
      ...(terminal && terminal !== 'completed' ? { error: terminal } : {}),
    };
  } catch (error) {
    return { decision: 'ERROR', error: error?.message || 'call_failed', findings: [] };
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

/**
 * Resolves the maxTokens value to pass into modelOptions for one eval run.
 *
 * Production's bounded engine (review-pipeline.js's resolveModelConfig) never sets an explicit
 * max_tokens at all -- callOpenRouterChat only includes it in the request body when the caller
 * supplies one, otherwise the provider's own (much larger) default output cap applies. This
 * script's --max-tokens flag defaults to 4,096 for operator convenience (bounding eval cost on
 * the legacy arm, whose response contract is comparatively small), but applying that same flat
 * ceiling to a --bounded run is not "measuring what ships" -- it is measuring the bounded engine
 * under an artificial constraint production never imposes. The bounded contract's response
 * (risk_plan + evidence_requests + risk_dispositions + findings, each carrying its own text
 * fields) is unavoidably larger than the legacy contract's, so a shared ceiling starves it
 * specifically. Found live: eval-expand's PR #132 baseline measured a bounded detectionRate of
 * 0.20 vs legacy's 0.73 with over double the malformed_response rate, on identical fixtures,
 * model, and modelOptions -- an eval-harness artifact this function removes, not evidence about
 * the engine itself.
 *
 * An explicit --max-tokens is always honored on both paths -- this only removes the *default*,
 * never a deliberate operator choice (e.g. a cost-bounded experiment).
 */
export function resolveEvalMaxTokens({ argv = process.argv, bounded = false, fallback = 4_096 } = {}) {
  const index = argv.indexOf('--max-tokens');
  const explicit = index >= 0 && argv[index + 1] !== undefined;
  if (bounded && !explicit) return undefined;
  const parsed = explicit ? Number(argv[index + 1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Findings text a concept group is matched against. Lower-cased; suggestion included. */
function findingText(finding = {}) {
  return [finding.title, finding.body, finding.suggestion].filter(Boolean).join('\n').toLowerCase();
}

/**
 * A finding matches a fixture when it anchors to an expected path and satisfies every concept
 * group. Groups are OR within, AND across: the finding must name each required idea somehow,
 * which no amount of generic "add more tests" phrasing can accidentally do.
 */
function findingAnchors(finding, fixture) {
  return fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected));
}

function findingMatchesFixture(finding, fixture) {
  if (!findingAnchors(finding, fixture)) return false;
  const text = findingText(finding);
  return fixture.mustMatch.every((group) => group.some((token) => text.includes(token)));
}

/**
 * Structural per-finding classification for CR-Bench's SNR: `hits + valid suggestions / noise`.
 * Every finding gets exactly one label -- mutually exclusive, collectively exhaustive over the
 * findings a run produced -- using only the same structural rules `gradeRun` already applies:
 *
 *   hit             — matches the fixture exactly (findingMatchesFixture): anchored to an
 *                      expected path AND names the seeded defect mechanism.
 *   valid_suggestion — anchored to an expected path but doesn't name the mechanism. This is the
 *                      harness's structural proxy for CR-Bench's "sound feedback that isn't the
 *                      target defect": we cannot judge soundness without an LLM judge (out of
 *                      scope, see module doc), so "pointed at the right file" stands in for it.
 *   noise           — everything else: any finding on a clean control (the charter's own
 *                      "do not flag" list makes every one of those wrong by definition), and any
 *                      defect-fixture finding that didn't even anchor to an expected path.
 *
 * No new judgment machinery: this reuses findingMatchesFixture/findingAnchors, the exact
 * functions `detected`/`anchored` already call per run.
 */
function classifyFindings(fixture, findings) {
  if (fixture.category === 'clean') return findings.map(() => 'noise');
  return findings.map((finding) => {
    if (findingMatchesFixture(finding, fixture)) return 'hit';
    if (findingAnchors(finding, fixture)) return 'valid_suggestion';
    return 'noise';
  });
}

function gradeRun(fixture, result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const errored = result?.decision === 'ERROR' || Boolean(result?.error);
  const classifications = errored ? [] : classifyFindings(fixture, findings);
  const counts = {
    hits: classifications.filter((label) => label === 'hit').length,
    validSuggestions: classifications.filter((label) => label === 'valid_suggestion').length,
    noise: classifications.filter((label) => label === 'noise').length,
  };
  if (fixture.category === 'clean') {
    return {
      errored,
      // Any finding at all on a control is a false positive: both controls are changes the
      // charter's "do not flag" list names explicitly.
      falsePositive: !errored && findings.length > 0,
      detected: false,
      anchored: false,
      findings: findings.length,
      ...counts,
    };
  }
  return {
    errored,
    falsePositive: false,
    detected: !errored && findings.some((finding) => findingMatchesFixture(finding, fixture)),
    // Weaker signal kept for diagnosis: the lane looked at the right file but did not name the
    // mechanism. A jump in `anchored` with flat `detected` means the probes aimed attention
    // without changing the conclusion.
    anchored: !errored && findings.some((finding) => findingAnchors(finding, fixture)),
    findings: findings.length,
    ...counts,
  };
}

function rate(hits, total) {
  return total ? Number((hits / total).toFixed(4)) : null;
}

/** Wilson 95% score interval — an 8-sample rate needs its uncertainty printed next to it. */
function wilson(hits, total) {
  if (!total) return null;
  const z = 1.96;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Number(Math.max(0, centre - spread).toFixed(4)), Number(Math.min(1, centre + spread).toFixed(4))];
}

/** Extracts a sorted numeric series from `rows[key]`, dropping non-finite/unmeasured entries. */
function numericSeries(rows, key) {
  return rows.map((row) => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
}

/** Same median/p95 selection the original latencyMs computation used, factored out so every
 * latency-shaped series (total latency, TTFB, first-content) reports identically. */
function median(sorted) {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}
function p95(sorted) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
}

/**
 * CR-Bench's signal-to-noise ratio: (hits + valid suggestions) / noise, over every finding the
 * arm produced (see `classifyFindings`'s doc comment for how each finding is labeled). `noise`
 * counting zero with nonzero signal is a real, measured "no noise observed" result, not missing
 * data -- reported as `ratio: null, unbounded: true` rather than `Infinity` (which JSON silently
 * turns into `null` anyway, indistinguishable from "not computable"). Zero signal and zero noise
 * (no findings at all, e.g. every run errored) is genuinely not computable: `ratio: null,
 * unbounded: false`.
 */
function signalToNoiseRatio(hits, validSuggestions, noise) {
  const signal = hits + validSuggestions;
  if (noise === 0) return { ratio: null, unbounded: signal > 0 };
  return { ratio: Number((signal / noise).toFixed(3)), unbounded: false };
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
  const firstChunkLatencies = numericSeries(selected, 'firstChunkMs');
  const firstContentLatencies = numericSeries(selected, 'firstContentMs');
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
  const firstChunkKindCounts = { reasoning: 0, content: 0, other: 0 };
  for (const row of selected) {
    if (row.firstChunkKind && firstChunkKindCounts[row.firstChunkKind] !== undefined) firstChunkKindCounts[row.firstChunkKind] += 1;
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
    // CR-Bench-style finding classification (see classifyFindings) and the SNR/precision it
    // enables. hits/validSuggestions/noise sum across every finding, not every run.
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
    // Time-to-first-SSE-chunk (any kind, matching production's TTFT measurement) and
    // time-to-first-content (the first chunk that actually carries `delta.content`). The gap
    // between them is the reasoning phase -- see src/evaluation/streamTiming.js's doc comment.
    // null when the run never went through a real fetch (e.g. an offline modelClient adapter).
    firstChunkMsMedian: median(firstChunkLatencies),
    firstChunkMsP95: p95(firstChunkLatencies),
    firstContentMsMedian: median(firstContentLatencies),
    firstContentMsP95: p95(firstContentLatencies),
    firstChunkMeasured: firstChunkLatencies.length,
    firstContentMeasured: firstContentLatencies.length,
    firstChunkKindCounts,
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

function fmtRate(rateValue, interval, n) {
  if (rateValue === null) return `n/a (N=${n})`;
  const ci = interval ? ` (95% CI ${interval[0].toFixed(3)}–${interval[1].toFixed(3)})` : '';
  return `${rateValue.toFixed(3)}${ci} N=${n}`;
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}` : '—';
}

function fmtSnr(arm) {
  if (arm.snrUnbounded) return `∞ (0 noise, ${arm.hits + arm.validSuggestions} signal)`;
  return arm.snr === null ? 'n/a (0 signal, 0 noise)' : arm.snr.toFixed(3);
}

function fmtFailureClasses(failureClasses) {
  const entries = Object.entries(failureClasses || {});
  if (!entries.length) return 'none';
  return entries.map(([label, count]) => `${label}: ${count}`).join(', ');
}

function fmtChunkKinds(counts) {
  if (!counts) return '—';
  return `reasoning ${counts.reasoning} / content ${counts.content} / other ${counts.other}`;
}

/**
 * Renders one corpus's evaluation report (the object `evaluateTestingCharter` + `summarizeArm` +
 * `summarizePerFixture` produce, as shipped in `report`/`--out`) as a GitHub-flavored markdown
 * document: one arm-comparison table with every metric the operator asked to see side by side
 * (detection rate + CI, FP rate, precision, SNR, errored/N with failure-class breakdown, total
 * latency, TTFB, and first-content latency), followed by a per-fixture detail table.
 *
 * Pure formatting over already-computed numbers -- this function invents nothing and estimates
 * nothing; a `null` field renders as an explicit "n/a"/"—" cell, never a guess.
 */
export function renderMarkdownReport(report) {
  const lines = [];
  const corpus = report.fixture || 'unknown-fixture';
  lines.push(`## Testing-charter evaluation — \`${corpus}\``);
  lines.push('');
  lines.push(`- Model: \`${report.model || 'unknown'}\``);
  lines.push(`- Path: \`${report.path || 'unknown'}\` (max_tokens=${report.maxTokens ?? 'uncapped (production default)'})`);
  lines.push(`- Repetitions per fixture/arm: ${report.repetitions ?? 'unknown'}`);
  lines.push('');
  lines.push('| Metric | ' + report.arms.map((arm) => arm.arm).join(' | ') + ' |');
  lines.push('|---|' + report.arms.map(() => '---').join('|') + '|');
  const row = (label, fn) => lines.push(`| ${label} | ${report.arms.map(fn).join(' | ')} |`);
  row('Detection rate (recall)', (arm) => fmtRate(arm.detectionRate, arm.detectionRate95, arm.defectRuns));
  row('Anchored rate', (arm) => fmtRate(arm.anchoredRate, null, arm.defectRuns));
  row('False-positive rate', (arm) => fmtRate(arm.falsePositiveRate, null, arm.cleanRuns));
  row('Precision (hits / (hits+noise))', (arm) => (arm.precision === null ? 'n/a' : arm.precision.toFixed(3)));
  row('SNR ((hits+valid)/noise)', (arm) => fmtSnr(arm));
  row('Hits / valid suggestions / noise', (arm) => `${arm.hits} / ${arm.validSuggestions} / ${arm.noise}`);
  row('Errored runs', (arm) => `${arm.erroredRuns}/${arm.runs} (${fmtFailureClasses(arm.failureClasses)})`);
  row('Findings/run (output-contract breaches)', (arm) => `${arm.findingsPerRun ?? 'n/a'} (${arm.outputContractBreaches} > 3)`);
  row('Total latency ms, median / P95', (arm) => `${fmtMs(arm.latencyMsMedian)} / ${fmtMs(arm.latencyMsP95)}`);
  row('TTFB ms, median / P95 (measured N)', (arm) => `${fmtMs(arm.firstChunkMsMedian)} / ${fmtMs(arm.firstChunkMsP95)} (N=${arm.firstChunkMeasured})`);
  row('First-content ms, median / P95 (measured N)', (arm) => `${fmtMs(arm.firstContentMsMedian)} / ${fmtMs(arm.firstContentMsP95)} (N=${arm.firstContentMeasured})`);
  row('First-chunk kind (reasoning/content/other)', (arm) => fmtChunkKinds(arm.firstChunkKindCounts));
  row('Prompt / completion tokens', (arm) => `${arm.promptTokens} / ${arm.completionTokens}`);
  row('Cost (USD)', (arm) => arm.costUSD.toFixed(6));
  lines.push('');

  if (Array.isArray(report.perFixture) && report.perFixture.length) {
    lines.push('### Per-fixture detection');
    lines.push('');
    lines.push('| Fixture | Category | ' + report.arms.map((arm) => arm.arm).join(' | ') + ' |');
    lines.push('|---|---|' + report.arms.map(() => '---').join('|') + '|');
    for (const fixture of report.perFixture) {
      const cells = report.arms.map((arm) => {
        const entry = fixture[arm.arm];
        if (!entry || !entry.runs) return 'n/a';
        return fmtRate(entry.rate, entry.interval, entry.runs);
      });
      lines.push(`| ${fixture.id} | ${fixture.category} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Concatenates one markdown report per corpus with a top-level heading. Multi-corpus is not yet
 * exercised by this repo (one testing-charter matrix today), but callers should not have to
 * hand-roll concatenation once a second corpus fixture exists.
 */
export function renderMarkdownReports(reports) {
  return reports.map((report) => renderMarkdownReport(report)).join('\n---\n\n');
}

/**
 * Wraps `modelOptions.fetchImplementation` (or `globalThis.fetch` when the caller supplied none)
 * with the streamTiming tap for one row, returning row-scoped `modelOptions` plus a `timing`
 * accumulator the caller reads after the row's call(s) settle. First-write-wins across whatever
 * HTTP calls the row makes (multi-turn investigation, retries): the earliest observed firstChunk/
 * firstContent is what the row reports, matching "how long before this row's request produced
 * anything at all".
 *
 * A no-op when the row is driven by a scripted `modelClient` (offline tests, no network) --
 * nothing to tap, and wrapping an unused fetch would be pure overhead.
 */
function buildTimedModelOptions(modelOptions) {
  const timing = { firstChunkMs: null, firstContentMs: null, firstChunkKind: null };
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
      }
    },
  });
  return { modelOptions: { ...modelOptions, fetchImplementation }, timing };
}

export async function evaluateTestingCharter(matrix, {
  repetitions = 8,
  concurrency = 5,
  modelOptions = {},
  arms = [],
  reviewWithModel = pipeline.reviewWithModel,
} = {}) {
  const fixtures = Array.isArray(matrix?.fixtures) ? matrix.fixtures : [];
  if (!fixtures.length) throw new Error('testing-charter matrix contains no fixtures');
  const jobs = [];
  for (const arm of arms) {
    for (const fixture of fixtures) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) jobs.push({ arm, fixture, repetition });
    }
  }
  const rows = await mapWithConcurrency(jobs, concurrency, async ({ arm, fixture, repetition }) => {
    const startedAt = Date.now();
    const { modelOptions: rowModelOptions, timing } = buildTimedModelOptions(modelOptions);
    let result;
    try {
      result = await reviewWithModel(
        { ...arm.persona, charter: arm.charter },
        fixture.files,
        { repo: 'review-yeti-ai/review-yeti-bot', prNumber: `testing-charter-${arm.id}-${repetition}-${fixture.id}`, title: fixture.title },
        null,
        rowModelOptions,
      );
    } catch (error) {
      result = { decision: 'ERROR', error: error?.message || 'call_failed', findings: [] };
    }
    const graded = gradeRun(fixture, result);
    return {
      arm: arm.id,
      fixtureId: fixture.id,
      category: fixture.category,
      repetition,
      latencyMs: Date.now() - startedAt,
      // Time-to-first-SSE-chunk and time-to-first-content for this row's first HTTP call, or
      // null when the row never went through a real fetch (offline modelClient). See
      // src/evaluation/streamTiming.js.
      firstChunkMs: timing.firstChunkMs,
      firstChunkKind: timing.firstChunkKind,
      firstContentMs: timing.firstContentMs,
      usage: result?.usage || {},
      error: result?.error,
      ...graded,
      findingTitles: (Array.isArray(result?.findings) ? result.findings : []).map((finding) => `${finding.path}:${finding.line} ${finding.title}`),
    };
  });
  return { rows, fixtures };
}

async function main() {
  const fixturePath = path.resolve(root, argument('--fixture', DEFAULT_FIXTURE));
  const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const persona = pipeline.PERSONA_CHARTERS.find((entry) => entry.id === (matrix.personaId || 'testing'));
  if (!persona) throw new Error(`persona ${matrix.personaId} is not configured`);
  const baselineCharter = fs.readFileSync(path.resolve(root, argument('--baseline-charter', DEFAULT_BASELINE_CHARTER)), 'utf8').trimEnd();
  const repetitions = Number(argument('--repetitions', matrix.repetitions || 8));
  const concurrency = Number(argument('--concurrency', 5));
  const model = argument('--model', process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731');
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.log(JSON.stringify({ status: 'not_run', reason: 'provider_unavailable', detail: 'OPENROUTER_API_KEY is required; no detection evidence claimed' }, null, 2));
    return 0;
  }

  const arms = [
    { id: 'baseline', persona, charter: baselineCharter },
    { id: 'candidate', persona, charter: persona.charter },
  ].filter((arm) => !flag('--candidate-only') || arm.id === 'candidate');

  if (baselineCharter === persona.charter.trimEnd()) {
    console.warn('[testing-charter-eval] baseline snapshot equals the live charter; both arms are identical');
  }

  // --bounded measures the path that actually ships (runPersonaInvestigation +
  // buildInvestigationMessages, review-pipeline.js's boundedMode default) instead of the legacy
  // single-shot reviewWithModel this script always used before. See
  // reviewWithBoundedInvestigation's doc comment for why that distinction is the whole point.
  const bounded = flag('--bounded');
  const maxTokens = resolveEvalMaxTokens({ argv: process.argv, bounded, fallback: 4_096 });
  const { rows, fixtures } = await evaluateTestingCharter(matrix, {
    repetitions,
    concurrency,
    arms,
    reviewWithModel: bounded ? reviewWithBoundedInvestigation : pipeline.reviewWithModel,
    modelOptions: {
      apiKey,
      model,
      maxAttempts: Number(argument('--max-attempts', 2)),
      timeoutMs: Number(argument('--timeout-ms', 90_000)),
      // Undefined (production's own 30s default applies) unless the operator passes --ttft-ms
      // explicitly. Found recording this eval's own live-pass cassette (2026-08-19): a slow/
      // queued provider can legitimately take longer than 30s to send its first byte on a
      // reasoning-heavy call, which reads as a harness/provider reliability problem when it is
      // really just an under-budgeted client timer. Left at production's default here on
      // purpose -- a baseline report should measure what production actually does, not a
      // harness-only allowance -- but exposed so an operator chasing transient ttft_timeout noise
      // (not a detection or SNR question) can widen it without hand-editing this file.
      ...(argument('--ttft-ms', '') ? { ttftMs: Number(argument('--ttft-ms', '')) } : {}),
      // Omitted entirely (not 0, not null) on a bounded run with no explicit --max-tokens -- see
      // resolveEvalMaxTokens's doc comment. Spreading conditionally keeps modelOptions identical
      // to before this fix whenever a cap does apply.
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      // Production's full hard-ban list, not a hand-picked subset. The old `['deepinfra']`
      // literal let providers production always excludes (novita, together, parasail,
      // openinference, ...) serve eval traffic -- observed live 2026-08-19: two 60s stalls
      // (DigitalOcean, OpenInference) and three prod-banned providers routed in a single
      // 9-fixture pass. A harness that routes differently from production cannot measure it.
      // stream: true preserved from #139 (SSE required on review preflight).
      openRouterPolicy: { allowedModels: [], fallbackModels: [], ignoredProviders: [...HARD_BANNED_PROVIDER_SLUGS], providerRouting: { ignore: [...HARD_BANNED_PROVIDER_SLUGS] }, timeoutMs: 90_000, stream: true },
    },
  });

  const report = {
    schemaVersion: 'testing-charter-eval-report-v1',
    fixture: path.relative(root, fixturePath),
    model,
    path: bounded ? 'bounded' : 'legacy',
    // null means "no explicit ceiling" -- the same uncapped behavior production's bounded engine
    // actually runs with. Recorded so a report is self-documenting about which mode produced it,
    // rather than requiring the reader to know this flag's default changed by path.
    maxTokens: maxTokens ?? null,
    repetitions,
    arms: arms.map((arm) => summarizeArm(rows, arm.id)),
    perFixture: summarizePerFixture(rows, fixtures),
  };
  const outputPath = argument('--out', '');
  const markdown = renderMarkdownReport(report);
  if (outputPath) {
    const resolvedOutputPath = path.resolve(root, outputPath);
    fs.writeFileSync(resolvedOutputPath, `${JSON.stringify({ ...report, rows }, null, 2)}\n`);
    // Sibling .md next to the .json --out, matching src/evaluation/evaluationArtifacts.js's own
    // json+md pairing convention -- the operator asked for a table readable in a PR body, and a
    // PR body quotes a file, not a stdout stream.
    const markdownPath = resolvedOutputPath.replace(/\.json$/u, '') + '.md';
    fs.writeFileSync(markdownPath, `${markdown}\n`);
  }
  // JSON stays first and unchanged (testing-charter-promotion-gate.mjs and any other machine
  // reader parse the --out FILE, never this stdout stream, but keeping the JSON block intact and
  // first is the conservative choice regardless). The markdown table is appended after it so a
  // human running this directly in a terminal sees the readable summary too.
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${markdown}`);
  const candidate = report.arms.find((arm) => arm.arm === 'candidate');
  return candidate && candidate.outputContractBreaches > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
