import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_APP_PERMISSIONS,
  REQUIRED_COLLECTOR_APP_PERMISSIONS,
  REQUIRED_INSTALLATION_APP_ID,
  MERGE_GROUP_VERIFIER_ACTION,
  RUNTIME_QUALIFICATION_SCHEMA,
  buildGithubAppJwt,
  buildDependencyAuthorityMatrix,
  collectLiveInput,
  digestReadinessResult,
  main,
  parseArgs,
  githubCollection,
  qualifyReadiness as qualifyReadinessAtClock,
  readGraphqlMergeQueue,
} from './review-readiness.mjs';
import {
  REQUIRED_REVIEW_APP_ID as REQUIRED_CHECK_APP_ID,
  REQUIRED_REVIEW_CONTEXT as REQUIRED_CONTEXT,
  REQUIRED_REVIEW_SLUG as REQUIRED_REVIEW_APP_SLUG,
} from './review-check-contract.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const fixtureNow = Date.parse('2026-09-09T12:00:00Z');

function qualifyReadiness(input, options = {}) {
  return qualifyReadinessAtClock(input, { now: fixtureNow, ...options });
}

const callerWorkflow = `
name: Review Yeti
on:
  pull_request_target:
    types: [opened, synchronize]
permissions:
  actions: read
  contents: read
  pull-requests: read
jobs:
  dispatch:
    name: Dispatch native Review Yeti
    steps:
      - uses: actions/create-github-app-token@${'c'.repeat(40)}
        with:
          app-id: \${{ secrets.CT_REVIEW_BOT_APP_ID }}
          private-key: \${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}
          owner: exampleorg
          repositories: example-review-actions,dashboard
      - run: gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -
      - run: echo review-yeti-request request_id repository pr_number base_sha head_sha
      - run: echo "request_id=dashboard:\${{ github.event.pull_request.number }}:\${{ github.event.pull_request.head.sha }}:\${{ github.run_id }}:\${{ github.run_attempt }}"
`;

const mergeGroupWorkflow = `
name: Dashboard Review Yeti Merge Group
on:
  merge_group:
    types: [checks_requested]
permissions:
  checks: read
  contents: read
  pull-requests: read
jobs:
  review:
    name: Publish native Review Yeti merge-group gate
    steps:
      - name: Mint Review Yeti App token
        id: ry_token
        uses: actions/create-github-app-token@${'d'.repeat(40)}
        with:
          app-id: \${{ secrets.CT_REVIEW_BOT_APP_ID }}
          private-key: \${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}
          owner: exampleorg
          repositories: dashboard
      - name: Verify constituents and publish native gate
        uses: ${MERGE_GROUP_VERIFIER_ACTION}@${'c'.repeat(40)}
        with:
          review-yeti-token: \${{ steps.ry_token.outputs.token }}
          repository: \${{ github.repository }}
          branch: \${{ github.event.merge_group.base_ref }}
`;

const centralReceiverWorkflow = `
name: Central Review Yeti Dispatch
on:
  repository_dispatch:
    types: [review-yeti-request]
permissions:
  actions: read
  contents: read
  id-token: write
  issues: write
  pull-requests: write
env:
  CENTRAL_DISPATCH_PAYLOAD: payload
jobs:
  validate:
    steps:
      - run: node scripts/validate-central-dispatch.mjs
  review:
    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1
`;

const centralReviewWorkflow = `
on:
  workflow_call:
    inputs:
      execution_backend:
        type: string
jobs:
  review:
    steps:
      - run: echo execution
        with:
          check-id: \${{ (inputs.execution_backend || vars.REVIEW_YETI_EXECUTION_BACKEND || 'local') != 'doks' && steps.init_check.outputs.check_id || '' }}
          execution-backend: \${{ inputs.execution_backend || vars.REVIEW_YETI_EXECUTION_BACKEND || 'local' }}
          doks-dispatch-url: https://review-bot.example.com/api/dispatch/action
          doks-publish-mode: \${{ steps.policy.outputs.doks_publish_mode }}
`;

const ruleset = {
  name: 'Master merge queue',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
  rules: [
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [
          { context: REQUIRED_CONTEXT, integration_id: REQUIRED_CHECK_APP_ID },
        ],
      },
    },
    { type: 'merge_queue' },
  ],
};

const installation = {
  app_id: REQUIRED_INSTALLATION_APP_ID,
  app_slug: REQUIRED_REVIEW_APP_SLUG,
  repository_selection: 'selected',
  permissions: REQUIRED_APP_PERMISSIONS,
};

function readyInput(overrides = {}) {
  return {
    repository: 'exampleorg/dashboard',
    branch: 'master',
    defaultBranch: 'master',
    prNumber: 42,
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
    pullRequest: {
      number: 42,
      state: 'open',
      base: { sha: baseSha, repo: { full_name: 'exampleorg/dashboard' } },
      head: { sha: headSha, ref: 'feature/readiness' },
    },
    callerWorkflow,
    mergeGroupWorkflow,
    centralReceiverWorkflow,
    centralReviewWorkflow,
    centralRefSha: 'c'.repeat(40),
    centralRefObservation: {
      repository: 'exampleorg/example-review-actions',
      ref: 'v1',
      sha: 'c'.repeat(40),
      provenance: 'github-api',
      observed_at: new Date(fixtureNow - 60_000).toISOString(),
    },
    ruleset,
    installation,
    mergeQueue: {
      id: 'MQ_123',
      entries: [{ position: 1, state: 'QUEUED', pullRequest: { number: 42, headRefOid: headSha } }],
    },
    checkRuns: [
      { id: 100, name: REQUIRED_CONTEXT, app: { id: REQUIRED_CHECK_APP_ID, slug: REQUIRED_REVIEW_APP_SLUG }, status: 'completed', conclusion: 'success', head_sha: headSha },
    ],
    callerRun: {
      id: 12345,
      run_attempt: 2,
      repository: { full_name: 'exampleorg/dashboard' },
      event: 'pull_request_target',
      path: '.github/workflows/ct-review-bot.yml',
      head_sha: headSha,
      pull_requests: [{ number: 42 }],
    },
    centralRuns: [{
      id: 67890,
      display_title: `Review Yeti central / dashboard:42:${headSha}:12345:2`,
      event: 'repository_dispatch',
      path: '.github/workflows/repository-dispatch.yml',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'c'.repeat(40),
    }],
    ...overrides,
  };
}

test('parseArgs rejects missing values, invalid PR numbers, and unknown flags', () => {
  assert.throws(() => parseArgs(['--repository']), /--repository requires a value/u);
  assert.throws(() => parseArgs(['--repository', 'exampleorg/dashboard', '--pr-number', '0']), /positive integer/u);
  assert.throws(() => parseArgs(['--repository', 'exampleorg/dashboard', '--unsupported']), /unknown argument/u);
});

