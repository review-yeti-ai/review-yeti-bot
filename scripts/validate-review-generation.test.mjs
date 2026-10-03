import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCH_EVENT_TYPE,
  REQUIRED_REVIEW_APP_ID,
  REQUIRED_REVIEW_CONTEXT,
  TARGET_REPOSITORY,
  assertReviewGeneration,
  validateCentralDispatch,
  writeOutputs,
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
  summary = 'generation reservation fixture',
  startedAt = '2026-09-24T18:28:55Z',
  completedAt = '2026-09-24T18:28:56Z',
} = {}) {
  return {
    id,
    name: REQUIRED_REVIEW_CONTEXT,
    head_sha: headSha,
    status,
    conclusion,
    started_at: startedAt,
    completed_at: completedAt,
    external_id: externalId,
    app: { id: REQUIRED_REVIEW_APP_ID, slug: 'ct-review-bot' },
    output: { title, summary, text: null },
  };
}

const infrastructurePanelSummary = `Verdict \`BLOCK\` at \`${headSha}\`.\n\nFindings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).\n\nCoverage: mode=panel; expected lanes=2; completed lanes=1; failed lanes=1; roster valid=true; quorum satisfied=false; full panel complete=false.\n\nTransport: bifrost \`pr-reviewer\`.`;

function infrastructurePanelCheck(overrides = {}) {
  return workerCheck({
    id: 101,
    attempt: 2,
    title: 'Review Yeti: BLOCK',
    summary: infrastructurePanelSummary,
    ...overrides,
  });
}

function infrastructureGateCheck(overrides = {}) {
  return {
    id: 102,
    name: 'Review Yeti Gate',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    completed_at: '2026-09-24T18:28:57Z',
    external_id: `review-yeti-gate:v1:${'2'.repeat(64)}`,
    app: { id: REQUIRED_REVIEW_APP_ID, slug: 'ct-review-bot' },
    output: {
      title: 'Review Yeti Gate: Failed',
      summary: 'Review Yeti Gate failed: infrastructure-failure. This is not an approval.',
      text: null,
    },
    ...overrides,
  };
}

function incompleteRosterSummary(expected, completed, engine = 'panel') {
  const coverage = engine === 'composed'
    ? `engine=composed; planned tasks=${expected}; expected tasks=${expected}; completed tasks=${completed}; failed tasks=0; roster valid=false; quorum satisfied=false; task coverage complete=false.`
    : `mode=panel; expected lanes=${expected}; completed lanes=${completed}; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.`;
  return `Verdict \`BLOCK\` at \`${headSha}\`.\n\nFindings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).\n\nCoverage: ${coverage}\n\nUnreported lanes (not on the published roster):\n- \`audit-tests\` \`malformed_output\`: Task ran and produced no verdict\n\nTransport: bifrost \`pr-reviewer\`.`;
}

function incompleteP2CandidateSummary(expected, completed, engine = 'panel', canonicalCount = 2, rawCount = 3) {
  return incompleteRosterSummary(expected, completed, engine).replace(
    'Findings: 0 (blocking P0/P1: 0; 0 raw persona finding(s) before clustering).',
    `Findings: ${canonicalCount} (blocking P0/P1: 0; ${rawCount} raw persona finding(s) before clustering).`,
  );
}

function incompleteRosterGateCheck(expected, completed, overrides = {}) {
  return infrastructureGateCheck({
    output: {
      title: 'Review Yeti Gate: Failed (incomplete panel)',
      summary: `Review Yeti Gate failed: the panel expected ${expected} review lane(s) but ${completed} completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.`,
      text: null,
    },
    ...overrides,
  });
}

