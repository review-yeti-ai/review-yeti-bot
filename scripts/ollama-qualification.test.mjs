import test from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASELINE_PROFILE,
  CANDIDATE_PROFILE,
  CANDIDATE_TIMEOUT_MS,
  FIXTURE_IDS,
  QUALIFICATION_SCHEMA,
  buildArmEnvironment,
  buildBaselineQualityGate,
  buildCandidateQualityGate,
  buildQualificationReceipt,
  buildTransportHandoff,
  classifyFailure,
  runQualification,
  summarizeEvaluation,
  summarizeFixtureOutcomes,
  validateQualificationInput,
  verifyPullRequest,
} from './ollama-qualification.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
const input = {
  confirm: 'QUALIFY',
  repository: 'exampleorg/example-review-actions',
  prNumber: 119,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  botSha: 'c'.repeat(40),
  centralSha: 'd'.repeat(40),
  botRoot: '/tmp/review-yeti-bot',
};
const DEFECT_FIXTURE_IDS = new Set([
  'vacuous-default-value-test',
  'format-evadable-absence-guard',
  'dual-cause-diagnostic-named-for-one',
  'active-skip-marker-left-in-suite',
  'shared-module-state-order-dependent-test',
  'elixir-second-error-cause-untested',
  'java-fixed-sleep-for-asynchronous-state',
]);

function makeFixtureRows({ missed = [], falsePositives = [], malformed = [] } = {}) {
  const missedIds = new Set(missed);
  const falsePositiveIds = new Set(falsePositives);
  const malformedIds = new Set(malformed);
  return FIXTURE_IDS.map((fixtureId, index) => {
    const defect = DEFECT_FIXTURE_IDS.has(fixtureId);
    return {
      fixtureId,
      category: defect ? 'defect' : 'clean',
      detected: defect && !missedIds.has(fixtureId),
      falsePositive: !defect && falsePositiveIds.has(fixtureId),
      errored: false,
      latencyMs: 10 + index,
      usage: { costUSD: 0 },
      attemptCount: malformedIds.has(fixtureId) ? 2 : 1,
      retryReasons: malformedIds.has(fixtureId) ? ['malformed_output'] : [],
      outputShape: 'direct_json_object',
      finishReason: 'stop',
      responseMode: 'stream',
      findingsSource: 'content',
      contentPresent: true,
      reasoningPresent: false,
      contentSizeBucket: 'tiny',
      reasoningSizeBucket: 'empty',
      responseAttempts: malformedIds.has(fixtureId)
        ? [{
            attempt: 1,
            outcome: 'malformed_output',
            provider: 'ollama',
            transport: 'ollama',
            latencyMs: 90_000,
            responseStatus: 200,
            failureClass: 'malformed_output',
            reasoningEffort: 'high',
            maxOutputTokens: 24_576,
            outputTokens: 24_576,
            outputShape: 'no_json',
            finishReason: 'length',
            responseMode: 'stream',
            findingsSource: 'none',
            contentPresent: false,
            reasoningPresent: true,
            contentSizeBucket: 'empty',
            reasoningSizeBucket: 'small',
          }, {
            attempt: 2,
            outcome: 'parsed',
            provider: 'ollama',
            transport: 'ollama',
            latencyMs: 1_000,
            responseStatus: 200,
            reasoningEffort: 'none',
            maxOutputTokens: 24_576,
            outputTokens: 12,
            outputShape: 'direct_json_object',
            finishReason: 'stop',
            responseMode: 'stream',
            findingsSource: 'content',
            contentPresent: true,
            reasoningPresent: false,
            contentSizeBucket: 'tiny',
            reasoningSizeBucket: 'empty',
          }]
        : [{
            attempt: 1,
            outcome: 'parsed',
            provider: 'ollama',
            transport: 'ollama',
            latencyMs: 10 + index,
            responseStatus: 200,
            reasoningEffort: 'high',
            maxOutputTokens: 24_576,
            outputTokens: 12,
            outputShape: 'direct_json_object',
            finishReason: 'stop',
            responseMode: 'stream',
            findingsSource: 'content',
            contentPresent: true,
            reasoningPresent: false,
            contentSizeBucket: 'tiny',
            reasoningSizeBucket: 'empty',
          }],
    };
  });
}

