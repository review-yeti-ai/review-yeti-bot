import { createHash, createSign } from 'node:crypto';

import {
  CALLER_WORKFLOW_PATH,
  CENTRAL_REPOSITORY,
  assertAdmittedRepository,
  validateCallerWorkflow,
} from './validate-central-dispatch.mjs';
import {
  evaluateExactCheckRuns,
  QUALIFYING_MERGE_QUEUE_STATES,
  REQUIRED_REVIEW_APP_ID as REQUIRED_CHECK_APP_ID,
  REQUIRED_REVIEW_CONTEXT as REQUIRED_CONTEXT,
  REQUIRED_REVIEW_SLUG as REQUIRED_REVIEW_APP_SLUG,
} from './review-check-contract.mjs';
import { isEntrypoint } from './entrypoint-guard.mjs';

export const READINESS_SCHEMA = 'exampleorg.review-yeti-readiness.v1';
export const MERGE_GROUP_WORKFLOW_PATH = '.github/workflows/ct-review-merge-group.yml';
export const MERGE_GROUP_VERIFIER_ACTION = 'exampleorg/example-review-actions/.github/actions/verify-merge-group';
// The required-check integration publishes the status context.  The
// installation being qualified is a different identity and must be checked
// independently; conflating these IDs would allow a correctly named check
// from the wrong installed App to qualify a runtime.
export const REQUIRED_INSTALLATION_APP_ID = 4385771;
export const DEPENDENCY_MATRIX_SCHEMA = 'exampleorg.review-yeti-dependency-matrix.v1';
export const RUNTIME_QUALIFICATION_SCHEMA = 'exampleorg.review-yeti-runtime-qualification.v1';
export const DEPENDENCY_OWNERS = Object.freeze({
  readiness: Object.freeze({ repository: 'exampleorg/example-review-actions', action: 'readiness collector and qualification output' }),
  source: Object.freeze({ repository: CENTRAL_REPOSITORY, action: 'versioned caller/receiver workflows and v1 source ref' }),
  artifact: Object.freeze({ repository: 'review-yeti-ai/review-yeti-bot', action: 'released worker image digest' }),
  schema: Object.freeze({ repository: 'review-yeti-ai/review-yeti-bot', action: 'k8s-operator CRD and runtime attempt-identity schema' }),
  operator: Object.freeze({ repository: 'review-yeti-ai/review-yeti-bot', action: 'k8s-operator lifecycle and job-builder path' }),
  service: Object.freeze({ repository: 'exampleorg/example-infra', action: 'Bifrost/review gateway deployment service' }),
  consumer_process: Object.freeze({ repository: 'admitted consumer repository', action: 'base-owned caller workflow run' }),
});
export const REQUIRED_DISPATCH_EVENT = 'review-yeti-request';
export const REQUIRED_CALLER_PERMISSIONS = Object.freeze({
  actions: 'read',
  contents: 'read',
  'pull-requests': 'read',
});
export const REQUIRED_MERGE_GROUP_PERMISSIONS = Object.freeze({
  checks: 'read',
  contents: 'read',
  'pull-requests': 'read',
});
export const REQUIRED_APP_PERMISSIONS = Object.freeze({
  checks: 'write',
  // repository_dispatch is a contents-scoped write operation for the runtime
  // publisher. The collector uses a separate read-only App identity below.
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
});
// These are the permissions needed by the runtime publisher installation.
// Repository ruleset discovery is a collector concern and must not silently
// become a requirement on the App installation that publishes review output.
export const REQUIRED_RUNTIME_APP_PERMISSIONS = REQUIRED_APP_PERMISSIONS;
export const REQUIRED_COLLECTOR_APP_PERMISSIONS = Object.freeze({
  administration: 'read',
});
export const REQUIRED_CENTRAL_RECEIVER_PERMISSIONS = Object.freeze({
  actions: 'read',
  contents: 'read',
  'id-token': 'write',
  issues: 'write',
  'pull-requests': 'write',
});

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REQUEST_ID_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,99}):([1-9][0-9]*):([0-9a-f]{40}):([1-9][0-9]*):([1-9][0-9]*)$/u;
const MAX_FAILURES = 12;
const MAX_MESSAGE_LENGTH = 240;
const MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const GITHUB_API_ORIGIN = 'https://api.github.com';
const MAX_RULESET_PAGES = 3;
const MAX_WORKFLOW_RUN_PAGES = 3;
const CHECK_RUN_PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 15_000;

