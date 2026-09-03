import test from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASELINE_PROFILE,
  CANDIDATE_PROFILE,
  COMPARISON_EVALUATION_ARM,
  COMPARISON_MAX_OUTPUT_TOKENS,
  COMPARISON_REASONING_EFFORT,
  COMPARISON_TIMEOUT_MS,
  FIXTURE_IDS,
  QUALIFICATION_CHILD_TIMEOUT_MS,
  QUALIFICATION_SCHEMA,
  buildArmEnvironment,
  buildBaselineQualityGate,
  buildCandidateQualityGate,
  buildQualificationReceipt,
  buildTransportHandoff,
  classifyFailure,
  normalizeChildTimeoutMs,
  runQualification,
  runChild,
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

function makeFixtureRows({
  missed = [],
  falsePositives = [],
  malformed = [],
  provider = 'ollama',
  transport = provider,
  reasoningEffort = COMPARISON_REASONING_EFFORT,
  maxOutputTokens = COMPARISON_MAX_OUTPUT_TOKENS,
  finishReason = 'stop',
} = {}) {
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
      finishReason,
      responseMode: 'stream',
      findingsSource: 'content',
      contentPresent: true,
      reasoningPresent: false,
      contentSizeBucket: 'tiny',
      reasoningSizeBucket: 'empty',
      outputContract: {
        policyDeclared: provider === 'fireworks' ? 'json_object' : 'unknown',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
      responseAttempts: malformedIds.has(fixtureId)
        ? [{
            attempt: 1,
            outcome: 'malformed_output',
            provider,
            transport,
            latencyMs: 90_000,
            responseStatus: 200,
            failureClass: 'malformed_output',
            reasoningEffort,
            maxOutputTokens,
            outputTokens: maxOutputTokens,
            outputShape: 'no_json',
            finishReason: 'length',
            responseMode: 'stream',
            findingsSource: 'none',
            contentPresent: false,
            reasoningPresent: true,
            contentSizeBucket: 'empty',
            reasoningSizeBucket: 'small',
            outputContract: {
              policyDeclared: provider === 'fireworks' ? 'json_object' : 'unknown',
              requestObserved: 'json_object',
              providerSupported: 'unreported',
              terminalParsed: false,
            },
          }, {
            attempt: 2,
            outcome: 'parsed',
            provider,
            transport,
            latencyMs: 1_000,
            responseStatus: 200,
            reasoningEffort: 'none',
            maxOutputTokens,
            outputTokens: 12,
            outputShape: 'direct_json_object',
            finishReason,
            responseMode: 'stream',
            findingsSource: 'content',
            contentPresent: true,
            reasoningPresent: false,
            contentSizeBucket: 'tiny',
            reasoningSizeBucket: 'empty',
            outputContract: {
              policyDeclared: provider === 'fireworks' ? 'json_object' : 'unknown',
              requestObserved: 'json_object',
              providerSupported: 'unreported',
              terminalParsed: true,
            },
          }]
        : [{
            attempt: 1,
            outcome: 'parsed',
            provider,
            transport,
            latencyMs: 10 + index,
            responseStatus: 200,
            reasoningEffort,
            maxOutputTokens,
            outputTokens: 12,
            outputShape: 'direct_json_object',
            finishReason,
            responseMode: 'stream',
            findingsSource: 'content',
            contentPresent: true,
            reasoningPresent: false,
            contentSizeBucket: 'tiny',
            reasoningSizeBucket: 'empty',
            outputContract: {
              policyDeclared: provider === 'fireworks' ? 'json_object' : 'unknown',
              requestObserved: 'json_object',
              providerSupported: 'unreported',
              terminalParsed: true,
            },
          }],
    };
  });
}

function makeArm(profile, options = {}) {
  const transport = profile === BASELINE_PROFILE ? 'fireworks' : 'ollama';
  return { profile, ...summarizeEvaluation({ rows: makeFixtureRows({ provider: transport, transport, ...options }) }, 0) };
}