function makeArm(profile, options = {}) {
  return { profile, ...summarizeEvaluation({ rows: makeFixtureRows(options) }, 0) };
}

test('qualification input is fail-closed and requires immutable coordinates', () => {
  assert.deepEqual(validateQualificationInput(input).prNumber, 119);
  for (const [field, value] of [['confirm', 'yes'], ['repository', 'not-a-repository'], ['baseSha', 'short'], ['centralSha', 'short'], ['botRoot', 'relative']]) {
    const invalid = { ...input, [field]: value };
    assert.throws(() => validateQualificationInput(invalid), /required|must|confirm|repository|SHA|absolute/u);
  }
  assert.throws(() => validateQualificationInput({ ...input, headSha: input.baseSha }), /must differ/u);
});

test('only the explicit Ollama candidate profile narrows the current policy', () => {
  const baseline = buildTransportHandoff(policy, BASELINE_PROFILE);
  const candidate = buildTransportHandoff(policy, CANDIDATE_PROFILE);
  assert.deepEqual(baseline.map((transport) => transport.name), ['fireworks', 'ollama', 'openrouter-fallback']);
  assert.deepEqual(candidate.map((transport) => transport.name), ['ollama']);
  assert.equal(candidate[0].timeout_ms, CANDIDATE_TIMEOUT_MS);
  assert.equal(candidate[0].reasoning_effort, 'high');
  assert.equal(policy.review_yeti.transports.find((transport) => transport.name === 'ollama').timeout_ms, 90_000);
  assert.throws(() => buildTransportHandoff(policy, 'openrouter-primary'), /unsupported qualification profile/u);
});

test('candidate child environment removes unrelated provider credentials', () => {
  const handoff = buildTransportHandoff(policy, CANDIDATE_PROFILE);
  const environment = buildArmEnvironment({
    baseEnv: {
      FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
      OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      GITHUB_TOKEN: 'github-secret',
      QUALIFICATION_GH_TOKEN: 'qualification-token',
      GITHUB_EVENT_PATH: '/tmp/event.json',
    },
    handoff,
    arm: 'candidate',
    botSha: input.botSha,
    fixturePath: '/tmp/evaluation-matrix.json',
  });
  assert.equal(environment.OLLAMA_PR_REVIEW_API_KEY, 'ollama-secret');
  assert.equal(environment.FIREWORKS_PR_REVIEW_API_KEY, undefined);
  assert.equal(environment.OPENROUTER_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.QUALIFICATION_GH_TOKEN, undefined);
  assert.equal(environment.GITHUB_EVENT_PATH, undefined);
  assert.equal(environment.VITEST, 'true');
});

test('exact-head verification rejects drift without exposing response data', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha }, title: 'secret title' }),
    };
  };
  const verified = await verifyPullRequest({ ...input, token: 'token-secret', fetchImpl });
  assert.deepEqual(verified, { repository: input.repository, prNumber: input.prNumber, baseSha: input.baseSha, headSha: input.headSha });
  assert.equal(calls[0].url, `https://api.github.com/repos/${input.repository}/pulls/${input.prNumber}`);
  assert.equal(calls[0].authorization, 'Bearer token-secret');

  await assert.rejects(
    verifyPullRequest({ ...input, headSha: 'd'.repeat(40), token: 'token-secret', fetchImpl }),
    /exact-head verification failed/u,
  );
  await assert.rejects(
    verifyPullRequest({ ...input, token: '', fetchImpl }),
    /read-only GitHub token is required/u,
  );
  await assert.rejects(
    verifyPullRequest({ ...input, token: 'token-secret', fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /http_503/u,
  );
});

