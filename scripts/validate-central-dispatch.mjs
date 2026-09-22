import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { resolve } from 'node:path';

import { isEntrypoint } from './entrypoint-guard.mjs';
export const CENTRAL_REPOSITORY = 'exampleorg/example-review-actions';
// Repositories admitted to the central dispatch boundary. ADR 0519 replaced the
// fixed exampleorg repository list with an owner check plus a per-repository
// concurrency cap. The public Review Yeti self-review is the sole cross-owner
// exception and is bound to one exact repository and one exact caller workflow;
// its target and central installation tokens are always distinct.
// ADR 0490 still governs the shared lane itself.
export const TARGET_OWNER = 'exampleorg';
// A GitHub repository name: no slashes, no leading dot, no path traversal.
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u;
export const TARGET_REPOSITORY = 'exampleorg/example-api';
export const REVIEW_YETI_REPOSITORY = 'review-yeti-ai/review-yeti-bot';

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

export const DISPATCH_EVENT_TYPE = 'review-yeti-request';
export const CALLER_WORKFLOW_PATH = '.github/workflows/ct-review-bot.yml';
export const REVIEW_YETI_CALLER_WORKFLOW_PATH = CALLER_WORKFLOW_PATH;

export function resolveAdmittedTarget(repository) {
  if (typeof repository !== 'string') throw new Error('repository must be a string');
  const [owner, name, ...rest] = repository.split('/');
  if (owner === TARGET_OWNER && rest.length === 0 && REPOSITORY_NAME_PATTERN.test(name ?? '')) {
    return {
      owner,
      name,
      repository,
      callerWorkflowPath: CALLER_WORKFLOW_PATH,
    };
  }
  if (repository === REVIEW_YETI_REPOSITORY) {
    return {
      owner: 'review-yeti-ai',
      name: 'review-yeti-bot',
      repository,
      callerWorkflowPath: REVIEW_YETI_CALLER_WORKFLOW_PATH,
    };
  }
  throw new Error(
    `repository is not admitted; repository must be a ${TARGET_OWNER}/<repo> repository or exactly ${REVIEW_YETI_REPOSITORY}, got '${repository}'`,
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
export const REQUIRED_REVIEW_CONTEXT = 'Review Yeti';
export const REQUIRED_REVIEW_APP_ID = 4385771;
export const REQUIRED_REVIEW_APP_SLUG = 'ct-review-bot';
export const CHECK_RUN_PAGE_SIZE = 100;
export const CHECK_RUN_ENDPOINT_CAP = 1000;
export const CAPACITY_RUN_PAGE_SIZE = 100;
export const CAPACITY_RUN_ENDPOINT_CAP = 1000;
export const MAX_REVIEW_GENERATIONS = 3;

const PAYLOAD_KEYS = Object.freeze(['base_sha', 'head_sha', 'pr_number', 'repository', 'request_id']);
const REFRESH_PAYLOAD_KEYS = Object.freeze([...PAYLOAD_KEYS, 'refresh_requested'].sort());
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_DISPATCH_PR_NUMBER_PATTERN = /^[1-9][0-9]*$/u;
const REQUEST_ID_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,99}):([1-9][0-9]*):([0-9a-f]{40}):([1-9][0-9]*):([1-9][0-9]*)$/u;
const PROVIDER_SECRET_PATTERN = /(?:OLLAMA_PR_REVIEW_API_KEY|OPENROUTER(?:_PR_REVIEW_API_KEY|_REVIEW_FLEET_KEY|_API_KEY)|FIREWORKS_PR_REVIEW_API_KEY|SYNTHETIC_API_KEY|GEMINI_API_KEY)/u;
const PUBLIC_DISPATCH_APP_ACTION_PATTERN = /^actions\/create-github-app-token@[0-9a-f]{40}$/u;
const PUBLIC_DISPATCH_ALLOWED_SECRETS = Object.freeze([
  'REVIEW_YETI_DISPATCH_APP_ID',
  'REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY',
]);
const WORKER_EXTERNAL_ID_PATTERN = /^(run_[a-f0-9]{32}):a([1-9][0-9]*)$/u;
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
// REL-940: conclusions that mark a prior attempt as a recoverable
// INFRASTRUCTURE failure rather than a verdict about the diff.
//
// `failure` is what the engine has always published for these titles.
// `action_required` is accepted so the engine can migrate to it -- it is the
// semantically correct "no verdict, operator action needed" conclusion, and it
// blocks merge exactly like `failure`. Accepting both here FIRST means the
// engine can switch without a flag-day: this validator must never be the thing
// that refuses same-head regeneration during that migration.
//
// `neutral` and `skipped` are deliberately absent and must stay absent: GitHub
// treats both as PASSING for required status checks, so admitting either here
// would let an infrastructure failure read as an approval.
const RECOVERABLE_INFRASTRUCTURE_CONCLUSIONS = new Set([
  'failure',
  'action_required',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

// GitHub serializes workflow_dispatch number inputs as strings in the event
// context. Normalize that one trusted workflow boundary before the strict
// dispatch validator runs; repository_dispatch values and types remain
// untouched so their type contract stays fail-closed. The receiver carries a
// workflow-owned equivalent to tolerate main/v1 skew; boundary tests cover both.
export function normalizeCentralDispatchPayload({ eventName, payload, runId, runAttempt }) {
  if (eventName !== 'workflow_dispatch') return payload;

  assertPlainObject(payload, 'workflow_dispatch inputs');

  const rawPrNumber = payload.pr_number;
  const prNumber = typeof rawPrNumber === 'number'
    ? rawPrNumber
    : typeof rawPrNumber === 'string' && WORKFLOW_DISPATCH_PR_NUMBER_PATTERN.test(rawPrNumber)
      ? Number(rawPrNumber)
      : NaN;

  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('workflow_dispatch pr_number must be a positive safe integer');
  }

  const rawRefreshRequested = payload.refresh_requested;
  const refreshRequested = rawRefreshRequested === true || rawRefreshRequested === 'true'
    ? true
    : rawRefreshRequested === false || rawRefreshRequested === 'false'
      ? false
      : null;

  if (refreshRequested === null) {
    throw new Error('workflow_dispatch refresh_requested must be a boolean');
  }

  let requestId = payload.request_id;
  if (requestId === undefined || requestId === '') {
    const repositoryName = typeof payload.repository === 'string' ? payload.repository.split('/')[1] : '';
    const executionRunId = typeof runId === 'number' ? runId
      : typeof runId === 'string' && WORKFLOW_DISPATCH_PR_NUMBER_PATTERN.test(runId) ? Number(runId) : NaN;
    const executionRunAttempt = typeof runAttempt === 'number' ? runAttempt
      : typeof runAttempt === 'string' && WORKFLOW_DISPATCH_PR_NUMBER_PATTERN.test(runAttempt) ? Number(runAttempt) : NaN;
    if (!repositoryName || !REPOSITORY_NAME_PATTERN.test(repositoryName)
        || !Number.isSafeInteger(executionRunId) || executionRunId < 1
        || !Number.isSafeInteger(executionRunAttempt) || executionRunAttempt < 1) {
      throw new Error('workflow_dispatch run identity is invalid');
    }
    requestId = `${repositoryName}:${prNumber}:${payload.head_sha}:${executionRunId}:${executionRunAttempt}`;
  }

  return { ...payload, request_id: requestId, pr_number: prNumber, refresh_requested: refreshRequested };
}

export function validateDispatchPayload(payload) {
  assertPlainObject(payload, 'client_payload');
  const keys = Object.keys(payload).sort();
  const expectedKeys = Object.hasOwn(payload, 'refresh_requested') ? REFRESH_PAYLOAD_KEYS : PAYLOAD_KEYS;
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`client_payload must contain exactly: ${PAYLOAD_KEYS.join(', ')}${expectedKeys === REFRESH_PAYLOAD_KEYS ? ', refresh_requested' : ''}`);
  }
  if (Object.hasOwn(payload, 'refresh_requested') && typeof payload.refresh_requested !== 'boolean') {
    throw new Error('refresh_requested must be a boolean');
  }
  const admittedTarget = resolveAdmittedTarget(payload.repository);
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
  if (admittedTarget.name !== requestRepoName) {
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

function withoutYamlComments(content) {
  return content.split(/\r?\n/u).map((line) => line.replace(/\s+#.*$/u, '')).join('\n');
}

function workflowStepBlocks(content) {
  const lines = content.split(/\r?\n/u);
  const starts = lines
    .map((line, index) => /^\s{6}-\s+/u.test(line) ? index : -1)
    .filter((index) => index >= 0);
  return starts.map((start, index) => lines.slice(start, starts[index + 1]).join('\n'));
}

function compactWorkflowScript(script) {
  return script.replace(/\\\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function validatePublicCallerWorkflow(content) {
  const sha256 = validateCallerWorkflow(content);
  const workflow = withoutYamlComments(content);
  const topLevelKeys = [...workflow.matchAll(/^([A-Za-z0-9_-]+):(?:\s|$)/gmu)].map((match) => match[1]);
  const allowedTopLevelKeys = new Set(['name', 'on', 'permissions', 'jobs']);
  if (topLevelKeys.some((key) => !allowedTopLevelKeys.has(key))) {
    throw new Error('public caller must be a dispatch-only workflow');
  }
  if (!/^\s{2}pull_request_target:\s*$/mu.test(workflow)) {
    throw new Error('public caller must run from pull_request_target');
  }

  const permissionBlock = workflow.match(/^permissions:\s*\n((?: {2}[^\n]*\n?)*)/mu)?.[1] || '';
  const permissionLines = [...permissionBlock.matchAll(/^ {2}([A-Za-z-]+):\s*([^\s]+)\s*$/gmu)]
    .map((match) => `${match[1]}:${match[2]}`);
  if (JSON.stringify(permissionLines) !== JSON.stringify(['contents:read'])) {
    throw new Error('public caller must request only contents:read workflow permissions');
  }
  if (/^ {4,}permissions:\s*$/mu.test(workflow)) {
    throw new Error('public caller must not widen job permissions');
  }

  const secretRefs = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gu)]
    .map((match) => match[1]);
  if (JSON.stringify([...new Set(secretRefs)].sort()) !== JSON.stringify([...PUBLIC_DISPATCH_ALLOWED_SECRETS].sort())) {
    throw new Error('public caller must use only the dedicated dispatch App secrets');
  }
  if (/github\.token|GITHUB_TOKEN|PERSONAL_ACCESS_TOKEN|NPM_TOKEN|\bPAT\b/u.test(workflow)) {
    throw new Error('public caller must not use ambient or personal access tokens');
  }

  const steps = workflowStepBlocks(workflow);
  if (steps.length !== 2) {
    throw new Error('public caller must contain exactly one App-mint step and one dispatch step');
  }
  const actionUses = [...workflow.matchAll(/^\s+uses:\s*([^\s]+)\s*$/gmu)].map((match) => match[1]);
  if (actionUses.length !== 1 || !PUBLIC_DISPATCH_APP_ACTION_PATTERN.test(actionUses[0])) {
    throw new Error('public caller must use exactly one SHA-pinned dispatch App action');
  }
  const appStep = steps.find((step) => step.includes('uses: actions/create-github-app-token@')) || '';
  const dispatchStep = steps.find((step) => step.includes('run: |')) || '';
  if (!appStep || !dispatchStep || appStep.includes('run:') || dispatchStep.includes('uses:')) {
    throw new Error('public caller must contain exactly one App-mint step and one dispatch step');
  }
  for (const marker of [
    'id: dispatch_token',
    'app-id: ${{ secrets.REVIEW_YETI_DISPATCH_APP_ID }}',
    'private-key: ${{ secrets.REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY }}',
    'owner: exampleorg',
    'repositories: example-review-actions',
  ]) {
    if (!appStep.includes(marker)) throw new Error(`public caller dispatch App is missing ${marker}`);
  }
  const appPermissions = [...appStep.matchAll(/^\s+permission-([a-z-]+):\s*([^\s]+)\s*$/gmu)]
    .map((match) => `${match[1]}:${match[2]}`);
  if (JSON.stringify(appPermissions) !== JSON.stringify(['contents:write'])) {
    throw new Error('public caller dispatch App must request only contents:write');
  }
  if (!/^\s+GH_TOKEN:\s*\$\{\{\s*steps\.dispatch_token\.outputs\.token\s*\}\}\s*$/mu.test(dispatchStep)) {
    throw new Error('public caller dispatch must bind GH_TOKEN to the dispatch App output');
  }

  const runBody = dispatchStep.match(/^\s+run:\s*\|\s*\n([\s\S]*)$/mu)?.[1] || '';
  const normalizedScript = compactWorkflowScript(runBody);
  const expectedScript = [
    'set -euo pipefail',
    'jq -n',
    '--arg repository "${{ github.repository }}"',
    '--argjson pr_number "${{ github.event.pull_request.number }}"',
    '--arg base_sha "${{ github.event.pull_request.base.sha }}"',
    '--arg head_sha "${{ github.event.pull_request.head.sha }}"',
    '--arg request_id "${{ github.event.repository.name }}:${{ github.event.pull_request.number }}:${{ github.event.pull_request.head.sha }}:${{ github.run_id }}:${{ github.run_attempt }}"',
    `'{event_type:"${DISPATCH_EVENT_TYPE}",client_payload:{repository:$repository,pr_number:$pr_number,base_sha:$base_sha,head_sha:$head_sha,request_id:$request_id}}'`,
    '| gh api --method POST repos/exampleorg/example-review-actions/dispatches --input -',
  ].join(' ');
  if (normalizedScript !== expectedScript) {
    throw new Error('public caller must perform exactly one coordinate-only central dispatch');
  }
  return sha256;
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

async function assertInstallationTokenScope({ token, owner, repositories, label, fetchImpl }) {
  const scope = await githubJson(
    'https://api.github.com/installation/repositories?per_page=100',
    token,
    fetchImpl,
  );
  assertPlainObject(scope, `${label} installation repository scope`);
  if (!Number.isSafeInteger(scope.total_count) || scope.total_count < 0 || !Array.isArray(scope.repositories)) {
    throw new Error(`${label} installation repository scope is invalid`);
  }
  const owners = scope.repositories.map((repository) => repository?.owner?.login);
  if (owners.some((repositoryOwner) => repositoryOwner !== owner)) {
    throw new Error(`${label} installation owner must be exactly ${owner}`);
  }
  const actual = scope.repositories.map((repository) => repository?.full_name);
  if (actual.some((repository) => typeof repository !== 'string')
      || scope.total_count !== actual.length
      || new Set(actual).size !== actual.length
      || JSON.stringify([...actual].sort()) !== JSON.stringify([...repositories].sort())) {
    throw new Error(`${label} installation repository scope must be exactly ${repositories.join(', ')}`);
  }
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
    const attempt = Number(workerIdentity[2]);
    if (!Number.isSafeInteger(attempt)) {
      throw new Error(`check-run ${row.id} external_id attempt exceeds the safe integer range`);
    }
    return { row, kind: 'worker', attempt, runId: workerIdentity[1] };
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

function isRecoverableInfrastructureAttempt(identity, expectedAttempt) {
  return identity.attempt === expectedAttempt
    && identity.row.status === 'completed'
    && RECOVERABLE_INFRASTRUCTURE_CONCLUSIONS.has(identity.row.conclusion)
    && RECOVERABLE_INFRASTRUCTURE_CHECK_TITLES.has(identity.row.output.title);
}

function assertRecoverablePriorWorkers({ workers, nextGeneration, context }) {
  const replacement = workers.find((identity) => identity.attempt >= nextGeneration);
  if (replacement) {
    throw new Error(`worker attempt a${replacement.attempt} already exists for this exact head`);
  }
  const expectedPriorWorkers = nextGeneration - 1;
  if (workers.length !== expectedPriorWorkers) {
    if (nextGeneration === 2) {
      throw new Error(`${context} requires exactly one worker a1; found ${workers.length} worker checks`);
    }
    throw new Error(
      `${context} requires exactly ${expectedPriorWorkers} prior worker checks; found ${workers.length}`,
    );
  }

  const workerRunIds = new Set(workers.map((identity) => identity.runId));
  if (workerRunIds.size !== 1) {
    throw new Error('prior worker generations must share one DOKS run identity');
  }

  let latestWorker;
  for (let expectedAttempt = 1; expectedAttempt < nextGeneration; expectedAttempt += 1) {
    const matches = workers.filter((identity) => identity.attempt === expectedAttempt);
    if (matches.length !== 1) {
      throw new Error(
        `${context} requires exactly one worker a${expectedAttempt}; found ${matches.length}`,
      );
    }
    const [worker] = matches;
    if (!isRecoverableInfrastructureAttempt(worker, expectedAttempt)) {
      const prefix = context === 'refresh' ? 'refresh ' : '';
      throw new Error(`${prefix}a${expectedAttempt} worker is not a completed recoverable infrastructure failure`);
    }
    latestWorker = worker;
  }
  return latestWorker;
}

export function assertReviewGeneration({ callerRunAttempt, inventory, refreshRequested = false }) {
  if (!Number.isSafeInteger(callerRunAttempt)
      || callerRunAttempt < 1
      || callerRunAttempt > MAX_REVIEW_GENERATIONS) {
    throw new Error(
      `caller run attempt ${callerRunAttempt} is outside the admitted generations a1 through a${MAX_REVIEW_GENERATIONS}`,
    );
  }
  const workers = inventory.identities.filter((identity) => identity.kind === 'worker');
  if (refreshRequested) {
    // A refresh is an explicit, persisted retry request. It is deliberately
    // admitted from either caller run attempt because a GitHub workflow retry
    // must not change the worker generation. The exact-head ledger remains the
    // authority: every prior generation must be a contiguous, completed
    // infrastructure failure from one durable DOKS run identity. The next
    // generation is derived from that ledger, never from the label workflow's
    // own run_attempt (which starts at one for each new label event).
    if (workers.length === 0) {
      throw new Error('refresh requires exactly one worker a1; found 0 worker checks');
    }
    const overLimit = workers.find((identity) => identity.attempt > MAX_REVIEW_GENERATIONS);
    if (overLimit) {
      throw new Error(
        `worker attempt a${overLimit.attempt} exceeds the admitted generation limit a${MAX_REVIEW_GENERATIONS}`,
      );
    }
    const nextGeneration = workers.length + 1;
    const latestWorker = assertRecoverablePriorWorkers({
      workers,
      nextGeneration,
      context: 'refresh',
    });
    if (nextGeneration > MAX_REVIEW_GENERATIONS) {
      throw new Error(`refresh generation limit a${MAX_REVIEW_GENERATIONS} is exhausted`);
    }
    return {
      review_generation: nextGeneration,
      review_check_count: inventory.rows.length,
      worker_check_count: workers.length,
      latest_worker_check_id: latestWorker.row.id,
      refresh_requested: true,
    };
  }
  if (callerRunAttempt === 1) {
    if (workers.length !== 0) {
      throw new Error(`caller attempt 1 requires zero worker checks; found ${workers.length}`);
    }
    return {
      review_generation: 1,
      review_check_count: inventory.rows.length,
      worker_check_count: 0,
      latest_worker_check_id: '',
      refresh_requested: false,
    };
  }

  const latestWorker = assertRecoverablePriorWorkers({
    workers,
    nextGeneration: callerRunAttempt,
    context: `caller attempt ${callerRunAttempt}`,
  });
  return {
    review_generation: callerRunAttempt,
    review_check_count: inventory.rows.length,
    worker_check_count: workers.length,
    latest_worker_check_id: latestWorker.row.id,
    refresh_requested: false,
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
  const listUrl = (status, pageNumber) => `https://api.github.com/repos/${CENTRAL_REPOSITORY}`
    + '/actions/workflows/repository-dispatch.yml/runs'
    + `?status=${status}&per_page=${CAPACITY_RUN_PAGE_SIZE}&page=${pageNumber}`;

  // Both listings answer both caps, so the global bound costs no extra
  // round-trip beyond the states it must observe. Retry once: the preceding
  // identity lookups already proved the API reachable, so a single failure here
  // is far more likely transient than an outage.
  //
  // GitHub's paginated listing is only a page-at-a-time snapshot. A run may move
  // between pages while this bounded read is in progress, so this is not a
  // durable lease or a globally serialized admission. The direct service-owned
  // admission cutover retires this pre-existing race; do not widen this caller
  // into a second lease system.
  async function listStatusRuns(status) {
    const rows = [];
    let expectedTotal = null;
    for (let pageNumber = 1; pageNumber <= CAPACITY_RUN_ENDPOINT_CAP / CAPACITY_RUN_PAGE_SIZE; pageNumber += 1) {
      const page = await githubJson(listUrl(status, pageNumber), token, fetchImpl);
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw new Error(`central ${status} workflow run page is invalid`);
      }
      if (page.total_count !== undefined) {
        if (!Number.isSafeInteger(page.total_count) || page.total_count < 0) {
          throw new Error(`central ${status} workflow run total_count is invalid`);
        }
        if (expectedTotal === null) expectedTotal = page.total_count;
        else if (page.total_count !== expectedTotal) throw new Error(`central ${status} workflow run total_count changed while listing`);
      }
      if (!Array.isArray(page.workflow_runs) || page.workflow_runs.length > CAPACITY_RUN_PAGE_SIZE) {
        throw new Error(`central ${status} workflow run page is invalid`);
      }
      rows.push(...page.workflow_runs);
      if (rows.length > CAPACITY_RUN_ENDPOINT_CAP) throw new Error(`central ${status} workflow run inventory exceeds the endpoint cap`);
      if (expectedTotal !== null && rows.length >= expectedTotal) return rows.slice(0, expectedTotal);
      if (page.workflow_runs.length < CAPACITY_RUN_PAGE_SIZE) return rows;
    }
    throw new Error(`central ${status} workflow run inventory is truncated at the endpoint cap`);
  }

  async function listRuns() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const pages = await Promise.all(
          CAPACITY_RUN_STATUSES.map((status) => listStatusRuns(status)),
        );
        return pages;
      } catch {
        // fall through to retry
      }
    }
    return null;
  }

  const pages = await listRuns();
  if (pages === null) throw new Error('central workflow run capacity listing unavailable after bounded retries');

  // Dedupe by id: a run can change state between the two listings.
  const runs = {
    workflow_runs: [...new Map(
      pages.flatMap((page) => (Array.isArray(page) ? page : []))
        .map((run) => [run?.id, run]),
    ).values()],
  };

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
  return { cap, globalCap, inFlight, globalInFlight };
}

export async function validateCentralDispatch({
  payload,
  token,
  targetToken = token,
  centralToken = token,
  fetchImpl = globalThis.fetch,
  eventName = 'repository_dispatch',
  executionRunId,
  executionRunAttempt,
}) {
  const request = validateDispatchPayload(payload);
  const admittedTarget = resolveAdmittedTarget(request.repository);
  if (admittedTarget.owner !== TARGET_OWNER) {
    if (typeof targetToken !== 'string' || targetToken.length === 0) {
      throw new Error('a target-owner Review Yeti App token is required for central target access');
    }
    if (typeof centralToken !== 'string' || centralToken.length === 0) {
      throw new Error('a central App token is required for central repository access');
    }
    if (targetToken === centralToken) {
      throw new Error('cross-owner validation requires distinct installation tokens');
    }
    await assertInstallationTokenScope({
      token: targetToken,
      owner: admittedTarget.owner,
      repositories: [admittedTarget.repository],
      label: 'target',
      fetchImpl,
    });
    await assertInstallationTokenScope({
      token: centralToken,
      owner: TARGET_OWNER,
      repositories: [CENTRAL_REPOSITORY],
      label: 'central',
      fetchImpl,
    });
  }
  const [, , , , callerRunIdText, callerRunAttemptText] = REQUEST_ID_PATTERN.exec(request.request_id);
  const callerRunId = Number(callerRunIdText);
  const callerRunAttempt = Number(callerRunAttemptText);
  if (!Number.isSafeInteger(callerRunId) || !Number.isSafeInteger(callerRunAttempt)) {
    throw new Error('request_id run identity exceeds the safe integer range');
  }
  const apiBase = `https://api.github.com/repos/${request.repository}`;
  const pull = await githubJson(`${apiBase}/pulls/${request.pr_number}`, targetToken, fetchImpl);
  if (pull?.base?.repo?.full_name !== request.repository) throw new Error('PR repository identity changed');
  if (pull?.state !== 'open') throw new Error('PR is not open');
  if (pull?.base?.sha !== request.base_sha) throw new Error('PR base SHA changed');
  if (pull?.head?.sha !== request.head_sha) throw new Error('PR head SHA changed');
  const directManualDispatch = eventName === 'workflow_dispatch'
    && String(callerRunId) === String(executionRunId)
    && String(callerRunAttempt) === String(executionRunAttempt);
  let callerRun;
  let callerWorkflowPath;
  let callerWorkflowToken;
  let callerWorkflowRepository;
  let callerWorkflowRevision;
  if (directManualDispatch) {
    callerRun = await githubJson(
      `https://api.github.com/repos/${CENTRAL_REPOSITORY}/actions/runs/${callerRunId}`,
      centralToken,
      fetchImpl,
    );
    callerWorkflowPath = '.github/workflows/repository-dispatch.yml';
    callerWorkflowToken = centralToken;
    callerWorkflowRepository = CENTRAL_REPOSITORY;
    callerWorkflowRevision = callerRun?.head_sha;
    if (callerRun?.repository?.full_name !== CENTRAL_REPOSITORY
        || callerRun?.event !== 'workflow_dispatch'
        || callerRun?.path !== callerWorkflowPath
        || !SHA_PATTERN.test(callerWorkflowRevision ?? '')
        || callerRun?.run_attempt !== callerRunAttempt
        || !['queued', 'in_progress'].includes(callerRun?.status)) {
      throw new Error('manual dispatch run identity changed');
    }
  } else {
    callerRun = await githubJson(`${apiBase}/actions/runs/${callerRunId}`, targetToken, fetchImpl);
    callerWorkflowPath = admittedTarget.callerWorkflowPath;
    callerWorkflowToken = targetToken;
    callerWorkflowRepository = request.repository;
    callerWorkflowRevision = pull?.base?.repo?.default_branch;
    if (callerRun?.repository?.full_name !== request.repository) throw new Error('caller run repository identity changed');
    if (callerRun?.event !== 'pull_request_target') throw new Error('caller run must use pull_request_target');
    if (callerRun?.path !== admittedTarget.callerWorkflowPath) throw new Error('caller run workflow path changed');
    // A pull_request_target run reports the PR *head* as head_sha and the PR source branch as
    // head_branch (the base-owned workflow code is what executes, but the run identity is the PR).
    if (callerRun?.head_sha !== request.head_sha) throw new Error('caller run is not bound to the requested PR head');
    if (typeof pull?.head?.ref === 'string' && callerRun?.head_branch !== pull.head.ref) {
      throw new Error('caller run is not bound to the PR source branch');
    }
    if (callerRun?.run_attempt !== callerRunAttempt) throw new Error('caller run attempt changed');
    if (!Array.isArray(callerRun?.pull_requests)
        || !callerRun.pull_requests.some((candidate) => candidate?.number === request.pr_number)) {
      throw new Error('caller run is not bound to the requested PR');
    }
  }

  // Capacity is checked only after identity is proven, so an invalid request
  // reports the validation failure rather than a misleading capacity message.
  const capacity = await assertRepositoryCapacity({
    repositoryName: admittedTarget.name,
    token: centralToken,
    fetchImpl,
  });
  // repository-dispatch.yml serializes this exact repository/PR/head for the
  // full validation + DOKS admission run. Re-read the App-owned check ledger
  // while holding that lease; the DOKS service then owns the durable request
  // identity and compare-and-swap allocation of the admitted worker attempt.
  const reviewInventory = await listExactHeadReviewChecks({
    repository: request.repository,
    headSha: request.head_sha,
    token: targetToken,
    fetchImpl,
  });
  const generation = assertReviewGeneration({
    callerRunAttempt,
    inventory: reviewInventory,
    refreshRequested: request.refresh_requested === true,
  });

  // The base-owned caller workflow. Live evidence (example-api #4804, base 0.8.8-stable, run
  // 33675866048): GitHub executed the caller from the repository DEFAULT branch — whose
  // pull_request_target filter lists every stable line — not the PR base branch's copy. Read
  // the caller from the default branch so the contract checks the bytes that actually ran.
  if (typeof callerWorkflowRevision !== 'string' || callerWorkflowRevision.length === 0) {
    throw new Error('caller workflow revision is missing');
  }
  const workflowUrl = `https://api.github.com/repos/${callerWorkflowRepository}/contents/${callerWorkflowPath}`
    + `?ref=${encodeURIComponent(callerWorkflowRevision)}`;
  const workflow = await githubJson(workflowUrl, callerWorkflowToken, fetchImpl);
  if (workflow?.encoding !== 'base64' || typeof workflow.content !== 'string') {
    throw new Error('base-owned caller workflow response is invalid');
  }
  let callerContent;
  try {
    callerContent = Buffer.from(workflow.content.replace(/\s+/gu, ''), 'base64').toString('utf8');
  } catch {
    throw new Error('base-owned caller workflow could not be decoded');
  }
  const callerWorkflowSha256 = directManualDispatch
    ? createHash('sha256').update(callerContent).digest('hex')
    : admittedTarget.owner === TARGET_OWNER
      ? validateCallerWorkflow(callerContent)
      : validatePublicCallerWorkflow(callerContent);
  return {
    ...request,
    caller_run_id: callerRunId,
    caller_run_attempt: callerRunAttempt,
    caller_workflow_path: callerWorkflowPath,
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
    targetToken: process.env.GH_TARGET_TOKEN,
    centralToken: process.env.GH_CENTRAL_TOKEN,
    eventName: process.env.GITHUB_EVENT_NAME,
    executionRunId: process.env.GITHUB_RUN_ID,
    executionRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
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
