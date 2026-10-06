import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

type AnyObject = Record<string, any>;
type ControllerModule = Record<string, unknown>;

const modulePath = path.resolve(__dirname, '../../scripts/self-review-check-run.mjs');
let controller: ControllerModule = {};
if (fs.existsSync(modulePath)) {
  try {
    controller = await import(pathToFileURL(modulePath).href) as ControllerModule;
  } catch {
    controller = {};
  }
}

function controllerFunction<T extends (...args: any[]) => any>(name: string): T {
  const implementation = controller[name];
  expect(typeof implementation, `${name} must implement the public controller contract`).toBe('function');
  return implementation as T;
}

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const identity = {
  repository: 'review-yeti-ai/review-yeti-bot',
  repositoryId: 1326169548,
  baseRef: 'main',
  defaultBranch: 'main',
  pullRequestNumber: 42,
  headSha,
  baseSha,
};

function currentPullRequest(overrides: AnyObject = {}): AnyObject {
  return {
    number: identity.pullRequestNumber,
    state: 'open',
    draft: false,
    head: { sha: headSha, repo: { id: 1326169548 } },
    base: { ref: 'main', sha: baseSha, repo: { id: 1326169548, full_name: identity.repository, default_branch: 'main' } },
    ...overrides,
  };
}

function waiverCheck(id: number, overrides: AnyObject = {}): AnyObject {
  const priorBase = 'c'.repeat(40);
  return {
    id,
    name: 'Execute AI Review Pipeline',
    head_sha: headSha,
    external_id: `review-yeti-self-review:v1:${identity.repositoryId}:${identity.pullRequestNumber}:${headSha}:765432:1`,
    status: 'completed',
    conclusion: 'success',
    app: { id: 15368 },
    output: {
      title: 'SHIP — operator waiver',
      summary: [
        `repository: ${identity.repository}#${identity.pullRequestNumber}`,
        `head: ${headSha}`,
        `base: ${priorBase}`,
        'verdict: SHIP',
        'reviewCompleted: false',
        'operatorWaiver: true',
      ].join('\n'),
    },
    ...overrides,
  };
}

function fakeApi(overrides: {
  current?: AnyObject;
  created?: AnyObject;
  updated?: AnyObject;
  checkRuns?: AnyObject[];
  check?: AnyObject;
} = {}) {
  const calls: string[] = [];
  let createdBody: AnyObject | undefined;
  const createCheckRun = vi.fn(async (body: AnyObject) => {
    calls.push('create');
    createdBody = body;
    return {
      id: 9001,
      name: 'Execute AI Review Pipeline',
      head_sha: identity.headSha,
      external_id: body.external_id,
      status: 'in_progress',
      app: { id: 15368 },
      output: body.output,
      body,
      ...overrides.created,
    };
  });
  const updateCheckRun = vi.fn(async (id: number, body: AnyObject) => {
    calls.push('update');
    const prior = overrides.checkRuns?.find(candidate => candidate.id === id);
    return {
      id,
      name: 'Execute AI Review Pipeline',
      head_sha: identity.headSha,
      external_id: prior?.external_id ?? createdBody?.external_id,
      status: 'completed',
      conclusion: body.conclusion,
      app: { id: 15368 },
      output: body.output,
      body,
      ...overrides.updated,
    };
  });
  return {
    calls,
    getCurrentPullRequest: vi.fn(async () => overrides.current ?? currentPullRequest()),
    getCheckRunsForHead: vi.fn(async () => overrides.checkRuns ?? []),
    getCheckRun: vi.fn(async () => overrides.check ?? {
      id: 9001, name: 'Execute AI Review Pipeline', head_sha: identity.headSha,
      external_id: createdBody?.external_id,
      status: 'in_progress', conclusion: null, app: { id: 15368 },
    }),
    createCheckRun,
    updateCheckRun,
  };
}