test('receipt is sanitized, baseline-authoritative, and never a promotion decision', () => {
  const receipt = buildQualificationReceipt({
    input,
    policy,
    runId: '123',
    now: '2026-08-25T00:00:00.000Z',
    baseline: makeArm(BASELINE_PROFILE),
    candidate: makeArm(CANDIDATE_PROFILE),
  });
  assert.deepEqual(receipt.fixture_ids, FIXTURE_IDS);
  assert.equal(receipt.schema, QUALIFICATION_SCHEMA);
  assert.equal(receipt.authoritative_arm, 'baseline');
  assert.deepEqual(receipt.implementation_refs, {
    central_action_sha: input.centralSha,
    review_yeti_bot_sha: input.botSha,
  });
  assert.equal(receipt.publication, 'none');
  assert.equal(receipt.provider_mutation, 'none');
  assert.equal(receipt.promotion_gate, 'manual_review_required');
  assert.equal(receipt.baseline_quality_gate.passed, true);
  assert.equal(receipt.candidate_quality_gate.passed, true);
  assert.equal(receipt.candidate_quality_gate.output_telemetry_complete, true);
  assert.equal(receipt.candidate_quality_gate.response_attempt_telemetry_complete, true);
  assert.equal(receipt.candidate_quality_gate.response_attempt_telemetry_consistent, true);
  assert.equal(receipt.candidate_quality_gate.stable_candidate_outputs, true);
  assert.equal(receipt.candidate_not_worse_on_defect_recall, true);
  assert.equal(receipt.candidate_eligible_for_next_step, true);
  assert.deepEqual(receipt.candidate_request_contract, {
    transport: 'ollama',
    timeout_ms: CANDIDATE_TIMEOUT_MS,
    connect_timeout_ms: 30_000,
    reasoning_effort: 'high',
    max_output_tokens: 'bot_default',
    repetitions: 1,
    concurrency: 1,
  });
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
  assert.equal(JSON.stringify(receipt).includes('findingsDetail'), false);
});

