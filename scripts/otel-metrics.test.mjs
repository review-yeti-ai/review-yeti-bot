import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toOtlpAttributes,
  computeBucketCounts,
  createCounterMetric,
  createGaugeMetric,
  createHistogramMetric,
  buildOtlpMetricsPayload,
  encodePrometheusText,
  encodeVictoriaMetricsJson,
  detectFormat,
  sendMetrics,
  emitDispatchMetric,
  emitVerdictMetric,
  emitProviderMetric,
  emitMergeGroupMetric,
  sanitizeMetricName,
} from './otel-metrics.mjs';

test('toOtlpAttributes converts diverse primitive values and ignores nulls', () => {
  const attrs = {
    repo: 'exampleorg/example-api',
    pr: 4973,
    ratio: 99.5,
    enabled: true,
    missing: null,
    absent: undefined,
  };

  const otlp = toOtlpAttributes(attrs);
  assert.deepEqual(otlp, [
    { key: 'repo', value: { stringValue: 'exampleorg/example-api' } },
    { key: 'pr', value: { intValue: '4973' } },
    { key: 'ratio', value: { doubleValue: 99.5 } },
    { key: 'enabled', value: { boolValue: true } },
  ]);
});

test('computeBucketCounts assigns values to the correct histogram bucket', () => {
  const bounds = [0.1, 0.5, 1.0];
  // 0.05 <= 0.1 -> bucket 0
  assert.deepEqual(computeBucketCounts(0.05, bounds), [1, 0, 0, 0]);
  // 0.1 <= 0.1 -> bucket 0
  assert.deepEqual(computeBucketCounts(0.1, bounds), [1, 0, 0, 0]);
  // 0.35 <= 0.5 -> bucket 1
  assert.deepEqual(computeBucketCounts(0.35, bounds), [0, 1, 0, 0]);
  // 0.9 <= 1.0 -> bucket 2
  assert.deepEqual(computeBucketCounts(0.9, bounds), [0, 0, 1, 0]);
  // 2.5 > 1.0 -> +Inf bucket (index 3)
  assert.deepEqual(computeBucketCounts(2.5, bounds), [0, 0, 0, 1]);
});

test('createCounterMetric creates standard OTLP counter with delta temporality', () => {
  const metric = createCounterMetric({
    name: 'review_yeti.verdicts_total',
    description: 'Total review verdicts',
    unit: '1',
    value: 1,
    attributes: { verdict: 'SHIP' },
    timestampNano: '1700000000000000000',
  });

  assert.equal(metric.name, 'review_yeti.verdicts_total');
  assert.equal(metric.type, 'counter');
  assert.equal(metric.otlp.sum.aggregationTemporality, 1);
  assert.equal(metric.otlp.sum.isMonotonic, true);
  assert.equal(metric.otlp.sum.dataPoints[0].asInt, '1');
  assert.deepEqual(metric.otlp.sum.dataPoints[0].attributes, [
    { key: 'verdict', value: { stringValue: 'SHIP' } },
  ]);
});

test('createGaugeMetric creates standard OTLP gauge', () => {
  const metric = createGaugeMetric({
    name: 'review_yeti.cluster.active_workers',
    value: 3,
    attributes: { namespace: 'ct-review-system' },
  });

  assert.equal(metric.name, 'review_yeti.cluster.active_workers');
  assert.equal(metric.type, 'gauge');
  assert.equal(metric.otlp.gauge.dataPoints[0].asInt, '3');
});

test('createHistogramMetric creates standard OTLP histogram with explicit bounds', () => {
  const metric = createHistogramMetric({
    name: 'review_yeti.dispatch.duration_seconds',
    value: 0.35,
    bounds: [0.1, 0.5, 1.0],
    attributes: { repository: 'exampleorg/example-api' },
  });

  assert.equal(metric.type, 'histogram');
  assert.equal(metric.otlp.histogram.aggregationTemporality, 1);
  assert.equal(metric.otlp.histogram.dataPoints[0].count, '1');
  assert.equal(metric.otlp.histogram.dataPoints[0].sum, 0.35);
  assert.deepEqual(metric.otlp.histogram.dataPoints[0].bucketCounts, ['0', '1', '0', '0']);
  assert.deepEqual(metric.otlp.histogram.dataPoints[0].explicitBounds, [0.1, 0.5, 1.0]);
});

