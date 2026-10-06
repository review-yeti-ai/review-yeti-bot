import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_CHECK_NAME = 'Execute AI Review Pipeline';
export const GITHUB_ACTIONS_APP_ID = 15368;
export const SELF_REVIEW_EXTERNAL_ID_PREFIX = 'review-yeti-self-review:v1:';
const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CHECK_RUN_RESULTS = 1000;

const shaPattern = /^[a-f0-9]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function resolveControllerMode(eventName, passthroughValue) {
  const value = passthroughValue ?? '';
  if (value !== '' && value !== 'true' && value !== 'false') {
    throw new Error('REVIEW_YETI_PASSTHROUGH must be exactly true, false, or unset');
  }
  if (value !== 'true') return 'review';
  if (eventName === 'repository_dispatch') return 'pause-dispatch';
  if (eventName === 'pull_request_target' || eventName === 'workflow_dispatch') return 'operator-waiver';
  return 'review';
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
    || pullRequest?.state !== 'open'
    || pullRequest?.draft !== false
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

function parsePullRequestNumber(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,8}$/u.test(text)) throw new Error('Pull request number is invalid');
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error('Pull request number is invalid');
  return number;
}

export function identityFromCurrentPullRequest({ current, repository, repositoryId, defaultBranch, pullRequestNumber }) {
  const numericRepositoryId = Number(repositoryId);
  const number = parsePullRequestNumber(pullRequestNumber);
  if (!repositoryPattern.test(repository ?? '') || !Number.isSafeInteger(numericRepositoryId) || numericRepositoryId <= 0
    || current?.state !== 'open' || current?.draft !== false || current?.number !== number
    || current?.base?.repo?.id !== numericRepositoryId || current?.base?.repo?.full_name !== repository
    || current?.base?.ref !== defaultBranch || current?.base?.repo?.default_branch !== defaultBranch
    || !shaPattern.test(current?.head?.sha ?? '') || !shaPattern.test(current?.base?.sha ?? '')) {
    throw new Error('Current pull request is not an open, non-draft candidate on the repository default branch');
  }
  return {
    repository,
    repositoryId: numericRepositoryId,
    baseRef: defaultBranch,
    defaultBranch,
    pullRequestNumber: number,
    headSha: current.head.sha,
    baseSha: current.base.sha,
  };
}