test('receipt eligibility fails closed on candidate quality regressions', () => {
  const base = makeArm(BASELINE_PROFILE);
  const clean = buildQualificationReceipt({ input, policy, baseline: base, candidate: makeArm(CANDIDATE_PROFILE), runId: 'quality-pass' });
  assert.equal(clean.candidate_eligible_for_next_step, true);

  const falsePositive = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { falsePositives: ['function-scoped-fixture-avoids-shared-state'] }),
    runId: 'quality-false-positive',
  });
  assert.equal(falsePositive.candidate_eligible_for_next_step, false);

  const missedDefect = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { missed: ['vacuous-default-value-test'] }),
    runId: 'quality-missed-defect',
  });
  assert.equal(missedDefect.candidate_eligible_for_next_step, false);

  const noDetections = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { missed: [...DEFECT_FIXTURE_IDS] }),
    runId: 'quality-no-detections',
  });
  assert.equal(noDetections.arms.candidate.detected_defect_runs, 0);
  assert.equal(noDetections.candidate_eligible_for_next_step, false);

  const malformedRecovery = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { malformed: ['shared-module-state-order-dependent-test'] }),
    runId: 'quality-malformed-recovery',
  });
  assert.equal(malformedRecovery.candidate_quality_gate.observed_malformed_output_recoveries, 1);
  assert.equal(malformedRecovery.candidate_eligible_for_next_step, false);

  const wrappedOutput = makeArm(CANDIDATE_PROFILE);
  wrappedOutput.fixture_outcomes[0] = { ...wrappedOutput.fixture_outcomes[0], output_shape: 'fenced_json_object' };
  const wrappedReceipt = buildQualificationReceipt({ input, policy, baseline: base, candidate: wrappedOutput });
  assert.equal(wrappedReceipt.candidate_quality_gate.output_telemetry_complete, true);
  assert.equal(wrappedReceipt.candidate_quality_gate.stable_candidate_outputs, false);
  assert.equal(wrappedReceipt.candidate_eligible_for_next_step, false);

  const truncatedCompletion = makeArm(CANDIDATE_PROFILE);
  truncatedCompletion.fixture_outcomes[0] = { ...truncatedCompletion.fixture_outcomes[0], finish_reason: 'length' };
  assert.equal(buildCandidateQualityGate(truncatedCompletion).stable_candidate_outputs, false);

  const missingOutputTelemetry = makeArm(CANDIDATE_PROFILE);
  delete missingOutputTelemetry.fixture_outcomes[0].content_size_bucket;
  assert.equal(buildCandidateQualityGate(missingOutputTelemetry).output_telemetry_complete, false);

  const missingAttemptTelemetry = makeArm(CANDIDATE_PROFILE);
  delete missingAttemptTelemetry.fixture_outcomes[0].response_attempts;
  assert.equal(buildCandidateQualityGate(missingAttemptTelemetry).response_attempt_telemetry_complete, false);
  assert.equal(buildCandidateQualityGate(missingAttemptTelemetry).passed, false);

  const incompleteAttemptTelemetry = makeArm(CANDIDATE_PROFILE);
  delete incompleteAttemptTelemetry.fixture_outcomes[0].response_attempts[0].max_output_tokens;
  assert.equal(buildCandidateQualityGate(incompleteAttemptTelemetry).response_attempt_telemetry_complete, false);
  assert.equal(buildCandidateQualityGate(incompleteAttemptTelemetry).passed, false);

  const inconsistentAttemptTelemetry = makeArm(CANDIDATE_PROFILE);
  inconsistentAttemptTelemetry.fixture_outcomes[0].retry_reasons = ['malformed_output'];
  assert.equal(buildCandidateQualityGate(inconsistentAttemptTelemetry).response_attempt_telemetry_consistent, false);
  assert.equal(buildCandidateQualityGate(inconsistentAttemptTelemetry).passed, false);

  const baselineFalsePositive = buildQualificationReceipt({
    input,
    policy,
    baseline: makeArm(BASELINE_PROFILE, { falsePositives: ['clean-rename-only'] }),
    candidate: makeArm(CANDIDATE_PROFILE),
    runId: 'quality-baseline-false-positive',
  });
  assert.equal(baselineFalsePositive.baseline_quality_gate.passed, false);
  assert.equal(baselineFalsePositive.candidate_eligible_for_next_step, false);

  const improvedCandidate = buildQualificationReceipt({
    input,
    policy,
    baseline: makeArm(BASELINE_PROFILE, { missed: ['vacuous-default-value-test'] }),
    candidate: makeArm(CANDIDATE_PROFILE),
    runId: 'quality-candidate-improvement',
  });
  assert.equal(improvedCandidate.baseline_quality_gate.passed, true);
  assert.equal(improvedCandidate.candidate_not_worse_on_defect_recall, true);
  assert.equal(improvedCandidate.candidate_eligible_for_next_step, true);

  const recallRegression = buildQualificationReceipt({
    input,
    policy,
    baseline: makeArm(BASELINE_PROFILE),
    candidate: makeArm(CANDIDATE_PROFILE, { missed: ['vacuous-default-value-test'] }),
    runId: 'quality-recall-regression',
  });
  assert.equal(recallRegression.candidate_not_worse_on_defect_recall, false);
  assert.equal(recallRegression.candidate_eligible_for_next_step, false);

  const missingFixtureEvidence = makeArm(CANDIDATE_PROFILE);
  missingFixtureEvidence.fixture_outcomes = missingFixtureEvidence.fixture_outcomes.slice(1);
  assert.equal(buildCandidateQualityGate(missingFixtureEvidence).fixture_set_complete, false);
  assert.equal(buildQualificationReceipt({ input, policy, baseline: base, candidate: missingFixtureEvidence }).candidate_eligible_for_next_step, false);

  const malformedCategoryEvidence = makeArm(CANDIDATE_PROFILE);
  malformedCategoryEvidence.fixture_outcomes[0] = { ...malformedCategoryEvidence.fixture_outcomes[0], category: 'unknown' };
  assert.equal(buildCandidateQualityGate(malformedCategoryEvidence).passed, false);

  const unexpectedFixtureEvidence = makeArm(CANDIDATE_PROFILE);
  unexpectedFixtureEvidence.fixture_outcomes[0] = { ...unexpectedFixtureEvidence.fixture_outcomes[0], fixture_id: 'unexpected-fixture' };
  assert.equal(buildCandidateQualityGate(unexpectedFixtureEvidence).fixture_set_complete, false);
  assert.equal(buildCandidateQualityGate(unexpectedFixtureEvidence).passed, false);

  const missingBaselineEvidence = makeArm(BASELINE_PROFILE);
  missingBaselineEvidence.fixture_outcomes = missingBaselineEvidence.fixture_outcomes.slice(1);
  assert.equal(buildBaselineQualityGate(missingBaselineEvidence).fixture_set_complete, false);
  assert.equal(buildQualificationReceipt({ input, policy, baseline: missingBaselineEvidence, candidate: makeArm(CANDIDATE_PROFILE) }).candidate_eligible_for_next_step, false);
});