test('qualification input is fail-closed and requires immutable coordinates', () => {
  assert.deepEqual(validateQualificationInput(input).prNumber, 119);
  for (const [field, value] of [['confirm', 'yes'], ['repository', 'not-a-repository'], ['baseSha', 'short'], ['centralSha', 'short'], ['botRoot', 'relative']]) {
    const invalid = { ...input, [field]: value };
    assert.throws(() => validateQualificationInput(invalid), /required|must|confirm|repository|SHA|absolute/u);
  }
  assert.throws(() => validateQualificationInput({ ...input, headSha: input.baseSha }), /must differ/u);
});

test('hosted comparison remains manual-only and fails the job on integrity errors', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ollama-qualification.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}(schedule|pull_request|pull_request_target|repository_dispatch|workflow_run):/mu);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/u);
  assert.match(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /timeout-minutes:\s*15\b/u);
  assert.doesNotMatch(workflow, /timeout-minutes:\s*90\b/u);
  assert.match(workflow, /Dispatching the Fireworks and Ollama qualification arms in parallel/u);
  assert.match(workflow, /8-minute hard wall-clock deadline/u);
});

test('qualification child has a hard wall-clock kill guard', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const result = await runChild({
    command: 'node',
    args: [],
    cwd: process.cwd(),
    env: process.env,
    spawnImpl: () => child,
    timeoutMs: 5,
    killGraceMs: 1,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(QUALIFICATION_CHILD_TIMEOUT_MS, 480_000);
});

test('qualification child timeout cannot exceed the hard eight-minute arm bound', () => {
  assert.equal(normalizeChildTimeoutMs(), QUALIFICATION_CHILD_TIMEOUT_MS);
  assert.equal(normalizeChildTimeoutMs(100), 100);
  assert.throws(() => normalizeChildTimeoutMs(QUALIFICATION_CHILD_TIMEOUT_MS + 1), /childTimeoutMs must be an integer/u);
  assert.throws(() => normalizeChildTimeoutMs(0), /childTimeoutMs must be an integer/u);
});

test('qualification dispatches both provider arms concurrently', async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qualification-parallel-'));
  const started = [];
  let active = 0;
  let maxActive = 0;
  try {
    const result = await runQualification({
      input: { ...input, botRoot: '/tmp/review-yeti-bot' },
      policy,
      token: 'read-only-token',
      outputDir,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha } }),
      }),
      spawnImpl: (_command, _args, options) => {
        started.push(options.env.QUALIFICATION_ARM);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const child = new EventEmitter();
        child.kill = () => true;
        setTimeout(() => {
          active -= 1;
          child.emit('close', 0);
        }, 5);
        return child;
      },
      childTimeoutMs: 100,
      runId: 'parallel-test',
    });
    assert.deepEqual(started, ['baseline', 'candidate']);
    assert.equal(maxActive, 2);
    assert.equal(result.receipt.arms.baseline.status, 'failed');
    assert.equal(result.receipt.arms.candidate.status, 'failed');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('comparison profiles pin one direct provider under the same bounded contract', () => {
  const baseline = buildTransportHandoff(policy, BASELINE_PROFILE);
  const candidate = buildTransportHandoff(policy, CANDIDATE_PROFILE);
  assert.equal(BASELINE_PROFILE, 'fireworks-high-150s-24576-control');
  assert.equal(CANDIDATE_PROFILE, 'ollama-high-150s-24576-evaluation');
  assert.deepEqual(baseline.map((transport) => transport.name), ['fireworks']);
  assert.deepEqual(candidate.map((transport) => transport.name), ['ollama']);
  for (const [transport] of [baseline, candidate]) {
    assert.equal(transport.timeout_ms, COMPARISON_TIMEOUT_MS);
    assert.equal(transport.connect_timeout_ms, 30_000);
    assert.equal(transport.reasoning_effort, COMPARISON_REASONING_EFFORT);
    assert.equal(transport.max_tokens, COMPARISON_MAX_OUTPUT_TOKENS);
    assert.equal(transport.stream, true);
  }
  assert.equal(policy.review_yeti.transports.find((transport) => transport.name === 'fireworks').timeout_ms, 120_000);
  assert.equal(policy.review_yeti.transports.find((transport) => transport.name === 'fireworks').connect_timeout_ms, 15_000);
  assert.equal(policy.review_yeti.transports.find((transport) => transport.name === 'ollama').timeout_ms, 90_000);
  assert.equal(policy.review_yeti.transports.find((transport) => transport.name === 'ollama').max_tokens, undefined);
  assert.equal(policy.review_yeti.transports.find((transport) => transport.name === 'ollama').reasoning_effort, 'high');
  assert.throws(() => buildTransportHandoff(policy, 'openrouter-primary'), /unsupported qualification profile/u);
});

