import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runMergeGroupGate, verifyMergeGroup } from '../.github/actions/verify-merge-group/verify-merge-group.mjs';

const repository = 'exampleorg/dashboard';
const headSha = 'b'.repeat(40);
const groupSha = 'c'.repeat(40);
const baseSha = 'a'.repeat(40);
const event = {
  action: 'checks_requested', repository: { full_name: repository },
  merge_group: { base_ref: 'refs/heads/master', base_sha: baseSha, head_sha: groupSha,
    head_ref: `refs/heads/gh-readonly-queue/master/pr-42-${baseSha}` },
};
const checks = [
  { id: 11, name: 'Review Yeti', app: { id: 4385771, slug: 'ct-review-bot' }, status: 'completed', conclusion: 'success', head_sha: headSha },
];
const entry = (number = 42, position = 1) => ({
  position, state: 'AWAITING_CHECKS', baseCommit: { oid: baseSha }, headCommit: { oid: groupSha },
  pullRequest: { number, headRefOid: headSha, state: 'OPEN', baseRefName: 'master', repository: { nameWithOwner: repository } },
});
const queueResponse = (entries = [entry()]) => ({ data: { repository: { mergeQueue: {
  id: 'MQ_123', entries: { nodes: entries, pageInfo: { hasNextPage: false } },
} } } });
const response = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) });

function fetchFixture({ graphql = queueResponse(), checkRuns = checks, totalCount = checkRuns.length, afterChecks } = {}) {
  let queueReads = 0;
  return async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal, 'every request is bounded');
    if (url === 'https://api.github.com/graphql') {
      queueReads += 1;
      assert.match(JSON.parse(options.body).query, /headCommit\{oid\}/u);
      return response(queueReads > 1 && afterChecks ? afterChecks : graphql);
    }
    assert.match(url, new RegExp(`/commits/${headSha}/check-runs\\?filter=all&per_page=100$`, 'u'));
    return response({ check_runs: checkRuns, total_count: totalCount });
  };
}

const verify = (options = {}) => verifyMergeGroup({ repository, branch: 'refs/heads/master', event,
  expectedHeadSha: groupSha, token: 'test-only', fetchImpl: fetchFixture(), ...options });

for (const linked of [false, true]) test(`CLI rejects a non-queue event through ${linked ? 'a linked path with spaces' : 'its direct path'}`, (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let invocationRoot = root;
  if (linked) {
    const scratch = mkdtempSync(path.join(tmpdir(), 'ct-merge-group-entrypoint-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    invocationRoot = path.join(scratch, 'linked repository');
    symlinkSync(root, invocationRoot, 'dir');
  }
  const run = spawnSync(process.execPath, [path.join(invocationRoot, '.github/actions/verify-merge-group/verify-merge-group.mjs')], {
    encoding: 'utf8', timeout: 10_000, env: { GITHUB_EVENT_NAME: 'pull_request' },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 1, 'CLI must execute and fail closed, never silently exit successfully');
  assert.match(run.stderr, /requires a merge_group event/u);
  assert.equal(run.stdout, '');
});

test('qualifies the exact event and latest checks, then refreshes queue identity', async () => {
  const result = await verify();
  assert.deepEqual(result.failures, []);
  assert.equal(result.entries.length, 1);
});

test('publishes and completes the native Review Yeti check on the synthetic head', async () => {
  const writes = [];
  let queueReads = 0;
  const result = await runMergeGroupGate({
    repository,
    branch: 'master',
    event,
    expectedHeadSha: groupSha,
    token: 'official-app-token',
    fetchImpl: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal, 'every request is bounded');
      if (url === `https://api.github.com/repos/${repository}/check-runs` && options.method === 'POST') {
        writes.push({ url, method: options.method, body: JSON.parse(options.body) });
        return response({ id: 9001 });
      }
      if (url === `https://api.github.com/repos/${repository}/check-runs/9001` && options.method === 'PATCH') {
        writes.push({ url, method: options.method, body: JSON.parse(options.body) });
        return response({ id: 9001 });
      }
      if (url === 'https://api.github.com/graphql') {
        queueReads += 1;
        return response(queueResponse());
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        return response({ check_runs: checks, total_count: checks.length });
      }
      assert.fail(`unexpected URL ${url}`);
    },
  });
  assert.deepEqual(result.failures, []);
  assert.equal(queueReads, 2);
  assert.equal(writes[0].body.name, 'Review Yeti');
  assert.equal(writes[0].body.head_sha, groupSha);
  assert.equal(writes[0].body.status, 'in_progress');
  assert.equal(writes[1].body.conclusion, 'success');
});

test('reports only method and status when synthetic check creation is rejected', async () => {
  await assert.rejects(
    runMergeGroupGate({
      repository,
      branch: 'master',
      event,
      expectedHeadSha: groupSha,
      token: 'official-app-token',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ secret: 'must-not-leak' }) }),
    }),
    (error) => {
      assert.equal(error.message, 'GitHub POST request failed with HTTP 403');
      assert.doesNotMatch(error.message, /secret|token|github\.com/u);
      return true;
    },
  );
});

