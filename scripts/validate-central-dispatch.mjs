import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { resolve } from 'node:path';

import { isEntrypoint } from './entrypoint-guard.mjs';
export const CENTRAL_REPOSITORY = 'exampleorg/example-review-actions';
// Repositories admitted to the central dispatch boundary. ADR 0519 replaced the
// fixed three-repository list with an owner check plus a per-repository
// concurrency cap: admission is earned by landing the base-owned caller on the
// target's default branch, which already requires write plus review there, and
// the shared Ollama lane is protected by the cap rather than by list
// membership. ADR 0490 still governs the lane itself.
export const TARGET_OWNER = 'exampleorg';
// A GitHub repository name: no slashes, no leading dot, no path traversal.
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u;
export const TARGET_REPOSITORY = 'exampleorg/example-api';

// Peak observed central concurrency over a 17.4h / 100-run sample was 4 global,
// and 4 / 3 / 2 for example-release / example-meta / example-api. Six is above every
// observed per-repository peak and well under the shared Ollama budget, so it
// bounds a runaway repository without throttling normal traffic. Override for
// an incident with CT_REVIEW_REPOSITORY_CONCURRENCY_CAP.
export const DEFAULT_REPOSITORY_CONCURRENCY_CAP = 6;

// A per-repository cap alone does not bound the shared provider. Admission is
// owner-based, so N admitted repositories could each sit at the per-repository
// cap and demand 6N upstream slots against a lane of roughly ten. The global cap
// is what actually protects the provider; the per-repository cap only stops one
// repository monopolising whatever the global cap allows. Eight leaves headroom
// below the lane's capacity while clearing the observed global peak of four.
export const DEFAULT_GLOBAL_CONCURRENCY_CAP = 8;

// With no usable count, a permissive fallback would silently delete both caps
// exactly when the provider is most likely to be under stress. Admitting a small
// number keeps a legitimate review moving without pretending the lane is empty.
export const DEGRADED_CONCURRENCY_ALLOWANCE = 1;

// A dispatched-but-not-started run is `queued` and still consumes a slot.
export const CAPACITY_RUN_STATUSES = Object.freeze(['queued', 'in_progress']);