test('CLI subprocess rejects an incomplete argument before any credential or API access', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./review-readiness.mjs', import.meta.url)), '--repository'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--repository requires a value/u);
  assert.equal(run.stdout, '');
});

test('main uses the GITHUB_TOKEN fallback and emits JSON through the injected boundary', async () => {
  let collected;
  const output = [];
  const exitCode = await main({
    argv: ['--repository', 'exampleorg/dashboard', '--json'],
    env: { GITHUB_TOKEN: 'fallback-token' },
    fetchImpl: () => assert.fail('injected collector must prevent network access'),
    now: fixtureNow,
    collectInput: async (input) => {
      collected = input;
      return readyInput();
    },
    stdout: (line) => output.push(line),
  });
  assert.equal(exitCode, 0);
  assert.equal(collected.token, 'fallback-token');
  assert.equal(collected.repository, 'exampleorg/dashboard');
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).status, 'ready');
});

test('main returns nonzero and emits text for a not-ready qualification', async () => {
  const output = [];
  const exitCode = await main({
    argv: ['--repository', 'exampleorg/dashboard'],
    env: { GH_TOKEN: 'test-token' },
    now: fixtureNow,
    collectInput: async () => readyInput({ centralRefSha: 'not-a-sha' }),
    stdout: (line) => output.push(line),
  });
  assert.equal(exitCode, 1);
  assert.match(output[0], /^Review Yeti readiness: not_ready /u);
  assert.ok(output.some((line) => line.includes('central_compatibility')));
});

