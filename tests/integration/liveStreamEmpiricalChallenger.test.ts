import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Response } from 'express';
import { EventEmitter } from 'events';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';
import { authService } from '../../src/dashboard/authService';
import {
  CommentPublisher,
  getJobId,
  getLiveStreamUrl,
  getOrgDashboardUrl,
  formatDashboardFooter,
  formatInlineCommentBody,
} from '../../src/github/commentPublisher';

describe('LiveStreamBus & SSE API Empirical Stress Harness', () => {
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

  describe('1. High Event Throughput (>1000 Events)', () => {
    it('publishes 2000 events rapidly without memory corruption or queue lag', () => {
      const jobId = 'job_stress_throughput_2000';
      const eventCount = 2000;

      const startTime = performance.now();
      for (let i = 1; i <= eventCount; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'security',
          data: {
            token: `token_${i}`,
            seq: i,
            accumulatedLength: i * 5,
          },
        });
      }
      const durationMs = performance.now() - startTime;
      const eventsPerSec = (eventCount / durationMs) * 1000;

      const history = bus.getHistory(jobId);

      // Verify throughput performance
      expect(durationMs).toBeLessThan(2000); // Should take under 2s
      expect(eventsPerSec).toBeGreaterThan(1000);

      // Verify history ring buffer capped at 500
      expect(history.length).toBe(500);

      // Oldest retained event should be seq 1501 (2000 - 500 + 1)
      expect(history[0].data.seq).toBe(1501);
      expect(history[499].data.seq).toBe(2000);
    });
  });

  describe('2. Concurrent Subscriber Connections', () => {
    it('broadcasts events to 50 concurrent subscribers simultaneously', () => {
      const jobId = 'job_concurrent_subscribers_50';
      const subscriberCount = 50;
      const subscribers: ReturnType<typeof createMockResponse>[] = [];

      for (let i = 0; i < subscriberCount; i++) {
        const mockRes = createMockResponse();
        subscribers.push(mockRes);
        bus.addClient(jobId, mockRes);
      }

      // Verify internal client count
      const activeClients = (bus as any).clients.get(jobId);
      expect(activeClients.size).toBe(subscriberCount);

      // Publish 50 events
      const eventsToPublish = 50;
      for (let e = 1; e <= eventsToPublish; e++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'performance',
          data: { chunk: `broadcast_chunk_${e}` },
        });
      }

      // Each subscriber should have received all 50 published events
      subscribers.forEach((sub) => {
        expect(sub.written.length).toBe(eventsToPublish);
        expect(sub.written[0]).toContain('broadcast_chunk_1');
        expect(sub.written[49]).toContain('broadcast_chunk_50');
      });
    });

    it('handles mixed new subscribers receiving full historical replay upon joining', () => {
      const jobId = 'job_replay_burst';

      // Publish 10 initial events
      for (let i = 1; i <= 10; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'agent_start',
          persona: 'correctness',
          data: { seq: i },
        });
      }

      // Add late-joining client
      const lateClient = createMockResponse();
      bus.addClient(jobId, lateClient);

      // Late client should immediately receive 10 historical events
      expect(lateClient.written.length).toBe(10);
      expect(JSON.parse(lateClient.written[0].replace('data: ', '')).data.seq).toBe(1);
      expect(JSON.parse(lateClient.written[9].replace('data: ', '')).data.seq).toBe(10);

      // Publish 5 more live events
      for (let i = 11; i <= 15; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'correctness',
          data: { seq: i },
        });
      }

      expect(lateClient.written.length).toBe(15);
    });
  });

  describe('3. 500-Event History Ring Buffer Pruning', () => {
    it('prunes exact oldest events when crossing 500 threshold across multiple jobs', () => {
      const job1 = 'job_ring_1';
      const job2 = 'job_ring_2';

      for (let i = 1; i <= 600; i++) {
        bus.publishEvent({
          jobId: job1,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: { index: i },
        });
      }

      for (let j = 1; j <= 300; j++) {
        bus.publishEvent({
          jobId: job2,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'architecture',
          data: { index: j },
        });
      }

      const history1 = bus.getHistory(job1);
      const history2 = bus.getHistory(job2);

      expect(history1.length).toBe(500);
      expect(history1[0].data.index).toBe(101);
      expect(history1[499].data.index).toBe(600);

      expect(history2.length).toBe(300);
      expect(history2[0].data.index).toBe(1);
      expect(history2[299].data.index).toBe(300);
    });
  });

  describe('4. Client Disconnections & Timer Cleanup', () => {
    it('cleans up client map and clears ping interval timer when client disconnects', () => {
      const jobId = 'job_disconnect_test';
      const client1 = createMockResponse();
      const client2 = createMockResponse();

      bus.addClient(jobId, client1);
      bus.addClient(jobId, client2);

      const pingMap = (bus as any).pingIntervals as Map<any, any>;
      expect(pingMap.has(client1)).toBe(true);
      expect(pingMap.has(client2)).toBe(true);

      // Disconnect client1
      client1.emitClose();

      expect(pingMap.has(client1)).toBe(false);
      expect(pingMap.has(client2)).toBe(true);

      // Publishing should write to client2 but NOT client1
      const writeSpy1 = vi.spyOn(client1, 'write');
      const writeSpy2 = vi.spyOn(client2, 'write');

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'job:complete',
        persona: 'quorum',
        data: { message: 'Done' },
      });

      expect(writeSpy1).not.toHaveBeenCalled();
      expect(writeSpy2).toHaveBeenCalled();

      // Disconnect client2 -> clients map for jobId should be deleted
      client2.emitClose();
      expect(pingMap.has(client2)).toBe(false);
      expect((bus as any).clients.has(jobId)).toBe(false);
    });

    it('gracefully handles write failure to disconnected or faulty SSE client during publishEvent', () => {
      const jobId = 'job_faulty_write';
      const faultyClient = createMockResponse();

      bus.addClient(jobId, faultyClient);

      // Force write to throw error simulating broken socket
      faultyClient.write = () => {
        throw new Error('EPIPE: Broken pipe');
      };

      expect(() => {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:start',
          persona: 'security',
          data: { status: 'starting' },
        });
      }).not.toThrow();

      // Faulty client should be automatically cleaned up and removed
      expect((bus as any).clients.has(jobId)).toBe(false);
      expect((bus as any).pingIntervals.has(faultyClient)).toBe(false);
    });
  });

  describe('5. REST SSE Endpoint & Query Token Auth (`/api/live/stream`)', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/live', createLiveRouter());
    });

    function mockRequest(app: express.Express, urlPath: string) {
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

        // If request was accepted and converted to SSE stream, resolve immediately with response headers
        setImmediate(() => {
          if (res.headers['content-type'] === 'text/event-stream') {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: null });
          }
        });
      });
    }

    it('gracefully accepts SSE connection with HTTP 200 fallback when invalid token parameter is provided', async () => {
      const res = await mockRequest(app, '/api/live/stream?jobId=job_auth_1&token=invalid_bad_token_999');

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('accepts SSE connection when valid admin session token is provided via token query param', async () => {
      const session = authService.login('admin', 'admin123');
      expect(session).not.toBeNull();

      const res = await mockRequest(app, `/api/live/stream?jobId=job_auth_2&token=${session!.token}`);

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('accepts SSE connection when valid session token is provided via access_token query param alias', async () => {
      const session = authService.login('admin', 'admin123');
      expect(session).not.toBeNull();

      const res = await mockRequest(app, `/api/live/stream?jobId=job_auth_3&access_token=${session!.token}`);

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('allows SSE stream connection when query token parameter is omitted', async () => {
      const res = await mockRequest(app, '/api/live/stream?jobId=job_auth_4');

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });
  });

  describe('6. CommentPublisher URL Formatting & Link Integrity Verification', () => {
    it('generates correct jobId format and strips single trailing slash on URLs', () => {
      const jobId = getJobId('calltelemetry', 'cisco-cdr', 42, '9f8e7d6c5b4a3210');
      expect(jobId).toBe('job_calltelemetry_cisco-cdr_pr42_9f8e7d6');

      const liveUrl = getLiveStreamUrl('https://bot.calltelemetry.com/', jobId);
      expect(liveUrl).toBe('https://bot.calltelemetry.com/dashboard/live?jobId=job_calltelemetry_cisco-cdr_pr42_9f8e7d6');

      const orgUrl = getOrgDashboardUrl('https://bot.calltelemetry.com/');
      expect(orgUrl).toBe('https://bot.calltelemetry.com/dashboard/organization');
    });

    it('demonstrates URL formatting limitation with multiple trailing slashes', () => {
      const jobId = 'job_test_slashes';
      // Note: getLiveStreamUrl uses .replace(/\/$/, '') which only strips a single trailing slash
      const liveUrlTripleSlash = getLiveStreamUrl('https://bot.calltelemetry.com///', jobId);
      expect(liveUrlTripleSlash).toBe('https://bot.calltelemetry.com///dashboard/live?jobId=job_test_slashes');
    });

    it('formats dashboard footer markdown links with custom verdict badges', () => {
      const liveUrl = 'https://bot.calltelemetry.com/dashboard/live?jobId=job_123';
      const orgUrl = 'https://bot.calltelemetry.com/dashboard/organization';

      const footerApprove = formatDashboardFooter(liveUrl, orgUrl, 'APPROVE');
      expect(footerApprove).toContain(`[📊 Live Terminal Dashboard](${liveUrl})`);
      expect(footerApprove).toContain(`[🏢 Org Settings](${orgUrl})`);
      expect(footerApprove).toContain('---');

      const footerFixFirst = formatDashboardFooter(liveUrl, orgUrl, 'FIX_FIRST');
      expect(footerFixFirst).toContain(`[📊 Live Terminal Dashboard](${liveUrl})`);

      const footerReject = formatDashboardFooter(liveUrl, orgUrl, 'REJECT');
      expect(footerReject).toContain(`[📊 Live Terminal Dashboard](${liveUrl})`);
    });

    it('formats inline comment body with mascot and fix options correctly', () => {
      const body = formatInlineCommentBody(
        {
          persona: 'security',
          severity: 'critical',
          filePath: 'src/auth.ts',
          lineNumber: 15,
          comment: 'Hardcoded credentials found',
          recommendation: 'Use environment variables',
          fixOptions: [
            { rank: 1, title: 'Env Var', explanation: 'Use process.env', suggestionCode: 'const key = process.env.API_KEY;' },
          ],
        },
        { mascot: true }
      );

      expect(body).toContain('CallTelemetry AI Reviewer');
      expect(body).toContain('### [security] Severity: CRITICAL');
      expect(body).toContain('**Finding**: Hardcoded credentials found');
      expect(body).toContain('[RECOMMENDATION] Use environment variables');
      expect(body).toContain('#### Option 1: Env Var (Rank #1)');
      expect(body).toContain('```suggestion\nconst key = process.env.API_KEY;\n```');
    });
  });
});
