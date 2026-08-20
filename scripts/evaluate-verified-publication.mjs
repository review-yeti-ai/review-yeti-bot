#!/usr/bin/env node
/**
 * Three-arm verified-publication evaluation over the testing-charter corpus.
 *
 *   baseline  — the frozen pre-depth-probe charter, bounded investigation path (live lanes).
 *   candidate — the current deep charter, bounded investigation path (live lanes).
 *   verified  — the SAME candidate lane rows, with the independent falsification stage
 *               (src/review/findingFalsification.js) applied to each row's findings before
 *               grading. Only CONFIRM survives; REFUTE and ABSTAIN withhold.
 *
 * The verified arm is deliberately paired with the candidate arm rather than re-running lanes:
 * the product stage runs on lane outputs, not on fresh lanes, and pairing measures the
 * verifier's marginal effect on identical hypotheses instead of burying it in lane variance.
 *
 * Grading stays structural (the same expectedPaths + mustMatch contract the testing-charter
 * harness uses) — no LLM grades an LLM anywhere in this harness. The falsification stage is a
 * product stage; its model calls are the thing under measurement, not the measurement itself.
 *
 * Offline by default: without OPENROUTER_API_KEY, `lanes` and `verify` exit 0 with not_run.
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

import {
  evaluateTestingCharter,
  resolveEvalMaxTokens,
  reviewWithBoundedInvestigation,
  summarizeArm,
  summarizePerFixture,
} from './evaluate-testing-charter.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { HARD_BANNED_PROVIDER_SLUGS } = require(path.join(root, '.github/workflows/pipelines/openRouterPolicy.js'));
const { runFindingFalsification } = require(path.join(root, 'src/review/findingFalsification.js'));

const DEFAULT_FIXTURE = 'tests/fixtures/testing-charter/evaluation-matrix.json';
const DEFAULT_BASELINE_CHARTER = 'tests/fixtures/testing-charter/baseline-charter.txt';

function argument(name, fallback, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

/**
 * Same structural detection contract as the testing-charter harness (anchor to an expected path
 * AND satisfy every mustMatch concept group). Mirrored here because the harness does not export
 * it; the shapes are pinned by tests/unit/verifiedPublicationEval.test.ts so drift breaks red.
 */
export function findingMatchesFixture(finding, fixture) {
  const anchored = fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected));
  if (!anchored) return false;
  const text = [finding.title, finding.body, finding.suggestion].filter(Boolean).join('\n').toLowerCase();
  return fixture.mustMatch.every((group) => group.some((token) => text.includes(token)));
}

export function gradeFindings(fixture, findings, errored) {
  if (fixture.category === 'clean') {
    return { errored, falsePositive: !errored && findings.length > 0, detected: false, anchored: false, findings: findings.length };
  }
  return {
    errored,
    falsePositive: false,
    detected: !errored && findings.some((finding) => findingMatchesFixture(finding, fixture)),
    anchored: !errored && findings.some((finding) => fixture.expectedPaths.some((expected) => String(finding.path || '').endsWith(expected))),
    findings: findings.length,
  };
}

/** Wilson 95% interval, matching the harness's own reporting. */
export function wilson(hits, total) {
  if (!total) return null;
  const z = 1.96;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Number(Math.max(0, centre - spread).toFixed(4)), Number(Math.min(1, centre + spread).toFixed(4))];
}

function loadMatrix(argv = process.argv) {
  const fixturePath = path.resolve(root, argument('--fixture', DEFAULT_FIXTURE, argv));
  const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const only = String(argument('--fixtures', '', argv)).split(',').map((token) => token.trim()).filter(Boolean);
  if (only.length > 0) matrix.fixtures = matrix.fixtures.filter((fixture) => only.includes(fixture.id));
  return { matrix, fixturePath };
}

function buildModelOptions(argv = process.argv) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = argument('--model', process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731', argv);
  const maxTokens = resolveEvalMaxTokens({ argv, bounded: true, fallback: 4_096 });
  return {
    apiKey,
    model,
    maxAttempts: Number(argument('--max-attempts', 2, argv)),
    timeoutMs: Number(argument('--timeout-ms', 90_000, argv)),
    ...(argument('--ttft-ms', '', argv) ? { ttftMs: Number(argument('--ttft-ms', '', argv)) } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    openRouterPolicy: {
      allowedModels: [],
      fallbackModels: [],
      ignoredProviders: [...HARD_BANNED_PROVIDER_SLUGS],
      providerRouting: { ignore: [...HARD_BANNED_PROVIDER_SLUGS] },
      timeoutMs: 90_000,
      stream: true,
    },
  };
}

/**
 * Phase 1: live lanes for one arm, capturing FULL findings per row (the harness row keeps only
 * titles). Keyed by the unique per-row prNumber the harness already synthesizes.
 */
export async function runLanesArm({ matrix, armId, charter, persona, repetitions, concurrency, modelOptions, reviewImplementation = reviewWithBoundedInvestigation }) {
  const captured = new Map();
  const capturingReview = async (personaArg, files, prContext, sessionContext, options) => {
    const result = await reviewImplementation(personaArg, files, prContext, sessionContext, options);
    captured.set(String(prContext.prNumber), Array.isArray(result?.findings) ? result.findings : []);
    return result;
  };
  const { rows, fixtures } = await evaluateTestingCharter(matrix, {
    repetitions,
    concurrency,
    arms: [{ id: armId, persona, charter }],
    reviewWithModel: capturingReview,
    modelOptions,
  });
  return {
    fixtures,
    rows: rows.map((row) => ({
      ...row,
      findingsDetail: captured.get(`testing-charter-${row.arm}-${row.repetition}-${row.fixtureId}`) || [],
    })),
  };
}

/**
 * Phase 2: apply the falsification stage to captured candidate rows. Errored lane rows pass
 * through unchanged (the verifier never runs on a lane that produced nothing); rows with
 * findings get live verifier calls and are re-graded on the confirmed subset only.
 */
export async function verifyCandidateRows({ rows, matrix, falsifyTurnFactory, armId = 'verified', concurrency = 3 }) {
  const fixturesById = new Map(matrix.fixtures.map((fixture) => [fixture.id, fixture]));
  const verifiedRows = [];
  const verifierStats = { rowsVerified: 0, hypotheses: 0, confirmed: 0, refuted: 0, abstained: 0, unavailable: 0, verifierLatencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, costUSD: 0 } };
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

export function buildFalsifyTurnFactory({ modelOptions, modelClient }) {
  return ({ row, fixture }) => async ({ messages, signal }) => pipeline.callPersonaModelTurn({
    persona: { id: 'finding-falsification', name: 'Finding Falsification' },
    prContext: { repo: 'review-yeti-ai/review-yeti-bot', prNumber: `verify-${row.arm}-${row.repetition}-${fixture.id}`, title: fixture.title },
    sessionContext: null,
    messages,
    options: { ...modelOptions, ...(modelClient ? { modelClient } : {}) },
    signal,
  });
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
    if (!process.env.OPENROUTER_API_KEY) {
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
    if (!process.env.OPENROUTER_API_KEY) {
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
    const rows = readShards(argument('--rows', ''));
    const arms = [...new Set(rows.map((row) => row.arm))];
    const report = {
      schemaVersion: 'verified-publication-report-v1',
      fixture: path.relative(root, fixturePath),
      arms: arms.map((armId) => armReport(rows, armId)),
      perFixture: summarizePerFixture(rows, matrix.fixtures),
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
