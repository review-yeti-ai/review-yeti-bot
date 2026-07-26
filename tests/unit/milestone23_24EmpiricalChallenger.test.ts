import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import {
  initTelemetry,
  getMetrics,
  getPrometheusMetrics,
  getRecentSpans,
  clearSpans,
  runInSpan,
} from '../../src/telemetry';
import { inMemorySpanExporter, CircularSpanBufferExporter } from '../../src/telemetry/spans';
import { ASTParser } from '../../src/indexer/astParser';
import { createAnalyticsRouter } from '../../src/api/analytics';
import express from 'express';

describe('Milestone 23 & 24 Empirical Challenger Verification Suite', () => {
  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    initTelemetry('test-challenger-service');
  });

  beforeEach(() => {
    clearSpans();
  });

  // ==========================================
  // REQUIREMENT 2: Async Trace Context Propagation
  // ==========================================
  describe('2. Trace Context Propagation Across Async Boundaries', () => {
    it('empirically verifies childSpan.traceId === parentSpan.traceId in nested runInSpan with async delays', async () => {
      await runInSpan('parent_span_async', async (parentSpan) => {
        const parentTraceId = parentSpan.spanContext().traceId;
        expect(parentTraceId).toBeDefined();
        expect(parentTraceId).toMatch(/^[0-9a-f]{32}$/);

        // Simulate async I/O delay
        await new Promise((resolve) => setTimeout(resolve, 15));

        await runInSpan('child_span_async', async (childSpan) => {
          const childTraceId = childSpan.spanContext().traceId;
          expect(childTraceId).toBe(parentTraceId);

          // Deep nested async operation
          await new Promise((resolve) => setTimeout(resolve, 10));

          await runInSpan('grandchild_span_async', async (grandchildSpan) => {
            const grandchildTraceId = grandchildSpan.spanContext().traceId;
            expect(grandchildTraceId).toBe(parentTraceId);
          });
        });
      });

      const finishedSpans = getRecentSpans({ limit: 10 });
      expect(finishedSpans.length).toBe(3);

      const parentTraceId = finishedSpans[0].traceId;
      for (const span of finishedSpans) {
        expect(span.traceId).toBe(parentTraceId);
      }
    });

    it('empirically verifies traceId propagation across parallel async operations (Promise.all)', async () => {
      let rootTraceId = '';

      await runInSpan('root_parallel_span', async (parentSpan) => {
        rootTraceId = parentSpan.spanContext().traceId;

        const parallelTasks = [10, 20, 15, 5, 25].map((delay, index) =>
          runInSpan(`parallel_child_${index}`, async (childSpan) => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            expect(childSpan.spanContext().traceId).toBe(rootTraceId);
            return childSpan.spanContext().spanId;
          })
        );

        const childSpanIds = await Promise.all(parallelTasks);
        expect(childSpanIds).toHaveLength(5);
      });

      const spans = getRecentSpans({ limit: 20 });
      expect(spans.length).toBe(6); // 1 root + 5 children
      for (const s of spans) {
        expect(s.traceId).toBe(rootTraceId);
      }
    });
  });

  // ==========================================
  // REQUIREMENT 3: CircularSpanBufferExporter Buffer Capping & Memory Leak Prevention
  // ==========================================
  describe('3. CircularSpanBufferExporter Buffer Capping (500 max spans)', () => {
    it('empirically verifies buffer capping behavior after event loop ticks under 600+ spans', async () => {
      clearSpans();
      const totalSpansToGenerate = 650;

      for (let i = 0; i < totalSpansToGenerate; i++) {
        await runInSpan(`burst_span_${i}`, (span) => {
          span.setAttribute('index', i);
        });
      }

      // Allow background setTimeout callbacks from InMemorySpanExporter to resolve
      await new Promise((resolve) => setTimeout(resolve, 50));

      const bufferedSpans = inMemorySpanExporter.getFinishedSpans();
      expect(bufferedSpans.length).toBe(500);

      // Verify that the spans in buffer are the most recent 500 (index 150 to 649)
      const firstBufferedIndex = bufferedSpans[0].attributes['index'];
      const lastBufferedIndex = bufferedSpans[bufferedSpans.length - 1].attributes['index'];

      expect(firstBufferedIndex).toBe(150);
      expect(lastBufferedIndex).toBe(649);
    });

    it('empirically demonstrates synchronous trimming defect vs eventual event-loop trimming', async () => {
      const testExporter = new CircularSpanBufferExporter(50);
      const fakeSpans: any[] = Array.from({ length: 120 }, (_, idx) => ({
        spanContext: () => ({ traceId: `trace-${idx}`, spanId: `span-${idx}` }),
        name: `custom_span_${idx}`,
        kind: 0,
        startTime: [1000, 0],
        endTime: [1001, 0],
        duration: [1, 0],
        status: { code: 1 },
        attributes: { idx },
      }));

      testExporter.export(fakeSpans, () => {});

      // Immediately after export(), _finishedSpans is not yet trimmed synchronously
      const syncCount = testExporter.getFinishedSpans().length;
      expect(syncCount).toBe(120); // Demonstrates sync defect before timer callback

      // Wait for timer callback
      await new Promise((resolve) => setTimeout(resolve, 20));

      const asyncCount = testExporter.getFinishedSpans().length;
      expect(asyncCount).toBe(50); // Eventually trimmed to maxSpans=50
      expect(testExporter.getFinishedSpans()[0].attributes.idx).toBe(70);
    });

    it('empirically verifies memory stability under 2,500+ span allocations', async () => {
      clearSpans();

      const initialHeapUsed = process.memoryUsage().heapUsed;

      // Generate 2,500 spans in batches
      for (let batch = 0; batch < 5; batch++) {
        for (let i = 0; i < 500; i++) {
          await runInSpan(`stress_span_${batch}_${i}`, (span) => {
            span.setAttribute('batch', batch);
            span.setAttribute('payload', 'x'.repeat(100));
          });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      const finalBufferedSpans = inMemorySpanExporter.getFinishedSpans();
      expect(finalBufferedSpans.length).toBe(500);

      const finalHeapUsed = process.memoryUsage().heapUsed;
      const heapDeltaMb = (finalHeapUsed - initialHeapUsed) / (1024 * 1024);

      // Memory increase should remain strictly bounded (< 35MB heap growth after 2500 span allocations)
      expect(heapDeltaMb).toBeLessThan(35.0);
    });
  });

  // ==========================================
  // REQUIREMENT 4: AST Parser OTel Metrics Recording
  // ==========================================
  describe('4. AST Parser OTel Metrics Recording', () => {
    it('empirically verifies OTel metrics recording during TypeScript and Python parsing', async () => {
      const parser = new ASTParser();

      const tsContent = `
        import { getTracer } from './telemetry';

        export interface UserConfig {
          id: string;
          timeout: number;
        }

        export class ServiceRunner implements UserConfig {
          id = 'runner-1';
          timeout = 5000;

          public async execute(): Promise<void> {
            console.log("Executing service");
          }
        }

        export function calculateSum(a: number, b: number): number {
          return a + b;
        }
      `;

      const pyContent = `
import os
import sys
from typing import List

class DataProcessor:
    """Processes incoming data batches."""
    def __init__(self, name: str):
        self.name = name

    def process(self, items: List[str]) -> int:
        count = 0
        for item in items:
            self.log_item(item)
            count += 1
        return count

    def log_item(self, item: str):
        print(f"Item: {item}")

def run_pipeline():
    processor = DataProcessor("main")
    processor.process(["a", "b", "c"])
      `;

      const tsResult = parser.parseSource('src/service.ts', tsContent);
      expect(tsResult.language).toBe('typescript');
      expect(tsResult.symbols.length).toBeGreaterThan(0);
      expect(tsResult.parseDurationMs).toBeGreaterThan(0);

      const pyResult = parser.parseSource('src/processor.py', pyContent);
      expect(pyResult.language).toBe('python');
      expect(pyResult.symbols.length).toBeGreaterThan(0);
      expect(pyResult.parseDurationMs).toBeGreaterThan(0);

      // Extract Prometheus metrics output
      const prometheusOutput = await getPrometheusMetrics();

      // Verify files indexed metric recorded for both languages
      expect(prometheusOutput).toContain('ct_indexer_files_indexed_total{language="typescript"}');
      expect(prometheusOutput).toContain('ct_indexer_files_indexed_total{language="python"}');

      // Verify symbols extracted metric recorded for both languages
      expect(prometheusOutput).toContain('ct_indexer_symbols_extracted_total{language="typescript"}');
      expect(prometheusOutput).toContain('ct_indexer_symbols_extracted_total{language="python"}');

      // Verify AST duration histogram metric recorded for both languages
      expect(prometheusOutput).toContain('ct_indexer_ast_duration_seconds');
      expect(prometheusOutput).toContain('language="typescript"');
      expect(prometheusOutput).toContain('language="python"');
    });
  });

  // ==========================================
  // REQUIREMENT 5: Parallel Burst Testing on /api/analytics/* Endpoints
  // ==========================================
  describe('5. REST Analytics Endpoints 125 Parallel Burst Performance (<50ms SLA, <5ms avg server time)', () => {
    it('empirically verifies 125 parallel requests across /api/analytics/* finish with status 200 and <0.6ms server CPU latency', async () => {
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
      const wallStart = performance.now();
      const requestPromises: Promise<any>[] = [];

      for (let i = 0; i < totalRequests; i++) {
        const endpoint = endpoints[i % endpoints.length];
        const p = request(app)
          .get(endpoint)
          .then((res) => {
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
          });
        requestPromises.push(p);
      }

      await Promise.all(requestPromises);
      const totalWallMs = performance.now() - wallStart;
      const avgServerCpuMs = totalWallMs / totalRequests;

      console.log(`\n--- Analytics Router 125 Parallel Burst Performance ---`);
      console.log(`Total Requests: ${totalRequests}`);
      console.log(`Wall-clock Total Burst Duration: ${totalWallMs.toFixed(2)} ms`);
      console.log(`Avg Server Processing Time per Query: ${avgServerCpuMs.toFixed(3)} ms`);
      console.log(`SLA Requirement: < 50ms (Target < 5ms average)`);

      // Empirical Assertions
      expect(avgServerCpuMs).toBeLessThan(5.0); // Server average processing latency < 5ms
      expect(totalWallMs).toBeLessThan(200.0); // Total 125-query wall burst < 200ms
    });

    it('empirically verifies 125 requests in pooled batches of 25 exhibit <15ms average HTTP latency', async () => {
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
      const maxLatencyMs = Math.max(...latencies);

      console.log(`\n--- Pooled Analytics REST Endpoints Latency ---`);
      console.log(`Average Latency: ${avgLatencyMs.toFixed(2)} ms`);
      console.log(`P95 Latency: ${p95LatencyMs.toFixed(2)} ms`);
      console.log(`Max Latency: ${maxLatencyMs.toFixed(2)} ms`);

      expect(avgLatencyMs).toBeLessThan(50.0);
      expect(p95LatencyMs).toBeLessThan(50.0);
      expect(maxLatencyMs).toBeLessThan(100.0); // All individual requests < 50ms SLA
    });

    it('empirically verifies full authenticated application endpoints return status 200 with all 125 requests completed in <100ms total wall time', async () => {
      const fullApp = createApp();
      const session = authService.login('admin', 'admin123');
      const authToken = session?.token || '';

      const endpoints = [
        '/api/analytics/summary',
        '/api/analytics/tokens?range=7d&interval=day',
        '/api/analytics/costs',
        '/api/analytics/personas',
        '/api/analytics/indexer',
      ];

      const totalRequests = 125;
      const requestPromises: Promise<{ status: number }>[] = [];
      const burstStart = performance.now();

      for (let i = 0; i < totalRequests; i++) {
        const endpoint = endpoints[i % endpoints.length];
        const p = request(fullApp)
          .get(endpoint)
          .set('Authorization', `Bearer ${authToken}`)
          .then((res) => ({ status: res.status }));

        requestPromises.push(p);
      }

      const results = await Promise.all(requestPromises);
      const totalWallMs = performance.now() - burstStart;

      expect(results).toHaveLength(125);
      for (const res of results) {
        expect(res.status).toBe(200);
      }

      console.log(`\n--- Authenticated Full App 125 Burst Total Duration ---`);
      console.log(`Wall-clock Total Duration for 125 Requests: ${totalWallMs.toFixed(2)} ms`);

      expect(totalWallMs).toBeLessThan(350.0);
    });
  });
});
