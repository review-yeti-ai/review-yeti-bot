import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FIXTURE_IDS,
  OPENROUTER_CONNECT_TIMEOUT_MS,
  OPENROUTER_MAX_OUTPUT_TOKENS,
  OPENROUTER_REASONING_EFFORT,
  QUALIFICATION_GEMINI_MODEL,
  QUALIFICATION_MODEL_OVERRIDES,
  OPENROUTER_TIMEOUT_MS,
  OPENROUTER_TRANSPORT,
  QUALIFICATION_CHILD_TIMEOUT_MS,
  QUALIFICATION_BUDGET_MARGIN_MS,
  QUALIFICATION_CONCURRENCY,
  QUALIFICATION_ISOLATED_DEFAULT_CONCURRENCY,
  QUALIFICATION_MAX_CONCURRENCY,
  QUALIFICATION_MAX_ATTEMPTS_PER_FIXTURE,
  QUALIFICATION_MAX_REPETITIONS,
  QUALIFICATION_OUTPUT_CONTRACT_MODES,
  QUALIFICATION_DEFAULT_OUTPUT_CONTRACT_MODE,
  QUALIFICATION_ROUTING_PROFILES,
  QUALIFICATION_DEFAULT_ROUTING_PROFILE,
  QUALIFICATION_SYNTHETIC_PROMPT_IDENTITY,
  QUALIFICATION_HEARTBEAT_MS,
  buildArmEnvironment,
  buildQualificationReceipt,
  buildTransportHandoff,
  normalizeChildTimeoutMs,
  normalizeQualificationMaxTokens,
  normalizeQualificationModel,
  normalizeQualificationProviderSlug,
  normalizeQualificationFixtureId,
  normalizeQualificationConcurrency,
  normalizeQualificationOutputContractMode,
  normalizeQualificationRoutingProfile,
  normalizeQualificationRepetitions,
  qualificationWorstCaseMs,
  runChild,
  runQualification,
  summarizeRows,
  validateQualificationInput,
} from './openrouter-qualification.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/review-yeti.json', import.meta.url), 'utf8'));
const input = {
  confirm: 'QUALIFY',
  repository: 'review-yeti-ai/review-yeti-bot',
  prNumber: 278,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  botSha: 'c'.repeat(40),
  centralSha: 'd'.repeat(40),
  botReleaseTag: 'v1.13.1',
  botRoot: '/tmp/review-yeti-bot',
};

