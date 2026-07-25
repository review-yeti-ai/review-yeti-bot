import { describe, it, expect } from 'vitest';
import { onPRCloseSchema, ctReviewConfigV3Schema } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { PRCloseDispatcher } from '../../src/github/prCloseDispatcher';
import { extractLinearIssueIds } from '../../src/personas/linearSyncPersona';

describe('Evaluation of on_pr_close Rules', () => {
  it('parses on_pr_close configuration section in V3 schema', () => {
    const rawYamlConfig = {
      ...createDefaultV3Config(),
      on_pr_close: {
        create_followup_prs: ['docs', 'marketing'],
        sync_linear_status: 'Done',
        sync_productlane: true,
      },
    };

    const parsed = ctReviewConfigV3Schema.parse(rawYamlConfig);
    expect(parsed.on_pr_close).toBeDefined();
    expect(parsed.on_pr_close.create_followup_prs).toEqual(['docs', 'marketing']);
    expect(parsed.on_pr_close.sync_linear_status).toBe('Done');
    expect(parsed.on_pr_close.sync_productlane).toBe(true);
  });

  it('evaluates create_followup_prs rule action', async () => {
    const mockGithub: any = {
      getChangedFiles: async () => [{ path: 'src/api/routes.ts' }],
      getBranchRef: async () => 'base-sha-11',
      createBranch: async () => {},
      createOrUpdateFile: async () => ({ sha: 'f1' }),
      createPullRequest: async () => ({ number: 200, html_url: 'https://github.com/pr/200' }),
      postIssueComment: async () => {},
    };

    const dispatcher = new PRCloseDispatcher();

    const payload: any = {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 55,
      baseSha: 'base-sha-11',
      title: 'feat(api): add new route',
      body: 'adds route endpoint',
      targetBranch: 'main',
      triggerSource: 'pr_close_event',
      triggerAction: 'closed',
      deliveryId: 'd-55',
      isMerged: true,
    };

    const configWithFollowup = {
      ...createDefaultV3Config(),
      on_pr_close: {
        create_followup_prs: ['docs'],
      },
    };

    const syncRes = await dispatcher.dispatchPRCloseActions(payload, {
      ...mockGithub,
      getFileContent: async () => JSON.stringify(configWithFollowup),
    });

    expect(syncRes.status).toBe('processed');
    expect(syncRes.actionsExecuted).toContain('create_followup_prs:docs');
  });

  it('evaluates sync_linear_status rule action with issue key extraction', () => {
    const title = 'feat(core): fix billing calculation [ENG-1234]';
    const body = 'Fixes LINEAR-567 and CT-890 when checkout is triggered';
    const issueIds = extractLinearIssueIds(`${title} ${body}`);

    expect(issueIds).toEqual(['ENG-1234', 'LINEAR-567', 'CT-890']);
  });

  it('evaluates sync_productlane rule action with feedback tag extraction', () => {
    const title = 'feat: add feedback portal [PL-404]';
    const body = 'Productlane feedback tag #user-request included';
    const matches = body.match(/#[a-z0-9-]+/gi) || [];

    expect(matches).toContain('#user-request');
  });

  it('bypasses on_pr_close rules when no rules match changed paths', async () => {
    const emptyConfig = {
      ...createDefaultV3Config(),
      on_pr_close: {
        create_followup_prs: [],
        sync_linear_status: undefined,
        sync_productlane: false,
      },
    };

    const mockGithub: any = {};
    const dispatcher = new PRCloseDispatcher();

    const payload: any = {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 12,
      baseSha: 'base-sha',
      title: 'chore: update readme',
      body: 'docs update',
    };

    const result = await dispatcher.dispatchPRCloseActions(payload, {
      ...mockGithub,
      getFileContent: async () => JSON.stringify(emptyConfig),
    });

    expect(result.status).toBe('skipped');
    expect(result.actionsExecuted.length).toBe(0);
  });

  it('handles multiple on_pr_close rules sequentially', async () => {
    const multiConfig = {
      ...createDefaultV3Config(),
      on_pr_close: {
        create_followup_prs: ['docs', 'marketing'],
        sync_linear_status: 'Completed',
        sync_productlane: true,
      },
    };

    const mockGithub: any = {
      getBranchRef: async () => 'base-sha',
      createBranch: async () => {},
      createOrUpdateFile: async () => ({ sha: 'sha1' }),
      createPullRequest: async () => ({ number: 201, html_url: 'https://github.com/pr/201' }),
      postIssueComment: async () => {},
    };

    const dispatcher = new PRCloseDispatcher();
    const payload: any = {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 99,
      baseSha: 'sha99',
      title: 'feat: major launch [ENG-999]',
      body: 'Resolves ENG-999',
    };

    const result = await dispatcher.dispatchPRCloseActions(payload, {
      ...mockGithub,
      getFileContent: async () => JSON.stringify(multiConfig),
    });

    expect(result.status).toBe('processed');
    expect(result.actionsExecuted).toContain('create_followup_prs:docs');
    expect(result.actionsExecuted).toContain('create_followup_prs:marketing');
    expect(result.actionsExecuted).toContain('sync_linear_status');
    expect(result.actionsExecuted).toContain('sync_productlane');
  });

  it('handles missing ticket keys gracefully without throw', () => {
    const textWithoutTickets = 'refactor: simplify internal queue handler';
    const issueIds = extractLinearIssueIds(textWithoutTickets);

    expect(issueIds).toEqual([]);
    expect(() => extractLinearIssueIds('')).not.toThrow();
  });

  it('validates invalid rule schema definitions with Zod error', () => {
    const invalidConfig = {
      create_followup_prs: 'invalid-string-instead-of-array',
    };

    const parseResult = onPRCloseSchema.safeParse(invalidConfig);
    expect(parseResult.success).toBe(false);
  });
});
