import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_CHECK_NAME = 'Execute AI Review Pipeline';
export const GITHUB_ACTIONS_APP_ID = 15368;

const shaPattern = /^[a-f0-9]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function resolveControllerMode(eventName, passthroughValue) {
  const value = passthroughValue ?? '';
  if (value !== '' && value !== 'true' && value !== 'false') {
    throw new Error('REVIEW_YETI_PASSTHROUGH must be exactly true, false, or unset');
  }
  return eventName === 'pull_request_target' && value === 'true' ? 'operator-waiver' : 'review';
}

export function identityFromEvent(event, repository, repositoryId) {
  if (!repositoryPattern.test(repository ?? '')) throw new Error('Workflow repository identity is invalid');
  const numericRepositoryId = Number(repositoryId);
  const pullRequest = event?.pull_request;
  if (!Number.isSafeInteger(numericRepositoryId) || numericRepositoryId <= 0
    || !Number.isSafeInteger(pullRequest?.number) || pullRequest.number <= 0
    || event?.repository?.full_name !== repository
    || event?.repository?.id !== numericRepositoryId
    || !event?.repository?.default_branch
    || pullRequest?.base?.ref !== event.repository.default_branch
    || pullRequest?.base?.repo?.id !== numericRepositoryId
    || !shaPattern.test(pullRequest?.head?.sha ?? '')
    || !shaPattern.test(pullRequest?.base?.sha ?? '')) {
    throw new Error('Pull request event is not bound to the workflow repository and exact revisions');
  }
  return {
    repository,
    repositoryId: numericRepositoryId,
    baseRef: pullRequest.base.ref,
    defaultBranch: event.repository.default_branch,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
    baseSha: pullRequest.base.sha,
  };
}

export function assertCurrentPullRequest(expected, current) {
  if (!Number.isSafeInteger(expected?.repositoryId) || !repositoryPattern.test(expected?.repository ?? '')
    || !Number.isSafeInteger(expected?.pullRequestNumber) || !shaPattern.test(expected?.headSha ?? '')
    || !shaPattern.test(expected?.baseSha ?? '')
    || current?.state !== 'open'
    || current?.number !== expected.pullRequestNumber
    || current?.base?.repo?.id !== expected.repositoryId
    || current?.base?.repo?.full_name !== expected.repository
    || current?.base?.ref !== expected.baseRef
    || current?.base?.repo?.default_branch !== expected.defaultBranch
    || expected.baseRef !== expected.defaultBranch
    || current?.head?.sha !== expected.headSha
    || current?.base?.sha !== expected.baseSha) {
    throw new Error('Current pull request no longer matches the admitted repository, PR, head, and base');
  }
}

function requiredCheckExternalId(identity, runId, runAttempt) {
  if (!/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(runAttempt))) {
    throw new Error('Workflow run identity is invalid');
  }
  return `review-yeti-self-review:v1:${identity.repositoryId}:${identity.pullRequestNumber}:${identity.headSha}:${runId}:${runAttempt}`;
}

function assertCheckResponse(check, expected) {
  if (!Number.isSafeInteger(check?.id) || check.id <= 0
    || check?.name !== REQUIRED_CHECK_NAME
    || check?.head_sha !== expected.headSha
    || check?.app?.id !== GITHUB_ACTIONS_APP_ID) {
    throw new Error('GitHub returned a check outside the required name, exact head, or GitHub Actions app');
  }
}

export async function startRequiredReviewCheck({ api, identity, mode, runId, runAttempt, now = () => new Date() }) {
  if (!['review', 'operator-waiver'].includes(mode)) throw new Error('Review controller mode is invalid');
  assertCurrentPullRequest(identity, await api.getCurrentPullRequest(identity));
  const startedAt = now().toISOString();
  const check = await api.createCheckRun({
    name: REQUIRED_CHECK_NAME,
    head_sha: identity.headSha,
    external_id: requiredCheckExternalId(identity, runId, runAttempt),
    status: 'in_progress',
    started_at: startedAt,
    output: {
      title: 'Review controller started',
      summary: [
        `repository: ${identity.repository}#${identity.pullRequestNumber}`,
        `head: ${identity.headSha}`,
        `base: ${identity.baseSha}`,
        `reviewCompleted: false`,
        `operatorWaiver: ${mode === 'operator-waiver'}`,
      ].join('\n'),
    },
  });
  assertCheckResponse(check, identity);
  if (check.status !== 'in_progress') throw new Error('Required review check did not enter in-progress state');
  return { checkRunId: check.id, identity, mode, runId: String(runId), runAttempt: String(runAttempt) };
}

