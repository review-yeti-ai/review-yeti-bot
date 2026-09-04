import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CENTRAL_REPOSITORY,
  DISPATCH_EVENT_TYPE,
  TARGET_REPOSITORY,
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

// ADR 0490 scope widened 2026-09-02 (example-review-actions #200): every admitted
// repository must pass the full dispatch contract end-to-end, not just the
// example-api namespace — the repo-name group shifted the REQUEST_ID_PATTERN
// capture indices, and an off-by-one would silently bind the wrong PR/SHA.
const WIDED_REPOSITORIES = [
  { repository: TARGET_REPOSITORY, name: 'example-api', pr: 4527 },
  { repository: 'exampleorg/example-release', name: 'example-release', pr: 771 },
  { repository: 'exampleorg/example-meta', name: 'example-meta', pr: 2704 },
];

function buildFixture({ repository, name, pr }) {
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
        path: '.github/workflows/ct-review-bot.yml',
        head_sha: headSha,
        head_branch: `fix/${name}-shim`,
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: pr }],
      });
    }
    if (url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=')) {
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
      - run: gh api repos/exampleorg/example-review-actions/actions/workflows/repository-dispatch.yml/runs
`;

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
    if (url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=')) {
      return response({ encoding: 'base64', content: Buffer.from(callerWorkflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('accepts only the sanitized Cisco dispatch identity contract', () => {
  assert.deepEqual(validateDispatchPayload(payload), payload);
  for (const invalid of [
    { ...payload, repository: 'exampleorg/another-repo' },
    { ...payload, pr_number: '4527' },
    { ...payload, base_sha: baseSha.toUpperCase() },
    { ...payload, head_sha: 'b'.repeat(39) },
    { ...payload, request_id: '../escape' },
    { ...payload, request_id: `example-api:4528:${headSha}:${callerRunId}:${callerRunAttempt}` },
    { ...payload, provider: 'ollama' },
    { ...payload, ollama_api_key: 'secret' },
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
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.authorization, 'Bearer central-token');
  assert.equal(calls[1].url.endsWith(`/actions/runs/${callerRunId}`), true);
  // The fixture PR targets 0.8.8-stable while the default branch is 0.8.7-stable: the caller
  // bytes must be read from the default branch (what GitHub executes), never from base.ref.
  assert.equal(calls[2].url.endsWith('?ref=0.8.7-stable'), true);
  assert.equal(calls[2].url.includes('0.8.8-stable'), false);
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
  const receiver = readFileSync(new URL('../.github/workflows/repository-dispatch.yml', import.meta.url), 'utf8');
  const reusable = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');

  assert.match(receiver, /types:\s*\[review-yeti-request\]/u);
  assert.match(receiver, /run-name:\s*Review Yeti central \/ \$\{\{ github\.event\.client_payload\.request_id \}\}/u);
  assert.match(receiver, /uses: exampleorg\/example-review-actions\/\.github\/workflows\/review-yeti\.yml@v1/u);
  assert.match(receiver, /secrets: inherit/u);
  // REL-540 / ADR 0511: the receiver's validate job runs as the ct-review-bot App, never the PAT.
  assert.match(receiver, /create-github-app-token@[0-9a-f]{40}/u);
  assert.match(receiver, /app-id: \$\{\{ secrets\.CT_REVIEW_BOT_APP_ID \}\}/u);
  assert.doesNotMatch(receiver, /secrets\.CROSS_REPO_TOKEN/u);
  assert.doesNotMatch(receiver, /OLLAMA_PR_REVIEW_API_KEY/u);
  assert.match(reusable, /OLLAMA_PR_REVIEW_API_KEY:\s*\$\{\{ secrets\.OLLAMA_PR_REVIEW_API_KEY \}\}/u);
  // REL-519: GitHub-surface auth moved to the ct-review-bot App installation
  // token (own rate bucket); github.token remains the non-central fallback.
  assert.match(reusable, /GH_TOKEN:\s*\$\{\{ steps\.ry_token\.outputs\.token \|\| github\.token \}\}/u);
  assert.doesNotMatch(reusable, /secrets\.CROSS_REPO_TOKEN/u);
  assert.doesNotMatch(reusable, /workflow_call:[\s\S]{0,1200}OLLAMA_PR_REVIEW_API_KEY/u);
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
