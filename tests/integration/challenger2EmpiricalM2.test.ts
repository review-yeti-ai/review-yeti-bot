import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express, Request, Response } from 'express';
import { EventEmitter } from 'events';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';

describe('Empirical Challenger 2 Suite — SSE Live Streaming Edge Cases & Stress', () => {
  let bus: LiveStreamBus;
  let app: Express;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
    app = express();
    app.use(express.json());
    app.use('/api/live', createLiveRouter());
  });

  afterEach(() => {
    bus.clearHistory();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  function mockRequest(app: Express, method: string, urlPath: string, body?: any) {
    return new Promise<{ status: number; body: any; headers: Record<string, string>; resMock: any }>((resolve) => {
      const [pathOnly, queryString] = urlPath.split('?');
      const queryParams: Record<string, any> = {};
      if (queryString) {
        const searchParams = new URLSearchParams(queryString);
        for (const [k, v] of searchParams.entries()) {
          if (queryParams[k]) {
            if (Array.isArray(queryParams[k])) {
              queryParams[k].push(v);
            } else {
              queryParams[k] = [queryParams[k], v];
            }
          } else {
            queryParams[k] = v;
          }
        }
      }

      const req: any = new EventEmitter();
      req.method = method;
      req.url = urlPath;
      req.path = pathOnly;
      req.query = queryParams;
      req.headers = { 'content-type': 'application/json' };
      req.body = body;

      let statusCode = 200;
      let responseBody: any = null;
      const headers: Record<string, string> = {};

      const res: any = new EventEmitter();
      res.statusCode = 200;
      res.headers = headers;
      res.setHeader = (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      };
      res.getHeader = (k: string) => headers[k.toLowerCase()];
      res.status = (code: number) => {
        statusCode = code;
        res.statusCode = code;
        return res;
      };
      res.json = (data: any) => {
        responseBody = data;
        resolve({ status: statusCode, body: data, headers, resMock: res });
      };
      res.send = (data: any) => {
        responseBody = data;
        resolve({ status: statusCode, body: data, headers, resMock: res });
      };
      res.flushHeaders = () => {};
      res.write = (chunk: string) => {
        if (!res.writtenChunks) res.writtenChunks = [];
        res.writtenChunks.push(chunk);
        return true;
      };

      app(req, res);

      setImmediate(() => {
        if (headers['content-type'] === 'text/event-stream') {
          resolve({ status: statusCode, body: responseBody, headers, resMock: res });
        }
      });
    });
  }

  describe('1. Client Disconnect Scenarios & Timer Cleanups', () => {
    it('cleans up client set and interval timer immediately when res emits close', () => {
      const jobId = 'job_disc_1';
      const mockRes = createMockResponse();

      bus.addClient(jobId, mockRes);

      const clientsMap = (bus as any).clients as Map<string, Set<any>>;
      const pingMap = (bus as any).pingIntervals as Map<any, any>;

      expect(clientsMap.get(jobId)?.has(mockRes)).toBe(true);
      expect(pingMap.has(mockRes)).toBe(true);

      mockRes.emitClose();

      expect(clientsMap.has(jobId)).toBe(false);
      expect(pingMap.has(mockRes)).toBe(false);
    });

    it('handles write failure during publishEvent without crashing and cleans up client', () => {
      const jobId = 'job_disc_write_fail';
      const mockRes = createMockResponse();

      bus.addClient(jobId, mockRes);
      mockRes.write = () => {
        throw new Error('EPIPE: broken pipe');
      };

      expect(() => {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { chunk: 'test' },
        });
      }).not.toThrow();

      const clientsMap = (bus as any).clients as Map<string, Set<any>>;
      const pingMap = (bus as any).pingIntervals as Map<any, any>;
      expect(clientsMap.has(jobId)).toBe(false);
      expect(pingMap.has(mockRes)).toBe(false);
    });

    it('survives rapid 100 connect/disconnect cycles without leaking ping timers', () => {
      const jobId = 'job_rapid_cycling';
      const pingMap = (bus as any).pingIntervals as Map<any, any>;
      const clientsMap = (bus as any).clients as Map<string, Set<any>>;

      for (let i = 0; i < 100; i++) {
        const res = createMockResponse();
        bus.addClient(jobId, res);
        expect(pingMap.has(res)).toBe(true);
        res.emitClose();
        expect(pingMap.has(res)).toBe(false);
      }

      expect(clientsMap.has(jobId)).toBe(false);
      expect(pingMap.size).toBe(0);
    });

    it('aborts history replay and cleans up client if write fails during addClient history loop', () => {
      const jobId = 'job_fail_history_replay';
      for (let i = 1; i <= 5; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { i },
        });
      }

      const mockRes = createMockResponse();
      let writeCount = 0;
      mockRes.write = () => {
        writeCount++;
        if (writeCount === 3) {
          throw new Error('Network reset mid-history-replay');
        }
        return true;
      };

      bus.addClient(jobId, mockRes);

      const clientsMap = (bus as any).clients as Map<string, Set<any>>;
      const pingMap = (bus as any).pingIntervals as Map<any, any>;

      expect(clientsMap.has(jobId)).toBe(false);
      expect(pingMap.has(mockRes)).toBe(false);
    });
  });

  describe('2. Stream Reconnection & History Playback Integrity', () => {
    it('allows client to reconnect after disconnect and receive complete history in chronological order', () => {
      const jobId = 'job_reconnect_integrity';

      for (let i = 1; i <= 3; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { step: i },
        });
      }

      const client1 = createMockResponse();
      bus.addClient(jobId, client1);
      expect(client1.written.length).toBe(3);
      client1.emitClose();

      for (let i = 4; i <= 5; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { step: i },
        });
      }

      const client2 = createMockResponse();
      bus.addClient(jobId, client2);

      expect(client2.written.length).toBe(5);
      const steps = client2.written.map((chunk) => {
        const json = JSON.parse(chunk.replace('data: ', '').trim());
        return json.data.step;
      });
      expect(steps).toEqual([1, 2, 3, 4, 5]);
    });

    it('reconnects after 550 events and receives exact 500 pruned historical events', () => {
      const jobId = 'job_reconnect_pruned';
      for (let i = 1; i <= 550; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'quality',
          data: { seq: i },
        });
      }

      const res = createMockResponse();
      bus.addClient(jobId, res);

      expect(res.written.length).toBe(500);
      const firstEvt = JSON.parse(res.written[0].replace('data: ', '').trim());
      const lastEvt = JSON.parse(res.written[499].replace('data: ', '').trim());

      expect(firstEvt.data.seq).toBe(51);
      expect(lastEvt.data.seq).toBe(550);
    });
  });

  describe('3. Heartbeat Emission & Timers', () => {
    it('emits `: ping\\n\\n` every 15 seconds to active clients', () => {
      vi.useFakeTimers();
      const jobId = 'job_heartbeat_test';
      const mockRes = createMockResponse();

      bus.addClient(jobId, mockRes);
      expect(mockRes.written.length).toBe(0);

      vi.advanceTimersByTime(15_000);
      expect(mockRes.written.length).toBe(1);
      expect(mockRes.written[0]).toBe(': ping\n\n');

      vi.advanceTimersByTime(15_000);
      expect(mockRes.written.length).toBe(2);
      expect(mockRes.written[1]).toBe(': ping\n\n');

      mockRes.emitClose();
    });

    it('cleans up client cleanly if ping write fails during interval callback', () => {
      vi.useFakeTimers();
      const jobId = 'job_ping_write_fail';
      const mockRes = createMockResponse();

      bus.addClient(jobId, mockRes);

      mockRes.write = () => {
        throw new Error('Socket write failure during ping');
      };

      expect(() => {
        vi.advanceTimersByTime(15_000);
      }).not.toThrow();

      const clientsMap = (bus as any).clients as Map<string, Set<any>>;
      const pingMap = (bus as any).pingIntervals as Map<any, any>;

      expect(clientsMap.has(jobId)).toBe(false);
      expect(pingMap.has(mockRes)).toBe(false);
    });
  });

  describe('4. Missing & Malformed `jobId` Parameters', () => {
    it('defaults missing `jobId` parameter to "default-job" on GET /api/live/stream', async () => {
      const res = await mockRequest(app, 'GET', '/api/live/stream');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('defaults empty `jobId=""` parameter to "default-job" on GET /api/live/stream', async () => {
      const res = await mockRequest(app, 'GET', '/api/live/stream?jobId=');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('defaults missing `jobId` parameter to "default-job" on GET /api/live/history', async () => {
      bus.publishEvent({
        jobId: 'default-job',
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { test: 'default' },
      });

      const res = await mockRequest(app, 'GET', '/api/live/history');
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe('default-job');
      expect(res.body.count).toBe(1);
    });

    it('EMPIRICAL DISCOVERY: reveals array jobId behavior when duplicate ?jobId= query parameters are passed', async () => {
      // Duplicate query params parse as array: req.query.jobId = ['jobA', 'jobB']
      const res = await mockRequest(app, 'GET', '/api/live/stream?jobId=jobA&jobId=jobB');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');

      // Check key in LiveStreamBus clients map
      const clientsMap = (bus as any).clients as Map<any, any>;
      const keys = Array.from(clientsMap.keys());
      // The key in the map is actually an Array object `['jobA', 'jobB']` rather than a string!
      const hasArrayKey = keys.some((k) => Array.isArray(k));
      expect(hasArrayKey).toBe(true);
    });

    it('handles special characters and long string jobId values without crashing bus', () => {
      const weirdJobId = 'job_special_!@#$%^&*()_+ space/slash';
      bus.publishEvent({
        jobId: weirdJobId,
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'quality',
        data: { ok: true },
      });

      const history = bus.getHistory(weirdJobId);
      expect(history.length).toBe(1);
      expect(history[0].jobId).toBe(weirdJobId);

      const mockRes = createMockResponse();
      bus.addClient(weirdJobId, mockRes);
      expect(mockRes.written.length).toBe(1);
      const parsed = JSON.parse(mockRes.written[0].replace('data: ', '').trim());
      expect(parsed.jobId).toBe(weirdJobId);
    });
  });

  describe('5. Empty History & Edge Cases', () => {
    it('returns empty array when history is requested for non-existent jobId', async () => {
      const res = await mockRequest(app, 'GET', '/api/live/history?jobId=job_does_not_exist_999');
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe('job_does_not_exist_999');
      expect(res.body.count).toBe(0);
      expect(res.body.events).toEqual([]);
    });

    it('returns empty jobs list from GET /api/live/active when no jobs have run', async () => {
      const res = await mockRequest(app, 'GET', '/api/live/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(0);
      expect(res.body.jobs).toEqual([]);
    });

    it('handles clearHistory() without breaking connected client streams or throwing errors', () => {
      const jobId = 'job_clear_safety';
      const mockRes = createMockResponse();
      bus.addClient(jobId, mockRes);

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { message: 'before clear' },
      });

      bus.clearHistory(jobId);

      expect(bus.getHistory(jobId)).toEqual([]);
      expect(bus.getJobStatus(jobId)).toBeUndefined();

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { message: 'after clear' },
      });

      expect(mockRes.written.length).toBe(2);
      expect(mockRes.written[1]).toContain('after clear');
    });

    it('handles event with missing optional data fields in updateJobSummary', () => {
      const jobId = 'job_sparse_event';
      const sparseEvent: any = {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:chunk',
        persona: 'security',
      };

      expect(() => {
        bus.publishEvent(sparseEvent);
      }).not.toThrow();

      const summary = bus.getJobStatus(jobId);
      expect(summary).toBeDefined();
      expect(summary?.eventCount).toBe(1);
      expect(summary?.tokenMetrics.totalTokens).toBe(0);
    });
  });
});