test('each comparison child receives only its selected provider credential', () => {
  const baseEnv = {
    FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
    OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
    OPENROUTER_API_KEY: 'openrouter-secret',
    GITHUB_TOKEN: 'github-secret',
    QUALIFICATION_GH_TOKEN: 'qualification-token',
    GITHUB_EVENT_PATH: '/tmp/event.json',
  };
  const candidateEnvironment = buildArmEnvironment({
    baseEnv,
    handoff: buildTransportHandoff(policy, CANDIDATE_PROFILE),
    arm: 'candidate',
    botSha: input.botSha,
    fixturePath: '/tmp/evaluation-matrix.json',
  });
  const baselineEnvironment = buildArmEnvironment({
    baseEnv,
    handoff: buildTransportHandoff(policy, BASELINE_PROFILE),
    arm: 'baseline',
    botSha: input.botSha,
    fixturePath: '/tmp/evaluation-matrix.json',
  });
  assert.equal(candidateEnvironment.OLLAMA_PR_REVIEW_API_KEY, 'ollama-secret');
  assert.equal(candidateEnvironment.FIREWORKS_PR_REVIEW_API_KEY, undefined);
  assert.equal(candidateEnvironment.OPENROUTER_API_KEY, undefined);
  assert.equal(baselineEnvironment.FIREWORKS_PR_REVIEW_API_KEY, 'fireworks-secret');
  assert.equal(baselineEnvironment.OLLAMA_PR_REVIEW_API_KEY, undefined);
  assert.equal(baselineEnvironment.OPENROUTER_API_KEY, undefined);
  for (const environment of [baselineEnvironment, candidateEnvironment]) {
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.QUALIFICATION_GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_EVENT_PATH, undefined);
    assert.equal(environment.VITEST, 'true');
  }
});