test('buildOtlpMetricsPayload constructs valid ExportMetricsServiceRequest', () => {
  const counter = createCounterMetric({
    name: 'review_yeti.test',
    value: 1,
    attributes: { env: 'test' },
  });
  const payload = buildOtlpMetricsPayload({
    serviceName: 'review-yeti-test',
    serviceVersion: '2.0.0',
    metrics: [counter],
  });

  assert.ok(Array.isArray(payload.resourceMetrics));
  assert.equal(payload.resourceMetrics.length, 1);
  const resourceAttrs = payload.resourceMetrics[0].resource.attributes;
  assert.ok(resourceAttrs.some((a) => a.key === 'service.name' && a.value.stringValue === 'review-yeti-test'));
  assert.equal(payload.resourceMetrics[0].scopeMetrics[0].metrics.length, 1);
  assert.equal(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'review_yeti.test');
});

test('encodePrometheusText formats counter, gauge, and histogram in valid exposition syntax', () => {
  const counter = createCounterMetric({
    name: 'review_yeti.verdicts_total',
    value: 5,
    attributes: { repository: 'exampleorg/example-api', verdict: 'SHIP' },
  });
  const histogram = createHistogramMetric({
    name: 'review_yeti.dispatch.duration_seconds',
    value: 0.25,
    bounds: [0.1, 0.5, 1.0],
    attributes: { repository: 'exampleorg/example-api' },
  });

  const text = encodePrometheusText([counter, histogram], { service: 'test-service' });

  assert.ok(text.includes('# TYPE review_yeti_verdicts_total counter'));
  assert.ok(text.includes('review_yeti_verdicts_total{service="test-service",repository="exampleorg/example-api",verdict="SHIP"} 5'));
  assert.ok(text.includes('# TYPE review_yeti_dispatch_duration_seconds histogram'));
  assert.ok(text.includes('review_yeti_dispatch_duration_seconds_bucket{service="test-service",repository="exampleorg/example-api",le="0.1"} 0'));
  assert.ok(text.includes('review_yeti_dispatch_duration_seconds_bucket{service="test-service",repository="exampleorg/example-api",le="0.5"} 1'));
  assert.ok(text.includes('review_yeti_dispatch_duration_seconds_bucket{service="test-service",repository="exampleorg/example-api",le="+Inf"} 1'));
  assert.ok(text.includes('review_yeti_dispatch_duration_seconds_sum{service="test-service",repository="exampleorg/example-api"} 0.25'));
  assert.ok(text.includes('review_yeti_dispatch_duration_seconds_count{service="test-service",repository="exampleorg/example-api"} 1'));
});

test('encodeVictoriaMetricsJson outputs valid JSON lines', () => {
  const counter = createCounterMetric({
    name: 'review_yeti.verdicts_total',
    value: 1,
    attributes: { verdict: 'SHIP' },
  });

  const jsonLines = encodeVictoriaMetricsJson([counter], {}, 1700000000000);
  const parsed = JSON.parse(jsonLines.trim());
  assert.equal(parsed.metric.__name__, 'review_yeti_verdicts_total');
  assert.equal(parsed.metric.verdict, 'SHIP');
  assert.deepEqual(parsed.values, [1]);
  assert.deepEqual(parsed.timestamps, [1700000000000]);
});

test('detectFormat correctly infers format from URL', () => {
  assert.equal(detectFormat('http://victoria:8428/api/v1/import/prometheus'), 'prometheus');
  assert.equal(detectFormat('http://victoria:8428/api/v1/import'), 'vm_json');
  assert.equal(detectFormat('http://collector:4318/v1/metrics'), 'otlp_json');
  assert.equal(detectFormat('http://custom', 'prometheus'), 'prometheus');
});

test('sendMetrics skips gracefully when disabled or endpoint missing', async () => {
  const resultNoEndpoint = await sendMetrics([{ name: 'test' }], { endpoint: '' });
  assert.equal(resultNoEndpoint.skipped, true);

  const resultDisabled = await sendMetrics([{ name: 'test' }], {
    endpoint: 'http://example.com',
    enabled: false,
  });
  assert.equal(resultDisabled.skipped, true);
});