export function deriveReviewCheckCompletion({
  mode,
  actionOutcome,
  enforceOutcome,
  reviewStatus,
  verdict,
  gateDecision,
  mergeEligible,
  filesOmitted,
}) {
  if (mode === 'operator-waiver') {
    return {
      conclusion: 'success',
      title: 'SHIP — operator waiver',
      verdict: 'SHIP',
      reviewCompleted: false,
      operatorWaiver: true,
      summary: [
        'verdict: SHIP',
        'reviewCompleted: false',
        'operatorWaiver: true',
        'authority: base-owned repository variable REVIEW_YETI_PASSTHROUGH=true',
        'No model review or finding publication ran for this pull request.',
        'This workflow-owned check is not a Review Yeti App maintenance receipt.',
      ].join('\n'),
    };
  }

  const completedVerdicts = new Set(['SHIP', 'FIX_FIRST', 'BLOCK']);
  const reviewCompleted = actionOutcome === 'success' && completedVerdicts.has(verdict);
  const accepted = reviewCompleted
    && enforceOutcome === 'success'
    && reviewStatus === 'SHIP'
    && verdict === 'SHIP'
    && gateDecision === 'PASS'
    && mergeEligible === 'true'
    && filesOmitted === '0';
  const visibleVerdict = ['SHIP', 'FIX_FIRST', 'BLOCK', 'INCOMPLETE', 'NO_VERDICT'].includes(verdict)
    ? verdict : 'UNRECOGNIZED';
  const visibleReviewStatus = ['SHIP', 'FIX_FIRST', 'BLOCK', 'INCOMPLETE', 'DISPATCHED'].includes(reviewStatus)
    ? reviewStatus : 'unavailable';
  const visibleGateDecision = ['PASS', 'BLOCK'].includes(gateDecision) ? gateDecision : 'unavailable';
  const visibleMergeEligible = ['true', 'false'].includes(mergeEligible) ? mergeEligible : 'unavailable';
  const visibleFilesOmitted = typeof filesOmitted === 'string' && /^\d{1,9}$/u.test(filesOmitted)
    ? filesOmitted : 'unavailable';
  return {
    conclusion: accepted ? 'success' : 'failure',
    title: accepted ? 'SHIP — complete review' : `Review ${visibleVerdict}`,
    verdict: visibleVerdict,
    reviewCompleted,
    operatorWaiver: false,
    summary: [
      `verdict: ${visibleVerdict}`,
      `reviewCompleted: ${reviewCompleted}`,
      'operatorWaiver: false',
      `reviewStatus: ${visibleReviewStatus}`,
      `gateDecision: ${visibleGateDecision}`,
      `mergeEligible: ${visibleMergeEligible}`,
      `filesOmitted: ${visibleFilesOmitted}`,
    ].join('\n'),
  };
}