test('OpenRouter qualification is manual-only and capped at fifteen minutes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/openrouter-qualification.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}(schedule|pull_request|pull_request_target|repository_dispatch|workflow_run):/mu);
  assert.match(workflow, /timeout-minutes:\s*15\b/u);
  assert.doesNotMatch(workflow, /timeout-minutes:\s*(?:90|[2-9]\d|1[6-9])\b/u);
  assert.match(workflow, /Dispatching one direct OpenRouter qualification arm/u);
  assert.match(workflow, /10-minute hard wall-clock deadline/u);
  assert.match(workflow, /if:\s*always\(\)/u);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/u);
  assert.match(workflow, /OPENROUTER_PR_REVIEW_API_KEY:/u);
  assert.match(workflow, /Fixed repetitions per fixture \(1 or 2/u);
  assert.match(workflow, /fixture_id:/u);
  assert.match(workflow, /concurrency:/u);
  assert.match(workflow, /model:/u);
  const announceStep = workflow.split('      - name: Announce bounded OpenRouter dispatch', 2)[1]?.split('      - name: Run bounded OpenRouter qualification', 1)[0] || '';
  assert.match(announceStep, /OUTPUT_CONTRACT_MODE_INPUT:/u);
  assert.match(announceStep, /MAX_TOKENS_INPUT:/u);
  assert.match(announceStep, /FIXTURE_ID_INPUT:/u);
  assert.match(announceStep, /CONCURRENCY_INPUT:/u);
  assert.match(announceStep, /PROVIDER_SLUG_INPUT:/u);
  assert.match(announceStep, /MODEL_INPUT:/u);
  assert.match(announceStep, /ROUTING_PROFILE_INPUT:/u);
  const announceRun = announceStep.split('        run: |', 2)[1] || '';
  assert.doesNotMatch(announceRun, /\$\{\{/u);
  assert.match(workflow, /environment:\s*\n\s+name:\s*review-yeti-openrouter-qualification/u);
  const jobEnv = workflow.split('    env:\n', 2)[1]?.split('    steps:', 1)[0] || '';
  assert.doesNotMatch(jobEnv, /OPENROUTER_PR_REVIEW_API_KEY/u);
  assert.match(jobEnv, /QUALIFICATION_GH_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(jobEnv, /QUALIFICATION_GH_TOKEN:.*CROSS_REPO_TOKEN/u);
  const provenanceStep = workflow.split('      - name: Verify signed release provenance before secret exposure', 2)[1]?.split('      - name: Announce bounded OpenRouter dispatch', 1)[0] || '';
  assert.match(provenanceStep, /PROVENANCE_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(provenanceStep, /PROVENANCE_TOKEN:.*CROSS_REPO_TOKEN/u);
  assert.match(workflow, /publication or provider mutation/u);
});

test('input requires immutable coordinates and an explicit confirmation', () => {
  assert.equal(validateQualificationInput(input).prNumber, 278);
  assert.equal(validateQualificationInput({ ...input, repetitions: 2 }).repetitions, 2);
  assert.equal(validateQualificationInput(input).outputContractMode, QUALIFICATION_DEFAULT_OUTPUT_CONTRACT_MODE);
  assert.equal(validateQualificationInput(input).routingProfile, QUALIFICATION_DEFAULT_ROUTING_PROFILE);
  assert.equal(validateQualificationInput(input).maxTokens, OPENROUTER_MAX_OUTPUT_TOKENS);
  assert.equal(validateQualificationInput({ ...input, fixtureId: FIXTURE_IDS[0] }).fixtureId, FIXTURE_IDS[0]);
  assert.equal(validateQualificationInput(input).concurrency, QUALIFICATION_CONCURRENCY);
  assert.equal(validateQualificationInput({ ...input, fixtureId: FIXTURE_IDS[0] }).concurrency, QUALIFICATION_ISOLATED_DEFAULT_CONCURRENCY);
  assert.equal(validateQualificationInput({ ...input, fixtureId: FIXTURE_IDS[0], concurrency: 3 }).concurrency, 3);
  assert.equal(normalizeQualificationConcurrency('', true), QUALIFICATION_ISOLATED_DEFAULT_CONCURRENCY);
  assert.equal(normalizeQualificationConcurrency(QUALIFICATION_MAX_CONCURRENCY, true), QUALIFICATION_MAX_CONCURRENCY);
  assert.equal(normalizeQualificationFixtureId(), null);
  assert.throws(() => normalizeQualificationFixtureId('missing-fixture'), /fixtureId/u);
  assert.equal(validateQualificationInput({ ...input, maxTokens: 65_536 }).maxTokens, 65_536);
  assert.equal(normalizeQualificationMaxTokens(65_536), 65_536);
  assert.equal(normalizeQualificationMaxTokens(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeQualificationProviderSlug(), null);
  assert.equal(normalizeQualificationProviderSlug('OpenInference'), 'openinference');
  assert.throws(() => normalizeQualificationProviderSlug('bad provider'), /providerSlug/u);
  assert.deepEqual(QUALIFICATION_ROUTING_PROFILES, ['default_uptime', 'throughput_sorted']);
  assert.equal(normalizeQualificationRoutingProfile(), QUALIFICATION_DEFAULT_ROUTING_PROFILE);
  assert.equal(normalizeQualificationRoutingProfile('THROUGHPUT_SORTED'), 'throughput_sorted');
  assert.throws(() => normalizeQualificationRoutingProfile('provider_order'), /routingProfile/u);
  assert.equal(validateQualificationInput({ ...input, outputContractMode: 'json_schema' }).outputContractMode, 'json_schema');
  assert.deepEqual(QUALIFICATION_OUTPUT_CONTRACT_MODES, ['json_object', 'json_schema']);
  assert.equal(normalizeQualificationOutputContractMode(), 'json_object');
  assert.equal(normalizeQualificationRepetitions(), 1);
  assert.equal(QUALIFICATION_MAX_REPETITIONS, 2);
  assert.equal(QUALIFICATION_CONCURRENCY, 3);
  assert.equal(QUALIFICATION_MAX_ATTEMPTS_PER_FIXTURE, 2);
  assert.equal(QUALIFICATION_BUDGET_MARGIN_MS, 4 * 60_000);
  assert.ok(qualificationWorstCaseMs(2) <= QUALIFICATION_CHILD_TIMEOUT_MS - QUALIFICATION_BUDGET_MARGIN_MS);
  for (const [field, value] of [['confirm', 'yes'], ['repository', 'invalid'], ['baseSha', 'short'], ['botReleaseTag', 'main'], ['botRoot', 'relative']]) {
    assert.throws(() => validateQualificationInput({ ...input, [field]: value }), /confirm|repository|SHA|botReleaseTag|absolute/u);
  }
  assert.throws(() => validateQualificationInput({ ...input, repetitions: 3 }), /repetitions/u);
  assert.throws(() => validateQualificationInput({ ...input, outputContractMode: 'xml' }), /outputContractMode/u);
  assert.throws(() => validateQualificationInput({ ...input, maxTokens: 0 }), /maxTokens/u);
  assert.throws(() => validateQualificationInput({ ...input, maxTokens: 1.5 }), /maxTokens/u);
  assert.throws(() => validateQualificationInput({ ...input, fixtureId: 'missing-fixture' }), /fixtureId/u);
  assert.throws(() => validateQualificationInput({ ...input, concurrency: 1 }), /isolated fixture/u);
  assert.throws(() => validateQualificationInput({ ...input, fixtureId: FIXTURE_IDS[0], concurrency: 0 }), /concurrency/u);
  assert.throws(() => validateQualificationInput({ ...input, fixtureId: FIXTURE_IDS[0], concurrency: 4 }), /concurrency/u);
  assert.throws(() => normalizeQualificationMaxTokens(Number.MAX_SAFE_INTEGER + 1), /maxTokens/u);
  assert.throws(() => validateQualificationInput({ ...input, headSha: input.baseSha }), /must differ/u);
});

test('allows only the explicit Gemini model as a qualification override and removes Auto Router plugins', () => {
  assert.deepEqual(QUALIFICATION_MODEL_OVERRIDES, [QUALIFICATION_GEMINI_MODEL]);
  assert.equal(normalizeQualificationModel(), null);
  assert.equal(normalizeQualificationModel('GOOGLE/GEMINI-3.7-FLASH'), QUALIFICATION_GEMINI_MODEL);
  assert.throws(() => normalizeQualificationModel('google/gemini-3.6-flash'), /model/u);

  const validated = validateQualificationInput({ ...input, model: QUALIFICATION_GEMINI_MODEL });
  assert.equal(validated.model, QUALIFICATION_GEMINI_MODEL);
  const handoff = buildTransportHandoff(
    policy,
    'json_schema',
    OPENROUTER_MAX_OUTPUT_TOKENS,
    null,
    QUALIFICATION_DEFAULT_ROUTING_PROFILE,
    validated.model,
  );
  assert.equal(handoff[0].model, QUALIFICATION_GEMINI_MODEL);
  assert.deepEqual(handoff[0].plugins, []);
  const receipt = buildQualificationReceipt({
    input: validated,
    policy,
    handoff,
    evaluation: { status: 'completed', rows: 3, fixture_set_valid: true, provider_attribution_valid: true },
    childTimedOut: false,
  });
  assert.equal(receipt.request_contract.model, QUALIFICATION_GEMINI_MODEL);
  assert.equal(receipt.request_contract.model_selection, 'qualification_override');
  assert.equal(receipt.integrity_gate.request_contract_valid, true);
  assert.equal(receipt.activation_authorized, false);
});

test('exact-head and signed release verification tolerate SHA casing but reject tag drift', async () => {
  const upperInput = { ...input, baseSha: input.baseSha.toUpperCase(), headSha: input.headSha.toUpperCase(), botSha: input.botSha.toUpperCase() };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/pulls/')) return { ok: true, json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha } }) };
    if (url.includes('/git/ref/tags/')) return { ok: true, json: async () => ({ object: { type: 'commit', sha: input.botSha } }) };
    return { ok: true, json: async () => ({ commit: { verification: { verified: true } } }) };
  };
  const { verifyPullRequest, verifyBotRelease } = await import('./openrouter-qualification.mjs');
  const normalized = validateQualificationInput(upperInput);
  await verifyPullRequest({ ...normalized, token: 'read-only-token', fetchImpl });
  await verifyBotRelease({ ...normalized, token: 'read-only-token', fetchImpl });
  assert.equal(calls.length, 3);
});

test('handoff contains exactly one direct OpenRouter transport under the common contract', () => {
  const handoff = buildTransportHandoff(policy);
  assert.deepEqual(handoff.map((transport) => transport.name), [OPENROUTER_TRANSPORT]);
  assert.equal(handoff[0].timeout_ms, OPENROUTER_TIMEOUT_MS);
  assert.equal(handoff[0].connect_timeout_ms, OPENROUTER_CONNECT_TIMEOUT_MS);
  assert.equal(handoff[0].max_tokens, OPENROUTER_MAX_OUTPUT_TOKENS);
  assert.equal(handoff[0].reasoning_effort, OPENROUTER_REASONING_EFFORT);
  assert.equal(handoff[0].stream, true);
  assert.equal(handoff[0].structured_output_mode, 'json_object');
  assert.equal(handoff[0].provider_routing.sort, undefined);
  assert.equal(handoff[0].provider_routing.allow_fallbacks, true);
  assert.equal(handoff[0].provider_routing.require_parameters, true);
  assert.deepEqual(handoff[0].provider_routing.preferred_min_throughput, { p90: 40 });
  assert.deepEqual(handoff[0].provider_routing.preferred_max_latency, { p99: 3 });
  const receipt = buildQualificationReceipt({
    input,
    policy,
    handoff,
    evaluation: { status: 'completed', rows: 3, fixture_set_valid: true, provider_attribution_valid: true },
    childTimedOut: false,
  });
  assert.equal(receipt.request_contract.provider_routing.profile, 'default_uptime');
  assert.equal(receipt.request_contract.provider_routing.sort, null);
  assert.equal(receipt.integrity_gate.request_contract_valid, true);
  assert.equal(buildTransportHandoff(policy, 'json_schema')[0].structured_output_mode, 'json_schema');
  assert.equal(buildTransportHandoff(policy, 'json_object', 65_536)[0].max_tokens, 65_536);
});

test('qualification retains a throughput-sorted control without changing production policy', () => {
  const handoff = buildTransportHandoff(policy, 'json_object', 24_576, null, 'throughput_sorted');
  assert.equal(handoff[0].provider_routing.sort, 'throughput');
  assert.equal(handoff[0].provider_routing.allow_fallbacks, true);
  const receipt = buildQualificationReceipt({
    input: { ...input, routingProfile: 'throughput_sorted' },
    policy,
    handoff,
    evaluation: { status: 'completed', rows: 3, fixture_set_valid: true, provider_attribution_valid: true },
    childTimedOut: false,
  });
  assert.equal(receipt.request_contract.provider_routing.profile, 'throughput_sorted');
  assert.equal(receipt.request_contract.provider_routing.sort, 'throughput');
  assert.equal(receipt.integrity_gate.request_contract_valid, true);
});

test('provider pinning is an isolated diagnostic override and disables gateway fallback', () => {
  const handoff = buildTransportHandoff(policy, 'json_schema', 24_576, 'openinference');
  assert.deepEqual(handoff[0].provider_routing.order, ['openinference']);
  assert.equal(handoff[0].provider_routing.allow_fallbacks, false);
  assert.equal(handoff[0].provider_routing.sort, undefined);
  assert.equal(handoff[0].provider_routing.preferred_min_throughput, undefined);
  assert.equal(handoff[0].provider_routing.preferred_max_latency, undefined);
  assert.throws(() => buildTransportHandoff(policy, 'json_object', 24_576, 'morph'), /excluded/u);
});

test('pinned receipts bind the diagnostic upstream without authorizing activation', () => {
  const pinnedInput = validateQualificationInput({ ...input, providerSlug: 'openinference' });
  const handoff = buildTransportHandoff(policy, 'json_schema', 24_576, pinnedInput.providerSlug);
  const receipt = buildQualificationReceipt({
    input: pinnedInput,
    policy,
    handoff,
    evaluation: { status: 'completed', rows: 3, fixture_set_valid: true, provider_attribution_valid: true },
    childTimedOut: false,
  });
  assert.deepEqual(receipt.request_contract.provider_routing, {
    mode: 'pinned', profile: 'default_uptime', provider_slug: 'openinference', order: ['openinference'], allow_fallbacks: false, sort: null,
  });
  assert.equal(receipt.integrity_gate.request_contract_valid, true);
  assert.equal(receipt.activation_authorized, false);
  assert.equal(receipt.provider_mutation, 'none');
});

test('child environment strips every non-OpenRouter provider credential', () => {
  const environment = buildArmEnvironment({
    baseEnv: {
      FIREWORKS_PR_REVIEW_API_KEY: 'fireworks-secret',
      OLLAMA_PR_REVIEW_API_KEY: 'ollama-secret',
      OPENROUTER_PR_REVIEW_API_KEY: 'openrouter-secret',
      GITHUB_TOKEN: 'github-secret',
      QUALIFICATION_GH_TOKEN: 'qualification-secret',
    },
    handoff: buildTransportHandoff(policy),
    botSha: input.botSha,
    fixturePath: '/tmp/matrix.json',
  });
  assert.equal(environment.OPENROUTER_PR_REVIEW_API_KEY, 'openrouter-secret');
  assert.equal(environment.FIREWORKS_PR_REVIEW_API_KEY, undefined);
  assert.equal(environment.OLLAMA_PR_REVIEW_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.QUALIFICATION_GH_TOKEN, undefined);
  assert.equal(environment.QUALIFICATION_ARM, 'openrouter');
});

test('child timeout sends SIGTERM then SIGKILL and cannot exceed ten minutes', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const result = await runChild({
    command: 'node', args: [], cwd: process.cwd(), env: process.env,
    spawnImpl: () => child, timeoutMs: 5, killGraceMs: 1,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(normalizeChildTimeoutMs(), QUALIFICATION_CHILD_TIMEOUT_MS);
  assert.equal(QUALIFICATION_CHILD_TIMEOUT_MS, 600_000);
  assert.equal(QUALIFICATION_HEARTBEAT_MS, 15_000);
  assert.throws(() => normalizeChildTimeoutMs(QUALIFICATION_CHILD_TIMEOUT_MS + 1), /childTimeoutMs must be an integer/u);
});

if (process.platform !== 'win32') {
  test('child timeout terminates the evaluator process group, including descendants', async () => {
    let childPid;
    const grandchildScript = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' }); setInterval(() => {}, 10000);";
    const result = await runChild({
      command: process.execPath,
      args: ['-e', grandchildScript],
      cwd: process.cwd(),
      env: process.env,
      spawnImpl: (command, args, options) => {
        const child = spawn(command, args, options);
        childPid = child.pid;
        return child;
      },
      timeoutMs: 25,
      killGraceMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.ok(Number.isInteger(childPid));
    assert.throws(() => process.kill(-childPid, 0), (error) => error?.code === 'ESRCH');
  });
}

test('qualification writes sanitized, non-authoritative evidence and uses one child', async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'openrouter-qualification-'));
  let captured;
  try {
    const highBudgetInput = { ...input, maxTokens: 65_536 };
    const result = await runQualification({
      input: highBudgetInput,
      policy,
      token: 'read-only-token',
      outputDir,
      fetchImpl: async (url) => {
        if (url.includes('/pulls/')) {
          return { ok: true, json: async () => ({ base: { sha: highBudgetInput.baseSha }, head: { sha: highBudgetInput.headSha } }) };
        }
        if (url.includes('/git/ref/tags/')) {
          return { ok: true, json: async () => ({ object: { type: 'commit', sha: highBudgetInput.botSha } }) };
        }
        return { ok: true, json: async () => ({ commit: { verification: { verified: true } } }) };
      },
      spawnImpl: (_command, args, options) => {
        captured = { args, env: options.env };
        const outputPath = args[args.indexOf('--out') + 1];
        const rows = FIXTURE_IDS.map((fixtureId, index) => ({
          fixtureId,
          repetition: 1,
          category: index === 2 ? 'clean' : 'defect',
          detected: index !== 2,
          falsePositive: false,
          errored: false,
          latencyMs: index + 10,
          provider: 'openrouter',
          transport: 'openrouter-fallback',
          responseStatus: 200,
          attemptCount: 1,
          responseAttempts: [{ attempt: 1, outcome: 'parsed', provider: 'openrouter', transport: 'openrouter-fallback' }],
        }));
        writeFileSync(outputPath, JSON.stringify({ rows }, null, 2));
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
      childTimeoutMs: 100,
      runId: 'openrouter-test',
    });
    assert.equal(captured.env.QUALIFICATION_ARM, 'openrouter');
    assert.deepEqual(JSON.parse(captured.env.REVIEW_YETI_TRANSPORTS).map((transport) => transport.name), [OPENROUTER_TRANSPORT]);
    assert.deepEqual(captured.args.slice(1, 5), ['lanes', '--arm', 'candidate', '--fixture']);
    assert.equal(captured.args[captured.args.indexOf('--repetitions') + 1], '1');
    assert.equal(captured.args[captured.args.indexOf('--concurrency') + 1], '3');
    assert.equal(captured.args[captured.args.indexOf('--max-tokens') + 1], '65536');
    assert.equal(result.receipt.schema, 'review-yeti.openrouter-qualification.v1');
    assert.equal(result.receipt.integrity_gate.passed, true);
    assert.equal(result.receipt.authoritative_arm, 'none');
    assert.equal(result.receipt.production_authority, 'unchanged');
    assert.equal(result.receipt.activation_authorized, false);
    assert.equal(result.receipt.publication, 'none');
    assert.equal(result.receipt.provider_mutation, 'none');
    assert.equal(result.receipt.evaluation.rows, 3);
    assert.equal(result.receipt.evaluation.provider_attribution_valid, true);
    assert.equal(result.receipt.evaluation.fixture_set_valid, true);
    assert.equal(result.receipt.request_contract.structured_output_mode, 'json_object');
    assert.equal(result.receipt.request_contract.max_output_tokens, 65_536);
    assert.equal(result.receipt.integrity_gate.request_contract_valid, true);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('receipt integrity fails closed on missing or misattributed evidence', () => {
  const handoff = buildTransportHandoff(policy);
  const receipt = buildQualificationReceipt({
    input,
    policy,
    handoff,
    evaluation: {
      status: 'completed', rows: 3, fixture_set_valid: true, provider_attribution_valid: false,
    },
    childTimedOut: false,
  });
  assert.equal(receipt.integrity_gate.passed, false);
  assert.equal(receipt.publication, 'none');
  assert.equal(receipt.activation_authorized, false);
});

test('schema-mode qualification remains non-authoritative and records the selected contract', () => {
  const schemaInput = { ...input, outputContractMode: 'json_schema' };
  const validated = validateQualificationInput(schemaInput);
  const handoff = buildTransportHandoff(policy, validated.outputContractMode);
  const receipt = buildQualificationReceipt({
    input: validated,
    policy,
    handoff,
    evaluation: {
      status: 'completed', rows: 3, fixture_set_valid: true, provider_attribution_valid: true,
    },
    childTimedOut: false,
  });
  assert.equal(receipt.request_contract.structured_output_mode, 'json_schema');
  assert.equal(receipt.integrity_gate.request_contract_valid, true);
  assert.equal(receipt.activation_authorized, false);
  assert.equal(receipt.authoritative_arm, 'none');
  assert.equal(receipt.publication, 'none');
  assert.equal(receipt.provider_mutation, 'none');
});

test('row-level attribution is required and cannot pass vacuously', () => {
  const rows = FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: index === 0 ? undefined : 'openrouter',
    transport: index === 0 ? undefined : 'openrouter-fallback',
  }));
  assert.equal(summarizeRows(rows, 0).provider_attribution_valid, false);
});

test('receipt keeps bounded RCA telemetry and observed partial cost without response bodies', () => {
  const fixtureId = FIXTURE_IDS[0];
  const rows = [
    {
      fixtureId, repetition: 1, category: 'defect', detected: true, falsePositive: false, errored: false,
      latencyMs: 100, provider: 'wafer', transport: OPENROUTER_TRANSPORT,
      usage: { promptTokens: 100, completionTokens: 200, costUSD: 0.012345 },
      responseAttempts: [{ attempt: 1, outcome: 'parsed', transport: 'openrouter', provider: 'wafer', outputShape: 'direct_json_object', responseStatus: 200 }],
    },
    {
      fixtureId, repetition: 2, category: 'defect', detected: false, falsePositive: false, errored: true,
      latencyMs: 200, provider: OPENROUTER_TRANSPORT, transport: OPENROUTER_TRANSPORT,
      responseStatus: 200, attemptCount: 1,
      responseAttempts: [{ attempt: 1, outcome: 'transport_error', transport: 'openrouter', failureClass: 'unknown', outputShape: 'empty_content', responseStatus: 200 }],
    },
  ];
  const summary = summarizeRows(rows, 0, 2, [fixtureId]);
  assert.equal(summary.cost_telemetry_status, 'partial');
  assert.equal(summary.cost_usd, null);
  assert.equal(summary.cost_usd_observed, 0.012345);
  assert.equal(summary.cost_observation_count, 1);
  assert.equal(summary.fixture_outcomes[1].failure_class, 'unknown');
  assert.equal(summary.fixture_outcomes[1].output_shape, 'empty_content');
  assert.equal(summary.fixture_outcomes[1].response_attempts[0].outcome, 'transport_error');
  assert.equal(summary.fixture_outcomes[0].response_attempts[0].provider, 'wafer');
  assert.equal(Object.hasOwn(summary.fixture_outcomes[1], 'response_body'), false);
});

test('receipt adds deterministic sanitized per-row identity and request/upstream fingerprints', () => {
  const rows = [1, 2].flatMap((repetition) => FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    repetition,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: 'openinference',
    transport: OPENROUTER_TRANSPORT,
    prompt: 'prompt contents must never enter a receipt',
    apiKey: 'openrouter-secret',
    responseAttempts: [{ attempt: 1, outcome: 'parsed', provider: 'openinference', transport: 'openrouter' }],
  })));
  const buildReceipt = () => buildQualificationReceipt({
    input: { ...input, repetitions: 2 },
    policy,
    handoff: buildTransportHandoff(policy),
    evaluation: summarizeRows(rows, 0, 2),
    childTimedOut: false,
    now: '2026-08-27T00:00:00.000Z',
  });
  const receipt = buildReceipt();
  const outcomes = receipt.evaluation.fixture_outcomes;
  assert.equal(receipt.prompt_contract.synthetic_prompt_identity, QUALIFICATION_SYNTHETIC_PROMPT_IDENTITY);
  for (const outcome of outcomes) {
    for (const field of ['invocation_identity', 'request_fingerprint', 'upstream_fingerprint']) {
      assert.match(outcome[field], /^[a-f0-9]{64}$/u);
    }
  }
  assert.notEqual(outcomes[0].invocation_identity, outcomes[1].invocation_identity, 'repetition changes invocation identity');
  assert.notEqual(outcomes[0].invocation_identity, outcomes[2].invocation_identity, 'fixture changes invocation identity');
  assert.notEqual(outcomes[0].request_fingerprint, outcomes[1].request_fingerprint, 'repetition changes request fingerprint');
  assert.notEqual(outcomes[0].request_fingerprint, outcomes[2].request_fingerprint, 'fixture changes request fingerprint');
  assert.notEqual(outcomes[0].upstream_fingerprint, outcomes[1].upstream_fingerprint, 'repetition changes upstream fingerprint');
  assert.notEqual(outcomes[0].upstream_fingerprint, outcomes[2].upstream_fingerprint, 'fixture changes upstream fingerprint');
  assert.deepEqual(buildReceipt(), receipt, 'fingerprints are deterministic');
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /openrouter-secret|prompt contents must never enter/u);
});