test('sendMetrics posts OTLP payload to HTTP endpoint successfully', async () => {
  let capturedBody = null;
  let capturedHeaders = null;

  const mockFetch = async (url, options) => {
    capturedBody = options.body;
    capturedHeaders = options.headers;
    return { ok: true, status: 200 };
  };

  const metric = createCounterMetric({ name: 'test_metric', value: 1 });
  const res = await sendMetrics([metric], {
    endpoint: 'http://collector:4318/v1/metrics',
    fetchImpl: mockFetch,
    serviceName: 'test-unit',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'test_metric');
});

test('sendMetrics fails open on network errors without throwing', async () => {
  const failingFetch = async () => {
    throw new Error('Connection refused (ECONNREFUSED)');
  };

  const metric = createCounterMetric({ name: 'test_metric', value: 1 });
  const res = await sendMetrics([metric], {
    endpoint: 'http://unreachable.local:8428/api/v1/import/prometheus',
    fetchImpl: failingFetch,
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('Connection refused'));
});

test('sendMetrics fails open on HTTP 500 without throwing', async () => {
  const serverErrorFetch = async () => {
    return { ok: false, status: 500 };
  };

  const metric = createCounterMetric({ name: 'test_metric', value: 1 });
  const res = await sendMetrics([metric], {
    endpoint: 'http://error.local:8428/api/v1/import/prometheus',
    fetchImpl: serverErrorFetch,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test('emitDispatchMetric generates duration histogram and request counter', async () => {
  let sentMetrics = null;
  const mockFetch = async (url, opts) => {
    return { ok: true, status: 200 };
  };

  await emitDispatchMetric({
    repository: 'exampleorg/example-api',
    prNumber: 4973,
    durationMs: 450,
    status: 'success',
    endpoint: 'http://test:8428/api/v1/import/prometheus',
    fetchImpl: (url, opts) => {
      sentMetrics = opts.body;
      return mockFetch(url, opts);
    },
  });

  assert.ok(sentMetrics.includes('review_yeti_dispatch_duration_seconds_bucket'));
  assert.ok(sentMetrics.includes('review_yeti_dispatch_requests_total'));
  assert.ok(sentMetrics.includes('pr_number="4973"'));
});

test('emitVerdictMetric generates verdict and finding counters', async () => {
  let sentBody = null;
  await emitVerdictMetric({
    repository: 'exampleorg/example-api',
    prNumber: 4973,
    verdict: 'SHIP',
    p0Count: 1,
    p1Count: 2,
    p2Count: 0,
    durationMs: 12500,
    endpoint: 'http://test:8428/api/v1/import/prometheus',
    fetchImpl: async (url, opts) => {
      sentBody = opts.body;
      return { ok: true, status: 200 };
    },
  });

  assert.ok(sentBody.includes('review_yeti_verdicts_total{service="review-yeti",repository="exampleorg/example-api",verdict="SHIP",backend="kubernetes"} 1'));
  assert.ok(sentBody.includes('review_yeti_findings_total{service="review-yeti",repository="exampleorg/example-api",severity="P0"} 1'));
  assert.ok(sentBody.includes('review_yeti_findings_total{service="review-yeti",repository="exampleorg/example-api",severity="P1"} 2'));
  assert.ok(sentBody.includes('review_yeti_review_duration_seconds_bucket'));
});

test('emitProviderMetric records tokens, ttft, and error counts', async () => {
  let sentBody = null;
  await emitProviderMetric({
    provider: 'bifrost',
    model: 'ollama/glm-5.3-flash',
    ttftMs: 820,
    totalMs: 4500,
    promptTokens: 1200,
    completionTokens: 350,
    reasoningTokens: 150,
    errorType: 'rate_limit',
    endpoint: 'http://test:8428/api/v1/import/prometheus',
    fetchImpl: async (url, opts) => {
      sentBody = opts.body;
      return { ok: true, status: 200 };
    },
  });

  assert.ok(sentBody.includes('review_yeti_provider_requests_total{service="review-yeti",provider="bifrost",model="ollama/glm-5.3-flash",status="error"} 1'));
  assert.ok(sentBody.includes('review_yeti_provider_ttft_seconds_bucket'));
  assert.ok(sentBody.includes('review_yeti_provider_tokens_total{service="review-yeti",provider="bifrost",model="ollama/glm-5.3-flash",token_type="prompt"} 1200'));
  assert.ok(sentBody.includes('review_yeti_provider_tokens_total{service="review-yeti",provider="bifrost",model="ollama/glm-5.3-flash",token_type="completion"} 350'));
  assert.ok(sentBody.includes('review_yeti_provider_tokens_total{service="review-yeti",provider="bifrost",model="ollama/glm-5.3-flash",token_type="reasoning"} 150'));
  assert.ok(sentBody.includes('review_yeti_provider_errors_total{service="review-yeti",provider="bifrost",model="ollama/glm-5.3-flash",error_type="rate_limit"} 1'));
});

test('emitMergeGroupMetric records merge queue evaluation result', async () => {
  let sentBody = null;
  await emitMergeGroupMetric({
    repository: 'exampleorg/example-ui',
    result: 'approved',
    durationMs: 850,
    endpoint: 'http://test:8428/api/v1/import/prometheus',
    fetchImpl: async (url, opts) => {
      sentBody = opts.body;
      return { ok: true, status: 200 };
    },
  });

  assert.ok(sentBody.includes('review_yeti_merge_group_evaluations_total{service="review-yeti",repository="exampleorg/example-ui",result="approved"} 1'));
  assert.ok(sentBody.includes('review_yeti_merge_group_duration_seconds_bucket'));
});
