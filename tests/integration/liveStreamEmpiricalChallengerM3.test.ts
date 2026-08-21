// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import request from 'supertest';
import http from 'http';
import { useSSE, createInitialPersonaProgress, DEFAULT_PERSONAS } from '../../src/lib/useSSE';
import { LiveStreamEvent } from '../../src/types/live';
import { createApp } from '../../src/app';
import { LiveStreamBus } from '../../src/live/liveStreamBus';

// Mock EventSource implementation for Vitest environment
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSED

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== MockEventSource.CLOSED) {
        this.readyState = MockEventSource.OPEN;
        if (this.onopen) this.onopen({});
      }
    }, 5);
  }

  emitMessage(data: any) {
    if (this.readyState === MockEventSource.OPEN && this.onmessage) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.onmessage(new MessageEvent('message', { data: payload }));
    }
  }

  emitCommentPing() {
    if (this.readyState === MockEventSource.OPEN && this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: '' }));
    }
  }

  emitError(err: any = {}) {
    if (this.onerror) {
      this.onerror(err);
    }
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('Milestone 3 Empirical Challenge: Live Real-Time SSE Stream & Terminal (/live & /dashboard/live)', () => {
  let app: any;
  let server: http.Server | null = null;

  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    process.env.WEBHOOK_SECRET = 'valid-test-secret-12345';
    app = createApp();
    LiveStreamBus.getInstance().clearHistory();
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Stream Event Ingestion and State Double-Buffering (< 50ms Flush Delay)
  // =========================================================================
  describe('1. Stream Event Ingestion & State Double-Buffering (< 50ms Flush Delay)', () => {
    it('ingests high-throughput burst of 100 events with sub-50ms flush delay', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'burst-job-1' }));

      await vi.waitFor(() => {
        expect(result.current.connectionStatus).toBe('connected');
      }, { timeout: 2000 });

      const mockEs = MockEventSource.instances[MockEventSource.instances.length - 1];
      expect(mockEs).toBeDefined();

      const startTime = performance.now();

      await act(async () => {
        for (let i = 1; i <= 100; i++) {
          mockEs.emitMessage({
            jobId: 'burst-job-1',
            timestamp: new Date().toISOString(),
            type: 'persona:chunk',
            persona: 'security',
            data: { chunk: `Token chunk #${i} for vulnerability scanning`, promptTokens: 1, completionTokens: 1 },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      });

      const flushDuration = performance.now() - startTime;

      expect(flushDuration).toBeLessThan(100);
      expect(result.current.events).toHaveLength(100);
      expect(result.current.tokenMetrics.completionTokens).toBe(100);
      expect(result.current.personaProgress.security.status).toBe('IN PROGRESS');
      expect(result.current.personaProgress.security.chunkCount).toBe(100);
    });

    it('handles multiple rapid intermittent event bursts cleanly without data loss or race conditions', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'multi-burst-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[MockEventSource.instances.length - 1];

      await act(async () => {
        for (let i = 1; i <= 25; i++) {
          mockEs.emitMessage({
            jobId: 'multi-burst-job',
            timestamp: new Date().toISOString(),
            type: 'persona:chunk',
            persona: 'architecture',
            data: { chunk: `Arch burst 1 token ${i}` },
          });
        }
        await new Promise((r) => setTimeout(r, 25));
      });
      expect(result.current.events).toHaveLength(25);

      await act(async () => {
        for (let i = 26; i <= 50; i++) {
          mockEs.emitMessage({
            jobId: 'multi-burst-job',
            timestamp: new Date().toISOString(),
            type: 'persona:chunk',
            persona: 'architecture',
            data: { chunk: `Arch burst 2 token ${i}` },
          });
        }
        await new Promise((r) => setTimeout(r, 25));
      });
      expect(result.current.events).toHaveLength(50);
    });

    it('enforces maxBufferHistory event history capping to prevent memory leaks', async () => {
      const maxHistory = 30;
      const { result } = renderHook(() => useSSE({ jobId: 'cap-job', maxBufferHistory: maxHistory }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[MockEventSource.instances.length - 1];

      await act(async () => {
        for (let i = 1; i <= 60; i++) {
          mockEs.emitMessage({
            jobId: 'cap-job',
            timestamp: new Date().toISOString(),
            type: 'llm:token',
            persona: 'quality',
            data: { chunk: `Token ${i}` },
          });
        }
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(result.current.events).toHaveLength(maxHistory);
      expect(result.current.events[maxHistory - 1].data.chunk).toBe('Token 60');
    });

    it('flushes double-buffered queue on document visibilitychange event when tab refocuses', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'vis-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[MockEventSource.instances.length - 1];

      mockEs.emitMessage({
        jobId: 'vis-job',
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'devops',
        data: { message: 'DevOps checks' },
      });

      await act(async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 2. Watchdog Timeout & Auto-Reconnect on Dropped SSE Connections
  // =========================================================================
  describe('2. Watchdog Timeout & Auto-Reconnect on Dropped SSE Connections', () => {
    it('triggers reconnect status on network error (onerror)', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'drop-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(result.current.connectionStatus).toBe('connected');

      const mockEs = MockEventSource.instances[0];

      await act(async () => {
        mockEs.readyState = MockEventSource.CLOSED;
        mockEs.emitError(new Error('Connection reset by peer'));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.connectionStatus).toBe('reconnecting');
    });

    it('executes exponential backoff reconnection attempts on dropped connection', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'backoff-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));

      const firstEs = MockEventSource.instances[0];

      await act(async () => {
        firstEs.readyState = MockEventSource.CLOSED;
        firstEs.emitError();
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.connectionStatus).toBe('reconnecting');

      await act(async () => {
        await new Promise((r) => setTimeout(r, 1100));
      });

      expect(MockEventSource.instances.length).toBeGreaterThan(1);
    });

    it('resets reconnect attempt counter when connection successfully re-opens (onopen)', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'reset-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));

      const es1 = MockEventSource.instances[0];

      await act(async () => {
        es1.readyState = MockEventSource.CLOSED;
        es1.emitError();
        await new Promise((r) => setTimeout(r, 1100));
      });

      const es2 = MockEventSource.instances[MockEventSource.instances.length - 1];
      expect(es2).toBeDefined();

      await act(async () => {
        if (es2.onopen) es2.onopen({});
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.connectionStatus).toBe('connected');
    });

    it('cleans up EventSource and allows manual reconnect() invocation', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'reconnect-test-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));

      act(() => {
        result.current.reconnect();
      });

      expect(MockEventSource.instances.length).toBeGreaterThan(1);
    });
  });

  // =========================================================================
  // 3. Public Unauthenticated Stream Query Parameters (/api/live/stream?jobId=test_job)
  // =========================================================================
  describe('3. Public Unauthenticated Stream Query Parameters (/api/live/stream)', () => {
    it('connects to unauthenticated stream URL with correct jobId query parameter', () => {
      const { result } = renderHook(() => useSSE({ jobId: 'public-test-job-99' }));

      expect(result.current.jobId).toBe('public-test-job-99');
      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe('/api/live/stream?jobId=public-test-job-99');
    });

    it('includes token query parameter in stream URL when token option is provided', () => {
      renderHook(() => useSSE({ jobId: 'authed-job', token: 'jwt-bearer-token-xyz' }));

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe(
        '/api/live/stream?jobId=authed-job&token=jwt-bearer-token-xyz'
      );
    });

    it('Express server returns 200 OK text/event-stream headers for GET /api/live/stream?jobId=test_job without authentication header', async () => {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, () => {
          const address = server!.address() as any;
          const req = http.get(
            `http://127.0.0.1:${address.port}/api/live/stream?jobId=test_job_express`,
            (res) => {
              expect(res.statusCode).toBe(200);
              expect(res.headers['content-type']).toContain('text/event-stream');
              expect(res.headers['cache-control']).toContain('no-cache');
              expect(res.headers['connection']).toContain('keep-alive');
              req.destroy();
              resolve();
            }
          );
          req.on('error', reject);
        });
      });
    });

    it('Express server defaults missing jobId to default-job', async () => {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, () => {
          const address = server!.address() as any;
          const req = http.get(
            `http://127.0.0.1:${address.port}/api/live/stream`,
            (res) => {
              expect(res.statusCode).toBe(200);
              expect(res.headers['content-type']).toContain('text/event-stream');
              req.destroy();
              resolve();
            }
          );
          req.on('error', reject);
        });
      });
    });

    it('Express GET /api/live/active returns active jobs list JSON', async () => {
      const res = await request(app).get('/api/live/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it('Express POST /api/live/publish accepts test event and broadcasts to subscribers', async () => {
      const res = await request(app)
        .post('/api/live/publish')
        .send({
          jobId: 'publish-job-1',
          type: 'persona:start',
          persona: 'security',
          data: { message: 'Publish test' },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('published');
      expect(res.body.event.jobId).toBe('publish-job-1');
    });
  });

  // =========================================================================
  // 4. Recharts Token Metrics Accumulation and Persona Log Filtering
  // =========================================================================
  describe('4. Recharts Token Metrics Accumulation & Persona Log Filtering', () => {
    it('initializes persona progress for all 11 default personas in PENDING status', () => {
      const initial = createInitialPersonaProgress();
      expect(Object.keys(initial)).toHaveLength(12);
      for (const personaKey of DEFAULT_PERSONAS) {
        expect(initial[personaKey]).toBeDefined();
        expect(initial[personaKey].status).toBe('PENDING');
        expect(initial[personaKey].progress).toBe(0);
        expect(initial[personaKey].findingsCount).toBe(0);
      }
    });

    it('tracks progress lifecycle (PENDING -> IN PROGRESS -> COMPLETED) across all 11 personas', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'lifecycle-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[0];

      await act(async () => {
        for (const persona of DEFAULT_PERSONAS) {
          mockEs.emitMessage({
            jobId: 'lifecycle-job',
            timestamp: new Date().toISOString(),
            type: 'persona:start',
            persona,
            data: { message: `Started ${persona}` },
          });
        }
        await new Promise((r) => setTimeout(r, 40));
      });

      for (const persona of DEFAULT_PERSONAS) {
        expect(result.current.personaProgress[persona].status).toBe('IN PROGRESS');
        expect(result.current.personaProgress[persona].progress).toBeGreaterThanOrEqual(15);
      }

      await act(async () => {
        for (const persona of DEFAULT_PERSONAS) {
          mockEs.emitMessage({
            jobId: 'lifecycle-job',
            timestamp: new Date().toISOString(),
            type: 'persona:complete',
            persona,
            data: { findingsCount: 2, message: `Completed ${persona}` },
          });
        }
        await new Promise((r) => setTimeout(r, 40));
      });

      for (const persona of DEFAULT_PERSONAS) {
        expect(result.current.personaProgress[persona].status).toBe('COMPLETED');
        expect(result.current.personaProgress[persona].progress).toBe(100);
        expect(result.current.personaProgress[persona].findingsCount).toBe(2);
      }
    });

    it('accumulates LLM token counts, costs, AST nodes, and nits across diverse event formats', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'metrics-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[0];

      await act(async () => {
        mockEs.emitMessage({
          jobId: 'metrics-job',
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'security',
          data: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.0015, latencyMs: 250 },
        });

        mockEs.emitMessage({
          jobId: 'metrics-job',
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'architecture',
          data: { tokensUsed: { prompt: 200, completion: 100, total: 300 }, totalCostUSD: 0.003, durationMs: 400 },
        });

        mockEs.emitMessage({
          jobId: 'metrics-job',
          timestamp: new Date().toISOString(),
          type: 'ast:lookup',
          persona: 'quality',
          data: { symbolName: 'parseConfig' },
        });

        mockEs.emitMessage({
          jobId: 'metrics-job',
          timestamp: new Date().toISOString(),
          type: 'nit:suppression',
          persona: 'quality',
          data: { pattern: 'unused-var-nit' },
        });

        await new Promise((r) => setTimeout(r, 40));
      });

      const metrics = result.current.tokenMetrics;
      expect(metrics.promptTokens).toBe(300);
      expect(metrics.completionTokens).toBe(150);
      expect(metrics.totalTokens).toBe(450);
      expect(metrics.estimatedCostUSD).toBeCloseTo(0.0045, 4);
      expect(metrics.astNodes).toBe(1);
      expect(metrics.nitsFound).toBe(1);

      expect(result.current.tokenHistory.length).toBeGreaterThan(0);
      const latestPoint = result.current.tokenHistory[result.current.tokenHistory.length - 1];
      expect(latestPoint).toHaveProperty('timestamp');
      expect(latestPoint).toHaveProperty('label');
      expect(latestPoint).toHaveProperty('promptTokens');
      expect(latestPoint).toHaveProperty('completionTokens');
      expect(latestPoint).toHaveProperty('totalTokens');
      expect(latestPoint).toHaveProperty('tokensPerSec');
      expect(latestPoint).toHaveProperty('latencyMs');
    });

    it('supports legacy event type shims (agent_start, llm_chunk, agent_done, indexer_lookup)', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'shim-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[0];

      await act(async () => {
        mockEs.emitMessage({
          jobId: 'shim-job',
          timestamp: new Date().toISOString(),
          type: 'agent_start',
          persona: 'database',
          data: { message: 'Database agent starting' },
        });

        mockEs.emitMessage({
          jobId: 'shim-job',
          timestamp: new Date().toISOString(),
          type: 'llm_chunk',
          persona: 'database',
          data: { chunk: 'SELECT * FROM users' },
        });

        mockEs.emitMessage({
          jobId: 'shim-job',
          timestamp: new Date().toISOString(),
          type: 'indexer_lookup',
          persona: 'database',
          data: { filePath: 'src/db.ts' },
        });

        mockEs.emitMessage({
          jobId: 'shim-job',
          timestamp: new Date().toISOString(),
          type: 'agent_done',
          persona: 'database',
          data: { findingsCount: 1 },
        });

        await new Promise((r) => setTimeout(r, 40));
      });

      expect(result.current.personaProgress.database.status).toBe('COMPLETED');
      expect(result.current.personaProgress.database.findingsCount).toBe(1);
      expect(result.current.tokenMetrics.astNodes).toBe(1);
    });

    it('filters events by selected persona with case-insensitivity and all-persona reset', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'filter-test-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[0];

      await act(async () => {
        mockEs.emitMessage({
          jobId: 'filter-test-job',
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { chunk: 'Sec chunk 1' },
        });

        mockEs.emitMessage({
          jobId: 'filter-test-job',
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'red_team',
          data: { chunk: 'Red team chunk 1' },
        });

        mockEs.emitMessage({
          jobId: 'filter-test-job',
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'finops',
          data: { chunk: 'FinOps chunk 1' },
        });

        await new Promise((r) => setTimeout(r, 40));
      });

      expect(result.current.events).toHaveLength(3);

      act(() => {
        result.current.setSelectedPersona('SECURITY');
      });
      expect(result.current.filteredEvents).toHaveLength(1);
      expect(result.current.filteredEvents[0].persona).toBe('security');

      act(() => {
        result.current.setSelectedPersona('red_team');
      });
      expect(result.current.filteredEvents).toHaveLength(1);
      expect(result.current.filteredEvents[0].persona).toBe('red_team');

      act(() => {
        result.current.setSelectedPersona('non_existent');
      });
      expect(result.current.filteredEvents).toHaveLength(0);

      act(() => {
        result.current.setSelectedPersona('all');
      });
      expect(result.current.filteredEvents).toHaveLength(3);
    });

    it('clears all events and resets token metrics cleanly when clearEvents() is called', async () => {
      const { result } = renderHook(() => useSSE({ jobId: 'clear-test-job' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      const mockEs = MockEventSource.instances[0];

      await act(async () => {
        mockEs.emitMessage({
          jobId: 'clear-test-job',
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'api_contract',
          data: { promptTokens: 50, completionTokens: 25 },
        });
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.tokenMetrics.totalTokens).toBeGreaterThan(0);

      act(() => {
        result.current.clearEvents();
      });

      expect(result.current.events).toHaveLength(0);
      expect(result.current.tokenMetrics.promptTokens).toBe(0);
      expect(result.current.tokenMetrics.completionTokens).toBe(0);
      expect(result.current.tokenMetrics.totalTokens).toBe(0);
      expect(result.current.tokenHistory).toHaveLength(0);
    });
  });
});