test('repeated fixture evidence requires every fixture exactly once per repetition', () => {
  const rows = [1, 2].flatMap((repetition) => FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    repetition,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: 'openrouter',
    transport: OPENROUTER_TRANSPORT,
    responseAttempts: [{ attempt: 1, outcome: 'parsed', provider: 'openrouter', transport: 'openrouter' }],
  })));
  assert.equal(summarizeRows(rows, 0, 2).fixture_set_valid, true);
  assert.equal(summarizeRows(rows.slice(1), 0, 2).fixture_set_valid, false);
  assert.equal(summarizeRows(rows, 0, 2).response_attempts, 6);
});

test('isolated fixture evidence can validate one fixture serially', () => {
  const fixtureId = FIXTURE_IDS[0];
  const rows = [1, 2].map((repetition) => ({
    fixtureId,
    repetition,
    category: 'defect',
    detected: true,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: 'openrouter',
    transport: OPENROUTER_TRANSPORT,
    responseStatus: 200,
    attemptCount: 1,
    responseAttempts: [{ attempt: 1, outcome: 'parsed', provider: 'openrouter', transport: 'openrouter' }],
  }));
  assert.equal(summarizeRows(rows, 0, 2, [fixtureId]).fixture_set_valid, true);
  const validated = validateQualificationInput({ ...input, fixtureId });
  const receipt = buildQualificationReceipt({
    input: validated,
    policy,
    handoff: buildTransportHandoff(policy),
    evaluation: { status: 'completed', rows: 2, fixture_set_valid: true, provider_attribution_valid: true },
    childTimedOut: false,
  });
  assert.deepEqual(receipt.fixture_ids, [fixtureId]);
  assert.equal(receipt.request_contract.concurrency, 1);
  const parallelValidated = validateQualificationInput({ ...input, fixtureId, concurrency: 3 });
  const parallelReceipt = buildQualificationReceipt({
    input: parallelValidated,
    policy,
    handoff: buildTransportHandoff(policy),
    evaluation: { status: 'completed', rows: 2, fixture_set_valid: true, provider_attribution_valid: true },
    childTimedOut: false,
  });
  assert.equal(parallelReceipt.request_contract.concurrency, 3);
});