function historicalGateCheck(overrides = {}) {
  return infrastructureGateCheck({
    id: 98,
    conclusion: 'cancelled',
    completed_at: '2026-09-24T18:23:39Z',
    external_id: `review-yeti-gate:v1:${'3'.repeat(64)}`,
    output: {
      title: 'Review Yeti Gate: Failed',
      summary: 'Review Yeti Gate failed: invalid-evidence. This is not an approval.',
      text: null,
    },
    ...overrides,
  });
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

function generationFetch({ attempt, checkPages, gatePages = [page([])], calls = [], manual = false }) {
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
    if (manual && url.endsWith(`/repos/exampleorg/example-review-actions/actions/runs/${runId}`)) {
      return response({
        repository: { full_name: 'exampleorg/example-review-actions' },
        event: 'workflow_dispatch',
        path: '.github/workflows/repository-dispatch.yml',
        head_sha: baseSha,
        run_attempt: attempt,
        status: 'in_progress',
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
      const checkName = parsed.searchParams.get('check_name');
      assert.ok([REQUIRED_REVIEW_CONTEXT, 'Review Yeti Gate'].includes(checkName));
      assert.equal(parsed.searchParams.get('filter'), 'all');
      assert.equal(parsed.searchParams.get('app_id'), String(REQUIRED_REVIEW_APP_ID));
      assert.equal(parsed.searchParams.get('per_page'), '100');
      const pageNumber = Number(parsed.searchParams.get('page'));
      const selectedPages = checkName === 'Review Yeti Gate' ? gatePages : checkPages;
      return response(selectedPages[pageNumber - 1] ?? page([], selectedPages[0]?.total_count ?? 0));
    }
    if (url.includes('/contents/.github/workflows/ct-review-bot.yml?ref=')) {
      return response({ encoding: 'base64', content: Buffer.from(callerWorkflow).toString('base64') });
    }
    if (manual && url.includes('/repos/exampleorg/example-review-actions/contents/.github/workflows/repository-dispatch.yml?ref=')) {
      return response({ encoding: 'base64', content: Buffer.from('name: Central Review Yeti Dispatch').toString('base64') });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

async function validate({ attempt, pages, gatePages, calls = [], refreshRequested = false, manual = false }) {
  return validateCentralDispatch({
    payload: { ...payloadFor(attempt), ...(refreshRequested ? { refresh_requested: true } : {}) },
    token: 'central-app-token',
    fetchImpl: generationFetch({ attempt, checkPages: pages, gatePages, calls, manual }),
    ...(manual ? { eventName: 'workflow_dispatch', executionRunId: 9000 + attempt, executionRunAttempt: attempt } : {}),
  });
}

test('attempt 1 admits only when no worker generation exists', async () => {
  const calls = [];
  const result = await validate({ attempt: 1, pages: [page([])], calls });
  assert.equal(result.review_generation, 1);
  assert.equal(result.refresh_execution_attempt, 0);
  assert.equal(result.worker_check_count, 0);
  const checkCall = calls.find((call) => call.url.includes('/check-runs?'));
  assert.ok(checkCall, 'central validation must query the exact-head raw Review Yeti checks');

  await assert.rejects(
    validate({ attempt: 1, pages: [page([workerCheck()])] }),
    /attempt 1 requires zero worker checks/u,
  );
});

test('explicit refresh admits a persisted retry after a provider-429 INCOMPLETE-infrastructure a1 (REL-1113 / #1320)', async () => {
  const result = await validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([workerCheck({
      title: 'Review Yeti: INCOMPLETE — infrastructure (automatic retry NOT CONFIRMED; lane panel failed: 429)',
    })])],
  });
  assert.equal(result.review_generation, 2);
  assert.equal(result.refresh_execution_attempt, 1);
  assert.equal(result.worker_check_count, 1);
  assert.equal(result.latest_worker_check_id, 100);
  assert.equal(result.refresh_requested, true);
});

test('explicit refresh admits the REL-1113 lane-failure and retry-suffixed title forms', async () => {
  for (const title of [
    'Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502)',
    'Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502); retrying as attempt 2 of 3',
    'Review Yeti: INCOMPLETE — infrastructure (lanes arch-lane 502, sec-lane 429 failed)',
  ]) {
    const result = await validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page([workerCheck({ title })])],
    });
    assert.equal(result.review_generation, 2, `title should be recoverable: ${title}`);
  }
});

test('the INCOMPLETE-infrastructure family does NOT admit a verdict, a malformed title, or an oversized detail', async () => {
  const notRecoverable = [
    // A real verdict must never become refresheable by this rule.
    'Review Yeti: BLOCK',
    'Review Yeti: SHIP',
    // The legacy fixed titles are still handled by the set, but an unrelated
    // title must not slip through the regex.
    'Review Yeti: INCOMPLETE',
    'Review Yeti: something else entirely',
    // Missing the closing paren.
    'Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502',
    // Empty detail: the engine always names at least one lane.
    'Review Yeti: INCOMPLETE — infrastructure ()',
    // Control characters are excluded by the engine's own character class.
    'Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed:\nfake)',
    // Longer than MAX_INCOMPLETE_INFRASTRUCTURE_DETAIL_CHARACTERS (120).
    `Review Yeti: INCOMPLETE — infrastructure (${'x'.repeat(121)})`,
    // Wrong prefix letter case and a different unicode dash.
    'Review Yeti: INCOMPLETE - infrastructure (lane arch-lane failed: 502)',
  ];
  for (const title of notRecoverable) {
    await assert.rejects(
      validate({ attempt: 1, refreshRequested: true, pages: [page([workerCheck({ title })])] }),
      /refresh a1 worker is not a completed recoverable infrastructure failure/u,
      `title must NOT be recoverable: ${JSON.stringify(title)}`,
    );
  }
});

test('an INCOMPLETE-infrastructure a1 still needs a completed check with a recoverable conclusion', async () => {
  const title = 'Review Yeti: INCOMPLETE — infrastructure (lane panel failed: 429)';
  // `neutral` and `skipped` read as PASSING for a required check, so they must
  // never be admitted as an infrastructure failure.
  for (const conclusion of ['success', 'neutral', 'skipped', 'cancelled', 'timed_out']) {
    await assert.rejects(
      validate({
        attempt: 1,
        refreshRequested: true,
        pages: [page([workerCheck({ title, conclusion })])],
      }),
      /refresh a1 worker is not a completed recoverable infrastructure failure/u,
      `conclusion must NOT be recoverable: ${conclusion}`,
    );
  }
  // And an in-progress run is not a completed attempt either.
  await assert.rejects(
    validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page([workerCheck({ title, status: 'in_progress', conclusion: null })])],
    }),
    /refresh a1 worker is not a completed recoverable infrastructure failure/u,
  );
});