test('completes the synthetic App check as failure when a constituent is not approved', async () => {
  const conclusions = [];
  let queueReads = 0;
  const result = await runMergeGroupGate({
    repository,
    branch: 'master',
    event,
    expectedHeadSha: groupSha,
    token: 'official-app-token',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/check-runs') && options.method === 'POST') return response({ id: 9002 });
      if (url.endsWith('/check-runs/9002') && options.method === 'PATCH') {
        conclusions.push(JSON.parse(options.body).conclusion);
        return response({ id: 9002 });
      }
      if (url === 'https://api.github.com/graphql') {
        queueReads += 1;
        return response(queueResponse());
      }
      return response({ check_runs: [{ ...checks[0], conclusion: 'failure' }], total_count: 1 });
    },
  });
  assert.match(result.failures.join(' '), /not successful/u);
  assert.equal(queueReads, 1);
  assert.deepEqual(conclusions, ['failure']);
});

test('real CLI rejects an event for a different repository before any fetch', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'ct-merge-group-event-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const eventPath = path.join(scratch, 'event.json');
  writeFileSync(eventPath, JSON.stringify({
    action: 'checks_requested',
    repository: { full_name: 'exampleorg/wrongrepo' },
    merge_group: event.merge_group,
  }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../.github/actions/verify-merge-group/verify-merge-group.mjs', import.meta.url))], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: groupSha,
      INPUT_GITHUB_TOKEN: 'test-only-placeholder',
      INPUT_REVIEW_YETI_TOKEN: 'test-only-placeholder',
      INPUT_REPOSITORY: repository,
      INPUT_BRANCH: 'master',
    },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /event does not bind/u);
  assert.equal(run.stdout, '');
});

test('direct verifier rejects an inadmissible repository before queue or fetch calls', async () => {
  let calls = 0;
  const result = await verifyMergeGroup({
    repository: 'evil/dashboard',
    branch: 'refs/heads/master',
    event: structuredClone(event),
    expectedHeadSha: groupSha,
    token: 'test-only-placeholder',
    fetchImpl: async () => {
      calls += 1;
      return response(queueResponse());
    },
  });
  assert.deepEqual(result.failures, ['repository is outside the admitted exampleorg target shape']);
  assert.equal(calls, 0);
});

test('real CLI reports thrown entrypoint errors as a failed invocation', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'ct-merge-group-missing-event-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../.github/actions/verify-merge-group/verify-merge-group.mjs', import.meta.url))], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_EVENT_PATH: path.join(scratch, 'missing-event.json'),
      GITHUB_SHA: groupSha,
      INPUT_GITHUB_TOKEN: 'test-only-placeholder',
      INPUT_REVIEW_YETI_TOKEN: 'test-only-placeholder',
      INPUT_REPOSITORY: repository,
      INPUT_BRANCH: 'master',
    },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /merge-group verification failed/u);
});

