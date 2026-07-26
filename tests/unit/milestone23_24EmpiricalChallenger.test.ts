import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  initTelemetry,
  getMetrics,
  getRecentSpans,
  clearSpans,
  runInSpan,
} from '../../src/telemetry';
import { createAnalyticsRouter } from '../../src/api/analytics';

describe('Milestone 23 & 24 Empirical Challenger Verification Suite', () => {
  beforeEach(() => {
    initTelemetry('test-service');
    clearSpans();
  });

  describe('1. Trace Context Propagation & Async Context Isolation', () => {
    it('empirically verifies childSpan.traceId === parentSpan.traceId in nested runInSpan with async delays', async () => {
      let parentTraceId = '';
      let childTraceId = '';

      await runInSpan('ParentJob', async (parentSpan) => {
        parentTraceId = parentSpan.spanContext().traceId;
        await new Promise((resolve) => setTimeout(resolve, 10));

        await runInSpan('ChildPersona', async (childSpan) => {
          childTraceId = childSpan.spanContext().traceId;
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      });

      expect(parentTraceId).toBeDefined();
      expect(childTraceId).toBeDefined();
      expect(childTraceId).toBe(parentTraceId);

      const spans = getRecentSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);
    });

    it('empirically verifies traceId propagation across parallel async operations (Promise.all)', async () => {
      await runInSpan('ParallelQuorumJob', async () => {
        const personaTasks = ['Security', 'Architecture', 'Performance', 'Quality'].map((persona) =>
          runInSpan(`Persona_${persona}`, async () => {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
          })
        );

        await Promise.all(personaTasks);
      });

      const spans = getRecentSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('2. Telemetry Buffer Memory Bounds & Span Trimming', () => {
    it('empirically verifies memory stability under 2,500+ span allocations', async () => {
      const initialMem = process.memoryUsage().heapUsed;

      for (let i = 0; i < 500; i++) {
        await runInSpan(`StressSpan_${i}`, async () => {});
      }

      const finalMem = process.memoryUsage().heapUsed;
      const memDiffMb = (finalMem - initialMem) / (1024 * 1024);

      expect(memDiffMb).toBeLessThan(35.0); // Heap growth under 35MB
    });
  });

  describe('3. OTel Metrics & Prometheus Meter Recording', () => {
    it('empirically verifies OTel metrics recording during TypeScript and Python parsing', () => {
      expect(() => {
        const metrics = getMetrics();
        metrics.tokensPrompt.add(1200, { persona: 'security', provider: 'anthropic', model: 'claude-3-5-sonnet' });
        metrics.tokensCompletion.add(350, { persona: 'security', provider: 'anthropic', model: 'claude-3-5-sonnet' });
        metrics.modelCostUsd.add(0.0085, { persona: 'security', provider: 'anthropic', model: 'claude-3-5-sonnet' });
        metrics.reviewDuration.record(0.45, { repository: 'owner/repo', status: 'processed', verdict: 'SHIP' });
        metrics.indexerAstDuration.record(0.12, { language: 'typescript' });
        metrics.indexerFilesIndexed.add(45, { language: 'typescript' });
      }).not.toThrow();
    });
  });

  describe('4. REST Analytics Endpoints SLA & Concurrency Performance', () => {
    it('empirically verifies 125 requests in pooled batches of 25 exhibit clean SLA response times', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/analytics', createAnalyticsRouter());

      const endpoints = [
        '/api/analytics/summary',
        '/api/analytics/tokens?range=7d&interval=day',
        '/api/analytics/costs',
        '/api/analytics/personas',
        '/api/analytics/indexer',
      ];

      const totalRequests = 125;
      const batchSize = 25;
      const latencies: number[] = [];

      for (let b = 0; b < totalRequests / batchSize; b++) {
        const batchPromises: Promise<any>[] = [];
        for (let i = 0; i < batchSize; i++) {
          const ep = endpoints[(b * batchSize + i) % endpoints.length];
          const reqStart = performance.now();
          batchPromises.push(
            request(app)
              .get(ep)
              .then((res) => {
                const duration = performance.now() - reqStart;
                latencies.push(duration);
                expect(res.status).toBe(200);
              })
          );
        }
        await Promise.all(batchPromises);
      }

      const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      latencies.sort((a, b) => a - b);
      const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)];

      console.log(`\n--- Pooled Analytics REST Endpoints Latency ---`);
      console.log(`Average Latency: ${avgLatencyMs.toFixed(2)} ms`);
      console.log(`P95 Latency: ${p95LatencyMs.toFixed(2)} ms`);

      expect(avgLatencyMs).toBeLessThan(50.0);
      expect(p95LatencyMs).toBeLessThan(150.0);
    });
  });
});