function positiveIntegerFromEnv(raw, name, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function repositoryConcurrencyCap(env = process.env) {
  return positiveIntegerFromEnv(
    env?.CT_REVIEW_REPOSITORY_CONCURRENCY_CAP,
    'CT_REVIEW_REPOSITORY_CONCURRENCY_CAP',
    DEFAULT_REPOSITORY_CONCURRENCY_CAP,
  );
}

export function globalConcurrencyCap(env = process.env) {
  return positiveIntegerFromEnv(
    env?.CT_REVIEW_GLOBAL_CONCURRENCY_CAP,
    'CT_REVIEW_GLOBAL_CONCURRENCY_CAP',
    DEFAULT_GLOBAL_CONCURRENCY_CAP,
  );
}

export function assertAdmittedRepository(repository) {
  if (typeof repository !== 'string') throw new Error('repository must be a string');
  const [owner, name, ...rest] = repository.split('/');
  if (owner !== TARGET_OWNER || rest.length > 0 || !REPOSITORY_NAME_PATTERN.test(name ?? '')) {
    throw new Error(`repository must be a ${TARGET_OWNER}/<repo> repository, got '${repository}'`);
  }
  return name;
}
export const DISPATCH_EVENT_TYPE = 'review-yeti-request';
export const CALLER_WORKFLOW_PATH = '.github/workflows/ct-review-bot.yml';
export const REQUIRED_REVIEW_CONTEXT = 'Review Yeti';
export const REQUIRED_REVIEW_APP_ID = 4385771;
export const REQUIRED_REVIEW_APP_SLUG = 'ct-review-bot';
export const CHECK_RUN_PAGE_SIZE = 100;
export const CHECK_RUN_ENDPOINT_CAP = 1000;

const PAYLOAD_KEYS = Object.freeze(['base_sha', 'head_sha', 'pr_number', 'repository', 'request_id']);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REQUEST_ID_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,99}):([1-9][0-9]*):([0-9a-f]{40}):([1-9][0-9]*):([1-9][0-9]*)$/u;
const PROVIDER_SECRET_PATTERN = /(?:OLLAMA_PR_REVIEW_API_KEY|OPENROUTER(?:_PR_REVIEW_API_KEY|_REVIEW_FLEET_KEY|_API_KEY)|FIREWORKS_PR_REVIEW_API_KEY|SYNTHETIC_API_KEY|GEMINI_API_KEY)/u;
const WORKER_EXTERNAL_ID_PATTERN = /^run_[a-f0-9]{32}:a([1-9][0-9]*)$/u;
const MERGE_GROUP_EXTERNAL_ID_PATTERN = /^merge-group:([a-f0-9]{40})$/u;
const CHECK_RUN_STATUSES = new Set(['completed', 'in_progress', 'pending', 'queued', 'requested', 'waiting']);
const CHECK_RUN_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
]);
const RECOVERABLE_INFRASTRUCTURE_CHECK_TITLES = new Set([
  'Review Yeti: review did not complete',
  'Review Yeti: NO VERDICT (no panel result for this head)',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function validateDispatchPayload(payload) {
  assertPlainObject(payload, 'client_payload');
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(PAYLOAD_KEYS)) {
    throw new Error(`client_payload must contain exactly: ${PAYLOAD_KEYS.join(', ')}`);
  }
  assertAdmittedRepository(payload.repository);
  if (!Number.isSafeInteger(payload.pr_number) || payload.pr_number < 1) {
    throw new Error('pr_number must be a positive safe integer');
  }
  for (const key of ['base_sha', 'head_sha']) {
    if (!SHA_PATTERN.test(payload[key])) throw new Error(`${key} must be a lowercase 40-character Git SHA`);
  }
  const requestIdentity = REQUEST_ID_PATTERN.exec(payload.request_id);
  if (!requestIdentity) {
    throw new Error('request_id must be <repo-name>:<pr_number>:<head_sha>:<github.run_id>:<github.run_attempt>');
  }
  const requestRepoName = requestIdentity[1];
  if (payload.repository !== `exampleorg/${requestRepoName}`) {
    throw new Error('request_id repo-name must match the payload repository');
  }
  if (Number(requestIdentity[2]) !== payload.pr_number || requestIdentity[3] !== payload.head_sha) {
    throw new Error('request_id must bind the payload PR number and head SHA');
  }
  return { ...payload };
}

export function validateExecutionContext({ repository, eventName, eventAction }) {
  if (repository !== CENTRAL_REPOSITORY) {
    throw new Error(`central execution must run in ${CENTRAL_REPOSITORY}`);
  }
  if (eventName === 'workflow_dispatch') {
    return;
  }
  if (eventName !== 'repository_dispatch' || eventAction !== DISPATCH_EVENT_TYPE) {
    throw new Error(`central execution requires repository_dispatch action ${DISPATCH_EVENT_TYPE} or workflow_dispatch`);
  }
}

export function validateCallerWorkflow(content) {
  if (typeof content !== 'string' || content.length === 0 || content.length > 262144) {
    throw new Error('base-owned caller workflow is missing or outside the size limit');
  }
  const required = [
    'repos/exampleorg/example-review-actions/dispatches',
    DISPATCH_EVENT_TYPE,
  ];
  for (const marker of required) {
    if (!content.includes(marker)) throw new Error(`base-owned caller workflow is missing central marker: ${marker}`);
  }
  if (/review-yeti\.yml@/u.test(content)) {
    throw new Error('base-owned caller workflow must use central dispatch instead of calling the reusable review workflow');
  }
  if (/secrets\s*:\s*inherit/u.test(content)) {
    throw new Error('base-owned caller workflow must not inherit secrets');
  }
  if (PROVIDER_SECRET_PATTERN.test(content)) {
    throw new Error('base-owned caller workflow must not reference provider credentials');
  }
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function githubJson(url, token, fetchImpl) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('a Review Yeti App token (GH_TOKEN) is required for central target access');
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response?.ok) throw new Error(`GitHub target lookup failed with HTTP ${response?.status ?? 'unknown'}`);
  return response.json();
}

