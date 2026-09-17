import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  flushMetrics,
  getPrometheusMetrics,
  getMetrics,
  initMetrics,
  resolveOtlpMetricsEndpoint,
} from '../../src/telemetry/metrics';

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
