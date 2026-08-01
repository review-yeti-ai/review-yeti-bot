import { describe, it, expect, vi } from 'vitest';
import { GitHubEventHandler, ParsedPRPayload } from '../../src/github/eventHandler';
import { PRCloseDispatcher } from '../../src/github/prCloseDispatcher';
import { executeDocsPersona } from '../../src/personas/docsPersona';
import { executeMarketingPersona } from '../../src/personas/marketingPersona';
import { executeLinearSyncPersona, extractLinearIssueIds } from '../../src/personas/linearSyncPersona';
import { ProductlaneMCPAdapter } from '../../src/mcp/productlaneAdapter';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { DopplerSecretManager } from '../../src/mcp/dopplerSecretManager';

describe('Milestone 22 Empirical Challenger Stress Suite', () => {
  const handler = new GitHubEventHandler();

  describe('1. Webhook PR Close Handling Edge Cases', () => {
    it('handles pull_request.closed with empty/undefined pull_request object', () => {
      const payload: any = {
        action: 'closed',
        pull_request: undefined,
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      };
      const result = handler.evaluateTrigger('pull_request', payload, 'deliv-empty-pr');
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toContain('PR is closed without being merged');
    });

    it('evaluates merged property with strict boolean check', () => {
      const payload: any = {
        action: 'closed',
        pull_request: {
          number: 10,
          merged: 'true' as any, // non-boolean truthy string
        },
      };
      const result = handler.evaluateTrigger('pull_request', payload, 'deliv-str-merged');
      expect(result.shouldTrigger).toBe(false); // evaluates pr.merged === true strictly
    });

    it('demonstrates bot sender login case sensitivity behavior', () => {
      const payloadNullSender: any = {
        action: 'closed',
        pull_request: { number: 11, merged: true },
        sender: null,
        repository: { owner: { login: 'owner' }, name: 'repo' },
      };
      const resNull = handler.evaluateTrigger('pull_request', payloadNullSender, 'd-null-sender');
      expect(resNull.shouldTrigger).toBe(true);
      expect(resNull.parsedPayload?.sender).toBe('');

      // Standard bot login (lowercase [bot]) is ignored
      const payloadBotLower: any = {
        action: 'closed',
        pull_request: { number: 12, merged: true },
        sender: { login: 'dependabot[bot]' },
        repository: { owner: { login: 'owner' }, name: 'repo' },
      };
      const resBotLower = handler.evaluateTrigger('pull_request', payloadBotLower, 'd-bot-lower');
      expect(resBotLower.shouldTrigger).toBe(false);
      expect(resBotLower.reason).toContain('Ignored bot action');

      // FINDING: Uppercase [BOT] bypasses case-sensitive endsWith('[bot]') check
      const payloadBotUpper: any = {
        action: 'closed',
        pull_request: { number: 13, merged: true },
        sender: { login: 'SOME-OTHER-BOT[BOT]' },
        repository: { owner: { login: 'owner' }, name: 'repo' },
      };
      const resBotUpper = handler.evaluateTrigger('pull_request', payloadBotUpper, 'd-bot-upper');
      expect(resBotUpper.shouldTrigger).toBe(true); // Demonstrates case-sensitivity finding
    });

    it('demonstrates unhandled TypeError when labels array contains null elements', () => {
      const payloadMalformed: any = {
        action: 'closed',
        pull_request: {
          number: 15,
          merged: true,
          labels: ['valid-label', null],
        },
        repository: { owner: { login: 'owner' }, name: 'repo' },
      };

      // FINDING: labels() helper throws TypeError on null element in labels array
      expect(() => handler.evaluateTrigger('pull_request', payloadMalformed, 'd-malformed')).toThrow(TypeError);
    });
  });

  describe('2. on_pr_close Policy Rules Robustness', () => {
    const dispatcher = new PRCloseDispatcher();

    it('handles undefined or null on_pr_close policy gracefully', async () => {
      const payload: ParsedPRPayload = {
        installationId: '1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 100,
        headSha: 'head',
        baseSha: 'base',
        title: 'title',
        body: 'body',
        sender: 'user',
        labels: [],
        triggerSource: 'pr_close_event',
        triggerAction: 'closed',
        deliveryId: 'd100',
        isMerged: true,
      };

      const mockGithub: any = {
        getFileContent: async () => JSON.stringify({ ...createDefaultV3Config(), on_pr_close: undefined }),
      };

      const res = await dispatcher.dispatchPRCloseActions(payload, mockGithub);
      expect(res.status).toBe('skipped');
      expect(res.actionsExecuted).toEqual([]);
    });

    it('demonstrates unhandled ConfigValidationError when create_followup_prs is malformed', async () => {
      const payload: ParsedPRPayload = {
        installationId: '1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 101,
        headSha: 'head',
        baseSha: 'base',
        title: 'title',
        body: 'body',
        sender: 'user',
        labels: [],
        triggerSource: 'pr_close_event',
        triggerAction: 'closed',
        deliveryId: 'd101',
        isMerged: true,
      };

      const mockGithub: any = {
        getFileContent: async () =>
          JSON.stringify({
            ...createDefaultV3Config(),
            on_pr_close: { create_followup_prs: 'invalid-string-not-array' as any },
          }),
      };

      // FINDING: loadConfig schema validation failure throws ConfigValidationError through dispatchPRCloseActions
      await expect(dispatcher.dispatchPRCloseActions(payload, mockGithub)).rejects.toThrow('Config validation failed');
    });

    it('handles unknown persona types in create_followup_prs without crashing', async () => {
      const payload: ParsedPRPayload = {
        installationId: '1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 102,
        headSha: 'head',
        baseSha: 'base',
        title: 'title',
        body: 'body',
        sender: 'user',
        labels: [],
        triggerSource: 'pr_close_event',
        triggerAction: 'closed',
        deliveryId: 'd102',
        isMerged: true,
      };

      const mockGithub: any = {
        getFileContent: async () =>
          JSON.stringify({
            ...createDefaultV3Config(),
            on_pr_close: { create_followup_prs: ['unknown_persona', 'docs'] as any },
          }),
        getBranchRef: async () => 'base-sha',
        createBranch: async () => {},
        createOrUpdateFile: async () => ({ sha: 'sha' }),
        createPullRequest: async () => ({ number: 999, html_url: 'http://example.com' }),
        postIssueComment: async () => {},
      };

      const res = await dispatcher.dispatchPRCloseActions(payload, mockGithub);
      expect(res.status).toBe('processed');
      expect(res.actionsExecuted).toContain('create_followup_prs:docs');
      expect(res.actionsExecuted).not.toContain('create_followup_prs:unknown_persona');
    });
  });

  describe('3. Follow-up PR Persona Generation Edge Cases', () => {
    const defaultPayload: ParsedPRPayload = {
      installationId: '1',
      owner: 'testowner',
      repo: 'testrepo',
      prNumber: 200,
      headSha: 'head-sha',
      baseSha: 'base-sha',
      title: 'feat: add <script>alert(1)</script> support & Emojis 🚀',
      body: 'Body with "quotes" and \n newlines',
      sender: 'user',
      labels: [],
      triggerSource: 'pr_close_event',
      triggerAction: 'closed',
      deliveryId: 'd200',
      isMerged: true,
    };

    it('handles docs-persona when changedFiles is empty and getChangedFiles fails', async () => {
      const payload: ParsedPRPayload = { ...defaultPayload, changedFiles: [] };
      const mockGithub: any = {
        getChangedFiles: vi.fn().mockRejectedValue(new Error('GitHub API 500 Internal Error')),
        getBranchRef: vi.fn().mockResolvedValue('main-sha'),
        createBranch: vi.fn().mockResolvedValue(undefined),
        createOrUpdateFile: vi.fn().mockResolvedValue({ sha: 'sha1' }),
        createPullRequest: vi.fn().mockResolvedValue({ number: 300, html_url: 'http://github.com/pr/300' }),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      };

      const res = await executeDocsPersona({
        payload,
        config: createDefaultV3Config(),
        github: mockGithub,
      });

      expect(res.created).toBe(true);
      expect(res.prNumber).toBe(300);
      expect(mockGithub.createOrUpdateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('- Repository files modified in PR #200'),
        })
      );
    });

    it('handles docs-persona when branch already exists (createBranch throws)', async () => {
      const mockGithub: any = {
        getBranchRef: vi.fn().mockResolvedValue('main-sha'),
        createBranch: vi.fn().mockRejectedValue(new Error('Reference already exists')),
        createOrUpdateFile: vi.fn().mockResolvedValue({ sha: 'sha1' }),
        createPullRequest: vi.fn().mockResolvedValue({ number: 301, html_url: 'http://github.com/pr/301' }),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      };

      const res = await executeDocsPersona({
        payload: defaultPayload,
        config: createDefaultV3Config(),
        github: mockGithub,
      });

      expect(res.created).toBe(true);
      expect(res.prNumber).toBe(301);
    });

    it('handles marketing-persona OmniRoute failure gracefully', async () => {
      const mockOmniRouteFail: any = {
        complete: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
      };

      const mockGithub: any = {
        getBranchRef: vi.fn().mockResolvedValue('main-sha'),
        createBranch: vi.fn().mockResolvedValue(undefined),
        createOrUpdateFile: vi.fn().mockResolvedValue({ sha: 'sha1' }),
        createPullRequest: vi.fn().mockResolvedValue({ number: 302, html_url: 'http://github.com/pr/302' }),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      };

      const res = await executeMarketingPersona({
        payload: defaultPayload,
        config: createDefaultV3Config(),
        github: mockGithub,
        omniRoute: mockOmniRouteFail,
      });

      expect(res.created).toBe(true);
      expect(res.prNumber).toBe(302);
      expect(mockGithub.createOrUpdateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('We are excited to announce new updates'),
        })
      );
    });

    it('handles postIssueComment failure on original PR without breaking persona result', async () => {
      const mockGithubCommentFail: any = {
        getBranchRef: vi.fn().mockResolvedValue('main-sha'),
        createBranch: vi.fn().mockResolvedValue(undefined),
        createOrUpdateFile: vi.fn().mockResolvedValue({ sha: 'sha1' }),
        createPullRequest: vi.fn().mockResolvedValue({ number: 303, html_url: 'http://github.com/pr/303' }),
        postIssueComment: vi.fn().mockRejectedValue(new Error('Comment forbidden 403')),
      };

      const res = await executeMarketingPersona({
        payload: defaultPayload,
        config: createDefaultV3Config(),
        github: mockGithubCommentFail,
      });

      expect(res.created).toBe(true);
      expect(res.prNumber).toBe(303);
    });
  });

  describe('4. Linear Issue Extraction & Productlane Sync Edge Cases', () => {
    it('extracts Linear issue IDs and demonstrates case sensitivity behavior', () => {
      expect(extractLinearIssueIds('')).toEqual([]);
      expect(extractLinearIssueIds('No issue IDs here')).toEqual([]);

      const sampleText = 'Fixes ENG-123, CT-456, and FOOBAR-9999. Lowercase eng-789 is ignored.';
      const extracted = extractLinearIssueIds(sampleText);
      expect(extracted).toContain('ENG-123');
      expect(extracted).toContain('CT-456');
      expect(extracted).toContain('FOOBAR-9999');
      // FINDING: Lowercase issue key is not matched by current regex /\b([A-Z]{2,10}-\d+)\b/g
      expect(extracted).not.toContain('ENG-789');
    });

    it('deduplicates issue IDs in upper-case', () => {
      const sampleText = 'ENG-100 ENG-100';
      expect(extractLinearIssueIds(sampleText)).toEqual(['ENG-100']);
    });

    it('handles executeLinearSyncPersona when Doppler has no LINEAR_API_KEY', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue(null),
      };

      const payload: ParsedPRPayload = {
        installationId: '1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 400,
        headSha: 'head',
        baseSha: 'base',
        title: 'fix: resolve issue [PROJ-88]',
        body: 'Closes PROJ-88',
        sender: 'user',
        labels: [],
        triggerSource: 'pr_close_event',
        triggerAction: 'closed',
        deliveryId: 'd400',
      };

      const res = await executeLinearSyncPersona({
        payload,
        config: createDefaultV3Config(),
        targetStatus: 'Completed',
        syncProductlane: false,
        dopplerManager: mockDoppler,
      });

      expect(res.linear.issuesUpdated).toEqual(['PROJ-88']);
      expect(res.linear.targetStatus).toBe('Completed');
    });

    it('handles ProductlaneMCPAdapter with missing secret', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue(null),
      };

      const adapter = new ProductlaneMCPAdapter({ dopplerManager: mockDoppler });
      const syncRes = await adapter.syncChangelog(500, 'Test Title', 'Test Content');
      expect(syncRes.success).toBe(false);

      const healthRes = await adapter.healthCheck();
      expect(healthRes.ok).toBe(false);
      expect(healthRes.message).toContain('PRODUCTLANE_API_KEY unresolvable');
    });

    it('handles ProductlaneMCPAdapter HTTP network error or non-200 status', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue('mock-pl-key'),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any);

      try {
        const adapter = new ProductlaneMCPAdapter({ dopplerManager: mockDoppler });
        const syncRes = await adapter.syncChangelog(501, 'Test Title', 'Test Content');
        expect(syncRes.success).toBe(false);

        const healthRes = await adapter.healthCheck();
        expect(healthRes.ok).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles ProductlaneMCPAdapter fetch network rejection', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue('mock-pl-key'),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND api.productlane.com'));

      try {
        const adapter = new ProductlaneMCPAdapter({ dopplerManager: mockDoppler });
        const syncRes = await adapter.syncChangelog(502, 'Test Title', 'Test Content');
        expect(syncRes.success).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('5. PRCloseDispatcher Partial and Total Failure Handling', () => {
    const dispatcher = new PRCloseDispatcher();

    it('handles partial persona failure (docs fails, marketing succeeds)', async () => {
      const payload: ParsedPRPayload = {
        installationId: '1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 600,
        headSha: 'head',
        baseSha: 'base',
        title: 'title',
        body: 'body',
        sender: 'user',
        labels: [],
        triggerSource: 'pr_close_event',
        triggerAction: 'closed',
        deliveryId: 'd600',
        isMerged: true,
      };

      let createPRCount = 0;
      const mockGithub: any = {
        getFileContent: async () =>
          JSON.stringify({
            ...createDefaultV3Config(),
            on_pr_close: { create_followup_prs: ['docs', 'marketing'] },
          }),
        getBranchRef: async () => 'base-sha',
        createBranch: async () => {},
        createOrUpdateFile: async () => ({ sha: 'sha' }),
        createPullRequest: async () => {
          createPRCount++;
          if (createPRCount === 1) {
            throw new Error('docs PR creation failed due to permissions');
          }
          return { number: 702, html_url: 'http://example.com/702' };
        },
        postIssueComment: async () => {},
      };

      const res = await dispatcher.dispatchPRCloseActions(payload, mockGithub);
      expect(res.status).toBe('processed');
      expect(res.actionsExecuted).toContain('create_followup_prs:marketing');
      expect(res.errors?.length).toBe(1);
      expect(res.errors?.[0]).toContain('Failed executing follow-up persona docs');
    });

    it('returns status: failed when all actions in policy throw errors', async () => {
      const payload: ParsedPRPayload = {
        installationId: '1',
        owner: 'owner',
        repo: 'repo',
        prNumber: 601,
        headSha: 'head',
        baseSha: 'base',
        title: 'title',
        body: 'body',
        sender: 'user',
        labels: [],
        triggerSource: 'pr_close_event',
        triggerAction: 'closed',
        deliveryId: 'd601',
        isMerged: true,
      };

      const mockGithub: any = {
        getFileContent: async () =>
          JSON.stringify({
            ...createDefaultV3Config(),
            on_pr_close: { create_followup_prs: ['docs'] },
          }),
        getBranchRef: async () => {
          throw new Error('GitHub API rate limit exceeded');
        },
      };

      const res = await dispatcher.dispatchPRCloseActions(payload, mockGithub);
      expect(res.status).toBe('failed');
      expect(res.actionsExecuted.length).toBe(0);
      expect(res.errors?.length).toBe(1);
      expect(res.errors?.[0]).toContain('Failed executing follow-up persona docs');
    });
  });
});