function assertNullableString(value, label) {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${label} must be a string or null`);
  }
}

function validateExactHeadReviewCheck(row, expectedHeadSha) {
  assertPlainObject(row, 'check-run row');
  if (!Number.isSafeInteger(row.id) || row.id < 1) {
    throw new Error('check-run row id must be a positive safe integer');
  }
  if (row.name !== REQUIRED_REVIEW_CONTEXT) {
    throw new Error(`check-run ${row.id} name is not ${REQUIRED_REVIEW_CONTEXT}`);
  }
  if (row.head_sha !== expectedHeadSha) {
    throw new Error(`check-run ${row.id} is not bound to the exact requested head`);
  }
  assertPlainObject(row.app, `check-run ${row.id} app`);
  if (row.app.id !== REQUIRED_REVIEW_APP_ID || row.app.slug !== REQUIRED_REVIEW_APP_SLUG) {
    throw new Error(`check-run ${row.id} is not owned by the required Review Yeti App`);
  }
  if (!CHECK_RUN_STATUSES.has(row.status)) {
    throw new Error(`check-run ${row.id} status is invalid`);
  }
  if (row.status === 'completed') {
    if (!CHECK_RUN_CONCLUSIONS.has(row.conclusion)) {
      throw new Error(`completed check-run ${row.id} conclusion is invalid`);
    }
  } else if (row.conclusion !== null) {
    throw new Error(`non-completed check-run ${row.id} must have a null conclusion`);
  }
  assertPlainObject(row.output, `check-run ${row.id} output`);
  if (typeof row.output.title !== 'string' || row.output.title.length === 0) {
    throw new Error(`check-run ${row.id} output.title must be a non-empty string`);
  }
  if (typeof row.output.summary !== 'string') {
    throw new Error(`check-run ${row.id} output.summary must be a string`);
  }
  assertNullableString(row.output.text, `check-run ${row.id} output.text`);
  if (typeof row.external_id !== 'string' || row.external_id.length === 0) {
    throw new Error(`check-run ${row.id} external_id must be a non-empty string`);
  }
  const workerIdentity = WORKER_EXTERNAL_ID_PATTERN.exec(row.external_id);
  if (workerIdentity) {
    const attempt = Number(workerIdentity[1]);
    if (!Number.isSafeInteger(attempt)) {
      throw new Error(`check-run ${row.id} external_id attempt exceeds the safe integer range`);
    }
    return { row, kind: 'worker', attempt };
  }
  const mergeGroupIdentity = MERGE_GROUP_EXTERNAL_ID_PATTERN.exec(row.external_id);
  if (mergeGroupIdentity) {
    if (mergeGroupIdentity[1] !== expectedHeadSha) {
      throw new Error(`check-run ${row.id} merge-group external_id is not bound to the exact requested head`);
    }
    return { row, kind: 'merge-group', attempt: null };
  }
  throw new Error(`check-run ${row.id} external_id is not a valid worker or merge-group identity`);
}

export async function listExactHeadReviewChecks({ repository, headSha, token, fetchImpl = globalThis.fetch }) {
  const apiBase = `https://api.github.com/repos/${repository}`;
  const rows = [];
  const identities = [];
  const seenIds = new Set();
  let expectedTotal = null;

  for (let pageNumber = 1; pageNumber <= CHECK_RUN_ENDPOINT_CAP / CHECK_RUN_PAGE_SIZE; pageNumber += 1) {
    const query = new URLSearchParams({
      check_name: REQUIRED_REVIEW_CONTEXT,
      filter: 'all',
      app_id: String(REQUIRED_REVIEW_APP_ID),
      per_page: String(CHECK_RUN_PAGE_SIZE),
      page: String(pageNumber),
    });
    const page = await githubJson(`${apiBase}/commits/${headSha}/check-runs?${query}`, token, fetchImpl);
    assertPlainObject(page, `check-runs page ${pageNumber}`);
    if (!Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new Error(`check-runs page ${pageNumber} total_count must be a non-negative safe integer`);
    }
    if (page.total_count >= CHECK_RUN_ENDPOINT_CAP) {
      throw new Error(`Review Yeti check inventory reaches or exceeds the ${CHECK_RUN_ENDPOINT_CAP}-run endpoint cap`);
    }
    if (expectedTotal === null) {
      expectedTotal = page.total_count;
    } else if (page.total_count !== expectedTotal) {
      throw new Error(`Review Yeti check inventory total_count changed from ${expectedTotal} to ${page.total_count}`);
    }
    if (!Array.isArray(page.check_runs)) {
      throw new Error(`check-runs page ${pageNumber} check_runs must be an array`);
    }
    if (page.check_runs.length > CHECK_RUN_PAGE_SIZE) {
      throw new Error(`check-runs page ${pageNumber} exceeds the requested page size`);
    }

    for (const row of page.check_runs) {
      const identity = validateExactHeadReviewCheck(row, headSha);
      if (seenIds.has(row.id)) {
        throw new Error(`Review Yeti check inventory contains duplicate check-run id ${row.id}`);
      }
      seenIds.add(row.id);
      rows.push(row);
      identities.push(identity);
    }
    if (rows.length > expectedTotal) {
      throw new Error(`Review Yeti check inventory returned ${rows.length} rows for total_count ${expectedTotal}`);
    }
    if (rows.length === expectedTotal) {
      return { rows, identities, totalCount: expectedTotal };
    }
    if (page.check_runs.length === 0 || page.check_runs.length < CHECK_RUN_PAGE_SIZE) {
      throw new Error(`Review Yeti check inventory is truncated at ${rows.length} of ${expectedTotal} rows`);
    }
  }
  throw new Error(`Review Yeti check inventory is truncated at the ${CHECK_RUN_ENDPOINT_CAP}-run endpoint cap`);
}

