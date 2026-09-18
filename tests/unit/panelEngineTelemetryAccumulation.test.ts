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

  it('records panelWallClockMs distinct from the SUM of concurrent lane durations', async () => {
    // Two personas that each match the changed file run concurrently (MAX_CONCURRENT_PERSONAS=4).
    // If panelWallClockMs simply summed the lanes' durations (the publishing-layer bug this
    // measurement work exists to make visible), it would be >= 2x a single lane's delay. The real
    // wall clock should be well under that, since both lanes were in flight at once.
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

    const DELAY_MS = 60;
    const mockClient = {
      complete: vi.fn(async (opts: any) => {
        const nonce = nonceFrom(opts);
        if (opts.metadata.role === 'persona') {
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
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

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/service.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-wall-clock',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(2);
    const summedLaneDurationMs = result.personas.reduce((sum, p) => sum + p.durationMs, 0);
    expect(summedLaneDurationMs).toBeGreaterThanOrEqual(DELAY_MS * 2 - 5);

    expect(typeof result.panelWallClockMs).toBe('number');
    expect(result.panelWallClockMs!).toBeGreaterThan(0);
    // Deliberately NOT compared against a fixed idle-time constant (e.g. via `timeBudgetMs`): a
    // real concurrent/serial gap is only a ~2x effect here, well inside `timeBudgetMs`'s up-to-4x
    // contention allowance, so that style of assertion cannot distinguish the fix from a mutation
    // that sets `panelWallClockMs` to the summed lane durations (confirmed by mutation testing --
    // see the Stage 0 PR description). Comparing against `summedLaneDurationMs` instead -- a value
    // measured in this same contended run -- self-corrects for contention: if the whole run is
    // slowed down by scheduling pressure, both numbers scale together, but a truly concurrent wall
    // clock stays close to a SINGLE lane's duration (well under the two-lane sum) regardless of
    // how much everything is slowed down, while the summed value never does.
    expect(result.panelWallClockMs!).toBeLessThan(summedLaneDurationMs * 0.8);
  });
});