test('evaluation summary reports only bounded aggregate evidence', () => {
  const summary = summarizeEvaluation({
    rows: [
      { category: 'defect', detected: true, errored: false, latencyMs: 100, usage: { costUSD: 0.1 } },
      { category: 'clean', falsePositive: false, errored: false, latencyMs: 200, usage: { costUSD: 0.2 } },
    ],
  }, 0);
  assert.deepEqual(summary, {
    exit_code: 0,
    status: 'completed',
    rows: 2,
    errored_runs: 0,
    defect_runs: 1,
    detected_defect_runs: 1,
    clean_runs: 1,
    false_positive_runs: 0,
    failure_classes: {},
    failure_classes_by_provider: {},
    response_statuses: {},
    error_codes: {},
    output_shapes: {},
    finish_reasons: {},
    response_modes: {},
    findings_sources: {},
    content_size_buckets: {},
    reasoning_size_buckets: {},
    response_attempt_outcomes: {},
    first_attempt_output_shapes: {},
    first_attempt_finish_reasons: {},
    first_attempt_failure_classes: {},
    first_attempt_reasoning_efforts: {},
    first_attempt_max_output_tokens: {},
    fixture_outcomes: [
      { fixture_id: 'row-1', category: 'defect', outcome: 'detected', latency_ms: 100 },
      { fixture_id: 'row-2', category: 'clean', outcome: 'clean', latency_ms: 200 },
    ],
    latency_ms_median: 100,
    latency_ms_p95: 200,
    cost_usd: 0.3,
  });
});

