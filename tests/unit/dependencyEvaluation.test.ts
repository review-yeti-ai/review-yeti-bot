import { describe, expect, it } from 'vitest';

describe('dependency investigation evaluation', () => {
  it('passes the deterministic baseline-versus-candidate contract matrix', async () => {
    const { evaluateDependencyMatrix } = await import('../../scripts/evaluate-dependency-investigation.mjs');
    const fixture = (await import('../../tests/fixtures/dependency-evaluation.json')).default;
    const result = evaluateDependencyMatrix(fixture);

    expect(result).toMatchObject({
      status: 'pass',
      promotionReady: false,
      fixtureCount: 16,
      repetitions: 3,
      deterministicGates: {
        noUnsafeShipOnBoundaries: true,
        recallImprovement: true,
        validEvidenceRequests: true,
        postEvidenceDecisions: true,
        cleanFalsePositives: true,
      },
    });
    expect(result.candidate.unsafeShipRate).toBe(0);
    expect(result.candidate.faultRecall).toBeGreaterThan(result.baseline.faultRecall);
  });
});