describe('base-owned self-review check controller', () => {
  it('binds the admitted target to this repository and its default branch', () => {
    const identityFromEvent = controllerFunction<(event: AnyObject, repository: string, repositoryId: string) => AnyObject>('identityFromEvent');
    const event = {
      repository: { id: 1326169548, full_name: identity.repository, default_branch: 'main' },
      pull_request: {
        number: 42,
        state: 'open',
        draft: false,
        head: { sha: headSha },
        base: { ref: 'main', sha: baseSha, repo: { id: 1326169548 } },
      },
    };
    expect(identityFromEvent(event, identity.repository, '1326169548')).toMatchObject(identity);
    expect(() => identityFromEvent({ ...event, pull_request: { ...event.pull_request, base: { ...event.pull_request.base, ref: 'release' } } }, identity.repository, '1326169548')).toThrow();
    expect(() => identityFromEvent(event, identity.repository, '7')).toThrow();
  });

  it('treats only the exact repository variable true as an operator waiver for pull requests', () => {
    const resolveControllerMode = controllerFunction<(eventName: string, value: string | undefined) => string>('resolveControllerMode');
    expect(resolveControllerMode('pull_request_target', 'true')).toBe('operator-waiver');
    expect(resolveControllerMode('pull_request_target', 'false')).toBe('review');
    expect(resolveControllerMode('pull_request_target', undefined)).toBe('review');
    expect(resolveControllerMode('repository_dispatch', 'true')).toBe('pause-dispatch');
    expect(resolveControllerMode('workflow_dispatch', 'true')).toBe('operator-waiver');
    expect(resolveControllerMode('workflow_dispatch', 'false')).toBe('review');
    expect(() => resolveControllerMode('pull_request_target', 'TRUE')).toThrow(/must be exactly/i);
    expect(() => resolveControllerMode('pull_request_target', 'yes')).toThrow(/must be exactly/i);
  });

  it('rejects a current PR read whose repository, open state, head, base, or number differs from the event', () => {
    const assertCurrentPullRequest = controllerFunction<(expected: AnyObject, current: AnyObject) => void>('assertCurrentPullRequest');
    expect(() => assertCurrentPullRequest(identity, currentPullRequest())).not.toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ number: 43 }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ state: 'closed' }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ draft: true }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ head: { sha: 'c'.repeat(40), repo: { id: 1326169548 } } }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ base: { sha: 'd'.repeat(40), repo: { id: 1326169548 } } }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ base: { sha: baseSha, repo: { id: 7 } } }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ base: { ...currentPullRequest().base, ref: 'release' } }))).toThrow();
  });

  it('derives manual reconciliation identity from the current PR API response, not caller head fields', () => {
    const identityFromCurrentPullRequest = controllerFunction<(input: AnyObject) => AnyObject>('identityFromCurrentPullRequest');
    const result = identityFromCurrentPullRequest({
      current: currentPullRequest({ head: { sha: 'd'.repeat(40), repo: { id: 987 } } }),
      repository: identity.repository,
      repositoryId: identity.repositoryId,
      defaultBranch: 'main',
      pullRequestNumber: identity.pullRequestNumber,
    });
    expect(result).toMatchObject({
      repository: identity.repository,
      repositoryId: identity.repositoryId,
      pullRequestNumber: identity.pullRequestNumber,
      headSha: 'd'.repeat(40),
      baseSha,
    });
    expect(() => identityFromCurrentPullRequest({
      current: currentPullRequest({ draft: true }), repository: identity.repository,
      repositoryId: identity.repositoryId, defaultBranch: 'main', pullRequestNumber: 42,
    })).toThrow(/open, non-draft/i);
  });

  it('creates a paused dispatch waiver only for an exact current same-repository PR', async () => {
    const selectStartCandidate = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('selectStartCandidate');
    const api = { getPullRequest: vi.fn(async () => currentPullRequest()) };
    const event = {
      repository: { default_branch: 'main' },
      client_payload: { target_repo: identity.repository, pr_number: 42 },
    };
    const selected = await selectStartCandidate({
      api, eventName: 'repository_dispatch', mode: 'pause-dispatch', event,
      repository: identity.repository, repositoryId: identity.repositoryId,
    });
    expect(selected).toMatchObject({
      identity, mode: 'operator-waiver', eventName: 'repository_dispatch', dispatchTargetRepository: identity.repository,
    });
    expect(api.getPullRequest).toHaveBeenCalledWith(42);

    const externalApi = { getPullRequest: vi.fn() };
    const external = await selectStartCandidate({
      api: externalApi, eventName: 'repository_dispatch', mode: 'pause-dispatch',
      event: { ...event, client_payload: { target_repo: 'external/fork', pr_number: 42 } },
      repository: identity.repository, repositoryId: identity.repositoryId,
    });
    expect(external).toEqual({ mode: 'no-review-ack' });
    expect(externalApi.getPullRequest).not.toHaveBeenCalled();

    const closedApi = { getPullRequest: vi.fn(async () => currentPullRequest({ state: 'closed' })) };
    const closed = await selectStartCandidate({
      api: closedApi, eventName: 'repository_dispatch', mode: 'pause-dispatch', event,
      repository: identity.repository, repositoryId: identity.repositoryId,
    });
    expect(closed).toEqual({ mode: 'no-review-ack' });
  });

  it('keeps unpaused repository dispatch on its existing external review path without a local check', async () => {
    const selectStartCandidate = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('selectStartCandidate');
    const api = { getPullRequest: vi.fn() };
    await expect(selectStartCandidate({
      api, eventName: 'repository_dispatch', mode: 'review', event: {},
      repository: identity.repository, repositoryId: identity.repositoryId,
    })).resolves.toEqual({ mode: 'dispatch-review' });
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it('creates the required check on the event head only after a matching live PR read', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({
      api, identity, mode: 'review', runId: '123456', runAttempt: '1', now: () => new Date('2026-10-06T01:00:00.000Z'),
    });
    expect(api.getCurrentPullRequest).toHaveBeenCalledWith(identity);
    expect(api.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Execute AI Review Pipeline',
      head_sha: headSha,
      status: 'in_progress',
      started_at: '2026-10-06T01:00:00.000Z',
      external_id: expect.stringContaining('123456:1'),
    }));
    expect(started).toMatchObject({ checkRunId: 9001, identity, mode: 'review' });
  });

  it('retires only exact same-head owned waiver checks before unpaused review continues, including an older base', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const oldWaiver = waiverCheck(8000);
    const ordinary = waiverCheck(8001, {
      output: { title: 'Review SHIP', summary: `repository: ${identity.repository}#42\nhead: ${headSha}\nbase: ${baseSha}\nreviewCompleted: true\noperatorWaiver: false` },
    });
    const wrongApp = waiverCheck(8002, { app: { id: 4385771 } });
    const api = fakeApi({ checkRuns: [oldWaiver, ordinary, wrongApp] });
    const started = await startRequiredReviewCheck({ api, identity, mode: 'review', runId: '123456', runAttempt: '2' });
    expect(api.calls).toEqual(['update', 'create']);
    expect(api.updateCheckRun).toHaveBeenCalledTimes(1);
    expect(api.updateCheckRun).toHaveBeenCalledWith(8000, expect.objectContaining({
      status: 'completed', conclusion: 'failure',
      output: expect.objectContaining({ title: 'Operator waiver superseded' }),
    }));
    expect(started.checkRunId).toBe(9001);
  });

  it('does not retire prior waiver checks while the operator waiver mode remains active', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const api = fakeApi({ checkRuns: [waiverCheck(8000)] });
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '3' });
    expect(started.retiredCheckRunIds).toEqual([]);
    expect(api.getCheckRunsForHead).not.toHaveBeenCalled();
    expect(api.updateCheckRun).not.toHaveBeenCalled();
  });

  it('refuses a check response from any app other than the required GitHub Actions app', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const api = fakeApi({ created: { app: { id: 4385771 } } });
    await expect(startRequiredReviewCheck({ api, identity, mode: 'review', runId: '123456', runAttempt: '1' }))
      .rejects.toThrow(/GitHub Actions app/i);
  });

  it('completes operator passthrough as a transparent SHIP waiver without reporting review completion', () => {
    const deriveReviewCheckCompletion = controllerFunction<(input: AnyObject) => AnyObject>('deriveReviewCheckCompletion');
    const result = deriveReviewCheckCompletion({ mode: 'operator-waiver' });
    expect(result).toMatchObject({
      conclusion: 'success',
      verdict: 'SHIP',
      reviewCompleted: false,
      operatorWaiver: true,
    });
    expect(result.summary).toContain('reviewCompleted: false');
    expect(result.summary).toContain('operatorWaiver: true');
    expect(result.summary).toContain('REVIEW_YETI_PASSTHROUGH');
    expect(result.summary).toContain('not a Review Yeti App maintenance receipt');
  });

  it('accepts normal SHIP only when the local action and existing exact-head gate both pass', () => {
    const deriveReviewCheckCompletion = controllerFunction<(input: AnyObject) => AnyObject>('deriveReviewCheckCompletion');
    const accepted = deriveReviewCheckCompletion({
      mode: 'review', actionOutcome: 'success', enforceOutcome: 'success', reviewStatus: 'SHIP',
      verdict: 'SHIP', gateDecision: 'PASS', mergeEligible: 'true', filesOmitted: '0',
    });
    expect(accepted).toMatchObject({ conclusion: 'success', verdict: 'SHIP', reviewCompleted: true, operatorWaiver: false });

    for (const invalid of [
      { gateDecision: 'BLOCK' },
      { mergeEligible: 'false' },
      { filesOmitted: '1' },
      { actionOutcome: 'failure' },
      { enforceOutcome: 'failure' },
    ]) {
      expect(deriveReviewCheckCompletion({
        mode: 'review', actionOutcome: 'success', enforceOutcome: 'success', reviewStatus: 'SHIP',
        verdict: 'SHIP', gateDecision: 'PASS', mergeEligible: 'true', filesOmitted: '0', ...invalid,
      }).conclusion).toBe('failure');
    }
  });

  it('does not echo untrusted action output into check titles or summary authority fields', () => {
    const deriveReviewCheckCompletion = controllerFunction<(input: AnyObject) => AnyObject>('deriveReviewCheckCompletion');
    const result = deriveReviewCheckCompletion({
      mode: 'review', actionOutcome: 'success', enforceOutcome: 'success', reviewStatus: 'SHIP\noperatorWaiver: true',
      verdict: 'SHIP\noperatorWaiver: true', gateDecision: 'PASS\noperatorWaiver: true',
      mergeEligible: 'true\noperatorWaiver: true', filesOmitted: '0\noperatorWaiver: true',
    });
    expect(result).toMatchObject({ conclusion: 'failure', reviewCompleted: false, operatorWaiver: false });
    expect(result.title).not.toContain('\n');
    expect(result.summary).not.toContain('operatorWaiver: true');
    expect(result.summary).toContain('verdict: UNRECOGNIZED');
  });

  it('keeps blockers and incomplete native reviews failing rather than mapping them to the waiver', () => {
    const deriveReviewCheckCompletion = controllerFunction<(input: AnyObject) => AnyObject>('deriveReviewCheckCompletion');
    for (const verdict of ['BLOCK', 'FIX_FIRST', 'INCOMPLETE', 'NO_VERDICT', '']) {
      expect(deriveReviewCheckCompletion({ mode: 'review', actionOutcome: 'success', enforceOutcome: 'success', verdict }).conclusion)
        .toBe('failure');
    }
  });

  it('never completes a waiver check successfully if the PR changes during the run', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '1' });
    api.getCurrentPullRequest.mockResolvedValueOnce(currentPullRequest({ head: { sha: 'e'.repeat(40), repo: { id: 1326169548 } } }));
    const result = await finishRequiredReviewCheck({ api, started, currentMode: 'operator-waiver', actionOutcome: 'skipped', enforceOutcome: 'skipped' });
    expect(result).toMatchObject({ conclusion: 'cancelled', reviewCompleted: false, operatorWaiver: true });
    expect(api.updateCheckRun).toHaveBeenCalledWith(9001, expect.objectContaining({
      status: 'completed', conclusion: 'cancelled',
    }));
  });

  it('cancels a waiver when the trusted mode snapshot changes before finish', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '1' });
    const result = await finishRequiredReviewCheck({ api, started, currentMode: 'review', actionOutcome: 'skipped', enforceOutcome: 'skipped' });
    expect(result).toMatchObject({ conclusion: 'cancelled', verdict: 'NO_VERDICT', reviewCompleted: false, operatorWaiver: true });
    expect(api.updateCheckRun).toHaveBeenCalledWith(9001, expect.objectContaining({ conclusion: 'cancelled' }));
  });

  it('does not let an older controller finish after a newer exact-head controller check exists', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const newer = waiverCheck(9002, { status: 'in_progress', conclusion: null });
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '1' });
    api.getCheckRunsForHead.mockResolvedValue([newer]);
    const result = await finishRequiredReviewCheck({ api, started, currentMode: 'operator-waiver', actionOutcome: 'skipped', enforceOutcome: 'skipped' });
    expect(result.conclusion).toBe('cancelled');
  });

  it('finishes an exact current check with the derived outcome and truthful summary', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '1' });
    const result = await finishRequiredReviewCheck({
      api, started, currentMode: 'operator-waiver', actionOutcome: 'skipped', enforceOutcome: 'skipped',
      now: () => new Date('2026-10-06T01:01:00.000Z'),
    });
    expect(api.updateCheckRun).toHaveBeenCalledWith(9001, expect.objectContaining({
      status: 'completed', conclusion: 'success', completed_at: '2026-10-06T01:01:00.000Z',
      output: expect.objectContaining({ title: expect.stringContaining('operator waiver'), summary: expect.stringContaining('reviewCompleted: false') }),
    }));
    expect(result).toMatchObject({ conclusion: 'success', verdict: 'SHIP', reviewCompleted: false, operatorWaiver: true });
  });

  it('builds a run-bound receipt from the verified check response and trusted workflow context', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const buildControllerReceipt = controllerFunction<(input: AnyObject) => AnyObject>('buildControllerReceipt');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '1' });
    const outcome = await finishRequiredReviewCheck({ api, started, currentMode: 'operator-waiver', actionOutcome: 'skipped', enforceOutcome: 'skipped' });
    const check = outcome.check;
    const receipt = buildControllerReceipt({
      started, outcome, check,
      executionSha: 'e'.repeat(40), workflowName: 'Review Bot',
      workflowRef: `${identity.repository}/.github/workflows/review-bot.yaml@refs/heads/main`,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1, checkRunId: 9001, checkName: 'Execute AI Review Pipeline', checkAppId: 15368,
      repositoryId: identity.repositoryId, repository: identity.repository, pullRequestNumber: 42,
      headSha, baseSha, executionSha: 'e'.repeat(40), runId: 123456, runAttempt: 1, mode: 'operator-waiver',
      conclusion: 'success', verdict: 'SHIP', reviewStatus: 'OPERATOR_WAIVER', gateDecision: 'OPERATOR_WAIVER',
      mergeEligible: true, filesOmitted: null, reviewCompleted: false, operatorWaiver: true,
      noReview: true, noModel: true, noFindings: true,
      eventName: 'pull_request_target', dispatchTargetRepository: null,
    });

    const writeControllerReceipt = controllerFunction<(started: AnyObject, outcome: AnyObject) => string>('writeControllerReceipt');
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-controller-receipt-'));
    try {
      vi.stubEnv('RUNNER_TEMP', runnerTemp);
      vi.stubEnv('GITHUB_SHA', 'e'.repeat(40));
      vi.stubEnv('GITHUB_WORKFLOW', 'Review Bot');
      vi.stubEnv('GITHUB_WORKFLOW_REF', `${identity.repository}/.github/workflows/review-bot.yaml@refs/heads/main`);
      const receiptPath = writeControllerReceipt(started, outcome);
      expect(path.relative(runnerTemp, receiptPath)).toBe(path.join('review-controller-receipt', 'receipt.json'));
      expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).toEqual(receipt);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('records a normal completed review distinctly from an operator waiver', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const buildControllerReceipt = controllerFunction<(input: AnyObject) => AnyObject>('buildControllerReceipt');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'review', runId: '123456', runAttempt: '5' });
    const outcome = await finishRequiredReviewCheck({
      api, started, currentMode: 'review', actionOutcome: 'success', enforceOutcome: 'success',
      reviewStatus: 'SHIP', verdict: 'SHIP', gateDecision: 'PASS', mergeEligible: 'true', filesOmitted: '0',
    });
    const receipt = buildControllerReceipt({
      started, outcome, check: outcome.check,
      executionSha: 'e'.repeat(40), workflowName: 'Review Bot',
      workflowRef: `${identity.repository}/.github/workflows/review-bot.yaml@refs/heads/main`,
    });
    expect(receipt).toMatchObject({
      mode: 'review', eventName: 'pull_request_target', dispatchTargetRepository: null,
      conclusion: 'success', verdict: 'SHIP', reviewCompleted: true, operatorWaiver: false,
      noReview: false, noModel: false, noFindings: false, filesOmitted: 0,
    });
    expect(receipt.summary).not.toContain('review-mode: passthrough');
  });

  it('uses filter=all and finds a prior waiver beyond the default-latest page', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const createGithubCheckApi = controllerFunction<(input: AnyObject) => AnyObject>('createGithubCheckApi');
    const urls: URL[] = [];
    const previousWaiver = waiverCheck(8000);
    const fetchImpl = vi.fn(async (input: string, init: AnyObject = {}) => {
      const url = new URL(input);
      urls.push(url);
      if (url.pathname.endsWith(`/pulls/${identity.pullRequestNumber}`)) {
        return new Response(JSON.stringify(currentPullRequest()), { status: 200 });
      }
      if (url.pathname.endsWith(`/commits/${headSha}/check-runs`)) {
        const page = Number(url.searchParams.get('page'));
        const checkRuns = page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ id: 10000 + index, name: `Other ${index}` }))
          : [previousWaiver];
        return new Response(JSON.stringify({ total_count: 101, check_runs: checkRuns }), { status: 200 });
      }
      if (url.pathname.endsWith('/check-runs') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: 9001, name: body.name, head_sha: body.head_sha,
          external_id: body.external_id, status: body.status, app: { id: 15368 }, output: body.output }), { status: 201 });
      }
      if (url.pathname.endsWith('/check-runs/8000') && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...previousWaiver, status: body.status, conclusion: body.conclusion,
          output: body.output }), { status: 200 });
      }
      throw new Error(`Unexpected test request ${init.method ?? 'GET'} ${url.pathname}`);
    });
    const api = createGithubCheckApi({ token: 'test-only', repository: identity.repository, fetchImpl });
    const started = await startRequiredReviewCheck({ api, identity, mode: 'review', runId: '123456', runAttempt: '4' });
    expect(started.retiredCheckRunIds).toEqual([8000]);
    const listingUrls = urls.filter(url => url.pathname.endsWith(`/commits/${headSha}/check-runs`));
    expect(listingUrls.map(url => [url.searchParams.get('filter'), url.searchParams.get('per_page'), url.searchParams.get('page')]))
      .toEqual([['all', '100', '1'], ['all', '100', '2']]);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('filter=all'), expect.anything());
  });

  it.each([
    { name: 'changing total', pages: [{ total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) }, { total_count: 102, check_runs: [{ id: 101 }, { id: 102 }] }] },
    { name: 'duplicate IDs', pages: [{ total_count: 2, check_runs: [{ id: 1 }] }, { total_count: 2, check_runs: [{ id: 1 }] }] },
    { name: 'over-limit result', pages: [{ total_count: 1001, check_runs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) }] },
  ])('rejects incomplete exact-head pagination with $name', async ({ pages }) => {
    const createGithubCheckApi = controllerFunction<(input: AnyObject) => AnyObject>('createGithubCheckApi');
    const fetchImpl = vi.fn(async () => {
      const value = pages.shift();
      if (!value) throw new Error('unexpected extra page');
      return new Response(JSON.stringify(value), { status: 200 });
    });
    const api = createGithubCheckApi({ token: 'test-only', repository: identity.repository, fetchImpl });
    await expect(api.getCheckRunsForHead(headSha)).rejects.toThrow();
  });
});
