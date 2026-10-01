import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as priorValidator from '../test/fixtures/prior-promoted-v1/scripts/validate-central-dispatch.mjs';

import {
  CENTRAL_REPOSITORY,
  DEFAULT_GLOBAL_CONCURRENCY_CAP,
  DEFAULT_REPOSITORY_CONCURRENCY_CAP,
  CAPACITY_RUN_STATUSES,
  DISPATCH_EVENT_TYPE,
  TARGET_REPOSITORY,
  assertAdmittedRepository,
  assertRepositoryCapacity,
  globalConcurrencyCap,
  normalizeCentralDispatchPayload,
  repositoryConcurrencyCap,
  validateCallerWorkflow,
  validateCentralDispatch,
  validateDispatchPayload,
  validateExecutionContext,
} from './validate-central-dispatch.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const callerRunId = 33572874647;
const callerRunAttempt = 2;
const payload = Object.freeze({
  request_id: `example-api:4527:${headSha}:${callerRunId}:${callerRunAttempt}`,
  repository: TARGET_REPOSITORY,
  pr_number: 4527,
  base_sha: baseSha,
  head_sha: headSha,
});
const receiverWorkflow = readFileSync(new URL('../.github/workflows/repository-dispatch.yml', import.meta.url), 'utf8');
const reusableWorkflow = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');

function workflowStepBlock(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const blockStart = start + marker.length;
  const next = source.indexOf('\n      - name: ', blockStart);
  return source.slice(blockStart, next === -1 ? source.length : next + 1);
}