test('qualifies entries at or ahead of current, ignoring a later pending PR', async () => {
  const later = entry(43, 3);
  later.state = 'LOCKED';
  later.pullRequest.headRefOid = 'd'.repeat(40);
  const result = await verify({ fetchImpl: fetchFixture({ graphql: queueResponse([entry(41, 1), entry(42, 2), later]) }) });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.entries.map((value) => value.pullRequest.number), [41, 42]);
});

for (const [name, change] of [
  ['missing event', (input) => { input.event = undefined; }],
  ['wrong repository', (input) => { input.event.repository.full_name = 'exampleorg/other'; }],
  ['wrong branch', (input) => { input.event.merge_group.base_ref = 'refs/heads/main'; }],
  ['wrong workflow head', (input) => { input.expectedHeadSha = headSha; }],
  ['wrong action', (input) => { input.event.action = 'destroyed'; }],
  ['missing base', (input) => { delete input.event.merge_group.base_sha; }],
  ['unrelated ref', (input) => { input.event.merge_group.head_ref = `refs/heads/main/pr-42-${baseSha}`; }],
]) test(`rejects ${name} before any API request`, async () => {
  const input = { event: structuredClone(event), expectedHeadSha: groupSha,
    fetchImpl: () => assert.fail('invalid event must not request GitHub') };
  change(input);
  assert.match((await verify(input)).failures.join(' '), /event does not bind/u);
});

for (const [name, change, pattern] of [
  ['GraphQL partial errors', (body) => { body.errors = [{ message: 'partial' }]; }, /GraphQL errors/u],
  ['disabled queue', (body) => { body.data.repository.mergeQueue = null; }, /disabled/u],
  ['missing queue', (body) => { delete body.data.repository.mergeQueue; }, /unknown/u],
  ['missing pagination', (body) => { delete body.data.repository.mergeQueue.entries.pageInfo; }, /pagination/u],
  ['truncated queue', (body) => { body.data.repository.mergeQueue.entries.pageInfo.hasNextPage = true; }, /pagination/u],
  ['unrelated queue PR', (body) => { body.data.repository.mergeQueue.entries.nodes = [entry(9)]; }, /current event PR/u],
  ['duplicate PR', (body) => { body.data.repository.mergeQueue.entries.nodes.push(entry(42, 2)); }, /duplicate pull request/u],
  ['duplicate position', (body) => { body.data.repository.mergeQueue.entries.nodes.push(entry(41)); }, /duplicate position/u],
  ['stale group head', (body) => { body.data.repository.mergeQueue.entries.nodes[0].headCommit.oid = headSha; }, /does not match/u],
  ['stale group base', (body) => { body.data.repository.mergeQueue.entries.nodes[0].baseCommit.oid = headSha; }, /does not match/u],
  ['locked entry', (body) => { body.data.repository.mergeQueue.entries.nodes[0].state = 'LOCKED'; }, /locked/u],
  ['unmergeable entry', (body) => { body.data.repository.mergeQueue.entries.nodes[0].state = 'UNMERGEABLE'; }, /unmergeable/u],
  ['unknown entry', (body) => { body.data.repository.mergeQueue.entries.nodes[0].state = 'UNKNOWN'; }, /unknown/u],
  ['missing PR head', (body) => { delete body.data.repository.mergeQueue.entries.nodes[0].pullRequest.headRefOid; }, /immutable head/u],
  ['closed live PR', (body) => { body.data.repository.mergeQueue.entries.nodes[0].pullRequest.state = 'CLOSED'; }, /closed/u],
  ['wrong live base', (body) => { body.data.repository.mergeQueue.entries.nodes[0].pullRequest.baseRefName = 'main'; }, /branch/u],
  ['wrong live repository', (body) => { body.data.repository.mergeQueue.entries.nodes[0].pullRequest.repository.nameWithOwner = 'exampleorg/other'; }, /repository/u],
]) test(`fails closed for ${name}`, async () => {
  const graphql = queueResponse();
  change(graphql);
  assert.match((await verify({ fetchImpl: fetchFixture({ graphql }) })).failures.join(' '), pattern);
});

