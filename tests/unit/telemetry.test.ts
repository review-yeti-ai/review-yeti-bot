import { describe, it, expect, beforeEach } from 'vitest';
import {
  initTelemetry,
  getTracer,
  getMetrics,
  getPrometheusMetrics,
  getRecentSpans,
  clearSpans,
  runInSpan,
  formatSpan,
} from '../../src/telemetry';

function metricValue(text: string, sample: string): number {
  const line = text.split('\n').find((entry) => entry.startsWith(`${sample} `));
  if (!line) throw new Error(`missing metric sample ${sample}`);
  return Number(line.slice(sample.length + 1));
}

describe('OpenTelemetry Instrumentation Engine (Milestone 23)', () => {
  beforeEach(() => {
    initTelemetry('test-service');
    clearSpans();
  });

  it('initializes tracer and meter successfully', () => {
    const tracer = getTracer('test-tracer');
    expect(tracer).toBeDefined();

    const metrics = getMetrics();
    expect(metrics).toBeDefined();
    expect(metrics.tokensPrompt).toBeDefined();
    expect(metrics.tokensCompletion).toBeDefined();
    expect(metrics.reviewDuration).toBeDefined();
    expect(metrics.jobsQueued).toBeDefined();
    expect(metrics.jobsDispatched).toBeDefined();
    expect(metrics.reviewReaperDeliveryIdentityMismatches).toBeDefined();
    expect(metrics.reviewReaperSupersededAttempts).toBeDefined();
    expect(metrics.activeJobs).toBeDefined();
    expect(metrics.queuedJobs).toBeDefined();
  });

  it('exposes an untouched reaper quarantine counter with a zero baseline', async () => {
    const prometheusText = await getPrometheusMetrics();

    expect(prometheusText).toContain('# HELP ct_review_reaper_delivery_identity_mismatch_total Abandoned review runs quarantined because run and outbox delivery identities differed.');
    expect(prometheusText).toContain('# TYPE ct_review_reaper_delivery_identity_mismatch_total counter');
    expect(prometheusText).toContain('ct_review_reaper_delivery_identity_mismatch_total 0');
    expect(prometheusText).toContain('# HELP ct_review_reaper_superseded_attempt_total Abandoned review attempts retired because a completed newer same-head App check already exists.');
    expect(prometheusText).toContain('# TYPE ct_review_reaper_superseded_attempt_total counter');
    expect(prometheusText).toContain('ct_review_reaper_superseded_attempt_total 0');
  });

  it('keeps every counter total cumulative across repeated Prometheus collections', async () => {
    const metrics = getMetrics();
    const counters = [
      { instrument: metrics.tokensPrompt, name: 'ct_review_tokens_prompt_total', increment: 11 },
      { instrument: metrics.tokensCompletion, name: 'ct_review_tokens_completion_total', increment: 12 },
      { instrument: metrics.tokensTotal, name: 'ct_review_tokens_total', increment: 13 },
      { instrument: metrics.modelCostUsd, name: 'ct_review_model_cost_usd_total', increment: 1.5 },
      { instrument: metrics.indexerFilesIndexed, name: 'ct_indexer_files_indexed_total', increment: 14 },
      { instrument: metrics.indexerSymbolsExtracted, name: 'ct_indexer_symbols_extracted_total', increment: 15 },
      { instrument: metrics.arbiterVerdicts, name: 'ct_arbiter_verdicts_total', increment: 16 },
      { instrument: metrics.jobsQueued, name: 'ct_queue_jobs_queued_total', increment: 17 },
      { instrument: metrics.jobsDispatched, name: 'ct_queue_jobs_dispatched_total', increment: 18 },
      {
        instrument: metrics.reviewReaperDeliveryIdentityMismatches,
        name: 'ct_review_reaper_delivery_identity_mismatch_total',
        increment: 19,
      },
      {
        instrument: metrics.reviewReaperSupersededAttempts,
        name: 'ct_review_reaper_superseded_attempt_total',
        increment: 20,
      },
    ];

    counters.forEach(({ instrument, increment }, index) => {
      instrument.add(increment, { regression: 'cumulative-counters', instrument: String(index) });
    });

    const firstCollection = await getPrometheusMetrics();
    const secondCollection = await getPrometheusMetrics();

    counters.forEach(({ name, increment }, index) => {
      const sample = `${name}{regression="cumulative-counters",instrument="${index}"}`;
      expect(metricValue(firstCollection, sample)).toBe(increment);
      expect(metricValue(secondCollection, sample)).toBe(increment);
    });
  });

  it('keeps histogram totals cumulative and exposes an up-down counter as the current gauge value', async () => {
    const metrics = getMetrics();
    const attributes = { regression: 'cumulative-non-counter-semantics' };
    metrics.reviewDuration.record(2.5, attributes);
    metrics.activeJobs.add(3, attributes);

    const firstCollection = await getPrometheusMetrics();
    const secondCollection = await getPrometheusMetrics();
    const histogramCount = 'ct_review_duration_seconds_count{regression="cumulative-non-counter-semantics"}';
    const histogramSum = 'ct_review_duration_seconds_sum{regression="cumulative-non-counter-semantics"}';
    const gauge = 'ct_queue_active_jobs{regression="cumulative-non-counter-semantics"}';

    expect(metricValue(firstCollection, histogramCount)).toBe(1);
    expect(metricValue(secondCollection, histogramCount)).toBe(1);
    expect(metricValue(secondCollection, histogramSum)).toBe(2.5);
    expect(metricValue(firstCollection, gauge)).toBe(3);
    expect(metricValue(secondCollection, gauge)).toBe(3);

    metrics.activeJobs.add(-1, attributes);
    const thirdCollection = await getPrometheusMetrics();
    expect(metricValue(thirdCollection, gauge)).toBe(2);
  });

  it('records metrics and serializes to Prometheus format via getPrometheusMetrics()', async () => {
    const metrics = getMetrics();
    metrics.tokensPrompt.add(150, { persona: 'security', provider: 'anthropic', model: 'claude-3-5-sonnet' });
    metrics.tokensCompletion.add(50, { persona: 'security', provider: 'anthropic', model: 'claude-3-5-sonnet' });
    metrics.modelCostUsd.add(0.0025, { persona: 'security', provider: 'anthropic', model: 'claude-3-5-sonnet' });
    metrics.reviewDuration.record(1.2, { repository: 'owner/repo', status: 'processed', verdict: 'SHIP' });
    metrics.indexerAstDuration.record(0.045, { language: 'typescript' });
    metrics.indexerFilesIndexed.add(3, { language: 'typescript' });
    metrics.jobsQueued.add(5, { repository: 'owner/repo' });
    metrics.jobsDispatched.add(3, { repository: 'owner/repo' });
    metrics.reviewReaperDeliveryIdentityMismatches.add(1);
    metrics.reviewReaperSupersededAttempts.add(1);
    metrics.activeJobs.add(2, { repository: 'owner/repo' });
    metrics.queuedJobs.add(2, { repository: 'owner/repo' });

    const prometheusText = await getPrometheusMetrics();
    expect(typeof prometheusText).toBe('string');
    expect(prometheusText).toContain('# HELP ct_review_tokens_prompt_total');
    expect(prometheusText).toContain('# TYPE ct_review_tokens_prompt_total counter');
    expect(prometheusText).toContain('ct_review_tokens_prompt_total{persona="security",provider="anthropic",model="claude-3-5-sonnet"} 150');
    expect(prometheusText).toContain('ct_review_duration_seconds');
    expect(prometheusText).toContain('ct_indexer_ast_duration_seconds');
    expect(prometheusText).toContain('ct_queue_jobs_queued_total');
    expect(prometheusText).toContain('ct_queue_jobs_dispatched_total');
    expect(prometheusText).toContain('ct_review_reaper_delivery_identity_mismatch_total');
    expect(prometheusText).toContain('ct_review_reaper_superseded_attempt_total');
    expect(prometheusText).toContain('ct_queue_active_jobs');
    expect(prometheusText).toContain('ct_queue_queued_jobs');
  });

  it('creates spans and retrieves them via getRecentSpans()', async () => {
    await runInSpan('ct_review_pipeline', async (parentSpan) => {
      parentSpan.setAttribute('ct.repo', 'owner/repo');
      parentSpan.setAttribute('ct.pr_number', 42);

      await runInSpan('ct_persona_lane', (childSpan) => {
        childSpan.setAttribute('ct.persona.id', 'security');
        childSpan.setAttribute('ct.tokens.prompt', 100);
      });
    });

    const spans = getRecentSpans({ limit: 10 });
    expect(spans.length).toBeGreaterThanOrEqual(2);

    const pipelineSpan = spans.find((s) => s.name === 'ct_review_pipeline');
    expect(pipelineSpan).toBeDefined();
    expect(pipelineSpan?.attributes['ct.repo']).toBe('owner/repo');
    expect(pipelineSpan?.attributes['ct.pr_number']).toBe(42);
    expect(pipelineSpan?.status.code).toBe('OK');

    const personaSpan = spans.find((s) => s.name === 'ct_persona_lane');
    expect(personaSpan).toBeDefined();
    expect(personaSpan?.attributes['ct.persona.id']).toBe('security');
    expect(personaSpan?.attributes['ct.tokens.prompt']).toBe(100);
  });

  it('filters recent spans by traceId or name and respects limit', async () => {
    await runInSpan('span_alpha', () => {});
    await runInSpan('span_beta', () => {});

    const alphaSpans = getRecentSpans({ name: 'span_alpha' });
    expect(alphaSpans.length).toBe(1);
    expect(alphaSpans[0].name).toBe('span_alpha');

    const limitedSpans = getRecentSpans({ limit: 1 });
    expect(limitedSpans.length).toBe(1);
  });
});
