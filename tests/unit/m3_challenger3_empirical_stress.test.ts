import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeQuorumFanOut, mefEngineOptions, mefEngineResult } from '../../src/quorum/mefEngine';
import { OmniRouteAdapter, ProviderConfig } from '../../src/router/omniRouteAdapter';
import { CtReviewConfig, EffortLevel, Persona } from '../../src/config/schema';
import { QuorumReviewContext, PRDiffFile } from '../../src/quorum/personas/basePersona';
import { extractAndParseJSONFindings } from '../../src/quorum/personas/parseHelper';
import { securityPersona } from '../../src/quorum/personas/securityPersona';
import { archPersona } from '../../src/quorum/personas/archPersona';
import { perfPersona } from '../../src/quorum/personas/perfPersona';
import { qualityPersona } from '../../src/quorum/personas/qualityPersona';
import { getPersonaRunner } from '../../src/quorum/personas';

describe('Challenger 3 — Quorum Engine & Personas Empirical Stress Harness', () => {
  let mockRouter: OmniRouteAdapter;
  let testConfig: CtReviewConfig;
  let sampleContext: QuorumReviewContext;

  beforeEach(() => {
    const dummyProvider: ProviderConfig = {
      id: 'challenger3-mock-provider',
      providerType: 'openai',
      displayName: 'Challenger 3 Mock Provider',
      baseUrl: 'https://api.openai.com',
      billingTier: 'subscription_flat',
      defaultModel: 'gpt-4o',
      supportedModels: ['gpt-4o', 'o1-preview'],
      priority: 1,
      enabled: true,
    };

    mockRouter = new OmniRouteAdapter({
      providers: [dummyProvider],
      defaultProviderId: 'challenger3-mock-provider',
    });

    testConfig = {
      version: '1.0.0',
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
      repoOwner: 'acme-corp',
      repoName: 'banking-service',
      prNumber: 303,
      headSha: 'headsha333333333333333333333333333333',
      baseSha: 'basesha333333333333333333333333333333',
      prTitle: 'feat: add wire transfer API [FIN-303]',
      prBody: 'Implements wire transfer processing.\n\nTesting steps:\n- npm test',
      diffFiles: [
        {
          filePath: 'src/services/wireTransfer.ts',
          patch: '@@ -1,10 +1,25 @@\n+import { db } from "../db";\n+export async function transfer(amount: number, toAccount: string) {\n+  await db.query(`UPDATE accounts SET balance = balance - ${amount}`);\n+}',
        },
        {
          filePath: 'src/controllers/wire.ts',
          patch: '@@ -5,5 +5,10 @@\n+export async function handleWire(req: any) {\n+  return transfer(req.body.amount, req.body.to);\n+}',
        },
      ],
    };
  });

  // =========================================================================
  // 1. mefEngine Fan-Out Fan-In Orchestrator Stress Tests
  // =========================================================================
  describe('1. mefEngine Fan-Out Fan-In Orchestrator', () => {
    it('handles empty diffFiles array without throwing and passes empty diff to personas', async () => {
      const emptyContext: QuorumReviewContext = {
        ...sampleContext,
        diffFiles: [],
      };

      vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'challenger3-mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 50, completion: 10, total: 60 },
      });

      const res = await executeQuorumFanOut(emptyContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toEqual(['security', 'architecture', 'performance', 'quality']);
      expect(res.allFindings).toHaveLength(0);
      expect(res.stats.totalTokensUsed).toBe(240); // 4 * 60
    });

    it('handles context with undefined patch or content in diffFiles gracefully', async () => {
      const diffContext: QuorumReviewContext = {
        ...sampleContext,
        diffFiles: [
          { filePath: 'src/empty1.ts' },
          { filePath: 'src/empty2.ts', patch: undefined, content: undefined },
        ],
      };

      const completeSpy = vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'challenger3-mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 40, completion: 10, total: 50 },
      });

      const res = await executeQuorumFanOut(diffContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toHaveLength(4);
      expect(completeSpy).toHaveBeenCalledTimes(4);
      // Prompt should contain fallback text "No diff patch available"
      const callArg = completeSpy.mock.calls[0][0];
      expect(callArg.prompt).toContain('No diff patch available');
    });

    it('processes massive diff payloads with 50 files without crashing or leaking memory', async () => {
      const largeDiffFiles: PRDiffFile[] = [];
      for (let i = 0; i < 50; i++) {
        largeDiffFiles.push({
          filePath: `src/generated/file_${i}.ts`,
          patch: `@@ -1,100 +1,200 @@\n` + `+const line_${i} = ${i};\n`.repeat(100),
        });
      }

      const largeContext: QuorumReviewContext = {
        ...sampleContext,
        diffFiles: largeDiffFiles,
      };

      vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: JSON.stringify([
          {
            filePath: 'src/generated/file_0.ts',
            lineNumber: 10,
            severity: 'minor',
            comment: 'Large diff test finding',
          },
        ]),
        providerUsed: 'challenger3-mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 5000, completion: 100, total: 5100 },
      });

      const res = await executeQuorumFanOut(largeContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toHaveLength(4);
      expect(res.allFindings).toHaveLength(4);
      expect(res.stats.totalTokensUsed).toBe(20400); // 4 * 5100
    });

    it('enforces per-persona timeout isolation when 1 persona hangs beyond timeoutMs', async () => {
      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
        if (req.persona === 'performance') {
          await new Promise((r) => setTimeout(r, 400));
        }
        return {
          content: '[]',
          providerUsed: 'challenger3-mock-provider',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 100, completion: 20, total: 120 },
        };
      });

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
        timeoutMsPerPersona: 100,
      });

      expect(res.stats.personasExecuted).toEqual(['security', 'architecture', 'quality']);
      expect(res.stats.personasFailed).toEqual(['performance']);
      expect(res.personaResults.performance.success).toBe(false);
      expect(res.personaResults.performance.error).toContain('performance timed out after 100ms');
    });

    it('handles LLM responses with undefined or missing tokensUsed objects without NaN totals', async () => {
      vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'challenger3-mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: undefined as any,
      });

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toHaveLength(4);
      expect(res.stats.totalTokensUsed).toBe(0);
      expect(Number.isNaN(res.stats.totalTokensUsed)).toBe(false);
    });

    it('falls back to default quality runner when custom or unknown persona string is provided in config', async () => {
      const customConfig: CtReviewConfig = {
        ...testConfig,
        quorum: {
          ...testConfig.quorum,
          personas: ['custom_unknown' as Persona],
        },
      };

      vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: JSON.stringify([
          {
            filePath: 'src/services/wireTransfer.ts',
            lineNumber: 5,
            severity: 'nit',
            comment: 'Fallback runner executed successfully',
          },
        ]),
        providerUsed: 'challenger3-mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 100, completion: 20, total: 120 },
      });

      const res = await executeQuorumFanOut(sampleContext, {
        config: customConfig,
        router: mockRouter,
      });

      expect(res.stats.totalPersonasConfigured).toBe(1);
      expect(res.stats.personasExecuted).toEqual(['custom_unknown']);
      expect(res.allFindings).toHaveLength(1);
      expect(res.allFindings[0].comment).toBe('Fallback runner executed successfully');
    });

    it('correctly passes per-persona effort overrides vs global effort level', async () => {
      const completeSpy = vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'challenger3-mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 50, completion: 10, total: 60 },
      });

      testConfig.quorum.effortLevel = 'medium';

      const options: mefEngineOptions = {
        config: testConfig,
        router: mockRouter,
        personaEffortOverrides: {
          security: 'reasoning',
          architecture: 'high',
        },
      };

      await executeQuorumFanOut(sampleContext, options);

      expect(completeSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ persona: 'security', effortLevel: 'reasoning' }));
      expect(completeSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ persona: 'architecture', effortLevel: 'high' }));
      expect(completeSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ persona: 'performance', effortLevel: 'medium' }));
      expect(completeSpy).toHaveBeenNthCalledWith(4, expect.objectContaining({ persona: 'quality', effortLevel: 'medium' }));
    });

    it('executes 30 concurrent PR fan-out reviews (120 parallel tasks) cleanly under load', async () => {
      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10) + 1));
        return {
          content: JSON.stringify([
            {
              filePath: 'src/services/wireTransfer.ts',
              lineNumber: 3,
              severity: 'major',
              comment: `Concurrent finding for ${req.persona}`,
            },
          ]),
          providerUsed: 'challenger3-mock-provider',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 100, completion: 30, total: 130 },
        };
      });

      const promises: Promise<mefEngineResult>[] = [];
      for (let i = 0; i < 30; i++) {
        promises.push(
          executeQuorumFanOut(
            { ...sampleContext, prNumber: 500 + i },
            { config: testConfig, router: mockRouter }
          )
        );
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(30);

      results.forEach((res) => {
        expect(res.stats.personasExecuted).toHaveLength(4);
        expect(res.stats.personasFailed).toHaveLength(0);
        expect(res.allFindings).toHaveLength(4);
        expect(res.stats.totalTokensUsed).toBe(520); // 4 * 130
      });
    });
  });

  // =========================================================================
  // 2. Personas Prompt Structure & Field Parsing Stress Tests
  // =========================================================================
  describe('2. Personas Prompt Structure & Field Parsing', () => {
    it('verifies prompt generation and runner mapping for all 4 personas', () => {
      const personasList: Persona[] = ['security', 'architecture', 'performance', 'quality'];

      personasList.forEach((p) => {
        const runner = getPersonaRunner(p);
        expect(runner.persona).toBe(p);

        const sysPrompt = runner.getSystemPrompt();
        expect(typeof sysPrompt).toBe('string');
        expect(sysPrompt.length).toBeGreaterThan(50);
        expect(sysPrompt).toContain('JSON array');

        const userPrompt = runner.buildUserPrompt(sampleContext);
        expect(userPrompt).toContain(`Review Pull Request #${sampleContext.prNumber}`);
        expect(userPrompt).toContain(sampleContext.repoOwner);
        expect(userPrompt).toContain(sampleContext.repoName);
        expect(userPrompt).toContain(sampleContext.prTitle);
        expect(userPrompt).toContain(sampleContext.prBody);
        expect(userPrompt).toContain('src/services/wireTransfer.ts');
      });
    });

    it('extracts findings from nested markdown JSON fences and surrounding text', () => {
      const complexMarkdown = `
Here are the security audit findings for the pull request:

\`\`\`json
[
  {
    "filePath": "src/services/wireTransfer.ts",
    "lineNumber": 3,
    "severity": "critical",
    "comment": "SQL Injection in update query string template",
    "suggestion": "await db.query('UPDATE accounts SET balance = balance - ?', [amount]);",
    "ruleId": "SEC-SQL-INJECTION"
  }
]
\`\`\`

Please resolve these items before merging.
`;

      const findings = extractAndParseJSONFindings(complexMarkdown, 'security', sampleContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].persona).toBe('security');
      expect(findings[0].filePath).toBe('src/services/wireTransfer.ts');
      expect(findings[0].lineNumber).toBe(3);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].comment).toBe('SQL Injection in update query string template');
      expect(findings[0].suggestion).toContain('UPDATE accounts');
      expect(findings[0].ruleId).toBe('SEC-SQL-INJECTION');
    });

    it('handles wrapper JSON objects containing findings, items, or results keys', () => {
      const wrapperObject = JSON.stringify({
        reviewSummary: 'Completed review',
        findings: [
          {
            filePath: 'src/controllers/wire.ts',
            lineNumber: 6,
            severity: 'major',
            comment: 'Missing input validation on req.body.amount',
          },
        ],
      });

      const findings = extractAndParseJSONFindings(wrapperObject, 'architecture', sampleContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].persona).toBe('architecture');
      expect(findings[0].comment).toContain('Missing input validation');
    });

    it('recovers cleanly without throwing on completely invalid JSON strings', () => {
      const invalidStrings = [
        '<html><body>504 Gateway Timeout</body></html>',
        'Stack overflow error in node_modules/...',
        '[{ "filePath": "src/a.ts", "lineNumber": 10', // Truncated
        'null',
        'undefined',
        '12345',
        '{}',
      ];

      invalidStrings.forEach((str) => {
        expect(() => extractAndParseJSONFindings(str, 'quality', sampleContext)).not.toThrow();
        const res = extractAndParseJSONFindings(str, 'quality', sampleContext);
        expect(Array.isArray(res)).toBe(true);
        expect(res).toHaveLength(0);
      });
    });

    it('sanitizes and normalizes invalid, missing, or malformed fields in LLM output', () => {
      const malformedPayload = JSON.stringify([
        {
          // Missing filePath -> default to first diff file
          // Missing lineNumber -> default to 1
          severity: 'SUPER_FATAL_SEVERITY', // Invalid -> default to 'minor'
          description: 'Uses description instead of comment',
          suggestion: 99999, // Number -> converted to string
        },
        {
          filePath: '  src/controllers/wire.ts  ',
          startLine: 12, // startLine -> lineNumber
          endLine: 18, // endLine -> endLineNumber
          severity: 'CRITICAL', // Case insensitive -> 'critical'
          comment: '   Unprotected endpoint   ',
          persona: 'SECURITY', // Upper case persona -> 'security'
        },
        {
          // Missing both comment and description -> MUST be filtered out
          filePath: 'src/invalid.ts',
          lineNumber: 5,
        },
      ]);

      const findings = extractAndParseJSONFindings(malformedPayload, 'quality', sampleContext);
      expect(findings).toHaveLength(2);

      // First item
      expect(findings[0].filePath).toBe('src/services/wireTransfer.ts');
      expect(findings[0].lineNumber).toBe(1);
      expect(findings[0].severity).toBe('minor');
      expect(findings[0].comment).toBe('Uses description instead of comment');
      expect(findings[0].suggestion).toBe('99999');

      // Second item
      expect(findings[1].filePath).toBe('src/controllers/wire.ts');
      expect(findings[1].lineNumber).toBe(12);
      expect(findings[1].endLineNumber).toBe(18);
      expect(findings[1].severity).toBe('critical');
      expect(findings[1].comment).toBe('Unprotected endpoint');
      expect(findings[1].persona).toBe('security');
    });

    it('handles PR title and body with prompt injection, backticks, and special characters', () => {
      const toxicContext: QuorumReviewContext = {
        ...sampleContext,
        prTitle: 'feat: `; DROP TABLE users; -- [PAY-100]',
        prBody: '```json\n{"injection": true}\n```\n${process.env.SECRET}\n\0\u0000',
      };

      const personas: Persona[] = ['security', 'architecture', 'performance', 'quality'];
      personas.forEach((p) => {
        const runner = getPersonaRunner(p);
        expect(() => runner.buildUserPrompt(toxicContext)).not.toThrow();
        const prompt = runner.buildUserPrompt(toxicContext);
        expect(prompt).toContain('DROP TABLE users');
      });
    });
  });
});