test('the INCOMPLETE-infrastructure family mirrors the engine \u0022140" check-run title cap', async () => {
  // The engine's predicate is `title.length <= MAX_CHECK_RUN_TITLE_CHARACTERS`,
  // not the prefix regex alone. GitHub caps output.title at 140 characters, and
  // the engine's own detail bound (120) is wider than the room the prefix leaves
  // (42 + detail + 1 = 140 => detail <= 97). So there is a real band of
  // over-length titles -- detail 98..120, total 141..163 -- that the engine
  // PUBLISHES as unrecoverable but that a prefix-only mirror would admit. The
  // consumer must not be more permissive than the engine it mirrors.
  const prefix = 'Review Yeti: INCOMPLETE — infrastructure (';
  const detail = (length) => prefix + 'x'.repeat(length) + ')';

  // At the boundary the engine accepts: total exactly 140 (detail 97).
  const atCap = detail(97);
  assert.equal(atCap.length, 140);
  const admitted = await validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([workerCheck({ title: atCap })])],
  });
  assert.equal(admitted.review_generation, 2);

  // One character over: the engine's predicate rejects it, so this must too.
  // 98..120 corresponds to the real over-length band; 121+ already fails the
  // detail bound alone and is covered by the case above.
  for (const length of [98, 120, 121]) {
    const overCap = detail(length);
    assert.ok(overCap.length > 140, `detail ${length} must exceed the cap`);
    await assert.rejects(
      validate({ attempt: 1, refreshRequested: true, pages: [page([workerCheck({ title: overCap })])] }),
      /refresh a1 worker is not a completed recoverable infrastructure failure/u,
      `a ${overCap.length}-character title must NOT be recoverable`,
    );
  }
});

test('explicit refresh admits a persisted retry from caller attempt 1 after a recoverable a1', async () => {
  const result = await validate({ attempt: 1, refreshRequested: true, pages: [page([workerCheck()])] });
  assert.equal(result.review_generation, 2);
  assert.equal(result.refresh_execution_attempt, 1);
  assert.equal(result.worker_check_count, 1);
  assert.equal(result.latest_worker_check_id, 100);
  assert.equal(result.refresh_requested, true);
});

test('explicit refresh advances the persisted retry ledger from a2 to the bounded a3', async () => {
  const result = await validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([
      workerCheck({ id: 100, attempt: 1 }),
      workerCheck({ id: 101, attempt: 2 }),
    ])],
  });
  assert.equal(result.review_generation, 3);
  assert.equal(result.refresh_execution_attempt, 2);
  assert.equal(result.worker_check_count, 2);
  assert.equal(result.latest_worker_check_id, 101);
  assert.equal(result.refresh_requested, true);
});

test('completed zero-finding panel with a failed lane and exact-head infrastructure Gate admits a3', async () => {
  const calls = [];
  const runs = [workerCheck({ id: 100 }), infrastructurePanelCheck()];
  const gatePages = [page([infrastructureGateCheck()])];
  for (const refreshRequested of [true, false]) {
    const result = await validate({
      attempt: refreshRequested ? 1 : 3,
      refreshRequested,
      pages: [page(runs)],
      gatePages,
      calls,
    });
    assert.equal(result.review_generation, 3);
    assert.equal(result.latest_worker_check_id, 101);
  }
  assert.ok(calls.some(({ url }) => new URL(url).searchParams.get('check_name') === 'Review Yeti Gate'));
});

test('zero-finding incomplete roster admits a bounded same-head retry for both published coverage formats', async () => {
  for (const [expected, completed, engine] of [[6, 5, 'panel'], [4, 3, 'panel'], [6, 4, 'composed']]) {
    const first = workerCheck({ title: 'Review Yeti: BLOCK', summary: incompleteRosterSummary(expected, completed, engine) });
    const gates = [page([incompleteRosterGateCheck(expected, completed)])];
    for (const refreshRequested of [true, false]) {
      const result = await validate({
        attempt: refreshRequested ? 1 : 2,
        refreshRequested,
        pages: [page([first])],
        gatePages: gates,
      });
      assert.equal(result.review_generation, 2);
      assert.equal(result.latest_worker_check_id, first.id);
      assert.equal(Object.hasOwn(result, 'recovery_kind'), false);
    }
    const manualCalls = [];
    const manual = await validate({
      attempt: 1, refreshRequested: true, manual: true,
      pages: [page([first])], gatePages: gates, calls: manualCalls,
    });
    assert.equal(manual.review_generation, 2);
    assert.equal(Object.hasOwn(manual, 'recovery_kind'), false);
    assert.equal(manual.caller_workflow_path, '.github/workflows/repository-dispatch.yml');
    assert.equal(manualCalls.some(({ url }) => url.includes('/contents/.github/workflows/ct-review-bot.yml')), false);
    const second = workerCheck({
      id: 101, attempt: 2, title: 'Review Yeti: BLOCK', summary: incompleteRosterSummary(expected, completed, engine),
    });
    const third = await validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page([workerCheck({ id: 100 }), second])],
      gatePages: gates,
    });
    assert.equal(third.review_generation, 3);
    assert.equal(Object.hasOwn(third, 'recovery_kind'), false);
  }
});

test('zero-only recovery keeps the existing max-check-id rule for tied Gate timestamps', async () => {
  const worker = workerCheck({ title: 'Review Yeti: BLOCK', summary: incompleteRosterSummary(6, 5) });
  const laterIdFailure = incompleteRosterGateCheck(6, 5, { id: 201 });
  const lowerIdSuccess = historicalGateCheck({
    id: 200,
    completed_at: laterIdFailure.completed_at,
    conclusion: 'success',
  });
  const result = await validate({
    attempt: 2,
    pages: [page([worker])],
    gatePages: [page([lowerIdSuccess, laterIdFailure])],
  });
  assert.equal(result.review_generation, 2);
  assert.equal(Object.hasOwn(result, 'recovery_kind'), false);
});