function workflowStepRun(source, name) {
  const block = workflowStepBlock(source, name);
  const run = block.match(/^        run: \|\n([\s\S]*)$/mu);
  assert.ok(run, `missing run body for ${name}`);
  return run[1].split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

function resolveWorkflowTargetScope(workflow, targetRepository) {
  const directory = mkdtempSync(`${tmpdir()}/review-yeti-token-scope-`);
  const outputPath = `${directory}/github-output`;
  try {
    const result = spawnSync('bash', ['-c', workflowStepRun(workflow, 'Resolve target repository scope')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath, TARGET_REPOSITORY: targetRepository },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => line.split('=', 2)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function resolveValidationTokenScope(targetRepository) {
  return resolveWorkflowTargetScope(receiverWorkflow, targetRepository);
}

// ADR 0490 scope widened 2026-09-02 (example-review-actions #200): every admitted
// repository must pass the full dispatch contract end-to-end, not just the
// example-api namespace — the repo-name group shifted the REQUEST_ID_PATTERN
// capture indices, and an off-by-one would silently bind the wrong PR/SHA.
const WIDED_REPOSITORIES = [
  { repository: TARGET_REPOSITORY, name: 'example-api', pr: 4527 },
  { repository: 'exampleorg/example-release', name: 'example-release', pr: 771 },
  { repository: 'exampleorg/example-meta', name: 'example-meta', pr: 2704 },
  { repository: CENTRAL_REPOSITORY, name: 'example-review-actions', pr: 293 },
];

function buildFixture({ repository, name, pr, callerPath = '.github/workflows/ct-review-bot.yml' }) {
  const request = {
    request_id: `${name}:${pr}:${headSha}:${callerRunId}:${callerRunAttempt}`,
    repository,
    pr_number: pr,
    base_sha: baseSha,
    head_sha: headSha,
  };
  const fetchImpl = async (url) => {
    if (url.endsWith(`/pulls/${pr}`)) {
      return response({
        state: 'open',
        base: { sha: baseSha, ref: 'main', repo: { full_name: repository, default_branch: 'main' } },
        head: { sha: headSha, ref: `fix/${name}-shim` },
      });
    }
    if (url.endsWith(`/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: repository },
        event: 'pull_request_target',
        path: callerPath,
        head_sha: headSha,
        head_branch: `fix/${name}-shim`,
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: pr }],
      });
    }
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) {
      // An idle lane: the happy path must exercise the real capacity branch.
      return response({ workflow_runs: [] });
    }
    if (url.includes(`/commits/${headSha}/check-runs?`)) {
      return response({ total_count: 1, check_runs: [infrastructureFailedFirstAttemptCheck()] });
    }
    if (url.includes(`/contents/${callerPath}?ref=`)) {
      return response({ encoding: 'base64', content: Buffer.from(callerWorkflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { request, fetchImpl };
}
const callerWorkflow = `
name: Review Yeti dispatch
on: pull_request_target
jobs:
  dispatch:
    steps:
      - run: gh api repos/exampleorg/example-review-actions/dispatches -f event_type=${DISPATCH_EVENT_TYPE}
`;

function infrastructureFailedFirstAttemptCheck(id = 100) {
  return {
    id,
    name: 'Review Yeti',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    external_id: `run_${'1'.repeat(32)}:a1`,
    app: { id: 4385771, slug: 'ct-review-bot' },
    output: { title: 'Review Yeti: review did not complete', summary: 'recorded dead first attempt', text: null },
  };
}

function response(payloadValue, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payloadValue,
  };
}

function successFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/pulls/4527')) {
      return response({
        state: 'open',
        base: { sha: baseSha, ref: '0.8.8-stable', repo: { full_name: TARGET_REPOSITORY, default_branch: '0.8.7-stable' } },
        head: { sha: headSha, ref: 'feat/API-0000-pr-source-branch' },
      });
    }
    if (url.endsWith(`/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: TARGET_REPOSITORY },
        event: 'pull_request_target',
        path: '.github/workflows/ct-review-bot.yml',
        head_sha: headSha,
        head_branch: 'feat/API-0000-pr-source-branch',
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: 4527 }],
      });
    }
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) {
      // An idle lane: the happy path must exercise the real capacity branch.
      return response({ workflow_runs: [] });
    }
    if (url.includes(`/commits/${headSha}/check-runs?`)) {
      return response({ total_count: 1, check_runs: [infrastructureFailedFirstAttemptCheck()] });
    }
    if (url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=')) {
      return response({ encoding: 'base64', content: Buffer.from(callerWorkflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('accepts only the sanitized Cisco dispatch identity contract', () => {
  assert.deepEqual(validateDispatchPayload(payload), payload);
  assert.deepEqual(validateDispatchPayload({ ...payload, refresh_requested: true }), {
    ...payload, refresh_requested: true,
  });
  for (const invalid of [
    { ...payload, repository: 'exampleorg/another-repo' },
    { ...payload, pr_number: '4527' },
    { ...payload, base_sha: baseSha.toUpperCase() },
    { ...payload, head_sha: 'b'.repeat(39) },
    { ...payload, request_id: '../escape' },
    { ...payload, request_id: `example-api:4528:${headSha}:${callerRunId}:${callerRunAttempt}` },
    { ...payload, provider: 'ollama' },
    { ...payload, ollama_api_key: 'secret' },
    { ...payload, recovery_kind: 'incomplete_p2' },
    { ...payload, incompleteP2Recovery: true },
    { ...payload, refresh_requested: 'true' },
  ]) {
    assert.throws(() => validateDispatchPayload(invalid));
  }
});

test('normalizes only workflow_dispatch inputs into the strict central payload contract', () => {
  const manualInputs = {
    ...payload,
    pr_number: '4527',
    refresh_requested: 'false',
  };

  const normalized = normalizeCentralDispatchPayload({
    eventName: 'workflow_dispatch',
    payload: manualInputs,
  });

  assert.deepEqual(normalized, { ...payload, refresh_requested: false });
  assert.deepEqual(validateDispatchPayload(normalized), normalized);
  assert.deepEqual(
    normalizeCentralDispatchPayload({
      eventName: 'workflow_dispatch',
      payload: { ...manualInputs, refresh_requested: 'true' },
    }),
    { ...payload, refresh_requested: true },
  );
  assert.throws(
    () => normalizeCentralDispatchPayload({
      eventName: 'workflow_dispatch',
      payload: { ...manualInputs, pr_number: '4527.5' },
    }),
    /workflow_dispatch pr_number must be a positive safe integer/u,
  );
});

test('keeps repository_dispatch payloads strict and fail-closed', () => {
  const dispatchedPayload = { ...payload, pr_number: '4527', refresh_requested: false };

  assert.equal(
    normalizeCentralDispatchPayload({
      eventName: 'repository_dispatch',
      payload: dispatchedPayload,
    }),
    dispatchedPayload,
  );
  assert.throws(() => validateDispatchPayload(dispatchedPayload), /pr_number must be a positive safe integer/u);
  assert.throws(
    () => validateDispatchPayload({ ...payload, refresh_requested: 'false' }),
    /refresh_requested must be a boolean/u,
  );
});

// Execute the production shell with an old promoted checkout, not a same-head
// helper. This must keep working before v1 promotion and must not need tokens.
function normalizeWithReceiver(eventName, input) {
  const directory = mkdtempSync(`${tmpdir()}/review-yeti-normalization-`);
  const outputPath = `${directory}/github-output`;
  try {
    const result = spawnSync('bash', ['-c', workflowStepRun(receiverWorkflow, 'Normalize central dispatch payload')], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('../test/fixtures/prior-promoted-v1/', import.meta.url)),
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: outputPath,
        EVENT_NAME: eventName,
        EXECUTION_RUN_ID: String(callerRunId),
        EXECUTION_RUN_ATTEMPT: String(callerRunAttempt),
        RAW_CENTRAL_DISPATCH_PAYLOAD: JSON.stringify(input),
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || `normalization exited ${result.status}`);
    const output = readFileSync(outputPath, 'utf8').trim();
    assert.match(output, /^payload=/u);
    return JSON.parse(output.slice('payload='.length));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('new receiver works with the prior promoted validator and still binds the genuine caller', async () => {
  for (const eventName of ['repository_dispatch', 'workflow_dispatch']) {
    const normalized = normalizeWithReceiver(eventName, {
      ...payload,
      pr_number: eventName === 'workflow_dispatch' ? '4527' : 4527,
      refresh_requested: eventName === 'workflow_dispatch' ? 'false' : false,
    });
    assert.deepEqual(normalized, { ...payload, refresh_requested: false });
    const result = await priorValidator.validateCentralDispatch({
      payload: normalized, targetToken: 'target-token', centralToken: 'central-token', fetchImpl: successFetch([]),
    });
    assert.equal(result.caller_run_id, callerRunId);
    assert.equal(result.caller_run_attempt, callerRunAttempt);
    assert.equal(result.head_sha, headSha);
    for (const mutation of [
      { event: 'workflow_dispatch' }, { head_sha: 'c'.repeat(40) },
      { run_attempt: 999 }, { pull_requests: [] },
    ]) {
      const transport = successFetch([]);
      await assert.rejects(priorValidator.validateCentralDispatch({
        payload: normalized, targetToken: 'target-token', centralToken: 'central-token',
        fetchImpl: async (url, init) => {
          const res = await transport(url, init);
          return url.endsWith(`/actions/runs/${callerRunId}`)
            ? response({ ...await res.json(), ...mutation }) : res;
        },
      }));
    }
  }
});

test('manual dispatch synthesizes an immutable request identity from its own run when omitted', () => {
  const manual = { ...payload, request_id: '', pr_number: '4527', refresh_requested: 'true' };
  const expected = {
    ...payload,
    request_id: `example-api:4527:${headSha}:${callerRunId}:${callerRunAttempt}`,
    refresh_requested: true,
  };
  assert.deepEqual(normalizeCentralDispatchPayload({
    eventName: 'workflow_dispatch', payload: manual,
    runId: callerRunId, runAttempt: callerRunAttempt,
  }), expected);
  assert.deepEqual(normalizeWithReceiver('workflow_dispatch', manual), expected);
});

test('manual dispatch validates its central run without requiring a target caller workflow', async () => {
  const calls = [];
  const manualPayload = { ...payload, refresh_requested: true };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/pulls/4527')) {
      return response({
        state: 'open',
        base: { sha: baseSha, ref: '0.8.7-stable', repo: { full_name: TARGET_REPOSITORY, default_branch: '0.8.7-stable' } },
        head: { sha: headSha, ref: 'feat/manual-review' },
      });
    }
    if (url.endsWith(`/repos/${CENTRAL_REPOSITORY}/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: CENTRAL_REPOSITORY }, event: 'workflow_dispatch',
        path: '.github/workflows/repository-dispatch.yml', head_sha: 'c'.repeat(40),
        run_attempt: callerRunAttempt, status: 'in_progress',
      });
    }
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) return response({ workflow_runs: [] });
    if (url.includes(`/commits/${headSha}/check-runs?`)) {
      return response({ total_count: 1, check_runs: [infrastructureFailedFirstAttemptCheck()] });
    }
    if (url.includes(`/repos/${CENTRAL_REPOSITORY}/contents/.github/workflows/repository-dispatch.yml?ref=`)) {
      return response({ encoding: 'base64', content: Buffer.from(receiverWorkflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await validateCentralDispatch({
    payload: manualPayload, targetToken: 'target-token', centralToken: 'central-token', fetchImpl,
    eventName: 'workflow_dispatch', executionRunId: callerRunId, executionRunAttempt: callerRunAttempt,
  });
  assert.equal(result.caller_run_id, callerRunId);
  assert.equal(result.caller_workflow_path, '.github/workflows/repository-dispatch.yml');
  assert.equal(result.review_generation, 2);
  assert.equal(result.refresh_requested, true);
  assert.equal(calls.some(({ url }) => url.includes('/contents/.github/workflows/ct-review-bot.yml')), false);
  for (const mutation of [
    { event: 'repository_dispatch' }, { path: '.github/workflows/other.yml' },
    { head_sha: 'not-a-sha' }, { run_attempt: 99 }, { status: 'completed' },
  ]) {
    await assert.rejects(validateCentralDispatch({
      payload: manualPayload, targetToken: 'target-token', centralToken: 'central-token',
      eventName: 'workflow_dispatch', executionRunId: callerRunId, executionRunAttempt: callerRunAttempt,
      fetchImpl: async (url, init) => {
        const res = await fetchImpl(url, init);
        if (!url.endsWith(`/repos/${CENTRAL_REPOSITORY}/actions/runs/${callerRunId}`)) return res;
        return response({ ...await res.json(), ...mutation });
      },
    }), /manual dispatch run identity changed/u);
  }
});

for (const [boundary, normalize] of [
  ['helper', (eventName, input) => normalizeCentralDispatchPayload({ eventName, payload: input })],
  ['workflow', normalizeWithReceiver],
]) {
  test(`${boundary}: manual normalization accepts only typed numbers or decimal strings and exact booleans`, () => {
    for (const pr_number of [4527, '4527']) {
      for (const [refresh_requested, expected] of [[true, true], ['true', true], [false, false], ['false', false]]) {
        const normalized = normalize('workflow_dispatch', { ...payload, pr_number, refresh_requested });
        assert.deepEqual(normalized, { ...payload, refresh_requested: expected });
        assert.deepEqual(priorValidator.validateDispatchPayload(normalized), normalized);
      }
    }
  });
  for (const invalid of [[4527], ['4527'], [['4527']], {}, true, false, null, undefined,
    0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '', '0', '-1',
    '1.5', '1e3', '0x10', ' 4527', '4527 ', '04527']) {
    test(`${boundary}: rejects malformed manual pr_number ${JSON.stringify(invalid)}`, () => {
      assert.throws(() => normalize('workflow_dispatch', {
        ...payload, pr_number: invalid, refresh_requested: false,
      }), /workflow_dispatch pr_number must be a positive safe integer/u);
    });
  }
  for (const invalid of [[], ['true'], {}, null, undefined, 0, 1, '', 'TRUE', 'False', ' true']) {
    test(`${boundary}: rejects malformed manual refresh_requested ${JSON.stringify(invalid)}`, () => {
      assert.throws(() => normalize('workflow_dispatch', {
        ...payload, refresh_requested: invalid,
      }), /workflow_dispatch refresh_requested must be a boolean/u);
    });
  }
  test(`${boundary}: automated dispatch remains uncoerced and strictly rejected by old and current validators`, () => {
    for (const malformed of [
      { ...payload, pr_number: '4527' }, { ...payload, refresh_requested: 'false' },
      { ...payload, extra: 'field' }, { ...payload, request_id: 'forged' },
    ]) {
      const normalized = normalize('repository_dispatch', malformed);
      assert.deepEqual(normalized, malformed);
      assert.throws(() => priorValidator.validateDispatchPayload(normalized));
      assert.throws(() => validateDispatchPayload(normalized));
    }
  });
}

test('request_id namespace must match the payload repository', () => {
  const mismatched = {
    request_id: `example-release:771:${headSha}:${callerRunId}:${callerRunAttempt}`,
    repository: 'exampleorg/example-meta',
    pr_number: 771,
    base_sha: baseSha,
    head_sha: headSha,
  };
  assert.throws(() => validateDispatchPayload(mismatched));
});

test('every admitted repository passes the full dispatch contract with its own request_id namespace', async () => {
  for (const fixture of WIDED_REPOSITORIES.map(buildFixture)) {
    const calls = [];
    const result = await validateCentralDispatch({
      payload: fixture.request,
      token: 'central-token',
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.repository, fixture.request.repository);
    assert.equal(result.pr_number, fixture.request.pr_number);
    assert.equal(result.head_sha, headSha);
    assert.equal(result.caller_run_id, callerRunId);
    assert.equal(result.caller_run_attempt, callerRunAttempt);
    assert.match(result.caller_workflow_sha256, /^[0-9a-f]{64}$/u);
  }
});

test('requires the central repository_dispatch execution context', () => {
  assert.doesNotThrow(() => validateExecutionContext({
    repository: CENTRAL_REPOSITORY,
    eventName: 'repository_dispatch',
    eventAction: DISPATCH_EVENT_TYPE,
  }));
  assert.doesNotThrow(() => validateExecutionContext({
    repository: CENTRAL_REPOSITORY,
    eventName: 'workflow_dispatch',
    eventAction: '',
  }));
  assert.throws(() => validateExecutionContext({ repository: TARGET_REPOSITORY, eventName: 'repository_dispatch', eventAction: DISPATCH_EVENT_TYPE }), /central execution/);
  assert.throws(() => validateExecutionContext({ repository: CENTRAL_REPOSITORY, eventName: 'pull_request_target', eventAction: DISPATCH_EVENT_TYPE }), /requires repository_dispatch/);
});

test('validates exact live PR identity and the immutable base-owned caller with the central token', async () => {
  const calls = [];
  const result = await validateCentralDispatch({ payload, token: 'central-token', fetchImpl: successFetch(calls) });

  assert.equal(result.repository, TARGET_REPOSITORY);
  assert.equal(result.head_sha, headSha);
  assert.match(result.caller_workflow_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.caller_run_id, callerRunId);
  assert.equal(result.caller_run_attempt, callerRunAttempt);
  // 6 calls: PR identity, caller run, two capacity listings (queued and
  // in_progress), exact-head App checks, and caller workflow bytes. Capacity is
  // checked after identity so an invalid request reports the validation
  // failure, not a capacity message.
  assert.equal(calls.length, 6);
  assert.equal(calls[0].init.headers.authorization, 'Bearer central-token');
  assert.equal(calls[1].url.endsWith(`/actions/runs/${callerRunId}`), true);
  // The fixture PR targets 0.8.8-stable while the default branch is 0.8.7-stable: the caller
  // bytes must be read from the default branch (what GitHub executes), never from base.ref.
  const listings = calls.filter((call) => call.url.includes('/actions/workflows/repository-dispatch.yml/runs'));
  assert.equal(listings.length, 2);
  assert.deepEqual(
    listings.map((call) => new URL(call.url).searchParams.get('status')).sort(),
    ['in_progress', 'queued'],
  );
  assert.equal(calls[5].url.endsWith('?ref=0.8.7-stable'), true);
  assert.equal(calls[5].url.includes('0.8.8-stable'), false);
  assert.equal(calls.some((call) => call.url.includes('central-token')), false);
});

test('exampleorg recovery queries both worker and authoritative Gate from App 438', async () => {
  const calls = [];
  const defaultFetch = successFetch(calls);
  const worker = {
    ...infrastructureFailedFirstAttemptCheck(),
    status: 'completed',
    conclusion: 'failure',
    completed_at: '2026-09-30T10:01:00Z',
    output: {
      title: 'Review Yeti: BLOCK',
      summary: [
        `Verdict \`BLOCK\` at \`${headSha}\`.`,
        'Findings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).',
        'Coverage: mode=panel; expected lanes=2; completed lanes=1; failed lanes=1; roster valid=true; quorum satisfied=false; full panel complete=false.',
      ].join('\n'),
      text: null,
    },
  };
  const gate = {
    id: 101,
    name: 'Review Yeti Gate',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    external_id: `review-yeti-gate:v1:${'2'.repeat(64)}`,
    completed_at: '2026-09-30T10:02:00Z',
    app: { id: 4385771, slug: 'ct-review-bot' },
    output: {
      title: 'Review Yeti Gate: Failed',
      summary: 'Review Yeti Gate failed: infrastructure-failure. This is not an approval.',
    },
  };
  const fetchImpl = async (url, init) => {
    if (url.includes(`/commits/${headSha}/check-runs?`)) {
      calls.push({ url, init });
      const query = new URL(url).searchParams;
      const rows = query.get('check_name') === 'Review Yeti' ? [worker] : [gate];
      return response({ total_count: rows.length, check_runs: rows });
    }
    return defaultFetch(url, init);
  };

  const result = await validateCentralDispatch({ payload, token: 'central-token', fetchImpl });

  assert.equal(result.review_generation, 2);
  assert.deepEqual(calls
    .filter((call) => call.url.includes(`/commits/${headSha}/check-runs?`))
    .map((call) => {
      const query = new URL(call.url).searchParams;
      return [query.get('check_name'), query.get('app_id')];
    }), [
    ['Review Yeti', '4385771'],
    ['Review Yeti Gate', '4385771'],
  ]);
});

test('fails closed on missing central credentials, stale identity, or a GitHub lookup failure', async () => {
  await assert.rejects(
    validateCentralDispatch({ payload, token: '', fetchImpl: successFetch([]) }),
    /App token \(GH_TOKEN\) is required/,
  );
  await assert.rejects(
    validateCentralDispatch({
      payload,
      token: 'central-token',
      fetchImpl: async () => response({
        state: 'open',
        base: { sha: baseSha, ref: '0.8.7-stable', repo: { full_name: TARGET_REPOSITORY, default_branch: '0.8.7-stable' } },
        head: { sha: 'c'.repeat(40) },
      }),
    }),
    /PR head SHA changed/,
  );
  await assert.rejects(
    validateCentralDispatch({ payload, token: 'central-token', fetchImpl: async () => response({}, 403) }),
    /HTTP 403/,
  );
});

test('rejects a forged or stale originating caller run', async () => {
  for (const mutate of [
    (run) => { run.event = 'workflow_dispatch'; },
    (run) => { run.path = '.github/workflows/other.yml'; },
    (run) => { run.head_sha = 'c'.repeat(40); },
    (run) => { run.head_sha = baseSha; },
    (run) => { run.head_branch = 'other/branch'; },
    (run) => { run.run_attempt = 3; },
    (run) => { run.pull_requests = [{ number: 9999 }]; },
  ]) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      if (!url.endsWith(`/actions/runs/${callerRunId}`)) return successFetch(calls)(url, init);
      const run = {
        repository: { full_name: TARGET_REPOSITORY },
        event: 'pull_request_target',
        path: '.github/workflows/ct-review-bot.yml',
        head_sha: headSha,
        head_branch: 'feat/API-0000-pr-source-branch',
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: 4527 }],
      };
      mutate(run);
      return response(run);
    };
    await assert.rejects(validateCentralDispatch({ payload, token: 'central-token', fetchImpl }));
  }
});

