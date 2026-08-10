#!/usr/bin/env node
import fs from 'node:fs';

const REQUIRED_SCENARIOS = Object.freeze([
  'repeated-pr-feedback-transitions', 'session-recap-exact-head', 'stale-head-rejected',
  'provider-failure-fail-open', 'compaction-bounded', 'otel-receipt-redacted',
  'mcp-poisoning-rejected', 'lease-loss-fenced', 'replay-dead-letter-authorized', 'secret-free-receipts',
]);
const SECRET = /(authorization|api[-_]?key|token|secret|password|private[-_]?key|credential|workspace[-_]?jwt)/iu;

function unsafe(value, key = '') {
  if (SECRET.test(key) && value !== '<redacted>') return true;
  if (typeof value === 'string') return /(?:bearer\s+|sk-|ghp_|https?:\/\/[^\s]+\?(?:[^\s]*token|[^\s]*key))/iu.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([nestedKey, nestedValue]) => unsafe(nestedValue, nestedKey));
}

export function evaluateOfflinePromotionMatrix(matrix = {}) {
  const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
  const byId = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  const failures = [];
  if (matrix.schemaVersion !== 'review-intelligence-eval-v1' || matrix.liveEvidence !== false) failures.push('matrix_contract');
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(String(matrix.vcrFixture || ''))) failures.push('vcr_fixture');
  for (const id of REQUIRED_SCENARIOS) {
    const scenario = byId.get(id);
    const assertions = scenario?.assertions && typeof scenario.assertions === 'object' ? Object.values(scenario.assertions) : [];
    if (!scenario || scenario.offline !== true || assertions.length === 0 || assertions.some((value) => value !== true) || unsafe(scenario.receipt)) failures.push(id);
  }
  if (byId.size !== scenarios.length) failures.push('duplicate_scenario');
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
  const result = evaluateOfflinePromotionMatrix(JSON.parse(fs.readFileSync(fixture, 'utf8')));
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exitCode = 1;
}