function boundedMessage(message) {
  const normalized = String(message).replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized.length > MAX_MESSAGE_LENGTH
    ? `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : normalized;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function digestReadinessResult(value) {
  const canonical = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function finalizeReadiness(result) {
  const finalized = {
    ...result,
    observed_at: result.observed_at || new Date().toISOString(),
  };
  finalized.content_digest = digestReadinessResult({ ...finalized, content_digest: undefined });
  return finalized;
}

function validObservationTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function freshObservationTime(value, now = Date.now()) {
  if (!validObservationTime(value)) return false;
  const age = now - Date.parse(value);
  return age >= -MAX_CLOCK_SKEW_MS && age <= MAX_OBSERVATION_AGE_MS;
}

function unknownDependency(reason) {
  return { status: 'unknown', identity: null, reason };
}

function compatibleDependency(identity) {
  return { status: 'compatible', identity };
}

function unavailableDeploymentDependencies(input) {
  const reason = input?.deploymentReadback === undefined
    ? 'owner-produced deployment readback is not wired into this collector'
    : 'caller-supplied deployment labels are not accepted as owner-produced evidence';
  return Object.fromEntries(['artifact', 'schema', 'operator', 'service']
    .map((key) => [key, unknownDependency(reason)]));
}

function centralSourceDependency(input, now = Date.now()) {
  const observation = input?.centralRefObservation;
  const sourceIdentity = {
    repository: CENTRAL_REPOSITORY,
    ref: 'v1',
    sha: input?.centralRefSha,
  };
  if (!SHA_PATTERN.test(String(input?.centralRefSha || ''))
      || !isObject(observation)
      || observation.repository !== CENTRAL_REPOSITORY
      || observation.ref !== 'v1'
      || observation.sha !== input.centralRefSha
      || observation.provenance !== 'github-api'
      || observation.stale === true
      || !freshObservationTime(observation.observed_at, now)) {
    return unknownDependency('central v1 source readback is unavailable, stale, or not bound to the resolved ref');
  }
  return compatibleDependency(sourceIdentity);
}

function consumerProcessDependency(input, runtime) {
  if (!runtime) {
    if (typeof input?.callerWorkflow === 'string'
        && input.callerWorkflow.includes('${{ github.run_id }}')
        && input.callerWorkflow.includes('${{ github.run_attempt }}')) {
      return compatibleDependency({
        repository: input.repository,
        workflow: CALLER_WORKFLOW_PATH,
        authority: 'source-qualified',
      });
    }
    return unknownDependency('caller process attempt identity is unavailable in source/configuration input');
  }
  const run = input?.callerRun;
  const expected = {
    repository: input.repository,
    workflow: CALLER_WORKFLOW_PATH,
    head_sha: input.expectedHeadSha,
    run_id: Number(run?.id),
    run_attempt: Number(run?.run_attempt),
  };
  const known = isObject(run)
    && Number.isSafeInteger(expected.run_id)
    && expected.run_id > 0
    && Number.isSafeInteger(expected.run_attempt)
    && expected.run_attempt > 0
    && run.repository?.full_name === expected.repository
    && run.path === expected.workflow
    && run.head_sha === expected.head_sha
    && Array.isArray(run.pull_requests)
    && run.pull_requests.some((candidate) => Number(candidate?.number) === Number(input.prNumber))
    && typeof input.callerWorkflow === 'string'
    && input.callerWorkflow.includes('${{ github.run_id }}')
    && input.callerWorkflow.includes('${{ github.run_attempt }}');
  return known
    ? compatibleDependency(expected)
    : unknownDependency('consumer process identity is unavailable or does not bind the run attempt');
}

export function buildDependencyAuthorityMatrix(input, { now = Date.now() } = {}) {
  const runtime = input?.mode === 'runtime' || input?.prNumber !== undefined;
  const source = centralSourceDependency(input, now);
  const deployment = unavailableDeploymentDependencies(input);
  const consumerProcess = consumerProcessDependency(input, runtime);
  const row = {
    id: 'review-yeti-delivery-chain',
    owner: {
      readiness: DEPENDENCY_OWNERS.readiness,
      source: DEPENDENCY_OWNERS.source,
      artifact: DEPENDENCY_OWNERS.artifact,
      schema: DEPENDENCY_OWNERS.schema,
      operator: DEPENDENCY_OWNERS.operator,
      service: DEPENDENCY_OWNERS.service,
      consumer_process: DEPENDENCY_OWNERS.consumer_process,
    },
    source,
    artifact: deployment.artifact,
    schema: deployment.schema,
    operator: deployment.operator,
    service: deployment.service,
    consumer_process: consumerProcess,
  };
  const dependencies = [
    ['source', source, DEPENDENCY_OWNERS.source],
    ['artifact', deployment.artifact, DEPENDENCY_OWNERS.artifact],
    ['schema', deployment.schema, DEPENDENCY_OWNERS.schema],
    ['operator', deployment.operator, DEPENDENCY_OWNERS.operator],
    ['service', deployment.service, DEPENDENCY_OWNERS.service],
    ['consumer_process', consumerProcess, DEPENDENCY_OWNERS.consumer_process],
  ];
  const scope = ([name, , owner]) => ({ dependency: name, owner: owner.repository, action: owner.action });
  const technicallyCompatible = dependencies.filter(([, value]) => value.status === 'compatible').map(scope);
  const unknown = dependencies.filter(([, value]) => value.status === 'unknown').map(scope);
  const incompatible = dependencies.filter(([, value]) => value.status === 'incompatible').map(scope);
  const status = incompatible.length > 0 ? 'incompatible' : unknown.length > 0 ? 'unknown' : 'compatible';
  return {
    schema: DEPENDENCY_MATRIX_SCHEMA,
    scope: runtime ? 'runtime' : 'configuration',
    status,
    rows: [row],
    authority_delta: {
      required: dependencies.map(scope),
      technically_compatible: technicallyCompatible,
      unknown,
      incompatible,
      authorization: {
        status: 'unknown',
        required: dependencies.map(scope),
        reason: 'approval grant evidence is not collected; technical compatibility is not authorization',
      },
    },
  };
}

function addFailure(failures, code, message) {
  if (failures.length >= MAX_FAILURES) return;
  failures.push({ code, message: boundedMessage(message) });
}

function addEvidence(evidence, key, value) {
  if (value !== undefined) evidence[key] = value;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

// GitHub App installation metadata is an App-authenticated endpoint. The
// installation token minted by create-github-app-token is intentionally used
// for repository contents/checks reads, but it must never be reused as App
// authentication for /repos/{owner}/{repo}/installation.
export function buildGithubAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  if (!/^[1-9][0-9]*$/u.test(String(appId)) || typeof privateKey !== 'string' || privateKey.length === 0) {
    return null;
  }
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: Number(now) - 60,
    exp: Number(now) + 540,
    iss: Number(appId),
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
}

function nonCommentLines(workflow) {
  return typeof workflow === 'string'
    ? workflow.split(/\r?\n/u).filter((line) => !/^\s*#/u.test(line) && !/^\s*$/u.test(line))
    : [];
}

function parseTopLevelPermissions(workflow) {
  if (typeof workflow !== 'string') return null;
  const lines = workflow.split(/\r?\n/u);
  const permissionsIndex = lines.findIndex((line) => /^permissions:\s*$/u.test(line));
  if (permissionsIndex < 0) return null;
  const permissions = {};
  for (const line of lines.slice(permissionsIndex + 1)) {
    if (/^\s*#/u.test(line) || /^\s*$/u.test(line)) continue;
    const match = /^  ([A-Za-z0-9_-]+):\s*(read|write|none)\s*$/u.exec(line);
    if (!match) break;
    permissions[match[1]] = match[2];
  }
  return Object.keys(permissions).length > 0 ? permissions : null;
}

function checkPermissions(workflow, required, code, failures, evidence) {
  const permissions = parseTopLevelPermissions(workflow);
  if (!permissions) {
    addFailure(failures, code, 'top-level permissions contract is missing or malformed');
    return;
  }
  const missing = Object.entries(required)
    .filter(([name, access]) => permissions[name] !== access)
    .map(([name, access]) => `${name}:${access}`);
  addEvidence(evidence, `${code}_permissions`, permissions);
  if (missing.length > 0) {
    addFailure(failures, code, `required permissions missing or widened: ${missing.join(', ')}`);
  }
}

function hasExactJobName(workflow) {
  return typeof workflow === 'string'
    && workflow.split(/\r?\n/u).filter((line) => /^\s+name:\s*Review Yeti \/ Review Yeti\s*$/u.test(line)).length === 1;
}

function workflowJobBlocks(workflow) {
  const lines = nonCommentLines(workflow);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex < 0) return [];
  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^( {2})([A-Za-z0-9_-]+):\s*$/u.exec(lines[index]);
    if (match) starts.push({ index, id: match[2] });
  }
  return starts.map((start, offset) => ({
    id: start.id,
    lines: lines.slice(start.index, starts[offset + 1]?.index || lines.length),
  }));
}

function workflowStepBlocks(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+/u.exec(lines[index]);
    if (match) starts.push({ index, indent: match[1].length });
  }
  return starts.map((start, offset) => ({
    lines: lines.slice(start.index, starts[offset + 1]?.index || lines.length),
    indent: start.indent,
  }));
}

function workflowInput(stepLines, name) {
  const indent = stepLines[0]?.match(/^(\s*)/u)?.[1].length || 0;
  const withPattern = new RegExp(`^ {${indent + 2}}with:\\s*$`, 'u');
  const starts = stepLines.flatMap((line, index) => withPattern.test(line) ? [index] : []);
  if (starts.length !== 1) return null;
  const inputs = [];
  for (const line of stepLines.slice(starts[0] + 1)) {
    if ((line.match(/^(\s*)/u)?.[1].length || 0) <= indent + 2) break;
    inputs.push(line);
  }
  const expression = new RegExp(`^ {${indent + 4}}${name}:\\s*(.+?)\\s*$`, 'u');
  const matches = inputs.map((line) => expression.exec(line)?.[1]).filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

function inspectVerifierAction(workflow, failures, evidence, centralSource) {
  const lines = nonCommentLines(workflow);
  const jobs = workflowJobBlocks(workflow);
  const reviewJobs = jobs.filter((job) => job.lines.some((line) => /^    name:\s*Review Yeti \/ Review Yeti\s*$/u.test(line)));
  const escapedAction = MERGE_GROUP_VERIFIER_ACTION.replace(/[/.]/gu, '\\$&');
  const actionPattern = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*${escapedAction}@([0-9a-f]{40})(?:\\s+#.*)?$`, 'u');
  const actionSteps = jobs.flatMap((job) => workflowStepBlocks(job.lines)
    .map((step) => ({ ...step, job, sha: step.lines.map((line) => actionPattern.exec(line)?.[1]).find(Boolean) }))
    .filter((step) => step.sha));
  const expectedSha = centralSource?.status === 'compatible'
    && typeof centralSource.identity?.sha === 'string'
    && SHA_PATTERN.test(centralSource.identity.sha)
    ? centralSource.identity.sha.toLowerCase()
    : null;
  const actualSha = actionSteps.length === 1 ? actionSteps[0].sha.toLowerCase() : null;
  const bindingStatus = expectedSha === null
    ? 'unknown'
    : actualSha === null
      ? 'missing'
      : actualSha === expectedSha ? 'matched' : 'mismatch';
  addEvidence(evidence, 'merge_group_verifier_binding', {
    status: bindingStatus,
    expected_sha: expectedSha,
    actual_sha: actualSha,
    actual_count: actionSteps.length,
  });
  const mentioned = lines.some((line) => line.includes(`${MERGE_GROUP_VERIFIER_ACTION}@`));
  if (reviewJobs.length !== 1) {
    addFailure(failures, 'merge_group_qualification', `merge-group must contain exactly one ${REQUIRED_CONTEXT} job`);
  }
  if (jobs.length !== 1) {
    addFailure(failures, 'merge_group_qualification', 'central merge-group verifier must be the sole job producer');
  }
  const reviewJob = reviewJobs[0];
  if (reviewJob && reviewJob.lines.some((line) => /^\s+(?:if|continue-on-error):/u.test(line))) {
    addFailure(failures, 'merge_group_qualification', 'required merge-group job must not be optional or continue on error');
  }
  if (actionSteps.length > 0 || mentioned) {
    if (actionSteps.length !== 1 || actionSteps[0].job !== reviewJob) {
      addFailure(failures, 'merge_group_qualification', 'central merge-group verifier must be the sole uses step in the required job');
    } else {
      const step = actionSteps[0];
      const reviewJobSteps = workflowStepBlocks(reviewJob.lines);
      const hasProperty = (candidate, name) => candidate.lines.some((line) =>
        new RegExp(`^(?: {${candidate.indent}}- | {${candidate.indent + 2}})${name}:`, 'u').test(line));
      const usesSteps = reviewJobSteps.filter((candidate) => hasProperty(candidate, 'uses'));
      const runSteps = reviewJobSteps.filter((candidate) => hasProperty(candidate, 'run'));
      if (usesSteps.length !== 1 || runSteps.length !== 0 || reviewJobSteps.length !== 1) {
        addFailure(failures, 'merge_group_qualification', 'central merge-group verifier must be the sole step in the required job');
      }
      const token = workflowInput(step.lines, 'github-token');
      const repository = workflowInput(step.lines, 'repository');
      const branch = workflowInput(step.lines, 'branch');
      if (token !== '${{ github.token }}') {
        addFailure(failures, 'merge_group_qualification', 'central verifier must receive a workflow token input');
      }
      if (repository !== '${{ github.repository }}') {
        addFailure(failures, 'merge_group_qualification', 'central verifier repository input must bind github.repository');
      }
      if (branch !== '${{ github.event.merge_group.base_ref }}') {
        addFailure(failures, 'merge_group_qualification', 'central verifier branch input must bind merge_group.base_ref');
      }
      if (expectedSha === null) {
        addFailure(failures, 'merge_group_qualification', 'central verifier pin cannot be qualified without a fresh observed central v1 release SHA');
      } else if (actualSha !== expectedSha) {
        addFailure(failures, 'merge_group_qualification', `central verifier pin must match the observed central v1 release SHA ${expectedSha}`);
      } else {
        addEvidence(evidence, 'merge_group_verifier', 'central_sha_pinned_action');
      }
    }
    return { actionPinned: actionSteps.length === 1 && actionSteps[0].job === reviewJob };
  }
  return { actionPinned: false };
}