test('nonzero no-blocker incomplete panels emit a P2 recovery candidate for service validation', async () => {
  for (const [expected, completed, engine] of [[6, 5, 'panel'], [6, 4, 'composed']]) {
    const summary = incompleteP2CandidateSummary(expected, completed, engine, 2, 3);
    const first = workerCheck({
      title: 'Review Yeti: BLOCK', summary,
      startedAt: '2026-09-24T18:28:55Z', completedAt: '2026-09-24T18:28:56Z',
    });
    const gates = [page([incompleteRosterGateCheck(expected, completed, { completed_at: '2026-09-24T18:28:57Z' })])];
    await assert.rejects(
      validate({
        attempt: 2,
        pages: [page([first])],
        gatePages: gates,
      }),
      /P2 recovery requires an explicit refresh request/u,
    );
    const retry = await validate({
      attempt: 2,
      refreshRequested: true,
      pages: [page([first])],
      gatePages: gates,
    });

    assert.equal(retry.review_generation, 2);
    assert.equal(retry.refresh_requested, true);
    assert.equal(retry.recovery_kind, 'incomplete_p2');

    // A P2 candidate cannot mask an earlier infrastructure/no-verdict worker:
    // the service archive contract requires every prior generation to be an
    // incomplete BLOCK (zero-finding incomplete BLOCKs remain eligible).
    await assert.rejects(validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page([
        workerCheck({ id: 100, attempt: 1 }),
        workerCheck({
          id: 101, attempt: 2, title: 'Review Yeti: BLOCK', summary,
          startedAt: '2026-09-24T18:29:00Z', completedAt: '2026-09-24T18:29:56Z',
        }),
      ])],
      gatePages: [page([incompleteRosterGateCheck(expected, completed, { completed_at: '2026-09-24T18:30:00Z' })])],
    }), /P2 recovery requires every prior worker to be a validated incomplete BLOCK; a1 is not a validated incomplete BLOCK/u);
  }
});

test('P2 recovery rejects canonical finding counts greater than the raw pre-clustering count', async () => {
  const worker = workerCheck({
    title: 'Review Yeti: BLOCK',
    summary: incompleteP2CandidateSummary(6, 5, 'panel', 3, 1),
    startedAt: '2026-09-24T18:28:55Z',
    completedAt: '2026-09-24T18:28:56Z',
  });

  await assert.rejects(validate({
    attempt: 2,
    refreshRequested: true,
    pages: [page([worker])],
    gatePages: [page([incompleteRosterGateCheck(6, 5, { completed_at: '2026-09-24T18:28:57Z' })])],
  }), /refresh a1 worker is not a completed recoverable infrastructure failure/u);
});

test('P2 candidate classification safely rejects missing or non-string worker summaries', () => {
  const second = workerCheck({
    id: 101,
    attempt: 2,
    title: 'Review Yeti: BLOCK',
    summary: incompleteP2CandidateSummary(4, 3, 'panel', 2, 3),
    startedAt: '2026-09-24T18:29:00Z',
    completedAt: '2026-09-24T18:29:56Z',
  });
  const invalidOutputs = [
    { title: 'Review Yeti: BLOCK', summary: undefined, text: null },
    { title: 'Review Yeti: BLOCK', summary: 42, text: null },
    { title: 'Review Yeti: BLOCK', text: null },
  ];

  for (const output of invalidOutputs) {
    const first = workerCheck({
      id: 100,
      attempt: 1,
      title: 'Review Yeti: BLOCK',
      startedAt: '2026-09-24T18:28:50Z',
      completedAt: '2026-09-24T18:28:56Z',
    });
    first.output = output;
    assert.throws(() => assertReviewGeneration({
      callerRunAttempt: 1,
      inventory: {
        headSha,
        identities: [
          { row: first, kind: 'worker', attempt: 1, runId: '1'.repeat(32) },
          { row: second, kind: 'worker', attempt: 2, runId: '1'.repeat(32) },
        ],
      },
      gateInventory: { rows: [] },
      refreshRequested: true,
    }), /P2 recovery requires every prior worker to be a validated incomplete BLOCK; a1 is not a validated incomplete BLOCK/u);
  }
});

test('manual dispatch without refresh admits an initial review but cannot replace an existing generation', async () => {
  const calls = [];
  const initial = await validate({ attempt: 1, manual: true, pages: [page([])], calls });
  assert.equal(initial.review_generation, 1);
  assert.equal(initial.refresh_requested, false);
  assert.equal(initial.caller_workflow_path, '.github/workflows/repository-dispatch.yml');
  assert.equal(calls.some(({ url }) => url.includes('/contents/.github/workflows/ct-review-bot.yml')), false);

  await assert.rejects(validate({
    attempt: 1,
    manual: true,
    pages: [page([workerCheck({ title: 'Review Yeti: BLOCK', summary: incompleteRosterSummary(4, 3) })])],
    gatePages: [page([incompleteRosterGateCheck(4, 3)])],
  }), /attempt 1 requires zero worker checks/u);
});

