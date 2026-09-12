import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CENTRAL_REPOSITORY,
  DISPATCH_EVENT_TYPE,
  REVIEW_YETI_CALLER_WORKFLOW_PATH,
  REVIEW_YETI_REPOSITORY,
  assertAdmittedRepository,
  resolveAdmittedTarget,
  validateCentralDispatch,
  validateDispatchPayload,
} from './validate-central-dispatch.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const callerRunId = 42424242;
const callerRunAttempt = 1;
const externalPayload = Object.freeze({
  request_id: `review-yeti-bot:314:${headSha}:${callerRunId}:${callerRunAttempt}`,
  repository: REVIEW_YETI_REPOSITORY,
  pr_number: 314,
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
`;

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function externalFetch(calls, {
  targetOwner = 'review-yeti-ai',
  targetRepositories = [REVIEW_YETI_REPOSITORY],
  centralOwner = 'exampleorg',
  centralRepositories = [CENTRAL_REPOSITORY],
} = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const authorization = init?.headers?.authorization;
    if (url === 'https://api.github.com/installation') {
      if (authorization === 'Bearer target-installation-token') {
        return response({ account: { login: targetOwner } });
      }
      if (authorization === 'Bearer central-installation-token') {
        return response({ account: { login: centralOwner } });
      }
      return response({}, 403);
    }
    if (url === 'https://api.github.com/installation/repositories?per_page=100') {
      const repositories = authorization === 'Bearer target-installation-token'
        ? targetRepositories
        : authorization === 'Bearer central-installation-token' ? centralRepositories : null;
      if (repositories === null) return response({}, 403);
      return response({
        total_count: repositories.length,
        repositories: repositories.map((full_name) => ({ full_name })),
      });
    }
    const expectedToken = url.includes(`/repos/${CENTRAL_REPOSITORY}/actions/workflows/`)
      ? 'central-installation-token'
      : 'target-installation-token';
    if (authorization !== `Bearer ${expectedToken}`) return response({}, 403);
    if (url.endsWith('/pulls/314')) {
      return response({
        state: 'open',
        base: { sha: baseSha, ref: 'main', repo: { full_name: REVIEW_YETI_REPOSITORY, default_branch: 'main' } },
        head: { sha: headSha, ref: 'fix/cross-org-caller' },
      });
    }
    if (url.endsWith(`/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: REVIEW_YETI_REPOSITORY },
        event: 'pull_request_target',
        path: REVIEW_YETI_CALLER_WORKFLOW_PATH,
        head_sha: headSha,
        head_branch: 'fix/cross-org-caller',
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: 314 }],
      });
    }
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) {
      return response({ total_count: 0, workflow_runs: [] });
    }
    if (url.includes(`/commits/${headSha}/check-runs?`)) {
      return response({ total_count: 0, check_runs: [] });
    }
    if (url.includes(`/contents/${REVIEW_YETI_CALLER_WORKFLOW_PATH}?ref=main`)) {
      return response({ encoding: 'base64', content: Buffer.from(callerWorkflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('admits exactly the Review Yeti repository and caller path outside exampleorg', () => {
  assert.equal(REVIEW_YETI_CALLER_WORKFLOW_PATH, '.github/workflows/ct-review-bot.yml');
  assert.deepEqual(resolveAdmittedTarget(REVIEW_YETI_REPOSITORY), {
    owner: 'review-yeti-ai',
    name: 'review-yeti-bot',
    repository: REVIEW_YETI_REPOSITORY,
    callerWorkflowPath: REVIEW_YETI_CALLER_WORKFLOW_PATH,
  });
  assert.equal(validateDispatchPayload(externalPayload).repository, REVIEW_YETI_REPOSITORY);
  assert.throws(
    () => assertAdmittedRepository(REVIEW_YETI_REPOSITORY),
    /must be a exampleorg\/<repo> repository/u,
  );

  for (const repository of [
    'review-yeti-ai/another-repository',
    'another-owner/review-yeti-bot',
    'review-yeti-ai/review-yeti-bot/extra',
    'review-yeti-ai/*',
  ]) {
    assert.throws(() => resolveAdmittedTarget(repository), /not admitted/u);
  }
});

test('routes external target reads and central capacity reads through distinct owner installations', async () => {
  const calls = [];
  const result = await validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch(calls),
  });

  assert.equal(result.repository, REVIEW_YETI_REPOSITORY);
  assert.equal(result.caller_workflow_path, REVIEW_YETI_CALLER_WORKFLOW_PATH);
  assert.equal(calls.length, 10);
  for (const call of calls) {
    if (call.url.startsWith('https://api.github.com/installation')) continue;
    const expectedToken = call.url.includes(`/repos/${CENTRAL_REPOSITORY}/actions/workflows/`)
      ? 'Bearer central-installation-token'
      : 'Bearer target-installation-token';
    assert.equal(call.init.headers.authorization, expectedToken);
  }
});

test('fails closed on wrong external caller path and token-scope mistakes', async () => {
  const wrongPathFetch = async (url, init) => {
    if (url.endsWith(`/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: REVIEW_YETI_REPOSITORY },
        event: 'pull_request_target',
        path: '.github/workflows/review-bot.yaml',
        head_sha: headSha,
        head_branch: 'fix/cross-org-caller',
        run_attempt: callerRunAttempt,
        pull_requests: [{ number: 314 }],
      });
    }
    return externalFetch([])(url, init);
  };
  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: wrongPathFetch,
  }), /caller run workflow path changed/u);

  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'central-installation-token',
    centralToken: 'target-installation-token',
    fetchImpl: externalFetch([]),
  }), /installation owner/u);
  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch([], { targetRepositories: ['review-yeti-ai/another-repository'] }),
  }), /repository scope/u);
  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'one-token-for-two-owners',
    centralToken: 'one-token-for-two-owners',
    fetchImpl: externalFetch([]),
  }), /distinct installation tokens/u);
  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: '',
    fetchImpl: externalFetch([]),
  }), /central App token/u);
});

test('trusted workflows mint owner-aware target and central tokens without ambient fallback', () => {
  const receiver = readFileSync(new URL('../.github/workflows/repository-dispatch.yml', import.meta.url), 'utf8');
  const reusable = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');

  for (const workflow of [receiver, reusable]) {
    assert.match(workflow, /^\s+review-yeti-ai\/review-yeti-bot\)$/mu);
    assert.match(workflow, /caller_workflow_path=\.github\/workflows\/ct-review-bot\.yml/u);
    assert.doesNotMatch(workflow, /^\s+review-yeti-ai\/\*\)$/mu);
    assert.match(workflow, /owner:\s*\$\{\{ steps\.target\.outputs\.owner \}\}/u);
    assert.match(workflow, /repositories:\s*\$\{\{ steps\.target\.outputs\.repositories \}\}/u);
    assert.match(workflow, /owner:\s*exampleorg/u);
    assert.match(workflow, /repositories:\s*example-review-actions/u);
    assert.match(workflow, /GH_TARGET_TOKEN:\s*\$\{\{ steps\.ry_token\.outputs\.token \}\}/u);
    assert.match(workflow, /GH_CENTRAL_TOKEN:\s*\$\{\{ steps\.central_token\.outputs\.token \|\| steps\.ry_token\.outputs\.token \}\}/u);
    assert.doesNotMatch(workflow, /steps\.ry_token\.outputs\.token \|\| github\.token/u);
    assert.doesNotMatch(workflow, /secrets\.CROSS_REPO_TOKEN/u);
    assert.equal((workflow.match(/secrets\.CT_REVIEW_BOT_APP_PRIVATE_KEY/gu) || []).length, 2);
  }

  assert.match(receiver, /TARGET_REPOSITORY:\s*\$\{\{ github\.event\.client_payload\.repository \|\| inputs\.repository \}\}/u);
  assert.match(reusable, /TARGET_REPOSITORY:\s*\$\{\{ inputs\.central_execution && inputs\.repository \|\| github\.repository \}\}/u);
  assert.equal((receiver.match(/private-key:\s*\$\{\{ secrets\.CT_REVIEW_BOT_APP_PRIVATE_KEY \}\}/gu) || []).length, 2);
  assert.equal((reusable.match(/private-key:\s*\$\{\{ secrets\.CT_REVIEW_BOT_APP_PRIVATE_KEY \}\}/gu) || []).length, 2);

  const reusableTargetToken = reusable.match(
    /- name: Mint Review Yeti App token\n[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for central tooling)/u,
  )?.[0] ?? '';
  const reusableTargetPermissions = [...reusableTargetToken.matchAll(/^\s+permission-([a-z-]+):\s*(\w+)\s*$/gmu)]
    .map((match) => `${match[1]}:${match[2]}`).sort();
  assert.deepEqual(reusableTargetPermissions, [
    'actions:read',
    'checks:write',
    'contents:write',
    'issues:write',
    'pull-requests:write',
  ]);
});
