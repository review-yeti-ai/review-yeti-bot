import test from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASELINE_PROFILE,
  CANDIDATE_PROFILE,
  FIXTURE_IDS,
  buildArmEnvironment,
  buildQualificationReceipt,
  buildTransportHandoff,
  runQualification,
  summarizeEvaluation,
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
  botRoot: '/tmp/review-yeti-bot',
};

test('qualification input is fail-closed and requires immutable coordinates', () => {
  assert.deepEqual(validateQualificationInput(input).prNumber, 119);
  for (const [field, value] of [['confirm', 'yes'], ['repository', 'not-a-repository'], ['baseSha', 'short'], ['botRoot', 'relative']]) {
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
    baseline: {
      profile: BASELINE_PROFILE,
      exit_code: 0,
      status: 'completed',
      rows: 3,
      errored_runs: 0,
      defect_runs: 2,
      detected_defect_runs: 1,
      clean_runs: 1,
      false_positive_runs: 0,
      latency_ms_median: 100,
      latency_ms_p95: 200,
      cost_usd: 0.01,
    },
    candidate: {
      profile: CANDIDATE_PROFILE,
      exit_code: 0,
      status: 'completed',
      rows: 3,
      errored_runs: 0,
      defect_runs: 2,
      detected_defect_runs: 2,
      clean_runs: 1,
      false_positive_runs: 0,
      latency_ms_median: 90,
      latency_ms_p95: 180,
      cost_usd: 0,
    },
  });
  assert.deepEqual(receipt.fixture_ids, FIXTURE_IDS);
  assert.equal(receipt.authoritative_arm, 'baseline');
  assert.equal(receipt.publication, 'none');
  assert.equal(receipt.provider_mutation, 'none');
  assert.equal(receipt.promotion_gate, 'manual_review_required');
  assert.equal(receipt.candidate_eligible_for_next_step, true);
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
  assert.equal(JSON.stringify(receipt).includes('findingsDetail'), false);
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
    latency_ms_median: 100,
    latency_ms_p95: 200,
    cost_usd: 0.3,
  });
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
    writeFileSync(output, JSON.stringify({ rows: [
      { category: 'defect', detected: true, errored: false, latencyMs: 10, usage: { costUSD: 0 } },
      { category: 'clean', falsePositive: false, errored: false, latencyMs: 20, usage: { costUSD: 0 } },
      { category: 'defect', detected: true, errored: false, latencyMs: 30, usage: { costUSD: 0 } },
    ] }));
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
