import { timeBudgetMs } from '../support/timeBudget';
// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import express, { Response } from 'express';
import { EventEmitter } from 'events';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';
import { useSSE, DEFAULT_PERSONAS } from '../../src/lib/useSSE';
import { TerminalFeed } from '../../src/components/live/terminal-feed';
import { PersonaTabs } from '../../src/components/live/persona-tabs';
import { PersonaProgressGrid } from '../../src/components/live/persona-progress-grid';
import { StreamingMetricsCharts } from '../../src/components/live/streaming-metrics-charts';
import { ActiveJobsSidebar } from '../../src/components/live/active-jobs-sidebar';

// Mock ResizeObserver for Recharts in jsdom
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.ResizeObserver =
      window.ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
});

// Mock EventSource for Vitest environment
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 10);
  }

  emitMessage(data: any) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  close() {
    this.readyState = 2;
  }
}

describe('Milestone 3 Empirical Stress Harness: High-Frequency SSE Streams & Live Terminal (`/live`)', () => {
  let bus: LiveStreamBus;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    bus.clearHistory();
    vi.restoreAllMocks();
  });

  describe('1. High-Frequency SSE Event Stream Bursts (500+ Events)', () => {
    it('verifies zero event loss and state accuracy across 600 rapid events to LiveStreamBus', () => {
      const jobId = 'job_stress_m3_burst_600';
      const eventCount = 600;
      let expectedPromptTokens = 0;
      let expectedCompletionTokens = 0;

      const startTime = performance.now();

      // Publish 600 events across all 11 personas
      for (let i = 1; i <= eventCount; i++) {
        const persona = DEFAULT_PERSONAS[(i - 1) % DEFAULT_PERSONAS.length];
        const pTokens = 10;
        const cTokens = 5;
        expectedPromptTokens += pTokens;
        expectedCompletionTokens += cTokens;

        let type: any = 'persona:chunk';
        const numPersonas = DEFAULT_PERSONAS.length;
        if (i <= numPersonas) {
          type = 'persona:start';
        } else if (i > (600 - numPersonas)) {
          type = 'persona:complete';
        }

        bus.publishEvent({
          jobId,
          timestamp: new Date(Date.now() + i * 10).toISOString(),
          type,
          persona,
          data: {
            chunk: `Log chunk #${i} from persona ${persona}`,
            promptTokens: pTokens,
            completionTokens: cTokens,
            totalTokens: pTokens + cTokens,
            costUSD: 0.0001,
            findingsCount: type === 'persona:complete' ? 2 : 0,
          },
        });
      }

      const durationMs = performance.now() - startTime;
      const history = bus.getHistory(jobId);
      const jobSummary = bus.getJobStatus(jobId);

      // Verify burst speed (< 1000ms for 600 events)
      expect(durationMs).toBeLessThan(timeBudgetMs(1000));

      // Verify history ring buffer capped at 500
      expect(history.length).toBe(500);

      // Verify summary job state accumulation across all 600 events
      expect(jobSummary).toBeDefined();
      expect(jobSummary?.eventCount).toBe(600);
      expect(jobSummary?.tokenMetrics.promptTokens).toBe(expectedPromptTokens);
      expect(jobSummary?.tokenMetrics.completionTokens).toBe(expectedCompletionTokens);
      expect(jobSummary?.tokenMetrics.totalTokens).toBe(expectedPromptTokens + expectedCompletionTokens);
      expect(jobSummary?.tokenMetrics.estimatedCostUSD).toBeCloseTo(0.06, 2);

      // Verify all 11 personas were tracked in job summary
      for (const p of DEFAULT_PERSONAS) {
        expect(jobSummary?.personaProgress[p]).toBeDefined();
        expect(jobSummary?.personaProgress[p].status).toBe('completed');
      }
    });

    it('verifies useSSE hook processes 600 rapid SSE events without state corruption or NaN metrics', async () => {
      const jobId = 'job_use_sse_burst_600';
      const { result } = renderHook(() => useSSE({ jobId, maxBufferHistory: 500 }));

      const mockEs = MockEventSource.instances[0];
      expect(mockEs).toBeDefined();

      await act(async () => {
        // Emit 600 events rapidly
        for (let i = 1; i <= 600; i++) {
          const numPersonas = DEFAULT_PERSONAS.length;
          const persona = DEFAULT_PERSONAS[(i - 1) % numPersonas];
          const type = i <= numPersonas ? 'persona:start' : i > (600 - numPersonas) ? 'persona:complete' : 'persona:chunk';
          mockEs.emitMessage({
            jobId,
            timestamp: new Date().toISOString(),
            type,
            persona,
            data: {
              chunk: `Fast event chunk ${i}`,
              promptTokens: 20,
              completionTokens: 10,
              costUSD: 0.0002,
              latencyMs: 150,
            },
          });
        }

        // Allow batching queue flush
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Verify hook events capped at maxBufferHistory (500)
      expect(result.current.events.length).toBe(500);

      // Verify token metrics aggregated cleanly without NaN
      expect(result.current.tokenMetrics.promptTokens).toBe(12000); // 600 * 20
      expect(result.current.tokenMetrics.completionTokens).toBe(6000); // 600 * 10
      expect(result.current.tokenMetrics.totalTokens).toBe(18000);
      expect(result.current.tokenMetrics.estimatedCostUSD).toBeCloseTo(0.12, 2);
      expect(result.current.tokenMetrics.tokensPerSec).toBeGreaterThan(0);
      expect(isNaN(result.current.tokenMetrics.tokensPerSec)).toBe(false);

      // Verify persona progress states mapped all 11 personas
      for (const p of DEFAULT_PERSONAS) {
        const prog = result.current.personaProgress[p];
        expect(prog).toBeDefined();
        expect(prog.status).toBe('COMPLETED');
        expect(prog.progress).toBe(100);
      }
    });
  });

  describe('2. Terminal Feed Line Capping & Ring Buffer Stability', () => {
    it('verifies TerminalFeed renders 500+ log lines with 1-indexed line numbers without breaking layout', () => {
      const mockEvents: LiveStreamEvent[] = [];
      const totalEvents = 550;
      const handleClear = vi.fn();

      for (let i = 1; i <= totalEvents; i++) {
        mockEvents.push({
          jobId: 'job_terminal_cap',
          timestamp: new Date(1700000000000 + i * 1000).toISOString(),
          type: i % 10 === 0 ? 'ast:lookup' : i % 5 === 0 ? 'persona:chunk' : 'llm:token',
          persona: DEFAULT_PERSONAS[(i - 1) % DEFAULT_PERSONAS.length],
          data: {
            chunk: i % 7 === 0 ? `Multiline log\nSecond line for event ${i}` : `Standard log line #${i}`,
            isError: i % 50 === 0,
          },
        });
      }

      render(React.createElement(TerminalFeed, { events: mockEvents, selectedPersona: 'all', onClear: handleClear }));

      // Verify line counter header displays total line count
      expect(screen.getByText('Terminal Feed')).toBeDefined();
      expect(screen.getByText(/lines/)).toBeDefined();

      // Check first line and last line 1-indexed line numbers exist
      expect(screen.getByText('1')).toBeDefined();
      expect(screen.getByText('550')).toBeDefined();

      // Check clear button functionality
      const clearBtn = screen.getByText('Clear');
      expect(clearBtn).toBeDefined();
      fireEvent.click(clearBtn);
      expect(handleClear).toHaveBeenCalledTimes(1);
    });

    it('verifies search query filtering on high-volume terminal feed performs instantly', () => {
      const mockEvents: LiveStreamEvent[] = [];
      for (let i = 1; i <= 500; i++) {
        mockEvents.push({
          jobId: 'job_search_perf',
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: i % 2 === 0 ? 'security' : 'devops',
          data: {
            chunk: i === 250 ? 'CRITICAL_VULNERABILITY_FOUND: SQL Injection in auth.ts' : `Normal log payload index ${i}`,
          },
        });
      }

      render(React.createElement(TerminalFeed, { events: mockEvents }));

      const searchInput = screen.getByPlaceholderText('Search terminal output...');
      
      const startTime = performance.now();
      fireEvent.change(searchInput, { target: { value: 'CRITICAL_VULNERABILITY' } });
      const durationMs = performance.now() - startTime;

      // Filtering 500 lines should be < 50ms
      expect(durationMs).toBeLessThan(timeBudgetMs(50));
      expect(screen.getByText(/CRITICAL_VULNERABILITY_FOUND/)).toBeDefined();
      expect(screen.queryByText(/Normal log payload index 1/)).toBeNull();
    });

    it('verifies ring buffer overflow prunes exact oldest events when crossing 500 threshold in LiveStreamBus', () => {
      const jobId = 'job_ring_buffer_prune';

      for (let i = 1; i <= 750; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { seq: i },
        });
      }

      const history = bus.getHistory(jobId);
      expect(history.length).toBe(500);

      // Oldest retained event should be seq 251 (750 - 500 + 1)
      expect(history[0].data.seq).toBe(251);
      // Newest retained event should be seq 750
      expect(history[499].data.seq).toBe(750);
    });
  });

  describe('3. Public Link Direct Access & SSE Stream Integration', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/live', createLiveRouter());
    });

    function mockGetRequest(app: express.Express, urlPath: string) {
      return new Promise<{ statusCode: number; headers: Record<string, string>; body: any }>((resolve) => {
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
        res.setHeader = (k: string, v: string) => {
          res.headers[k.toLowerCase()] = v;
        };
        res.getHeader = (k: string) => res.headers[k.toLowerCase()];
        res.status = (code: number) => {
          res.statusCode = code;
          return res;
        };
        res.json = (data: any) => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        };
        res.write = () => true;
        res.flushHeaders = () => {};

        app(req, res);

        setImmediate(() => {
          if (res.headers['content-type'] === 'text/event-stream') {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: null });
          }
        });
      });
    }

    it('allows direct unauthenticated public link connections (`/api/live/stream?jobId=...`) with HTTP 200 SSE stream', async () => {
      const res = await mockGetRequest(app, '/api/live/stream?jobId=job_public_direct_link_pr42');

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
    });

    it('serves active jobs list via `/api/live/active` endpoint for public dashboard sidebar', async () => {
      // Publish 2 events to register active job in bus
      bus.publishEvent({
        jobId: 'job_calltelemetry_cisco-cdr_pr42_abc123',
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { repo: 'calltelemetry/cisco-cdr', prNumber: 42 },
      });

      const res = await mockGetRequest(app, '/api/live/active');

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(1);
      expect(res.body.jobs[0].jobId).toBe('job_calltelemetry_cisco-cdr_pr42_abc123');
      expect(res.body.jobs[0].repo).toBe('calltelemetry/cisco-cdr');
      expect(res.body.jobs[0].prNumber).toBe(42);
    });

    it('serves event history via `/api/live/history?jobId=...` for late-joining connections', async () => {
      const jobId = 'job_history_replay';

      for (let i = 1; i <= 25; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'quality',
          data: { seq: i },
        });
      }

      const res = await mockGetRequest(app, `/api/live/history?jobId=${jobId}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.jobId).toBe(jobId);
      expect(res.body.count).toBe(25);
      expect(res.body.events).toHaveLength(25);
      expect(res.body.events[0].data.seq).toBe(1);
      expect(res.body.events[24].data.seq).toBe(25);
    });
  });

  describe('4. Full UI Components Stress Test under High Event Throughput', () => {
    it('renders all live components together with 500+ events without React rendering errors or visual glitches', () => {
      const mockEvents: LiveStreamEvent[] = [];
      const mockProgress: Record<string, any> = {};

      DEFAULT_PERSONAS.forEach((p, idx) => {
        mockProgress[p] = {
          persona: p,
          status: idx % 2 === 0 ? 'COMPLETED' : 'IN PROGRESS',
          progress: idx % 2 === 0 ? 100 : 65,
          findingsCount: idx * 2,
          lastMessage: `Persona ${p} active evaluation...`,
        };
      });

      for (let i = 1; i <= 500; i++) {
        const persona = DEFAULT_PERSONAS[(i - 1) % DEFAULT_PERSONAS.length];
        mockEvents.push({
          jobId: 'job_full_ui_stress',
          timestamp: new Date().toISOString(),
          type: i % 4 === 0 ? 'persona:start' : i % 4 === 1 ? 'persona:chunk' : i % 4 === 2 ? 'ast:lookup' : 'persona:complete',
          persona,
          data: {
            chunk: `High throughput log line event #${i}`,
            promptTokens: 50,
            completionTokens: 25,
            totalTokens: 75,
            costUSD: 0.0005,
            latencyMs: 120,
          },
        });
      }

      const mockMetrics = {
        promptTokens: 25000,
        completionTokens: 12500,
        totalTokens: 37500,
        estimatedCostUSD: 0.25,
        tokensPerSec: 150.5,
        latencyMs: 120,
        astNodes: 125,
        nitsFound: 15,
      };

      const mockHistory = [
        {
          timestamp: new Date().toISOString(),
          label: '09:00:00',
          promptTokens: 25000,
          completionTokens: 12500,
          totalTokens: 37500,
          tokensPerSec: 150.5,
          latencyMs: 120,
        },
      ];

      const mockJobs = [
        {
          jobId: 'job_full_ui_stress',
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 99,
          title: 'High Throughput Stream PR',
          status: 'active' as const,
          personaProgress: {},
          tokenMetrics: mockMetrics,
          startTime: new Date().toISOString(),
          eventCount: 500,
          lastEventTime: new Date().toISOString(),
        },
      ];

      // Render full suite of live components using React.createElement
      render(
        React.createElement(
          'div',
          { className: 'space-y-6' },
          React.createElement(ActiveJobsSidebar, { currentJobId: 'job_full_ui_stress', onSelectJob: vi.fn(), activeJobs: mockJobs }),
          React.createElement(PersonaTabs, { selectedPersona: 'all', onSelectPersona: vi.fn(), events: mockEvents }),
          React.createElement(PersonaProgressGrid, { personaProgress: mockProgress }),
          React.createElement(StreamingMetricsCharts, { metrics: mockMetrics, history: mockHistory }),
          React.createElement(TerminalFeed, { events: mockEvents, selectedPersona: 'all' })
        )
      );

      // Verify key visual indicators render without crashing
      expect(screen.getByText('High Throughput Stream PR')).toBeDefined();
      expect(screen.getByText('calltelemetry/cisco-cdr')).toBeDefined();
      expect(screen.getByText('All Personas')).toBeDefined();
      expect(screen.getByText('Terminal Feed')).toBeDefined();

      // Check metrics stat cards
      expect(screen.getByText('25,000')).toBeDefined();
      expect(screen.getByText('12,500')).toBeDefined();
      expect(screen.getByText('37,500')).toBeDefined();
      expect(screen.getByText('$0.2500')).toBeDefined();
      expect(screen.getByText('150.5 t/s')).toBeDefined();

      // Check persona progress grid items
      expect(screen.getAllByText('COMPLETED').length).toBeGreaterThan(0);
      expect(screen.getAllByText('IN PROGRESS').length).toBeGreaterThan(0);
    });
  });
});
