#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REQUIRED_SCENARIOS = Object.freeze([
  'repeated-pr-feedback-transitions', 'session-recap-exact-head', 'stale-head-rejected',
  'provider-failure-fail-open', 'compaction-bounded', 'otel-receipt-redacted',
  'mcp-poisoning-rejected', 'lease-loss-fenced', 'replay-dead-letter-authorized', 'secret-free-receipts',
]);
const SECRET = /(authorization|api[-_]?key|token|secret|password|private[-_]?key|credential|workspace[-_]?jwt)/iu;
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTELLIGENCE_FIXTURE = 'intelligence-evaluation';

function unsafe(value, key = '') {
  if (key !== 'secret-free-receipts' && SECRET.test(key) && value !== '<redacted>') return true;
  if (typeof value === 'string') return /(?:bearer\s+|sk-|ghp_|https?:\/\/[^\s]+\?(?:[^\s]*token|[^\s]*key))/iu.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([nestedKey, nestedValue]) => unsafe(nestedValue, nestedKey));
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

function scenarioSemantics(id, fixture) {
  const expected = fixture?.expected || {};
  const github = fixture?.github?.responses || {};
  const model = fixture?.model?.responses || {};
  const memory = fixture?.memory?.providerResponse || {};
  switch (id) {
    case 'repeated-pr-feedback-transitions':
      return github.ledger === 'exact-head-deduplicated' && expected.verdict === 'SHIP' && expected.publishedReviewCount === 1;
    case 'session-recap-exact-head':
      return github.head === 'exact' && /^[a-f0-9]{40}$/u.test(fixture?.event?.headSha || '') && expected.coverageStatus === 'complete';
    case 'stale-head-rejected':
      return fixture?.evaluation?.scenarioResults?.[id]?.receipt?.reasonCode === 'stale_head';
    case 'provider-failure-fail-open':
      return memory.status === 'unavailable' && memory.failOpen === true && expected.outboxState === 'pending';
    case 'compaction-bounded':
      return model.compacted === true && fixture?.evaluation?.scenarioResults?.[id]?.receipt?.maxEntries === 40;
    case 'otel-receipt-redacted':
      return fixture?.evaluation?.scenarioResults?.[id]?.receipt?.exporter === 'none';
    case 'mcp-poisoning-rejected':
      return fixture?.evaluation?.scenarioResults?.[id]?.receipt?.reasonCode === 'tool_not_allowlisted';
    case 'lease-loss-fenced':
      return fixture?.evaluation?.scenarioResults?.[id]?.receipt?.fence === 4;
    case 'replay-dead-letter-authorized':
      return fixture?.evaluation?.scenarioResults?.[id]?.receipt?.attempts === 3;
    case 'secret-free-receipts':
      return unsafe(fixture) === false && fixture?.evaluation?.scenarioResults?.[id]?.receipt?.provider === 'fixture';
    default:
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

export function evaluateOfflinePromotionMatrix(matrix = {}, suppliedInputs) {
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
  for (const id of REQUIRED_SCENARIOS) {
    const scenario = byId.get(id);
    const fixtureResult = workflow?.evaluation?.scenarioResults?.[id];
    const expected = scenario?.expected;
    if (!scenario || scenario.offline !== true || !expected || expected.status !== fixtureResult?.status
      || !equalJson(expected.receipt, fixtureResult?.receipt) || !sameIdentity(fixtureResult?.identity, workflow?.event)
      || !scenarioSemantics(id, workflow) || unsafe(fixtureResult?.receipt)) failures.push(id);
  }
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
  const result = evaluateOfflinePromotionMatrix(matrix, loadOfflineEvaluationInputs(matrix));
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exitCode = 1;
}
