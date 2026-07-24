import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeQuorumFanOut, QuorumReviewContext } from '../../src/quorum/mefEngine';
import { OmniRouteAdapter, ProviderConfig } from '../../src/router/omniRouteAdapter';
import { CtReviewConfig } from '../../src/config/schema';
import { securityPersona } from '../../src/quorum/personas/securityPersona';
import { archPersona } from '../../src/quorum/personas/archPersona';
import { perfPersona } from '../../src/quorum/personas/perfPersona';
import { qualityPersona } from '../../src/quorum/personas/qualityPersona';
import { extractAndParseJSONFindings } from '../../src/quorum/personas/parseHelper';

describe('Quorum Review Panel Engine — mefEngine Unit Tests', () => {
  let mockRouter: OmniRouteAdapter;
  let testConfig: CtReviewConfig;
  let sampleContext: QuorumReviewContext;

  beforeEach(() => {
    const dummyProvider: ProviderConfig = {
      id: 'mock-provider',
      providerType: 'openai',
      displayName: 'Mock Provider',
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

    sampleContext = {
      repoOwner: 'acme-inc',
      repoName: 'backend-api',
      prNumber: 42,
      headSha: 'abc123head',
      baseSha: 'xyz987base',
      prTitle: 'feat: add payment processing endpoint',
      prBody: 'Implements payment processing with JWT auth.',
      diffFiles: [
        {
          filePath: 'src/payment.ts',
          patch: '@@ -10,6 +10,12 @@\n+const token = "secret123";\n+eval(req.body);',
        },
      ],
    };
  });

  describe('Persona Prompts & Parser Units', () => {
    it('generates system and user prompts for all 4 personas', () => {
      expect(securityPersona.getSystemPrompt()).toContain('Security Auditor');
      expect(securityPersona.buildUserPrompt(sampleContext)).toContain('src/payment.ts');

      expect(archPersona.getSystemPrompt()).toContain('Software Architect');
      expect(archPersona.buildUserPrompt(sampleContext)).toContain('src/payment.ts');

      expect(perfPersona.getSystemPrompt()).toContain('Performance Optimization Engineer');
      expect(perfPersona.buildUserPrompt(sampleContext)).toContain('src/payment.ts');

      expect(qualityPersona.getSystemPrompt()).toContain('Code Quality Lead');
      expect(qualityPersona.buildUserPrompt(sampleContext)).toContain('src/payment.ts');
    });

    it('robustly parses JSON findings with markdown code fences and stray text', () => {
      const markdownJson = `
Here are the security findings:
\`\`\`json
[
  {
    "filePath": "src/payment.ts",
    "lineNumber": 11,
    "severity": "critical",
    "comment": "Hardcoded secret token",
    "suggestion": "use process.env.TOKEN",
    "ruleId": "SEC-001"
  }
]
\`\`\`
Hope this helps!`;

      const findings = extractAndParseJSONFindings(markdownJson, 'security', sampleContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].filePath).toBe('src/payment.ts');
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].ruleId).toBe('SEC-001');
    });

    it('handles empty or malformed LLM responses without throwing exceptions', () => {
      expect(extractAndParseJSONFindings('', 'security')).toEqual([]);
      expect(extractAndParseJSONFindings('Invalid raw non-json text', 'security')).toEqual([]);
      expect(extractAndParseJSONFindings('{"error": "rate limit"}', 'security')).toEqual([]);
    });
  });

  describe('mefEngine.executeQuorumFanOut Orchestrator', () => {
    it('executes parallel fan-out across all 4 configured personas', async () => {
      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => ({
        content: JSON.stringify([
          {
            filePath: 'src/payment.ts',
            lineNumber: 10,
            severity: 'minor',
            comment: `Finding from ${req.persona}`,
            ruleId: `${req.persona.toUpperCase()}-001`,
          },
        ]),
        providerUsed: 'openai',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
      }));

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(mockRouter.complete).toHaveBeenCalledTimes(4);
      expect(res.stats.personasExecuted).toEqual(['security', 'architecture', 'performance', 'quality']);
      expect(res.stats.personasFailed).toHaveLength(0);
      expect(res.allFindings).toHaveLength(4);
      expect(res.stats.totalTokensUsed).toBe(600);
    });

    it('respects persona effort level overrides and custom persona selections', async () => {
      const completeSpy = vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'openai',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 50, completion: 10, total: 60 },
      });

      testConfig.quorum.personas = ['security', 'quality'];
      testConfig.quorum.effortLevel = 'low';

      await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
        personaEffortOverrides: {
          security: 'high',
        },
      });

      expect(completeSpy).toHaveBeenCalledTimes(2);
      expect(completeSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ persona: 'security', effortLevel: 'high' })
      );
      expect(completeSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ persona: 'quality', effortLevel: 'low' })
      );
    });

    it('handles partial persona timeouts and failures gracefully without crashing', async () => {
      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
        if (req.persona === 'performance') {
          throw new Error('LLM Provider Rate Limit 429');
        }
        return {
          content: JSON.stringify([
            {
              filePath: 'src/payment.ts',
              lineNumber: 12,
              severity: 'minor',
              comment: `OK from ${req.persona}`,
            },
          ]),
          providerUsed: 'openai',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 100, completion: 50, total: 150 },
        };
      });

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toEqual(['security', 'architecture', 'quality']);
      expect(res.stats.personasFailed).toEqual(['performance']);
      expect(res.personaResults.performance.success).toBe(false);
      expect(res.personaResults.performance.error).toContain('Rate Limit');
      expect(res.allFindings).toHaveLength(3);
    });
  });
});