test('fixture outcomes retain bounded routing evidence without findings or provider text', () => {
  const outcomes = summarizeFixtureOutcomes([
    {
      fixtureId: 'dual-cause-diagnostic-named-for-one',
      category: 'defect',
      detected: false,
      errored: false,
      latencyMs: 12_345,
      provider: 'Ollama',
      transport: 'ollama',
      attemptCount: 2,
      retryReasons: ['timeout', 'provider_error'],
      outputShape: 'direct_json_object',
      finishReason: 'stop',
      responseMode: 'stream',
      findingsSource: 'reasoning',
      contentPresent: false,
      reasoningPresent: true,
      contentSizeBucket: 'empty',
      reasoningSizeBucket: 'tiny',
      responseAttempts: [{
        attempt: 1,
        outcome: 'malformed_output',
        provider: 'ollama',
        transport: 'ollama',
        latencyMs: 90_000,
        responseStatus: 200,
        failureClass: 'malformed_output',
        reasoningEffort: 'high',
        maxOutputTokens: 24_576,
        outputTokens: 24_576,
        outputShape: 'no_json',
        finishReason: 'length',
        responseMode: 'stream',
        findingsSource: 'none',
        contentPresent: false,
        reasoningPresent: true,
        contentSizeBucket: 'empty',
        reasoningSizeBucket: 'small',
        rawResponse: 'do not retain this response text',
      }],
      error: 'do not retain this response text',
    },
    {
      fixtureId: 'clean-rename-only',
      category: 'clean',
      falsePositive: true,
      errored: false,
      responseStatus: 200,
      errorCode: 'not-an-error',
    },
    {
      fixtureId: '__proto__',
      category: 'defect',
      detected: false,
      errored: true,
      responseStatus: 404,
      errorCode: 'not_found_error',
    },
  ]);
  assert.deepEqual(outcomes, [
    {
      fixture_id: 'dual-cause-diagnostic-named-for-one',
      category: 'defect',
      outcome: 'miss',
      latency_ms: 12_345,
      provider: 'ollama',
      transport: 'ollama',
      attempt_count: 2,
      retry_reasons: ['timeout', 'provider_error'],
      output_shape: 'direct_json_object',
      finish_reason: 'stop',
      response_mode: 'stream',
      findings_source: 'reasoning',
      content_present: false,
      reasoning_present: true,
      content_size_bucket: 'empty',
      reasoning_size_bucket: 'tiny',
      response_attempts: [{
        attempt: 1,
        outcome: 'malformed_output',
        provider: 'ollama',
        transport: 'ollama',
        latency_ms: 90_000,
        response_status: '200',
        failure_class: 'malformed_output',
        reasoning_effort: 'high',
        max_output_tokens: 24_576,
        output_tokens: 24_576,
        output_shape: 'no_json',
        finish_reason: 'length',
        response_mode: 'stream',
        findings_source: 'none',
        content_present: false,
        reasoning_present: true,
        content_size_bucket: 'empty',
        reasoning_size_bucket: 'small',
      }],
    },
    {
      fixture_id: 'clean-rename-only',
      category: 'clean',
      outcome: 'false_positive',
      response_status: '200',
      error_code: 'not-an-error',
    },
    {
      fixture_id: 'row-3',
      category: 'defect',
      outcome: 'error',
      response_status: '404',
      error_code: 'not_found_error',
    },
  ]);
  assert.equal(JSON.stringify(outcomes).includes('response text'), false);
});

test('fixture output telemetry accepts only exact bounded enums and booleans', () => {
  const [outcome] = summarizeFixtureOutcomes([{
    fixtureId: 'clean-rename-only',
    category: 'clean',
    falsePositive: false,
    outputShape: 'raw-secret-shape',
    finishReason: 'raw-secret-finish',
    responseMode: 'unbounded-mode',
    findingsSource: '__proto__',
    contentPresent: 'true',
    reasoningPresent: 1,
    contentSizeBucket: '12345',
    reasoningSizeBucket: 'raw-length',
    responseAttempts: [{
      attempt: 1,
      outcome: 'secret-outcome',
      provider: 'secret-provider',
      reasoningEffort: 'secret-effort',
      rawResponse: 'secret-response',
    }],
  }]);
  assert.deepEqual(outcome, { fixture_id: 'clean-rename-only', category: 'clean', outcome: 'clean' });
});