test('single-repetition callers may omit repetition, but duplicates fail closed', () => {
  const singleRunRows = FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: 'openrouter',
    transport: OPENROUTER_TRANSPORT,
    responseAttempts: [{ attempt: 1, outcome: 'parsed', transport: 'openrouter' }],
  }));
  assert.equal(summarizeRows(singleRunRows, 0).fixture_set_valid, true);
  const duplicateRows = [1, 2].flatMap((repetition) => FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    repetition: fixtureId === FIXTURE_IDS[0] ? 1 : repetition,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: 'openrouter',
    transport: OPENROUTER_TRANSPORT,
    responseAttempts: [{ attempt: 1, outcome: 'parsed', transport: 'openrouter' }],
  })));
  assert.equal(summarizeRows(duplicateRows, 0, 2).fixture_set_valid, false);
});

test('upstream response labels remain informational for the OpenRouter route', () => {
  const rows = FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: index === 0 ? 'inceptron' : index === 1 ? 'openinference' : 'deepinfra',
    transport: OPENROUTER_TRANSPORT,
    responseAttempts: [{
      attempt: 1,
      outcome: 'parsed',
      provider: index === 0 ? 'inceptron' : index === 1 ? 'openinference' : 'deepinfra',
      transport: index === 0 ? 'openrouter' : OPENROUTER_TRANSPORT,
    }],
  }));
  assert.equal(summarizeRows(rows, 0).provider_attribution_valid, true);
});

test('missing or misrouted attempts cannot pass OpenRouter attribution', () => {
  const rows = FIXTURE_IDS.map((fixtureId, index) => ({
    fixtureId,
    category: index === 2 ? 'clean' : 'defect',
    detected: index !== 2,
    falsePositive: false,
    errored: false,
    latencyMs: 10,
    provider: 'deepinfra',
    transport: OPENROUTER_TRANSPORT,
    responseAttempts: index === 0 ? [] : [{
      attempt: 1,
      outcome: 'parsed',
      provider: index === 1 ? 'ollama' : 'unknown-provider',
      transport: index === 1 ? 'ollama' : OPENROUTER_TRANSPORT,
    }],
  }));
  assert.equal(summarizeRows(rows, 0).provider_attribution_valid, false);
});
