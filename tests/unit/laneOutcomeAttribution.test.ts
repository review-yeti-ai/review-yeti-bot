import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  flushMetrics,
  getPrometheusMetrics,
  getMetrics,
  initMetrics,
  resolveOtlpMetricsEndpoint,
} from '../../src/telemetry/metrics';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { CtReviewConfigV3, ctReviewConfigV3Schema } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { OpenRouterResponseError } from '../../src/gateway/openRouterClient';

function metricLines(text: string, name: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));
}

function readOutcome(text: string, labels: { persona: string; outcome: string; failure_class?: string; transport?: string }): number {
  const { persona, outcome } = labels;
  const matches = metricLines(text, 'review_yeti_lane_outcome_total').filter((line) =>
    line.includes(`persona="${persona}"`) &&
    line.includes(`outcome="${outcome}"`) &&
    (labels.failure_class === undefined || line.includes(`failure_class="${labels.failure_class}"`)) &&
    (labels.transport === undefined || line.includes(`transport="${labels.transport}"`)),
  );
  if (matches.length === 0) return 0;
  const value = matches[0].split('}')[1] ?? matches[0].split(' ')[1];
  return Number(value);
}

describe('REL-904 lane/provider attribution telemetry', () => {
  beforeEach(() => {
    delete process.env.REVIEW_YETI_OTEL_METRICS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  });

  afterEach(() => {
    delete process.env.REVIEW_YETI_OTEL_METRICS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    vi.restoreAllMocks();
  });

  it('resolves the OTLP endpoint from the worker env with explicit precedence', () => {
    expect(resolveOtlpMetricsEndpoint({ NODE_ENV: 'test' })).toBeNull();
    expect(resolveOtlpMetricsEndpoint({ NODE_ENV: 'test', REVIEW_YETI_OTEL_METRICS_ENDPOINT: 'http://otel:4318/v1/metrics' }))
      .toBe('http://otel:4318/v1/metrics');
    expect(
      resolveOtlpMetricsEndpoint({
        NODE_ENV: 'test',
        REVIEW_YETI_OTEL_METRICS_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://fallback:4318/v1/metrics',
      }),
    ).toBe('http://fallback:4318/v1/metrics');
  });

  it('flushMetrics is a no-op that resolves before any endpoint exists', async () => {
    await expect(flushMetrics(50)).resolves.toBeUndefined();
  });

  it('exposes the lane outcome counter in the Prometheus exposition', async () => {
    initMetrics({ NODE_ENV: 'test' });
    const metrics = getMetrics();
    metrics.laneOutcomes.add(1, { persona: 'architect', outcome: 'completed', failure_class: '', transport: 'bifrost' });
    metrics.laneOutcomes.add(1, { persona: 'security', outcome: 'failed', failure_class: 'rate_limit', transport: 'unknown' });
    const text = await getPrometheusMetrics();
    expect(readOutcome(text, { persona: 'architect', outcome: 'completed', transport: 'bifrost' })).toBe(1);
    expect(readOutcome(text, { persona: 'security', outcome: 'failed', failure_class: 'rate_limit' })).toBe(1);
    expect(text).toContain('# TYPE review_yeti_lane_outcome_total counter');
  });

  it('keeps the failure class vocabulary closed to workerFailureClasses', async () => {
    const { workerFailureClasses } = await import('../../src/types/workerFailure');
    expect(workerFailureClasses).toEqual([
      'contract',
      'timeout',
      'budget_exhausted',
      'auth',
      'rate_limit',
      'transport',
      'provider_error',
      'malformed_output',
      'internal_error',
    ]);
  });
});

/**
 * REL-904 P1 remediation: prove the lane-outcome emission sites inside
 * panelEngine are live by driving executePersonaPanel itself. Removing the
 * laneOutcomes.add calls from panelEngine must fail these tests, not just the
 * direct counter assertions above.
 */
describe('lane outcome emission inside panelEngine (P1: verified through the engine)', () => {
  function panelConfig(): CtReviewConfigV3 {
    return ctReviewConfigV3Schema.parse({
      version: 3,
      profile: 'assertive',
      quorum: 2,
      personas: [
        {
          id: 'sec-lane',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['src/security/**'],
          providers: ['claude'],
        },
        {
          id: 'correct-lane',
          enabled: true,
          required: true,
          charter: 'builtin:correctness',
          paths: ['src/security/**'],
          providers: ['codex'],
        },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'ordered',
        overall_timeout_s: 120,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
          { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude', 'codex'] },
      },
      path_instructions: [],
      rules: [],
      reviewer_effort: 'high',
      confidence_threshold: 70,
      mascot: true,
    });
  }

  function nonceAware(implementation: (prompt: string, ctx: { nonce: string; model: unknown }) => unknown) {
    return async (opts: any) => {
      const prompt = extractMessageContentText(opts.messages[1].content);
      const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1]?.trim() ?? 'test-nonce';
      return implementation(prompt, { nonce, model: opts.model });
    };
  }

  it('records outcome=completed with the winning transport when lanes finish cleanly', async () => {
    initMetrics({ NODE_ENV: 'test' });
    const mockClient = { complete: vi.fn() };
    mockClient.complete.mockImplementation(
      nonceAware((prompt: string, { nonce }) => {
        if (prompt.includes('Role: ARBITER')) {
          return {
            model: 'claude-5-sonnet',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'clean' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 15, completion: 15, total: 30 },
            costUSD: 0.0002,
          };
        }
        if (prompt.includes('Role: MODERATOR')) {
          return {
            model: 'claude-5-sonnet',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
          };
        }
        return {
          model: 'claude-5-sonnet',
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0.00005,
        };
      }),
    );

    await executePersonaPanel({
      config: panelConfig(),
      changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-rel904',
      client: mockClient as unknown as OmniRouteClient,
    });

    const text = await getPrometheusMetrics();
    const completed = metricLines(text, 'review_yeti_lane_outcome_total')
      .filter((line) => line.includes('outcome="completed"'));
    expect(completed.length).toBeGreaterThanOrEqual(2);
  });

  it('records outcome=failed with the coded failure class when a required lane fails closed', async () => {
    initMetrics({ NODE_ENV: 'test' });
    const mockClient = { complete: vi.fn() };
    mockClient.complete.mockImplementation(async () => {
      throw new OpenRouterResponseError('unauthorized', 401);
    });

    await expect(
      executePersonaPanel({
        config: panelConfig(),
        changedFiles: [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-rel904-fail',
        client: mockClient as unknown as OmniRouteClient,
      }),
    ).rejects.toThrow();

    const text = await getPrometheusMetrics();
    const failed = metricLines(text, 'review_yeti_lane_outcome_total')
      .filter((line) => line.includes('outcome="failed"'));
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.some((line) => line.includes('failure_class="auth"'))).toBe(true);
  });
});

describe('flushMetrics with-readers branch (P2: seam coverage)', () => {
  it('force-flushes every injected reader and resolves', async () => {
    const calls: string[] = [];
    const readers = [
      { forceFlush: async () => { calls.push('otlp'); } },
      { forceFlush: async () => { calls.push('memory'); } },
    ];
    await flushMetrics(1000, readers);
    expect(calls.sort()).toEqual(['memory', 'otlp']);
  });

  it('resolves inside the timeout guard when a reader hangs', async () => {
    const started = Date.now();
    await flushMetrics(
      50,
      [{ forceFlush: () => new Promise<void>(() => undefined) }],
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('swallows a reader rejection without throwing', async () => {
    await expect(
      flushMetrics(1000, [{ forceFlush: async () => { throw new Error('collector down'); } }]),
    ).resolves.toBeUndefined();
  });
});
