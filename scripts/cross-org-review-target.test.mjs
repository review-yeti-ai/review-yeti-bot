import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CENTRAL_REPOSITORY,
  DISPATCH_EVENT_TYPE,
  REVIEW_YETI_CALLER_WORKFLOW_PATH,
  REVIEW_YETI_REPOSITORY,
  resolveAdmittedTarget,
  validateCentralDispatch,
  validateDispatchPayload,
  validatePublicCallerWorkflow,
} from './validate-central-dispatch.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const callerRunId = 42424242;
const externalPayload = Object.freeze({
  request_id: `review-yeti-bot:314:${headSha}:${callerRunId}:1`,
  repository: REVIEW_YETI_REPOSITORY,
  pr_number: 314,
  base_sha: baseSha,
  head_sha: headSha,
});

const callerWorkflow = `
name: Review Yeti
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
jobs:
  dispatch:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - name: Mint dispatch App token
        id: dispatch_token
        uses: actions/create-github-app-token@0123456789abcdef0123456789abcdef01234567
        with:
          app-id: \${{ secrets.REVIEW_YETI_DISPATCH_APP_ID }}
          private-key: \${{ secrets.REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY }}
          owner: exampleorg
          repositories: example-review-actions
          permission-contents: write
      - name: Dispatch Review Yeti request
        env:
          GH_TOKEN: \${{ steps.dispatch_token.outputs.token }}
        run: |
          set -euo pipefail
          jq -n \\
            --arg repository "\${{ github.repository }}" \\
            --argjson pr_number "\${{ github.event.pull_request.number }}" \\
            --arg base_sha "\${{ github.event.pull_request.base.sha }}" \\
            --arg head_sha "\${{ github.event.pull_request.head.sha }}" \\
            --arg request_id "\${{ github.event.repository.name }}:\${{ github.event.pull_request.number }}:\${{ github.event.pull_request.head.sha }}:\${{ github.run_id }}:\${{ github.run_attempt }}" \\
            '{event_type:"${DISPATCH_EVENT_TYPE}",client_payload:{repository:$repository,pr_number:$pr_number,base_sha:$base_sha,head_sha:$head_sha,request_id:$request_id}}' |
            gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -
`;

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function externalFetch(calls, {
  targetRepositories = [REVIEW_YETI_REPOSITORY],
  targetOwner = REVIEW_YETI_REPOSITORY.split('/')[0],
  centralOwner,
  workflow = callerWorkflow,
} = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const authorization = init?.headers?.authorization;
    if (url === 'https://api.github.com/installation') return response({}, 404);
    if (url === 'https://api.github.com/installation/repositories?per_page=100') {
      const repositories = authorization === 'Bearer target-installation-token'
        ? targetRepositories
        : authorization === 'Bearer central-installation-token'
          ? [CENTRAL_REPOSITORY]
          : null;
      if (repositories === null) return response({}, 403);
      return response({
        total_count: repositories.length,
        repositories: repositories.map((fullName) => ({
          full_name: fullName,
          owner: {
            login: authorization === 'Bearer target-installation-token'
              ? targetOwner
              : centralOwner ?? fullName.split('/')[0],
          },
        })),
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
        head: { sha: headSha, ref: 'fix/central-caller' },
      });
    }
    if (url.endsWith(`/actions/runs/${callerRunId}`)) {
      return response({
        repository: { full_name: REVIEW_YETI_REPOSITORY },
        event: 'pull_request_target',
        path: REVIEW_YETI_CALLER_WORKFLOW_PATH,
        head_sha: headSha,
        head_branch: 'fix/central-caller',
        run_attempt: 1,
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
      return response({ encoding: 'base64', content: Buffer.from(workflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('admits only the exact public Review Yeti repository and caller path', () => {
  assert.equal(REVIEW_YETI_REPOSITORY, 'review-yeti-ai/review-yeti-bot');
  assert.equal(REVIEW_YETI_CALLER_WORKFLOW_PATH, '.github/workflows/ct-review-bot.yml');
  assert.deepEqual(resolveAdmittedTarget(REVIEW_YETI_REPOSITORY), {
    owner: 'review-yeti-ai',
    name: 'review-yeti-bot',
    repository: REVIEW_YETI_REPOSITORY,
    callerWorkflowPath: REVIEW_YETI_CALLER_WORKFLOW_PATH,
  });
  assert.equal(validateDispatchPayload(externalPayload).repository, REVIEW_YETI_REPOSITORY);

  for (const repository of [
    'review-yeti-ai/another-repository',
    'another-owner/review-yeti-bot',
    'review-yeti-ai/review-yeti-bot/extra',
    'review-yeti-ai/*',
  ]) {
    assert.throws(() => resolveAdmittedTarget(repository), /not admitted/u);
  }
});

test('public caller requires the exact dispatch App and coordinate-only payload', () => {
  assert.match(validatePublicCallerWorkflow(callerWorkflow), /^[0-9a-f]{64}$/u);

  const invalidWorkflows = [
    [callerWorkflow.replace('${{ steps.dispatch_token.outputs.token }}', '${{ github.token }}'), /dispatch App token|ambient/u],
    [callerWorkflow.replace('actions/create-github-app-token@0123456789abcdef0123456789abcdef01234567', 'actions/checkout@0123456789abcdef0123456789abcdef01234567'), /exactly one/u],
    [callerWorkflow.replace('permission-contents: write', 'permission-actions: read\n          permission-contents: write'), /contents:write/u],
    [callerWorkflow.replace('repositories: example-review-actions', 'repositories: another-private-repository'), /central dispatch repository|repositories/u],
    [callerWorkflow.replace('GH_TOKEN: ${{ steps.dispatch_token.outputs.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), /dispatch App token|ambient|dedicated dispatch App secrets/u],
    [callerWorkflow.replace('request_id:$request_id', 'request_id:$request_id,extra:$extra'), /coordinate-only/u],
    [callerWorkflow.replace('            gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -', '            gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -\n            gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -'), /exactly one/u],
    [callerWorkflow.replace('      - name: Dispatch Review Yeti request', '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n      - name: Dispatch Review Yeti request'), /checkout|dispatch-only|exactly one/u],
  ];

  for (const [workflow, message] of invalidWorkflows) {
    assert.throws(() => validatePublicCallerWorkflow(workflow), message);
  }
});

test('uses distinct exact-installation tokens for public target and private central capacity', async () => {
  const calls = [];
  const result = await validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch(calls),
  });

  assert.equal(result.repository, REVIEW_YETI_REPOSITORY);
  assert.equal(result.caller_workflow_path, REVIEW_YETI_CALLER_WORKFLOW_PATH);
  assert.equal(calls.some((call) => call.url === 'https://api.github.com/installation'), false);
  for (const call of calls) {
    if (call.url.startsWith('https://api.github.com/installation')) continue;
    const expectedToken = call.url.includes(`/repos/${CENTRAL_REPOSITORY}/actions/workflows/`)
      ? 'Bearer central-installation-token'
      : 'Bearer target-installation-token';
    assert.equal(call.init.headers.authorization, expectedToken, call.url);
  }
});

test('central validation applies the strict public caller contract', async () => {
  const weakCaller = callerWorkflow.replace('repositories: example-review-actions', 'repositories: another-private-repository');
  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch([], { workflow: weakCaller }),
  }), /public caller dispatch App|central dispatch repository|repositories/u);
});

test('fails closed when the exact public target token scope is wrong or tokens are reused', async () => {
  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch([], { targetRepositories: ['review-yeti-ai/another-repository'] }),
  }), /repository scope/u);

  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch([], { targetOwner: 'another-owner' }),
  }), /target installation owner/u);

  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'target-installation-token',
    centralToken: 'central-installation-token',
    fetchImpl: externalFetch([], { centralOwner: 'another-owner' }),
  }), /central installation owner/u);

  await assert.rejects(validateCentralDispatch({
    payload: externalPayload,
    targetToken: 'same-installation-token',
    centralToken: 'same-installation-token',
    fetchImpl: externalFetch([]),
  }), /distinct installation tokens/u);
});