for (const engine of ['panel', 'composed']) {
  test(`incomplete ${engine} retry rejects a wrong summary head and duplicate evidence lines`, async () => {
    const summary = incompleteRosterSummary(6, 5, engine);
    const lines = summary.split('\n');
    const coverageLine = lines.find((line) => line.startsWith('Coverage: '));
    const findingsLine = lines.find((line) => line.startsWith('Findings: '));
    const mutations = [
      ['wrong summary head SHA', summary.replace(headSha, 'c'.repeat(40))],
      ['duplicate Coverage line', summary.replace(coverageLine, `${coverageLine}\n${coverageLine}`)],
      ['duplicate Findings line', summary.replace(findingsLine, `${findingsLine}\n${findingsLine}`)],
    ];
    for (const [label, mutatedSummary] of mutations) {
      assert.notEqual(mutatedSummary, summary, label);
      await assert.rejects(
        validate({
          attempt: 2,
          pages: [page([workerCheck({ title: 'Review Yeti: BLOCK', summary: mutatedSummary })])],
          gatePages: [page([incompleteRosterGateCheck(6, 5)])],
        }),
        /a1 worker is not a completed recoverable infrastructure failure/u,
        label,
      );
    }
  });
}

test('incomplete roster retry rejects findings, contradictory coverage, or mismatched Gate evidence', async () => {
  const summary = incompleteRosterSummary(6, 5);
  const composedSummary = incompleteRosterSummary(6, 5, 'composed');
  const gate = incompleteRosterGateCheck(6, 5);
  const invalidWorkers = [
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('Findings: 0', 'Findings: 1') }),
    workerCheck({
      title: 'Review Yeti: BLOCK',
      summary: incompleteP2CandidateSummary(6, 5).replace('blocking P0/P1: 0', 'blocking P0/P1: 1'),
    }),
    workerCheck({
      title: 'Review Yeti: BLOCK',
      summary: incompleteP2CandidateSummary(6, 5, 'panel', 2, 0),
    }),
    workerCheck({
      title: 'Review Yeti: BLOCK',
      summary: incompleteP2CandidateSummary(6, 5, 'panel', 0, 2),
    }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('blocking P0/P1: 0', 'blocking P0/P1: 1') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('0 raw persona finding(s)', '1 raw persona finding(s)') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('completed lanes=5', 'completed lanes=6') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('failed lanes=0', 'failed lanes=1') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('roster valid=false', 'roster valid=true') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('quorum satisfied=false', 'quorum satisfied=true') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: summary.replace('full panel complete=false', 'full panel complete=true') }),
    workerCheck({ title: 'Review Yeti: FIX_FIRST', summary }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary, conclusion: 'success' }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: composedSummary.replace('planned tasks=6', 'planned tasks=7') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: composedSummary.replace('completed tasks=5', 'completed tasks=6') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: composedSummary.replace('failed tasks=0', 'failed tasks=1') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: composedSummary.replace('engine=composed', 'engine=unknown') }),
    workerCheck({ title: 'Review Yeti: BLOCK', summary: composedSummary.replace('task coverage complete=false', 'task coverage complete=true') }),
  ];
  for (const worker of invalidWorkers) {
    await assert.rejects(
      validate({ attempt: 2, pages: [page([worker])], gatePages: [page([gate])] }),
      /a1 worker is not a completed recoverable infrastructure failure/u,
    );
  }
  for (const gates of [
    [],
    [incompleteRosterGateCheck(4, 3)],
    [infrastructureGateCheck()],
    [incompleteRosterGateCheck(6, 5, { conclusion: 'success' })],
    [incompleteRosterGateCheck(6, 5, { completed_at: '2026-09-24T18:28:55Z' })],
  ]) {
    await assert.rejects(
      validate({
        attempt: 2,
        pages: [page([workerCheck({ title: 'Review Yeti: BLOCK', summary })])],
        gatePages: [page(gates)],
      }),
      /a1 worker is not a completed recoverable infrastructure failure/u,
    );
  }
});

test('P2 recovery candidate still requires the newest exact-head App-owned incomplete-panel Gate', async () => {
  const summary = incompleteP2CandidateSummary(6, 5);
  const worker = workerCheck({ title: 'Review Yeti: BLOCK', summary });
  const invalidGates = [
    [],
    [incompleteRosterGateCheck(4, 3)],
    [infrastructureGateCheck()],
    [incompleteRosterGateCheck(6, 5, { app: { id: 1, slug: 'other' } })],
    [incompleteRosterGateCheck(6, 5, { conclusion: 'success' })],
    [incompleteRosterGateCheck(6, 5, { completed_at: '2026-09-24T18:28:55Z' })],
    [incompleteRosterGateCheck(6, 5), historicalGateCheck({ completed_at: '2026-09-24T18:29:00Z' })],
  ];

  for (const gateRuns of invalidGates) {
    await assert.rejects(
      validate({ attempt: 2, pages: [page([worker])], gatePages: [page(gateRuns)] }),
      /P2 recovery requires every prior worker to be a validated incomplete BLOCK|a1 worker is not a completed recoverable infrastructure failure|Review Yeti Gate check is not an exact-head App-owned gate/u,
    );
  }
});

