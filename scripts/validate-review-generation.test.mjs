import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPATCH_EVENT_TYPE,
  REQUIRED_REVIEW_APP_ID,
  REQUIRED_REVIEW_CONTEXT,
  TARGET_REPOSITORY,
  validateCentralDispatch,
} from './validate-central-dispatch.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const callerWorkflow = `
name: Review Yeti dispatch
on: pull_request_target
jobs:
  dispatch:
    steps:
      - run: gh api repos/exampleorg/example-review-actions/dispatches -f event_type=${DISPATCH_EVENT_TYPE}
`;

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function payloadFor(attempt, runId = 9000 + attempt) {
  return {
    request_id: `example-api:42:${headSha}:${runId}:${attempt}`,
    repository: TARGET_REPOSITORY,
    pr_number: 42,
    base_sha: baseSha,
    head_sha: headSha,
  };
}

function workerCheck({
  id = 100,
  attempt = 1,
  status = 'completed',
  conclusion = 'failure',
  title = 'Review Yeti: review did not complete',
  externalId = `run_${'1'.repeat(32)}:a${attempt}`,
} = {}) {
  return {
    id,
    name: REQUIRED_REVIEW_CONTEXT,
    head_sha: headSha,
    status,
    conclusion,
    external_id: externalId,
    app: { id: REQUIRED_REVIEW_APP_ID, slug: 'ct-review-bot' },
    output: { title, summary: 'generation reservation fixture', text: null },
  };
}

function mergeGroupCheck(id = 99, externalHeadSha = headSha) {
  return workerCheck({
    id,
    status: 'completed',
    conclusion: 'success',
    title: 'Review Yeti merge group approved',
    externalId: `merge-group:${externalHeadSha}`,
  });
}

function page(checkRuns, totalCount = checkRuns.length) {
  return { total_count: totalCount, check_runs: checkRuns };
}

function generationFetch({ attempt, checkPages, calls = [] }) {
  const runId = 9000 + attempt;
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/pulls/42')) {
      return response({
        state: 'open',
        base: { sha: baseSha, repo: { full_name: TARGET_REPOSITORY, default_branch: '0.8.7-stable' } },
        head: { sha: headSha, ref: 'fix/generation-reservation' },
      });
    }
    if (url.endsWith(`/actions/runs/${runId}`)) {
      return response({
        repository: { full_name: TARGET_REPOSITORY },
        event: 'pull_request_target',
        path: '.github/workflows/ct-review-bot.yml',
        head_sha: headSha,
        head_branch: 'fix/generation-reservation',
        run_attempt: attempt,
        pull_requests: [{ number: 42 }],
      });
    }
    if (url.includes('/actions/workflows/repository-dispatch.yml/runs')) {
      return response({ workflow_runs: [] });
    }
    if (url.includes(`/commits/${headSha}/check-runs?`)) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('check_name'), REQUIRED_REVIEW_CONTEXT);
      assert.equal(parsed.searchParams.get('filter'), 'all');
      assert.equal(parsed.searchParams.get('app_id'), String(REQUIRED_REVIEW_APP_ID));
      assert.equal(parsed.searchParams.get('per_page'), '100');
      const pageNumber = Number(parsed.searchParams.get('page'));
      return response(checkPages[pageNumber - 1] ?? page([], checkPages[0]?.total_count ?? 0));
    }
    if (url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=')) {
      return response({ encoding: 'base64', content: Buffer.from(callerWorkflow).toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

async function validate({ attempt, pages, calls = [], refreshRequested = false }) {
  return validateCentralDispatch({
    payload: { ...payloadFor(attempt), ...(refreshRequested ? { refresh_requested: true } : {}) },
    token: 'central-app-token',
    fetchImpl: generationFetch({ attempt, checkPages: pages, calls }),
  });
}

test('attempt 1 admits only when no worker generation exists', async () => {
  const calls = [];
  const result = await validate({ attempt: 1, pages: [page([])], calls });
  assert.equal(result.review_generation, 1);
  assert.equal(result.worker_check_count, 0);
  const checkCall = calls.find((call) => call.url.includes('/check-runs?'));
  assert.ok(checkCall, 'central validation must query the exact-head raw Review Yeti checks');

  await assert.rejects(
    validate({ attempt: 1, pages: [page([workerCheck()])] }),
    /attempt 1 requires zero worker checks/u,
  );
});

test('explicit refresh admits a persisted retry from caller attempt 1 after a recoverable a1', async () => {
  const result = await validate({ attempt: 1, refreshRequested: true, pages: [page([workerCheck()])] });
  assert.equal(result.review_generation, 2);
  assert.equal(result.worker_check_count, 1);
  assert.equal(result.latest_worker_check_id, 100);
  assert.equal(result.refresh_requested, true);
  assert.equal(result.retry_after_execution_attempt, 1);
});

test('explicit refresh still requires the authoritative recoverable a1 ledger', async () => {
  await assert.rejects(
    validate({ attempt: 1, refreshRequested: true, pages: [page([])] }),
    /refresh requires exactly one worker a1; found 0 worker checks/u,
  );
  await assert.rejects(
    validate({ attempt: 1, refreshRequested: true, pages: [page([workerCheck({ title: 'Review Yeti: SHIP' })])] }),
    /refresh a1 worker is not a completed recoverable infrastructure failure/u,
  );
});

test('merge-group attestations require the exact head without consuming a worker generation', async () => {
  const result = await validate({ attempt: 1, pages: [page([mergeGroupCheck()])] });
  assert.equal(result.review_generation, 1);
  assert.equal(result.worker_check_count, 0);

  await assert.rejects(
    validate({ attempt: 1, pages: [page([mergeGroupCheck(99, 'c'.repeat(40))])] }),
    /merge-group external_id is not bound to the exact requested head/u,
  );
});

test('attempt 2 admits exactly one replacement after an infrastructure-failed a1', async () => {
  for (const title of [
    'Review Yeti: review did not complete',
    'Review Yeti: NO VERDICT (no panel result for this head)',
  ]) {
    const result = await validate({ attempt: 2, pages: [page([workerCheck({ title })])] });
    assert.equal(result.review_generation, 2);
    assert.equal(result.worker_check_count, 1);
    assert.equal(result.latest_worker_check_id, 100);
  }
});

test('attempt 2 rejects terminal review verdicts and inconsistent infrastructure markers', async () => {
  const cases = [
    workerCheck({ title: 'Review Yeti: BLOCK' }),
    workerCheck({ title: 'Review Yeti: FIX_FIRST' }),
    workerCheck({ title: 'Review Yeti: review did not complete', conclusion: 'cancelled' }),
    workerCheck({ title: 'Review Yeti: review did not complete', conclusion: 'timed_out' }),
    workerCheck({ title: 'Review Yeti: NO VERDICT (no panel result for this head)', conclusion: 'neutral' }),
    workerCheck({ title: 'Review Yeti: NO VERDICT (no panel result for this head)', status: 'in_progress', conclusion: null }),
  ];
  for (const run of cases) {
    await assert.rejects(
      validate({ attempt: 2, pages: [page([run])] }),
      /a1 worker is not a completed recoverable infrastructure failure/u,
    );
  }
});

test('serialized duplicate attempt-2 revalidation admits once and rejects after a2 appears', async () => {
  const first = await validate({ attempt: 2, pages: [page([workerCheck({ id: 100 })])] });
  assert.equal(first.review_generation, 2);

  await assert.rejects(
    validate({
      attempt: 2,
      pages: [page([
        workerCheck({ id: 100 }),
        workerCheck({ id: 101, attempt: 2, status: 'in_progress', conclusion: null, title: 'Review Yeti: in progress' }),
      ])],
    }),
    /worker attempt a2 already exists/u,
  );
});

test('attempt 2 rejects every ledger containing multiple a1 workers', async () => {
  const ledgers = [
    [workerCheck({ id: 9 }), workerCheck({ id: 10 })],
    [workerCheck({ id: 9, title: 'Review Yeti: BLOCK' }), workerCheck({ id: 10 })],
    [workerCheck({ id: 9 }), workerCheck({ id: 10, status: 'in_progress', conclusion: null, title: 'Review Yeti: in progress' })],
  ];
  for (const runs of ledgers) {
    await assert.rejects(
      validate({ attempt: 2, pages: [page(runs)] }),
      /attempt 2 requires exactly one worker a1; found 2 worker checks/u,
    );
  }
});

test('attempt 2 rejects zero checks, active a1, terminal a1, and a2-or-later', async () => {
  const cases = [
    { runs: [], pattern: /requires exactly one worker a1; found 0 worker checks/u },
    { runs: [workerCheck({ status: 'in_progress', conclusion: null, title: 'Review Yeti: in progress' })], pattern: /a1 worker is not a completed recoverable infrastructure failure/u },
    { runs: [workerCheck({ conclusion: 'success', title: 'Review Yeti: SHIP' })], pattern: /a1 worker is not a completed recoverable infrastructure failure/u },
    { runs: [workerCheck({ conclusion: 'neutral', title: 'Review Yeti: PASSTHROUGH' })], pattern: /a1 worker is not a completed recoverable infrastructure failure/u },
    { runs: [workerCheck({ conclusion: 'skipped', title: 'Review Yeti: PASSTHROUGH' })], pattern: /a1 worker is not a completed recoverable infrastructure failure/u },
    { runs: [workerCheck({ conclusion: 'failure', title: 'Review Yeti: SHIP' })], pattern: /a1 worker is not a completed recoverable infrastructure failure/u },
    { runs: [workerCheck({ id: 101, attempt: 2 })], pattern: /worker attempt a2 already exists/u },
    { runs: [workerCheck({ id: 101, attempt: 3 })], pattern: /worker attempt a3 already exists/u },
    { runs: [workerCheck({ id: 99, attempt: 2 }), workerCheck({ id: 100 })], pattern: /worker attempt a2 already exists/u },
  ];
  for (const fixture of cases) {
    await assert.rejects(validate({ attempt: 2, pages: [page(fixture.runs)] }), fixture.pattern);
  }
});

test('attempt 3 admits one governed same-head rerequest after two infrastructure failures', async () => {
  const result = await validate({
    attempt: 3,
    pages: [page([
      workerCheck({ id: 100, attempt: 1 }),
      workerCheck({ id: 101, attempt: 2 }),
    ])],
  });
  assert.equal(result.review_generation, 3);
  assert.equal(result.worker_check_count, 2);
  assert.equal(result.latest_worker_check_id, 101);
});

test('attempt 3 rejects prior worker generations from different DOKS run identities', async () => {
  await assert.rejects(
    validate({
      attempt: 3,
      pages: [page([
        workerCheck({ id: 100, attempt: 1, externalId: `run_${'1'.repeat(32)}:a1` }),
        workerCheck({ id: 101, attempt: 2, externalId: `run_${'2'.repeat(32)}:a2` }),
      ])],
    }),
    /prior worker generations must share one DOKS run identity/u,
  );
});

test('attempt 3 rejects gaps, duplicate generations, active workers, and terminal verdicts', async () => {
  const cases = [
    {
      runs: [workerCheck({ id: 100, attempt: 1 })],
      pattern: /attempt 3 requires exactly 2 prior worker checks; found 1/u,
    },
    {
      runs: [workerCheck({ id: 100, attempt: 1 }), workerCheck({ id: 101, attempt: 1 })],
      pattern: /requires exactly one worker a1; found 2/u,
    },
    {
      runs: [workerCheck({ id: 100, attempt: 1 }), workerCheck({ id: 101, attempt: 2, status: 'in_progress', conclusion: null, title: 'Review Yeti: in progress' })],
      pattern: /a2 worker is not a completed recoverable infrastructure failure/u,
    },
    {
      runs: [workerCheck({ id: 100, attempt: 1 }), workerCheck({ id: 101, attempt: 2, conclusion: 'success', title: 'Review Yeti: SHIP' })],
      pattern: /a2 worker is not a completed recoverable infrastructure failure/u,
    },
    {
      runs: [workerCheck({ id: 100, attempt: 1 }), workerCheck({ id: 101, attempt: 3 })],
      pattern: /worker attempt a3 already exists/u,
    },
  ];
  for (const fixture of cases) {
    await assert.rejects(validate({ attempt: 3, pages: [page(fixture.runs)] }), fixture.pattern);
  }
});

test('caller attempts beyond the bounded recovery generations fail closed', async () => {
  await assert.rejects(
    validate({
      attempt: 4,
      pages: [page([
        workerCheck({ id: 100, attempt: 1 }),
        workerCheck({ id: 101, attempt: 2 }),
        workerCheck({ id: 102, attempt: 3 }),
      ])],
    }),
    /caller run attempt 4 is outside the admitted generations/u,
  );
});

test('malformed official and unknown external identities fail closed', async () => {
  for (const externalId of [null, '', 'run_short:a1', `run_${'1'.repeat(32)}:a0`, `run_${'1'.repeat(32)}:a01`, `merge-group:${'z'.repeat(40)}`, 'operator:manual']) {
    await assert.rejects(
      validate({ attempt: 1, pages: [page([workerCheck({ externalId })])] }),
      /external_id/u,
    );
  }
});

test('every returned row must be a complete exact-identity check object', async () => {
  const invalidRows = [
    null,
    {},
    { ...workerCheck(), id: 0 },
    { ...workerCheck(), id: Number.MAX_SAFE_INTEGER + 1 },
    { ...workerCheck(), name: 'Review Yeti Gate' },
    { ...workerCheck(), head_sha: 'c'.repeat(40) },
    { ...workerCheck(), app: { id: 1, slug: 'ct-review-bot' } },
    { ...workerCheck(), app: { id: REQUIRED_REVIEW_APP_ID, slug: 'other' } },
    { ...workerCheck(), status: 'mystery' },
    { ...workerCheck(), status: 'completed', conclusion: null },
    { ...workerCheck(), status: 'in_progress', conclusion: 'failure' },
    { ...workerCheck(), output: null },
    { ...workerCheck(), output: { title: 4, summary: 'x', text: null } },
    { ...workerCheck(), output: { title: 'x', summary: {}, text: null } },
  ];
  for (const row of invalidRows) {
    await assert.rejects(validate({ attempt: 1, pages: [page([row])] }));
  }
});

test('pagination rejects duplicate IDs, truncation, changing totals, and endpoint-cap overflow', async () => {
  const hundredMergeChecks = Array.from({ length: 100 }, (_, index) => mergeGroupCheck(index + 1));
  const duplicateAcrossPages = [
    page(hundredMergeChecks, 101),
    page([mergeGroupCheck(100)], 101),
  ];
  await assert.rejects(validate({ attempt: 1, pages: duplicateAcrossPages }), /duplicate check-run id 100/u);

  await assert.rejects(
    validate({ attempt: 1, pages: [page(hundredMergeChecks, 101), page([], 101)] }),
    /truncated/u,
  );
  await assert.rejects(
    validate({ attempt: 1, pages: [page(hundredMergeChecks, 101), page([mergeGroupCheck(101)], 102)] }),
    /total_count changed/u,
  );
  await assert.rejects(validate({ attempt: 1, pages: [page([], 1001)] }), /reaches or exceeds the 1000-run endpoint cap/u);
  await assert.rejects(validate({ attempt: 1, pages: [{ total_count: 0, check_runs: {} }] }), /check_runs must be an array/u);
  await assert.rejects(validate({ attempt: 1, pages: [{ total_count: -1, check_runs: [] }] }), /total_count/u);
});

test('pagination rejects an exact 1000-row inventory as endpoint-cap ambiguous', async () => {
  const exactCapPages = Array.from({ length: 10 }, (_, pageIndex) => page(
    Array.from({ length: 100 }, (_, rowIndex) => mergeGroupCheck((pageIndex * 100) + rowIndex + 1)),
    1000,
  ));
  await assert.rejects(
    validate({ attempt: 1, pages: exactCapPages }),
    /reaches or exceeds the 1000-run endpoint cap/u,
  );
});

test('pagination accepts a complete multi-page inventory and reconciles the flattened count', async () => {
  const first = Array.from({ length: 100 }, (_, index) => mergeGroupCheck(index + 1));
  const result = await validate({
    attempt: 1,
    pages: [page(first, 101), page([mergeGroupCheck(101)], 101)],
  });
  assert.equal(result.worker_check_count, 0);
  assert.equal(result.review_check_count, 101);
});
