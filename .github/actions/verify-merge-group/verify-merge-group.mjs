import { readFile } from 'node:fs/promises';

import { isEntrypoint } from '../../../scripts/entrypoint-guard.mjs';
import {
  evaluateExactCheckRuns,
  QUALIFYING_MERGE_QUEUE_STATES,
} from '../../../scripts/review-check-contract.mjs';
import { assertAdmittedRepository } from '../../../scripts/validate-central-dispatch.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const QUEUE_QUERY = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id entries(first:100){nodes{position state baseCommit{oid} headCommit{oid} pullRequest{number state baseRefName headRefOid repository{nameWithOwner}}} pageInfo{hasNextPage}}}}}';

function normalizeBranch(branch) {
  return String(branch || '').replace(/^refs\/heads\//u, '');
}

function mergeGroupIdentityFailure({ repository, branch, event, expectedHeadSha }) {
  try {
    assertAdmittedRepository(repository);
  } catch {
    return 'repository is outside the admitted exampleorg target shape';
  }
  const normalizedBranch = normalizeBranch(branch);
  const group = event?.merge_group;
  const prefix = `refs/heads/gh-readonly-queue/${normalizedBranch}/`;
  const match = typeof group?.head_ref === 'string' && group.head_ref.startsWith(prefix)
    ? /^pr-([1-9][0-9]*)-[0-9a-f]{7,40}$/u.exec(group.head_ref.slice(prefix.length)) : null;
  if (!normalizedBranch || event?.action !== 'checks_requested'
      || event?.repository?.full_name !== repository
      || normalizeBranch(group?.base_ref) !== normalizedBranch
      || !SHA_PATTERN.test(String(group?.base_sha || ''))
      || !SHA_PATTERN.test(String(group?.head_sha || ''))
      || group?.head_sha !== expectedHeadSha
      || !Number.isSafeInteger(Number(match?.[1])) || Number(match?.[1]) < 1) {
    return 'merge-group event does not bind the repository, branch, current PR, and exact workflow head';
  }
  return null;
}

async function githubJson(url, token, fetchImpl, options = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('a Review Yeti App token is required');
  const method = options.method || 'GET';
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(options.headers || {}),
      },
      ...(options.body ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new Error(`GitHub ${method} request failed before response`);
  }
  if (!response?.ok) {
    const status = Number.isSafeInteger(Number(response?.status)) ? Number(response.status) : 'unknown';
    throw new Error(`GitHub ${method} request failed with HTTP ${status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub ${method} response was not valid JSON`);
  }
}

class QueueValidationError extends Error {}

function selectConstituents(response, { repository, branch, group, currentNumber }) {
  if (Array.isArray(response?.errors) && response.errors.length > 0) throw new QueueValidationError('merge queue lookup returned GraphQL errors');
  const queue = response?.data?.repository?.mergeQueue;
  if (queue === null) throw new QueueValidationError('merge queue is disabled for the merge-group branch');
  if (!queue || typeof queue.id !== 'string' || !queue.id) throw new QueueValidationError('merge queue identity is unknown or malformed');
  if (!Array.isArray(queue.entries?.nodes)) throw new QueueValidationError('merge queue entries are unavailable or malformed');
  if (queue.entries.pageInfo?.hasNextPage !== false) throw new QueueValidationError('merge queue pagination is incomplete or unknown; refusing partial qualification');
  const allEntries = queue.entries.nodes;
  const numbers = new Set();
  const positions = new Set();
  for (const entry of allEntries) {
    const number = entry?.pullRequest?.number;
    if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number)) throw new QueueValidationError('merge queue contains a missing or duplicate pull request');
    if (!Number.isSafeInteger(entry?.position) || entry.position < 1 || positions.has(entry.position)) throw new QueueValidationError('merge queue contains an invalid or duplicate position');
    numbers.add(number);
    positions.add(entry.position);
  }
  const current = allEntries.find((entry) => entry.pullRequest.number === currentNumber);
  if (!current) throw new QueueValidationError('merge queue does not contain the current event PR exactly once');
  // Bind the event's synthetic test commit, not the PR source commit. A
  // previous group's checks must never qualify a newly rebuilt queue entry.
  if (current.headCommit?.oid !== group.head_sha || current.baseCommit?.oid !== group.base_sha) throw new QueueValidationError('current queue entry does not match the event merge-group base and head');
  const entries = allEntries.filter((entry) => entry.position <= current.position).sort((a, b) => a.position - b.position);
  for (const entry of entries) {
    const pull = entry.pullRequest;
    if (!SHA_PATTERN.test(String(pull.headRefOid || ''))) throw new QueueValidationError('constituent PR has no exact immutable head SHA');
    if (!QUALIFYING_MERGE_QUEUE_STATES.includes(entry.state)) throw new QueueValidationError('constituent merge queue entry is locked, unmergeable, or unknown');
    if (pull.state !== 'OPEN' || pull.baseRefName !== branch || pull.repository?.nameWithOwner !== repository) throw new QueueValidationError('constituent live PR is closed or targets a different repository or branch');
  }
  return { id: queue.id, entries };
}

