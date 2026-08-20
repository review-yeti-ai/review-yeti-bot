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
  };
  const evidenceRegistry = { capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable' }) };
  const manifest = `<review_units>${JSON.stringify((Array.isArray(files) ? files : []).map((file) => ({ path: file.path })))}</review_units>`;
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

/** Findings text a concept group is matched against. Lower-cased; suggestion included. */
function findingText(finding = {}) {
  return [finding.title, finding.body, finding.suggestion].filter(Boolean).join('\n').toLowerCase();
}

/**
 * A finding matches a fixture when it anchors to an expected path and satisfies every concept
 * group. Groups are OR within, AND across: the finding must name each required idea somehow,
 * which no amount of generic "add more tests" phrasing can accidentally do.
 */
function findingMatchesFixture(finding, fixture) {
  const anchored = fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected));
  if (!anchored) return false;
  const text = findingText(finding);
  return fixture.mustMatch.every((group) => group.some((token) => text.includes(token)));
}

function gradeRun(fixture, result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const errored = result?.decision === 'ERROR' || Boolean(result?.error);
  if (fixture.category === 'clean') {
    return {
      errored,
      // Any finding at all on a control is a false positive: both controls are changes the
      // charter's "do not flag" list names explicitly.
      falsePositive: !errored && findings.length > 0,
      detected: false,
      anchored: false,
      findings: findings.length,
    };
  }
  return {
    errored,
    falsePositive: false,
    detected: !errored && findings.some((finding) => findingMatchesFixture(finding, fixture)),
    // Weaker signal kept for diagnosis: the lane looked at the right file but did not name the
    // mechanism. A jump in `anchored` with flat `detected` means the probes aimed attention
    // without changing the conclusion.
    anchored: !errored && findings.some((finding) => fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected))),
    findings: findings.length,
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
  const latencies = selected.map((row) => row.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const detectedCount = defects.filter((row) => row.detected).length;
  return {
    arm: armId,
    runs: selected.length,
    erroredRuns: selected.filter((row) => row.errored).length,
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
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUSD: Number(usage.costUSD.toFixed(6)),
    latencyMsMedian: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    latencyMsP95: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null,
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
    let result;
    try {
      result = await reviewWithModel(
        { ...arm.persona, charter: arm.charter },
        fixture.files,
        { repo: 'review-yeti-ai/review-yeti-bot', prNumber: `testing-charter-${arm.id}-${repetition}-${fixture.id}`, title: fixture.title },
        null,
        modelOptions,
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
      maxTokens: Number(argument('--max-tokens', 4_096)),
      openRouterPolicy: { allowedModels: [], fallbackModels: [], ignoredProviders: ['deepinfra'], providerRouting: { ignore: ['deepinfra'] }, timeoutMs: 90_000, stream: false },
    },
  });

  const report = {
    schemaVersion: 'testing-charter-eval-report-v1',
    fixture: path.relative(root, fixturePath),
    model,
    path: bounded ? 'bounded' : 'legacy',
    repetitions,
    arms: arms.map((arm) => summarizeArm(rows, arm.id)),
    perFixture: summarizePerFixture(rows, fixtures),
  };
  const outputPath = argument('--out', '');
  if (outputPath) fs.writeFileSync(path.resolve(root, outputPath), `${JSON.stringify({ ...report, rows }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  const candidate = report.arms.find((arm) => arm.arm === 'candidate');
  return candidate && candidate.outputContractBreaches > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
