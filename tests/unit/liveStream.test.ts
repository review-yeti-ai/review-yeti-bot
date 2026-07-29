import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import express, { Response } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';
import { CommentPublisher } from '../../src/github/commentPublisher';

describe('Live Agent Stream & Terminal View Suite (Release v1.3.0)', () => {
  let bus: LiveStreamBus;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
  });

  describe('Singleton & Event History Isolation', () => {
    it('returns a singleton instance', () => {
      const instance1 = LiveStreamBus.getInstance();
      const instance2 = LiveStreamBus.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('publishes live stream events and maintains event history per jobId', () => {
      const event: LiveStreamEvent = {
        jobId: 'job_test_123',
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'security',
        data: { message: 'Security persona analyzing authentication tokens' },
      };

      bus.publishEvent(event);

      const history = bus.getHistory('job_test_123');
      expect(history.length).toBe(1);
      expect(history[0].persona).toBe('security');
      expect(history[0].data.message).toContain('Security persona');
    });

    it('isolates event history across distinct jobId values', () => {
      bus.publishEvent({
        jobId: 'job_A',
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'security',
        data: { message: 'Event for Job A' },
      });

      bus.publishEvent({
        jobId: 'job_B',
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'architecture',
        data: { message: 'Event for Job B' },
      });

      const historyA = bus.getHistory('job_A');
      const historyB = bus.getHistory('job_B');

      expect(historyA.length).toBe(1);
      expect(historyA[0].data.message).toBe('Event for Job A');
      expect(historyB.length).toBe(1);
      expect(historyB[0].data.message).toBe('Event for Job B');
    });

    it('enforces 500-event pruning limit per jobId', () => {
      const jobId = 'job_prune_test';
      for (let i = 1; i <= 505; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm_chunk',
          persona: 'quality',
          data: { chunk: `chunk_${i}` },
        });
      }

      const history = bus.getHistory(jobId);
      expect(history.length).toBe(500);
      expect(history[0].data.chunk).toBe('chunk_6');
      expect(history[499].data.chunk).toBe('chunk_505');
    });

    it('clears event history for specific jobId or globally', () => {
      bus.publishEvent({
        jobId: 'job_clear_1',
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'security',
        data: { message: 'Event 1' },
      });
      bus.publishEvent({
        jobId: 'job_clear_2',
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'performance',
        data: { message: 'Event 2' },
      });

      bus.clearHistory('job_clear_1');
      expect(bus.getHistory('job_clear_1').length).toBe(0);
      expect(bus.getHistory('job_clear_2').length).toBe(1);

      bus.clearHistory();
      expect(bus.getHistory('job_clear_2').length).toBe(0);
    });

    it('tracks active jobs metadata, persona progress, and LLM token usage', () => {
      const jobId = 'job_calltelemetry_cisco-cdr_pr88_b2c3d4e';
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { message: 'Starting security scan' },
      });

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:chunk',
        persona: 'security',
        data: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.002 },
      });

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:complete',
        persona: 'security',
        data: { findingsCount: 2, message: 'Scan finished' },
      });

      const activeJobs = bus.getActiveJobs();
      expect(activeJobs.length).toBe(1);
      expect(activeJobs[0].jobId).toBe(jobId);
      expect(activeJobs[0].repo).toBe('calltelemetry/cisco-cdr');
      expect(activeJobs[0].prNumber).toBe(88);
      expect(activeJobs[0].personaProgress.security.status).toBe('completed');
      expect(activeJobs[0].personaProgress.security.findingsCount).toBe(2);
      expect(activeJobs[0].tokenMetrics.totalTokens).toBe(150);
      expect(activeJobs[0].tokenMetrics.estimatedCostUSD).toBe(0.002);

      const jobStatus = bus.getJobStatus(jobId);
      expect(jobStatus).toBeDefined();
      expect(jobStatus?.eventCount).toBe(3);
    });
  });

  describe('SSE Client Registration & Stream Lifecycle', () => {
    function createMockResponse(): Response & { written: string[]; headers: Record<string, string>; closed: boolean } {
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
      };
      return mockRes;
    }

    it('sets correct SSE headers when adding a client', () => {
      const mockRes = createMockResponse();
      bus.addClient('job_headers_test', mockRes);

      expect(mockRes.headers['Content-Type']).toBe('text/event-stream');
      expect(mockRes.headers['Cache-Control']).toBe('no-cache');
      expect(mockRes.headers['Connection']).toBe('keep-alive');
    });

    it('replays cached historical events immediately upon new client registration', () => {
      const jobId = 'job_replay_test';
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'security',
        data: { message: 'Historical event 1' },
      });

      const mockRes = createMockResponse();
      bus.addClient(jobId, mockRes);

      expect(mockRes.written.length).toBe(1);
      expect(mockRes.written[0]).toContain('Historical event 1');
    });

    it('broadcasts published events in real-time to active connected clients', () => {
      const jobId = 'job_broadcast_test';
      const mockRes = createMockResponse();
      bus.addClient(jobId, mockRes);

      const event: LiveStreamEvent = {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'quorum_verdict',
        persona: 'quorum',
        data: { verdict: 'SHIP' },
      };

      bus.publishEvent(event);

      expect(mockRes.written.length).toBe(1);
      expect(mockRes.written[0]).toContain('data: ');
      expect(mockRes.written[0]).toContain('SHIP');
    });

    it('cleans up client set when client connection closes', () => {
      const jobId = 'job_close_test';
      const mockRes = createMockResponse();
      bus.addClient(jobId, mockRes);

      // Emit close event on response
      mockRes.emit('close');

      // Publishing new event should not attempt to write to closed res
      const writeSpy = vi.spyOn(mockRes, 'write');
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'agent_done',
        persona: 'quality',
        data: { message: 'Finished' },
      });

      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('REST Endpoints (src/api/liveApi.ts)', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/live', createLiveRouter());
    });

    function mockRequest(app: express.Express, method: string, urlPath: string, body?: any) {
      return new Promise<{ status: number; body: any }>((resolve) => {
        const [pathOnly, queryString] = urlPath.split('?');
        const queryParams: Record<string, string> = {};
        if (queryString) {
          new URLSearchParams(queryString).forEach((v, k) => {
            queryParams[k] = v;
          });
        }

        const req: any = new EventEmitter();
        req.method = method;
        req.url = urlPath;
        req.path = pathOnly;
        req.query = queryParams;
        req.headers = { 'content-type': 'application/json' };
        req.body = body;

        let statusCode = 200;
        let responseData: any = null;

        const res: any = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
        res.getHeader = (k: string) => res.headers[k.toLowerCase()];
        res.status = (code: number) => {
          statusCode = code;
          res.statusCode = code;
          return res;
        };
        res.json = (data: any) => {
          responseData = data;
          resolve({ status: statusCode, body: data });
        };
        res.send = (data: any) => {
          responseData = data;
          resolve({ status: statusCode, body: data });
        };
        res.flushHeaders = () => {
          resolve({ status: statusCode, body: { streamStarted: true } });
        };
        res.write = (data: any) => {
          resolve({ status: statusCode, body: { streamStarted: true, chunk: String(data) } });
          return true;
        };

        app(req, res);
      });
    }

    it('GET /api/live/history returns recorded events for a job', async () => {
      bus.publishEvent({
        jobId: 'job_api_456',
        timestamp: new Date().toISOString(),
        type: 'quorum_verdict',
        persona: 'quorum',
        data: { verdict: 'APPROVE', confidenceScore: 95 },
      });

      const res = await mockRequest(app, 'GET', '/api/live/history?jobId=job_api_456');

      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe('job_api_456');
      expect(res.body.count).toBe(1);
      expect(res.body.events[0].data.verdict).toBe('APPROVE');
    });

    it('POST /api/live/publish emits event and returns 201 Created', async () => {
      const res = await mockRequest(app, 'POST', '/api/live/publish', {
        jobId: 'job_pub_test',
        type: 'indexer_lookup',
        persona: 'architecture',
        data: { message: 'AST lookup performed' },
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('published');
      expect(res.body.event.jobId).toBe('job_pub_test');

      const history = bus.getHistory('job_pub_test');
      expect(history.length).toBe(1);
      expect(history[0].type).toBe('indexer_lookup');
    });

    it('POST /api/live/publish returns 400 Bad Request if missing required fields', async () => {
      const res = await mockRequest(app, 'POST', '/api/live/publish', {
        jobId: 'job_incomplete',
        // missing type and persona
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required parameters');
    });

    it('GET /api/live/stream allows public unauthenticated connection', async () => {
      const res = await mockRequest(app, 'GET', '/api/live/stream?jobId=job_public_stream');
      expect(res.status).toBe(200);
    });

    it('GET /api/live/stream gracefully handles invalid token without returning 401', async () => {
      const res = await mockRequest(app, 'GET', '/api/live/stream?jobId=job_invalid_token&token=invalid_xyz');
      expect(res.status).toBe(200);
    });

    it('GET /api/live/active and GET /api/live/jobs return active jobs list', async () => {
      bus.publishEvent({
        jobId: 'job_active_123',
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'quality',
        data: { repo: 'org/repo1', prNumber: 42 },
      });

      const resActive = await mockRequest(app, 'GET', '/api/live/active');
      expect(resActive.status).toBe(200);
      expect(resActive.body.success).toBe(true);
      expect(resActive.body.count).toBe(1);
      expect(resActive.body.jobs[0].jobId).toBe('job_active_123');

      const resJobs = await mockRequest(app, 'GET', '/api/live/jobs');
      expect(resJobs.status).toBe(200);
      expect(resJobs.body.success).toBe(true);
      expect(resJobs.body.count).toBe(1);
    });
  });

  describe('PR Review Dashboard Link Integration', () => {
    it('attaches Live Stream and Organization Dashboard URLs to published PR reviews', async () => {
      let capturedBody = '';

      const publisher = new CommentPublisher({
        githubToken: 'ghs_valid_test_token_1234567890',
        baseUrl: 'https://api.github.test',
      });

      // Mock fetchWithRetry
      (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
        const payload = JSON.parse(opts.body);
        capturedBody = payload.body;
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({ id: 9999 }),
        };
      };

      const res = await publisher.publishReview({
        owner: 'calltelemetry',
        repo: 'ct-meta',
        prNumber: 1448,
        commitSha: 'a1b2c3d4e5f6',
        event: 'COMMENT',
        body: '## PR Quorum Summary Review\nAll checks passed cleanly.',
      });

      expect(res.success).toBe(true);
      expect(capturedBody).toContain('Live Terminal Dashboard');
      expect(capturedBody).toContain('/dashboard/live?jobId=job_calltelemetry_ct-meta_pr1448_a1b2c3d');
      expect(capturedBody).toContain('/dashboard/organization');
    });
  });
});
