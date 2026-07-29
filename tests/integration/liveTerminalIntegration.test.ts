import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import path from 'path';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';
import { CommentPublisher, getJobId, getLiveStreamUrl, getOrgDashboardUrl } from '../../src/comments/CommentPublisher';

describe('Live Review Terminal Integration Suite (Milestone 35/36)', () => {
  let app: Express;
  let bus: LiveStreamBus;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();

    app = express();
    app.use(express.json());

    // Mount live stream API
    app.use('/api/live', createLiveRouter());

    // Mount dashboard static routes (matching src/app.ts)
    app.get('/dashboard/live', (_req, res) => {
      res.sendFile(path.join(__dirname, '../../public/live.html'));
    });

    app.get('/dashboard/organization', (_req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    // Static assets
    app.use(express.static(path.join(__dirname, '../../public')));
  });

  afterEach(() => {
    bus.clearHistory();
  });

    function mockRequest(app: express.Express, method: string, urlPath: string) {
      return new Promise<{ status: number; body: any; text: string; header: Record<string, string> }>((resolve) => {
        const [pathOnly, queryString] = urlPath.split('?');
        const queryParams: Record<string, string> = {};
        if (queryString) {
          new URLSearchParams(queryString).forEach((v, k) => {
            queryParams[k] = v;
          });
        }

        const req: any = new (require('events').EventEmitter)();
        req.method = method;
        req.url = urlPath;
        req.path = pathOnly;
        req.query = queryParams;
        req.headers = { 'content-type': 'application/json' };

        let statusCode = 200;
        let responseBody: any = '';
        const headers: Record<string, string> = {};

        const res: any = new (require('events').EventEmitter)();
        res.statusCode = 200;
        res.headers = headers;
        res.setHeader = (k: string, v: string) => { headers[k.toLowerCase()] = v; };
        res.getHeader = (k: string) => headers[k.toLowerCase()];
        res.status = (code: number) => {
          statusCode = code;
          res.statusCode = code;
          return res;
        };
        res.json = (data: any) => {
          responseBody = data;
          headers['content-type'] = 'application/json';
          resolve({ status: statusCode, body: data, text: JSON.stringify(data), header: headers });
        };
        res.send = (data: any) => {
          responseBody = data;
          resolve({ status: statusCode, body: data, text: String(data), header: headers });
        };
        res.flushHeaders = () => {
          resolve({ status: statusCode, body: { streamStarted: true }, text: 'streamStarted', header: headers });
        };
        res.write = (data: any) => {
          resolve({ status: statusCode, body: { streamStarted: true, chunk: String(data) }, text: String(data), header: headers });
          return true;
        };
        res.sendFile = (filePath: string) => {
          const fs = require('fs');
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            headers['content-type'] = 'text/html';
            resolve({ status: 200, body: content, text: content, header: headers });
          } else {
            resolve({ status: 404, body: 'Not found', text: 'Not found', header: headers });
          }
        };

        app(req, res);
      });
    }

  it('serves Linear dark theme live review terminal page (public/live.html) at GET /dashboard/live', async () => {
    const res = await mockRequest(app, 'GET', '/dashboard/live?jobId=job_integration_test_123');

    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/html');
    expect(res.text.includes('Tabbed Persona Explorer') || res.text.includes('Live Agent Review Terminal') || res.text.includes('/_next/static/chunks/')).toBe(true);
    expect(res.text.includes('Prompt') || res.text.includes('inspector-prompt')).toBe(true);
  });

  it('serves organization management page at GET /dashboard/organization', async () => {
    const res = await mockRequest(app, 'GET', '/dashboard/organization');

    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/html');
  });

  it('streams full 5-persona agent review sequence through LiveStreamBus and history API', async () => {
    const jobId = 'job_owner_repo_pr99_f1e2d3c';

    const eventsSequence: LiveStreamEvent[] = [
      {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'security',
        data: { message: 'Security persona starting static AST scan', promptSnippet: 'Scan for SQL injection' },
      },
      {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'indexer_lookup',
        persona: 'architecture',
        data: { message: 'AST Symbol resolution: queryBuilder.ts:55', path: 'src/db/queryBuilder.ts' },
      },
      {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'llm_chunk',
        persona: 'performance',
        data: { chunk: 'Analyzing memory allocations in buffer pool...', tokensUsed: 120 },
      },
      {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'nit_suppression',
        persona: 'quality',
        data: { message: 'Suppressed minor variable naming nit in src/util.ts', path: 'src/util.ts' },
      },
      {
        jobId,
        timestamp: new Date().toISOString(),
        type: 'quorum_verdict',
        persona: 'quorum',
        data: { verdict: 'SHIP', confidenceScore: 97, message: 'All 4 persona panels passed with zero P0/P1 findings.' },
      },
    ];

    // Emit event sequence
    eventsSequence.forEach((evt) => bus.publishEvent(evt));

    // Fetch history from API
    const historyRes = await mockRequest(app, 'GET', `/api/live/history?jobId=${jobId}`);

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.jobId).toBe(jobId);
    expect(historyRes.body.count).toBe(5);

    const personasReceived = historyRes.body.events.map((e: any) => e.persona);
    expect(personasReceived).toEqual(['security', 'architecture', 'performance', 'quality', 'quorum']);

    const verdictEvent = historyRes.body.events.find((e: any) => e.persona === 'quorum');
    expect(verdictEvent.data.verdict).toBe('SHIP');
  });

  it('publishes GitHub review comment containing matching jobId link to /dashboard/live', async () => {
    const owner = 'calltelemetry';
    const repo = 'cisco-cdr';
    const prNumber = 88;
    const commitSha = 'b2c3d4e5f6789a0';

    const jobId = getJobId(owner, repo, prNumber, commitSha);
    expect(jobId).toBe('job_calltelemetry_cisco-cdr_pr88_b2c3d4e');

    let publishedBody = '';

    const publisher = new CommentPublisher({
      githubToken: 'ghs_integration_test_token',
      baseUrl: 'https://api.github.test',
    });

    (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
      const payload = JSON.parse(opts.body);
      publishedBody = payload.body;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ id: 8888 }),
      };
    };

    const domain = 'https://ct-review-bot.calltelemetry.com';
    const expectedLiveUrl = getLiveStreamUrl(domain, jobId);
    const expectedOrgUrl = getOrgDashboardUrl(domain);

    const res = await publisher.publishReview({
      owner,
      repo,
      prNumber,
      commitSha,
      event: 'APPROVE',
      body: '## Quorum Arbiter Consensus: SHIP\nAll personas completed analysis successfully.',
    });

    expect(res.success).toBe(true);
    expect(publishedBody).toContain(expectedLiveUrl);
    expect(publishedBody).toContain(expectedOrgUrl);
    expect(publishedBody).toContain(`/dashboard/live?jobId=${jobId}`);
  });

  it('handles unauthenticated stream requests and populates sidebar via GET /api/live/active', async () => {
    const jobId = 'job_calltelemetry_cisco-cdr_pr99_a1b2c3d';

    // Verify unauthenticated GET /api/live/stream connection
    const streamRes = await mockRequest(app, 'GET', `/api/live/stream?jobId=${jobId}`);
    expect(streamRes.status).toBe(200);

    // Publish event
    bus.publishEvent({
      jobId,
      timestamp: new Date().toISOString(),
      type: 'persona:start',
      persona: 'security',
      data: { repo: 'calltelemetry/cisco-cdr', prNumber: 99, message: 'Scan starting' },
    });

    // Verify GET /api/live/active populates sidebar job summary
    const activeRes = await mockRequest(app, 'GET', '/api/live/active');
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.success).toBe(true);
    expect(activeRes.body.count).toBeGreaterThanOrEqual(1);

    const targetJob = activeRes.body.jobs.find((j: any) => j.jobId === jobId);
    expect(targetJob).toBeDefined();
    expect(targetJob.repo).toBe('calltelemetry/cisco-cdr');
    expect(targetJob.prNumber).toBe(99);
    expect(targetJob.personaProgress.security).toBeDefined();
    expect(targetJob.personaProgress.security.status).toBe('in_progress');
  });
});
