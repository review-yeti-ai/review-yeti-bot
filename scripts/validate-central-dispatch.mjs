import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CENTRAL_REPOSITORY = 'exampleorg/example-review-actions';
// Repositories admitted to the central dispatch boundary. ADR 0490 scope
// widened 2026-09-02 (example-review-actions #200): example-release and example-meta joined
// example-api on the Ollama-only policy.
export const TARGET_REPOSITORY = 'exampleorg/example-api';
export const ALLOWED_TARGET_REPOSITORIES = Object.freeze(new Set([
  TARGET_REPOSITORY,
  'exampleorg/example-release',
  'exampleorg/example-meta',
]));
export const DISPATCH_EVENT_TYPE = 'review-yeti-request';
export const CALLER_WORKFLOW_PATH = '.github/workflows/ct-review-bot.yml';

const PAYLOAD_KEYS = Object.freeze(['base_sha', 'head_sha', 'pr_number', 'repository', 'request_id']);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REQUEST_ID_PATTERN = /^(example-api|example-release|example-meta):([1-9][0-9]*):([0-9a-f]{40}):([1-9][0-9]*):([1-9][0-9]*)$/u;
const PROVIDER_SECRET_PATTERN = /(?:OLLAMA_PR_REVIEW_API_KEY|OPENROUTER(?:_PR_REVIEW_API_KEY|_REVIEW_FLEET_KEY|_API_KEY)|FIREWORKS_PR_REVIEW_API_KEY|SYNTHETIC_API_KEY|GEMINI_API_KEY)/u;

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
  if (!ALLOWED_TARGET_REPOSITORIES.has(payload.repository)) {
    throw new Error(`repository must be one of ${[...ALLOWED_TARGET_REPOSITORIES].join(', ')}`);
  }
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
    'repository-dispatch.yml',
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::Central Review Yeti dispatch rejected: ${error.message}`);
    process.exitCode = 1;
  });
}
