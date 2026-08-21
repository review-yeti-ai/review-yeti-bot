import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Response } from 'express';
import { EventEmitter } from 'events';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';
import { authService } from '../../src/dashboard/authService';

describe('Challenger 1 Empirical Stress & Latency Suite for Milestone 2 (SSE Engine)', () => {
  let bus: LiveStreamBus;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
  });

  afterEach(() => {
    bus.clearHistory();
  });

  function createMockResponse(): Response & {
    written: string[];
    headers: Record<string, string>;
    closed: boolean;
    emitClose: () => void;
  } {
    const ee = new EventEmitter();
    const mockRes: any = {
      headers: {},
      written: [],
      closed: false,
      setHeader(name: string, value: string) {
        mockRes.headers[name] = value;
        return mockRes;
      },
      flushHeaders() {},
      write(chunk: string) {
        if (mockRes.closed) {
          throw new Error('Cannot write to closed connection');
        }
        mockRes.written.push(chunk);
        return true;
      },
      on(event: string, fn: any) {
        ee.on(event, fn);
        return mockRes;
      },
      emit(event: string, ...args: any[]) {
        return ee.emit(event, ...args);
      },
      emitClose() {
        mockRes.closed = true;
        ee.emit('close');
      },
    };
    return mockRes;
  }

  describe('1. Empirical Latency Verification (< 50ms SLA Target)', () => {
    it('achieves sub-5ms median latency and < 50ms p99 latency for 10,000 published events', () => {
      const jobId = 'job_latency_benchmark_10000';
      const mockRes = createMockResponse();
      bus.addClient(jobId, mockRes);

      const totalEvents = 10000;
      const latenciesNs: bigint[] = [];

      for (let i = 0; i < totalEvents; i++) {
        const startNs = process.hrtime.bigint();
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'security',
          data: { token: `t_${i}`, seq: i },
        });
        const endNs = process.hrtime.bigint();
        latenciesNs.push(endNs - startNs);
      }

      // Convert to milliseconds
      const latenciesMs = latenciesNs.map((ns) => Number(ns) / 1e6);
      latenciesMs.sort((a, b) => a - b);

      const minMs = latenciesMs[0];
      const maxMs = latenciesMs[latenciesMs.length - 1];
      const sumMs = latenciesMs.reduce((acc, v) => acc + v, 0);
      const avgMs = sumMs / totalEvents;
      const p50Ms = latenciesMs[Math.floor(totalEvents * 0.5)];
      const p95Ms = latenciesMs[Math.floor(totalEvents * 0.95)];
      const p99Ms = latenciesMs[Math.floor(totalEvents * 0.99)];

      console.log(`[EMPIRICAL LATENCY REPORT] 10k events sample:`);
      console.log(`  Min: ${minMs.toFixed(4)} ms`);
      console.log(`  Avg: ${avgMs.toFixed(4)} ms`);
      console.log(`  P50: ${p50Ms.toFixed(4)} ms`);
      console.log(`  P95: ${p95Ms.toFixed(4)} ms`);
      console.log(`  P99: ${p99Ms.toFixed(4)} ms`);
      console.log(`  Max: ${maxMs.toFixed(4)} ms`);

      // SLAs
      expect(avgMs).toBeLessThan(5); // Avg sub-5ms
      expect(p99Ms).toBeLessThan(50); // P99 sub-50ms requirement
      expect(mockRes.written.length).toBe(totalEvents);
      mockRes.emitClose();
    });

    it('measures event fan-out latency across 500 concurrent client connections (< 50ms capability)', () => {
      const jobId = 'job_fanout_latency_500';
      const clientCount = 500;
      const clients: ReturnType<typeof createMockResponse>[] = [];

      for (let i = 0; i < clientCount; i++) {
        const mockRes = createMockResponse();
        clients.push(mockRes);
        bus.addClient(jobId, mockRes);
      }

      const publishCount = 100;
      const fanoutLatenciesMs: number[] = [];

      for (let i = 0; i < publishCount; i++) {
        const startNs = process.hrtime.bigint();
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'architecture',
          data: { chunk: `chunk_${i}` },
        });
        const endNs = process.hrtime.bigint();
        fanoutLatenciesMs.push(Number(endNs - startNs) / 1e6);
      }

      fanoutLatenciesMs.sort((a, b) => a - b);
      const avgFanoutMs = fanoutLatenciesMs.reduce((a, b) => a + b, 0) / publishCount;
      const p99FanoutMs = fanoutLatenciesMs[Math.floor(publishCount * 0.99)];

      console.log(`[FAN-OUT LATENCY REPORT] 500 clients, 100 events:`);
      console.log(`  Avg fan-out publish latency: ${avgFanoutMs.toFixed(4)} ms`);
      console.log(`  P99 fan-out publish latency: ${p99FanoutMs.toFixed(4)} ms`);

      expect(p99FanoutMs).toBeLessThan(50); // Must be strictly < 50ms even with 500 clients
      clients.forEach((c) => {
        expect(c.written.length).toBe(publishCount);
        c.emitClose();
      });
    });
  });

  describe('2. SSE Stream Throughput Stress Test', () => {
    it('benchmarks maximum event publish rate (events/sec) and payload throughput', () => {
      const jobId = 'job_throughput_benchmark';
      const mockRes = createMockResponse();
      bus.addClient(jobId, mockRes);

      const eventCount = 20000;
      const payloadSample = {
        symbolName: 'SymbolResolverEngine',
        filePath: 'src/indexer/astParser.ts',
        callersCount: 42,
        calleesCount: 18,
        riskScore: 0.12,
        rationale: 'Comprehensive AST graph indexing with deep node traversal',
      };

      const start = performance.now();
      for (let i = 0; i < eventCount; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'ast:lookup',
          persona: 'architecture',
          data: payloadSample,
        });
      }
      const durationMs = performance.now() - start;
      const eventsPerSec = (eventCount / durationMs) * 1000;

      const bytesTransferred = mockRes.written.reduce((acc, chunk) => acc + Buffer.byteLength(chunk), 0);
      const mbTransferred = bytesTransferred / (1024 * 1024);
      const mbPerSec = (mbTransferred / durationMs) * 1000;

      console.log(`[THROUGHPUT REPORT]:`);
      console.log(`  Events: ${eventCount}`);
      console.log(`  Time: ${durationMs.toFixed(2)} ms`);
      console.log(`  Event Throughput: ${eventsPerSec.toFixed(0)} events/sec`);
      console.log(`  Payload Throughput: ${mbPerSec.toFixed(2)} MB/sec (${mbTransferred.toFixed(2)} MB total)`);

      expect(eventsPerSec).toBeGreaterThan(5000); // Expect >5,000 events/sec in Node in-memory
      mockRes.emitClose();
    });
  });

  describe('3. Concurrency & High Client Scale Stress Test', () => {
    it('handles 1,000 concurrent client streams across 50 active jobs without memory leakage', () => {
      const jobCount = 50;
      const clientsPerJob = 20; // 1000 clients total
      const totalClients = jobCount * clientsPerJob;

      const clients: ReturnType<typeof createMockResponse>[] = [];

      const initialHeap = process.memoryUsage().heapUsed;

      for (let j = 0; j < jobCount; j++) {
        const jobId = `job_scale_${j}`;
        for (let c = 0; c < clientsPerJob; c++) {
          const res = createMockResponse();
          clients.push(res);
          bus.addClient(jobId, res);
        }
      }

      // Publish 10 events per job
      for (let j = 0; j < jobCount; j++) {
        const jobId = `job_scale_${j}`;
        for (let e = 0; e < 10; e++) {
          bus.publishEvent({
            jobId,
            timestamp: new Date().toISOString(),
            type: 'persona:chunk',
            persona: 'quality',
            data: { eventNum: e },
          });
        }
      }

      const heapAfterClients = process.memoryUsage().heapUsed;
      const heapIncreaseMb = (heapAfterClients - initialHeap) / (1024 * 1024);

      console.log(`[CONCURRENCY SCALE REPORT]:`);
      console.log(`  Total Clients: ${totalClients} (${jobCount} jobs x ${clientsPerJob} clients)`);
      console.log(`  Heap Increase: ${heapIncreaseMb.toFixed(2)} MB`);

      clients.forEach((c) => expect(c.written.length).toBe(10));

      // Now disconnect all clients and verify cleanup
      clients.forEach((c) => c.emitClose());

      const activeClientsMap = (bus as any).clients as Map<string, any>;
      const pingMap = (bus as any).pingIntervals as Map<any, any>;

      // Check leftover clients map entries
      if (activeClientsMap.size > 0) {
        console.log('[DEBUG LEAK] Remaining jobs in clients map:', Array.from(activeClientsMap.entries()).map(([k, v]) => `${k}: size=${v.size}`));
      }

      expect(activeClientsMap.size).toBe(0);
      expect(pingMap.size).toBe(0);
    });
  });

  describe('4. Active Jobs Retrieval Overhead under Heavy Scale', () => {
    it('populates and retrieves 1,000 active jobs with persona & token metrics without performance degradation', () => {
      const jobCount = 1000;

      const startPopulate = performance.now();
      for (let i = 0; i < jobCount; i++) {
        const jobId = `job_org${i}_repo${i}_pr${i}_sha${i}`;

        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:start',
          persona: 'security',
          data: { repo: `org${i}/repo${i}`, prNumber: i },
        });

        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { promptTokens: 500, completionTokens: 200, totalTokens: 700, costUSD: 0.005 },
        });

        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:complete',
          persona: 'security',
          data: { findingsCount: 3 },
        });
      }
      const populateMs = performance.now() - startPopulate;

      const startGet = performance.now();
      const activeJobs = bus.getActiveJobs();
      const getMs = performance.now() - startGet;

      console.log(`[ACTIVE JOBS BENCHMARK]:`);
      console.log(`  Populated 1k jobs: ${populateMs.toFixed(2)} ms`);
      console.log(`  getActiveJobs() duration: ${getMs.toFixed(2)} ms`);

      expect(activeJobs.length).toBe(1000);
      expect(getMs).toBeLessThan(10); // Retrieval of 1k summaries must be under 10ms

      const sampleJob = bus.getJobStatus('job_org500_repo500_pr500_sha500');
      expect(sampleJob).toBeDefined();
      expect(sampleJob?.repo).toBe('org500/repo500');
      expect(sampleJob?.prNumber).toBe(500);
      expect(sampleJob?.tokenMetrics.totalTokens).toBe(700);
      expect(sampleJob?.tokenMetrics.estimatedCostUSD).toBeCloseTo(0.005, 5);
      expect(sampleJob?.personaProgress.security.status).toBe('completed');
    });
  });

  describe('5. Invalid Token Handling and Auth Boundary Test', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/live', createLiveRouter());
    });

    function mockGet(app: express.Express, urlPath: string) {
      return new Promise<{ statusCode: number; contentType: string }>((resolve) => {
        const [pathOnly, queryString] = urlPath.split('?');
        const queryParams: Record<string, string> = {};
        if (queryString) {
          new URLSearchParams(queryString).forEach((v, k) => {
            queryParams[k] = v;
          });
        }

        const req: any = new EventEmitter();
        req.method = 'GET';
        req.url = urlPath;
        req.path = pathOnly;
        req.query = queryParams;
        req.headers = {};

        const res: any = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
        res.getHeader = (k: string) => res.headers[k.toLowerCase()];
        res.status = (code: number) => { res.statusCode = code; return res; };
        res.write = () => true;
        res.flushHeaders = () => {};

        app(req, res);

        setImmediate(() => {
          resolve({
            statusCode: res.statusCode,
            contentType: res.headers['content-type'] || '',
          });
        });
      });
    }

    it('handles requests with null, empty, invalid, expired, and malicious tokens safely without 500 error or crashes', async () => {
      const maliciousTokens = [
        '',
        'null',
        'undefined',
        "' OR 1=1 --",
        '<script>alert(1)</script>',
        'A'.repeat(10000), // Huge token payload
        'invalid_bearer_xyz_123',
      ];

      for (const token of maliciousTokens) {
        const res = await mockGet(app, `/api/live/stream?jobId=job_fuzz&token=${encodeURIComponent(token)}`);
        expect(res.statusCode).toBe(200);
        expect(res.contentType).toBe('text/event-stream');
      }
    });
  });

  describe('6. Edge Case & Failure Mode Challenge', () => {
    it('handles MaxListeners / high job subscriber event emitter limits gracefully', () => {
      const jobId = 'job_max_listeners_test';

      // Attach 150 event listeners directly to bus to challenge maxListeners default (100)
      const listenerCount = 150;
      const listeners: Array<(...args: any[]) => void> = [];

      for (let i = 0; i < listenerCount; i++) {
        const fn = vi.fn();
        listeners.push(fn);
        bus.on(`job:${jobId}`, fn);
      }

      // Publish event
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'quorum',
        data: { test: true },
      });

      listeners.forEach((fn) => {
        expect(fn).toHaveBeenCalledTimes(1);
      });

      // Cleanup
      listeners.forEach((fn) => {
        bus.off(`job:${jobId}`, fn);
      });
    });

    it('handles giant payloads (1MB prompt/token chunk) without crashing event history ring buffer', () => {
      const jobId = 'job_giant_payload';
      const giantChunk = 'X'.repeat(1024 * 1024); // 1MB string

      expect(() => {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm_chunk',
          persona: 'security',
          data: { chunk: giantChunk },
        });
      }).not.toThrow();

      const history = bus.getHistory(jobId);
      expect(history.length).toBe(1);
      expect(history[0].data.chunk.length).toBe(1024 * 1024);
    });
  });
});