function isRecoverableFirstAttempt(identity) {
  return identity.attempt === 1
    && identity.row.status === 'completed'
    && identity.row.conclusion === 'failure'
    && RECOVERABLE_INFRASTRUCTURE_CHECK_TITLES.has(identity.row.output.title);
}

export function assertReviewGeneration({ callerRunAttempt, inventory }) {
  if (callerRunAttempt !== 1 && callerRunAttempt !== 2) {
    throw new Error(`caller run attempt ${callerRunAttempt} is outside the admitted generations a1 and a2`);
  }
  const workers = inventory.identities.filter((identity) => identity.kind === 'worker');
  if (callerRunAttempt === 1) {
    if (workers.length !== 0) {
      throw new Error(`caller attempt 1 requires zero worker checks; found ${workers.length}`);
    }
    return {
      review_generation: 1,
      review_check_count: inventory.rows.length,
      worker_check_count: 0,
      latest_worker_check_id: '',
    };
  }

  const replacement = workers.find((identity) => identity.attempt >= 2);
  if (replacement) {
    throw new Error(`worker attempt a${replacement.attempt} already exists for this exact head`);
  }
  if (workers.length !== 1) {
    throw new Error(`caller attempt 2 requires exactly one worker a1; found ${workers.length} worker checks`);
  }
  const [firstAttempt] = workers;
  if (!isRecoverableFirstAttempt(firstAttempt)) {
    throw new Error('a1 worker is not a completed recoverable infrastructure failure');
  }
  return {
    review_generation: 2,
    review_check_count: inventory.rows.length,
    worker_check_count: workers.length,
    latest_worker_check_id: firstAttempt.row.id,
  };
}