export function assertCurrentPullRequest(expected, current) {
  if (!Number.isSafeInteger(expected?.repositoryId) || !repositoryPattern.test(expected?.repository ?? '')
    || !Number.isSafeInteger(expected?.pullRequestNumber) || !shaPattern.test(expected?.headSha ?? '')
    || !shaPattern.test(expected?.baseSha ?? '')
    || current?.state !== 'open'
    || current?.draft !== false
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
  return `${SELF_REVIEW_EXTERNAL_ID_PREFIX}${identity.repositoryId}:${identity.pullRequestNumber}:${identity.headSha}:${runId}:${runAttempt}`;
}

function identityExternalIdPrefix(identity) {
  return `${SELF_REVIEW_EXTERNAL_ID_PREFIX}${identity.repositoryId}:${identity.pullRequestNumber}:${identity.headSha}:`;
}

export function isOwnedOperatorWaiverCheck(check, identity) {
  if (check?.name !== REQUIRED_CHECK_NAME || check?.app?.id !== GITHUB_ACTIONS_APP_ID
    || check?.head_sha !== identity?.headSha
    || !identityExternalIdPrefix(identity)
    || typeof check?.external_id !== 'string'
    || !check.external_id.startsWith(identityExternalIdPrefix(identity))
    || !/^\d+:\d+$/u.test(check.external_id.slice(identityExternalIdPrefix(identity).length))) {
    return false;
  }
  const title = check.output?.title;
  const summary = check.output?.summary;
  if (typeof summary !== 'string' || !['Review controller started', 'SHIP — operator waiver'].includes(title)) return false;
  const lines = new Set(summary.split('\n'));
  const baseLine = [...lines].find(line => line.startsWith('base: '));
  return lines.has(`repository: ${identity.repository}#${identity.pullRequestNumber}`)
    && lines.has(`head: ${identity.headSha}`)
    && /^base: [a-f0-9]{40}$/u.test(baseLine ?? '')
    && lines.has('reviewCompleted: false')
    && lines.has('operatorWaiver: true');
}

function assertCheckResponse(check, expected, externalId) {
  if (!Number.isSafeInteger(check?.id) || check.id <= 0
    || check?.name !== REQUIRED_CHECK_NAME
    || check?.head_sha !== expected.headSha
    || check?.app?.id !== GITHUB_ACTIONS_APP_ID
    || (externalId !== undefined && check?.external_id !== externalId)) {
    throw new Error('GitHub returned a check outside the required name, exact head, or GitHub Actions app');
  }
}

export async function retirePriorOperatorWaivers({ api, identity, exceptCheckRunId, now = () => new Date() }) {
  const checks = await api.getCheckRunsForHead(identity.headSha);
  const retiredCheckRunIds = [];
  for (const prior of checks) {
    if (prior?.id === exceptCheckRunId || !isOwnedOperatorWaiverCheck(prior, identity)) continue;
    if (prior.status === 'completed' && prior.conclusion !== 'success') continue;
    // Re-read the candidate immediately before changing only this source-owned waiver check.
    assertCurrentPullRequest(identity, await api.getCurrentPullRequest(identity));
    const conclusion = prior.status === 'completed' ? 'failure' : 'cancelled';
    const updated = await api.updateCheckRun(prior.id, {
      status: 'completed',
      conclusion,
      completed_at: now().toISOString(),
      output: {
        title: 'Operator waiver superseded',
        summary: [
          `repository: ${identity.repository}#${identity.pullRequestNumber}`,
          `head: ${identity.headSha}`,
          'reviewCompleted: false',
          'operatorWaiver: false',
          'A newer base-owned controller run superseded this operator waiver.',
        ].join('\n'),
      },
    });
    if (updated?.id !== prior.id || updated?.name !== REQUIRED_CHECK_NAME
      || updated?.head_sha !== identity.headSha || updated?.app?.id !== GITHUB_ACTIONS_APP_ID
      || updated?.external_id !== prior.external_id || updated?.status !== 'completed'
      || updated?.conclusion !== conclusion) {
      throw new Error('GitHub did not retire the exact prior operator waiver check');
    }
    retiredCheckRunIds.push(prior.id);
  }
  return retiredCheckRunIds;
}

export async function startRequiredReviewCheck({
  api, identity, mode, runId, runAttempt, eventName = 'pull_request_target', dispatchTargetRepository = null,
  now = () => new Date(),
}) {
  if (!['review', 'operator-waiver'].includes(mode)) throw new Error('Review controller mode is invalid');
  if (!['pull_request_target', 'workflow_dispatch', 'repository_dispatch'].includes(eventName)
    || (eventName === 'repository_dispatch'
      ? mode !== 'operator-waiver' || dispatchTargetRepository !== identity.repository
      : dispatchTargetRepository !== null)) {
    throw new Error('Review check trigger is not bound to an eligible base-owned event');
  }
  assertCurrentPullRequest(identity, await api.getCurrentPullRequest(identity));
  const retiredCheckRunIds = mode === 'review'
    ? await retirePriorOperatorWaivers({ api, identity, now })
    : [];
  const startedAt = now().toISOString();
  const externalId = requiredCheckExternalId(identity, runId, runAttempt);
  const check = await api.createCheckRun({
    name: REQUIRED_CHECK_NAME,
    head_sha: identity.headSha,
    external_id: externalId,
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
        ...(mode === 'operator-waiver' ? ['review-mode: passthrough', 'review lanes: 0', 'noReview: true', 'noModel: true', 'noFindings: true'] : ['review-mode: review']),
      ].join('\n'),
    },
  });
  assertCheckResponse(check, identity, externalId);
  if (check.status !== 'in_progress') throw new Error('Required review check did not enter in-progress state');
  return {
    checkRunId: check.id, identity, mode, runId: String(runId), runAttempt: String(runAttempt), externalId,
    eventName, dispatchTargetRepository, retiredCheckRunIds,
  };
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
      reviewStatus: 'OPERATOR_WAIVER',
      gateDecision: 'OPERATOR_WAIVER',
      mergeEligible: true,
      filesOmitted: null,
      reviewCompleted: false,
      operatorWaiver: true,
      summary: [
        'review-mode: passthrough',
        'review lanes: 0',
        'verdict: SHIP',
        'reviewCompleted: false',
        'operatorWaiver: true',
        'noReview: true',
        'noModel: true',
        'noFindings: true',
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
    reviewStatus: visibleReviewStatus,
    gateDecision: visibleGateDecision,
    mergeEligible: visibleMergeEligible === 'true' ? true : visibleMergeEligible === 'false' ? false : null,
    filesOmitted: /^\d{1,9}$/u.test(visibleFilesOmitted) ? Number(visibleFilesOmitted) : null,
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

function canceledOutcome(started, message) {
  const waiver = started.mode === 'operator-waiver';
  return {
    conclusion: 'cancelled',
    title: 'Canceled — controller evidence changed',
    verdict: 'NO_VERDICT',
    reviewStatus: 'NO_REVIEW',
    gateDecision: 'NO_REVIEW',
    mergeEligible: false,
    filesOmitted: null,
    reviewCompleted: false,
    operatorWaiver: waiver,
    summary: [
      waiver ? 'review-mode: passthrough' : 'review-mode: review',
      'reviewCompleted: false',
      `operatorWaiver: ${waiver}`,
      `No SHIP was issued: ${message}`,
    ].join('\n'),
  };
}

export async function finishRequiredReviewCheck({
  api,
  started,
  currentMode,
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
    if (!['review', 'operator-waiver'].includes(currentMode) || currentMode !== started.mode) {
      throw new Error('Trusted controller mode changed before completion');
    }
    const externalId = requiredCheckExternalId(started.identity, started.runId, started.runAttempt);
    const currentCheck = await api.getCheckRun(started.checkRunId);
    assertCheckResponse(currentCheck, started.identity, externalId);
    if (currentCheck.status !== 'in_progress') throw new Error('Started check is no longer the active controller attempt');
    const checks = await api.getCheckRunsForHead(started.identity.headSha);
    const superseded = checks.some(check => check?.id > started.checkRunId
      && check?.name === REQUIRED_CHECK_NAME
      && check?.app?.id === GITHUB_ACTIONS_APP_ID
      && check?.head_sha === started.identity.headSha
      && typeof check?.external_id === 'string'
      && check.external_id.startsWith(identityExternalIdPrefix(started.identity)));
    if (superseded) throw new Error('A newer exact-head controller check superseded this attempt');
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
    const knownInvalidation = error instanceof Error && [
      'Current pull request no longer matches',
      'Trusted controller mode changed',
      'A newer exact-head controller check superseded',
      'Started check is no longer the active controller attempt',
    ].some(prefix => error.message.startsWith(prefix));
    if (!knownInvalidation) throw error;
    outcome = canceledOutcome(started, error.message);
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
  assertCheckResponse(check, started.identity, requiredCheckExternalId(started.identity, started.runId, started.runAttempt));
  if (check.status !== 'completed' || check.conclusion !== outcome.conclusion) {
    throw new Error('GitHub did not complete the required review check with the derived outcome');
  }
  return { ...outcome, summary, completedAt, check };
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
  async function getCheckRunsForHead(headSha) {
    if (!shaPattern.test(headSha ?? '')) throw new Error('Check-run head SHA is invalid');
    const checkRuns = [];
    const seenIds = new Set();
    let totalCount;
    let page = 1;
    do {
      if (page > MAX_CHECK_RUN_RESULTS / CHECK_RUN_PAGE_SIZE) {
        throw new Error('GitHub check-run pagination exceeded the bounded result limit');
      }
      const result = await request(`commits/${headSha}/check-runs?filter=all&per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`);
      if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0 || !Array.isArray(result?.check_runs)) {
        throw new Error('GitHub returned an invalid check-run page');
      }
      if (totalCount === undefined) totalCount = result.total_count;
      else if (result.total_count !== totalCount) throw new Error('GitHub check-run total changed during pagination');
      if (totalCount > MAX_CHECK_RUN_RESULTS) throw new Error('GitHub check-run result exceeded the bounded result limit');
      const expectedPageLength = Math.min(CHECK_RUN_PAGE_SIZE, totalCount - checkRuns.length);
      if (result.check_runs.length !== expectedPageLength) {
        throw new Error('GitHub check-run pagination returned an incomplete or inconsistent page');
      }
      for (const check of result.check_runs) {
        if (!Number.isSafeInteger(check?.id) || check.id <= 0 || seenIds.has(check.id)) {
          throw new Error('GitHub check-run pagination returned an invalid or duplicate check ID');
        }
        seenIds.add(check.id);
        checkRuns.push(check);
      }
      page += 1;
    } while (checkRuns.length < totalCount);
    return checkRuns;
  }
  return {
    getCurrentPullRequest: identity => request(`pulls/${identity.pullRequestNumber}`),
    getPullRequest: pullRequestNumber => request(`pulls/${parsePullRequestNumber(pullRequestNumber)}`),
    getCheckRun: checkRunId => {
      if (!Number.isSafeInteger(checkRunId) || checkRunId <= 0) throw new Error('Check-run ID is invalid');
      return request(`check-runs/${checkRunId}`);
    },
    getCheckRunsForHead,
    createCheckRun: body => request('check-runs', 'POST', body),
    updateCheckRun: (checkRunId, body) => request(`check-runs/${checkRunId}`, 'PATCH', body),
  };
}

function readWorkflowEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is unavailable');
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function isInvalidCurrentCandidate(error) {
  return error instanceof Error && error.message.startsWith('Current pull request is not an open, non-draft candidate');
}

function noReviewAcknowledgement() {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, '## No review check created\n\nThe paused repository-dispatch request did not identify an eligible current pull request in this repository. No review, model call, finding publication, or SHIP check was issued.\n');
  }
}