test('failure classification is coarse and never copies provider error text', () => {
  assert.equal(classifyFailure({ error: 'HTTP 429 rate_limit_exceeded for secret-model' }), 'rate_limit');
  assert.equal(classifyFailure({ error: 'upstream 503 service unavailable' }), 'upstream_5xx');
  assert.equal(classifyFailure({ error: 'socket timed out while connecting' }), 'timeout_or_connect');
  assert.equal(classifyFailure({ error: 'invalid findings JSON' }), 'invalid_output');
  assert.equal(classifyFailure({ error: 'ECONNRESET from provider' }), 'network');
  assert.equal(classifyFailure({ error: 'provider refused request' }), 'provider_error');
  const summary = summarizeEvaluation({ rows: [{
    category: 'defect',
    errored: true,
    error: 'api-key token-secret provider failed',
    provider: 'Ollama',
    responseStatus: 502,
    errorCode: 'upstream_error',
  }] }, 0);
  assert.deepEqual(summary.failure_classes, { auth: 1 });
  assert.deepEqual(summary.failure_classes_by_provider, { ollama: { auth: 1 } });
  assert.deepEqual(summary.response_statuses, { '502': 1 });
  assert.deepEqual(summary.error_codes, { upstream_error: 1 });
  assert.equal(JSON.stringify(summary).includes('token-secret'), false);

  const transportFallback = summarizeEvaluation({ rows: [{
    category: 'defect',
    errored: true,
    transport: 'Ollama',
    responseStatus: 404,
    errorCode: 'not_found_error',
  }] }, 0);
  assert.deepEqual(transportFallback.failure_classes_by_provider, { ollama: { provider_error: 1 } });
  assert.deepEqual(transportFallback.response_statuses, { '404': 1 });
  assert.deepEqual(transportFallback.error_codes, { not_found_error: 1 });

  const hostile = summarizeEvaluation({ rows: [{
    category: 'clean',
    errored: true,
    provider: '__proto__',
    responseStatus: 99,
    errorCode: 'not a safe label',
  }] }, 1);
  assert.deepEqual(hostile.failure_classes_by_provider, { unknown: { provider_error: 1 } });
  assert.deepEqual(hostile.response_statuses, {});
  assert.deepEqual(hostile.error_codes, {});
  assert.equal(Object.prototype.polluted, undefined);
});

test('runQualification verifies first, then starts exactly two bounded arms in parallel', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'ct-ollama-qualification-test-'));
  const starts = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha } }),
  });
  const spawnImpl = (_command, args, options) => {
    const child = new EventEmitter();
    const arm = args[args.indexOf('--arm') + 1];
    const output = args[args.indexOf('--out') + 1];
    starts.push({ arm, transportPlan: JSON.parse(options.env.REVIEW_YETI_TRANSPORTS) });
    writeFileSync(output, JSON.stringify({ rows: makeFixtureRows() }));
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  try {
    const result = await runQualification({
      input,
      policy,
      token: 'read-only-token',
      outputDir: tempRoot,
      fetchImpl,
      spawnImpl,
      now: '2026-08-25T00:00:00.000Z',
      runId: 'test-run',
    });
    assert.deepEqual(starts.map((entry) => entry.arm).sort(), ['baseline', 'candidate']);
    assert.deepEqual(starts.find((entry) => entry.arm === 'candidate').transportPlan.map((transport) => transport.name), ['ollama']);
    assert.equal(starts.find((entry) => entry.arm === 'candidate').transportPlan[0].timeout_ms, CANDIDATE_TIMEOUT_MS);
    assert.equal(starts.find((entry) => entry.arm === 'baseline').transportPlan.find((transport) => transport.name === 'ollama').timeout_ms, 90_000);
    assert.deepEqual(starts.find((entry) => entry.arm === 'baseline').transportPlan.map((transport) => transport.name), ['fireworks', 'ollama', 'openrouter-fallback']);
    assert.equal(result.receipt.candidate_eligible_for_next_step, true);
    assert.match(result.receiptPath, /ollama-qualification-receipt\.json$/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('runQualification records failed child arms and withholds candidate eligibility', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'ct-ollama-qualification-failure-test-'));
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha } }),
  });
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    const arm = args[args.indexOf('--arm') + 1];
    if (arm === 'baseline') {
      const output = args[args.indexOf('--out') + 1];
      writeFileSync(output, JSON.stringify({ rows: [
        { category: 'defect', detected: true, errored: false, latencyMs: 10, usage: { costUSD: 0 } },
      ] }));
      queueMicrotask(() => child.emit('close', 0));
    } else {
      queueMicrotask(() => child.emit('error', new Error('provider unavailable')));
    }
    return child;
  };
  try {
    const result = await runQualification({ input, policy, token: 'read-only-token', outputDir: tempRoot, fetchImpl, spawnImpl });
    assert.equal(result.receipt.arms.baseline.status, 'completed');
    assert.equal(result.receipt.arms.candidate.status, 'failed');
    assert.equal(result.receipt.arms.candidate.exit_code, 1);
    assert.equal(result.receipt.candidate_eligible_for_next_step, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
