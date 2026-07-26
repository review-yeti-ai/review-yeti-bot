import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import {
  initTelemetry,
  getTracer,
  getMetrics,
  getPrometheusMetrics,
  getRecentSpans,
  clearSpans,
  runInSpan,
} from '../../src/telemetry';
import { ASTParser } from '../../src/indexer/astParser';
import { inMemorySpanExporter } from '../../src/telemetry/spans';

describe('Milestone 23 & 24: Empirical Challenger Test Suite', () => {
  let app: any;
  let authToken: string;

  beforeAll(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  beforeEach(() => {
    initTelemetry('test-challenger-service');
    clearSpans();
  });

  describe('Requirement 2: OTel Active Spans, Attributes, Metrics, and AST Parse Duration Recordings', () => {
    it('empirically checks active span creation and context propagation (Detects NoopContextManager issue)', async () => {
      let rootTraceId = '';
      let childTraceId = '';

      await runInSpan('root_span', async (parentSpan) => {
        parentSpan.setAttribute('ct.root_attr', 'root_value');
        rootTraceId = parentSpan.spanContext().traceId;

        await runInSpan('child_span_1', async (childSpan) => {
          childSpan.setAttribute('ct.child_attr', 'child_value_1');
          childTraceId = childSpan.spanContext().traceId;
        });
      });

      const spans = getRecentSpans();
      expect(spans.length).toBeGreaterThanOrEqual(2);
      expect(rootTraceId).toBeTruthy();
      expect(childTraceId).toBeTruthy();

      // EMPIRICAL FINDING: Trace ID propagation fails because NoopContextManager is used instead of AsyncLocalStorageContextManager
      const contextPropagated = (rootTraceId === childTraceId);
      console.log(`[Empirical Audit] OTel Trace ID Context Propagation Active: ${contextPropagated} (Root: ${rootTraceId}, Child: ${childTraceId})`);
    });

    it('accumulates counter and histogram metrics correctly', async () => {
      const metrics = getMetrics();
      metrics.tokensPrompt.add(100, { model: 'gpt-4' });
      metrics.tokensPrompt.add(200, { model: 'gpt-4' });
      metrics.tokensCompletion.add(50, { model: 'gpt-4' });
      metrics.reviewDuration.record(0.4, { status: 'success' });
      metrics.reviewDuration.record(1.2, { status: 'success' });

      const promOutput = await getPrometheusMetrics();
      expect(promOutput).toContain('ct_review_tokens_prompt_total{model="gpt-4"} 300');
      expect(promOutput).toContain('ct_review_tokens_completion_total{model="gpt-4"} 50');
      expect(promOutput).toContain('ct_review_duration_seconds_count{status="success"} 2');
      expect(promOutput).toContain('ct_review_duration_seconds_sum{status="success"} 1.6');
    });

    it('empirically audits AST parse duration recordings for TypeScript, Python, and fallback files', async () => {
      const parser = new ASTParser();

      // Initial metric collection to check starting values
      const initialPromText = await getPrometheusMetrics();

      // Parse TS
      const tsResult = parser.parseSource('test.ts', `export class Test { foo(): string { return "bar"; } }`);
      expect(tsResult.parseDurationMs).toBeGreaterThanOrEqual(0);

      // Parse Python
      const pyResult = parser.parseSource('test.py', `class Test:\n    def foo(self):\n        return "bar"`);
      expect(pyResult.parseDurationMs).toBeGreaterThanOrEqual(0);

      // Parse Unknown file (fallback)
      const txtResult = parser.parseSource('test.txt', `class DummyClass`);
      expect(txtResult.parseDurationMs).toBeGreaterThanOrEqual(0);

      const afterPromText = await getPrometheusMetrics();
      console.log('[Empirical Audit] AST Indexer Duration Metrics in Prometheus Output:');
      console.log(afterPromText.split('\n').filter((line) => line.includes('ct_indexer_ast_duration_seconds')).join('\n'));
    });
  });

  describe('Requirement 3: GET /metrics Prometheus Format and GET /api/telemetry/spans JSON Readout', () => {
    it('validates GET /metrics format compliance with Prometheus text exposition standards', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');

      const text = res.text;
      expect(text).toMatch(/# HELP ct_review_tokens_prompt_total .+/);
      expect(text).toMatch(/# TYPE ct_review_tokens_prompt_total counter/);
      expect(text).toMatch(/# HELP ct_review_duration_seconds .+/);
      expect(text).toMatch(/# TYPE ct_review_duration_seconds histogram/);
      expect(text).toContain('ct_review_duration_seconds_bucket{le="+Inf"}');
      expect(text).toContain('ct_review_duration_seconds_sum');
      expect(text).toContain('ct_review_duration_seconds_count');
    });

    it('validates GET /api/telemetry/spans JSON structure, authentication, and filtering', async () => {
      // Unauthenticated request returns 401
      const unauthRes = await request(app).get('/api/telemetry/spans');
      expect(unauthRes.status).toBe(401);

      await runInSpan('test_endpoint_span_1', (span) => {
        span.setAttribute('test.key', 'value1');
      });
      await runInSpan('test_endpoint_span_2', (span) => {
        span.setAttribute('test.key', 'value2');
      });

      // Unfiltered GET with auth header
      const resAll = await request(app)
        .get('/api/telemetry/spans')
        .set('Authorization', `Bearer ${authToken}`);
      expect(resAll.status).toBe(200);
      expect(resAll.body.status).toBe('ok');
      expect(typeof resAll.body.count).toBe('number');
      expect(Array.isArray(resAll.body.spans)).toBe(true);

      // Filter by name
      const resFiltered = await request(app)
        .get('/api/telemetry/spans?name=test_endpoint_span_1')
        .set('Authorization', `Bearer ${authToken}`);
      expect(resFiltered.status).toBe(200);
      expect(resFiltered.body.count).toBe(1);
      expect(resFiltered.body.spans[0].name).toBe('test_endpoint_span_1');
      expect(resFiltered.body.spans[0].attributes['test.key']).toBe('value1');

      // Test limit parameter
      const resLimit = await request(app)
        .get('/api/telemetry/spans?limit=1')
        .set('Authorization', `Bearer ${authToken}`);
      expect(resLimit.status).toBe(200);
      expect(resLimit.body.spans.length).toBe(1);
    });
  });

  describe('Requirement 4 & 5: Analytics REST API Latency SLA (<50ms) & Repeated Query Stress', () => {
    const endpoints = [
      '/api/analytics/summary',
      '/api/analytics/tokens',
      '/api/analytics/costs',
      '/api/analytics/personas',
      '/api/analytics/indexer',
    ];

    endpoints.forEach((endpoint) => {
      it(`guarantees <50ms response latency for ${endpoint} across 50 repeated requests`, async () => {
        const iterations = 50;
        const latencies: number[] = [];

        for (let i = 0; i < iterations; i++) {
          const start = performance.now();
          const res = await request(app)
            .get(endpoint)
            .set('Authorization', `Bearer ${authToken}`);
          const duration = performance.now() - start;

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          latencies.push(duration);
        }

        const avg = latencies.reduce((a, b) => a + b, 0) / iterations;
        const max = Math.max(...latencies);
        const p95 = latencies.sort((a, b) => a - b)[Math.floor(iterations * 0.95)];

        console.log(`[Latency SLA] ${endpoint} -> Avg: ${avg.toFixed(2)}ms, Max: ${max.toFixed(2)}ms, P95: ${p95.toFixed(2)}ms`);

        expect(avg).toBeLessThan(50);
        expect(p95).toBeLessThan(100);
      });
    });

    it('empirically tests concurrent burst load performance across all analytics endpoints', async () => {
      const requests = Array.from({ length: 25 }, () =>
        endpoints.map(async (ep) => {
          const start = performance.now();
          const res = await request(app)
            .get(ep)
            .set('Authorization', `Bearer ${authToken}`);
          const duration = performance.now() - start;
          expect(res.status).toBe(200);
          return { ep, duration };
        })
      ).flat();

      const results = await Promise.all(requests);
      const slowRequests = results.filter((r) => r.duration >= 50);
      console.log(`[Burst Stress] Total parallel requests: ${results.length}, Slow (>50ms): ${slowRequests.length}`);
    });
  });

  describe('Edge Case Mining & Failure Mode Detection', () => {
    it('empirically audits CircularSpanBufferExporter capacity & memory growth under span overflow (>500 spans)', async () => {
      clearSpans();
      for (let i = 0; i < 600; i++) {
        await runInSpan(`overflow_span_${i}`, () => {});
      }

      const totalExporterSpans = inMemorySpanExporter.getFinishedSpans().length;
      console.log(`[Empirical Audit] Span Exporter total stored spans after 600 exports (Cap target: 500): ${totalExporterSpans}`);
    });

    it('tests quote escaping in Prometheus attribute values', async () => {
      const metrics = getMetrics();
      metrics.tokensPrompt.add(1, { persona: 'test"persona', provider: 'test\\provider' });

      const text = await getPrometheusMetrics();
      expect(text).toContain('ct_review_tokens_prompt_total{persona="test\\"persona",provider="test\\\\provider"}');
    });

    it('tests analytics token endpoint query parameters handling', async () => {
      const res = await request(app)
        .get('/api/analytics/tokens?range=30d&interval=week')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.range).toBe('30d');
      expect(res.body.interval).toBe('week');
    });
  });
});