export async function selectStartCandidate({ api, eventName, mode, event, repository, repositoryId }) {
  const defaultBranch = event?.repository?.default_branch;
  if (eventName === 'pull_request_target') {
    return { identity: identityFromEvent(event, repository, repositoryId), mode, eventName, dispatchTargetRepository: null };
  }
  if (eventName === 'workflow_dispatch') {
    const number = parsePullRequestNumber(event?.inputs?.pull_request_number);
    const current = await api.getPullRequest(number);
    return {
      identity: identityFromCurrentPullRequest({ current, repository, repositoryId, defaultBranch, pullRequestNumber: number }),
      mode, eventName, dispatchTargetRepository: null,
    };
  }
  if (eventName === 'repository_dispatch' && mode === 'review') return { mode: 'dispatch-review' };
  if (eventName === 'repository_dispatch' && mode === 'pause-dispatch') {
    const targetRepository = event?.client_payload?.target_repo;
    if (targetRepository !== repository) return { mode: 'no-review-ack' };
    let number;
    try {
      number = parsePullRequestNumber(event?.client_payload?.pr_number);
    } catch {
      return { mode: 'no-review-ack' };
    }
    let current;
    try {
      current = await api.getPullRequest(number);
    } catch (error) {
      if (error instanceof Error && error.message.includes('HTTP 404')) return { mode: 'no-review-ack' };
      throw error;
    }
    try {
      return {
        identity: identityFromCurrentPullRequest({ current, repository, repositoryId, defaultBranch, pullRequestNumber: number }),
        mode: 'operator-waiver', eventName, dispatchTargetRepository: targetRepository,
      };
    } catch (error) {
      if (isInvalidCurrentCandidate(error)) return { mode: 'no-review-ack' };
      throw error;
    }
  }
  throw new Error('Workflow event is not eligible for a base-owned review check');
}

