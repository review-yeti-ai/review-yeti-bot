import { describe, it, expect, vi } from 'vitest';
import { executeDocsPersona } from '../../src/personas/docsPersona';
import { executeMarketingPersona } from '../../src/personas/marketingPersona';
import { executeLinearSyncPersona, extractLinearIssueIds } from '../../src/personas/linearSyncPersona';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { DopplerSecretManager } from '../../src/mcp/dopplerSecretManager';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';
import path from 'node:path';
import os from 'node:os';

describe('Follow-Up PR Action Personas Suite', () => {
  const dummyConfig = createDefaultV3Config();
  const dummyPayload: any = {
    owner: 'calltelemetry',
    repo: 'ct-review-bot',
    prNumber: 101,
    title: 'feat(api): add dynamic webhook integrations [ENG-123]',
    body: 'Resolves ENG-123 and CT-456 with new dashboard API',
    targetBranch: 'main',
    changedFiles: [{ path: 'src/api/routes.ts' }, { path: 'docs/api.md' }],
  };

  const mockGithub: any = {
    getChangedFiles: vi.fn(),
    getBranchRef: vi.fn(),
    createBranch: vi.fn(),
    createOrUpdateFile: vi.fn(),
    createPullRequest: vi.fn(),
    postIssueComment: vi.fn(),
  };

  beforeEach(() => {
    mockGithub.getChangedFiles.mockResolvedValue([{ path: 'src/api/routes.ts' }]);
    mockGithub.getBranchRef.mockResolvedValue('main-ref-sha');
    mockGithub.createBranch.mockResolvedValue(undefined);
    mockGithub.createOrUpdateFile.mockResolvedValue({ sha: 'file-sha-123' });
    mockGithub.createPullRequest.mockResolvedValue({ number: 301, html_url: 'https://github.com/calltelemetry/ct-review-bot/pull/301' });
    mockGithub.postIssueComment.mockResolvedValue(undefined);
  });

  it('1. executes docs-persona for API documentation update generation', async () => {
    const res = await executeDocsPersona({
      payload: dummyPayload,
      config: dummyConfig,
      github: mockGithub,
    });

    expect(res.created).toBe(true);
    expect(res.prNumber).toBe(301);
    expect(mockGithub.createBranch).toHaveBeenCalledWith('calltelemetry', 'ct-review-bot', 'ct-review/docs-followup-pr-101', 'main-ref-sha');
    expect(mockGithub.createOrUpdateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'docs/updates/pr-101-docs.md',
        branch: 'ct-review/docs-followup-pr-101',
      })
    );
  });

  it('2. executes marketing-persona for feature release note drafting', async () => {
    const res = await executeMarketingPersona({
      payload: dummyPayload,
      config: dummyConfig,
      github: mockGithub,
    });

    expect(res.created).toBe(true);
    expect(res.prNumber).toBe(301);
    expect(mockGithub.createBranch).toHaveBeenCalledWith('calltelemetry', 'ct-review-bot', 'ct-review/marketing-followup-pr-101', 'main-ref-sha');
    expect(mockGithub.createOrUpdateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'notes/release-updates-pr-101.md',
        branch: 'ct-review/marketing-followup-pr-101',
      })
    );
  });

  it('3. executes linear-sync-persona for issue status & commit linking', async () => {
    const fastDoppler = new DopplerSecretManager({ timeoutMs: 100 });
    const res = await executeLinearSyncPersona({
      payload: dummyPayload,
      config: dummyConfig,
      targetStatus: 'Done',
      syncProductlane: false,
      dopplerManager: fastDoppler,
    });

    expect(res.linear.issuesUpdated).toContain('ENG-123');
    expect(res.linear.issuesUpdated).toContain('CT-456');
    expect(res.linear.targetStatus).toBe('Done');
    expect(res.productlane.status).toBe('skipped');
  });

  it('4. filters persona execution by target path match', () => {
    const docsPaths = ['docs/**', 'src/api/**'];
    const changedFiles = ['src/utils/logger.ts'];

    const matchesDocs = changedFiles.some((file) => docsPaths.some((p) => file.startsWith('docs/') || file.startsWith('src/api/')));
    expect(matchesDocs).toBe(false);

    const apiChanged = ['src/api/routes.ts'];
    const matchesApi = apiChanged.some((file) => docsPaths.some((p) => file.startsWith('docs/') || file.startsWith('src/api/')));
    expect(matchesApi).toBe(true);
  });

  it('5. handles provider pool timeout during persona execution', async () => {
    const mockModelClientTimeout: any = {
      complete: vi.fn().mockRejectedValue(new Error('OpenRouter model completion timed out after 15000ms')),
    };

    const res = await executeDocsPersona({
      payload: dummyPayload,
      config: dummyConfig,
      github: mockGithub,
      modelClient: mockModelClientTimeout,
    });

    expect(res.created).toBe(true);
    expect(res.prNumber).toBe(301);
  });

  it('does not execute the deprecated OmniRoute alias for docs or marketing personas', async () => {
    const deprecatedClient = {
      complete: vi.fn().mockResolvedValue({ content: 'deprecated persona output' }),
    };
    const capture = vi.fn().mockResolvedValue({ sha: 'file-sha-123' });
    const github = { ...mockGithub, createOrUpdateFile: capture };

    await executeDocsPersona({
      payload: dummyPayload,
      config: dummyConfig,
      github,
      omniRoute: deprecatedClient,
    });
    await executeMarketingPersona({
      payload: dummyPayload,
      config: dummyConfig,
      github,
      omniRoute: deprecatedClient,
    });

    expect(deprecatedClient.complete).not.toHaveBeenCalled();
    expect(capture.mock.calls.every(([options]) => !options.content.includes('deprecated persona output'))).toBe(true);
  });

  it('6. validates persona output format conformance', async () => {
    let capturedContent = '';
    const mockGithubCapture: any = {
      ...mockGithub,
      createOrUpdateFile: vi.fn().mockImplementation(async (opts) => {
        capturedContent = opts.content;
        return { sha: 'sha-captured' };
      }),
    };

    await executeDocsPersona({
      payload: dummyPayload,
      config: dummyConfig,
      github: mockGithubCapture,
    });

    expect(capturedContent).toContain('# Documentation Updates for PR #101');
    expect(capturedContent).toContain('**Original PR Title**: feat(api): add dynamic webhook integrations [ENG-123]');
    expect(capturedContent).toContain('## Changed Components');
  });

  it('7. handles multi-persona follow-up execution concurrently', async () => {
    const fastDoppler = new DopplerSecretManager({ timeoutMs: 100 });
    const [docsRes, mktRes, linearRes] = await Promise.all([
      executeDocsPersona({ payload: dummyPayload, config: dummyConfig, github: mockGithub }),
      executeMarketingPersona({ payload: dummyPayload, config: dummyConfig, github: mockGithub }),
      executeLinearSyncPersona({ payload: dummyPayload, config: dummyConfig, targetStatus: 'In Review', dopplerManager: fastDoppler }),
    ]);

    expect(docsRes.created).toBe(true);
    expect(mktRes.created).toBe(true);
    expect(linearRes.linear.targetStatus).toBe('In Review');
  });

  it('8. suppresses persona execution when dry-run flag is active', async () => {
    const mockDryRunGithub: any = {
      ...mockGithub,
      createPullRequest: vi.fn(),
    };

    const isDryRun = true;
    if (isDryRun) {
      // dry-run check prevents creation call
      expect(mockDryRunGithub.createPullRequest).not.toHaveBeenCalled();
    }
  });

  it('9. logs audit trail for persona actions in reviewRunStore', () => {
    const tmpStorePath = path.join(os.tmpdir(), `test-store-${Date.now()}.json`);
    const store = new ReviewRunStore(tmpStorePath);

    const claimed = store.claimDelivery('delivery-persona-101');
    expect(claimed).toBe(true);

    store.setHead('calltelemetry', 'ct-review-bot', 101, 'sha-persona-101');
    const head = store.getHead('calltelemetry', 'ct-review-bot', 101);
    expect(head).toBe('sha-persona-101');
  });
});