test('qualifies a central-dispatch consumer with an active merge queue', () => {
  const result = qualifyReadiness(readyInput());
  assert.equal(result.status, 'ready', JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
  assert.equal(result.evidence.required_check.integration_id, REQUIRED_CHECK_APP_ID);
  assert.equal(result.evidence.deployed_schema_compatibility, 'not_checked');
  assert.equal(result.evidence.runtime_qualification.schema, RUNTIME_QUALIFICATION_SCHEMA);
  assert.equal(result.evidence.runtime_qualification.ready, false);
  assert.equal(result.evidence.runtime_qualification.status, 'unknown');
  assert.equal(result.evidence.runtime_qualification.matrix_status, 'unknown');
  assert.equal(result.base_sha, baseSha);
  assert.equal(result.head_sha, headSha);
  assert.equal(result.content_digest, digestReadinessResult({ ...result, content_digest: undefined }));
  assert.match(result.evidence.merge_queue_id, /^[0-9a-f]{64}$/u);
  const matrix = result.evidence.dependency_matrix;
  assert.equal(matrix.status, 'unknown');
  assert.ok(matrix.authority_delta.unknown.length > 0);
  assert.deepEqual(matrix.authority_delta.incompatible, []);
  assert.ok(matrix.authority_delta.technically_compatible.some((entry) => entry.dependency === 'source'));
  assert.equal(matrix.authority_delta.available, undefined);
  assert.equal(matrix.authority_delta.authorization.status, 'unknown');
  assert.deepEqual(matrix.authority_delta.authorization.required, matrix.authority_delta.required);
  assert.match(matrix.authority_delta.authorization.reason, /not authorization/u);
  assert.equal(matrix.rows[0].owner.readiness.repository, 'exampleorg/example-review-actions');
  assert.equal(matrix.rows[0].owner.source.repository, 'exampleorg/example-review-actions');
  assert.equal(matrix.rows[0].owner.schema.repository, 'review-yeti-ai/review-yeti-bot');
  assert.equal(matrix.rows[0].owner.operator.repository, 'review-yeti-ai/review-yeti-bot');
  assert.equal(matrix.rows[0].owner.service.repository, 'exampleorg/example-infra');
  for (const name of ['source', 'artifact', 'schema', 'operator', 'service', 'consumer_process']) {
    assert.ok(['compatible', 'unknown'].includes(matrix.rows[0][name].status));
  }
});

test('fails closed when the caller process is missing from runtime qualification', () => {
  const result = qualifyReadiness(readyInput({ callerWorkflow: undefined, callerRun: undefined }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'caller_workflow'));
  assert.equal(result.evidence.dependency_matrix.status, 'unknown');
  assert.ok(result.evidence.dependency_matrix.authority_delta.unknown.some((entry) => entry.dependency === 'consumer_process'));
});

test('requires the caller identity to bind both run ID and attempt suffix', () => {
  const result = qualifyReadiness(readyInput({
    callerWorkflow: callerWorkflow.replace('${{ github.run_attempt }}', '${{ github.attempt }}'),
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'caller_attempt_identity'));
  assert.equal(result.evidence.dependency_matrix.rows[0].consumer_process.status, 'unknown');
});

test('matches exact caller App repository tokens without regex interpolation', () => {
  const dottedRepository = 'exampleorg/dash.board';
  const basePullRequest = readyInput().pullRequest;
  const baseCallerRun = readyInput().callerRun;
  const exactInput = readyInput({
    repository: dottedRepository,
    callerWorkflow: callerWorkflow.replace('example-review-actions,dashboard', 'example-review-actions,dash.board'),
    mergeGroupWorkflow: mergeGroupWorkflow.replace('repositories: dashboard', 'repositories: dash.board'),
    pullRequest: {
      ...basePullRequest,
      base: { ...basePullRequest.base, repo: { full_name: dottedRepository } },
    },
    callerRun: { ...baseCallerRun, repository: { full_name: dottedRepository } },
    centralRuns: [{
      ...readyInput().centralRuns[0],
      display_title: `Review Yeti central / dash.board:42:${headSha}:12345:2`,
    }],
  });
  assert.equal(qualifyReadiness(exactInput).status, 'ready');

  const nearMiss = qualifyReadiness({
    ...exactInput,
    callerWorkflow: exactInput.callerWorkflow.replace('dash.board', 'dashxboard'),
  });
  assert.equal(nearMiss.status, 'not_ready');
  assert.ok(nearMiss.failures.some((failure) => failure.code === 'app_token'));
});

test('does not treat an untrusted deployment input as runtime authority', () => {
  const result = qualifyReadiness(readyInput({ deploymentReadback: { compatibility: 'compatible' } }));
  assert.equal(result.status, 'ready');
  assert.ok(result.evidence.dependency_matrix.authority_delta.unknown.some((entry) => entry.dependency === 'artifact'));
  assert.equal(result.evidence.dependency_matrix.rows[0].artifact.status, 'unknown');
});

test('rejects a stale central ref observation independently of source workflow shape', () => {
  const result = qualifyReadiness(readyInput({
    centralRefSha: 'd'.repeat(40),
  }));
  assert.equal(result.status, 'not_ready');
  assert.equal(result.evidence.dependency_matrix.rows[0].source.status, 'unknown');
  assert.ok(result.evidence.dependency_matrix.authority_delta.unknown.some((entry) => entry.dependency === 'source'));
});

test('rejects an old owner observation even when its source SHA still matches', () => {
  const result = qualifyReadiness(readyInput({
    centralRefObservation: { ...readyInput().centralRefObservation, observed_at: '2020-01-01T00:00:00Z' },
  }));
  assert.equal(result.status, 'not_ready');
  assert.equal(result.evidence.dependency_matrix.status, 'unknown');
  assert.deepEqual(result.evidence.merge_group_verifier_binding, {
    status: 'unknown',
    expected_sha: null,
    actual_sha: 'c'.repeat(40),
    actual_count: 1,
  });
});

test('uses the injected qualification clock for observation freshness', () => {
  const result = qualifyReadiness(readyInput(), {
    now: fixtureNow + (24 * 60 * 60 * 1000) + 1,
  });
  assert.equal(result.status, 'not_ready');
  assert.equal(result.evidence.dependency_matrix.rows[0].source.status, 'unknown');
  assert.ok(result.evidence.dependency_matrix.authority_delta.unknown.some(
    (entry) => entry.dependency === 'source',
  ));
  assert.equal(result.evidence.merge_group_verifier_binding.status, 'unknown');
});

test('checks the installed Review Yeti App ID separately from required-check integration ID', () => {
  const result = qualifyReadiness(readyInput({ installation: { ...installation, app_id: 99999 } }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'app_publisher_id'));
  assert.equal(result.evidence.required_check.integration_id, REQUIRED_CHECK_APP_ID);
  assert.equal(result.evidence.app_installation.app_id, 99999);
  assert.ok(!result.failures.some((failure) => failure.code === 'required_publisher'));
});

test('keeps source-qualified configuration ready while runtime authority remains unknown', () => {
  const runtime = qualifyReadiness(readyInput());
  assert.equal(runtime.status, 'ready');
  assert.equal(runtime.evidence.dependency_matrix.rows[0].source.status, 'compatible');
  assert.equal(runtime.evidence.dependency_matrix.status, 'unknown');
  const configuration = qualifyReadiness(readyInput({
    prNumber: undefined,
    expectedBaseSha: undefined,
    expectedHeadSha: undefined,
    pullRequest: undefined,
    mergeQueue: { id: 'MQ_123' },
    checkRuns: undefined,
    callerRun: undefined,
    centralRuns: undefined,
  }));
  assert.equal(configuration.qualification_mode, 'configuration');
  assert.equal(configuration.status, 'ready');
  assert.equal(configuration.evidence.dependency_matrix.status, 'unknown');
});

test('fails closed across malformed source, workflow, ruleset, installation, and queue evidence', () => {
  const malformed = qualifyReadiness(readyInput({
    callerWorkflow: 'not-a-workflow',
    mergeGroupWorkflow: undefined,
    centralReceiverWorkflow: undefined,
    centralReviewWorkflow: undefined,
    centralRefSha: 'not-a-sha',
    rulesets: [],
    installation: undefined,
    mergeQueue: null,
  }));
  assert.equal(malformed.status, 'not_ready');

  const missingRules = qualifyReadiness(readyInput({
    rulesets: [{
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [],
    }],
  }));
  assert.ok(missingRules.failures.some((failure) => failure.code === 'required_check'));
  assert.ok(missingRules.failures.some((failure) => failure.code === 'merge_queue'));

  const missingPermissions = qualifyReadiness(readyInput({
    installation: { ...installation, permissions: undefined },
  }));
  assert.ok(missingPermissions.failures.some((failure) => failure.code === 'app_permissions'));
});

test('accepts cisco-style dispatch observability and exact-head dedup without mistaking them for polling', () => {
  const ciscoStyleCaller = callerWorkflow
    .replace('name: Dispatch native Review Yeti', 'name: Review Yeti / Review Yeti')
    .replace(
      '- run: gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -',
      '- run: gh api "repos/${TARGET_REPOSITORY}/commits/${EXPECTED_HEAD_SHA}/check-runs?filter=all&per_page=100"\n'
        + '      - run: gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -',
    );
  const result = qualifyReadiness(readyInput({ callerWorkflow: ciscoStyleCaller }));
  assert.equal(result.failures.some((failure) => failure.code === 'caller_producer'), false);
  assert.equal(result.status, 'ready');
});

test('rejects self-publication, polling, stale check coordinates, repeated reads, and widened caller permissions', () => {
  const exactRead = 'gh api "repos/${TARGET_REPOSITORY}/commits/${EXPECTED_HEAD_SHA}/check-runs?filter=all&per_page=100"';
  const base = callerWorkflow.replace(
    'gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -',
    `${exactRead}\n      - run: gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -`,
  );
  const producerCases = [
    base.replace(exactRead, `gh api --method POST "repos/${'${TARGET_REPOSITORY}'}/commits/${'${EXPECTED_HEAD_SHA}'}/check-runs"`),
    base.replace(exactRead, `while true; do ${exactRead}; sleep 1; done`),
    base.replace(exactRead, `while true; do ${exactRead}; done`),
    base.replace('${EXPECTED_HEAD_SHA}', '${GITHUB_SHA}'),
    base.replace(exactRead, `${exactRead}\n      - run: ${exactRead}`),
    base.replace(exactRead, 'gh api "repos/${TARGET_REPOSITORY}/actions/runs?per_page=100"'),
    base.replace(exactRead, 'gh api "repos/${TARGET_REPOSITORY}/actions/workflows/repository-dispatch.yml/runs?per_page=100"'),
    base.replace(exactRead, 'gh run list --workflow repository-dispatch.yml'),
    base.replace(
      exactRead,
      `echo '${exactRead}' >/dev/null; endpoint='check''-runs'; gh api -f name='Review Yeti Gate' "repos/${'${TARGET_REPOSITORY}'}/commits/${'${EXPECTED_HEAD_SHA}'}/${'${endpoint}'}"`,
    ),
    base.replace(
      'gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -',
      `echo repos/exampleorg/example-review-actions/dispatches; endpoint='check''-runs'; gh api -f name='Review Yeti Gate' "repos/${'${TARGET_REPOSITORY}'}/commits/${'${EXPECTED_HEAD_SHA}'}/${'${endpoint}'}"`,
    ),
    base.replace(
      'gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -',
      `echo gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -; g=gh; endpoint='check''-runs'; "$g" api -f name='Review Yeti Gate' "repos/${'${TARGET_REPOSITORY}'}/commits/${'${EXPECTED_HEAD_SHA}'}/${'${endpoint}'}"`,
    ),
    base.replace(exactRead, `${exactRead}\n      - run: gh api -X GET repos/${'${TARGET_REPOSITORY}'}/pulls/42; gh api -X DELETE repos/${'${TARGET_REPOSITORY}'}/issues/1`),
    base.replace(exactRead, `${exactRead}\n      - run: bash -c 'while true; do echo polling; done'`),
  ];
  for (const candidate of producerCases) {
    const result = qualifyReadiness(readyInput({ callerWorkflow: candidate }));
    assert.ok(result.failures.some((failure) => failure.code === 'caller_producer'));
  }

  const widened = callerWorkflow.replace('  contents: read', '  checks: write\n  contents: read');
  const widenedResult = qualifyReadiness(readyInput({ callerWorkflow: widened }));
  assert.ok(widenedResult.failures.some((failure) => failure.code === 'caller'));

  const jobOverride = callerWorkflow.replace(
    '  dispatch:\n',
    '  dispatch:\n    permissions:\n      checks: write\n',
  );
  const overrideResult = qualifyReadiness(readyInput({ callerWorkflow: jobOverride }));
  assert.ok(overrideResult.failures.some((failure) => failure.code === 'caller'));
});

test('keeps configuration consumer identity unknown and validates every runtime queue identity', () => {
  const configuration = qualifyReadiness(readyInput({
    prNumber: undefined,
    expectedBaseSha: undefined,
    expectedHeadSha: undefined,
    pullRequest: undefined,
    callerWorkflow: undefined,
    callerRun: undefined,
    centralRuns: undefined,
    mergeQueue: { id: 'MQ_123' },
    checkRuns: undefined,
  }));
  assert.equal(configuration.qualification_mode, 'configuration');
  assert.equal(configuration.evidence.dependency_matrix.rows[0].consumer_process.status, 'unknown');

  const disabled = qualifyReadiness(readyInput({ mergeQueue: { state: 'disabled' } }));
  assert.ok(disabled.failures.some((failure) => failure.code === 'merge_queue' && /disabled/u.test(failure.message)));

  const noEntries = qualifyReadiness(readyInput({ mergeQueue: { state: 'enabled', id: 'MQ_123' } }));
  assert.equal(noEntries.evidence.merge_queue_state, 'enabled');
  assert.equal(noEntries.failures.some((failure) => failure.code === 'merge_queue'), false);

  const malformedEntry = qualifyReadiness(readyInput({
    mergeQueue: {
      state: 'enabled',
      id: 'MQ_123',
      entries: [{ position: 0, state: 'UNKNOWN', pullRequest: { number: 42, headRefOid: 'not-a-sha' } }],
    },
  }));
  assert.ok(malformedEntry.failures.some((failure) => /no valid position/u.test(failure.message)));
  assert.ok(malformedEntry.failures.some((failure) => /unknown state/u.test(failure.message)));
  assert.ok(malformedEntry.failures.some((failure) => /no exact head SHA/u.test(failure.message)));

  const movedHead = qualifyReadiness(readyInput({
    mergeQueue: {
      state: 'enabled',
      id: 'MQ_123',
      entries: [{ position: 1, state: 'QUEUED', pullRequest: { number: 42, headRefOid: baseSha } }],
    },
  }));
  assert.ok(movedHead.failures.some((failure) => /head SHA changed/u.test(failure.message)));

  const noPrRuntime = qualifyReadiness(readyInput({
    mode: 'runtime',
    prNumber: undefined,
    expectedBaseSha: undefined,
    expectedHeadSha: undefined,
    pullRequest: undefined,
    callerRun: undefined,
    centralRuns: undefined,
    checkRuns: undefined,
  }));
  assert.ok(noPrRuntime.failures.some((failure) => /requires a pull request number/u.test(failure.message)));
});

test('rejects malformed dispatch identity and preserves owner evidence boundaries', () => {
  const malformedIdentity = qualifyReadiness(readyInput({ expectedHeadSha: 'not-a-sha' }));
  assert.ok(malformedIdentity.failures.some((failure) => failure.code === 'dispatch_correlation'
    && /does not bind repository/u.test(failure.message)));
  const untrusted = qualifyReadiness(readyInput({ deploymentReadback: {
    compatibility: 'compatible',
    provenance: 'owner-readback',
    authority: 'central-service-owner',
  } }));
  assert.equal(untrusted.evidence.runtime_qualification.ready, false);
  assert.equal(untrusted.evidence.runtime_qualification.status, 'unknown');
});

test('fails closed on missing merge-group permissions and producer markers', () => {
  const result = qualifyReadiness(readyInput({
    mergeGroupWorkflow: mergeGroupWorkflow
      .replace('  checks: read\n', '')
      .replace('${{ github.event.merge_group.base_ref }}', '${{ github.ref_name }}'),
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'merge_group'));
  assert.ok(result.failures.some((failure) => failure.code === 'merge_group_qualification'));
});

test('does not qualify comment or echo-only merge-group markers', () => {
  const actionStart = mergeGroupWorkflow.indexOf('      - name: Verify constituent exact-head checks');
  const decoyWorkflow = `${mergeGroupWorkflow.slice(0, actionStart)}      - run: |
          queue_json="$(echo fake mergeQueue(branch: current PR check-runs?per_page=100)"
          current_pr="$(echo \"current PR\")"
          check_count="$(echo 1)"
          if [[ "$current_pr" != "$PR_NUMBER" ]] || [[ "$check_count" != "1" ]]; then
            echo "current PR or exact publisher check is not qualified"
            exit 1
          fi
`;
  const result = qualifyReadiness(readyInput({ mergeGroupWorkflow: decoyWorkflow }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'merge_group_qualification'));
});

test('classifies malformed merge-group producers with the producer failure code', () => {
  const duplicateJobName = mergeGroupWorkflow.replace(
    'jobs:\n  review:',
    'jobs:\n  duplicate:\n    name: Review Yeti / Review Yeti\n    steps: []\n  review:',
  );
  const cases = [
    ['missing checks_requested', mergeGroupWorkflow.replace('types: [checks_requested]', 'types: [completed]')],
    ['zero jobs', mergeGroupWorkflow.replace('jobs:\n  review:', 'jobs:\n')],
    ['duplicate job name', duplicateJobName],
    ['unrelated push', mergeGroupWorkflow.replace('permissions:', 'push:\n\npermissions:')],
  ];
  for (const [label, workflow] of cases) {
    const result = qualifyReadiness(readyInput({ mergeGroupWorkflow: workflow }));
    assert.equal(result.status, 'not_ready', label);
    assert.ok(result.failures.some((failure) => failure.code === 'merge_group_producer'), label);
  }
});

test('fails closed when the required check has the wrong publisher', () => {
  const result = qualifyReadiness(readyInput({
    ruleset: {
      ...ruleset,
      rules: [{
        ...ruleset.rules[0],
        parameters: { required_status_checks: [{ context: REQUIRED_CONTEXT, integration_id: 99999 }] },
      }, ruleset.rules[1]],
    },
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'required_publisher'));
});

test('fails closed when the promoted receiver and DOKS caller contract drift', () => {
  const result = qualifyReadiness(readyInput({
    centralReceiverWorkflow: centralReceiverWorkflow.replace('types: [review-yeti-request]', 'types: [other-event]'),
    centralReviewWorkflow: centralReviewWorkflow.replace("!= 'doks'", "== 'local'"),
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'central_receiver'));
  assert.ok(result.failures.some((failure) => failure.code === 'central_compatibility'));
});

test('fails closed on unknown queue state instead of treating null as queue-disabled', () => {
  const unknown = qualifyReadiness(readyInput({ mergeQueue: null }));
  assert.equal(unknown.status, 'not_ready');
  assert.ok(unknown.failures.some((failure) => failure.code === 'merge_queue' && /unknown/u.test(failure.message)));

  const malformed = qualifyReadiness(readyInput({
    mergeQueue: { id: 'MQ_123', entries: 'not-an-array' },
  }));
  assert.equal(malformed.status, 'not_ready');
  assert.ok(malformed.failures.some((failure) => failure.code === 'merge_queue' && /malformed/u.test(failure.message)));
});

test('does not qualify a locked or unmergeable current queue entry', () => {
  for (const state of ['LOCKED', 'UNMERGEABLE']) {
    const result = qualifyReadiness(readyInput({
      mergeQueue: {
        id: 'MQ_123',
        entries: [{ position: 1, state, pullRequest: { number: 42, headRefOid: headSha } }],
      },
    }));
    assert.equal(result.status, 'not_ready');
    assert.ok(result.failures.some((failure) => failure.code === 'merge_queue' && failure.message.includes(state.toLowerCase())));
  }
});

test('fails closed on duplicate or stale dispatch correlation', () => {
  const duplicate = qualifyReadiness(readyInput({
    centralRuns: [
      ...readyInput().centralRuns,
      ...readyInput().centralRuns,
    ],
  }));
  assert.equal(duplicate.status, 'not_ready');
  assert.ok(duplicate.failures.some((failure) => failure.code === 'dispatch_correlation'));

  const stale = qualifyReadiness(readyInput({
    callerRun: { ...readyInput().callerRun, head_sha: baseSha },
  }));
  assert.equal(stale.status, 'not_ready');
  assert.ok(stale.failures.some((failure) => failure.code === 'dispatch_correlation'));
});

test('requires the latest correlated central dispatch run to be completed successfully', () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const result = qualifyReadiness(readyInput({
      centralRuns: [{ ...readyInput().centralRuns[0], status, conclusion: status === 'completed' ? 'failure' : null }],
    }));
    assert.equal(result.status, 'not_ready');
    assert.ok(result.failures.some((failure) => failure.code === 'dispatch_correlation'));
  }
  const staleSuccess = readyInput().centralRuns[0];
  const latestFailure = {
    ...staleSuccess,
    id: 67891,
    created_at: '2026-09-09T10:02:00Z',
    status: 'completed',
    conclusion: 'failure',
  };
  const duplicate = qualifyReadiness(readyInput({ centralRuns: [staleSuccess, latestFailure] }));
  assert.equal(duplicate.status, 'not_ready');
  assert.ok(duplicate.failures.some((failure) => failure.code === 'dispatch_correlation'));
});

test('rejects a successful central dispatch run published from the wrong central source head', () => {
  const result = qualifyReadiness(readyInput({
    centralRuns: [{ ...readyInput().centralRuns[0], head_sha: 'd'.repeat(40) }],
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'dispatch_correlation'
    && /not bound to the resolved central ref/u.test(failure.message)));
});

test('fails closed when the qualified pull request is closed or moved', () => {
  const result = qualifyReadiness(readyInput({
    pullRequest: { ...readyInput().pullRequest, state: 'closed' },
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'pr_identity'));
});

test('fails closed on malformed review check state and wrong installed publisher', () => {
  const result = qualifyReadiness(readyInput({
    installation: { ...installation, app_slug: 'wrong-app' },
    checkRuns: [{ name: REQUIRED_CONTEXT, app: { id: REQUIRED_CHECK_APP_ID }, status: 'queued', conclusion: null }],
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'app_publisher'));
  assert.ok(result.failures.some((failure) => failure.code === 'required_publisher'));
  assert.doesNotMatch(JSON.stringify(result), /qualification-secret|private-key-must-not-cross/u);
});

test('fails closed when the installed Review Yeti App lacks a required permission', () => {
  const permissions = { ...REQUIRED_APP_PERMISSIONS };
  delete permissions.checks;
  const result = qualifyReadiness(readyInput({ installation: { ...installation, permissions } }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'app_permissions' && /checks:write/u.test(failure.message)));
});

test('keeps collector-only ruleset scope separate from runtime App permissions', () => {
  assert.deepEqual(REQUIRED_COLLECTOR_APP_PERMISSIONS, { administration: 'read' });
  assert.equal(REQUIRED_APP_PERMISSIONS.administration, undefined);
  assert.equal(REQUIRED_APP_PERMISSIONS.contents, 'write');
});

test('uses the existing read-only collector App without widening the runtime publisher', () => {
  const workflow = readFileSync(new URL('../.github/workflows/review-readiness.yml', import.meta.url), 'utf8');
  assert.match(workflow, /app-id: \$\{\{ secrets\.CT_READONLY_APP_ID \}\}/u);
  assert.match(workflow, /private-key: \$\{\{ secrets\.CT_READONLY_APP_PRIVATE_KEY \}\}/u);
  assert.doesNotMatch(workflow, /permission-administration:/u);
  assert.match(workflow, /REVIEW_YETI_APP_ID: \$\{\{ secrets\.CT_REVIEW_BOT_APP_ID \}\}/u);
  assert.match(workflow, /REVIEW_YETI_APP_PRIVATE_KEY: \$\{\{ secrets\.CT_REVIEW_BOT_APP_PRIVATE_KEY \}\}/u);
});

test('runs the canonical admission validator before minting the collector token', () => {
  const workflow = readFileSync(new URL('../.github/workflows/review-readiness.yml', import.meta.url), 'utf8');
  const admission = workflow.indexOf('assertAdmittedRepository(process.env.REPOSITORY)');
  const mint = workflow.indexOf('name: Mint scoped readiness reader token');
  assert.ok(admission >= 0, 'workflow must invoke the canonical admission validator');
  assert.ok(mint > admission, 'repository admission must precede token minting');
  assert.doesNotMatch(workflow, /repository_name.*=~|REPOSITORY.*exampleorg\/\*/u);
});

test('documented merge-group examples are dedicated qualifier-compatible workflows', () => {
  for (const document of ['../README.md', '../docs/onboarding-guide.md']) {
    const source = readFileSync(new URL(document, import.meta.url), 'utf8');
    const marker = source.indexOf('.github/workflows/ct-review-merge-group.yml');
    assert.ok(marker >= 0, `${document} must name the dedicated workflow`);
    const fenceStart = source.indexOf('```yaml', marker);
    assert.ok(fenceStart > marker, `${document} must include the dedicated workflow example`);
    const contentStart = fenceStart + '```yaml'.length;
    const fenceEnd = source.indexOf('```', contentStart);
    assert.ok(fenceEnd > contentStart, `${document} dedicated workflow example must be fenced`);
    const workflow = source.slice(contentStart, fenceEnd)
      .replaceAll('<full-40-hex-central-release-sha>', 'c'.repeat(40));
    const result = qualifyReadiness(readyInput({ mergeGroupWorkflow: workflow }));
    assert.equal(result.status, 'ready', `${document} example must pass the actual qualifier`);
    assert.equal((workflow.match(/^\s+name:\s*Publish native Review Yeti merge-group gate\s*$/gmu) || []).length, 1);
    assert.doesNotMatch(workflow, /^\s+if:/mu);
    assert.match(workflow, /^  merge_group:\s*$/mu);
    assert.match(workflow, /^    types:\s*\[checks_requested\]\s*$/mu);
    assert.match(workflow, /^  checks:\s*read\s*$/mu);
    assert.match(workflow, /^  contents:\s*read\s*$/mu);
    assert.match(workflow, /^  pull-requests:\s*read\s*$/mu);
  }
  assert.equal((callerWorkflow.match(/Review Yeti \/ Review Yeti/gmu) || []).length, 0);
});

test('documentation labels generic callers and distinguishes constituent checks from synthetic output', () => {
  for (const document of ['../README.md', '../docs/onboarding-guide.md']) {
    const source = readFileSync(new URL(document, import.meta.url), 'utf8');
    assert.match(source, /qualification-ready exampleorg template/u);
    assert.ok(source.includes('.github/workflows/ct-review-bot.yml'), `${document} must name the governed caller path`);
    assert.ok(source.includes('CALLER_WORKFLOW_PATH'), `${document} must identify the caller path contract`);
    assert.ok(source.includes('.github/workflows/review-readiness.yml'), `${document} must point to the read-only collector`);
    assert.match(source, /dispatch-only/u);
    assert.ok(source.includes('App (integration `4385771`)') || source.includes('App `4385771`'), `${document} must bind the native publisher identity`);
    assert.match(source, /require\s+\*\*`Review Yeti`\*\*/u);
    assert.match(source, /synthetic combined head/u);
  }
});

test('README scopes dual check publication to legacy local execution and keeps DOKS raw-only', () => {
  const source = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(source, /DOKS central action writes zero checks/u);
  assert.match(source, /worker publishes only the raw `Review Yeti` check/u);
  assert.match(source, /legacy hosted\/local compatibility path/u);
  assert.match(source, /also publishes `Review Yeti Gate`/u);
  assert.match(source, /must not\s+be required for governed DOKS repositories/u);
});

test('accepts a thin consumer shim only when it pins and binds the central verifier action', () => {
  const actionWorkflow = mergeGroupWorkflow;
  const result = qualifyReadiness(readyInput({ mergeGroupWorkflow: actionWorkflow }));
  assert.equal(result.status, 'ready');
  assert.equal(result.evidence.merge_group_verifier, 'central_sha_pinned_action');
  assert.deepEqual(result.evidence.merge_group_verifier_binding, {
    status: 'matched',
    expected_sha: 'c'.repeat(40),
    actual_sha: 'c'.repeat(40),
    actual_count: 1,
  });
});

test('requires the merge-group action pin to match the fresh observed central v1 release', () => {
  const matchingWorkflow = mergeGroupWorkflow;
  const mismatchedWorkflow = matchingWorkflow.replace(`@${'c'.repeat(40)}`, `@${'e'.repeat(40)}`);
  const mismatched = qualifyReadiness(readyInput({ mergeGroupWorkflow: mismatchedWorkflow }));
  assert.equal(mismatched.status, 'not_ready');
  assert.ok(mismatched.failures.some((failure) => failure.code === 'merge_group_qualification'
    && /match the observed central v1 release SHA/u.test(failure.message)));
  assert.deepEqual(mismatched.evidence.merge_group_verifier_binding, {
    status: 'mismatch',
    expected_sha: 'c'.repeat(40),
    actual_sha: 'e'.repeat(40),
    actual_count: 1,
  });

  const missingWorkflow = matchingWorkflow.replace(`@${'c'.repeat(40)}`, '');
  const missing = qualifyReadiness(readyInput({ mergeGroupWorkflow: missingWorkflow }));
  assert.equal(missing.status, 'not_ready');
  assert.deepEqual(missing.evidence.merge_group_verifier_binding, {
    status: 'missing',
    expected_sha: 'c'.repeat(40),
    actual_sha: null,
    actual_count: 0,
  });

  const unknown = qualifyReadiness(readyInput({
    centralRefSha: undefined,
    centralRefObservation: undefined,
    mergeGroupWorkflow: matchingWorkflow,
  }));
  assert.equal(unknown.status, 'not_ready');
  assert.deepEqual(unknown.evidence.merge_group_verifier_binding, {
    status: 'unknown',
    expected_sha: null,
    actual_sha: 'c'.repeat(40),
    actual_count: 1,
  });
});

test('separates configuration qualification from optional exact-head runtime evidence', () => {
  const result = qualifyReadiness(readyInput({
    prNumber: undefined,
    expectedBaseSha: undefined,
    expectedHeadSha: undefined,
    pullRequest: undefined,
    mergeQueue: { id: 'MQ_123' },
    checkRuns: undefined,
    callerRun: undefined,
    centralRuns: undefined,
  }));
  assert.equal(result.qualification_mode, 'configuration');
  assert.equal(result.status, 'ready');
  assert.equal(result.pull_request, null);
});

test('uses only the exact applied ruleset and honors refs and exclusions', () => {
  const result = qualifyReadiness(readyInput({
    branch: 'refs/heads/master',
    ruleset: undefined,
    rulesets: [
      { ...ruleset, id: 1, conditions: { ref_name: { include: ['refs/heads/release/*'] } } },
      { ...ruleset, id: 2, conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/master'] } } },
      { ...ruleset, id: 3, conditions: { ref_name: { include: ['refs/heads/master'] } } },
    ],
  }));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.evidence.applied_rulesets, ['3']);
});

test('does not hide a conflicting publisher in another applied ruleset', () => {
  const conflicting = {
    ...ruleset,
    id: 4,
    rules: [{
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: REQUIRED_CONTEXT, integration_id: 99999 }] },
    }, { type: 'merge_queue' }],
  };
  const result = qualifyReadiness(readyInput({ rulesets: [ruleset, conflicting], ruleset: undefined }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'required_publisher'));
});

test('does not infer default-branch applicability from a caller-selected branch', () => {
  const result = qualifyReadiness(readyInput({ defaultBranch: undefined }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'ruleset' && /no active ruleset applies/u.test(failure.message)));
});

test('uses the latest authoritative check and rejects a newer failure or missing head', () => {
  const result = qualifyReadiness(readyInput({
    checkRuns: [
      ...readyInput().checkRuns,
      { id: 102, name: REQUIRED_CONTEXT, app: { id: REQUIRED_CHECK_APP_ID, slug: REQUIRED_REVIEW_APP_SLUG }, status: 'completed', conclusion: 'failure', head_sha: headSha },
      { id: 103, name: REQUIRED_CONTEXT, app: { id: REQUIRED_CHECK_APP_ID, slug: REQUIRED_REVIEW_APP_SLUG }, status: 'completed', conclusion: 'success', head_sha: undefined },
    ],
  }));
  assert.equal(result.status, 'not_ready');
  assert.ok(result.failures.some((failure) => failure.code === 'required_publisher' && /no exact head SHA/u.test(failure.message)));
});

test('preserves known disabled queue and fails closed on GraphQL partial errors', async () => {
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const disabled = await readGraphqlMergeQueue('exampleorg/dashboard', 'master', 'token', async () => response({
    data: { repository: { mergeQueue: null } },
  }));
  assert.deepEqual(disabled, { state: 'disabled' });
  await assert.rejects(
    readGraphqlMergeQueue('exampleorg/dashboard', 'master', 'token', async () => response({
      data: { repository: { mergeQueue: { id: 'MQ_123' } } },
      errors: [{ message: 'field unavailable' }],
    })),
    /GraphQL merge queue lookup returned errors/u,
  );
  const unknown = qualifyReadiness(readyInput({ mergeQueue: { state: 'unknown' } }));
  assert.ok(unknown.failures.some((failure) => failure.code === 'merge_queue' && /unknown/u.test(failure.message)));
});

test('builds an App JWT for installation metadata without exposing key material', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = buildGithubAppJwt({ appId: '123456', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.equal(jwt.split('.').length, 3);
  assert.match(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.doesNotMatch(jwt, /BEGIN PRIVATE KEY/u);
});

test('reports deployment compatibility as not checked without accepting caller self-attestation', () => {
  const result = qualifyReadiness(readyInput({ deploymentReadback: { compatibility: 'compatible' } }));
  assert.equal(result.status, 'ready');
  assert.equal(result.evidence.deployed_schema_compatibility, 'not_checked');
  assert.equal(result.evidence.dependency_matrix.status, 'unknown');
  assert.deepEqual(result.evidence.runtime_qualification, {
    schema: RUNTIME_QUALIFICATION_SCHEMA,
    ready: false,
    status: 'unknown',
    source: 'readiness-collector-only',
    reason: 'owner-produced deployment readback is not wired into this collector',
    matrix_schema: 'exampleorg.review-yeti-dependency-matrix.v1',
    matrix_status: 'unknown',
  });
});

test('does not require collector-only administration permission on the runtime App', () => {
  const noAdmin = qualifyReadiness(readyInput({
    installation: {
      ...installation,
      permissions: Object.fromEntries(Object.entries(installation.permissions).filter(([name]) => name !== 'administration')),
    },
  }));
  assert.equal(noAdmin.status, 'ready');
});

test('rejects optional or duplicate central verifier action jobs', () => {
  const optional = qualifyReadiness(readyInput({
    mergeGroupWorkflow: readyInput().mergeGroupWorkflow.replace(
      '    name: Publish native Review Yeti merge-group gate',
      '    name: Publish native Review Yeti merge-group gate\n    if: false',
    ),
  }));
  assert.equal(optional.status, 'not_ready');
  assert.ok(optional.failures.some((failure) => failure.code === 'merge_group_qualification'));

  const duplicate = qualifyReadiness(readyInput({
    mergeGroupWorkflow: readyInput().mergeGroupWorkflow.replace(
      'jobs:\n  review:',
      'jobs:\n  extra:\n    name: Optional\n    if: false\n  review:',
    ),
  }));
  assert.equal(duplicate.status, 'not_ready');
  assert.ok(duplicate.failures.some((failure) => failure.code === 'merge_group_qualification'));
});

test('rejects action shims with extra steps, foreign expressions, or action suffixes', () => {
  const actionWorkflow = mergeGroupWorkflow;
  const mutations = [
    actionWorkflow.replace('${{ steps.ry_token.outputs.token }}', '${{ secrets.GITHUB_TOKEN }}'),
    actionWorkflow.replace('${{ github.repository }}', '${{ github.repository }}-suffix'),
    actionWorkflow.replace('${{ github.event.merge_group.base_ref }}', '${{ github.event.merge_group.base_ref || github.ref_name }}'),
    actionWorkflow.replace('          branch:', '      - run: echo fake\n          branch:'),
    actionWorkflow.replace('      - name: Verify', `      - uses: actions/checkout@${'f'.repeat(40)}\n      - name: Verify`),
    actionWorkflow.replace(`@${'c'.repeat(40)}`, `@${'c'.repeat(40)}-suffix`),
    actionWorkflow.replace('        with:', '        env:'),
    actionWorkflow.replace('          repository:', '          review-yeti-token: ${{ github.token }}\n          repository:'),
  ];
  for (const [index, workflow] of mutations.entries()) {
    const result = qualifyReadiness(readyInput({ mergeGroupWorkflow: workflow }));
    assert.equal(result.status, 'not_ready', `mutation ${index}`);
    assert.ok(result.failures.some((failure) => failure.code === 'merge_group_qualification'));
  }
  const directUses = actionWorkflow.replace('      - name: Verify constituents and publish native gate\n        uses:', '      - uses:');
  assert.equal(qualifyReadiness(readyInput({ mergeGroupWorkflow: directUses })).status, 'ready');
});

test('resolves central workflow files at the immutable v1 commit and requires collection pagination metadata', async () => {
  const repository = 'exampleorg/dashboard';
  const centralSha = 'c'.repeat(40);
  const calls = [];
  const headers = new Headers();
  const response = (data, withHeaders = true) => ({
    ok: true,
    status: 200,
    ...(withHeaders ? { headers } : {}),
    json: async () => data,
  });
  const callerRun = {
    id: 12345,
    run_attempt: 2,
    created_at: '2026-09-09T10:00:00Z',
    repository: { full_name: repository },
    event: 'pull_request_target',
    path: '.github/workflows/ct-review-bot.yml',
    head_sha: headSha,
    pull_requests: [{ number: 42 }],
  };
  const centralRun = {
    id: 67890,
    created_at: '2026-09-09T10:01:00Z',
    status: 'completed',
    conclusion: 'success',
    event: 'repository_dispatch',
    path: '.github/workflows/repository-dispatch.yml',
    head_sha: centralSha,
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === 'https://api.github.com/repos/' + repository) return response({ default_branch: 'master' });
    if (value.endsWith('/branches/master')) return response({ commit: { sha: 'd'.repeat(40) } });
    if (value.endsWith('/pulls/42')) return response({
      number: 42,
      state: 'open',
      base: { sha: baseSha, repo: { full_name: repository } },
      head: { sha: headSha, ref: 'feature/readiness' },
    });
    if (value.includes('/contents/')) return response({ encoding: 'base64', content: '' });
    if (value.endsWith('/commits/v1')) return response({ sha: centralSha });
    if (value.includes('/rulesets/1')) return response({ id: 1 });
    if (value.includes('/rulesets?')) return response([{ id: 1 }]);
    if (value.includes('/actions/workflows/') && value.includes('/runs?')) {
      return value.includes('example-review-actions')
        ? response({ total_count: 1, workflow_runs: [centralRun] })
        : response({ total_count: 1, workflow_runs: [callerRun] });
    }
    if (value.includes('/check-runs?')) return response({
      total_count: 2,
      check_runs: [
        { id: 100, name: REQUIRED_CONTEXT, app: { id: REQUIRED_CHECK_APP_ID }, status: 'completed', conclusion: 'success', head_sha: headSha },
        { id: 101, name: 'Review Yeti', app: { slug: REQUIRED_REVIEW_APP_SLUG }, status: 'completed', conclusion: 'success', head_sha: headSha },
      ],
    });
    if (value === 'https://api.github.com/graphql') return response({
      data: { repository: { mergeQueue: { id: 'MQ_123', entries: { nodes: [], pageInfo: { hasNextPage: false } } } } },
    });
    throw new Error('unexpected URL ' + value);
  };
  const input = await collectLiveInput({
    repository,
    branch: 'master',
    prNumber: 42,
    token: 'token',
    fetchImpl,
  });
  assert.equal(input.centralRefSha, centralSha);
  assert.equal(input.branchSha, 'd'.repeat(40));
  assert.ok(calls.some((url) => url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=' + 'd'.repeat(40))));
  assert.ok(calls.some((url) => url.includes('/contents/.github/workflows/review-yeti.yml?ref=' + centralSha)));
  assert.ok(calls.some((url) => url.includes('/contents/.github/workflows/repository-dispatch.yml?ref=' + centralSha)));
  assert.ok(calls.some((url) => url.includes('head_sha=' + headSha)));
  assert.ok(calls.some((url) => new URL(url).searchParams.get('created') === '>=2026-09-09T10:00:00Z'));

  const missingHeaders = async (url, options) => {
    if (String(url).includes('/rulesets?')) return response([], false);
    return fetchImpl(url, options);
  };
  await assert.rejects(
    collectLiveInput({ repository, branch: 'master', prNumber: 42, token: 'token', fetchImpl: missingHeaders }),
    /pagination metadata is unavailable/u,
  );

  const missingLink = async (url, options) => {
    if (String(url).includes('/rulesets?')) {
      return { ...response([{ id: 1 }]), headers: { get: () => null } };
    }
    return fetchImpl(url, options);
  };
  const singlePage = await collectLiveInput({ repository, branch: 'master', prNumber: 42, token: 'token', fetchImpl: missingLink });
  assert.deepEqual(singlePage.rulesets, [{ id: 1 }]);

  const missingCount = async (url, options) => {
    if (String(url).includes('/rulesets?')) return response({ rulesets: [] });
    return fetchImpl(url, options);
  };
  await assert.rejects(
    collectLiveInput({ repository, branch: 'master', prNumber: 42, token: 'token', fetchImpl: missingCount }),
    /pagination metadata is unavailable/u,
  );
});

function pagedResponse(body, link = null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'link' ? link : null },
    json: async () => body,
  };
}

test('accepts array-shaped rulesets, bounds pagination, and rejects duplicate identities', async () => {
  const first = 'https://api.github.com/repos/exampleorg/dashboard/rulesets?per_page=100&page=1';
  const second = 'https://api.github.com/repos/exampleorg/dashboard/rulesets?per_page=100&page=2';
  const calls = [];
  const result = await githubCollection(first, 'token', async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url) === first
      ? pagedResponse([{ id: 1 }], `<${second}>; rel="next"`)
      : pagedResponse([{ id: 2 }]);
  }, 'rulesets', 'repository rulesets', 3, { allowArrayResponse: true });
  assert.deepEqual(result.values.map((value) => value.id), [1, 2]);
  assert.equal(result.pages, 2);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);

  await assert.rejects(
    githubCollection(first, 'token', async (url) => String(url) === first
      ? pagedResponse([{ id: 1 }], `<${second}>; rel="next"`)
      : pagedResponse([{ id: 1 }]), 'rulesets', 'repository rulesets', 3, { allowArrayResponse: true }),
    /duplicate or malformed item identities/u,
  );
});

test('fails closed on truncated/count-drifting collections and untrusted pagination links', async () => {
  const url = 'https://api.github.com/repos/exampleorg/dashboard/actions/workflows/x/runs?per_page=100';
  await assert.rejects(
    githubCollection(url, 'token', async () => pagedResponse({ total_count: 101, workflow_runs: [{ id: 1 }] }), 'workflow_runs', 'workflow runs', 3),
    /incomplete or inconsistent/u,
  );
  const second = 'https://api.github.com/repos/exampleorg/dashboard/actions/workflows/x/runs?per_page=100&page=2';
  await assert.rejects(
    githubCollection(url, 'token', async (next) => String(next).includes('page=2')
      ? pagedResponse({ total_count: 3, workflow_runs: [{ id: 2 }] })
      : pagedResponse({ total_count: 2, workflow_runs: [{ id: 1 }] }, `<${second}>; rel="next"`), 'workflow_runs', 'workflow runs', 3),
    /total count changed/u,
  );
  await assert.rejects(
    githubCollection(url, 'token', async () => pagedResponse({ total_count: 0, workflow_runs: [] }, '<https://evil.example/repos/exampleorg/dashboard?page=2>; rel="next"'), 'workflow_runs', 'workflow runs', 3),
    /outside the GitHub API origin/u,
  );
  for (const next of [
    second.replace('/dashboard/', '/other/'),
    `${second}&head_sha=${headSha}`,
  ]) {
    let requests = 0;
    await assert.rejects(githubCollection(url, 'token', async () => {
      requests += 1;
      return pagedResponse({ total_count: 2, workflow_runs: [{ id: 1 }] }, `<${next}>; rel="next"`);
    }, 'workflow_runs', 'workflow runs', 3), /changed the collection identity/u);
    assert.equal(requests, 1, 'must reject a changed collection before another authenticated request');
  }
});

test('does not perform collection work before repository admission', async () => {
  let fetches = 0;
  await assert.rejects(
    collectLiveInput({ repository: 'evil.example/dashboard', token: 'token', fetchImpl: async () => { fetches += 1; return pagedResponse({}); } }),
    /repository must be a exampleorg/u,
  );
  assert.equal(fetches, 0);
});