async function startIdentityForEvent(api, mode) {
  const event = readWorkflowEvent();
  return selectStartCandidate({
    api,
    eventName: process.env.GITHUB_EVENT_NAME,
    mode,
    event,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
  });
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

function currentModeForEvent(eventName, passthroughValue) {
  const mode = resolveControllerMode(eventName, passthroughValue);
  return mode === 'pause-dispatch' ? 'operator-waiver' : mode;
}

function assertStartedIdentity(value) {
  if (!value || !repositoryPattern.test(value.repository ?? '')
    || !Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0
    || !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber <= 0
    || !shaPattern.test(value.headSha ?? '') || !shaPattern.test(value.baseSha ?? '')
    || value.baseRef !== value.defaultBranch || typeof value.defaultBranch !== 'string') {
    throw new Error('Started review candidate identity is invalid');
  }
  return value;
}

export function buildControllerReceipt({ started, outcome, check, executionSha, workflowName, workflowRef }) {
  if (!started || !['review', 'operator-waiver'].includes(started.mode)
    || !Number.isSafeInteger(started.checkRunId) || started.checkRunId <= 0
    || !/^\d+$/u.test(started.runId ?? '') || !/^\d+$/u.test(started.runAttempt ?? '')
    || !shaPattern.test(executionSha ?? '') || typeof workflowName !== 'string' || workflowName.length === 0
    || !['pull_request_target', 'workflow_dispatch', 'repository_dispatch'].includes(started.eventName)
    || (started.eventName === 'repository_dispatch'
      ? started.mode !== 'operator-waiver' || started.dispatchTargetRepository !== started.identity.repository
      : started.dispatchTargetRepository !== null)
    || typeof workflowRef !== 'string' || !workflowRef.startsWith(`${started.identity.repository}/`)) {
    throw new Error('Controller receipt workflow identity is invalid');
  }
  const checkPathAndRef = workflowRef.slice(started.identity.repository.length + 1);
  const separator = checkPathAndRef.lastIndexOf('@');
  const workflowPath = separator > 0 ? checkPathAndRef.slice(0, separator) : '';
  if (workflowPath !== '.github/workflows/review-bot.yaml' || !check || check.id !== started.checkRunId
    || check.name !== REQUIRED_CHECK_NAME || check.app?.id !== GITHUB_ACTIONS_APP_ID
    || check.head_sha !== started.identity.headSha || check.external_id !== started.externalId
    || check.status !== 'completed' || check.conclusion !== outcome.conclusion
    || check.output?.title !== outcome.title || check.output?.summary !== outcome.summary) {
    throw new Error('Controller receipt is not bound to the completed official check');
  }
  const waiver = started.mode === 'operator-waiver';
  return {
    schemaVersion: 1,
    checkRunId: check.id,
    checkName: check.name,
    checkAppId: check.app.id,
    checkExternalId: check.external_id,
    checkHeadSha: check.head_sha,
    repositoryId: started.identity.repositoryId,
    repository: started.identity.repository,
    pullRequestNumber: started.identity.pullRequestNumber,
    headSha: started.identity.headSha,
    baseSha: started.identity.baseSha,
    executionSha,
    workflowName,
    workflowPath,
    workflowRef,
    runId: Number(started.runId),
    runAttempt: Number(started.runAttempt),
    eventName: started.eventName,
    dispatchTargetRepository: started.dispatchTargetRepository,
    mode: started.mode,
    conclusion: check.conclusion,
    title: check.output.title,
    summary: check.output.summary,
    reviewCompleted: outcome.reviewCompleted,
    operatorWaiver: outcome.operatorWaiver,
    verdict: outcome.verdict,
    reviewStatus: outcome.reviewStatus,
    gateDecision: outcome.gateDecision,
    mergeEligible: outcome.mergeEligible,
    filesOmitted: outcome.filesOmitted,
    noReview: waiver,
    noModel: waiver,
    noFindings: waiver,
  };
}

export function writeControllerReceipt(started, outcome) {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('RUNNER_TEMP is unavailable');
  const check = outcome.check;
  const receipt = buildControllerReceipt({
    started,
    outcome,
    check,
    executionSha: process.env.GITHUB_SHA,
    workflowName: process.env.GITHUB_WORKFLOW,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
  });
  const receiptDirectory = path.join(runnerTemp, 'review-controller-receipt');
  fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(receiptDirectory, 'receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receiptPath;
}

async function main(command) {
  if (command === 'mode') {
    const mode = resolveControllerMode(process.env.GITHUB_EVENT_NAME, process.env.REVIEW_YETI_PASSTHROUGH);
    writeOutputs({ mode });
    return;
  }
  if (command === 'start') {
    const api = workflowApi();
    const selected = await startIdentityForEvent(api, process.env.REVIEW_MODE);
    if (['no-review-ack', 'dispatch-review'].includes(selected.mode)) {
      if (selected.mode === 'no-review-ack') noReviewAcknowledgement();
      writeOutputs({ 'check-run-id': '', mode: selected.mode, identity: '', 'pull-request-number': '' });
      return;
    }
    const started = await startRequiredReviewCheck({
      api,
      identity: selected.identity,
      mode: selected.mode,
      eventName: selected.eventName,
      dispatchTargetRepository: selected.dispatchTargetRepository ?? null,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    writeOutputs({
      'check-run-id': started.checkRunId,
      mode: started.mode,
      identity: JSON.stringify(started.identity),
      'pull-request-number': started.identity.pullRequestNumber,
      'event-name': started.eventName,
      'dispatch-target-repository': started.dispatchTargetRepository ?? '',
    });
    return;
  }
  if (command === 'finish') {
    const identity = assertStartedIdentity(JSON.parse(process.env.STARTED_IDENTITY_JSON || '{}'));
    const checkRunId = Number(process.env.CHECK_RUN_ID);
    const mode = process.env.REVIEW_MODE;
    const runId = process.env.GITHUB_RUN_ID;
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
    const outcome = await finishRequiredReviewCheck({
      api: workflowApi(),
      started: { checkRunId, identity, mode, runId, runAttempt, externalId: requiredCheckExternalId(identity, runId, runAttempt) },
      currentMode: currentModeForEvent(process.env.GITHUB_EVENT_NAME, process.env.REVIEW_YETI_PASSTHROUGH),
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
    const receiptPath = writeControllerReceipt({
      checkRunId, identity, mode, runId, runAttempt,
      eventName: process.env.REVIEW_EVENT_NAME,
      dispatchTargetRepository: process.env.DISPATCH_TARGET_REPOSITORY || null,
      externalId: requiredCheckExternalId(identity, runId, runAttempt),
    }, outcome);
    writeOutputs({ 'receipt-path': receiptPath });
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
