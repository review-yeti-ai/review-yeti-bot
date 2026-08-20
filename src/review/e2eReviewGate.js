'use strict';

// API-2902: pure, deterministic classification logic for the live E2E review gate
// (scripts/e2e-review-gate.mjs). Split out so the red/green pass-fail rules can be unit tested
// without a live provider call -- the live script itself stays a thin IO/orchestration wrapper
// around this.

const DEFAULT_GATE_TIMEOUT_MS = 90_000;
const DEFAULT_GATE_TTFT_MS = 30_000;

function boundedPositiveInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return Math.max(min, Math.min(max, fallback));
  }
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.max(min, Math.min(max, resolved));
}

/**
 * The release canary uses maximum reasoning effort, so its total completion budget is longer
 * than its liveness budget. A reasoning token is still a first token: TTFT remains short while
 * a healthy stream gets enough time to finish.
 */
function resolveGateTransportBudget(env = {}) {
  const safeEnv = env || {};
  const timeoutMs = boundedPositiveInteger(
    safeEnv.E2E_REVIEW_GATE_TIMEOUT_MS,
    DEFAULT_GATE_TIMEOUT_MS,
    500,
    600_000,
  );
  const ttftMs = boundedPositiveInteger(
    safeEnv.E2E_REVIEW_GATE_TTFT_MS,
    DEFAULT_GATE_TTFT_MS,
    500,
    timeoutMs,
  );
  return { timeoutMs, ttftMs };
}

/**
 * A completed (non-ERROR) lane result from `reviewWithModel`, reduced to the fields this gate
 * cares about.
 * @param {{decision?: string, findings?: unknown[]}} result
 * @param {string} name
 */
function summarizeFixtureResult(result, name) {
  const completed = result?.decision !== 'ERROR';
  const findingCount = Array.isArray(result?.findings) ? result.findings.length : 0;
  return {
    name,
    completed,
    findingCount,
    decision: result?.decision,
    provider: result?.provider,
    model: result?.model,
    ...(completed ? {} : { error: result?.error || 'unknown' }),
  };
}

/**
 * The red fixture plants an unambiguous, in-charter defect: it must produce at least one
 * finding on a lane that actually completed. A lane that errored (`decision: 'ERROR'`) never
 * counts as a pass here, even with zero findings -- that is an infra failure of the gate itself,
 * not evidence the panel is healthy.
 */
function redFixtureOk(summary) {
  return Boolean(summary.completed && summary.findingCount >= 1);
}

/**
 * The green fixture is a trivial, safe change: it must produce zero findings on a completed
 * lane. A lane that errored is still a gate failure (never silently treated as "0 findings,
 * fine") -- an ERROR lane proves nothing about whether the panel avoids false positives.
 */
function greenFixtureOk(summary) {
  return Boolean(summary.completed && summary.findingCount === 0);
}

/**
 * @param {{red: ReturnType<typeof summarizeFixtureResult>, green: ReturnType<typeof summarizeFixtureResult>}} fixtures
 */
function evaluateGate({ red, green }) {
  const redOk = redFixtureOk(red);
  const greenOk = greenFixtureOk(green);
  return {
    status: redOk && greenOk ? 'pass' : 'fail',
    red: { ...red, expected: '>=1 finding, completed lane', ok: redOk },
    green: { ...green, expected: '0 findings, completed lane', ok: greenOk },
  };
}

module.exports = {
  resolveGateTransportBudget,
  summarizeFixtureResult,
  redFixtureOk,
  greenFixtureOk,
  evaluateGate,
};