function checkCallerWorkflow(workflow, repository, failures, evidence) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    addFailure(failures, 'caller_workflow', 'base-owned caller workflow is unavailable');
    return;
  }
  try {
    const sha256 = validateCallerWorkflow(workflow);
    addEvidence(evidence, 'caller_workflow_sha256', sha256);
  } catch (error) {
    addFailure(failures, 'caller_workflow', error.message);
  }
  if (!/^\s*pull_request_target:/mu.test(workflow)) {
    addFailure(failures, 'caller_producer', 'caller workflow does not produce pull_request_target runs');
  }
  if (!hasExactJobName(workflow)) {
    addFailure(failures, 'caller_producer', `caller must have exactly one ${REQUIRED_CONTEXT} job producer`);
  }
  checkPermissions(workflow, REQUIRED_CALLER_PERMISSIONS, 'caller', failures, evidence);
  if (!/actions\/create-github-app-token@[0-9a-f]{40}/u.test(workflow)
      || !/CT_REVIEW_BOT_APP_ID/u.test(workflow)
      || !/CT_REVIEW_BOT_APP_PRIVATE_KEY/u.test(workflow)
      || !/owner:\s*exampleorg/u.test(workflow)) {
    addFailure(failures, 'app_token', 'caller must mint the SHA-pinned Review Yeti App token for exampleorg');
  }
  const repositoriesMatch = /repositories:\s*([^\n]+)/u.exec(workflow);
  const repositories = (repositoriesMatch?.[1] || '').replace(/["']/gu, '');
  const targetName = repository.split('/')[1];
  const repositoryTokens = repositories.split(/[\s,\[\]]+/u).filter(Boolean);
  if (!repositoryTokens.includes(targetName) || !repositoryTokens.includes('example-review-actions')) {
    addFailure(failures, 'app_token', `caller App token must include ${CENTRAL_REPOSITORY} and ${repository}`);
  }
  for (const marker of ['request_id', 'repository', 'pr_number', 'base_sha', 'head_sha']) {
    if (!workflow.includes(marker)) addFailure(failures, 'dispatch_correlation', `caller dispatch payload omits ${marker}`);
  }
  if (!workflow.includes(REQUIRED_DISPATCH_EVENT)) {
    addFailure(failures, 'dispatch_correlation', `caller does not emit ${REQUIRED_DISPATCH_EVENT}`);
  }
  if (!workflow.includes('${{ github.run_id }}') || !workflow.includes('${{ github.run_attempt }}')) {
    addFailure(failures, 'caller_attempt_identity', 'caller request identity must bind github.run_id and github.run_attempt');
  }
}

function checkCentralReceiver(workflow, failures, evidence) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    addFailure(failures, 'central_receiver', 'promoted central receiver workflow is unavailable');
    return;
  }
  addEvidence(evidence, 'central_receiver_sha256', createHash('sha256').update(workflow, 'utf8').digest('hex'));
  for (const marker of [
    'repository_dispatch:',
    'types: [review-yeti-request]',
    'CENTRAL_DISPATCH_PAYLOAD',
    'scripts/validate-central-dispatch.mjs',
    'uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1',
  ]) {
    if (!workflow.includes(marker)) addFailure(failures, 'central_receiver', `promoted receiver lacks ${marker}`);
  }
  checkPermissions(workflow, REQUIRED_CENTRAL_RECEIVER_PERMISSIONS, 'central_receiver', failures, evidence);
}