test('central workflows use a separate exact public-target App boundary', () => {
  const receiver = readFileSync(new URL('../.github/workflows/repository-dispatch.yml', import.meta.url), 'utf8');
  const reusable = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');

  for (const workflow of [receiver, reusable]) {
    assert.match(workflow, /^\s+review-yeti-ai\/review-yeti-bot\)$/mu);
    assert.doesNotMatch(workflow, /^\s+review-yeti-ai\/\*\)$/mu);
    assert.match(workflow, /REVIEW_YETI_PUBLIC_TARGET_APP_ID/u);
    assert.match(workflow, /REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY/u);
    assert.match(workflow, /owner:\s*review-yeti-ai/u);
    assert.match(workflow, /repositories:\s*review-yeti-bot/u);
    assert.match(workflow, /owner:\s*exampleorg/u);
    assert.match(workflow, /repositories:\s*example-review-actions/u);
    assert.match(workflow, /GH_TARGET_TOKEN:/u);
    assert.match(workflow, /GH_CENTRAL_TOKEN:/u);
    assert.doesNotMatch(workflow, /steps\.ry_token\.outputs\.token \|\| github\.token/u);
  }
});

test('Review Yeti verdict publication cannot trigger target repository workflows', () => {
  const reusable = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');
  const exampleorgTokenStep = reusable.match(
    /- name: Mint Review Yeti App token for exampleorg target[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for exact public target)/u,
  )?.[0] ?? '';
  const publicTokenStep = reusable.match(
    /- name: Mint Review Yeti App token for exact public target[\s\S]*?(?=\n\s+- name: Mint Review Yeti App token for central tooling)/u,
  )?.[0] ?? '';
  assert.match(exampleorgTokenStep, /permission-actions:\s*read/u);
  assert.match(publicTokenStep, /permission-actions:\s*read/u);
  assert.doesNotMatch(reusable, /Trigger target repository CI validation on SHIP/u);
  assert.doesNotMatch(reusable, /gh workflow run/u);
});

