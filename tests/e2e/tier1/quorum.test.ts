import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { FixtureGenerator } from '@harness/fixtureGenerator';
import { E2EAssertions } from '@harness/assertions';
import { parseAndValidateConfig } from '@src/config/configLoader';
import {
  evaluateQuorum,
  PersonaFinding,
  QuorumEvaluationInput,
  QuorumEvaluationResult
} from '@src/quorum/quorumEngine';


describe('Tier 1 Feature Coverage: Quorum Aggregation & Multi-Persona Engine', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-quorum-suite',
      configYaml: FixtureGenerator.buildConfigYaml({
        quorum: {
          minApprovals: 2,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'medium',
        },
      }),
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockGithub.reset();
    harness.mockOmniRoute.resetState();
  });

  test('1. Fan-out concurrency across all configured persona agents', async () => {
    const omniUrl = `http://127.0.0.1:${harness.mockOmniRoute.port}`;
    const personas: Array<'security' | 'architecture' | 'performance' | 'quality'> = [
      'security',
      'architecture',
      'performance',
      'quality',
    ];

    const startTime = Date.now();
    // Dispatch concurrent fan-out requests to MockOmniRouteServer
    const promises = personas.map((persona) =>
      fetch(`${omniUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-access-token-123',
        },
        body: JSON.stringify({
          persona,
          effortLevel: 'medium',
          prompt: 'Review diff hunk for security vulnerabilities',
        }),
      })
    );

    const responses = await Promise.all(promises);
    const duration = Date.now() - startTime;

    expect(responses).toHaveLength(4);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.providerUsed).toBeDefined();
      expect(data.tokensUsed.total).toBeGreaterThan(0);
    }

    // Verify all 4 persona requests were recorded by MockOmniRouteServer
    const recordedRequests = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = recordedRequests.filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBeGreaterThanOrEqual(4);
    expect(duration).toBeLessThan(5000); // Verify concurrent execution speed
  });

  test('2. Fan-in quorum aggregation of findings from multiple personas', () => {
    const personaFindings: Record<string, PersonaFinding[]> = {
      security: [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 42,
          comment: 'Hardcoded secret token in auth.ts',
          codeSnippet: 'const token = "AKIA12345678";',
        },
      ],
      architecture: [
        {
          persona: 'architecture',
          severity: 'minor',
          filePath: 'src/ui/component.tsx',
          lineNumber: 12,
          comment: 'Direct database driver imported in React UI layer',
          codeSnippet: 'import db from "../db";',
        },
      ],
      performance: [],
      quality: [],
    };

    const result = evaluateQuorum({
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings,
    });

    expect(result.requestingChangesPersonas).toContain('security');
    expect(result.approvingPersonas).toContain('architecture');
    expect(result.approvingPersonas).toContain('performance');
    expect(result.approvingPersonas).toContain('quality');
    expect(result.activeFindings).toHaveLength(2);
    expect(result.decision).toBe('REQUEST_CHANGES');
  });

  test('3. Nit filtering ensures nit severity findings do not block approval', () => {
    const personaFindings: Record<string, PersonaFinding[]> = {
      security: [],
      architecture: [
        {
          persona: 'architecture',
          severity: 'nit',
          filePath: 'src/utils.ts',
          lineNumber: 5,
          comment: 'Prefer const over let for unused reassignment',
          codeSnippet: 'let x = 10;',
        },
      ],
      performance: [
        {
          persona: 'performance',
          severity: 'nit',
          filePath: 'src/format.ts',
          lineNumber: 10,
          comment: 'Consider caching template string',
          codeSnippet: 'const res = `${a}-${b}`;',
        },
      ],
      quality: [],
    };

    const result = evaluateQuorum({
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings,
    });

    expect(result.filteredNits).toHaveLength(2);
    expect(result.activeFindings).toHaveLength(0);
    expect(result.requestingChangesPersonas).toHaveLength(0);
    expect(result.approvingPersonas).toHaveLength(4);
    expect(result.decision).toBe('APPROVE');
  });

  test('4. Approval threshold decisions - APPROVE when approving personas >= minApprovals and 0 blocking findings', () => {
    const personaFindings: Record<string, PersonaFinding[]> = {
      security: [],
      architecture: [],
      performance: [],
      quality: [
        {
          persona: 'quality',
          severity: 'nit',
          filePath: 'src/index.ts',
          lineNumber: 1,
          comment: 'Missing newline at EOF',
          codeSnippet: 'console.log("ready");',
        },
      ],
    };

    const result = evaluateQuorum({
      minApprovals: 3,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings,
    });

    expect(result.approvingPersonas.length).toBe(4);
    expect(result.approvingPersonas.length).toBeGreaterThanOrEqual(3);
    expect(result.decision).toBe('APPROVE');
  });

  test('5. Approval threshold decisions - REQUEST_CHANGES when critical/major findings exist', () => {
    const personaFindings: Record<string, PersonaFinding[]> = {
      security: [
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/api.ts',
          lineNumber: 99,
          comment: 'SQL Injection vulnerability via unsanitized input',
          codeSnippet: 'db.query("SELECT * FROM users WHERE id = " + req.id)',
        },
      ],
      architecture: [],
      performance: [],
      quality: [],
    };

    const result = evaluateQuorum({
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings,
    });

    expect(result.requestingChangesPersonas).toEqual(['security']);
    expect(result.decision).toBe('REQUEST_CHANGES');
  });

  test('6. Quorum calculation with custom persona subset configuration', () => {
    const customConfig = parseAndValidateConfig(`
version: "1.0"
quorum:
  minApprovals: 2
  personas:
    - security
    - architecture
  effortLevel: high
`);

    expect(customConfig.quorum.personas).toEqual(['security', 'architecture']);

    const personaFindings: Record<string, PersonaFinding[]> = {
      security: [],
      architecture: [],
    };

    const result = evaluateQuorum({
      minApprovals: customConfig.quorum.minApprovals,
      configuredPersonas: customConfig.quorum.personas,
      personaFindings,
    });

    expect(result.approvingPersonas).toEqual(['security', 'architecture']);
    expect(result.decision).toBe('APPROVE');
  });
});
