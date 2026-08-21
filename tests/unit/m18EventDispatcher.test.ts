import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { PRCloseDispatcher } from '../../src/github/prCloseDispatcher';

describe('Milestone 18: Event Handler & PR Close Dispatcher', () => {
  let eventHandler: GitHubEventHandler;

  beforeEach(() => {
    eventHandler = new GitHubEventHandler();
  });

  describe('GitHubEventHandler PR Close Triggers', () => {
    it('triggers pr_close_event when pull_request.closed and merged is true', () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 101,
          state: 'closed',
          merged: true,
          merged_at: '2026-07-25T12:00:00Z',
          title: 'feat: add new API endpoint CT-201',
          head: { sha: 'head-sha-123' },
          base: { sha: 'base-sha-456', ref: 'main' },
        },
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
        installation: { id: 999 },
      };

      const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-123');
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload?.triggerSource).toBe('pr_close_event');
      expect(result.parsedPayload?.isMerged).toBe(true);
      expect(result.parsedPayload?.targetBranch).toBe('main');
    });

    it('ignores pull_request.closed when merged is false', () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 102,
          state: 'closed',
          merged: false,
          head: { sha: 'head-sha-123' },
          base: { sha: 'base-sha-456' },
        },
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      };

      const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-124');
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toContain('closed without being merged');
    });
  });

  describe('GitHubInstallationClient Extended REST Methods', () => {
    it('supports getBranchRef, createBranch, createOrUpdateFile, createPullRequest', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        if (url.includes('/git/ref/heads/main')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ object: { sha: 'main-base-sha-789' } }),
          };
        }
        if (url.includes('/git/refs')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ ref: 'refs/heads/new-branch', object: { sha: 'main-base-sha-789' } }),
          };
        }
        if (url.includes('/contents/')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ content: { sha: 'new-file-sha-456' } }),
          };
        }
        if (url.includes('/pulls')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ number: 505, html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/505' }),
          };
        }
        return { ok: true, text: async () => '{}' };
      });

      vi.stubGlobal('fetch', mockFetch);

      const client = new GitHubInstallationClient({ token: 'ghs_test1234567890' });

      const sha = await client.getBranchRef('calltelemetry', 'ct-review-bot', 'main');
      expect(sha).toBe('main-base-sha-789');

      await expect(client.createBranch('calltelemetry', 'ct-review-bot', 'feature-branch', 'sha-123')).resolves.not.toThrow();

      const fileRes = await client.createOrUpdateFile({
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        path: 'docs/test.md',
        message: 'add test doc',
        content: '# Test Doc',
        branch: 'feature-branch',
      });
      expect(fileRes.sha).toBe('new-file-sha-456');

      const prRes = await client.createPullRequest({
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        title: 'docs: test pr',
        body: 'test body',
        head: 'feature-branch',
        base: 'main',
      });
      expect(prRes.number).toBe(505);

      vi.unstubAllGlobals();
    });
  });

  describe('PRCloseDispatcher Policy Evaluation', () => {
    it('returns status skipped when repository config has no on_pr_close rules', async () => {
      const mockClient: any = {
        getFileContent: vi.fn().mockResolvedValue(null),
      };

      const dispatcher = new PRCloseDispatcher();
      const payload: any = {
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        prNumber: 42,
        baseSha: 'base-123',
        title: 'sample pr',
      };

      const result = await dispatcher.dispatchPRCloseActions(payload, mockClient);
      expect(result.status).toBe('skipped');
      expect(result.actionsExecuted).toEqual([]);
    });

    it('executes configured personas when on_pr_close rules present in config', async () => {
      const configYaml = `
version: 3
profile: "balanced"
quorum: 1
personas:
  - id: "sec-lane"
    enabled: true
    required: true
    charter: "builtin:correctness"
    paths: ["**"]
    providers: ["codex"]
reviewers:
  execution: "personas"
  fallback: "ordered"
  overall_timeout_s: 60
  providers:
    - id: "codex"
      enabled: true
      model: "codex/gpt-5.6-sol-high"
      effort: "max"
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: ["codex"]

on_pr_close:
  create_followup_prs: ["docs", "marketing"]
  sync_linear_status: "Done"
  sync_productlane: false
`;
      const mockClient: any = {
        getFileContent: vi.fn().mockResolvedValue(configYaml),
        getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts' }]),
        getBranchRef: vi.fn().mockResolvedValue('main-sha'),
        createBranch: vi.fn().mockResolvedValue(undefined),
        createOrUpdateFile: vi.fn().mockResolvedValue({ sha: 'doc-file-sha' }),
        createPullRequest: vi.fn().mockResolvedValue({ number: 99, html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/99' }),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      };

      const dispatcher = new PRCloseDispatcher();
      const payload: any = {
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        prNumber: 42,
        baseSha: 'base-123',
        title: 'feat: add authentication CT-101',
        body: 'Closes CT-101',
        targetBranch: 'main',
      };

      const result = await dispatcher.dispatchPRCloseActions(payload, mockClient);
      expect(result.status).toBe('processed');
      expect(result.actionsExecuted).toContain('create_followup_prs:docs');
      expect(result.actionsExecuted).toContain('create_followup_prs:marketing');
      expect(result.actionsExecuted).toContain('sync_linear_status');
      expect(result.followupPRsCreated).toHaveLength(2);
    });
  });
});