function checkCentralReviewWorkflow(workflow, failures, evidence) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    addFailure(failures, 'central_compatibility', 'promoted central review workflow is unavailable');
    return;
  }
  // Source-level compatibility is useful evidence, but it is not proof of the
  // schema accepted by the image currently deployed behind the dispatch URL.
  if (!/check-id:[^\n]*!=\s*['"]doks['"]/u.test(workflow)) {
    addFailure(failures, 'central_compatibility', 'promoted central workflow does not gate check-id on the DOKS backend');
  }
  for (const marker of ['execution-backend:', 'doks-dispatch-url:', 'doks-publish-mode:']) {
    if (!workflow.includes(marker)) addFailure(failures, 'central_compatibility', `promoted central workflow lacks ${marker}`);
  }
  addEvidence(evidence, 'central_source_doks_check_id_contract', 'present');
}

function checkMergeGroupWorkflow(workflow, failures, evidence, centralSource) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    addFailure(failures, 'merge_group_workflow', 'dedicated merge-group workflow is unavailable');
    return;
  }
  const lines = nonCommentLines(workflow);
  const trigger = lines.some((line, index) => /^\s*merge_group:\s*$/u.test(line)
    && /^\s+types:\s*\[checks_requested\]\s*$/u.test(lines[index + 1] || ''));
  addEvidence(evidence, 'merge_group_trigger', trigger);
  if (!trigger) addFailure(failures, 'merge_group_producer', 'merge-group workflow must trigger checks_requested events');
  const requiredJobCount = workflowJobBlocks(workflow)
    .filter((job) => job.lines.some((line) => /^    name:\s*Review Yeti \/ Review Yeti\s*$/u.test(line)))
    .length;
  if (requiredJobCount !== 1) {
    addFailure(failures, 'merge_group_producer', `merge-group must produce exactly one ${REQUIRED_CONTEXT} job`);
  }
  checkPermissions(workflow, REQUIRED_MERGE_GROUP_PERMISSIONS, 'merge_group', failures, evidence);
  const verifierUses = inspectVerifierAction(workflow, failures, evidence, centralSource).actionPinned;
  if (!verifierUses) {
    addFailure(
      failures,
      'merge_group_qualification',
      `merge-group producer must use the pinned central verifier action; inline shell heuristics are not trusted evidence`,
    );
  }
  if (/^\s*(pull_request|pull_request_target|push|schedule|workflow_run):/mu.test(workflow)) {
    addFailure(failures, 'merge_group_producer', 'dedicated merge-group workflow must not have unrelated event producers');
  }
}