test('a3 P2 recovery binds each older BLOCK to the latest Gate in its worker window', async () => {
  const first = workerCheck({
    id: 100,
    attempt: 1,
    title: 'Review Yeti: BLOCK',
    summary: incompleteP2CandidateSummary(6, 5, 'panel', 2, 3),
    startedAt: '2026-09-24T18:28:50Z',
    completedAt: '2026-09-24T18:28:56Z',
  });
  const second = workerCheck({
    id: 101,
    attempt: 2,
    title: 'Review Yeti: BLOCK',
    summary: incompleteRosterSummary(4, 3),
    startedAt: '2026-09-24T18:29:00Z',
    completedAt: '2026-09-24T18:29:56Z',
  });
  const gate1 = incompleteRosterGateCheck(6, 5, { id: 102, completed_at: '2026-09-24T18:28:58Z' });
  const gate2 = incompleteRosterGateCheck(4, 3, { id: 103, completed_at: '2026-09-24T18:30:00Z' });
  const admitted = await validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([first, second])],
    gatePages: [page([gate1, gate2])],
  });
  assert.equal(admitted.review_generation, 3);
  assert.equal(admitted.latest_worker_check_id, 101);
  assert.equal(admitted.recovery_kind, 'incomplete_p2');

  const conflictingSameTime = historicalGateCheck({
    id: 104,
    completed_at: '2026-09-24T18:28:58Z',
  });
  const invalidCases = [
    { gates: [gate2], workers: [first, second] },
    {
      gates: [incompleteRosterGateCheck(6, 5, { id: 102, completed_at: '2026-09-24T18:29:01Z' }), gate2],
      workers: [first, second],
    },
    {
      gates: [gate1, incompleteRosterGateCheck(4, 3, {
        id: 103,
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-24T18:30:00Z',
        output: { title: 'Review Yeti Gate: Passed', summary: 'Review Yeti Gate passed.', text: null },
      })],
      workers: [first, second],
    },
    { gates: [gate1, gate2, conflictingSameTime], workers: [first, second] },
    {
      gates: [gate1, gate2, historicalGateCheck({ id: 106, completed_at: gate2.completed_at })],
      workers: [first, second],
    },
    {
      gates: [gate1, gate2],
      workers: [first, { ...second, started_at: '2026-09-24T18:28:56Z' }],
      timelineError: true,
    },
    {
      gates: [gate1, gate2],
      workers: [first, { ...second, started_at: undefined }],
      timelineError: true,
    },
  ];
  for (const { gates, workers, timelineError } of invalidCases) {
    await assert.rejects(
      validate({ attempt: 1, refreshRequested: true, pages: [page(workers)], gatePages: [page(gates)] }),
      timelineError
        ? /P2 recovery requires valid, strictly ordered prior worker started_at\/completed_at timestamps/u
        : /P2 recovery requires every prior worker to be a validated incomplete BLOCK|refresh a[12] worker is not a completed recoverable infrastructure failure/u,
    );
  }

  const duplicateEquivalentGate = { ...gate1, id: 105 };
  const equivalentTie = await validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([first, second])],
    gatePages: [page([gate1, duplicateEquivalentGate, gate2])],
  });
  assert.equal(equivalentTie.review_generation, 3);
  assert.equal(equivalentTie.recovery_kind, 'incomplete_p2');
});

test('P2 recovery requires canonical Gate timestamps while legacy zero-finding retries retain their parser', async () => {
  const first = workerCheck({
    id: 100,
    attempt: 1,
    title: 'Review Yeti: BLOCK',
    summary: incompleteP2CandidateSummary(6, 5, 'panel', 2, 3),
    startedAt: '2026-03-01T00:00:50Z',
    completedAt: '2026-03-01T00:00:56Z',
  });
  const second = workerCheck({
    id: 101,
    attempt: 2,
    title: 'Review Yeti: BLOCK',
    summary: incompleteRosterSummary(4, 3),
    startedAt: '2026-03-01T00:01:00Z',
    completedAt: '2026-03-01T00:01:56Z',
  });
  const canonicalGate1 = incompleteRosterGateCheck(6, 5, {
    id: 102,
    completed_at: '2026-03-01T00:00:58Z',
  });
  const gate2 = incompleteRosterGateCheck(4, 3, {
    id: 103,
    completed_at: '2026-03-01T00:02:00Z',
  });
  const canonical = await validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([first, second])],
    gatePages: [page([canonicalGate1, gate2])],
  });
  assert.equal(canonical.review_generation, 3);
  assert.equal(canonical.recovery_kind, 'incomplete_p2');

  // Date.parse rolls this well-shaped but impossible date forward to
  // 2026-03-01T00:00:58Z, inside a1's Gate window. P2 validation must reject it.
  const rolloverGate = incompleteRosterGateCheck(6, 5, {
    id: 104,
    completed_at: '2026-02-29T00:00:58Z',
  });
  await assert.rejects(validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([first, second])],
    gatePages: [page([rolloverGate, gate2])],
  }), /P2 recovery requires every prior worker to be a validated incomplete BLOCK/u);

  const legacyZeroWorker = workerCheck({
    title: 'Review Yeti: BLOCK',
    summary: incompleteRosterSummary(6, 5),
    startedAt: '2026-03-01T00:00:50Z',
    completedAt: '2026-03-01T00:00:56Z',
  });
  const legacyZero = await validate({
    attempt: 2,
    pages: [page([legacyZeroWorker])],
    gatePages: [page([rolloverGate])],
  });
  assert.equal(legacyZero.review_generation, 2);
  assert.equal(Object.hasOwn(legacyZero, 'recovery_kind'), false);
});

test('P2 recovery rejects conflicting same-time App Gate checks for the final or sole worker', async () => {
  const worker = workerCheck({
    id: 100,
    attempt: 1,
    title: 'Review Yeti: BLOCK',
    summary: incompleteP2CandidateSummary(6, 5, 'panel', 2, 3),
    startedAt: '2026-09-24T18:28:50Z',
    completedAt: '2026-09-24T18:28:56Z',
  });
  const gate = incompleteRosterGateCheck(6, 5, { id: 102, completed_at: '2026-09-24T18:28:58Z' });
  const conflictingGate = historicalGateCheck({ id: 104, completed_at: gate.completed_at });

  await assert.rejects(validate({
    attempt: 1,
    refreshRequested: true,
    pages: [page([worker])],
    gatePages: [page([gate, conflictingGate])],
  }), /P2 recovery requires every prior worker to be a validated incomplete BLOCK/u);
});

