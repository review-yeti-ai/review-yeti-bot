import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDiffStateStorage, IDiffStateStorage } from '../../src/persistence/db';
import { DiffStateManager } from '../../src/persistence/diffStateManager';
import { parseConstitution } from '../../src/constitution/constitutionEngine';
import { OmniRouteAdapter, ProviderConfig } from '../../src/router/omniRouteAdapter';
import { executeQuorumFanOut } from '../../src/quorum/mefEngine';
import { aggregateQuorumConsensus } from '../../src/quorum/consensus';
import { CtReviewConfig } from '../../src/config/schema';

describe('Milestone 3 — Quorum Review Panel Engine Integration Suite', () => {
  let storage: IDiffStateStorage;
  let diffStateMgr: DiffStateManager;
  let mockRouter: OmniRouteAdapter;
  let testConfig: CtReviewConfig;

  beforeEach(async () => {
    storage = await createDiffStateStorage(':memory:');
    diffStateMgr = new DiffStateManager(storage);

    const dummyProvider: ProviderConfig = {
      id: 'mock-provider',
      providerType: 'openai',
      displayName: 'Mock LLM Provider',
      baseUrl: 'https://api.openai.com',
      billingTier: 'subscription_flat',
      defaultModel: 'gpt-4o',
      supportedModels: ['gpt-4o'],
      priority: 1,
      enabled: true,
    };

    mockRouter = new OmniRouteAdapter({
      providers: [dummyProvider],
      defaultProviderId: 'mock-provider',
    });

    testConfig = {
      version: '1.0',
      quorum: {
        minApprovals: 2,
        personas: ['security', 'architecture', 'performance', 'quality'],
        effortLevel: 'medium',
      },
      ticketEnforcement: {
        required: true,
        providers: ['linear', 'jira', 'github'],
        patterns: [],
      },
      constitution: {
        enabled: true,
        path: '.github/constitution.md',
      },
    };
  });

  afterEach(async () => {
    await storage.close();
  });

  it('runs full multi-commit PR review lifecycle: Commit 1 (Flawed) -> Commit 2 (Remediated)', async () => {
    const rawConstitutionMarkdown = `
# Engineering Constitution

## Forbidden Patterns
- Prohibit direct eval execution \`/eval\\(.*?/\`

## Directives
- PR description must contain testing steps
`;
    const parsedConstitution = parseConstitution(rawConstitutionMarkdown);

    // ==========================================
    // COMMIT 1: Flawed Commit
    // ==========================================
    const commit1HeadSha = 'sha1111111111111111111111111111111111111';
    const commit1BaseSha = 'sha0000000000000000000000000000000000000';

    const commit1Context = {
      repoOwner: 'acme-org',
      repoName: 'auth-service',
      prNumber: 101,
      headSha: commit1HeadSha,
      baseSha: commit1BaseSha,
      prTitle: 'feat: add raw auth parser', // Missing ticket linkage
      prBody: 'Initial draft for auth parsing.', // Missing testing steps
      diffFiles: [
        {
          filePath: 'src/auth/jwt.ts',
          patch: '@@ -0,0 +1,5 @@\n+export function parseToken(raw) {\n+  return eval(raw);\n+}',
        },
      ],
    };

    const commit1Hunks = [
      {
        filePath: 'src/auth/jwt.ts',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 5,
        hunkContent: '@@ -0,0 +1,5 @@\n+export function parseToken(raw) {\n+  return eval(raw);\n+}',
      },
    ];

    // Mock OmniRoute completion for Commit 1 (Security persona flags eval)
    vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
      if (req.persona === 'security') {
        return {
          content: JSON.stringify([
            {
              filePath: 'src/auth/jwt.ts',
              lineNumber: 2,
              severity: 'critical',
              comment: 'Avoid eval() execution with untrusted JWT tokens.',
              suggestion: 'return JSON.parse(raw);',
              ruleId: 'SEC-NO-EVAL',
              codeSnippet: 'return eval(raw);',
            },
          ]),
          providerUsed: 'openai',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 200, completion: 100, total: 300 },
        };
      }
      return {
        content: '[]',
        providerUsed: 'openai',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
      };
    });

    // 1. Fan-out LLM analysis for Commit 1
    const mefResult1 = await executeQuorumFanOut(commit1Context, {
      config: testConfig,
      router: mockRouter,
    });

    expect(mefResult1.allFindings).toHaveLength(1);
    expect(mefResult1.allFindings[0].severity).toBe('critical');

    // 2. Consensus Aggregation & Diff State Tracking for Commit 1
    const quorumResult1 = await aggregateQuorumConsensus(
      {
        repoOwner: commit1Context.repoOwner,
        repoName: commit1Context.repoName,
        prNumber: commit1Context.prNumber,
        headSha: commit1Context.headSha,
        baseSha: commit1Context.baseSha,
        config: testConfig,
        hunks: commit1Hunks,
        mefResult: mefResult1,
        prTitle: commit1Context.prTitle,
        prBody: commit1Context.prBody,
        changedFiles: commit1Context.diffFiles,
        constitution: parsedConstitution,
      },
      diffStateMgr
    );

    // Verify Commit 1 Assertions
    expect(quorumResult1.decision).toBe('REQUEST_CHANGES');
    expect(quorumResult1.ticketValidation.valid).toBe(false);
    expect(quorumResult1.ticketValidation.mode).toBe('strict');
    expect(quorumResult1.constitutionCompliance.compliant).toBe(false);
    expect(quorumResult1.constitutionCompliance.violations.length).toBeGreaterThanOrEqual(1);
    expect(quorumResult1.activeFindings).toHaveLength(1);
    expect(quorumResult1.activeFindings[0].ruleId).toBe('SEC-NO-EVAL');
    expect(quorumResult1.inlineComments).toHaveLength(1);
    expect(quorumResult1.formattedMarkdown).toContain('🔴 **CHANGES REQUESTED**');

    // Verify state in diffStateManager DB
    const state1 = await storage.getPRState('acme-org', 'auth-service', 101);
    expect(state1).not.toBeNull();
    expect(state1?.findings.filter((f) => f.status === 'IDENTIFIED')).toHaveLength(1);

    // ==========================================
    // COMMIT 2: Remediated Commit
    // ==========================================
    const commit2HeadSha = 'sha2222222222222222222222222222222222222';

    const commit2Context = {
      repoOwner: 'acme-org',
      repoName: 'auth-service',
      prNumber: 101,
      headSha: commit2HeadSha,
      baseSha: commit1BaseSha,
      prTitle: 'feat: add safe auth parser [PROJ-202]', // Ticket linkage added
      prBody: 'Implements safe JWT parsing. Testing steps: 1. run npm test.', // Testing steps added
      diffFiles: [
        {
          filePath: 'src/auth/jwt.ts',
          patch: '@@ -0,0 +1,5 @@\n+export function parseToken(raw) {\n+  return JSON.parse(raw);\n+}',
        },
      ],
    };

    const commit2Hunks = [
      {
        filePath: 'src/auth/jwt.ts',
        oldStart: 1,
        oldLines: 5,
        newStart: 1,
        newLines: 5,
        hunkContent: '@@ -0,0 +1,5 @@\n+export function parseToken(raw) {\n+  return JSON.parse(raw);\n+}',
      },
    ];

    // Mock OmniRoute completion for Commit 2 (All personas return clean 0 findings)
    vi.spyOn(mockRouter, 'complete').mockResolvedValue({
      content: '[]',
      providerUsed: 'openai',
      modelUsed: 'gpt-4o',
      tokensUsed: { prompt: 100, completion: 20, total: 120 },
    });

    // 1. Fan-out LLM analysis for Commit 2
    const mefResult2 = await executeQuorumFanOut(commit2Context, {
      config: testConfig,
      router: mockRouter,
    });

    expect(mefResult2.allFindings).toHaveLength(0);

    // 2. Consensus Aggregation & Diff State Tracking for Commit 2
    const quorumResult2 = await aggregateQuorumConsensus(
      {
        repoOwner: commit2Context.repoOwner,
        repoName: commit2Context.repoName,
        prNumber: commit2Context.prNumber,
        headSha: commit2Context.headSha,
        baseSha: commit2Context.baseSha,
        config: testConfig,
        hunks: commit2Hunks,
        mefResult: mefResult2,
        prTitle: commit2Context.prTitle,
        prBody: commit2Context.prBody,
        changedFiles: commit2Context.diffFiles,
        constitution: parsedConstitution,
      },
      diffStateMgr
    );

    // Verify Commit 2 Assertions
    expect(quorumResult2.decision).toBe('APPROVE');
    expect(quorumResult2.ticketValidation.valid).toBe(true);
    expect(quorumResult2.ticketValidation.ticketsFound).toContain('PROJ-202');
    expect(quorumResult2.constitutionCompliance.compliant).toBe(true);
    expect(quorumResult2.activeFindings).toHaveLength(0);
    expect(quorumResult2.resolvedFindings.length).toBeGreaterThanOrEqual(1);
    expect(quorumResult2.inlineComments).toHaveLength(0);
    expect(quorumResult2.formattedMarkdown).toContain('🟢 **APPROVED**');

    // Verify state in diffStateManager DB
    const state2 = await storage.getPRState('acme-org', 'auth-service', 101);
    expect(state2).not.toBeNull();
    expect(state2?.findings.filter((f) => f.status === 'RESOLVED')).toHaveLength(1);
    expect(state2?.findings.filter((f) => f.status === 'IDENTIFIED')).toHaveLength(0);
  });
});