test('rejects a newer failed run rather than reusing older success', async () => {
  const result = await verify({ fetchImpl: fetchFixture({ checkRuns: [ ...checks,
    { ...checks[0], id: 12, conclusion: 'failure' },
  ] }) });
  assert.match(result.failures.join(' '), /latest exact-head run is not successful/u);
});

test('fails closed when one constituent check-runs lookup is unavailable', async () => {
  const second = entry(42, 2);
  second.pullRequest.headRefOid = 'd'.repeat(40);
  let checkReads = 0;
  const result = await verify({
    fetchImpl: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal, 'every request is bounded');
      if (url === 'https://api.github.com/graphql') return response(queueResponse([entry(41, 1), second]));
      checkReads += 1;
      if (checkReads === 2) throw new Error('simulated constituent check lookup outage');
      return response({ check_runs: checks, total_count: checks.length });
    },
  });
  assert.equal(checkReads, 2);
  assert.match(result.failures.join(' '), /PR #42: exact-head check lookup is unavailable/u);
});

test('rejects stale checks and wrong publishers', async () => {
  for (const mutation of [ { head_sha: baseSha }, { app: { id: 1 } } ]) {
    const result = await verify({ fetchImpl: fetchFixture({ checkRuns: [ { ...checks[0], ...mutation }, checks[1] ] }) });
    assert.ok(result.failures.length > 0);
  }
});

test('rejects truncated or unknown check history', async () => {
  for (const totalCount of [null, 101, 3]) {
    const result = await verify({ fetchImpl: fetchFixture({ totalCount }) });
    assert.match(result.failures.join(' '), /pagination/u);
  }
});

test('rejects changed source after checking its former green head', async () => {
  const afterChecks = queueResponse();
  afterChecks.data.repository.mergeQueue.entries.nodes[0].pullRequest.headRefOid = 'd'.repeat(40);
  assert.match((await verify({ fetchImpl: fetchFixture({ afterChecks }) })).failures.join(' '), /changed during/u);
});

test('rejects queue removal during qualification', async () => {
  assert.match((await verify({ fetchImpl: fetchFixture({ afterChecks: queueResponse([]) }) })).failures.join(' '), /revalidation/u);
});

for (const [name, change] of [
  ['locked entry', (value) => { value.state = 'LOCKED'; }],
  ['unmergeable entry', (value) => { value.state = 'UNMERGEABLE'; }],
  ['changed synthetic head', (value) => { value.headCommit.oid = headSha; }],
  ['changed synthetic base', (value) => { value.baseCommit.oid = headSha; }],
  ['closed PR', (value) => { value.pullRequest.state = 'CLOSED'; }],
  ['changed PR repository', (value) => { value.pullRequest.repository.nameWithOwner = 'exampleorg/other'; }],
  ['changed PR base', (value) => { value.pullRequest.baseRefName = 'main'; }],
]) test(`revalidates ${name} after green checks`, async () => {
  const afterChecks = queueResponse();
  change(afterChecks.data.repository.mergeQueue.entries.nodes[0]);
  const result = await verify({ fetchImpl: fetchFixture({ afterChecks }) });
  assert.match(result.failures.join(' '), /revalidation/u);
});

test('allows valid queue progress after green checks without weakening revalidation', async () => {
  const afterChecks = queueResponse();
  afterChecks.data.repository.mergeQueue.entries.nodes[0].state = 'BUILT';
  const result = await verify({ fetchImpl: fetchFixture({ afterChecks }) });
  assert.deepEqual(result.failures, []);
});

test('redacts transport exceptions', async () => {
  const result = await verify({ fetchImpl: async () => { throw new Error('secret=private'); } });
  assert.deepEqual(result.failures, ['merge queue lookup is unavailable']);
});
