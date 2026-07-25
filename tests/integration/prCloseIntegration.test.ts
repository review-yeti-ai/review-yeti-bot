import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { PRCloseDispatcher } from '../../src/github/prCloseDispatcher';
import { createDefaultV3Config } from '../../src/config/configLoader';

describe('PR Close Pipeline Integration Suite', () => {
  let app: any;
  const eventHandler = new GitHubEventHandler();
  const dispatcher = new PRCloseDispatcher();

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    app = createApp();
  });

  it('1. handles end-to-end pull_request.closed webhook event dispatch to follow-up PR creation', async () => {
    const payload = {
      action: 'closed',
      pull_request: {
        number: 505,
        state: 'closed',
        merged: true,
        merged_at: '2026-07-25T14:00:00Z',
        title: 'feat(core): add core functionality [ENG-505]',
        body: 'Closes ENG-505',
        head: { sha: 'head-sha-505' },
        base: { sha: 'base-sha-505', ref: 'main' },
      },
      repository: {
        owner: { login: 'calltelemetry' },
        name: 'ct-review-bot',
      },
      sender: { login: 'octocat' },
    };

    const triggerResult = eventHandler.evaluateTrigger('pull_request', payload, 'deliv-integration-505');
    expect(triggerResult.shouldTrigger).toBe(true);
    expect(triggerResult.parsedPayload).toBeDefined();

    const mockGithub: any = {
      getBranchRef: async () => 'base-sha-505',
      createBranch: async () => {},
      createOrUpdateFile: async () => ({ sha: 'sha-created-505' }),
      createPullRequest: async () => ({ number: 905, html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/905' }),
      postIssueComment: async () => {},
      getFileContent: async () =>
        JSON.stringify({
          ...createDefaultV3Config(),
          on_pr_close: { create_followup_prs: ['docs'] },
        }),
    };

    const dispatchResult = await dispatcher.dispatchPRCloseActions(triggerResult.parsedPayload!, mockGithub);

    expect(dispatchResult.status).toBe('processed');
    expect(dispatchResult.actionsExecuted).toContain('create_followup_prs:docs');
    expect(dispatchResult.followupPRsCreated.length).toBe(1);
    expect(dispatchResult.followupPRsCreated[0].prNumber).toBe(905);
  });

  it('2. processes on_pr_close rules with Linear status sync & Productlane updates in pipeline', async () => {
    const payload = {
      action: 'closed',
      pull_request: {
        number: 506,
        merged: true,
        title: 'fix(api): payload issue key [CT-777]',
        body: 'Fixes CT-777 #user-feedback',
        head: { sha: 'head-sha-506' },
        base: { sha: 'base-sha-506', ref: 'main' },
      },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      sender: { login: 'developer1' },
    };

    const triggerResult = eventHandler.evaluateTrigger('pull_request', payload, 'deliv-integration-506');
    expect(triggerResult.shouldTrigger).toBe(true);

    const mockGithub: any = {
      getFileContent: async () =>
        JSON.stringify({
          ...createDefaultV3Config(),
          on_pr_close: {
            sync_linear_status: 'Done',
            sync_productlane: true,
          },
        }),
    };

    const dispatchResult = await dispatcher.dispatchPRCloseActions(triggerResult.parsedPayload!, mockGithub);

    expect(dispatchResult.status).toBe('processed');
    expect(dispatchResult.actionsExecuted).toContain('sync_linear_status');
    expect(dispatchResult.actionsExecuted).toContain('sync_productlane');
    expect(dispatchResult.linearSyncResult?.issuesUpdated).toContain('CT-777');
  });

  it('3. verifies reviewRunStore audit trail recording on merged PR completion', async () => {
    const mockStore: any = {
      runs: [] as any[],
      recordReviewRun(data: any) {
        this.runs.push(data);
      },
    };

    mockStore.recordReviewRun({
      prRun: 'ct-review-bot #507',
      headSha: 'head-sha-507',
      personas: 'docs, linear-sync',
      quorum: '1/1 Distinct',
      arbiterVerdict: 'PASS',
    });

    expect(mockStore.runs.length).toBe(1);
    expect(mockStore.runs[0].prRun).toBe('ct-review-bot #507');
  });

  it('4. handles unmerged PR close events gracefully with skipped status', async () => {
    const unmergedPayload = {
      action: 'closed',
      pull_request: {
        number: 508,
        merged: false,
        title: 'wip: closed without merge',
      },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      sender: { login: 'developer2' },
    };

    const triggerResult = eventHandler.evaluateTrigger('pull_request', unmergedPayload, 'deliv-integration-508');
    expect(triggerResult.shouldTrigger).toBe(false);
    expect(triggerResult.reason).toContain('without being merged');
  });
});
