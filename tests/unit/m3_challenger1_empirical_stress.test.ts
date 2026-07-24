import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeQuorumFanOut, mefEngineOptions, mefEngineResult } from '../../src/quorum/mefEngine';
import { OmniRouteAdapter, ProviderConfig } from '../../src/router/omniRouteAdapter';
import { CtReviewConfig, EffortLevel, Persona } from '../../src/config/schema';
import { QuorumReviewContext } from '../../src/quorum/personas/basePersona';
import { extractAndParseJSONFindings } from '../../src/quorum/personas/parseHelper';
import { securityPersona } from '../../src/quorum/personas/securityPersona';
import { archPersona } from '../../src/quorum/personas/archPersona';
import { perfPersona } from '../../src/quorum/personas/perfPersona';
import { qualityPersona } from '../../src/quorum/personas/qualityPersona';
import { getPersonaRunner } from '../../src/quorum/personas';

describe('Challenger 1 — Milestone 3 Quorum Engine Empirical Stress Harness', () => {
  let mockRouter: OmniRouteAdapter;
  let testConfig: CtReviewConfig;
  let sampleContext: QuorumReviewContext;

  beforeEach(() => {
    const dummyProvider: ProviderConfig = {
      id: 'mock-omniroute-provider',
      providerType: 'openai',
      displayName: 'Mock Provider',
      baseUrl: 'https://api.openai.com',
      billingTier: 'subscription_flat',
      defaultModel: 'gpt-4o',
      supportedModels: ['gpt-4o', 'o1-preview'],
      priority: 1,
      enabled: true,
    };

    mockRouter = new OmniRouteAdapter({
      providers: [dummyProvider],
      defaultProviderId: 'mock-omniroute-provider',
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
      repoOwner: 'acme-org',
      repoName: 'payment-service',
      prNumber: 101,
      headSha: 'headsha123456',
      baseSha: 'basesha654321',
      prTitle: 'feat: add encrypted payment tokens [PAY-789]',
      prBody: 'Implements AES-256 GCM token encryption.\n\nTesting steps:\n- npm test',
      diffFiles: [
        {
          filePath: 'src/crypto/token.ts',
          patch: '@@ -1,5 +1,12 @@\n+import crypto from "crypto";\n+export function encrypt(text: string) {\n+  return crypto.createCipher("aes192", "secret");\n+}',
        },
        {
          filePath: 'src/controllers/payment.ts',
          patch: '@@ -20,3 +20,8 @@\n+export async function handlePayment(req: any) {\n+  const key = req.headers["x-api-key"];\n+  return process(key);\n+}',
        },
      ],
    };
  });

  // =========================================================================
  // 1. High Concurrency Parallel Persona Execution Stress Suite
  // =========================================================================
  describe('1. High Concurrency Parallel Persona Execution', () => {
    it('executes 50 concurrent PR reviews (200 parallel persona LLM requests) without cross-talk, leaks, or state corruption', async () => {
      let totalLLMCalls = 0;

      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
        totalLLMCalls++;
        // Simulate small random latency between 5ms and 20ms to stress race conditions
        const delay = Math.floor(Math.random() * 15) + 5;
        await new Promise((r) => setTimeout(r, delay));

        return {
          content: JSON.stringify([
            {
              filePath: 'src/crypto/token.ts',
              lineNumber: 3,
              severity: 'major',
              comment: `Concurrency test finding for ${req.persona} on PR`,
              ruleId: `${req.persona.toUpperCase()}-STRESS`,
            },
          ]),
          providerUsed: 'mock-omniroute-provider',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 150, completion: 50, total: 200 },
        };
      });

      const concurrentPRs = 50;
      const tasks: Promise<mefEngineResult>[] = [];

      for (let i = 0; i < concurrentPRs; i++) {
        const prContext: QuorumReviewContext = {
          ...sampleContext,
          prNumber: 1000 + i,
        };
        tasks.push(
          executeQuorumFanOut(prContext, {
            config: testConfig,
            router: mockRouter,
            timeoutMsPerPersona: 5000,
          })
        );
      }

      const results = await Promise.all(tasks);

      expect(results).toHaveLength(50);
      expect(totalLLMCalls).toBe(200); // 50 PRs * 4 personas = 200 total calls

      results.forEach((res, i) => {
        expect(res.stats.personasExecuted).toEqual(['security', 'architecture', 'performance', 'quality']);
        expect(res.stats.personasFailed).toHaveLength(0);
        expect(res.allFindings).toHaveLength(4);
        expect(res.stats.totalTokensUsed).toBe(800); // 4 * 200 = 800 per PR
        expect(res.stats.totalExecutionTimeMs).toBeGreaterThan(0);
      });
    });

    it('maintains strict persona isolation when concurrent requests have different persona configurations', async () => {
      const completeSpy = vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => ({
        content: JSON.stringify([
          {
            filePath: 'src/test.ts',
            lineNumber: 1,
            severity: 'minor',
            comment: `Finding from ${req.persona}`,
          },
        ]),
        providerUsed: 'mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
      }));

      const config1: CtReviewConfig = {
        ...testConfig,
        quorum: { ...testConfig.quorum, personas: ['security', 'performance'] },
      };

      const config2: CtReviewConfig = {
        ...testConfig,
        quorum: { ...testConfig.quorum, personas: ['architecture', 'quality'] },
      };

      const [res1, res2] = await Promise.all([
        executeQuorumFanOut(sampleContext, { config: config1, router: mockRouter }),
        executeQuorumFanOut(sampleContext, { config: config2, router: mockRouter }),
      ]);

      expect(res1.stats.personasExecuted).toEqual(['security', 'performance']);
      expect(res2.stats.personasExecuted).toEqual(['architecture', 'quality']);
      expect(completeSpy).toHaveBeenCalledTimes(4);
    });
  });

  // =========================================================================
  // 2. Partial Persona Failures and Timeouts Stress Suite
  // =========================================================================
  describe('2. Partial Persona Failures and Timeouts', () => {
    it('handles 1 timing out persona while remaining 3 personas resolve normally', async () => {
      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
        if (req.persona === 'architecture') {
          // Hang longer than timeoutMs
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return {
          content: JSON.stringify([
            {
              filePath: 'src/crypto/token.ts',
              lineNumber: 2,
              severity: 'minor',
              comment: `Normal response for ${req.persona}`,
            },
          ]),
          providerUsed: 'mock-provider',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 100, completion: 20, total: 120 },
        };
      });

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
        timeoutMsPerPersona: 100, // Short timeout 100ms for test execution speed
      });

      expect(res.stats.personasExecuted).toEqual(['security', 'performance', 'quality']);
      expect(res.stats.personasFailed).toEqual(['architecture']);
      expect(res.personaResults.architecture.success).toBe(false);
      expect(res.personaResults.architecture.error).toContain('architecture timed out after 100ms');
      expect(res.allFindings).toHaveLength(3);
      expect(res.stats.totalTokensUsed).toBe(360); // 3 * 120
    });

    it('handles network / provider exception in 2 personas while 2 personas succeed', async () => {
      vi.spyOn(mockRouter, 'complete').mockImplementation(async (req) => {
        if (req.persona === 'security') {
          throw new Error('500 Internal Server Error from OpenAI API');
        }
        if (req.persona === 'performance') {
          throw new Error('429 Rate Limit Exceeded');
        }
        return {
          content: JSON.stringify([
            {
              filePath: 'src/crypto/token.ts',
              lineNumber: 1,
              severity: 'major',
              comment: `Ok from ${req.persona}`,
            },
          ]),
          providerUsed: 'mock-provider',
          modelUsed: 'gpt-4o',
          tokensUsed: { prompt: 100, completion: 50, total: 150 },
        };
      });

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toEqual(['architecture', 'quality']);
      expect(res.stats.personasFailed).toEqual(['security', 'performance']);
      expect(res.personaResults.security.error).toContain('500 Internal Server Error');
      expect(res.personaResults.performance.error).toContain('429 Rate Limit Exceeded');
      expect(res.allFindings).toHaveLength(2);
    });

    it('handles total failure scenario where ALL configured personas fail or time out', async () => {
      vi.spyOn(mockRouter, 'complete').mockRejectedValue(new Error('OmniRoute Token Storage Unreachable'));

      const res = await executeQuorumFanOut(sampleContext, {
        config: testConfig,
        router: mockRouter,
      });

      expect(res.stats.personasExecuted).toHaveLength(0);
      expect(res.stats.personasFailed).toEqual(['security', 'architecture', 'performance', 'quality']);
      expect(res.allFindings).toHaveLength(0);
      expect(res.stats.totalTokensUsed).toBe(0);
      expect(res.stats.totalExecutionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 3. Invalid or Corrupted LLM JSON Responses Stress Suite
  // =========================================================================
  describe('3. Invalid or Corrupted LLM JSON Responses', () => {
    it('parses markdown json code blocks (```json ... ``` and ``` ... ```) with leading/trailing text', () => {
      const inputWithJsonFence = `
Here is my review of the security aspects:
\`\`\`json
[
  {
    "filePath": "src/crypto/token.ts",
    "lineNumber": 3,
    "severity": "critical",
    "comment": "Deprecated crypto.createCipher used. Use createCipheriv instead.",
    "suggestion": "crypto.createCipheriv('aes-256-gcm', key, iv)",
    "ruleId": "SEC-CRYPTO-DEPRECATED"
  }
]
\`\`\`
End of security review.
`;

      const findings = extractAndParseJSONFindings(inputWithJsonFence, 'security', sampleContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].filePath).toBe('src/crypto/token.ts');
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].ruleId).toBe('SEC-CRYPTO-DEPRECATED');

      const inputWithGenericFence = `
\`\`\`
[
  {
    "filePath": "src/controllers/payment.ts",
    "lineNumber": 21,
    "severity": "major",
    "comment": "Missing authorization check on API key header."
  }
]
\`\`\`
`;
      const findings2 = extractAndParseJSONFindings(inputWithGenericFence, 'security', sampleContext);
      expect(findings2).toHaveLength(1);
      expect(findings2[0].filePath).toBe('src/controllers/payment.ts');
      expect(findings2[0].severity).toBe('major');
    });

    it('extracts JSON array when embedded within raw conversational text without code fences', () => {
      const rawTextWithArray = `
After reviewing the code, I found 1 performance issue:
[
  {
    "filePath": "src/controllers/payment.ts",
    "lineNumber": 22,
    "severity": "minor",
    "comment": "Synchronous call in async loop.",
    "suggestion": "await processAsync(key);"
  }
]
Please address this when possible.
`;

      const findings = extractAndParseJSONFindings(rawTextWithArray, 'performance', sampleContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].comment).toBe('Synchronous call in async loop.');
    });

    it('handles wrapper JSON objects containing findings/items/results arrays', () => {
      // Wrapper object with "findings" key
      const wrappedFindings = JSON.stringify({
        summary: 'Found 1 issue',
        findings: [
          {
            filePath: 'src/a.ts',
            lineNumber: 10,
            severity: 'major',
            comment: 'Issue in wrapped object',
          },
        ],
      });
      const f1 = extractAndParseJSONFindings(wrappedFindings, 'architecture', sampleContext);
      expect(f1).toHaveLength(1);
      expect(f1[0].comment).toBe('Issue in wrapped object');

      // Wrapper object with "items" key
      const wrappedItems = JSON.stringify({
        items: [
          {
            filePath: 'src/b.ts',
            lineNumber: 15,
            severity: 'nit',
            comment: 'Nit in items array',
          },
        ],
      });
      const f2 = extractAndParseJSONFindings(wrappedItems, 'quality', sampleContext);
      expect(f2).toHaveLength(1);
      expect(f2[0].comment).toBe('Nit in items array');

      // Wrapper object with "results" key
      const wrappedResults = JSON.stringify({
        results: [
          {
            filePath: 'src/c.ts',
            lineNumber: 20,
            severity: 'critical',
            comment: 'Critical in results array',
          },
        ],
      });
      const f3 = extractAndParseJSONFindings(wrappedResults, 'security', sampleContext);
      expect(f3).toHaveLength(1);
      expect(f3[0].comment).toBe('Critical in results array');
    });

    it('gracefully handles severely corrupted, unparseable, or truncated JSON without throwing', () => {
      const brokenJSONs = [
        `[ { "filePath": "src/a.ts", "comment": "Truncated json...`,
        `{ "error": "Internal model failure" }`,
        `NOT_JSON_AT_ALL`,
        `[`,
        `undefined`,
        `null`,
        `{}`,
      ];

      brokenJSONs.forEach((brokenStr) => {
        expect(() => extractAndParseJSONFindings(brokenStr, 'security', sampleContext)).not.toThrow();
        const res = extractAndParseJSONFindings(brokenStr, 'security', sampleContext);
        expect(Array.isArray(res)).toBe(true);
        expect(res).toHaveLength(0);
      });
    });

    it('sanitizes and defaults missing, invalid, or malformed finding fields', () => {
      const rawWithMissingFields = JSON.stringify([
        {
          // Missing filePath -> should default to sampleContext.diffFiles[0].filePath
          // Missing lineNumber -> should default to 1
          severity: 'SUPER_CRITICAL_INVALID', // Should default to 'minor'
          description: 'Used description field instead of comment', // Should map description -> comment
          suggestion: 12345, // Non-string suggestion -> converted to string
        },
        {
          filePath: 'src/controllers/payment.ts',
          startLine: 15, // Uses startLine instead of lineNumber
          endLine: 20, // Uses endLine instead of endLineNumber
          severity: 'NIT', // Case insensitive severity
          comment: '   Spaced comment   ',
          persona: 'SECURITY', // Upper case persona string -> normalized to security
        },
        {
          // Item without comment or description -> MUST be filtered out
          filePath: 'src/invalid.ts',
          lineNumber: 5,
        },
      ]);

      const findings = extractAndParseJSONFindings(rawWithMissingFields, 'quality', sampleContext);

      expect(findings).toHaveLength(2);

      // Item 1 verification
      expect(findings[0].filePath).toBe('src/crypto/token.ts');
      expect(findings[0].lineNumber).toBe(1);
      expect(findings[0].severity).toBe('minor');
      expect(findings[0].comment).toBe('Used description field instead of comment');
      expect(findings[0].suggestion).toBe('12345');

      // Item 2 verification
      expect(findings[1].filePath).toBe('src/controllers/payment.ts');
      expect(findings[1].lineNumber).toBe(15);
      expect(findings[1].endLineNumber).toBe(20);
      expect(findings[1].severity).toBe('nit');
      expect(findings[1].comment).toBe('Spaced comment');
      expect(findings[1].persona).toBe('security');
    });
  });

  // =========================================================================
  // 4. Persona Effort Level Mappings & Persona Prompts Stress Suite
  // =========================================================================
  describe('4. Persona Effort Level Mappings & Persona Prompts', () => {
    it('verifies system prompt content and user prompt construction for all 4 default persona runners', () => {
      const runners = [
        { name: 'security', runner: securityPersona, expectedRole: 'Security Auditor' },
        { name: 'architecture', runner: archPersona, expectedRole: 'Software Architect' },
        { name: 'performance', runner: perfPersona, expectedRole: 'Performance Optimization Engineer' },
        { name: 'quality', runner: qualityPersona, expectedRole: 'Code Quality Lead' },
      ];

      runners.forEach(({ name, runner, expectedRole }) => {
        expect(runner.persona).toBe(name);

        const systemPrompt = runner.getSystemPrompt();
        expect(systemPrompt).toContain(expectedRole);
        expect(systemPrompt).toContain('JSON array');

        const userPrompt = runner.buildUserPrompt(sampleContext);
        expect(userPrompt).toContain(`PR Title: ${sampleContext.prTitle}`);
        expect(userPrompt).toContain(`PR Description: ${sampleContext.prBody}`);
        expect(userPrompt).toContain('src/crypto/token.ts');
        expect(userPrompt).toContain('src/controllers/payment.ts');

        // Verify getPersonaRunner helper
        expect(getPersonaRunner(name as Persona)).toBe(runner);
      });
    });

    it('correctly propagates effort levels (low, medium, high, reasoning) from config and overrides to OmniRouteAdapter', async () => {
      const completeSpy = vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 50, completion: 10, total: 60 },
      });

      const effortLevels: EffortLevel[] = ['low', 'medium', 'high', 'reasoning'];

      for (const level of effortLevels) {
        testConfig.quorum.effortLevel = level;
        await executeQuorumFanOut(sampleContext, {
          config: testConfig,
          router: mockRouter,
        });

        // Each persona should receive the global effort level
        expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ effortLevel: level }));
        completeSpy.mockClear();
      }
    });

    it('applies per-persona effort overrides over global effort level configuration', async () => {
      const completeSpy = vi.spyOn(mockRouter, 'complete').mockResolvedValue({
        content: '[]',
        providerUsed: 'mock-provider',
        modelUsed: 'gpt-4o',
        tokensUsed: { prompt: 50, completion: 10, total: 60 },
      });

      testConfig.quorum.effortLevel = 'low';

      const options: mefEngineOptions = {
        config: testConfig,
        router: mockRouter,
        personaEffortOverrides: {
          security: 'reasoning',
          architecture: 'high',
          performance: 'medium',
          // quality omitted -> defaults to 'low'
        },
      };

      await executeQuorumFanOut(sampleContext, options);

      expect(completeSpy).toHaveBeenCalledTimes(4);

      // Verify each specific persona received its requested effort override
      expect(completeSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ persona: 'security', effortLevel: 'reasoning' })
      );
      expect(completeSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ persona: 'architecture', effortLevel: 'high' })
      );
      expect(completeSpy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ persona: 'performance', effortLevel: 'medium' })
      );
      expect(completeSpy).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ persona: 'quality', effortLevel: 'low' })
      );
    });
  });
});
