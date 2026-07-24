import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { evaluateQuorum, PersonaFinding, QuorumEvaluationInput } from '@src/quorum/quorumEngine';

describe('Tier 2 Boundary & Corner Case Tests: Quorum Aggregation Engine', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-quorum-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockGithub.reset();
    harness.mockOmniRoute.resetState();
  });

  test('1. Empty inputs handling - handles missing findings, empty objects, and undefined entries', () => {
    const emptyInput: QuorumEvaluationInput = {
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings: {},
    };

    const result = evaluateQuorum(emptyInput);

    expect(result.approvingPersonas).toEqual(['security', 'architecture', 'performance', 'quality']);
    expect(result.requestingChangesPersonas).toEqual([]);
    expect(result.activeFindings).toEqual([]);
    expect(result.filteredNits).toEqual([]);
    expect(result.decision).toBe('APPROVE');
  });

  test('2. Zero personas boundary - empty configuredPersonas list returns zero approvals and REQUEST_CHANGES', () => {
    const zeroPersonasInput: QuorumEvaluationInput = {
      minApprovals: 2,
      configuredPersonas: [],
      personaFindings: {
        security: [
          {
            persona: 'security',
            severity: 'critical',
            filePath: 'src/main.ts',
            lineNumber: 1,
            comment: 'Critical bug',
            codeSnippet: 'const x = 1;',
          },
        ],
      },
    };

    const result = evaluateQuorum(zeroPersonasInput);

    expect(result.approvingPersonas).toHaveLength(0);
    expect(result.requestingChangesPersonas).toHaveLength(0);
    expect(result.activeFindings).toHaveLength(0);
    // Decision is REQUEST_CHANGES because approving count (0) < minApprovals (2)
    expect(result.decision).toBe('REQUEST_CHANGES');
  });

  test('3. High minApprovals boundary - requires all personas to approve when minApprovals exceeds active personas count', () => {
    const highThresholdInput: QuorumEvaluationInput = {
      minApprovals: 10, // Exceeds configured personas count of 4
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings: {
        security: [],
        architecture: [],
        performance: [],
        quality: [],
      },
    };

    const result = evaluateQuorum(highThresholdInput);

    expect(result.approvingPersonas).toHaveLength(4);
    // Even though 0 findings exist, 4 approving personas < minApprovals (10)
    expect(result.decision).toBe('REQUEST_CHANGES');
  });

  test('4. Tie-breaking and threshold boundary conditions', () => {
    // Scenario A: Exact threshold match (minApprovals = 2, 2 approving, 0 requesting changes)
    const exactMatch = evaluateQuorum({
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture'],
      personaFindings: { security: [], architecture: [] },
    });
    expect(exactMatch.approvingPersonas.length).toBe(2);
    expect(exactMatch.decision).toBe('APPROVE');

    // Scenario B: Requesting changes blocks approval even if approving personas >= minApprovals
    const blockedMatch = evaluateQuorum({
      minApprovals: 1,
      configuredPersonas: ['security', 'architecture'],
      personaFindings: {
        security: [],
        architecture: [
          {
            persona: 'architecture',
            severity: 'major',
            filePath: 'src/app.ts',
            lineNumber: 10,
            comment: 'Tight coupling',
            codeSnippet: 'new DirectDB()',
          },
        ],
      },
    });
    expect(blockedMatch.approvingPersonas).toEqual(['security']);
    expect(blockedMatch.requestingChangesPersonas).toEqual(['architecture']);
    // Blocking finding from architecture causes REQUEST_CHANGES despite approving personas (1) >= minApprovals (1)
    expect(blockedMatch.decision).toBe('REQUEST_CHANGES');
  });

  test('5. Nit-only filtering across all personas - nits are excluded from activeFindings and do not block approval', () => {
    const nitOnlyInput: QuorumEvaluationInput = {
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings: {
        security: [
          {
            persona: 'security',
            severity: 'nit',
            filePath: 'src/a.ts',
            lineNumber: 1,
            comment: 'Nit 1',
            codeSnippet: 'let a = 1;',
          },
          {
            persona: 'security',
            severity: 'nit',
            filePath: 'src/a.ts',
            lineNumber: 2,
            comment: 'Nit 2',
            codeSnippet: 'let b = 2;',
          },
        ],
        architecture: [
          {
            persona: 'architecture',
            severity: 'nit',
            filePath: 'src/b.ts',
            lineNumber: 5,
            comment: 'Nit 3',
            codeSnippet: 'let c = 3;',
          },
        ],
        performance: [],
        quality: [
          {
            persona: 'quality',
            severity: 'nit',
            filePath: 'src/c.ts',
            lineNumber: 9,
            comment: 'Nit 4',
            codeSnippet: 'let d = 4;',
          },
        ],
      },
    };

    const result = evaluateQuorum(nitOnlyInput);

    expect(result.filteredNits).toHaveLength(4);
    expect(result.activeFindings).toHaveLength(0);
    expect(result.requestingChangesPersonas).toHaveLength(0);
    expect(result.approvingPersonas).toHaveLength(4);
    expect(result.decision).toBe('APPROVE');
  });

  test('6. Minor findings classification - minor findings enter activeFindings but do not trigger REQUEST_CHANGES', () => {
    const minorFindingsInput: QuorumEvaluationInput = {
      minApprovals: 2,
      configuredPersonas: ['security', 'architecture', 'performance', 'quality'],
      personaFindings: {
        performance: [
          {
            persona: 'performance',
            severity: 'minor',
            filePath: 'src/perf.ts',
            lineNumber: 15,
            comment: 'Consider string builder optimization',
            codeSnippet: 'str += "a";',
          },
        ],
      },
    };

    const result = evaluateQuorum(minorFindingsInput);

    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0].severity).toBe('minor');
    expect(result.requestingChangesPersonas).toHaveLength(0);
    expect(result.approvingPersonas).toHaveLength(4);
    expect(result.decision).toBe('APPROVE');
  });
});