function normalizeBranch(branch) {
  return String(branch || '').replace(/^refs\/heads\//u, '');
}

function globMatches(pattern, branch, defaultBranch) {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return branch === defaultBranch;
  if (pattern === '~NOT_DEFAULT_BRANCH') return branch !== defaultBranch;
  const normalized = String(pattern).replace(/^refs\/heads\//u, '');
  const expression = normalized.replace(/[\\^$+?.()|{}[\]]/gu, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${expression}$`, 'u').test(branch);
}

function rulesetApplies(ruleset, branch, defaultBranch) {
  const refName = ruleset?.conditions?.ref_name;
  if (!isObject(refName)) return false;
  const includes = Array.isArray(refName.include) ? refName.include : [];
  const excludes = Array.isArray(refName.exclude) ? refName.exclude : [];
  const included = includes.length === 0 || includes.some((pattern) => globMatches(pattern, branch, defaultBranch));
  const excluded = excludes.some((pattern) => globMatches(pattern, branch, defaultBranch));
  return included && !excluded;
}

function checkRulesets(rulesets, branch, defaultBranch, failures, evidence) {
  if (!Array.isArray(rulesets) || rulesets.length === 0) {
    addFailure(failures, 'ruleset', 'active branch ruleset evidence is unavailable or malformed');
    return;
  }
  const applied = rulesets.filter((candidate) => isObject(candidate)
    && candidate.enforcement === 'active'
    && rulesetApplies(candidate, branch, defaultBranch));
  addEvidence(evidence, 'applied_rulesets', applied.map((candidate) => String(candidate.id || candidate.name || 'unknown')).slice(0, 20));
  if (applied.length === 0) {
    addFailure(failures, 'ruleset', `no active ruleset applies exactly to ${branch}`);
    return;
  }
  const requiredChecks = applied.flatMap((ruleset) => {
    const rule = Array.isArray(ruleset.rules)
      ? ruleset.rules.find((candidate) => candidate?.type === 'required_status_checks')
      : null;
    return Array.isArray(rule?.parameters?.required_status_checks) ? rule.parameters.required_status_checks : [];
  });
  const reviews = requiredChecks.filter((check) => check?.context === REQUIRED_CONTEXT);
  const review = reviews[0];
  addEvidence(evidence, 'required_check', review ? {
    context: review.context,
    integration_id: review.integration_id,
  } : null);
  if (reviews.length === 0) {
    addFailure(failures, 'required_check', `applied branch rulesets do not require ${REQUIRED_CONTEXT}`);
  } else {
    const wrongPublishers = reviews.filter((candidate) => Number(candidate.integration_id) !== REQUIRED_CHECK_APP_ID);
    if (wrongPublishers.length > 0) {
      addFailure(failures, 'required_publisher', `${REQUIRED_CONTEXT} has an applied requirement from integration ${String(wrongPublishers[0].integration_id)}, expected ${REQUIRED_CHECK_APP_ID}`);
    }
  }
  if (!applied.some((ruleset) => Array.isArray(ruleset.rules)
    && ruleset.rules.some((rule) => rule?.type === 'merge_queue'))) {
    addFailure(failures, 'merge_queue', `no applied active ruleset enables a merge queue for ${branch}`);
  }
}

function checkInstallation(installation, failures, evidence) {
  if (!isObject(installation)) {
    addFailure(failures, 'app_installation', 'Review Yeti App installation metadata is unavailable; App-authenticated read-only evidence is required');
    return;
  }
  addEvidence(evidence, 'app_installation', {
    app_id: installation.app_id,
    app_slug: installation.app_slug,
    repository_selection: installation.repository_selection,
  });
  if (Number(installation.app_id) !== REQUIRED_INSTALLATION_APP_ID) {
    addFailure(failures, 'app_publisher_id', `repository installation App ID is ${String(installation.app_id || '<unknown>')}, expected ${REQUIRED_INSTALLATION_APP_ID}`);
  }
  if (installation.app_slug !== REQUIRED_REVIEW_APP_SLUG) {
    addFailure(failures, 'app_publisher', `repository installation is ${String(installation.app_slug || '<unknown>')}, expected ${REQUIRED_REVIEW_APP_SLUG}`);
  }
  const permissions = installation.permissions;
  if (!isObject(permissions)) {
    addFailure(failures, 'app_permissions', 'Review Yeti App installation has no permissions evidence');
    return;
  }
  const missing = Object.entries(REQUIRED_APP_PERMISSIONS)
    .filter(([name, access]) => permissions[name] !== access)
    .map(([name, access]) => `${name}:${access}`);
  if (missing.length > 0) addFailure(failures, 'app_permissions', `Review Yeti App installation lacks ${missing.join(', ')}`);
}

function checkPullRequest({ repository, prNumber, expectedBaseSha, expectedHeadSha, pullRequest }, failures) {
  if (prNumber === undefined) return;
  if (!isObject(pullRequest)
      || Number(pullRequest.number) !== Number(prNumber)
      || pullRequest.state !== 'open'
      || pullRequest.base?.repo?.full_name !== repository
      || pullRequest.base?.sha !== expectedBaseSha
      || pullRequest.head?.sha !== expectedHeadSha) {
    addFailure(failures, 'pr_identity', 'live pull request is not open at the requested repository, base, and head');
  }
}

function checkMergeQueue(mergeQueue, prNumber, expectedHeadSha, runtime, failures, evidence) {
  const state = mergeQueue?.state || (isObject(mergeQueue) && typeof mergeQueue.id === 'string' ? 'enabled' : 'unknown');
  addEvidence(evidence, 'merge_queue_state', state);
  if (state === 'disabled') {
    addFailure(failures, 'merge_queue', 'merge queue is disabled for the qualified branch');
    return;
  }
  if (state !== 'enabled' || !isObject(mergeQueue) || typeof mergeQueue.id !== 'string' || mergeQueue.id.length === 0) {
    addFailure(failures, 'merge_queue', 'mergeQueue lookup returned an unknown or invalid state');
    return;
  }
  addEvidence(evidence, 'merge_queue_id', createHash('sha256').update(mergeQueue.id).digest('hex'));
  if (!runtime || mergeQueue.entries === undefined) return;
  if (!Array.isArray(mergeQueue.entries)) {
    addFailure(failures, 'merge_queue', 'mergeQueue.entries is malformed');
    return;
  }
  if (prNumber === undefined) {
    addFailure(failures, 'merge_queue', 'runtime qualification requires a pull request number');
    return;
  }
  const entries = mergeQueue.entries.filter((entry) => isObject(entry));
  const matches = entries.filter((entry) => Number(entry.pullRequest?.number) === Number(prNumber));
  if (matches.length !== 1) {
    addFailure(failures, 'merge_queue', `merge queue returned current PR #${prNumber} ${matches.length} times; expected exactly once`);
    return;
  }
  const entry = matches[0];
  if (!Number.isInteger(entry.position) || entry.position < 1) {
    addFailure(failures, 'merge_queue', `merge queue entry for PR #${prNumber} has no valid position`);
  }
  if (entry.state === 'UNMERGEABLE' || entry.state === 'LOCKED') {
    addFailure(failures, 'merge_queue', `merge queue entry for PR #${prNumber} is ${entry.state.toLowerCase()}`);
  } else if (!QUALIFYING_MERGE_QUEUE_STATES.includes(entry.state)) {
    addFailure(failures, 'merge_queue', `merge queue entry for PR #${prNumber} has unknown state`);
  }
  const headSha = entry.pullRequest?.headRefOid;
  if (!SHA_PATTERN.test(String(headSha || ''))) {
    addFailure(failures, 'merge_queue', `merge queue entry for PR #${prNumber} has no exact head SHA`);
  } else if (expectedHeadSha && headSha !== expectedHeadSha) {
    addFailure(failures, 'merge_queue', `merge queue PR #${prNumber} head SHA changed`);
  }
}

function checkCheckRuns(checkRuns, expectedHeadSha, failures, evidence) {
  const result = evaluateExactCheckRuns(checkRuns, expectedHeadSha);
  for (const failure of result.failures) {
    const code = failure.includes(REQUIRED_CONTEXT) ? 'required_publisher' : 'review_publisher';
    addFailure(failures, code, failure);
  }
  addEvidence(evidence, 'head_check_context', {
    context_count: result.context_count,
    latest_id: result.context?.id,
    latest_conclusion: result.context?.conclusion,
    exact_publisher: Number(result.context?.app?.id) === REQUIRED_CHECK_APP_ID,
  });
  addEvidence(evidence, 'head_review_verdict', {
    count: result.verdict_count,
    latest_id: result.verdict?.id,
    latest_conclusion: result.verdict?.conclusion,
    exact_publisher: result.verdict?.app?.slug === REQUIRED_REVIEW_APP_SLUG,
  });
}

function checkDispatchCorrelation({ repository, prNumber, expectedBaseSha, expectedHeadSha, centralRefSha, callerRun, centralRuns }, failures, evidence) {
  if (prNumber === undefined) return;
  if (!isObject(callerRun) || !Number.isSafeInteger(Number(callerRun.id)) || !Number.isSafeInteger(Number(callerRun.run_attempt))) {
    addFailure(failures, 'dispatch_correlation', 'caller run evidence is unavailable or malformed');
    return;
  }
  const repositoryName = repository.split('/')[1];
  const requestId = `${repositoryName}:${prNumber}:${expectedHeadSha}:${callerRun.id}:${callerRun.run_attempt}`;
  const requestIdentity = REQUEST_ID_PATTERN.exec(requestId);
  if (!requestIdentity || Number(requestIdentity[2]) !== Number(prNumber) || requestIdentity[3] !== expectedHeadSha) {
    addFailure(failures, 'dispatch_correlation', 'caller request identity does not bind repository, PR, head, run, and attempt');
  }
  if (callerRun.repository?.full_name !== repository
      || callerRun.event !== 'pull_request_target'
      || callerRun.path !== CALLER_WORKFLOW_PATH
      || callerRun.head_sha !== expectedHeadSha
      || callerRun.run_attempt !== Number(callerRun.run_attempt)
      || !Array.isArray(callerRun.pull_requests)
      || !callerRun.pull_requests.some((candidate) => Number(candidate?.number) === Number(prNumber))) {
    addFailure(failures, 'dispatch_correlation', 'caller run is not bound to the requested PR exact head');
  }
  const expectedTitle = `Review Yeti central / ${requestId}`;
  const correlatedRuns = Array.isArray(centralRuns)
    ? centralRuns.filter((run) => run?.display_title === expectedTitle
      && run?.event === 'repository_dispatch'
      && run?.path === '.github/workflows/repository-dispatch.yml')
    : [];
  const latest = [...correlatedRuns].sort((left, right) => {
    const leftTime = Date.parse(left?.created_at || '') || 0;
    const rightTime = Date.parse(right?.created_at || '') || 0;
    return rightTime - leftTime || Number(right?.id || 0) - Number(left?.id || 0);
  })[0];
  const matches = latest?.status === 'completed' && latest?.conclusion === 'success' ? [latest] : [];
  addEvidence(evidence, 'dispatch_request_id_sha256', createHash('sha256').update(requestId).digest('hex'));
  if (correlatedRuns.length !== 1) {
    addFailure(failures, 'dispatch_correlation', `central dispatch correlation returned ${correlatedRuns.length} matching runs; expected exactly one`);
  } else if (matches.length !== 1) {
    addFailure(failures, 'dispatch_correlation', 'latest correlated central dispatch run is not completed successfully');
  } else if (centralRefSha && matches[0].head_sha !== centralRefSha) {
    addFailure(failures, 'dispatch_correlation', 'central dispatch run is not bound to the resolved central ref');
  }
}

export function qualifyReadiness(input, { now = Date.now() } = {}) {
  const failures = [];
  const evidence = {};
  const repository = input?.repository;
  let repositoryName;
  try {
    repositoryName = assertAdmittedRepository(repository);
  } catch (error) {
    addFailure(failures, 'repository', error.message);
  }
  if (!repositoryName) {
    return finalizeReadiness({ schema: READINESS_SCHEMA, repository: repository || null, qualification_mode: 'configuration', status: 'not_ready', failures, evidence });
  }
  const branch = normalizeBranch(input.branch || input.defaultBranch || 'main');
  // A caller-provided branch is not proof that it is the repository default;
  // keep ~DEFAULT_BRANCH rulesets unknown until repository metadata supplies it.
  const defaultBranch = normalizeBranch(input.defaultBranch || '');
  const runtime = input.mode === 'runtime' || input.prNumber !== undefined;
  checkCallerWorkflow(input.callerWorkflow, repository, failures, evidence);
  const centralSource = centralSourceDependency(input, now);
  checkMergeGroupWorkflow(input.mergeGroupWorkflow, failures, evidence, centralSource);
  checkCentralReceiver(input.centralReceiverWorkflow, failures, evidence);
  checkCentralReviewWorkflow(input.centralReviewWorkflow, failures, evidence);
  if (typeof input.centralRefSha !== 'string' || !SHA_PATTERN.test(input.centralRefSha)) {
    addEvidence(evidence, 'central_v1_sha', null);
    addFailure(failures, 'central_compatibility', 'central v1 ref resolution is unknown or malformed');
  } else {
    addEvidence(evidence, 'central_v1_sha', input.centralRefSha);
  }
  // This collector proves source/configuration and, in runtime mode, exact PR
  // identity and current GitHub check/queue evidence. It cannot authenticate
  // the image behind the central dispatch endpoint, so deployment schema
  // compatibility is intentionally outside this qualification boundary.
  addEvidence(evidence, 'deployed_schema_compatibility', 'not_checked');
  addEvidence(evidence, 'qualification_scope', 'source_configuration_and_github_exact_head_only');
  if (runtime) checkPullRequest(input, failures);
  checkRulesets(input.rulesets || (input.ruleset ? [input.ruleset] : []), branch, defaultBranch, failures, evidence);
  checkInstallation(input.installation, failures, evidence);
  const dependencyMatrix = buildDependencyAuthorityMatrix(input, { now });
  addEvidence(evidence, 'dependency_matrix', dependencyMatrix);
  addEvidence(evidence, 'dependency_authority_delta', dependencyMatrix.authority_delta);
  // This collector can qualify source/configuration and exact GitHub state,
  // but it has no authenticated owner-produced deployment readback. Keep the
  // runtime gate explicit so consumers cannot mistake a top-level GitHub
  // `ready` result for proof that the deployed worker/service is compatible.
  addEvidence(evidence, 'runtime_qualification', {
    schema: RUNTIME_QUALIFICATION_SCHEMA,
    ready: false,
    status: 'unknown',
    source: 'readiness-collector-only',
    reason: 'owner-produced deployment readback is not wired into this collector',
    matrix_schema: DEPENDENCY_MATRIX_SCHEMA,
    matrix_status: dependencyMatrix.status,
  });
  checkMergeQueue(input.mergeQueue, input.prNumber, input.expectedHeadSha, runtime, failures, evidence);
  if (runtime) {
    checkCheckRuns(input.checkRuns, input.expectedHeadSha, failures, evidence);
    checkDispatchCorrelation(input, failures, evidence);
  }
  return finalizeReadiness({
    schema: READINESS_SCHEMA,
    repository: `exampleorg/${repositoryName}`,
    branch,
    qualification_mode: runtime ? 'runtime' : 'configuration',
    pull_request: input.prNumber ?? null,
    base_sha: input.expectedBaseSha || null,
    head_sha: input.expectedHeadSha || null,
    status: failures.length === 0 ? 'ready' : 'not_ready',
    failures,
    evidence,
  });
}

function assertGithubApiUrl(url, label = 'GitHub request') {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (parsed.origin !== GITHUB_API_ORIGIN || parsed.username || parsed.password || parsed.hash
      || !parsed.pathname.startsWith('/repos/') && parsed.pathname !== '/graphql') {
    throw new Error(`${label} URL is outside the GitHub API origin`);
  }
  return parsed;
}

function requestOptions(token, options = {}) {
  return {
    method: options.method || 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.headers || {}),
    },
    ...(options.body ? { body: options.body } : {}),
  };
}