// ADR 0519: the shared Ollama lane is protected by a per-repository cap rather
// than by a fixed repository allowlist. Count this repository's in-flight
// central runs and refuse admission above the cap, so one repository cannot
// occupy the budget that a required merge gate depends on. The refusal is
// retryable: it reports capacity, not a policy violation.
export async function assertRepositoryCapacity({
  repositoryName,
  token,
  fetchImpl = globalThis.fetch,
  cap = repositoryConcurrencyCap(),
  globalCap = globalConcurrencyCap(),
  selfRunId = process.env.GITHUB_RUN_ID,
}) {
  // A dispatched run that has not yet started a job is `queued`, not
  // `in_progress`, and it will still consume an upstream slot. Counting only
  // in-progress runs undercounts exactly during the burst the cap exists for,
  // making the cap advisory when it matters most. Count both states.
  const listUrl = (status) => `https://api.github.com/repos/${CENTRAL_REPOSITORY}`
    + '/actions/workflows/repository-dispatch.yml/runs'
    + `?status=${status}&per_page=100`;

  // Both listings answer both caps, so the global bound costs no extra
  // round-trip beyond the states it must observe. Retry once: the preceding
  // identity lookups already proved the API reachable, so a single failure here
  // is far more likely transient than an outage.
  async function listRuns() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const pages = await Promise.all(
          CAPACITY_RUN_STATUSES.map((status) => githubJson(listUrl(status), token, fetchImpl)),
        );
        return pages;
      } catch {
        // fall through to retry
      }
    }
    return null;
  }

  const pages = await listRuns();
  const runs = pages === null ? null : {
    // Dedupe by id: a run can change state between the two listings.
    workflow_runs: [...new Map(
      pages.flatMap((page) => (Array.isArray(page?.workflow_runs) ? page.workflow_runs : []))
        .map((run) => [run?.id, run]),
    ).values()],
  };

  if (runs === null) {
    // Degraded: no count is available. Rejecting outright would fail a required
    // merge gate closed on a transient listing error; admitting without limit
    // would delete both caps precisely when the lane is likely stressed. Admit a
    // small allowance and report it, so the degradation is visible rather than
    // silent.
    return {
      cap,
      globalCap,
      inFlight: null,
      globalInFlight: null,
      degraded: true,
      allowance: DEGRADED_CONCURRENCY_ALLOWANCE,
    };
  }

  const all = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  const others = all.filter((run) => !(selfRunId && String(run?.id) === String(selfRunId)));
  const globalInFlight = others.length;
  const prefix = `${repositoryName}:`;
  // display_title carries the request_id, whose first field is the repo name.
  const inFlight = others.filter((run) => (typeof run?.display_title === 'string' ? run.display_title : '').includes(prefix)).length;

  if (globalInFlight >= globalCap) {
    throw new Error(
      `central review lane already has ${globalInFlight} reviews in flight `
      + `(global cap ${globalCap}); retry when capacity frees`,
    );
  }
  if (inFlight >= cap) {
    throw new Error(
      `repository ${repositoryName} already has ${inFlight} central reviews in flight `
      + `(cap ${cap}); retry when capacity frees`,
    );
  }
  return { cap, globalCap, inFlight, globalInFlight, degraded: false };
}