test('P2 recovery rejects negative durations and noncanonical or impossible prior-worker timestamps', async (t) => {
  const first = workerCheck({
    id: 100,
    attempt: 1,
    title: 'Review Yeti: BLOCK',
    summary: incompleteP2CandidateSummary(6, 5, 'panel', 2, 3),
    startedAt: '2026-09-24T18:28:50Z',
    completedAt: '2026-09-24T18:28:56Z',
  });
  const second = workerCheck({
    id: 101,
    attempt: 2,
    title: 'Review Yeti: BLOCK',
    summary: incompleteRosterSummary(4, 3),
    startedAt: '2026-09-24T18:29:00Z',
    completedAt: '2026-09-24T18:29:56Z',
  });
  const gates = [
    incompleteRosterGateCheck(6, 5, { id: 102, completed_at: '2026-09-24T18:28:58Z' }),
    incompleteRosterGateCheck(4, 3, { id: 103, completed_at: '2026-09-24T18:30:00Z' }),
  ];
  const invalidCases = [
    {
      name: 'rejects a negative duration on the first worker',
      workers: [{ ...first, started_at: '2026-09-24T18:28:57Z' }, second],
    },
    {
      name: 'rejects a negative duration on the second worker',
      workers: [first, { ...second, started_at: '2026-09-24T18:29:57Z' }],
    },
    {
      name: 'rejects millisecond precision on the first worker',
      workers: [{ ...first, started_at: '2026-09-24T18:28:50.000Z' }, second],
    },
    {
      name: 'rejects a space-separated timestamp on the first worker',
      workers: [{ ...first, started_at: '2026-09-24 18:28:50Z' }, second],
    },
    {
      name: 'rejects an impossible calendar date on the first worker',
      workers: [{ ...first, started_at: '2026-02-30T18:28:50Z' }, second],
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      await assert.rejects(
        validate({ attempt: 1, refreshRequested: true, pages: [page(invalidCase.workers)], gatePages: [page(gates)] }),
        /P2 recovery requires valid, strictly ordered prior worker started_at\/completed_at timestamps/u,
      );
    });
  }
});

test('refresh chooses the newest exact-head App Gate from historical runs regardless of API order', async () => {
  const runs = [workerCheck({ id: 100 }), infrastructurePanelCheck()];
  for (const gates of [
    [infrastructureGateCheck(), historicalGateCheck()],
    [historicalGateCheck(), infrastructureGateCheck()],
  ]) {
    const result = await validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page(runs)],
      gatePages: [page(gates)],
    });
    assert.equal(result.review_generation, 3);
    assert.equal(result.latest_worker_check_id, 101);
  }
});

test('older-only Gate and later noninfrastructure Gate cannot authorize refresh', async () => {
  const runs = [workerCheck({ id: 100 }), infrastructurePanelCheck()];
  const laterNoninfra = historicalGateCheck({
    id: 103,
    completed_at: '2026-09-24T18:29:00Z',
  });
  const tiedNoninfra = historicalGateCheck({
    id: 103,
    completed_at: '2026-09-24T18:28:57Z',
  });
  for (const gates of [
    [historicalGateCheck()],
    [infrastructureGateCheck({ id: 98, completed_at: '2026-09-24T18:23:39Z' })],
    [infrastructureGateCheck(), laterNoninfra],
    [laterNoninfra, infrastructureGateCheck()],
    [infrastructureGateCheck(), tiedNoninfra],
  ]) {
    await assert.rejects(
      validate({ attempt: 1, refreshRequested: true, pages: [page(runs)], gatePages: [page(gates)] }),
      /refresh a2 worker is not a completed recoverable infrastructure failure/u,
    );
  }
});

test('failed panel remains nonrefreshable without current App-owned infrastructure Gate', async () => {
  const runs = [workerCheck({ id: 100 }), infrastructurePanelCheck()];
  const cases = [
    [],
    [infrastructureGateCheck({ app: { id: 1, slug: 'other' } })],
    [infrastructureGateCheck({ head_sha: 'c'.repeat(40) })],
    [infrastructureGateCheck({ conclusion: 'success' })],
    [infrastructureGateCheck({ status: 'in_progress', conclusion: null })],
    [infrastructureGateCheck({ completed_at: '2026-09-24T18:28:55Z' })],
    [infrastructureGateCheck({ external_id: 'operator:manual' })],
    [infrastructureGateCheck({ output: { title: 'Review Yeti Gate: Failed', summary: 'Review Yeti Gate failed: code-findings. This is not an approval.', text: null } })],
  ];
  for (const gates of cases) {
    await assert.rejects(
      validate({ attempt: 1, refreshRequested: true, pages: [page(runs)], gatePages: [page(gates)] }),
      /refresh a2 worker is not a completed recoverable infrastructure failure|Review Yeti Gate check is not an exact-head App-owned gate/u,
    );
  }
});