async function githubJson(url, token, fetchImpl = globalThis.fetch, options = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('GH_TOKEN is required for read-only readiness qualification');
  assertGithubApiUrl(url);
  let response;
  try {
    response = await fetchImpl(url, requestOptions(token, options));
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
    return await response.json();
  } catch (error) {
    if (error?.message === 'HTTP ' + (response?.status ?? 'unknown')) {
      throw new Error('GitHub lookup failed with an HTTP error');
    }
    throw new Error('GitHub lookup failed; transport details are redacted');
  }
}

function parseLinkHeader(value, label) {
  const link = String(value || '');
  const nextMatch = /<([^>]+)>\s*;\s*rel="next"/u.exec(link);
  const lastMatch = /<([^>]+)>\s*;\s*rel="last"/u.exec(link);
  const nextUrl = nextMatch?.[1] || null;
  if (nextUrl) assertGithubApiUrl(nextUrl, `${label} pagination`);
  if (lastMatch?.[1]) assertGithubApiUrl(lastMatch[1], `${label} pagination`);
  return { nextUrl, lastUrl: lastMatch?.[1] || null };
}

async function githubJsonPage(url, token, fetchImpl = globalThis.fetch, label = 'GitHub collection') {
  if (typeof token !== 'string' || token.length === 0) throw new Error('GH_TOKEN is required for read-only readiness qualification');
  assertGithubApiUrl(url, label);
  let response;
  try {
    response = await fetchImpl(url, requestOptions(token));
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
    if (!response.headers || typeof response.headers.get !== 'function') {
      throw new Error('pagination metadata is unavailable');
    }
    const data = await response.json();
    const linkHeader = response.headers.get('link');
    const links = parseLinkHeader(linkHeader, label);
    const totalCount = Number.isSafeInteger(data?.total_count) && data.total_count >= 0
      ? data.total_count
      : null;
    return { data, ...links, totalCount };
  } catch (error) {
    if (error?.message === 'pagination metadata is unavailable') throw new Error(`${label} pagination metadata is unavailable`);
    if (error?.message === 'HTTP ' + (response?.status ?? 'unknown')) throw new Error(`${label} lookup failed with an HTTP error`);
    if (/URL is outside|URL is invalid/u.test(error?.message || '')) throw error;
    throw new Error(`${label} lookup failed; transport details are redacted`);
  }
}

