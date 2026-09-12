import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  CENTRAL_REPOSITORY,
  DEFAULT_GLOBAL_CONCURRENCY_CAP,
  DEFAULT_REPOSITORY_CONCURRENCY_CAP,
  CAPACITY_RUN_STATUSES,
  DISPATCH_EVENT_TYPE,
  REVIEW_YETI_REPOSITORY,
  TARGET_REPOSITORY,
  assertAdmittedRepository,
  assertRepositoryCapacity,
  globalConcurrencyCap,
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

function workflowStepRun(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const blockStart = start + marker.length;
  const next = source.indexOf('\n      - name: ', blockStart);
  const block = source.slice(blockStart, next === -1 ? source.length : next + 1);
  const run = block.match(/^        run: \|\n([\s\S]*)$/mu);
  assert.ok(run, `missing run body for ${name}`);
  return run[1].split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

function resolveValidationTokenScope(targetRepository) {
  const directory = mkdtempSync(`${tmpdir()}/review-yeti-token-scope-`);
  const outputPath = `${directory}/github-output`;
  try {
    const result = spawnSync('bash', ['-c', workflowStepRun(receiverWorkflow, 'Resolve target repository scope')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath, TARGET_REPOSITORY: targetRepository },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => line.split('=', 2)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    { ...payload, refresh_requested: 'true' },
  ]) {
    assert.throws(() => validateDispatchPayload(invalid));
  }
});

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
  assert.match(receiver, /run-name:\s*Review Yeti central \/ \$\{\{ github\.event\.client_payload\.request_id \}\}/u);
  assert.match(receiver, /group:\s*central-review-yeti-\$\{\{ github\.event\.client_payload\.repository \|\| inputs\.repository \}\}-\$\{\{ github\.event\.client_payload\.pr_number \|\| inputs\.pr_number \}\}-\$\{\{ github\.event\.client_payload\.head_sha \|\| inputs\.head_sha \}\}/u);
  assert.match(receiver, /cancel-in-progress:\s*false/u);
  assert.match(receiver, /uses: exampleorg\/example-review-actions\/\.github\/workflows\/review-yeti\.yml@v1/u);
  assert.match(receiver, /review_generation:\s*\$\{\{ steps\.request\.outputs\.review_generation \}\}/u);
  assert.match(receiver, /expected_generation:\s*\$\{\{ fromJSON\(needs\.validate\.outputs\.review_generation\) \}\}/u);
  assert.match(receiver, /execution_backend:\s*doks/u);
  assert.match(receiver, /secrets: inherit/u);
  // REL-540 / ADR 0511: the receiver's validate job runs as the ct-review-bot App, never the PAT.
  assert.match(receiver, /create-github-app-token@[0-9a-f]{40}/u);
  assert.match(receiver, /app-id: \$\{\{ secrets\.CT_REVIEW_BOT_APP_ID \}\}/u);
  const validationTokenStep = receiver.match(/- name: Mint Review Yeti App token for target validation[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for central validation)/u)?.[0] ?? '';
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
  assert.match(reusable, /GH_TOKEN:\s*\$\{\{ steps\.ry_token\.outputs\.token \}\}/u);
  assert.match(reusable, /GH_TARGET_TOKEN:\s*\$\{\{ steps\.ry_token\.outputs\.token \}\}/u);
  assert.match(reusable, /GH_CENTRAL_TOKEN:\s*\$\{\{ steps\.central_token\.outputs\.token \|\| steps\.ry_token\.outputs\.token \}\}/u);
  assert.doesNotMatch(reusable, /steps\.ry_token\.outputs\.token \|\| github\.token/u);
  assert.match(reusable, /REVIEW_YETI_DOKS_PUBLISH_MODE:\s*\$\{\{ inputs\.central_execution && 'app-gate' \|\| vars\.REVIEW_YETI_DOKS_PUBLISH_MODE \|\| 'disabled' \}\}/u);
  assert.match(reusable, /expected_generation:\s*[\s\S]*?default:\s*1[\s\S]*?type:\s*number/u);
  assert.match(reusable, /expected-generation:\s*\$\{\{ inputs\.expected_generation \}\}/u);
  assert.match(reusable, /group:\s*exampleorg-review-yeti-[^\n]*inputs\.head_sha/u);
  assert.doesNotMatch(reusable, /secrets\.CROSS_REPO_TOKEN/u);
  assert.doesNotMatch(reusable, /workflow_call:[\s\S]{0,1200}OLLAMA_PR_REVIEW_API_KEY/u);
  assert.match(receiver, /refresh_requested:/u);
  assert.match(reusable, /refresh_requested:/u);
  assert.doesNotMatch(reusable, /^\s+refresh_execution_attempt:/mu);
  assert.doesNotMatch(reusable, /^\s+refresh-requested:/mu);
  assert.doesNotMatch(reusable, /^\s+refresh-execution-attempt:/mu);
  assert.equal((reusable.match(/^\s+max-file-diff-chars:/gmu) || []).length, 1);
});

test('receiver scopes App tokens to one owner while preserving exampleorg coverage', () => {
  assert.deepEqual(resolveValidationTokenScope('exampleorg/example-api'), {
    owner: 'exampleorg',
    name: 'example-api',
    repositories: 'example-api,example-review-actions',
    caller_workflow_path: '.github/workflows/ct-review-bot.yml',
    needs_central_token: 'false',
  });
  assert.deepEqual(resolveValidationTokenScope(CENTRAL_REPOSITORY), {
    owner: 'exampleorg',
    name: 'example-review-actions',
    repositories: 'example-review-actions',
    caller_workflow_path: '.github/workflows/ct-review-bot.yml',
    needs_central_token: 'false',
  });
  assert.deepEqual(resolveValidationTokenScope(REVIEW_YETI_REPOSITORY), {
    owner: 'review-yeti-ai',
    name: 'review-yeti-bot',
    repositories: 'review-yeti-bot',
    caller_workflow_path: '.github/workflows/review-bot.yaml',
    needs_central_token: 'true',
  });

  const validationTokenStep = receiverWorkflow.match(
    /- name: Mint Review Yeti App token for target validation[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for central validation)/u,
  )?.[0] ?? '';
  assert.match(validationTokenStep, /owner:\s*\$\{\{ steps\.target\.outputs\.owner \}\}/u);
  assert.match(validationTokenStep, /repositories:\s*\$\{\{ steps\.target\.outputs\.repositories \}\}/u);
  const centralTokenStep = receiverWorkflow.match(
    /- name: Mint Review Yeti App token for central validation[\s\S]*?(?=\n\s+- name: Validate payload)/u,
  )?.[0] ?? '';
  assert.match(centralTokenStep, /owner:\s*exampleorg/u);
  assert.match(centralTokenStep, /repositories:\s*example-review-actions/u);
  assert.match(centralTokenStep, /if:\s*\$\{\{ steps\.target\.outputs\.needs_central_token == 'true' \}\}/u);
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