test('DOKS reviews delegate provider health to the cluster worker', () => {
  const reusable = readFileSync(new URL('../.github/workflows/review-yeti.yml', import.meta.url), 'utf8');
  const smokeStep = reusable.match(
    /- name: Smoke-test Review Yeti transports[\s\S]*?(?=\n\s+- name: Validate admitted transport handoff)/u,
  )?.[0] ?? '';
  const handoffStep = reusable.match(
    /- name: Validate admitted transport handoff[\s\S]*?(?=\n\s+- name: Resolve Review Yeti release channel)/u,
  )?.[0] ?? '';
  const seedStep = reusable.match(
    /- name: Align panel seed key[\s\S]*?(?=\n\s+- name: Run Review Yeti review panel)/u,
  )?.[0] ?? '';
  const reviewStep = reusable.match(
    /- name: Run Review Yeti review panel[\s\S]*?(?=\n\s+# Loud, not silent:)/u,
  )?.[0] ?? '';

  for (const step of [smokeStep, handoffStep, seedStep]) {
    assert.match(step, /env\.TRUSTED_EXECUTION_BACKEND != 'doks'/u);
  }
  assert.match(reviewStep, /execution-backend:\s*\$\{\{ env\.TRUSTED_EXECUTION_BACKEND \}\}/u);
  assert.match(reviewStep, /\n\s+if: steps\.policy\.outputs\.passthrough != 'true'\n/u);
  assert.doesNotMatch(reviewStep, /\n\s+if:[^\n]*TRUSTED_EXECUTION_BACKEND != 'doks'/u);
});