export async function githubCollection(url, token, fetchImpl, key, label, maxPages = MAX_WORKFLOW_RUN_PAGES, options = {}) {
  const originalUrl = assertGithubApiUrl(url, label);
  const queryIdentity = (parsed) => [...parsed.searchParams.entries()]
    .filter(([name]) => name !== 'page').sort().map((entry) => JSON.stringify(entry)).join(',');
  const values = [];
  let nextUrl = url;
  let expectedTotalCount = null;
  let pages = 0;
  const seenIds = new Set();
  while (nextUrl) {
    pages += 1;
    if (pages > maxPages) throw new Error(`${label} pagination exceeded the safety bound`);
    const parsedNext = assertGithubApiUrl(nextUrl, label);
    if (parsedNext.pathname !== originalUrl.pathname || queryIdentity(parsedNext) !== queryIdentity(originalUrl)) {
      throw new Error(`${label} pagination changed the collection identity`);
    }
    const page = await githubJsonPage(nextUrl, token, fetchImpl, label);
    const pageValues = Array.isArray(page.data)
      ? page.data
      : page.data?.[key];
    if (!Array.isArray(pageValues)) throw new Error(`${label} response is malformed`);
    if (pageValues.length > 100) throw new Error(`${label} page exceeds the 100-item safety bound`);
    if (page.totalCount !== null) {
      if (expectedTotalCount !== null && expectedTotalCount !== page.totalCount) {
        throw new Error(`${label} total count changed during pagination`);
      }
      expectedTotalCount = page.totalCount;
    } else if (!options.allowArrayResponse || !Array.isArray(page.data)) {
      throw new Error(`${label} pagination metadata is unavailable`);
    }
    // A real Headers object returning null for Link is GitHub's normal final
    // page, not missing metadata. Array endpoints do not expose total_count.
    for (const value of pageValues) {
      const id = value?.id;
      if ((typeof id !== 'string' && typeof id !== 'number') || seenIds.has(String(id))) {
        throw new Error(`${label} response contains duplicate or malformed item identities`);
      }
      seenIds.add(String(id));
    }
    values.push(...pageValues);
    nextUrl = page.nextUrl;
    if (!nextUrl && expectedTotalCount !== null && expectedTotalCount !== values.length) {
      throw new Error(`${label} pagination is incomplete or inconsistent`);
    }
  }
  return { values, pages };
}

async function optionalGithubJson(url, token, fetchImpl) {
  try {
    return await githubJson(url, token, fetchImpl);
  } catch {
    return null;
  }
}