export async function verifyMergeGroup({ repository, branch, event, expectedHeadSha, token, fetchImpl = globalThis.fetch }) {
  const failures = [];
  const identityFailure = mergeGroupIdentityFailure({ repository, branch, event, expectedHeadSha });
  if (identityFailure) return { failures: [identityFailure] };
  const normalizedBranch = normalizeBranch(branch);
  const group = event?.merge_group;
  const prefix = `refs/heads/gh-readonly-queue/${normalizedBranch}/`;
  const match = /^pr-([1-9][0-9]*)-[0-9a-f]{7,40}$/u.exec(group.head_ref.slice(prefix.length));
  const currentNumber = Number(match?.[1]);
  const [owner, name] = repository.split('/');
  const identity = { repository, branch: normalizedBranch, group, currentNumber };
  const readQueue = async () => selectConstituents(await githubJson('https://api.github.com/graphql', token, fetchImpl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUEUE_QUERY, variables: { owner, name, branch: normalizedBranch } }),
  }), identity);
  let queue;
  try {
    queue = await readQueue();
  } catch (error) {
    // Network exceptions may contain authenticated URLs or headers.
    return { failures: [error instanceof QueueValidationError ? error.message : 'merge queue lookup is unavailable'] };
  }
  for (const entry of queue.entries) {
    const { number, headRefOid: headSha } = entry.pullRequest;
    try {
      const checks = await githubJson(`https://api.github.com/repos/${repository}/commits/${headSha}/check-runs?filter=all&per_page=100`, token, fetchImpl);
      // Never reuse a green run from a partial page hiding a newer failure.
      if (!Number.isSafeInteger(checks?.total_count) || !Array.isArray(checks?.check_runs)
          || checks.total_count !== checks.check_runs.length || checks.total_count > 100) {
        failures.push(`PR #${number}: check-run pagination is incomplete or unknown`);
        continue;
      }
      const result = evaluateExactCheckRuns(checks.check_runs, headSha);
      for (const failure of result.failures) failures.push(`PR #${number}: ${failure}`);
    } catch {
      failures.push(`PR #${number}: exact-head check lookup is unavailable`);
    }
  }
  if (failures.length === 0) {
    try {
      const fresh = await readQueue();
      const signature = (value) => JSON.stringify({ id: value.id, entries: value.entries.map((entry) => ({
        number: entry.pullRequest.number, head: entry.pullRequest.headRefOid, position: entry.position,
      })) });
      if (signature(fresh) !== signature(queue)) failures.push('merge queue changed during exact-head qualification');
    } catch {
      failures.push('merge queue revalidation is unavailable or no longer matches the event');
    }
  }
  return { failures, entries: queue.entries };
}

function boundedSummary(failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return 'Every merge-group constituent has a successful exact-head Review Yeti check from the official App.';
  }
  return failures.slice(0, 12).map((failure) => `- ${String(failure).slice(0, 500)}`).join('\n').slice(0, 6_000);
}

async function createSyntheticCheck({ repository, expectedHeadSha, token, fetchImpl = globalThis.fetch }) {
  const check = await githubJson(`https://api.github.com/repos/${repository}/check-runs`, token, fetchImpl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      name: 'Review Yeti',
      head_sha: expectedHeadSha,
      status: 'in_progress',
      output: {
        title: 'Review Yeti merge-group verification running',
        summary: 'Validating each queued pull request against its latest exact-head native Review Yeti verdict.',
      },
    },
  });
  if (!Number.isSafeInteger(Number(check?.id)) || Number(check.id) < 1) {
    throw new Error('Review Yeti check creation returned no immutable check id');
  }
  return Number(check.id);
}

async function completeSyntheticCheck({ repository, checkId, token, fetchImpl = globalThis.fetch, failures, entryCount }) {
  const success = failures.length === 0;
  await githubJson(`https://api.github.com/repos/${repository}/check-runs/${checkId}`, token, fetchImpl, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: {
      status: 'completed',
      conclusion: success ? 'success' : 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title: success ? 'Review Yeti merge group approved' : 'Review Yeti merge group rejected',
        summary: success
          ? `${boundedSummary([])} Verified ${entryCount} constituent(s).`
          : boundedSummary(failures),
      },
    },
  });
}

export async function runMergeGroupGate(options, runtimeFetch = globalThis.fetch) {
  const identityFailure = mergeGroupIdentityFailure(options);
  if (identityFailure) return { failures: [identityFailure], entries: [] };
  const resolvedOptions = { ...options, fetchImpl: options.fetchImpl || runtimeFetch };
  const checkId = await createSyntheticCheck(resolvedOptions);
  let result;
  try {
    result = await verifyMergeGroup(resolvedOptions);
  } catch {
    result = { failures: ['merge-group verification failed unexpectedly'], entries: [] };
  }
  try {
    await completeSyntheticCheck({
      ...options,
      fetchImpl: resolvedOptions.fetchImpl,
      checkId,
      failures: result.failures,
      entryCount: result.entries?.length || 0,
    });
  } catch {
    throw new Error('Review Yeti synthetic check could not be completed');
  }
  return { ...result, checkId };
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'merge_group') {
    console.error('::error::Review Yeti merge-group verifier requires a merge_group event');
    process.exitCode = 1;
    return;
  }
  const result = await runMergeGroupGate({
    repository: process.env.INPUT_REPOSITORY,
    branch: process.env.INPUT_BRANCH,
    event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
    expectedHeadSha: process.env.GITHUB_SHA,
    token: process.env.INPUT_REVIEW_YETI_TOKEN,
  });
  if (result.failures.length > 0) {
    for (const failure of result.failures.slice(0, 12)) console.error(`::error::${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Verified exact-head Review Yeti checks for ${result.entries.length} merge-group constituent(s).`);
}

if (isEntrypoint(import.meta.url)) main().catch((error) => {
  const safeDiagnostic = /^(?:GitHub (?:GET|POST|PATCH) (?:request failed (?:before response|with HTTP (?:[1-5][0-9]{2}|unknown))|response was not valid JSON)|Review Yeti check creation returned no immutable check id)$/u;
  const message = error instanceof Error && safeDiagnostic.test(error.message)
    ? error.message
    : 'Review Yeti merge-group verification failed';
  console.error(`::error::${message}`);
  process.exitCode = 1;
});