test('immutable caller contract rejects inherited or provider credentials and direct reusable execution', () => {
  assert.match(validateCallerWorkflow(callerWorkflow), /^[0-9a-f]{64}$/u);
  for (const forbidden of [
    'secrets: inherit',
    'OLLAMA_PR_REVIEW_API_KEY',
    'OPENROUTER_REVIEW_FLEET_KEY',
    'uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1',
  ]) {
    assert.throws(() => validateCallerWorkflow(`${callerWorkflow}\n${forbidden}\n`));
  }
});

test('workflow contract delegates promoted v1 bytes and keeps provider secrets in the central job', () => {
  const receiver = receiverWorkflow;
  const reusable = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');

  assert.match(receiver, /types:\s*\[review-yeti-request\]/u);
  assert.match(receiver, /run-name:\s*Review Yeti central \/ \$\{\{ github\.event\.client_payload\.request_id \|\| inputs\.request_id \|\| format\(/u);
  assert.match(receiver, /group:\s*central-review-yeti-\$\{\{ github\.event\.client_payload\.repository \|\| inputs\.repository \}\}-\$\{\{ github\.event\.client_payload\.pr_number \|\| inputs\.pr_number \}\}-\$\{\{ github\.event\.client_payload\.head_sha \|\| inputs\.head_sha \}\}/u);
  assert.match(receiver, /cancel-in-progress:\s*false/u);
  assert.match(receiver, /uses: exampleorg\/example-review-actions\/\.github\/workflows\/review-yeti\.yml@v1/u);
  assert.match(receiver, /review_generation:\s*\$\{\{ steps\.request\.outputs\.review_generation \}\}/u);
  assert.match(receiver, /refresh_execution_attempt:\s*\$\{\{ steps\.request\.outputs\.refresh_execution_attempt \}\}/u);
  assert.match(receiver, /expected_generation:\s*\$\{\{ fromJSON\(needs\.validate\.outputs\.review_generation\) \}\}/u);
  assert.match(receiver, /refresh_execution_attempt:\s*\$\{\{ fromJSON\(needs\.validate\.outputs\.refresh_execution_attempt\) \}\}/u);
  // REL-1163: central defaults to doks; mars is an explicit opt-in only (on hold pending funds).
  assert.match(receiver, /execution_backend:\s*\$\{\{ vars\.REVIEW_YETI_CENTRAL_EXECUTION_BACKEND == 'mars' && 'mars' \|\| 'doks' \}\}/u);
  assert.doesNotMatch(receiver, /execution_backend:\s*mars\s*$/mu);
  assert.match(receiver, /secrets: inherit/u);
  // REL-540 / ADR 0511: the receiver's validate job runs as the ct-review-bot App, never the PAT.
  assert.match(receiver, /create-github-app-token@[0-9a-f]{40}/u);
  assert.match(receiver, /app-id: \$\{\{ secrets\.CT_REVIEW_BOT_APP_ID \}\}/u);
  const normalizationBlock = workflowStepBlock(receiver, 'Normalize central dispatch payload');
  const normalizationStep = workflowStepRun(receiver, 'Normalize central dispatch payload');
  assert.match(normalizationStep, /normalizeCentralDispatchPayload/u);
  assert.doesNotMatch(normalizationBlock, /working-directory:|secrets\.|steps\..*\.outputs\.token/u);
  assert.doesNotMatch(normalizationStep, /\bimport\b|\brequire\s*\(/u);
  assert.ok(receiver.indexOf('- name: Normalize central dispatch payload') < receiver.indexOf('- name: Checkout promoted central validator'));
  assert.ok(receiver.indexOf('- name: Normalize central dispatch payload') < receiver.indexOf('- name: Mint Review Yeti App token'));
  const checkout = workflowStepBlock(receiver, 'Checkout promoted central validator');
  assert.match(checkout, /ref: v1/u);
  assert.match(checkout, /persist-credentials: false/u);
  assert.match(normalizationBlock, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(normalizationBlock, /EXECUTION_RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.match(normalizationBlock, /EXECUTION_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/u);
  assert.match(normalizationBlock, /RAW_CENTRAL_DISPATCH_PAYLOAD: \$\{\{ toJSON\(github\.event\.client_payload \|\| inputs\) \}\}/u);
  assert.match(receiver, /CENTRAL_DISPATCH_PAYLOAD: \$\{\{ steps\.payload\.outputs\.payload \}\}/u);
  assert.doesNotMatch(receiver, /^\s{10}CENTRAL_DISPATCH_PAYLOAD: \$\{\{ toJSON\(github\.event\.client_payload \|\| inputs\) \}\}$/mu);
  assert.match(receiver, /recovery_kind: \$\{\{ steps\.request\.outputs\.recovery_kind \}\}/u);
  assert.match(receiver, /recovery_kind: \$\{\{ needs\.validate\.outputs\.recovery_kind \}\}/u);
  const validationTokenStep = receiver.match(/- name: Mint Review Yeti App token for exampleorg target validation[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for exact public target validation)/u)?.[0] ?? '';
  const scopedPermissions = [...validationTokenStep.matchAll(/^\s+permission-([a-z-]+):\s*(\w+)\s*$/gmu)]
    .map((match) => `${match[1]}:${match[2]}`).sort();
  assert.deepEqual(scopedPermissions, [
    'actions:read',
    'checks:read',
    'contents:read',
    'pull-requests:read',
  ]);
  assert.doesNotMatch(receiver, /secrets\.CROSS_REPO_TOKEN/u);
  assert.doesNotMatch(receiver, /OLLAMA_PR_REVIEW_API_KEY/u);
  assert.match(reusable, /OLLAMA_PR_REVIEW_API_KEY:\s*\$\{\{ secrets\.OLLAMA_PR_REVIEW_API_KEY \}\}/u);
  // GitHub-surface auth is fail-closed on the owner-scoped App token. Central
  // validation receives a separate token when the target owner differs.
  assert.match(reusable, /GH_TOKEN:\s*\$\{\{ steps\.target_token_exampleorg\.outputs\.token \|\| steps\.target_token_public\.outputs\.token \}\}/u);
  assert.match(reusable, /GH_TARGET_TOKEN:\s*\$\{\{ steps\.target_token_exampleorg\.outputs\.token \|\| steps\.target_token_public\.outputs\.token \}\}/u);
  assert.match(reusable, /GH_CENTRAL_TOKEN:\s*\$\{\{ steps\.central_token\.outputs\.token \}\}/u);
  assert.doesNotMatch(reusable, /github\.token/u);
  assert.match(reusable, /REVIEW_YETI_DOKS_PUBLISH_MODE:\s*\$\{\{ inputs\.central_execution && 'app-gate' \|\| vars\.REVIEW_YETI_DOKS_PUBLISH_MODE \|\| 'disabled' \}\}/u);
  assert.match(reusable, /expected_generation:\s*[\s\S]*?default:\s*1[\s\S]*?type:\s*number/u);
  assert.match(reusable, /expected-generation:\s*\$\{\{ inputs\.expected_generation \}\}/u);
  assert.match(reusable, /recovery_kind:\s*[\s\S]*?default:\s*''[\s\S]*?type:\s*string/u);
  assert.match(reusable, /REQUEST_RECOVERY_KIND: \$\{\{ inputs\.recovery_kind \}\}/u);
  assert.match(reusable, /VALIDATED_RECOVERY_KIND: \$\{\{ steps\.central_validation\.outputs\.recovery_kind \}\}/u);
  const centralValidationStep = workflowStepBlock(reusable, 'Validate central dispatch boundary');
  assert.match(centralValidationStep, /^\s+id: central_validation$/mu);
  assert.match(centralValidationStep, /^\s+run: node \.exampleorg-review-actions\/scripts\/validate-central-dispatch\.mjs$/mu);
  const recoveryClassificationStep = workflowStepBlock(reusable, 'Verify central recovery classification');
  assert.match(recoveryClassificationStep, /if: \$\{\{ inputs\.central_execution \}\}/u);
  assert.match(recoveryClassificationStep, /REQUEST_RECOVERY_KIND/u);
  assert.match(recoveryClassificationStep, /VALIDATED_RECOVERY_KIND/u);
  assert.match(reusable, /incomplete-p2-recovery: \$\{\{ inputs\.central_execution && inputs\.recovery_kind == 'incomplete_p2' \}\}/u);
  assert.match(reusable, /group:\s*exampleorg-review-yeti-[^\n]*inputs\.head_sha/u);
  assert.doesNotMatch(reusable, /secrets\.CROSS_REPO_TOKEN/u);
  assert.doesNotMatch(reusable, /workflow_call:[\s\S]{0,1200}OLLAMA_PR_REVIEW_API_KEY/u);
  assert.match(receiver, /refresh_requested:/u);
  assert.match(reusable, /refresh_requested:/u);
  assert.match(reusable, /refresh_execution_attempt:\s*[\s\S]*?default:\s*0[\s\S]*?type:\s*number/u);
  assert.match(reusable, /refresh-requested:\s*\$\{\{ inputs\.refresh_requested \}\}/u);
  assert.match(reusable, /refresh-execution-attempt:\s*\$\{\{ inputs\.refresh_requested && inputs\.refresh_execution_attempt \|\| '' \}\}/u);
  assert.equal((reusable.match(/^\s+max-file-diff-chars:/gmu) || []).length, 1);
});

test('the central recovery-classification step accepts only the validator result', () => {
  const classificationScript = workflowStepRun(reusableWorkflow, 'Verify central recovery classification');
  const execute = (requestKind, validatedKind) => spawnSync('bash', ['-c', classificationScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REQUEST_RECOVERY_KIND: requestKind,
      VALIDATED_RECOVERY_KIND: validatedKind,
    },
  });

  for (const [requestKind, validatedKind] of [
    ['', ''],
    ['incomplete_p2', 'incomplete_p2'],
  ]) {
    const result = execute(requestKind, validatedKind);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }

  for (const [requestKind, validatedKind] of [
    ['', 'incomplete_p2'],
    ['incomplete_p2', ''],
    ['unexpected', 'incomplete_p2'],
  ]) {
    const result = execute(requestKind, validatedKind);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /central recovery classification changed between admission and execution/u);
  }

  const missingRequestKind = spawnSync('bash', ['-c', classificationScript], {
    encoding: 'utf8',
    env: { ...process.env, VALIDATED_RECOVERY_KIND: 'incomplete_p2' },
  });
  assert.equal(missingRequestKind.status, 1);
  assert.match(missingRequestKind.stderr, /REQUEST_RECOVERY_KIND/u);
});

test('receiver scopes internal and public target Apps independently', () => {
  assert.deepEqual(resolveValidationTokenScope('exampleorg/example-api'), {
    owner: 'exampleorg',
    name: 'example-api',
    repositories: 'example-api',
    scope: 'exampleorg',
    caller_workflow_path: '.github/workflows/ct-review-bot.yml',
  });
  assert.deepEqual(resolveValidationTokenScope(CENTRAL_REPOSITORY), {
    owner: 'exampleorg',
    name: 'example-review-actions',
    repositories: 'example-review-actions',
    scope: 'exampleorg',
    caller_workflow_path: '.github/workflows/ct-review-bot.yml',
  });
  assert.deepEqual(resolveValidationTokenScope('review-yeti-ai/review-yeti-bot'), {
    owner: 'review-yeti-ai',
    name: 'review-yeti-bot',
    repositories: 'review-yeti-bot',
    scope: 'review-yeti-public',
    caller_workflow_path: '.github/workflows/ct-review-bot.yml',
  });

  const crossOrg = spawnSync('bash', ['-c', workflowStepRun(receiverWorkflow, 'Resolve target repository scope')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: '/dev/null',
      TARGET_REPOSITORY: 'review-yeti-ai/review-yeti-bot',
    },
  });
  assert.equal(crossOrg.status, 0, crossOrg.stderr);

  const validationTokenStep = receiverWorkflow.match(
    /- name: Mint Review Yeti App token for exact public target validation[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for central validation)/u,
  )?.[0] ?? '';
  assert.match(validationTokenStep, /app-id:\s*\$\{\{ secrets\.REVIEW_YETI_PUBLIC_TARGET_APP_ID \}\}/u);
  assert.match(validationTokenStep, /private-key:\s*\$\{\{ secrets\.REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY \}\}/u);
  assert.match(validationTokenStep, /owner:\s*review-yeti-ai/u);
  assert.match(validationTokenStep, /repositories:\s*review-yeti-bot/u);
});

test('reusable and receiver admission scopes stay in lockstep', () => {
  for (const targetRepository of [
    'exampleorg/example-api',
    CENTRAL_REPOSITORY,
    'review-yeti-ai/review-yeti-bot',
  ]) {
    assert.deepEqual(
      resolveWorkflowTargetScope(reusableWorkflow, targetRepository),
      resolveValidationTokenScope(targetRepository),
      `admission scope drift for ${targetRepository}`,
    );
  }
});

test('App setup documentation preserves route-specific least privilege', () => {
  const docs = readFileSync(new URL('../docs/github-app-setup.md', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('../tools/create-review-dispatch-app.sh', import.meta.url), 'utf8');
  const targetToken = workflowStepBlock(reusableWorkflow, 'Mint Review Yeti App token for exampleorg target');
  const centralToken = workflowStepBlock(reusableWorkflow, 'Mint Review Yeti App token for central tooling');
  assert.match(docs, /## Route-specific permissions/u);
  assert.match(docs, /review-yeti-ingress/u);
  assert.match(docs, /REVIEW_YETI_DISPATCH_APP_ID/u);
  assert.match(docs, /CT_REVIEW_BOT_APP_ID/u);
  assert.match(docs, /REVIEW_YETI_PUBLIC_TARGET_APP_ID/u);
  assert.match(docs, /short-lived token request/u);
  assert.match(docs, /App registration grants the\s+union/u);
  assert.match(docs, /`permission-\*` inputs/u);
  assert.match(docs, /## Installing the route-specific Apps/u);
  assert.match(docs, /Install the \*\*Public ingress App\*\* only on\s+`exampleorg\/example-review-actions`/u);
  assert.match(docs, /Install the \*\*Public target App\*\* only on\s+`review-yeti-ai\/review-yeti-bot`/u);
  assert.doesNotMatch(docs, /Add all \*\*Consumer Repositories\*\*/u);
  assert.doesNotMatch(docs, /## Installing the App on Repositories/u);
  assert.match(docs, /Internal exampleorg App registration:[\s\S]*?`Actions` \*\*Read-only\*\*[\s\S]*?`Checks`, `Contents`,\s+`Issues`, and `Pull requests` \*\*Read and write\*\*/u);
  assert.match(docs, /Central tooling token \(not an App registration\):[\s\S]*`Actions` and `Contents` \*\*Read-only\*\*/u);
  assert.match(helper, /actions: "read"/u);
  assert.match(targetToken, /permission-actions: read/u);
  for (const permission of ['checks', 'contents', 'issues', 'pull_requests']) {
    assert.match(helper, new RegExp(`${permission}: "write"`, 'u'), `helper is missing ${permission}:write App grant`);
    assert.match(targetToken, new RegExp(`permission-${permission.replace('_', '-')}: write`, 'u'), `runtime target token is missing ${permission}:write`);
  }
  assert.doesNotMatch(helper, /repository_dispatch:/u);
  assert.match(centralToken, /permission-actions: read/u);
  assert.match(centralToken, /permission-contents: read/u);
  assert.doesNotMatch(centralToken, /permission-(?:actions|contents): write/u);
  assert.doesNotMatch(docs, /(?:secrets\.|gh secret set )REVIEW_BOT_APP_ID/u);
  assert.doesNotMatch(docs, /"actions":\s*"write"[\s\S]{0,160}"checks":\s*"write"[\s\S]{0,160}"contents":\s*"write"/u);
});


test('reads the caller from the default branch even when the PR base branch still carries the legacy shim', async () => {
  const legacyShim = `
name: Review Yeti
on:
  pull_request_target:
    branches: [0.8.8-stable]
jobs:
  review:
    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1
    secrets: inherit
`;
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=0.8.8-stable')) {
      calls.push({ url, init });
      return response({ encoding: 'base64', content: Buffer.from(legacyShim).toString('base64') });
    }
    return successFetch(calls)(url, init);
  };
  const result = await validateCentralDispatch({ payload, token: 'central-token', fetchImpl });
  assert.match(result.caller_workflow_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(calls.some((call) => call.url.includes('?ref=0.8.8-stable')), false);
  assert.equal(calls.some((call) => call.url.includes('?ref=0.8.7-stable')), true);
  // Sanity: had the validator read base.ref, the legacy shim would have been rejected.
  assert.throws(() => validateCallerWorkflow(legacyShim), /missing central marker/u);
});

// ADR 0519: admission is by owner plus a valid base-owned caller, not a fixed
// repository list, and the shared lane is bounded by a per-repository cap.
test('admits any exampleorg repository while rejecting every unlisted external target', () => {
  for (const name of ['example-api', 'example-release', 'example-meta', 'example-workspace', 'example-ui']) {
    assert.equal(assertAdmittedRepository(`exampleorg/${name}`), name);
  }
  for (const bad of [
    'evil/example-workspace',            // wrong owner
    'exampleorg/a/b',            // extra path segment
    'exampleorg/../example-review-actions', // traversal
    'exampleorg/',               // empty name
    'exampleorg/.hidden',        // leading dot
    'example-workspace',                 // unqualified
  ]) {
    assert.throws(() => assertAdmittedRepository(bad), /must be a exampleorg\/<repo> repository/u);
  }
});

test('request_id repo-name is generic but still bound to the payload repository', () => {
  const ok = {
    ...payload,
    repository: 'exampleorg/example-workspace',
    request_id: `example-workspace:4527:${headSha}:${callerRunId}:${callerRunAttempt}`,
  };
  assert.equal(validateDispatchPayload(ok).repository, 'exampleorg/example-workspace');
  // A generic pattern must not let the prefix drift from the repository.
  assert.throws(
    () => validateDispatchPayload({ ...ok, request_id: `example-api:4527:${headSha}:${callerRunId}:${callerRunAttempt}` }),
    /request_id repo-name must match the payload repository/u,
  );
});

test('per-repository capacity cap bounds the shared lane without blocking normal traffic', async () => {
  const listing = (count, name = 'example-workspace') => async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: Array.from({ length: count }, (_, index) => ({
        id: 5000 + index,
        display_title: `Review Yeti central / ${name}:1:${headSha}:1:1`,
      })),
    }),
  });
  const cap = DEFAULT_REPOSITORY_CONCURRENCY_CAP;
  assert.equal(cap, 6);
  assert.equal(repositoryConcurrencyCap({}), cap);
  assert.equal(repositoryConcurrencyCap({ CT_REVIEW_REPOSITORY_CONCURRENCY_CAP: '2' }), 2);
  assert.throws(() => repositoryConcurrencyCap({ CT_REVIEW_REPOSITORY_CONCURRENCY_CAP: '0' }), /positive integer/u);

  const under = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl: listing(cap - 1), cap, selfRunId: '0',
  });
  assert.equal(under.inFlight, cap - 1);

  await assert.rejects(
    assertRepositoryCapacity({ repositoryName: 'example-workspace', token: 't', fetchImpl: listing(cap), cap, selfRunId: '0' }),
    /already has 6 central reviews in flight \(cap 6\)/u,
  );

  // Another repository's runs never consume this repository's budget.
  const isolated = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl: listing(cap, 'example-api'), cap: 1, selfRunId: '0',
  });
  assert.equal(isolated.inFlight, 0);

  // The dispatching run must not count against its own cap.
  const selfExcluded = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl: listing(cap), cap, selfRunId: '5000',
  });
  assert.equal(selfExcluded.inFlight, cap - 1);

  // A listing outage cannot prove either cap, so admission fails closed after
  // the bounded retry rather than inventing an unbacked allowance.
  await assert.rejects(
    assertRepositoryCapacity({
      repositoryName: 'example-workspace', token: 't', fetchImpl: async () => ({ ok: false, status: 500 }), cap: 1, selfRunId: '0',
    }),
    /capacity listing unavailable after bounded retries/u,
  );
});