test('comparison child environment never accepts an unselected fallback credential', () => {
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

test('receipt is sanitized, symmetric, and never a provider or promotion decision', () => {
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
  assert.equal(receipt.authoritative_arm, 'none');
  assert.equal(receipt.production_authority, 'unchanged');
  assert.equal(receipt.activation_authorized, false);
  assert.equal(receipt.single_run_decision, 'evidence_only');
  assert.equal(receipt.minimum_independent_runs_for_decision, 3);
  assert.equal(receipt.independent_runs_in_receipt, 1);
  assert.deepEqual(receipt.prompt_contract, {
    evaluator_arm: COMPARISON_EVALUATION_ARM,
    charter: 'current-testing',
    synthetic_prompt_identity_equal: true,
    exact_bot_sha_bound: true,
  });
  assert.deepEqual(receipt.implementation_refs, {
    central_action_sha: input.centralSha,
    review_yeti_bot_sha: input.botSha,
  });
  assert.equal(receipt.publication, 'none');
  assert.equal(receipt.provider_mutation, 'none');
  assert.equal(receipt.promotion_gate, 'manual_review_required');
  assert.equal(receipt.comparison_integrity_gate.passed, true);
  assert.equal(receipt.baseline_quality_gate.passed, true);
  assert.equal(receipt.candidate_quality_gate.passed, true);
  assert.equal(receipt.baseline_quality_gate.first_attempt_contract_observed, true);
  assert.equal(receipt.baseline_quality_gate.required_transport, 'fireworks');
  assert.equal(receipt.baseline_quality_gate.required_first_attempt_reasoning_effort, 'high');
  assert.equal(receipt.baseline_quality_gate.required_first_attempt_max_output_tokens, 24_576);
  assert.equal(receipt.candidate_quality_gate.output_telemetry_complete, true);
  assert.equal(receipt.candidate_quality_gate.response_attempt_telemetry_complete, true);
  assert.equal(receipt.candidate_quality_gate.response_attempt_telemetry_consistent, true);
  assert.equal(receipt.candidate_quality_gate.required_first_attempt_reasoning_effort, 'high');
  assert.equal(receipt.candidate_quality_gate.required_first_attempt_max_output_tokens, 24_576);
  assert.equal(receipt.candidate_quality_gate.first_attempt_contract_observed, true);
  assert.equal(receipt.candidate_quality_gate.terminal_parseability_complete, true);
  assert.equal(receipt.candidate_not_worse_on_defect_recall, true);
  assert.equal(receipt.candidate_quality_eligible_for_aggregate, true);
  assert.deepEqual(receipt.common_request_contract, {
    timeout_ms: COMPARISON_TIMEOUT_MS,
    connect_timeout_ms: 30_000,
    child_timeout_ms: QUALIFICATION_CHILD_TIMEOUT_MS,
    reasoning_effort: COMPARISON_REASONING_EFFORT,
    max_output_tokens: COMPARISON_MAX_OUTPUT_TOKENS,
    stream: true,
    repetitions: 1,
    concurrency: 1,
  });
  assert.equal(receipt.baseline_request_contract.transport, 'fireworks');
  assert.equal(receipt.candidate_request_contract.transport, 'ollama');
  assert.equal(receipt.baseline_request_contract.model_sha256.length, 64);
  assert.equal(receipt.candidate_request_contract.model_sha256.length, 64);
  assert.deepEqual(receipt.route_sampling_residual, {
    comparison_scope: 'configured_operational_routes',
    same_sampler_claim_allowed: false,
    contract: 'provider_specific_defaults_from_exact_bot_sha',
    values_observed_in_receipt: false,
  });
  assert.deepEqual(receipt.contract_evidence.handoff_only_not_runtime_observed, ['timeout_ms', 'connect_timeout_ms', 'model_sha256']);
  assert.equal(receipt.planned_primary_requests_per_arm, FIXTURE_IDS.length);
  assert.equal(receipt.max_model_attempts_per_arm, FIXTURE_IDS.length * 2);
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
  assert.equal(JSON.stringify(receipt).includes('findingsDetail'), false);
});

test('receipt eligibility fails closed on candidate quality regressions', () => {
  const base = makeArm(BASELINE_PROFILE);
  const clean = buildQualificationReceipt({ input, policy, baseline: base, candidate: makeArm(CANDIDATE_PROFILE), runId: 'quality-pass' });
  assert.equal(clean.candidate_quality_eligible_for_aggregate, true);

  const falsePositive = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { falsePositives: ['function-scoped-fixture-avoids-shared-state'] }),
    runId: 'quality-false-positive',
  });
  assert.equal(falsePositive.candidate_quality_eligible_for_aggregate, false);

  const missedDefect = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { missed: ['vacuous-default-value-test'] }),
    runId: 'quality-missed-defect',
  });
  assert.equal(missedDefect.candidate_quality_eligible_for_aggregate, false);

  const noDetections = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { missed: [...DEFECT_FIXTURE_IDS] }),
    runId: 'quality-no-detections',
  });
  assert.equal(noDetections.arms.candidate.detected_defect_runs, 0);
  assert.equal(noDetections.candidate_quality_eligible_for_aggregate, false);

  const malformedRecovery = buildQualificationReceipt({
    input,
    policy,
    baseline: base,
    candidate: makeArm(CANDIDATE_PROFILE, { malformed: ['shared-module-state-order-dependent-test'] }),
    runId: 'quality-malformed-recovery',
  });
  assert.equal(malformedRecovery.candidate_quality_gate.observed_malformed_output_recoveries, 1);
  assert.equal(malformedRecovery.candidate_quality_eligible_for_aggregate, false);

  const wrappedOutput = makeArm(CANDIDATE_PROFILE);
  wrappedOutput.fixture_outcomes[0] = { ...wrappedOutput.fixture_outcomes[0], output_shape: 'fenced_json_object' };
  const wrappedReceipt = buildQualificationReceipt({ input, policy, baseline: base, candidate: wrappedOutput });
  assert.equal(wrappedReceipt.candidate_quality_gate.output_telemetry_complete, true);
  assert.equal(wrappedReceipt.candidate_quality_gate.terminal_parseability_complete, false);
  assert.equal(wrappedReceipt.candidate_quality_eligible_for_aggregate, false);

  const truncatedCompletion = makeArm(CANDIDATE_PROFILE);
  truncatedCompletion.fixture_outcomes[0] = { ...truncatedCompletion.fixture_outcomes[0], finish_reason: 'length' };
  assert.equal(buildCandidateQualityGate(truncatedCompletion).terminal_parseability_complete, false);

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

  const ignoredTokenOverride = makeArm(CANDIDATE_PROFILE);
  ignoredTokenOverride.fixture_outcomes[0].response_attempts[0].max_output_tokens = 49_152;
  assert.equal(buildCandidateQualityGate(ignoredTokenOverride).first_attempt_contract_observed, false);
  assert.equal(buildCandidateQualityGate(ignoredTokenOverride).passed, false);

  const ignoredReasoningOverride = makeArm(CANDIDATE_PROFILE);
  ignoredReasoningOverride.fixture_outcomes[0].response_attempts[0].reasoning_effort = 'medium';
  assert.equal(buildCandidateQualityGate(ignoredReasoningOverride).first_attempt_contract_observed, false);
  assert.equal(buildCandidateQualityGate(ignoredReasoningOverride).passed, false);

  const candidateProviderFallback = makeArm(CANDIDATE_PROFILE);
  candidateProviderFallback.fixture_outcomes[0].response_attempts[0].provider = 'fireworks';
  assert.equal(buildCandidateQualityGate(candidateProviderFallback).first_attempt_contract_observed, false);
  assert.equal(buildCandidateQualityGate(candidateProviderFallback).passed, false);

  const baselineProviderFallback = makeArm(BASELINE_PROFILE);
  baselineProviderFallback.fixture_outcomes[0].response_attempts[0].transport = 'ollama';
  assert.equal(buildBaselineQualityGate(baselineProviderFallback).first_attempt_contract_observed, false);
  assert.equal(buildBaselineQualityGate(baselineProviderFallback).passed, false);

  const baselineMalformedRecovery = makeArm(BASELINE_PROFILE, { malformed: ['shared-module-state-order-dependent-test'] });
  assert.equal(buildBaselineQualityGate(baselineMalformedRecovery).observed_malformed_output_recoveries, 1);
  assert.equal(buildBaselineQualityGate(baselineMalformedRecovery).passed, false);

  const baselineMissingFinish = makeArm(BASELINE_PROFILE, { finishReason: 'missing' });
  assert.equal(buildBaselineQualityGate(baselineMissingFinish).terminal_parseability_complete, true);
  assert.equal(buildBaselineQualityGate(baselineMissingFinish).finish_reason_telemetry_complete, false);
  assert.equal(buildBaselineQualityGate(baselineMissingFinish).passed, true);

  const baselineFalsePositive = buildQualificationReceipt({
    input,
    policy,
    baseline: makeArm(BASELINE_PROFILE, { falsePositives: ['clean-rename-only'] }),
    candidate: makeArm(CANDIDATE_PROFILE),
    runId: 'quality-baseline-false-positive',
  });
  assert.equal(baselineFalsePositive.baseline_quality_gate.passed, false);
  assert.equal(baselineFalsePositive.comparison_integrity_gate.passed, true);
  assert.equal(baselineFalsePositive.candidate_quality_eligible_for_aggregate, true);

  const improvedCandidate = buildQualificationReceipt({
    input,
    policy,
    baseline: makeArm(BASELINE_PROFILE, { missed: ['vacuous-default-value-test'] }),
    candidate: makeArm(CANDIDATE_PROFILE),
    runId: 'quality-candidate-improvement',
  });
  assert.equal(improvedCandidate.baseline_quality_gate.passed, false);
  assert.equal(improvedCandidate.comparison_integrity_gate.passed, true);
  assert.equal(improvedCandidate.candidate_not_worse_on_defect_recall, true);
  assert.equal(improvedCandidate.candidate_quality_eligible_for_aggregate, true);

  const recallRegression = buildQualificationReceipt({
    input,
    policy,
    baseline: makeArm(BASELINE_PROFILE),
    candidate: makeArm(CANDIDATE_PROFILE, { missed: ['vacuous-default-value-test'] }),
    runId: 'quality-recall-regression',
  });
  assert.equal(recallRegression.candidate_not_worse_on_defect_recall, false);
  assert.equal(recallRegression.candidate_quality_eligible_for_aggregate, false);

  const missingFixtureEvidence = makeArm(CANDIDATE_PROFILE);
  missingFixtureEvidence.fixture_outcomes = missingFixtureEvidence.fixture_outcomes.slice(1);
  assert.equal(buildCandidateQualityGate(missingFixtureEvidence).fixture_set_complete, false);
  assert.equal(buildQualificationReceipt({ input, policy, baseline: base, candidate: missingFixtureEvidence }).candidate_quality_eligible_for_aggregate, false);

  const malformedCategoryEvidence = makeArm(CANDIDATE_PROFILE);
  malformedCategoryEvidence.fixture_outcomes[0] = { ...malformedCategoryEvidence.fixture_outcomes[0], category: 'unknown' };
  assert.equal(buildCandidateQualityGate(malformedCategoryEvidence).fixture_categories_valid, false);
  assert.equal(buildCandidateQualityGate(malformedCategoryEvidence).integrity_passed, false);
  assert.equal(buildCandidateQualityGate(malformedCategoryEvidence).passed, false);

  const swappedBaselineCategories = makeArm(BASELINE_PROFILE);
  const defectIndex = swappedBaselineCategories.fixture_outcomes.findIndex((entry) => entry.category === 'defect');
  const cleanIndex = swappedBaselineCategories.fixture_outcomes.findIndex((entry) => entry.category === 'clean');
  swappedBaselineCategories.fixture_outcomes[defectIndex] = {
    ...swappedBaselineCategories.fixture_outcomes[defectIndex],
    category: 'clean',
  };
  swappedBaselineCategories.fixture_outcomes[cleanIndex] = {
    ...swappedBaselineCategories.fixture_outcomes[cleanIndex],
    category: 'defect',
  };
  const swappedCategoryReceipt = buildQualificationReceipt({
    input,
    policy,
    baseline: swappedBaselineCategories,
    candidate: makeArm(CANDIDATE_PROFILE),
  });
  assert.equal(swappedCategoryReceipt.baseline_quality_gate.fixture_categories_valid, false);
  assert.equal(swappedCategoryReceipt.baseline_quality_gate.integrity_passed, false);
  assert.equal(swappedCategoryReceipt.comparison_integrity_gate.passed, false);

  const unexpectedFixtureEvidence = makeArm(CANDIDATE_PROFILE);
  unexpectedFixtureEvidence.fixture_outcomes[0] = { ...unexpectedFixtureEvidence.fixture_outcomes[0], fixture_id: 'unexpected-fixture' };
  assert.equal(buildCandidateQualityGate(unexpectedFixtureEvidence).fixture_set_complete, false);
  assert.equal(buildCandidateQualityGate(unexpectedFixtureEvidence).passed, false);

  const missingBaselineEvidence = makeArm(BASELINE_PROFILE);
  missingBaselineEvidence.fixture_outcomes = missingBaselineEvidence.fixture_outcomes.slice(1);
  assert.equal(buildBaselineQualityGate(missingBaselineEvidence).fixture_set_complete, false);
  assert.equal(buildQualificationReceipt({ input, policy, baseline: missingBaselineEvidence, candidate: makeArm(CANDIDATE_PROFILE) }).candidate_quality_eligible_for_aggregate, false);
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
    output_contract_telemetry_status: 'unavailable',
    output_contract_policy_declared: {},
    output_contract_request_observed: {},
    output_contract_provider_supported: {},
    output_contract_terminal_parsed: {},
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
    token_telemetry_status: 'unavailable',
    prompt_tokens: null,
    completion_tokens: null,
    cost_telemetry_status: 'complete',
    cost_usd: 0.3,
  });
});

