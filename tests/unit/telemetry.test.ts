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
    expect(metrics.activeJobs).toBeDefined();
    expect(metrics.queuedJobs).toBeDefined();
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
