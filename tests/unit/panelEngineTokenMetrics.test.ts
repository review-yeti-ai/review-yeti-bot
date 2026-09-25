import { afterEach, describe, it, expect, vi } from 'vitest';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, ctReviewConfigV3Schema } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { getMetrics } from '../../src/telemetry';

/**
 * REL-1132: `review_yeti_tokens_*_total` must sum every real provider call -- every turn of every
 * lane, the moderator and the arbiter -- not each role's terminal turn. Before this change the
 * counters were fed once per role from its final response, so the three-turn lane below reported
 * 230 tokens instead of 525 and the worker metric ran about 2.7x under Bifrost.
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


afterEach(() => {
  vi.restoreAllMocks();
});

describe('panelEngine.ts -- worker token counters count every provider call (REL-1132)', () => {
  it('adds every lane turn, the moderator and the arbiter to review_yeti_tokens_total', async () => {
    const metrics = getMetrics();
    const totalAdd = vi.spyOn(metrics.tokensTotal, 'add');
    const promptAdd = vi.spyOn(metrics.tokensPrompt, 'add');
    const costAdd = vi.spyOn(metrics.modelCostUsd, 'add');
    const attempts = new Map<string, number>();

    const mockClient = {
      complete: vi.fn(async (opts: any) => {
        const nonce = nonceFrom(opts);
        if (opts.metadata.role === 'moderator') {
          return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: { prompt: 40, completion: 10, total: 50 }, costUSD: 0.0005, raw: {} };
        }
        if (opts.metadata.role === 'arbiter') {
          return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'clean' }), usage: { prompt: 30, completion: 5, total: 35 }, costUSD: 0.0004, raw: {} };
        }
        const attempt = (attempts.get(opts.persona) || 0) + 1;
        attempts.set(opts.persona, attempt);
        if (attempt === 1) {
          return { model: opts.model, content: JSON.stringify({ tool: 'read_file', args: { path: 'src/security/auth.ts' } }), usage: { prompt: 100, completion: 20, total: 120 }, costUSD: 0.001, raw: {} };
        }
        if (attempt === 2) {
          return { model: opts.model, content: 'not a native JSON result and not a tool call either', usage: { prompt: 150, completion: 25, total: 175 }, costUSD: 0.0012, raw: {} };
        }
        return { model: opts.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: { prompt: 200, completion: 30, total: 230 }, costUSD: 0.002, raw: {} };
      }),
    };

    const result = await executePersonaPanel({
      config: buildTelemetryConfig(3),
      changedFiles: CHANGED_FILES,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-token-metrics',
      client: mockClient as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_schema' } },
    });
    expect(result.personas.find((lane) => lane.id === 'telemetry-lane')?.turnsCount).toBe(3);

    const sumFor = (spy: typeof totalAdd, persona: string) => spy.mock.calls
      .filter(([, labels]) => (labels as Record<string, string>)?.persona === persona)
      .reduce((sum, [value]) => sum + Number(value), 0);

    // Every lane turn: 120 + 175 + 230, not the terminal 230.
    expect(sumFor(totalAdd, 'telemetry-lane')).toBe(525);
    expect(sumFor(promptAdd, 'telemetry-lane')).toBe(450);
    expect(sumFor(costAdd, 'telemetry-lane')).toBeCloseTo(0.0042, 10);
    expect(sumFor(totalAdd, 'moderator')).toBe(50);
    expect(sumFor(totalAdd, 'arbiter')).toBe(35);
    // Each provider call is counted exactly once: 3 lane turns + moderator + arbiter.
    expect(totalAdd.mock.calls.filter(([, labels]) => ['telemetry-lane', 'moderator', 'arbiter']
      .includes((labels as Record<string, string>)?.persona))).toHaveLength(5);
    expect(totalAdd.mock.calls.every(([, labels]) => (labels as Record<string, string>)?.provider === 'claude')).toBe(true);
  });
});