// A per-repository cap alone does not bound the shared provider: owner-based
// admission means N repositories could each sit at the per-repository cap.
test('global cap bounds the shared lane across repositories', async () => {
  const mixed = (perRepo) => async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: Object.entries(perRepo).flatMap(([name, count]) =>
        Array.from({ length: count }, (_, index) => ({
          id: `${name}-${index}`,
          display_title: `Review Yeti central / ${name}:1:${headSha}:1:1`,
        }))),
    }),
  });

  assert.equal(DEFAULT_GLOBAL_CONCURRENCY_CAP, 8);
  assert.equal(globalConcurrencyCap({}), DEFAULT_GLOBAL_CONCURRENCY_CAP);
  assert.equal(globalConcurrencyCap({ CT_REVIEW_GLOBAL_CONCURRENCY_CAP: '3' }), 3);
  assert.throws(() => globalConcurrencyCap({ CT_REVIEW_GLOBAL_CONCURRENCY_CAP: '-1' }), /positive integer/u);

  // Three repositories, each below the per-repository cap of 6, together exceed
  // the global cap. Without a global bound this admits and oversubscribes the
  // provider — the hole this test exists to prevent.
  await assert.rejects(
    assertRepositoryCapacity({
      repositoryName: 'example-workspace',
      token: 't',
      fetchImpl: mixed({ 'example-api': 4, 'example-meta': 4, 'example-workspace': 1 }),
      cap: 6,
      globalCap: 8,
      selfRunId: '0',
    }),
    /global cap 8/u,
  );

  // Global pressure is reported even when this repository is idle.
  const headroom = await assertRepositoryCapacity({
    repositoryName: 'example-workspace',
    token: 't',
    fetchImpl: mixed({ 'example-api': 3, 'example-meta': 2 }),
    cap: 6,
    globalCap: 8,
    selfRunId: '0',
  });
  assert.equal(headroom.globalInFlight, 5);
  assert.equal(headroom.inFlight, 0);

  // The global cap is checked first: at global saturation the caller learns the
  // lane is full, not that its own repository is fine.
  await assert.rejects(
    assertRepositoryCapacity({
      repositoryName: 'example-workspace', token: 't', fetchImpl: mixed({ 'example-api': 8 }), cap: 6, globalCap: 8, selfRunId: '0',
    }),
    /central review lane already has 8/u,
  );
});

