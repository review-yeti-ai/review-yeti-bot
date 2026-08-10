#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReviewIntelligenceScenarioRunner } from './review-intelligence-scenarios.mjs';

const REQUIRED_SCENARIOS = Object.freeze([
  'repeated-pr-feedback-transitions', 'session-recap-exact-head', 'stale-head-rejected',
  'provider-failure-fail-open', 'compaction-bounded', 'otel-receipt-redacted',
  'mcp-poisoning-rejected', 'lease-loss-fenced', 'replay-dead-letter-authorized', 'secret-free-receipts',
]);
const SECRET = /(authorization|api[-_]?key|token|secret|password|private[-_]?key|credential|workspace[-_]?jwt)/iu;
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTELLIGENCE_FIXTURE = 'intelligence-evaluation';

function unsafe(value, path = []) {
  const key = path.at(-1) || '';
  const scenarioIdContainer = path.length === 3 && path[0] === 'evaluation' && path[1] === 'scenarioResults';
  if (!(scenarioIdContainer && key === 'secret-free-receipts') && SECRET.test(key) && value !== '<redacted>') return true;
  if (typeof value === 'string') return /(?:bearer\s+|sk-|ghp_|https?:\/\/[^\s]+\?(?:[^\s]*token|[^\s]*key))/iu.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([nestedKey, nestedValue]) => unsafe(nestedValue, [...path, nestedKey]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeFixtureId(value) {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(String(value || ''));
}

function sameIdentity(left, right) {
  return left?.repository === right?.repository
    && left?.prNumber === right?.prNumber
    && left?.headSha === right?.headSha;
}

function cassetteIsValid(cassette, scenarioIds) {
  if (!cassette || typeof cassette !== 'object' || cassette.version !== 2
    || cassette.fixtureId !== 'offline-review-intelligence' || cassette.provider !== 'review-intelligence'
    || !Array.isArray(cassette.allowedOrigins) || cassette.allowedOrigins.length === 0
    || !Array.isArray(cassette.interactions) || cassette.interactions.length === 0
    || !Array.isArray(cassette.scenarioIds) || !equalJson([...cassette.scenarioIds].sort(), [...scenarioIds].sort())
    || unsafe(cassette)) return false;
  try {
    return cassette.allowedOrigins.every((origin) => {
      const parsed = new URL(origin);
      return parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash;
    });
  } catch (_) {
    return false;
  }
}

export function loadOfflineEvaluationInputs(matrix = {}, { root = SCRIPT_ROOT } = {}) {
  const inputs = { workflowFixture: null, cassette: null, cassetteDigest: null, errors: [] };
  const workflowPath = path.join(root, 'tests/fixtures/review-workflows', `${INTELLIGENCE_FIXTURE}.json`);
  try {
    inputs.workflowFixture = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  } catch (_) {
    inputs.errors.push('workflow_fixture');
  }
  if (!safeFixtureId(matrix.vcrFixture)) {
    inputs.errors.push('vcr_fixture');
    return inputs;
  }
  const cassettePath = path.join(root, 'tests/fixtures/cassettes/intelligence', `${matrix.vcrFixture}.json`);
  try {
    const raw = fs.readFileSync(cassettePath, 'utf8');
    inputs.cassette = JSON.parse(raw);
    inputs.cassetteDigest = sha256(raw);
  } catch (_) {
    inputs.errors.push('vcr_fixture');
  }
  return inputs;
}

export async function evaluateOfflinePromotionMatrix(matrix = {}, suppliedInputs) {
  const inputs = suppliedInputs || loadOfflineEvaluationInputs(matrix);
  const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
  const byId = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  const failures = [];
  if (matrix.schemaVersion !== 'review-intelligence-eval-v1' || matrix.liveEvidence !== false) failures.push('matrix_contract');
  if (!safeFixtureId(matrix.vcrFixture) || !/^[a-f0-9]{64}$/u.test(String(matrix.vcrSha256 || ''))
    || inputs.errors.includes('vcr_fixture') || !cassetteIsValid(inputs.cassette, REQUIRED_SCENARIOS)
    || inputs.cassetteDigest !== matrix.vcrSha256) failures.push('vcr_fixture');
  const workflow = inputs.workflowFixture;
  if (inputs.errors.includes('workflow_fixture') || workflow?.id !== INTELLIGENCE_FIXTURE
    || !sameIdentity(workflow?.event, { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) })
    || workflow?.config?.provider !== 'mem0') failures.push('workflow_fixture');
  let runner = null;
  try { runner = createReviewIntelligenceScenarioRunner({ workflowFixture: workflow, cassette: inputs.cassette }); }
  catch (_) { failures.push('vcr_fixture'); }
  for (const id of REQUIRED_SCENARIOS) {
    const scenario = byId.get(id);
    const expected = scenario?.expected;
    try {
      if (!runner) throw new Error('scenario runner unavailable');
      const actual = await runner.run(id);
      if (!scenario || scenario.offline !== true || !expected || expected.status !== actual?.status
        || !equalJson(expected.receipt, actual?.receipt) || !sameIdentity(actual?.identity, workflow?.event)
        || unsafe(actual?.receipt)) failures.push(id);
    } catch (error) {
      if (/cassette/iu.test(String(error?.message || ''))) failures.push('vcr_fixture');
      failures.push(id);
    }
  }
  try { runner?.assertComplete(); } catch (_) { failures.push('vcr_fixture'); }
  if (byId.size !== scenarios.length || scenarios.length !== REQUIRED_SCENARIOS.length) failures.push('duplicate_scenario');
  const passed = REQUIRED_SCENARIOS.filter((id) => !failures.includes(id)).length;
  return {
    status: failures.length ? 'fail' : 'pass',
    deterministic: true,
    liveEvidence: false,
    score: Number((passed / REQUIRED_SCENARIOS.length).toFixed(4)),
    scenarios: REQUIRED_SCENARIOS,
    failures,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith('evaluate-review-intelligence.mjs')) {
  const fixture = argument('--fixture');
  if (!fixture) {
    console.error('Usage: evaluate-review-intelligence.mjs --fixture <offline-matrix.json>');
    process.exit(2);
  }
  const matrix = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const result = await evaluateOfflinePromotionMatrix(matrix, loadOfflineEvaluationInputs(matrix));
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exitCode = 1;
}