async function readWorkflow(repository, path, branch, token, fetchImpl) {
  const response = await githubJson(
    `https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    token,
    fetchImpl,
  );
  if (response?.encoding !== 'base64' || typeof response.content !== 'string') throw new Error(`${path} content response is invalid`);
  return Buffer.from(response.content.replace(/\s+/gu, ''), 'base64').toString('utf8');
}

async function optionalReadWorkflow(repository, path, branch, token, fetchImpl) {
  try {
    return await readWorkflow(repository, path, branch, token, fetchImpl);
  } catch {
    return null;
  }
}

export async function readGraphqlMergeQueue(repository, branch, token, fetchImpl) {
  const [owner, name] = repository.split('/');
  const query = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id entries(first:100){nodes{position state pullRequest{number headRefOid}} pageInfo{hasNextPage}}}}}';
  const response = await githubJson('https://api.github.com/graphql', token, fetchImpl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, branch } }),
  });
  // A GraphQL response containing both data and errors is not authoritative:
  // partial data can look like a disabled queue while a field-level failure
  // actually made the lookup incomplete. Preserve a clean null as the known
  // disabled state and classify transport/schema failures as unknown upstream.
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error('GraphQL merge queue lookup returned errors');
  }
  if (!isObject(response?.data) || !isObject(response.data.repository)) {
    throw new Error('GraphQL merge queue lookup returned malformed data');
  }
  const queue = response.data.repository.mergeQueue;
  if (queue === null) return { state: 'disabled' };
  if (!isObject(queue)) throw new Error('GraphQL merge queue lookup returned an invalid queue');
  if (!isObject(queue.entries?.pageInfo) || typeof queue.entries.pageInfo.hasNextPage !== 'boolean') {
    throw new Error('GraphQL merge queue pagination metadata is unavailable');
  }
  return { state: 'enabled', ...queue };
}

export async function collectLiveInput({ repository, branch, prNumber, token, appId, privateKey, fetchImpl }) {
  // Admission is deliberately the first operation. No API request, including
  // repository metadata, may be made for a repository outside this boundary.
  assertAdmittedRepository(repository);
  const metadata = await githubJson(`https://api.github.com/repos/${repository}`, token, fetchImpl);
  const resolvedBranch = branch || metadata.default_branch;
  if (typeof resolvedBranch !== 'string' || resolvedBranch.length === 0) throw new Error('repository default branch is missing');
  const branchMetadata = await githubJson(
    `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(resolvedBranch)}`,
    token,
    fetchImpl,
  );
  const resolvedBranchSha = branchMetadata?.commit?.sha;
  if (!SHA_PATTERN.test(String(resolvedBranchSha || ''))) throw new Error('repository branch SHA is missing or malformed');
  const pull = prNumber === undefined
    ? null
    : await githubJson(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, token, fetchImpl);
  const expectedHeadSha = pull?.head?.sha;
  const expectedBaseSha = pull?.base?.sha;
  const workflows = await Promise.all([
    optionalReadWorkflow(repository, CALLER_WORKFLOW_PATH, resolvedBranchSha, token, fetchImpl),
    optionalReadWorkflow(repository, MERGE_GROUP_WORKFLOW_PATH, resolvedBranchSha, token, fetchImpl),
  ]);
  const centralRef = await optionalGithubJson(
    `https://api.github.com/repos/${CENTRAL_REPOSITORY}/commits/v1`, token, fetchImpl,
  );
  const centralRefSha = SHA_PATTERN.test(String(centralRef?.sha || '')) ? centralRef.sha : null;
  // Resolve the mutable release channel before reading any central workflow.
  // Source compatibility must be bound to the commit that was actually resolved.
  const centralWorkflows = centralRefSha === null ? [null, null] : await Promise.all([
    optionalReadWorkflow(CENTRAL_REPOSITORY, '.github/workflows/repository-dispatch.yml', centralRefSha, token, fetchImpl),
    optionalReadWorkflow(CENTRAL_REPOSITORY, '.github/workflows/review-yeti.yml', centralRefSha, token, fetchImpl),
  ]);
  const rulesets = await githubCollection(
    `https://api.github.com/repos/${repository}/rulesets?includes_parents=true&per_page=100`,
    token, fetchImpl, 'rulesets', 'repository rulesets', MAX_RULESET_PAGES, { allowArrayResponse: true },
  ).then((result) => result.values);
  const rulesetList = Array.isArray(rulesets) ? rulesets : [];
  if (rulesetList.some((item) => !/^[1-9][0-9]*$/u.test(String(item?.id || '')))) {
    throw new Error('repository rulesets response contains an invalid rule identity');
  }
  const detailedRulesets = await Promise.all(rulesetList.map((item) => githubJson(
    `https://api.github.com/repos/${repository}/rulesets/${item.id}`, token, fetchImpl,
  )));
  let callerRun = null;
  let centralRuns = null;
  let checkRuns = null;
  if (pull) {
    const callerRuns = await githubCollection(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(CALLER_WORKFLOW_PATH)}/runs?event=pull_request_target&head_sha=${expectedHeadSha}&per_page=100`,
      token, fetchImpl, 'workflow_runs', 'caller workflow runs', MAX_WORKFLOW_RUN_PAGES,
    );
    const exactCallerRuns = callerRuns.values.filter((run) => run?.repository?.full_name === repository
      && run?.event === 'pull_request_target'
      && run?.head_sha === expectedHeadSha
      && run?.pull_requests?.some((candidate) => Number(candidate?.number) === Number(prNumber)));
    callerRun = [...exactCallerRuns].sort((left, right) => {
      const leftTime = Date.parse(left?.created_at || '') || 0;
      const rightTime = Date.parse(right?.created_at || '') || 0;
      return rightTime - leftTime || Number(right?.id || 0) - Number(left?.id || 0);
    })[0] || null;
    if (!callerRun) throw new Error('caller workflow run for the exact PR head is unavailable');
    const callerDate = String(callerRun.created_at || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(callerDate) || !Number.isFinite(Date.parse(callerDate))) {
      throw new Error('caller workflow run creation time is unavailable');
    }
    const centralResponse = await githubCollection(
      `https://api.github.com/repos/${CENTRAL_REPOSITORY}/actions/workflows/repository-dispatch.yml/runs?event=repository_dispatch&created=${encodeURIComponent(`>=${callerDate}`)}&per_page=100`,
      token, fetchImpl, 'workflow_runs', 'central workflow runs', MAX_WORKFLOW_RUN_PAGES,
    );
    centralRuns = centralResponse.values.filter((run) => (Date.parse(run?.created_at || '') || 0) >= (Date.parse(callerRun.created_at) || 0));
    const checks = await githubCollection(
      `https://api.github.com/repos/${repository}/commits/${expectedHeadSha}/check-runs?filter=all&per_page=${CHECK_RUN_PAGE_SIZE}`,
      token, fetchImpl, 'check_runs', 'head check runs', 1,
    );
    checkRuns = checks.values;
  }
  let installation = null;
  try {
    const installationJwt = buildGithubAppJwt({ appId, privateKey });
    // GitHub requires App JWT authentication for this endpoint. The scoped
    // installation token is deliberately not substituted here.
    if (installationJwt) installation = await optionalGithubJson(
      `https://api.github.com/repos/${repository}/installation`, installationJwt, fetchImpl,
    );
  } catch {
    installation = null;
  }
  return {
    repository,
    branch: resolvedBranch,
    branchSha: resolvedBranchSha,
    prNumber,
    expectedBaseSha,
    expectedHeadSha,
    pullRequest: pull ? {
      number: pull.number,
      state: pull.state,
      base: { sha: pull.base?.sha, repo: { full_name: pull.base?.repo?.full_name } },
      head: { sha: pull.head?.sha, ref: pull.head?.ref },
    } : undefined,
    callerWorkflow: workflows[0],
    mergeGroupWorkflow: workflows[1],
    centralReceiverWorkflow: centralWorkflows[0],
    centralReviewWorkflow: centralWorkflows[1],
    centralRefSha: centralRefSha || undefined,
    centralRefObservation: centralRefSha ? {
      repository: CENTRAL_REPOSITORY,
      ref: 'v1',
      sha: centralRefSha,
      provenance: 'github-api',
      observed_at: new Date().toISOString(),
    } : undefined,
    defaultBranch: metadata.default_branch,
    rulesets: detailedRulesets,
    installation,
    mergeQueue: await optionalMergeQueue(repository, resolvedBranch, token, fetchImpl, prNumber),
    checkRuns,
    callerRun,
    centralRuns,
  };
}

async function optionalMergeQueue(repository, branch, token, fetchImpl, prNumber) {
  try {
    const queue = await readGraphqlMergeQueue(repository, branch, token, fetchImpl);
    if (queue.state !== 'enabled') return queue;
    if (prNumber !== undefined && (queue.entries?.pageInfo?.hasNextPage === true || !Array.isArray(queue.entries?.nodes))) {
      return { ...queue, entries: null };
    }
    return { ...queue, entries: prNumber === undefined ? undefined : queue.entries.nodes };
  } catch {
    return { state: 'unknown' };
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('arguments must be an array');
  const args = {};
  const valueFor = (flag, index) => {
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') {
      args.json = true;
    } else if (value === '--repository' || value === '--branch' || value === '--pr-number') {
      args[value.slice(2).replaceAll('-', '_')] = valueFor(value, index);
      index += 1;
    } else {
      throw new Error(`unknown argument ${value}`);
    }
  }
  if (!args.repository) throw new Error('--repository is required');
  if (args.pr_number !== undefined && !/^[1-9][0-9]*$/u.test(args.pr_number)) throw new Error('--pr-number must be a positive integer');
  return args;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  collectInput = collectLiveInput,
  stdout = console.log,
  now = Date.now(),
} = {}) {
  const args = parseArgs(argv);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const liveInput = await collectInput({
    repository: args.repository,
    branch: args.branch,
    prNumber: args.pr_number === undefined ? undefined : Number(args.pr_number),
    token,
    appId: env.REVIEW_YETI_APP_ID,
    privateKey: env.REVIEW_YETI_APP_PRIVATE_KEY,
    fetchImpl,
  });
  const result = qualifyReadiness(liveInput, { now });
  if (args.json) stdout(JSON.stringify(result));
  else {
    stdout(`Review Yeti readiness: ${result.status} for ${result.repository}@${result.branch}`);
    for (const failure of result.failures) stdout(`- ${failure.code}: ${failure.message}`);
  }
  return result.status === 'ready' ? 0 : 1;
}

if (isEntrypoint(import.meta.url)) {
  main().then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  }).catch((error) => {
    console.error(`::error::Review Yeti readiness qualification failed: ${boundedMessage(error.message)}`);
    process.exitCode = 1;
  });
}