export async function finishRequiredReviewCheck({
  api,
  started,
  actionOutcome,
  enforceOutcome,
  reviewStatus,
  verdict,
  gateDecision,
  mergeEligible,
  filesOmitted,
  now = () => new Date(),
}) {
  if (!Number.isSafeInteger(started?.checkRunId) || started.checkRunId <= 0) throw new Error('Started required check id is unavailable');
  let outcome;
  try {
    assertCurrentPullRequest(started.identity, await api.getCurrentPullRequest(started.identity));
    outcome = deriveReviewCheckCompletion({
      mode: started.mode,
      actionOutcome,
      enforceOutcome,
      reviewStatus,
      verdict,
      gateDecision,
      mergeEligible,
      filesOmitted,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Current pull request no longer matches')) throw error;
    outcome = {
      conclusion: 'cancelled',
      title: 'Canceled — pull request changed',
      verdict: 'NO_VERDICT',
      reviewCompleted: false,
      operatorWaiver: false,
      summary: 'reviewCompleted: false\noperatorWaiver: false\nThe admitted PR head, base, repository, or open state changed before completion.',
    };
  }

  const completedAt = now().toISOString();
  const summary = [
    `repository: ${started.identity.repository}#${started.identity.pullRequestNumber}`,
    `head: ${started.identity.headSha}`,
    `base: ${started.identity.baseSha}`,
    outcome.summary,
  ].join('\n');
  const check = await api.updateCheckRun(started.checkRunId, {
    status: 'completed',
    conclusion: outcome.conclusion,
    completed_at: completedAt,
    output: { title: outcome.title, summary },
  });
  assertCheckResponse(check, started.identity);
  if (check.status !== 'completed' || check.conclusion !== outcome.conclusion) {
    throw new Error('GitHub did not complete the required review check with the derived outcome');
  }
  return { ...outcome, summary, completedAt };
}

export function createGithubCheckApi({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token || !repositoryPattern.test(repository ?? '')) throw new Error('GitHub API credentials or repository are unavailable');
  const baseUrl = new URL(apiUrl);
  if (!['https:', 'http:'].includes(baseUrl.protocol)) throw new Error('GitHub API URL must use HTTP(S)');
  const root = `${baseUrl.href.replace(/\/$/u, '')}/repos/${repository}`;
  async function request(pathname, method = 'GET', body) {
    const response = await fetchImpl(`${root}/${pathname}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${pathname} failed with HTTP ${response.status}`);
    return response.json();
  }
  return {
    getCurrentPullRequest: identity => request(`pulls/${identity.pullRequestNumber}`),
    createCheckRun: body => request('check-runs', 'POST', body),
    updateCheckRun: (checkRunId, body) => request(`check-runs/${checkRunId}`, 'PATCH', body),
  };
}

function readWorkflowEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is unavailable');
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function workflowIdentity() {
  return identityFromEvent(readWorkflowEvent(), process.env.GITHUB_REPOSITORY, process.env.GITHUB_REPOSITORY_ID);
}

function writeOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is unavailable');
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9_-]+$/u.test(key) || /[\r\n]/u.test(String(value))) throw new Error('Workflow output is malformed');
    fs.appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

function workflowApi() {
  return createGithubCheckApi({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
}

async function main(command) {
  if (command === 'mode') {
    const mode = resolveControllerMode(process.env.GITHUB_EVENT_NAME, process.env.REVIEW_YETI_PASSTHROUGH);
    writeOutputs({ mode });
    return;
  }
  if (command === 'start') {
    const identity = workflowIdentity();
    const mode = process.env.REVIEW_MODE;
    const started = await startRequiredReviewCheck({
      api: workflowApi(),
      identity,
      mode,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    writeOutputs({ 'check-run-id': started.checkRunId, mode: started.mode });
    return;
  }
  if (command === 'finish') {
    const identity = workflowIdentity();
    const checkRunId = Number(process.env.CHECK_RUN_ID);
    const mode = process.env.REVIEW_MODE;
    const outcome = await finishRequiredReviewCheck({
      api: workflowApi(),
      started: { checkRunId, identity, mode },
      actionOutcome: process.env.ACTION_OUTCOME,
      enforceOutcome: process.env.ENFORCE_OUTCOME,
      reviewStatus: process.env.REVIEW_STATUS,
      verdict: process.env.VERDICT,
      gateDecision: process.env.GATE_DECISION,
      mergeEligible: process.env.MERGE_ELIGIBLE,
      filesOmitted: process.env.FILES_OMITTED,
    });
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) throw new Error('GITHUB_STEP_SUMMARY is unavailable');
    fs.appendFileSync(summaryPath, `## ${outcome.title}\n\n${outcome.summary}\n\n`);
    if (outcome.conclusion === 'cancelled') process.exitCode = 1;
    return;
  }
  throw new Error('Expected controller command: mode, start, or finish');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => {
    console.error(`::error::${error instanceof Error ? error.message : 'Self-review controller failed'}`);
    process.exitCode = 1;
  });
}
