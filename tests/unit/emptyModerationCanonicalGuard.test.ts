import { describe, expect, it, vi } from 'vitest';

/**
 * REL-1139: defense in depth. On an eligible run the canonical arbitration is always SHIP, so the
 * trusted side's "canonical verdict is not SHIP" refusal is only reachable if the shared decision
 * and the arbitration ever diverge. Force that divergence to pin the guard.
 */
vi.mock('../../src/review/reviewAdapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/reviewAdapters')>();
  return {
    ...actual,
    computeAppVerdict: (options: Parameters<typeof actual.computeAppVerdict>[0]) => ({
      ...actual.computeAppVerdict(options),
      verdict: 'BLOCK',
    }),
  };
});

vi.resetModules();
const { deriveCanonicalWorkerReviewEvidence } = await import('../../src/review/workerReviewCompletion');

const coordinates = {
  runId: `run_${'a'.repeat(32)}`, repositoryId: 3210, owner: 'calltelemetry', repo: 'review-yeti-bot', prNumber: 42,
  headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), executionAttempt: 2,
} as const;

describe('trusted skip claim with a non-SHIP canonical verdict (REL-1139)', () => {
  it('is refused even though the shared decision is eligible', () => {
    const derived = deriveCanonicalWorkerReviewEvidence({
      version: 'WorkerReviewCompletion.v1', ...coordinates,
      result: {
        version: 'WorkerReviewResult.v1', completedAt: '2026-09-26T12:00:00.000Z',
        personas: [{ id: 'security', decision: 'APPROVE', findings: [] }],
        coverageComplete: true, quorumSatisfied: true, moderation: 'skipped-empty',
      },
    }, {
      expectedCoordinates: coordinates, expectedPersonaIds: ['security'],
      changedFiles: [{ path: 'src/example.ts', patch: '@@ -1,0 +1 @@\n+const first = 1;\n' }],
      coverageComplete: true, quorumSatisfied: true,
      emptyModeration: { truncatedFiles: 0, unavailablePatches: 0, omittedSourcePaths: 0, routedFiles: 0, uncoveredPaths: 0 },
    });
    expect(derived.valid).toBe(false);
    if (!derived.valid) expect(derived.message).toMatch(/canonical verdict is BLOCK/u);
  });
});
