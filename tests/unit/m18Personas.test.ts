import { describe, it, expect, vi } from 'vitest';
import { executeDocsPersona } from '../../src/personas/docsPersona';
import { executeMarketingPersona } from '../../src/personas/marketingPersona';
import { extractLinearIssueIds, executeLinearSyncPersona } from '../../src/personas/linearSyncPersona';
import { createDefaultV3Config } from '../../src/config/configLoader';

describe('Milestone 18: Follow-up PR Personas Engine', () => {
  const dummyConfig = createDefaultV3Config();
  const dummyPayload: any = {
    owner: 'calltelemetry',
    repo: 'ct-review-bot',
    prNumber: 77,
    title: 'feat(api): add new webhook endpoint CT-303',
    body: 'Resolves CT-303 and ENG-888',
    targetBranch: 'main',
    changedFiles: [{ path: 'src/app.ts' }, { path: 'src/config/schema.ts' }],
  };

  const mockGithub: any = {
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts' }]),
    getBranchRef: vi.fn().mockResolvedValue('main-ref-sha'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    createOrUpdateFile: vi.fn().mockResolvedValue({ sha: 'file-sha' }),
    createPullRequest: vi.fn().mockResolvedValue({ number: 108, html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/108' }),
    postIssueComment: vi.fn().mockResolvedValue(undefined),
  };

  describe('docsPersona', () => {
    it('generates follow-up documentation PR', async () => {
      const result = await executeDocsPersona({
        payload: dummyPayload,
        config: dummyConfig,
        github: mockGithub,
      });

      expect(result.created).toBe(true);
      expect(result.prNumber).toBe(108);
      expect(mockGithub.createBranch).toHaveBeenCalledWith('calltelemetry', 'ct-review-bot', 'ct-review/docs-followup-pr-77', 'main-ref-sha');
      expect(mockGithub.createOrUpdateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'docs/updates/pr-77-docs.md',
          branch: 'ct-review/docs-followup-pr-77',
        })
      );
      expect(mockGithub.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'docs: follow-up documentation for #77',
          base: 'main',
        })
      );
      expect(mockGithub.postIssueComment).toHaveBeenCalled();
    });
  });

  describe('marketingPersona', () => {
    it('generates marketing release notes follow-up PR', async () => {
      const result = await executeMarketingPersona({
        payload: dummyPayload,
        config: dummyConfig,
        github: mockGithub,
      });

      expect(result.created).toBe(true);
      expect(result.prNumber).toBe(108);
      expect(mockGithub.createBranch).toHaveBeenCalledWith('calltelemetry', 'ct-review-bot', 'ct-review/marketing-followup-pr-77', 'main-ref-sha');
      expect(mockGithub.createOrUpdateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'notes/release-updates-pr-77.md',
          branch: 'ct-review/marketing-followup-pr-77',
        })
      );
      expect(mockGithub.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'marketing: release notes follow-up for #77',
          base: 'main',
        })
      );
    });
  });

  describe('linearSyncPersona', () => {
    it('extracts Linear issue IDs accurately from title and body text', () => {
      const text = 'feat(auth): fix token refresh CT-303 and ENG-888 (fixes CT-303)';
      const issueIds = extractLinearIssueIds(text);
      expect(issueIds).toEqual(['CT-303', 'ENG-888']);
    });

    it('returns empty array when no Linear issue IDs present', () => {
      const text = 'refactor: clean up logging code without tickets';
      const issueIds = extractLinearIssueIds(text);
      expect(issueIds).toEqual([]);
    });

    it('executes linear and productlane sync persona without error', async () => {
      const syncResult = await executeLinearSyncPersona({
        payload: dummyPayload,
        config: dummyConfig,
        targetStatus: 'Done',
        syncProductlane: true,
      });

      expect(syncResult.linear.issuesUpdated).toEqual(['CT-303', 'ENG-888']);
      expect(syncResult.linear.targetStatus).toBe('Done');
      expect(syncResult.productlane.status).toBeDefined();
    });
  });
});
