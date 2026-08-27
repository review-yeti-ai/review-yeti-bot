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
  OPENROUTER_TIMEOUT_MS,
  OPENROUTER_TRANSPORT,
  QUALIFICATION_CHILD_TIMEOUT_MS,
  QUALIFICATION_HEARTBEAT_MS,
  buildArmEnvironment,
  buildQualificationReceipt,
  buildTransportHandoff,
  normalizeChildTimeoutMs,
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
  assert.match(workflow, /environment:\s*\n\s+name:\s*review-yeti-openrouter-qualification/u);
  const jobEnv = workflow.split('    env:\n', 2)[1]?.split('    steps:', 1)[0] || '';
  assert.doesNotMatch(jobEnv, /OPENROUTER_PR_REVIEW_API_KEY/u);
  assert.match(workflow, /publication or provider mutation/u);
});

test('input requires immutable coordinates and an explicit confirmation', () => {
  assert.equal(validateQualificationInput(input).prNumber, 278);
  for (const [field, value] of [['confirm', 'yes'], ['repository', 'invalid'], ['baseSha', 'short'], ['botReleaseTag', 'main'], ['botRoot', 'relative']]) {
    assert.throws(() => validateQualificationInput({ ...input, [field]: value }), /confirm|repository|SHA|botReleaseTag|absolute/u);
  }
  assert.throws(() => validateQualificationInput({ ...input, headSha: input.baseSha }), /must differ/u);
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
    const result = await runQualification({
      input,
      policy,
      token: 'read-only-token',
      outputDir,
      fetchImpl: async (url) => {
        if (url.includes('/pulls/')) {
          return { ok: true, json: async () => ({ base: { sha: input.baseSha }, head: { sha: input.headSha } }) };
        }
        if (url.includes('/git/ref/tags/')) {
          return { ok: true, json: async () => ({ object: { type: 'commit', sha: input.botSha } }) };
        }
        return { ok: true, json: async () => ({ commit: { verification: { verified: true } } }) };
      },
      spawnImpl: (_command, args, options) => {
        captured = { args, env: options.env };
        const outputPath = args[args.indexOf('--out') + 1];
        const rows = FIXTURE_IDS.map((fixtureId, index) => ({
          fixtureId,
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
      provider: index === 1 ? 'openinference' : 'openrouter',
      transport: OPENROUTER_TRANSPORT,
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
