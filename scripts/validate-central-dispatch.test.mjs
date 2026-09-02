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
const advancedBaseSha = 'd'.repeat(40);
const callerRunId = 33572874647;
const callerRunAttempt = 2;
const payload = Object.freeze({
  request_id: `example-api:4527:${headSha}:${callerRunId}:${callerRunAttempt}`,
  repository: TARGET_REPOSITORY,
  pr_number: 4527,
  base_sha: baseSha,
  head_sha: headSha,
});
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
        base: { sha: baseSha, ref: '0.8.7-stable', repo: { full_name: TARGET_REPOSITORY } },
        head: { sha: headSha },
      });
    }
    if (url.endsWith(`/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: TARGET_REPOSITORY },
        event: 'pull_request_target',
        path: '.github/workflows/ct-review-bot.yml',
        head_sha: baseSha,
        head_branch: 'feat/API-0000-pr-source-branch',
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: 4527 }],
      });
    }
    if (url.includes('/compare/')) {
      return response({ status: url.endsWith(`...${advancedBaseSha}`) ? 'behind' : 'diverged' });
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

test('requires the central repository_dispatch execution context', () => {
  assert.doesNotThrow(() => validateExecutionContext({
    repository: CENTRAL_REPOSITORY,
    eventName: 'repository_dispatch',
    eventAction: DISPATCH_EVENT_TYPE,
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
  assert.equal(calls[2].url.endsWith(`?ref=${baseSha}`), true);
  assert.equal(calls.some((call) => call.url.includes('central-token')), false);
});

test('fails closed on missing central credentials, stale identity, or a GitHub lookup failure', async () => {
  await assert.rejects(
    validateCentralDispatch({ payload, token: '', fetchImpl: successFetch([]) }),
    /CROSS_REPO_TOKEN is required/,
  );
  await assert.rejects(
    validateCentralDispatch({
      payload,
      token: 'central-token',
      fetchImpl: async () => response({
        state: 'open',
        base: { sha: baseSha, ref: '0.8.7-stable', repo: { full_name: TARGET_REPOSITORY } },
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
        head_sha: baseSha,
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
  assert.doesNotMatch(receiver, /OLLAMA_PR_REVIEW_API_KEY/u);
  assert.match(reusable, /OLLAMA_PR_REVIEW_API_KEY:\s*\$\{\{ secrets\.OLLAMA_PR_REVIEW_API_KEY \}\}/u);
  assert.match(reusable, /GH_TOKEN:\s*\$\{\{ inputs\.central_execution && secrets\.CROSS_REPO_TOKEN \|\| github\.token \}\}/u);
  assert.doesNotMatch(reusable, /workflow_call:[\s\S]{0,1200}OLLAMA_PR_REVIEW_API_KEY/u);
});

test('accepts a caller run from a newer base tip that still contains the PR base and reads the workflow there', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (!url.endsWith(`/actions/runs/${callerRunId}`)) return successFetch(calls)(url, init);
    calls.push({ url, init });
    return response({
      repository: { full_name: TARGET_REPOSITORY },
      event: 'pull_request_target',
      path: '.github/workflows/ct-review-bot.yml',
      head_sha: advancedBaseSha,
      head_branch: '0.8.7-stable',
      run_attempt: callerRunAttempt,
      pull_requests: [{ number: 4527 }],
    });
  };
  const result = await validateCentralDispatch({ payload, token: 'central-token', fetchImpl });
  assert.equal(result.base_sha, baseSha);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].url.includes(`/compare/0.8.7-stable...${advancedBaseSha}`), true);
  assert.equal(calls[3].url.endsWith(`?ref=${advancedBaseSha}`), true);
});
