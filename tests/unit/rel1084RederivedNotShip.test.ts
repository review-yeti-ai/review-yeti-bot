import { describe, expect, it, vi } from 'vitest';

/**
 * REL-1084: `rederived-not-ship` is defense in depth. Every input that makes the re-derived
 * verdict non-SHIP is refused by an earlier check, so the only way to reach it is an arbitration
 * that disagrees with the gate record. Pin that it still refuses, with its own code.
 */
vi.mock('../../src/review/reviewAdapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/reviewAdapters')>();
  return {
    ...actual,
    computeAppVerdict: (options: Parameters<typeof actual.computeAppVerdict>[0]) => ({
      ...actual.computeAppVerdict(options), verdict: 'FIX_FIRST',
    }),
  };
});

describe('stored prior re-derivation', () => {
  it('refuses a prior whose re-derived verdict is not SHIP even when every other check passes', async () => {
    vi.resetModules();
    const { storedCompletionShipCompleteReason } = await import('../../src/review/workerReviewCompletion');
    const result = {
      version: 'WorkerReviewResult.v1' as const, completedAt: '2026-09-24T10:00:00.000Z',
      personas: [{ id: 'sec-lane', decision: 'APPROVE' as const, status: 'COMPLETE' as const, findings: [] }],
      coverageComplete: true, quorumSatisfied: true,
    };
    const gate = {
      worker_result_digest: 'a'.repeat(64),
      evidence: { verdict: 'SHIP', completedAt: '2026-09-24T10:00:01.000Z', coverageComplete: true, quorumSatisfied: true,
        infrastructureFailure: false, p0Count: 0, p1Count: 0, expectedLanes: 1, completedLanes: 1 },
      decision: { status: 'success', eligible: true, reason: 'clean-review' },
    };
    expect(storedCompletionShipCompleteReason(result, gate, 'a'.repeat(64))).toBe('rederived-not-ship');
  });
});