test('code findings and other non-SHIP verdicts cannot use the infrastructure Gate to refresh', async () => {
  const variants = [
    infrastructurePanelCheck({ summary: infrastructurePanelSummary.replace('Findings: 0', 'Findings: 1') }),
    infrastructurePanelCheck({ summary: infrastructurePanelSummary.replace('0 raw persona finding(s)', '1 raw persona finding(s)') }),
    infrastructurePanelCheck({ summary: infrastructurePanelSummary.replace('failed lanes=1', 'failed lanes=0') }),
    infrastructurePanelCheck({ summary: infrastructurePanelSummary.replace('full panel complete=false', 'full panel complete=true') }),
    infrastructurePanelCheck({ title: 'Review Yeti: FIX_FIRST' }),
    infrastructurePanelCheck({ conclusion: 'success' }),
  ];
  for (const candidate of variants) {
    await assert.rejects(
      validate({
        attempt: 1,
        refreshRequested: true,
        pages: [page([workerCheck({ id: 100 }), candidate])],
        gatePages: [page([infrastructureGateCheck()])],
      }),
      /refresh a2 worker is not a completed recoverable infrastructure failure/u,
    );
  }
});

test('an admitted infrastructure panel cannot allocate a duplicate a3 generation', async () => {
  const gatePages = [page([infrastructureGateCheck()])];
  const prior = [workerCheck({ id: 100 }), infrastructurePanelCheck()];
  const first = await validate({
    attempt: 1, refreshRequested: true, pages: [page(prior)], gatePages,
  });
  assert.equal(first.review_generation, 3);

  await assert.rejects(
    validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page([...prior, workerCheck({
        id: 103, attempt: 3, status: 'in_progress', conclusion: null,
        title: 'Review Yeti: in progress',
      })])],
      gatePages,
    }),
    /refresh a3 worker is not a completed recoverable infrastructure failure/u,
  );
});

test('explicit refresh fails closed after the bounded a3 already exists', async () => {
  await assert.rejects(
    validate({
      attempt: 1,
      refreshRequested: true,
      pages: [page([
        workerCheck({ id: 100, attempt: 1 }),
        workerCheck({ id: 101, attempt: 2 }),
        workerCheck({ id: 102, attempt: 3 }),
      ])],
    }),
    /refresh generation limit a3 is exhausted/u,
  );
});

test('explicit refresh rejects a2 ledgers with gaps, duplicate generations, or different run identities', async () => {
  const cases = [
    {
      runs: [workerCheck({ id: 100, attempt: 1 }), workerCheck({ id: 101, attempt: 1 })],
      pattern: /requires exactly one worker a1; found 2/u,
    },
    {
      runs: [workerCheck({ id: 100, attempt: 1 }), workerCheck({ id: 101, attempt: 3 })],
      pattern: /worker attempt a3 already exists/u,
    },
    {
      runs: [
        workerCheck({ id: 100, attempt: 1, externalId: `run_${'1'.repeat(32)}:a1` }),
        workerCheck({ id: 101, attempt: 2, externalId: `run_${'2'.repeat(32)}:a2` }),
      ],
      pattern: /prior worker generations must share one DOKS run identity/u,
    },
  ];
  for (const fixture of cases) {
    await assert.rejects(
      validate({ attempt: 1, refreshRequested: true, pages: [page(fixture.runs)] }),
      fixture.pattern,
    );
  }
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

// REL-940: `action_required` is the semantically correct "no verdict, operator
// action needed" conclusion for an infrastructure failure, and it blocks merge
// exactly like `failure`. This validator accepts it BEFORE the engine starts
// publishing it, so the engine migration is not a flag-day and this gate can
// never be the thing that refuses same-head regeneration mid-migration.
test('attempt 2 admits an action_required infrastructure failure alongside failure', async () => {
  for (const conclusion of ['failure', 'action_required']) {
    const runs = [workerCheck({ conclusion })];
    const result = await validate({ attempt: 2, pages: [page(runs)] });
    assert.ok(result, `a1 ${conclusion} should admit an a2 regeneration`);
  }
});

// The exclusion of neutral/skipped is load-bearing, not an omission: GitHub
// treats both as PASSING for required status checks, so admitting either would
// let an infrastructure failure read as an approval. Asserted against every
// recoverable title so a future title addition cannot quietly widen it.
test('attempt 2 never admits a passing-equivalent conclusion', async () => {
  const recoverableTitles = [
    'Review Yeti: review did not complete',
    'Review Yeti: NO VERDICT (no panel result for this head)',
  ];
  for (const title of recoverableTitles) {
    for (const conclusion of ['neutral', 'skipped']) {
      await assert.rejects(
        validate({ attempt: 2, pages: [page([workerCheck({ conclusion, title })])] }),
        /a1 worker is not a completed recoverable infrastructure failure/u,
        `${conclusion} with title "${title}" must never admit a regeneration`,
      );
    }
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


test('validated recovery classification reaches the GitHub step output file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'central-recovery-output-'));
  try {
    for (const p2 of [true, false]) {
      const result = await validate({ attempt: 1, refreshRequested: true,
        pages: [page([workerCheck({ title: 'Review Yeti: BLOCK',
          summary: p2 ? incompleteP2CandidateSummary(6, 5) : incompleteRosterSummary(6, 5) })])],
        gatePages: [page([incompleteRosterGateCheck(6, 5)])],
      });
      const outputPath = join(directory, p2 ? 'p2-output' : 'ordinary-output');
      writeOutputs(result, outputPath);
      const outputs = Object.fromEntries(readFileSync(outputPath, 'utf8').trimEnd().split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      assert.equal(outputs.review_generation, '2');
      assert.equal(outputs.refresh_execution_attempt, '1');
      assert.equal(outputs.recovery_kind, p2 ? 'incomplete_p2' : undefined);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
