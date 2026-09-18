import { describe, it, expect, vi } from 'vitest';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, ctReviewConfigV3Schema } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

/**
 * Every provider call `invoke()` makes inside a persona's turn loop -- a tool-exploration turn, a
 * bounded structured-output correction, or the terminal turn -- must be counted and its usage
 * accumulated. Before this change, `invoke()` returned only the LAST turn's `response`, and
 * `turnsCount` incremented only inside the tool-call branch, so a lane that made several real
 * provider calls without ever requesting a tool reported `turnsCount: 1` and every token/cost
 * figure reflected only its final call. See `src/panel/panelEngine.ts` `invoke()` and `runPersona`.
 */

function buildTelemetryConfig(maxTurns: number, personaId = 'telemetry-lane'): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    version: 3,
    profile: 'assertive',
    quorum: 1,
    personas: [
      {
        id: personaId,
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/security/**'],
        providers: ['claude'],
        maxTurns,
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: 120,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  });
}

const CHANGED_FILES = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];

function nonceFrom(opts: any): string {
  const prompt = extractMessageContentText(opts.messages[1].content);
  return prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
}

describe('panelEngine.ts — per-turn telemetry accumulation', () => {
  it('accumulates promptTokens, completionTokens, cachedTokens, costUSD, model, and kind across every real turn, not just the terminal one', async () => {
    const config = buildTelemetryConfig(3);
    const attempts = new Map<string, number>();

    const mockClient = {
      complete: vi.fn(async (opts: any) => {
        const nonce = nonceFrom(opts);
        if (opts.metadata.role !== 'persona') {
          const body = opts.metadata.role === 'arbiter'
            ? { verdict: 'SHIP', rationale: 'clean' }
            : { decision: 'RECONCILED', findings: [] };
          return { model: opts.model, content: JSON.stringify({ nonce, ...body }), usage: null, costUSD: null, raw: {} };
        }
        const key = `${opts.metadata.role}:${opts.persona}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);

        if (attempt === 1) {
          // Turn 1: requests a read-only tool. Nested `args` -- exercised through the native
          // envelope parser (`parseNativeToolCall`), which is the production Bifrost contract.
          return {
            model: opts.model,
            content: JSON.stringify({ tool: 'read_file', args: { path: 'src/security/auth.ts' } }),
            usage: { prompt: 100, completion: 20, total: 120, cached_tokens: 30 },
            costUSD: 0.001,
            raw: {},
          };
        }
        if (attempt === 2) {
          // Turn 2: neither a valid native result nor a tool envelope -- triggers one bounded
          // correction.
          return {
            model: opts.model,
            content: 'not a native JSON result and not a tool call either',
            usage: { prompt: 150, completion: 25, total: 175 },
            costUSD: 0.0012,
            raw: {},
          };
        }
        // Turn 3: the terminal, successful turn.
        return {
          model: opts.model,
          content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }),
          usage: { prompt: 200, completion: 30, total: 230, cached_tokens: 50 },
          costUSD: 0.002,
          raw: {},
        };
      }),
    };

    const result = await executePersonaPanel({
      config,
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-telemetry-accumulation',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });

    const lane = result.personas.find((persona) => persona.id === 'telemetry-lane');
    expect(lane).toBeDefined();

    // The turnsCount fix: three real provider calls were made (tool, correction, final), not one.
    expect(lane!.turnsCount).toBe(3);
    expect(lane!.toolTurns).toBe(1);
    expect(lane!.correctionTurns).toBe(1);

    expect(lane!.turnUsages).toHaveLength(3);
    expect(lane!.turnUsages!.map((t) => t.kind)).toEqual(['tool', 'correction', 'final']);
    expect(lane!.turnUsages!.map((t) => t.turn)).toEqual([1, 2, 3]);

    expect(lane!.turnUsages![0]).toMatchObject({
      promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 30,
      costUSD: 0.001, model: 'claude-5-sonnet',
    });
    expect(lane!.turnUsages![1]).toMatchObject({
      promptTokens: 150, completionTokens: 25, totalTokens: 175, cachedTokens: 0,
      costUSD: 0.0012, model: 'claude-5-sonnet',
    });
    expect(lane!.turnUsages![2]).toMatchObject({
      promptTokens: 200, completionTokens: 30, totalTokens: 230, cachedTokens: 50,
      costUSD: 0.002, model: 'claude-5-sonnet',
    });

    // aggregateUsage is the SUM across every turn -- this is the number that was previously
    // unavailable anywhere: only the last turn (200/30/230/50 cached) was ever visible.
    expect(lane!.aggregateUsage).toEqual({
      promptTokens: 450, completionTokens: 75, totalTokens: 525, cachedTokens: 80,
      costUSD: expect.closeTo(0.0042, 6),
    });

    // The single-turn fields the rest of the codebase already reads must still reflect only the
    // FINAL turn -- the contract said "do not change the existing `response` field's meaning".
    expect(lane!.promptTokens).toBe(200);
    expect(lane!.completionTokens).toBe(30);
    expect(lane!.totalTokens).toBe(230);
  });

  it('counts a correction-only lane\'s real turns even though it never calls a tool (turnsCount regression)', async () => {
    // Counterfactual: before this fix, `turnsCount` started at 1 and only incremented inside the
    // tool-call branch. A lane that spends a turn on a structured-output correction and never
    // requests a tool made 2 real provider calls but reported turnsCount=1. Reverting the fix
    // (removing the top-of-loop `turnsCount++` and restoring the old tool-call-only increment)
    // makes this assertion fail: `lane.turnsCount` reads back 1 instead of 2.
    //
    // `invoke()` has two, separately coded correction sites (see the sibling test below for the
    // other one): this one is the `catch (fenceErr)` site -- content that is neither a valid
    // fenced/native result NOR a tool call, reached only after both parses have already failed.
    // The turn 1 content below is deliberately not valid JSON at all, so it can only reach this
    // site, never the other one.
    const config = buildTelemetryConfig(2, 'correction-only-lane');
    const attempts = new Map<string, number>();

    const mockClient = {
      complete: vi.fn(async (opts: any) => {
        const nonce = nonceFrom(opts);
        if (opts.metadata.role !== 'persona') {
          return {
            model: opts.model,
            content: opts.metadata.role === 'arbiter'
              ? `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'clean' })}\nCT_REVIEW_END:${nonce}`
              : `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: null,
            costUSD: null,
            raw: {},
          };
        }
        const key = `${opts.metadata.role}:${opts.persona}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);

        if (attempt === 1) {
          return { model: opts.model, content: 'malformed, not fenced, not a tool call', usage: { prompt: 10, completion: 5, total: 15 }, costUSD: 0.0001, raw: {} };
        }
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 20, completion: 10, total: 30 },
          costUSD: 0.0002,
          raw: {},
        };
      }),
    };

    const result = await executePersonaPanel({
      config,
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-correction-only-turns',
      client: mockClient as unknown as OmniRouteClient,
    });

    const lane = result.personas.find((persona) => persona.id === 'correction-only-lane');
    expect(lane).toBeDefined();
    expect(lane!.turnsCount).toBe(2);
    expect(lane!.toolTurns).toBe(0);
    expect(lane!.correctionTurns).toBe(1);
    expect(lane!.turnUsages).toHaveLength(2);
  });

  it('counts a correction turn reached through the OTHER correction site: a validly-parsed but contract-violating result', async () => {
    // The second, distinct correction site in `invoke()`: the turn's content parses successfully
    // as JSON matching the nonce (`structuredOutputContractError` passes -- `decision` is a valid
    // enum member and `findings` is an array), but `validateParsed` rejects it on the PERSONA
    // decision contract (`personaDecisionContractError`): `APPROVE` carrying a non-empty
    // `findings` array is contradictory. This never reaches the `catch (fenceErr)` block the
    // sibling test above exercises -- parsing did not fail -- so it can only prove the OTHER site
    // (the `if (!contractError) {...} ... structuredCorrectionAttempts += 1` block) sets
    // `correctionTurns`/`kind` correctly. Deleting the counter increment or the `kind =
    // 'correction'` downgrade at THIS site specifically (while leaving the other site untouched)
    // would leave the sibling test green and only this one red.
    const config = buildTelemetryConfig(2, 'contract-correction-lane');
    const attempts = new Map<string, number>();

    const mockClient = {
      complete: vi.fn(async (opts: any) => {
        const nonce = nonceFrom(opts);
        if (opts.metadata.role !== 'persona') {
          return {
            model: opts.model,
            content: opts.metadata.role === 'arbiter'
              ? `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'clean' })}\nCT_REVIEW_END:${nonce}`
              : `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: null,
            costUSD: null,
            raw: {},
          };
        }
        const key = `${opts.metadata.role}:${opts.persona}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);

        if (attempt === 1) {
          // Valid JSON, valid nonce fence, valid `decision` enum member, `findings` is an array --
          // parses cleanly. Only the PERSONA-specific decision/findings contradiction is wrong:
          // APPROVE must carry zero findings.
          const contradictory = {
            decision: 'APPROVE',
            findings: [{ severity: 'P1', path: 'src/security/auth.ts', line: 1, title: 'x', body: 'y' }],
          };
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(contradictory)}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 40, completion: 8, total: 48 },
            costUSD: 0.0003,
            raw: {},
          };
        }
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 20, completion: 10, total: 30 },
          costUSD: 0.0002,
          raw: {},
        };
      }),
    };

    const result = await executePersonaPanel({
      config,
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-contract-correction-turns',
      client: mockClient as unknown as OmniRouteClient,
    });

    const lane = result.personas.find((persona) => persona.id === 'contract-correction-lane');
    expect(lane).toBeDefined();
    expect(lane!.turnsCount).toBe(2);
    expect(lane!.toolTurns).toBe(0);
    expect(lane!.correctionTurns).toBe(1);
    expect(lane!.turnUsages).toHaveLength(2);
    expect(lane!.turnUsages!.map((t) => t.kind)).toEqual(['correction', 'final']);
  });

  it('records panelWallClockMs distinct from the SUM of concurrent lane durations', async () => {
    // Two personas that each match the changed file run concurrently (MAX_CONCURRENT_PERSONAS=4).
    // If panelWallClockMs simply summed the lanes' durations (the publishing-layer bug this
    // measurement work exists to make visible), it would be >= 2x a single lane's delay. The real
    // wall clock should be well under that, since both lanes were in flight at once.
    //
    // Concurrency itself is proven BY CONSTRUCTION below (`maxObservedConcurrency`, the same
    // pattern `panelEngineParallel.test.ts` uses), not by elapsed time -- that assertion cannot
    // flake regardless of runner load. The VALUE of `panelWallClockMs` still has to be checked
    // against real elapsed time, though, since that is what it measures. `DELAY_MS` is set an
    // order of magnitude above typical GC/parse jitter (a few ms to a few tens of ms) so that
    // noise cannot meaningfully move the ratio, and the ratio itself is compared against
    // `summedLaneDurationMs` -- a value measured in this SAME contended run, not a fixed
    // `timeBudgetMs`-style idle-time constant -- so a slow runner inflates both sides together
    // instead of eating the margin on only one side.
    const config = ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 1,
      personas: [
        { id: 'lane-a', enabled: true, required: true, charter: 'builtin:security', paths: ['src/**'], providers: ['claude'], maxTurns: 1 },
        { id: 'lane-b', enabled: true, required: true, charter: 'builtin:correctness', paths: ['src/**'], providers: ['claude'], maxTurns: 1 },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
      path_instructions: [],
      rules: [],
      reviewer_effort: 'high',
      confidence_threshold: 70,
      mascot: true,
      display: { mascot: true },
    });

    // An order of magnitude above the few ms to few tens of ms of GC/parse jitter that could
    // otherwise eat a thin margin -- see the comment above.
    const DELAY_MS = 300;
    let activeConcurrentCalls = 0;
    let maxObservedConcurrency = 0;
    const mockClient = {
      complete: vi.fn(async (opts: any) => {
        const nonce = nonceFrom(opts);
        if (opts.metadata.role === 'persona') {
          activeConcurrentCalls++;
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeConcurrentCalls);
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          activeConcurrentCalls--;
        }
        const body = opts.metadata.role === 'arbiter'
          ? { verdict: 'SHIP', rationale: 'clean' }
          : opts.metadata.role === 'moderator'
            ? { decision: 'RECONCILED', findings: [] }
            : { decision: 'APPROVE', findings: [] };
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0.00001,
          raw: {},
        };
      }),
    };

    // Measured AROUND the call, so it is a strict superset of anything the panel can measure
    // internally. This is what makes the assertion below an invariant rather than a tuned margin.
    const observedOuterWallMs0 = Date.now();
    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/service.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-wall-clock',
      client: mockClient as unknown as OmniRouteClient,
    });
    const observedOuterWallMs = Date.now() - observedOuterWallMs0;

    // Proof BY CONSTRUCTION that both persona calls were genuinely in flight at once -- not
    // inferred from timing. If a future change accidentally serialized the fan-out, this fails
    // regardless of how generous the timing margins below are.
    expect(maxObservedConcurrency).toBe(2);

    expect(result.personas).toHaveLength(2);
    const summedLaneDurationMs = result.personas.reduce((sum, p) => sum + p.durationMs, 0);
    expect(summedLaneDurationMs).toBeGreaterThanOrEqual(DELAY_MS * 2 - 5);

    expect(typeof result.panelWallClockMs).toBe('number');
    // The flake-proof invariant: always true for a correct implementation, contention or not.
    // Alone it does NOT catch a `panelWallClockMs = summedLaneDurationMs` mutation (equality
    // still satisfies `<=`) -- that is what the ratio assertion below is for.
    expect(result.panelWallClockMs!).toBeGreaterThan(0);
    expect(result.panelWallClockMs!).toBeLessThanOrEqual(summedLaneDurationMs);
    // What catches a `panelWallClockMs = summedLaneDurationMs` mutation is CONTAINMENT, not a
    // tuned ratio. `panelWallClockMs` is measured inside `executePersonaPanel`; `observedOuterWallMs`
    // is measured around the call. An inner interval can never exceed the outer interval that
    // encloses it -- that holds on any runner, at any load, with no threshold to tune. The summed
    // lane durations are NOT so bounded: with two lanes genuinely in flight at once the sum counts
    // the overlapped time twice, so the mutated value exceeds the real elapsed time and this fails.
    //
    // A previous revision asserted `< summedLaneDurationMs * 0.7`. That was flagged (correctly) as
    // a flake vector: `maxObservedConcurrency` proves the lanes STARTED together but not that they
    // overlapped substantially, so on a contended runner a correct implementation could drift past
    // the ratio. Widening the ratio only moves the cliff; containment removes it.
    expect(result.panelWallClockMs!).toBeLessThanOrEqual(observedOuterWallMs);
  });
});

/**
 * `panelWallClockMs` is set at THREE return sites in `executePersonaPanel`: the main result, the
 * zero-lane non-evidence early return, and the fast-ship early return. Only the main one was
 * exercised, so deleting the field from either early return -- or computing it from the wrong
 * baseline -- left every test green while those paths silently reported no wall clock. Both early
 * returns are short-circuits that skip the persona fan-out entirely, which is exactly when a
 * "how long did this review actually take" number is easiest to lose and hardest to notice.
 */
describe('panelWallClockMs on early-return paths', () => {
  const silentClient = { complete: vi.fn() };

  it('is recorded when every applicable persona is gated not-applicable', async () => {
    // A fourth short-circuit, found by accident while trying to reach fast-ship: every applicable
    // persona gates itself not-applicable, so the fan-out is skipped and a full PanelResult is
    // returned with no provider call. It was missing `panelWallClockMs` entirely -- the review
    // named the zero-lane and fast-ship returns, not this one.
    const config = buildTelemetryConfig(3);
    const outerStart = Date.now();
    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/security/notes.md', patch: '+ a docs line' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-gated',
      client: silentClient as unknown as OmniRouteClient,
    });
    const outerWallMs = Date.now() - outerStart;

    expect(silentClient.complete).not.toHaveBeenCalled();
    expect(typeof result.panelWallClockMs).toBe('number');
    expect(result.panelWallClockMs!).toBeGreaterThanOrEqual(0);
    expect(result.panelWallClockMs!).toBeLessThanOrEqual(outerWallMs);
  });

  it('is recorded on the zero-lane non-evidence return', async () => {
    const config = buildTelemetryConfig(3);
    const outerStart = Date.now();
    const result = await executePersonaPanel({
      config,
      // Matches no persona path, and is documentation -- the zero-lane non-evidence contract.
      changedFiles: [{ path: 'docs/readme.md', patch: '+ a docs line' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-zero-lane',
      client: silentClient as unknown as OmniRouteClient,
    });
    const outerWallMs = Date.now() - outerStart;

    expect(result.zeroLaneNonEvidence).toBe(true);
    expect(result.personas).toHaveLength(0);
    expect(typeof result.panelWallClockMs).toBe('number');
    expect(result.panelWallClockMs!).toBeGreaterThanOrEqual(0);
    // Same containment invariant as the main-path test: a panel-internal interval cannot exceed
    // the interval measured around the call. Catches a wrong baseline, not just a missing field.
    expect(result.panelWallClockMs!).toBeLessThanOrEqual(outerWallMs);
    expect(silentClient.complete).not.toHaveBeenCalled();
  });
});
