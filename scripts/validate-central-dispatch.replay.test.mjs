import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { validateCentralDispatch } from './validate-central-dispatch.mjs';

// REL-512: the central-dispatch validator was shipped as a required check without ever being
// exercised by a real dispatch (2026-09-02 outage). Three separate rounds of guessing the shape
// of GitHub's actions/runs and pulls API responses broke it in three different ways (#193 caller
// permissions / startup_failure, #194-#196 run.head_sha/head_branch binding, #199 reading the
// caller workflow from pull.base.ref instead of the repository default branch). This file replays
// RECORDED REAL API objects -- not synthetic fixtures like validate-central-dispatch.test.mjs uses
// -- so the run-object shape can't be guessed again. See test/fixtures/central-dispatch/README.md
// for exactly what was captured live via `gh api`, what is byte-exact, and what is reconstructed
// (and why).

const fixturesDir = fileURLToPath(new URL('../test/fixtures/central-dispatch/', import.meta.url));

function loadFixtureJson(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

const callerWorkflowContent = readFileSync(
  path.join(fixturesDir, 'ct-review-bot-0.8.7-stable.yml'),
  'utf8',
);

function contentsResponse(content) {
  return response({ encoding: 'base64', content: Buffer.from(content).toString('base64') });
}

function response(payloadValue, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payloadValue,
  };
}

const CASES = [
  {
    name: 'example-api-4820',
    repository: 'exampleorg/example-api',
    prNumber: 4820,
    runFile: 'example-api-4820-run-33668880961.json',
    pullFile: 'example-api-4820-pull.json',
  },
  {
    name: 'example-api-4804',
    repository: 'exampleorg/example-api',
    prNumber: 4804,
    runFile: 'example-api-4804-run-33675866048.json',
    pullFile: 'example-api-4804-pull.json',
  },
];

/**
 * Builds a fetchImpl that serves the recorded pull, run, and caller-workflow-contents responses,
 * plus a generation-ledger mock for the newly required exact-head check-runs read. `runOverride`
 * lets a test replay a
 * mutated or byte-exact-as-captured run object without touching the fixture file itself.
 */
function fetchImplFor({ pull, run, apiBase, defaultBranchRef }, runOverride = run, checkRuns = null) {
  return async (url) => {
    if (url === `${apiBase}/pulls/${pull.number}`) return response(pull);
    if (url === `${apiBase}/actions/runs/${run.id}`) return response(runOverride);
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) {
      // Capacity is a fail-closed prerequisite. This replay models an idle
      // central lane so generation/identity assertions remain the subject of
      // the fixture; pagination movement is documented as a pre-existing race
      // retired by direct service-owned admission.
      return response({ workflow_runs: [] });
    }
    if (url.startsWith(`${apiBase}/commits/${run.head_sha}/check-runs?`)) {
      const query = new URL(url).searchParams;
      assert.equal(query.get('check_name'), 'Review Yeti');
      assert.equal(query.get('filter'), 'all');
      assert.equal(query.get('app_id'), '4385771');
      assert.equal(query.get('per_page'), '100');
      assert.equal(query.get('page'), '1');
      const defaultCheckRuns = [{
          id: 8675309,
          name: 'Review Yeti',
          head_sha: runOverride.head_sha,
          status: 'completed',
          conclusion: 'failure',
          external_id: `run_${'1'.repeat(32)}:a1`,
          app: { id: 4385771, slug: 'ct-review-bot' },
          output: { title: 'Review Yeti: review did not complete', summary: 'Replay-only generation state.', text: null },
        }];
      const ledger = checkRuns ?? defaultCheckRuns;
      return response({
        total_count: ledger.length,
        check_runs: ledger,
      });
    }
    if (url.startsWith(`${apiBase}/contents/.github/workflows/ct-review-bot.yml?ref=`)) {
      const requestedRef = decodeURIComponent(url.split('ref=')[1]);
      assert.equal(requestedRef, defaultBranchRef, 'validateCentralDispatch must read the caller workflow from the repository default branch, not pull.base.ref');
      return contentsResponse(callerWorkflowContent);
    }
    throw new Error(`unexpected URL in replay fixture: ${url}`);
  };
}

function buildFixtureContext({ repository, prNumber, runFile, pullFile }) {
  const run = loadFixtureJson(runFile);
  const pull = loadFixtureJson(pullFile);
  const apiBase = `https://api.github.com/repos/${repository}`;
  // The recorded run's own pull_requests field is empty (see README.md -- GitHub stops
  // populating it once the PR closes). Restore what it held while the PR was open: the single
  // PR this run reviewed. This is the same PR identity the fixture's own filename and payload
  // assert, not a fabricated value.
  const runWithOpenPullRequest = { ...run, pull_requests: [{ number: prNumber }] };
  const payload = Object.freeze({
    request_id: `${repository.split('/')[1]}:${prNumber}:${run.head_sha}:${run.id}:${run.run_attempt}`,
    repository,
    pr_number: prNumber,
    base_sha: pull.base.sha,
    head_sha: run.head_sha,
  });
  return {
    run,
    runWithOpenPullRequest,
    pull,
    apiBase,
    payload,
    defaultBranchRef: pull.base.repo.default_branch,
  };
}

