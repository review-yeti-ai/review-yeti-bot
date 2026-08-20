#!/usr/bin/env node
// API-2902: the live, model-backed release gate. Every other lane in `npm run test:all`
// (including test:intelligence-eval and test:bounded-review-eval) replays recorded cassettes --
// deliberately, per TEST_INFRA.md's fail-closed replay boundary -- and is credential-free by
// design. None of them proves the panel still produces a real finding against a REAL provider
// today. This script does exactly one thing: run the `security` persona through the real bounded
// investigation path (runPersonaInvestigation + buildInvestigationMessages -- the same engine
// review-pipeline.js's main() runs on every real PR review) against two small fixture diffs and
// assert the shape of the result.
//
//   - tests/fixtures/e2e-review-gate/red-known-bug.diff plants an unambiguous P0 (a live-looking
//     Stripe secret key literal, squarely inside the security persona's own charter) and must
//     produce >= 1 finding on a completed (non-ERROR) lane.
//   - tests/fixtures/e2e-review-gate/green-clean.diff is a trivial, safe refactor and must
//     produce 0 findings on a completed lane.
//
// Docs/RELEASING.md documents that `v1` must not advance unless this gate is green for the
// candidate commit. `release.yml` calls this workflow as a hard `needs:` dependency for
// `channel=v1` releases (`v1-rc` is unaffected) -- see that file's `e2e_gate` job.
//
// This never fabricates a pass: if OPENROUTER_API_KEY (or an explicit override) is not
// configured, the script exits non-zero with a `status: "fail"` JSON line explaining why -- the
// same shape a real failure would have -- instead of a soft "not_run" skip that could be misread
// as evidence the gate ran clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const { resolveOpenRouterPolicy } = require(path.join(root, '.github/workflows/pipelines/openRouterPolicy.js'));
const {
  summarizeFixtureResult,
  evaluateGate,
  resolveGateTransportBudget,
} = require(path.join(root, 'src/review/e2eReviewGate.js'));
const { runPersonaInvestigation: runBoundedPersonaInvestigation } = require(path.join(root, 'src/review/reviewInvestigation.js'));

const FIXTURE_DIR = path.join(root, 'tests/fixtures/e2e-review-gate');

const SCHEMA_VERSION = 'e2e-review-gate-v1';

function fail(reason, extra = {}) {
  console.error(JSON.stringify({ schemaVersion: SCHEMA_VERSION, status: 'fail', reason, ...extra }));
  process.exitCode = 1;
}

/**
 * Drives the actual production review path -- runPersonaInvestigation (src/review/
 * reviewInvestigation.js) + buildInvestigationMessages -- instead of the legacy single-shot
 * reviewWithModel contract this gate used before the legacy path was deleted (review-pipeline.js's
 * boundedMode branch is now the only branch; see scripts/evaluate-testing-charter.mjs's
 * reviewWithBoundedInvestigation for the same adapter pattern). Evidence tooling is disabled: both
 * fixtures are self-contained diffs, so a real evidence registry would add nothing but a repo
 * checkout this gate does not have. callPersonaModelTurn (the modelTurn implementation below)
 * already sets investigationSchema: true unconditionally, so the strict review_investigation JSON
 * schema applies without extra wiring here.
 */
async function runFixture({ name, file, persona, model, apiKey, baseUrl, openRouterPolicy }) {
  const diffText = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
  const diffFiles = pipeline.parseDiff(diffText);
  if (diffFiles.length === 0) throw new Error(`fixture ${file} parsed to zero changed files`);

  const prContext = {
    repo: 'review-yeti-ai/review-yeti-bot',
    prNumber: 'e2e-review-gate',
    headSha: 'e'.repeat(40),
  };
  const identity = {
    repository: prContext.repo,
    prNumber: 1,
    baseSha: 'a'.repeat(40),
    headSha: prContext.headSha,
  };
  const evidenceRegistry = { capabilities: { enabled: false, readOnly: true, tools: [] }, call: async () => ({ status: 'unavailable' }) };
  const manifest = `<review_units>${JSON.stringify(diffFiles.map((diffFile) => ({ path: diffFile.path })))}</review_units>`;
  const modelOptions = {
    model,
    apiKey,
    baseUrl,
    maxAttempts: openRouterPolicy.maxAttempts,
    timeoutMs: openRouterPolicy.timeoutMs,
    ttftMs: openRouterPolicy.ttftMs,
    reasoningEffort: 'max',
    openRouterPolicy,
  };

  const run = await runBoundedPersonaInvestigation({
    identity,
    persona,
    manifest,
    diffFiles,
    evidenceRegistry,
    modelTurn: (turnArgs) => pipeline.callPersonaModelTurn({
      persona,
      prContext,
      sessionContext: {},
      messages: turnArgs.messages,
      options: modelOptions,
      turn: turnArgs.turn,
      finalOnly: turnArgs.finalOnly,
      signal: turnArgs.signal,
    }),
  });

  return summarizeFixtureResult(run.personaResult, name);
}

async function main() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const model = String(process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731').trim();
  const baseUrl = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').trim();
  const { timeoutMs, ttftMs } = resolveGateTransportBudget(process.env);
  const openRouterPolicy = resolveOpenRouterPolicy({}, {
    OPENROUTER_TIMEOUT_MS: String(timeoutMs),
    OPENROUTER_TTFT_MS: String(ttftMs),
    OPENROUTER_MAX_ATTEMPTS: '2',
    OPENROUTER_STRUCTURED_OUTPUT: 'strict',
  });

  if (!apiKey) {
    fail('OPENROUTER_API_KEY is not configured; refusing to claim a passing gate without live provider evidence. See docs/RELEASING.md for the wiring TODO.');
    return;
  }

  const pipelineModule = pipeline;
  const securityPersona = pipelineModule.PERSONA_CHARTERS.find((persona) => persona.id === 'security');
  if (!securityPersona) {
    fail('security persona charter not found in PERSONA_CHARTERS');
    return;
  }

  let red;
  let green;
  try {
    red = await runFixture({
      name: 'red-known-bug', file: 'red-known-bug.diff', persona: securityPersona, model, apiKey, baseUrl, openRouterPolicy,
    });
    green = await runFixture({
      name: 'green-clean', file: 'green-clean.diff', persona: securityPersona, model, apiKey, baseUrl, openRouterPolicy,
    });
  } catch (error) {
    fail(`live model call failed: ${error?.message || error}`);
    return;
  }

  const gate = evaluateGate({ red, green });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    status: gate.status,
    model,
    fixtures: { red: gate.red, green: gate.green },
  };

  if (gate.status === 'pass') {
    console.log(JSON.stringify(payload));
  } else {
    console.error(JSON.stringify(payload));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  fail(`unexpected error: ${error?.message || error}`);
});
