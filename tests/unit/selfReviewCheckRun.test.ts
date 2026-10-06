import fs from 'node:fs';
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
    head: { sha: headSha, repo: { id: 1326169548 } },
    base: { ref: 'main', sha: baseSha, repo: { id: 1326169548, full_name: identity.repository, default_branch: 'main' } },
    ...overrides,
  };
}

function fakeApi(overrides: {
  current?: AnyObject;
  created?: AnyObject;
  updated?: AnyObject;
} = {}) {
  const createCheckRun = vi.fn(async (body: AnyObject) => ({
    id: 9001,
    name: 'Execute AI Review Pipeline',
    head_sha: identity.headSha,
    status: 'in_progress',
    app: { id: 15368 },
    body,
    ...overrides.created,
  }));
  const updateCheckRun = vi.fn(async (_id: number, body: AnyObject) => ({
    id: 9001,
    name: 'Execute AI Review Pipeline',
    head_sha: identity.headSha,
    status: 'completed',
    conclusion: body.conclusion,
    app: { id: 15368 },
    body,
    ...overrides.updated,
  }));
  return {
    getCurrentPullRequest: vi.fn(async () => overrides.current ?? currentPullRequest()),
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
    expect(resolveControllerMode('repository_dispatch', 'true')).toBe('review');
    expect(() => resolveControllerMode('pull_request_target', 'TRUE')).toThrow(/must be exactly/i);
    expect(() => resolveControllerMode('pull_request_target', 'yes')).toThrow(/must be exactly/i);
  });

  it('rejects a current PR read whose repository, open state, head, base, or number differs from the event', () => {
    const assertCurrentPullRequest = controllerFunction<(expected: AnyObject, current: AnyObject) => void>('assertCurrentPullRequest');
    expect(() => assertCurrentPullRequest(identity, currentPullRequest())).not.toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ number: 43 }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ state: 'closed' }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ head: { sha: 'c'.repeat(40), repo: { id: 1326169548 } } }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ base: { sha: 'd'.repeat(40), repo: { id: 1326169548 } } }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ base: { sha: baseSha, repo: { id: 7 } } }))).toThrow();
    expect(() => assertCurrentPullRequest(identity, currentPullRequest({ base: { ...currentPullRequest().base, ref: 'release' } }))).toThrow();
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
    const result = await finishRequiredReviewCheck({ api, started, actionOutcome: 'skipped', enforceOutcome: 'skipped' });
    expect(result).toMatchObject({ conclusion: 'cancelled', reviewCompleted: false, operatorWaiver: false });
    expect(api.updateCheckRun).toHaveBeenCalledWith(9001, expect.objectContaining({
      status: 'completed', conclusion: 'cancelled',
    }));
  });

  it('finishes an exact current check with the derived outcome and truthful summary', async () => {
    const startRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('startRequiredReviewCheck');
    const finishRequiredReviewCheck = controllerFunction<(input: AnyObject) => Promise<AnyObject>>('finishRequiredReviewCheck');
    const api = fakeApi();
    const started = await startRequiredReviewCheck({ api, identity, mode: 'operator-waiver', runId: '123456', runAttempt: '1' });
    const result = await finishRequiredReviewCheck({
      api, started, actionOutcome: 'skipped', enforceOutcome: 'skipped',
      now: () => new Date('2026-10-06T01:01:00.000Z'),
    });
    expect(api.updateCheckRun).toHaveBeenCalledWith(9001, expect.objectContaining({
      status: 'completed', conclusion: 'success', completed_at: '2026-10-06T01:01:00.000Z',
      output: expect.objectContaining({ title: expect.stringContaining('operator waiver'), summary: expect.stringContaining('reviewCompleted: false') }),
    }));
    expect(result).toMatchObject({ conclusion: 'success', verdict: 'SHIP', reviewCompleted: false, operatorWaiver: true });
  });
});