for (const testCase of CASES) {
  test(`replays the recorded ${testCase.name} run + PR through immutable identity validation`, async () => {
    const ctx = buildFixtureContext(testCase);
    if (ctx.run.run_attempt > 2) {
      await assert.rejects(
        validateCentralDispatch({
          payload: ctx.payload,
          token: 'replay-token',
          fetchImpl: fetchImplFor(ctx, ctx.runWithOpenPullRequest),
        }),
        /outside the admitted generations/u,
      );
    } else {
      const result = await validateCentralDispatch({
        payload: ctx.payload,
        token: 'replay-token',
        fetchImpl: fetchImplFor(ctx, ctx.runWithOpenPullRequest),
      });
      assert.equal(result.repository, testCase.repository);
      assert.equal(result.pr_number, testCase.prNumber);
      assert.equal(result.head_sha, ctx.run.head_sha);
      assert.equal(result.caller_run_id, ctx.run.id);
      assert.equal(result.caller_run_attempt, ctx.run.run_attempt);
      assert.equal(result.review_generation, 2);
      assert.match(result.caller_workflow_sha256, /^[0-9a-f]{64}$/u);
    }
  });

  test(`${testCase.name}: rejects when replayed with a mutated head_sha`, async () => {
    const ctx = buildFixtureContext(testCase);
    const mutatedRun = { ...ctx.runWithOpenPullRequest, head_sha: 'c'.repeat(40) };
    await assert.rejects(
      validateCentralDispatch({
        payload: ctx.payload,
        token: 'replay-token',
        fetchImpl: fetchImplFor(ctx, mutatedRun),
      }),
      /caller run is not bound to the requested PR head/,
    );
  });

  test(`${testCase.name}: rejects when replayed with a mutated head_branch`, async () => {
    const ctx = buildFixtureContext(testCase);
    const mutatedRun = { ...ctx.runWithOpenPullRequest, head_branch: 'someone-elses-branch' };
    await assert.rejects(
      validateCentralDispatch({
        payload: ctx.payload,
        token: 'replay-token',
        fetchImpl: fetchImplFor(ctx, mutatedRun),
      }),
      /caller run is not bound to the PR source branch/,
    );
  });

  test(`${testCase.name}: rejects the run object exactly as GitHub returns it today (pull_requests emptied by PR closure)`, async () => {
    // Regression coverage for the quirk documented in README.md: once a PR closes, GitHub's
    // actions/runs API stops populating pull_requests, even for a run that validated
    // successfully in production while the PR was open. A byte-exact replay of the fixture
    // file (not the pull_requests-restored variant every other case in this file uses) proves
    // the validator's real, verified behavior on that exact input -- not a hypothetical.
    const ctx = buildFixtureContext(testCase);
    assert.deepEqual(ctx.run.pull_requests, [], 'fixture must be the live-captured run object with pull_requests emptied by PR closure, or this test is not exercising the quirk it documents');
    await assert.rejects(
      validateCentralDispatch({
        payload: ctx.payload,
        token: 'replay-token',
        fetchImpl: fetchImplFor(ctx, ctx.run),
      }),
      /caller run is not bound to the requested PR/,
    );
  });
}

test('example-api-4804: the caller workflow is read from the repository default branch (0.8.7-stable), not the PR base branch (0.8.8-stable) -- the exact #199 divergence this fixture records', async () => {
  const ctx = buildFixtureContext(CASES.find((c) => c.name === 'example-api-4804'));
  assert.equal(ctx.pull.base.ref, '0.8.8-stable');
  assert.equal(ctx.defaultBranchRef, '0.8.7-stable');
  assert.notEqual(ctx.pull.base.ref, ctx.defaultBranchRef);

  const result = await validateCentralDispatch({
    payload: ctx.payload,
    token: 'replay-token',
    fetchImpl: fetchImplFor(ctx, ctx.runWithOpenPullRequest),
  });
  assert.match(result.caller_workflow_sha256, /^[0-9a-f]{64}$/u);
});

test('recorded example-api request rejects an a3 replay whose prior workers have mixed DOKS run identities', async () => {
  const ctx = buildFixtureContext(CASES.find((c) => c.name === 'example-api-4804'));
  const run = { ...ctx.runWithOpenPullRequest, run_attempt: 3 };
  const payload = {
    ...ctx.payload,
    request_id: `example-api:${ctx.pull.number}:${run.head_sha}:${run.id}:3`,
  };
  const check = (id, attempt, runId) => ({
    id,
    name: 'Review Yeti',
    head_sha: run.head_sha,
    status: 'completed',
    conclusion: 'failure',
    external_id: `run_${runId}:a${attempt}`,
    app: { id: 4385771, slug: 'ct-review-bot' },
    output: { title: 'Review Yeti: review did not complete', summary: 'Replay-only generation state.', text: null },
  });

  await assert.rejects(
    validateCentralDispatch({
      payload,
      token: 'replay-token',
      fetchImpl: fetchImplFor(ctx, run, [
        check(8675310, 1, '1'.repeat(32)),
        check(8675311, 2, '2'.repeat(32)),
      ]),
    }),
    /prior worker generations must share one DOKS run identity/u,
  );
});