test('zero-valued provider usage is marked unavailable instead of comparable pricing', () => {
  const summary = summarizeEvaluation({ rows: makeFixtureRows() }, 0);
  assert.equal(summary.token_telemetry_status, 'unavailable');
  assert.equal(summary.prompt_tokens, null);
  assert.equal(summary.completion_tokens, null);
  assert.equal(summary.cost_telemetry_status, 'unavailable');
  assert.equal(summary.cost_usd, null);
  assert.equal(summary.output_contract_telemetry_status, 'complete');
  assert.deepEqual(summary.output_contract_policy_declared, { unknown: FIXTURE_IDS.length });
  assert.deepEqual(summary.output_contract_request_observed, { json_object: FIXTURE_IDS.length });
  assert.deepEqual(summary.output_contract_provider_supported, { unreported: FIXTURE_IDS.length });
  assert.deepEqual(summary.output_contract_terminal_parsed, { true: FIXTURE_IDS.length });
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
      outputContract: {
        policyDeclared: 'unknown',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: false,
      },
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
        outputContract: {
          policyDeclared: 'unknown',
          requestObserved: 'json_object',
          providerSupported: 'unreported',
          terminalParsed: false,
        },
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
      output_contract: {
        policy_declared: 'unknown',
        request_observed: 'json_object',
        provider_supported: 'unreported',
        terminal_parsed: false,
      },
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
        output_contract: {
          policy_declared: 'unknown',
          request_observed: 'json_object',
          provider_supported: 'unreported',
          terminal_parsed: false,
        },
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
    const evaluatorArm = args[args.indexOf('--arm') + 1];
    const logicalArm = options.env.QUALIFICATION_ARM;
    const output = args[args.indexOf('--out') + 1];
    const transportPlan = JSON.parse(options.env.REVIEW_YETI_TRANSPORTS);
    starts.push({ logicalArm, evaluatorArm, transportPlan });
    writeFileSync(output, JSON.stringify({ rows: makeFixtureRows({ provider: transportPlan[0].name, transport: transportPlan[0].name }) }));
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
    assert.deepEqual(starts.map((entry) => entry.logicalArm).sort(), ['baseline', 'candidate']);
    assert.deepEqual(starts.map((entry) => entry.evaluatorArm), [COMPARISON_EVALUATION_ARM, COMPARISON_EVALUATION_ARM]);
    assert.deepEqual(starts.find((entry) => entry.logicalArm === 'candidate').transportPlan.map((transport) => transport.name), ['ollama']);
    assert.deepEqual(starts.find((entry) => entry.logicalArm === 'baseline').transportPlan.map((transport) => transport.name), ['fireworks']);
    for (const entry of starts) {
      assert.equal(entry.transportPlan[0].timeout_ms, COMPARISON_TIMEOUT_MS);
      assert.equal(entry.transportPlan[0].connect_timeout_ms, 30_000);
      assert.equal(entry.transportPlan[0].max_tokens, COMPARISON_MAX_OUTPUT_TOKENS);
      assert.equal(entry.transportPlan[0].reasoning_effort, COMPARISON_REASONING_EFFORT);
    }
    assert.equal(result.receipt.comparison_integrity_gate.passed, true);
    assert.equal(result.receipt.candidate_quality_eligible_for_aggregate, true);
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
  const spawnImpl = (_command, args, options) => {
    const child = new EventEmitter();
    const logicalArm = options.env.QUALIFICATION_ARM;
    if (logicalArm === 'baseline') {
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
    assert.equal(result.receipt.comparison_integrity_gate.passed, false);
    assert.equal(result.receipt.candidate_quality_eligible_for_aggregate, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
