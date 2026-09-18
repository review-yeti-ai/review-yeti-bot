import { describe, it, expect, vi } from 'vitest';
import { ctReviewConfigV3Schema, type CtReviewConfigV3 } from '../../src/config/schema';
import type { OmniRouteClient } from '../../src/gateway/omniRouteClient';

/**
 * The fourth `panelWallClockMs` return site: fast-ship. The other three (main, zero-lane,
 * gated-not-applicable) are covered in `panelEngineTelemetryAccumulation.test.ts`.
 *
 * Two things make this path awkward to reach, and both are worth recording because an earlier
 * attempt silently hit a DIFFERENT short-circuit and looked like a mocking failure:
 *
 *  1. `classifyReviewScope` must be replaced at module load. An ESM namespace is frozen, so
 *     `vi.spyOn` on it does not intercept; this needs a `vi.mock` factory. `importOriginal` keeps
 *     the rest of `classifierEngine` real, because `panelEngine` imports several other helpers
 *     from it and a blanket mock breaks them.
 *  2. The classifier only runs when `shouldClassify` is true, which for a required persona means
 *     `containsExecutableOrSensitiveCode` must be FALSE. That heuristic flags a path containing
 *     `security` -- so a fixture like `src/security/notes.md` is "sensitive" despite being a .md,
 *     the classifier never runs, and the panel falls through to the gated-not-applicable return.
 *     `content/guide.md` is genuinely non-sensitive (verified against the heuristic directly).
 *
 * Fast-ship is the path where a missing wall clock is least likely to be noticed: it
 * short-circuits the entire panel, so no lane reports any time at all.
 */
vi.mock('../../src/panel/classifierEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/panel/classifierEngine')>();
  return {
    ...actual,
    classifyReviewScope: vi.fn().mockResolvedValue({
      fastShip: true,
      selectedPersonas: [],
      effortTier: 'low',
      rationale: 'docs-only change',
      model: 'fast-ship-classifier',
      providerId: 'claude',
    }),
  };
});

function config(): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    version: 3, profile: 'assertive', quorum: 1,
    personas: [{
      id: 'content-lane', enabled: true, required: true, charter: 'builtin:security',
      paths: ['content/**'], providers: ['claude'], maxTurns: 2,
    }],
    reviewers: {
      execution: 'personas', fallback: 'none', overall_timeout_s: 120,
      providers: [{ id: 'claude', enabled: true, model: 'c', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 }],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [], rules: [], reviewer_effort: 'high',
    confidence_threshold: 70, mascot: true, display: { mascot: true },
  });
}

describe('panelWallClockMs on the fast-ship return', () => {
  it('is recorded, and bounded by the interval around the call', async () => {
    const { executePersonaPanel } = await import('../../src/panel/panelEngine');
    const client = { complete: vi.fn() };

    const outerStart = Date.now();
    const result = await executePersonaPanel({
      config: config(),
      changedFiles: [{ path: 'content/guide.md', patch: '+ a docs line' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-fast-ship',
      client: client as unknown as OmniRouteClient,
    });
    const outerWallMs = Date.now() - outerStart;

    // Proves this is the fast-ship path specifically, not one of the other short-circuits:
    // no persona lane ran, and the result carries the fast-ship classifier's identity.
    expect(client.complete).not.toHaveBeenCalled();
    expect(result.personas.some((p) => p.model === 'fast-ship-classifier')).toBe(true);

    expect(typeof result.panelWallClockMs).toBe('number');
    expect(result.panelWallClockMs!).toBeGreaterThanOrEqual(0);
    // Same containment invariant as the other three sites: a panel-internal interval cannot
    // exceed the interval measured around the call. Catches a wrong baseline, not just absence.
    expect(result.panelWallClockMs!).toBeLessThanOrEqual(outerWallMs);
  });
});