export async function validateCentralDispatch({ payload, token, fetchImpl = globalThis.fetch }) {
  const request = validateDispatchPayload(payload);
  const [, , , , callerRunIdText, callerRunAttemptText] = REQUEST_ID_PATTERN.exec(request.request_id);
  const callerRunId = Number(callerRunIdText);
  const callerRunAttempt = Number(callerRunAttemptText);
  if (!Number.isSafeInteger(callerRunId) || !Number.isSafeInteger(callerRunAttempt)) {
    throw new Error('request_id run identity exceeds the safe integer range');
  }
  const apiBase = `https://api.github.com/repos/${request.repository}`;
  const pull = await githubJson(`${apiBase}/pulls/${request.pr_number}`, token, fetchImpl);
  if (pull?.base?.repo?.full_name !== request.repository) throw new Error('PR repository identity changed');
  if (pull?.state !== 'open') throw new Error('PR is not open');
  if (pull?.base?.sha !== request.base_sha) throw new Error('PR base SHA changed');
  if (pull?.head?.sha !== request.head_sha) throw new Error('PR head SHA changed');

  const callerRun = await githubJson(`${apiBase}/actions/runs/${callerRunId}`, token, fetchImpl);
  if (callerRun?.repository?.full_name !== request.repository) throw new Error('caller run repository identity changed');
  if (callerRun?.event !== 'pull_request_target') throw new Error('caller run must use pull_request_target');
  if (callerRun?.path !== CALLER_WORKFLOW_PATH) throw new Error('caller run workflow path changed');
  // A pull_request_target run reports the PR *head* as head_sha and the PR source branch as
  // head_branch (the base-owned workflow code is what executes, but the run identity is the PR).
  // Bind the caller run to the exact requested PR head; the base-owned workflow bytes are read
  // from the base branch below.
  if (callerRun?.head_sha !== request.head_sha) throw new Error('caller run is not bound to the requested PR head');
  if (typeof pull?.head?.ref === 'string' && callerRun?.head_branch !== pull.head.ref) {
    throw new Error('caller run is not bound to the PR source branch');
  }
  if (callerRun?.run_attempt !== callerRunAttempt) throw new Error('caller run attempt changed');
  if (!Array.isArray(callerRun?.pull_requests)
      || !callerRun.pull_requests.some((candidate) => candidate?.number === request.pr_number)) {
    throw new Error('caller run is not bound to the requested PR');
  }

  // Capacity is checked only after identity is proven, so an invalid request
  // reports the validation failure rather than a misleading capacity message.
  await assertRepositoryCapacity({
    repositoryName: assertAdmittedRepository(request.repository),
    token,
    fetchImpl,
  });

  // repository-dispatch.yml serializes this exact repository/PR/head for the
  // full validation + DOKS admission run. Re-read the App-owned check ledger
  // while holding that lease; the DOKS service then owns the durable request
  // identity and compare-and-swap allocation of the admitted worker attempt.
  const reviewInventory = await listExactHeadReviewChecks({
    repository: request.repository,
    headSha: request.head_sha,
    token,
    fetchImpl,
  });
  const generation = assertReviewGeneration({ callerRunAttempt, inventory: reviewInventory });

  // The base-owned caller workflow. Live evidence (example-api #4804, base 0.8.8-stable, run
  // 33675866048): GitHub executed the caller from the repository DEFAULT branch — whose
  // pull_request_target filter lists every stable line — not the PR base branch's copy. Read
  // the caller from the default branch so the contract checks the bytes that actually ran.
  const defaultBranch = pull?.base?.repo?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) throw new Error('repository default branch is missing');
  const workflowUrl = `${apiBase}/contents/${CALLER_WORKFLOW_PATH}?ref=${encodeURIComponent(defaultBranch)}`;
  const workflow = await githubJson(workflowUrl, token, fetchImpl);
  if (workflow?.encoding !== 'base64' || typeof workflow.content !== 'string') {
    throw new Error('base-owned caller workflow response is invalid');
  }
  let callerContent;
  try {
    callerContent = Buffer.from(workflow.content.replace(/\s+/gu, ''), 'base64').toString('utf8');
  } catch {
    throw new Error('base-owned caller workflow could not be decoded');
  }
  const callerWorkflowSha256 = validateCallerWorkflow(callerContent);
  return {
    ...request,
    caller_run_id: callerRunId,
    caller_run_attempt: callerRunAttempt,
    caller_workflow_sha256: callerWorkflowSha256,
    ...generation,
  };
}

function writeOutputs(result, outputPath) {
  if (!outputPath) return;
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

async function main() {
  validateExecutionContext({
    repository: process.env.GITHUB_REPOSITORY,
    eventName: process.env.GITHUB_EVENT_NAME,
    eventAction: process.env.GITHUB_EVENT_ACTION,
  });
  let payload;
  try {
    payload = JSON.parse(process.env.CENTRAL_DISPATCH_PAYLOAD || '');
  } catch {
    throw new Error('CENTRAL_DISPATCH_PAYLOAD must be valid JSON');
  }
  const result = await validateCentralDispatch({
    payload,
    token: process.env.GH_TOKEN,
  });
  writeOutputs(result, process.env.GITHUB_OUTPUT);
  console.log(`Validated central Review Yeti request ${result.request_id} for ${result.repository}#${result.pr_number} at exact head ${result.head_sha}.`);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Central Review Yeti dispatch rejected: ${error.message}`);
    process.exitCode = 1;
  });
}