test('a transient listing failure is retried before degrading', async () => {
  // Each attempt lists both statuses, so a round is two calls. The first round
  // fails, the second succeeds.
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls <= CAPACITY_RUN_STATUSES.length) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ workflow_runs: [] }) };
  };
  const result = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl: flaky, cap: 6, globalCap: 8, selfRunId: '0',
  });
  assert.equal(result.globalInFlight, 0);
  assert.ok(calls > CAPACITY_RUN_STATUSES.length, 'expected a second listing round');
});

test('fails closed through central validation when capacity remains unavailable', async () => {
  const calls = [];
  const baseFetch = successFetch(calls);
  const unavailableFetch = async (url, init) => {
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) return response({}, 503);
    return baseFetch(url, init);
  };
  await assert.rejects(
    validateCentralDispatch({ payload, token: 'central-token', fetchImpl: unavailableFetch }),
    /capacity listing unavailable after bounded retries/u,
  );
});

// A dispatched run that has not started a job is `queued`. Counting only
// in-progress runs undercounts during exactly the burst the cap exists for.
test('capacity counts queued runs, not only in-progress', async () => {
  assert.deepEqual([...CAPACITY_RUN_STATUSES], ['queued', 'in_progress']);

  const seen = [];
  const byStatus = (queued, inProgress) => async (url) => {
    seen.push(url);
    const status = new URL(url).searchParams.get('status');
    const count = status === 'queued' ? queued : inProgress;
    const offset = status === 'queued' ? 0 : 1000;
    return {
      ok: true,
      json: async () => ({
        workflow_runs: Array.from({ length: count }, (_, index) => ({
          id: offset + index,
          display_title: `Review Yeti central / example-workspace:1:${headSha}:1:1`,
        })),
      }),
    };
  };

  // Both states are listed.
  const counted = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl: byStatus(2, 3), cap: 6, globalCap: 8, selfRunId: '-1',
  });
  assert.equal(counted.globalInFlight, 5);
  assert.equal(seen.filter((u) => u.includes('status=queued')).length, 1);
  assert.equal(seen.filter((u) => u.includes('status=in_progress')).length, 1);

  // Queued alone can saturate the per-repository cap. Under the old
  // in-progress-only listing this admitted.
  await assert.rejects(
    assertRepositoryCapacity({
      repositoryName: 'example-workspace', token: 't', fetchImpl: byStatus(6, 0), cap: 6, globalCap: 8, selfRunId: '-1',
    }),
    /repository example-workspace already has 6/u,
  );

  // A run appearing in both listings (state changed mid-check) counts once.
  const dupe = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [{ id: 77, display_title: `Review Yeti central / example-workspace:1:${headSha}:1:1` }],
    }),
  });
  const deduped = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl: dupe, cap: 6, globalCap: 8, selfRunId: '-1',
  });
  assert.equal(deduped.globalInFlight, 1);
});

test('paginates capacity listings beyond the first 100 workflow runs', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    seen.push(parsed);
    const status = parsed.searchParams.get('status');
    const pageNumber = Number(parsed.searchParams.get('page'));
    if (status === 'in_progress') return response({ total_count: 0, workflow_runs: [] });
    if (pageNumber === 1) {
      return response({ total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, index) => ({
        id: 8_000 + index,
        display_title: `Review Yeti central / example-workspace:1:${headSha}:1:1`,
      })) });
    }
    return response({ total_count: 101, workflow_runs: [{
      id: 8_100,
      display_title: `Review Yeti central / example-workspace:1:${headSha}:1:1`,
    }] });
  };
  const result = await assertRepositoryCapacity({
    repositoryName: 'example-workspace', token: 't', fetchImpl, cap: 200, globalCap: 200, selfRunId: '-1',
  });
  assert.equal(result.inFlight, 101);
  assert.equal(result.globalInFlight, 101);
  assert.deepEqual(
    seen.filter((url) => url.searchParams.get('status') === 'queued').map((url) => url.searchParams.get('page')),
    ['1', '2'],
  );
});
