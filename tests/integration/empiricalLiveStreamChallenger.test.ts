import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import { createApp } from '../../src/app';
import { LiveStreamBus, LiveStreamEvent } from '../../src/live/liveStreamBus';
import { authService } from '../../src/dashboard/authService';

describe('Empirical Challenger Suite — Live Terminal & 9-Event SSE Streaming', () => {
  let app: any;
  let bus: LiveStreamBus;
  let server: http.Server;
  let baseUrl: string;
  let validToken: string;

  beforeEach(async () => {
    // Set minimal dummy env vars so app initializes properly
    process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '123456';
    process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3\n-----END RSA PRIVATE KEY-----';
    process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'secret123';
    process.env.OMNIROUTE_BASE_URL = process.env.OMNIROUTE_BASE_URL || 'http://localhost:9999';

    bus = LiveStreamBus.getInstance();
    bus.clearHistory();

    // Authenticate to get a valid session token
    const session = authService.login('admin', process.env.ADMIN_PASSWORD || 'admin123');
    expect(session).not.toBeNull();
    validToken = session!.token;

    app = createApp();

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    bus.clearHistory();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('1. Dashboard Static HTML Routes Delivery', () => {
    it('serves Live Terminal UI at /dashboard/live with status 200 and text/html content-type', async () => {
      const res = await request(server).get('/dashboard/live?jobId=job_emp_test_100');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text.toLowerCase()).toContain('<!doctype html>');
      expect(res.text).toContain('CT-Review-Bot — Real-Time AI Review Dashboard');
      expect(res.text.includes('/js/live.js') || res.text.includes('/_next/static/chunks/')).toBe(true);
    });

    it('serves Organization Management UI at /dashboard/organization with status 200 and text/html content-type', async () => {
      const res = await request(server).get('/dashboard/organization');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text.toLowerCase()).toContain('<!doctype html>');
    });

    it('serves static assets referenced by dashboard UI (css/theme.css, css/components.css)', async () => {
      const resTheme = await request(app).get('/css/theme.css');
      expect(resTheme.status).toBe(200);
      expect(resTheme.headers['content-type']).toContain('css');

      const resComp = await request(app).get('/css/components.css');
      expect(resComp.status).toBe(200);
      expect(resComp.headers['content-type']).toContain('css');
    });
  });

  describe('2. SSE Live Stream Endpoint & All 9 Event Types Streaming', () => {
    it('sets correct SSE response headers on /api/live/stream with valid token', async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/live/stream?jobId=job_header_test&token=${validToken}`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          expect(res.headers['cache-control']).toContain('no-cache');
          expect(res.headers['connection']).toContain('keep-alive');
          expect(res.headers['x-accel-buffering']).toBe('no');
          req.removeAllListeners('error');
          req.on('error', () => {});
          req.destroy();
          resolve();
        });
        req.on('error', reject);
      });
    });

    it('gracefully handles invalid query authentication token with status 200 public stream fallback', async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/live/stream?jobId=job_auth_test&token=invalid-secret-token`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          req.removeAllListeners('error');
          req.on('error', () => {});
          req.destroy();
          resolve();
        });
        req.on('error', reject);
      });
    });

    it('streams all 9 distinct event types end-to-end to an active SSE client connection', async () => {
      const jobId = 'job_empirical_9_events_test_999';
      const receivedEvents: LiveStreamEvent[] = [];

      // Open live HTTP SSE stream connection to the running server using query token
      const req = http.get(`${baseUrl}/api/live/stream?jobId=${jobId}&token=${validToken}`, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const block of lines) {
            if (block.startsWith('data: ')) {
              const jsonStr = block.replace(/^data: /, '').trim();
              if (jsonStr) {
                try {
                  const evt = JSON.parse(jsonStr);
                  receivedEvents.push(evt);
                } catch (err) {
                  // Ignore non-json or ping frames
                }
              }
            }
          }
        });
      });

      // Wait 100ms for connection to establish and register on bus
      await new Promise((r) => setTimeout(r, 100));

      // Define all 9 event types per requirements
      const all9Events: LiveStreamEvent[] = [
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:start',
          persona: 'security',
          data: {
            personaId: 'security',
            charter: 'Analyze AST for OWASP Top 10 vulnerabilities',
            paths: ['src/api/**/*.ts'],
            required: true,
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'security',
          data: {
            chunk: 'Scanning 4 files for unmanaged SQL queries and auth leaks...',
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:prompt',
          persona: 'security',
          data: {
            provider: 'anthropic-v1',
            model: 'claude-3-5-sonnet-20241022',
            promptSnippet: 'CT_REVIEW_NONCE: persona=security repo=calltelemetry/cisco-cdr headSha=a1b2c3d',
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'security',
          data: {
            token: 'FINDINGS',
            accumulatedLength: 1420,
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'omniroute:metric',
          persona: 'security',
          data: {
            requestedModel: 'claude-3-5-sonnet',
            resolvedModel: 'claude-3-5-sonnet-20241022',
            provider: 'anthropic-v1',
            latencyMs: 345,
            promptTokens: 1250,
            completionTokens: 420,
            totalTokens: 1670,
            costUSD: 0.00501,
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'ast:lookup',
          persona: 'architecture',
          data: {
            symbolName: 'LiveStreamBus',
            filePath: 'src/live/liveStreamBus.ts',
            callersCount: 8,
            calleesCount: 3,
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'nit:suppression',
          persona: 'quality',
          data: {
            findingTitle: 'Minor variable naming nit',
            pattern: 'use camelCase for tmp vars',
            rationale: 'Suppressed based on repository historical style rules',
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:complete',
          persona: 'security',
          data: {
            personaId: 'security',
            durationMs: 450,
            findingsCount: 1,
          },
        },
        {
          jobId,
          timestamp: new Date().toISOString(),
          type: 'job:complete',
          persona: 'quorum',
          data: {
            verdict: 'SHIP',
            quorumSatisfied: true,
            distinctProviders: ['anthropic-v1', 'openai-v1', 'mistral-v1'],
            totalPersonasExecuted: 4,
            totalFindings: 1,
            totalDurationMs: 1820,
            totalCostUSD: 0.0142,
          },
        },
      ];

      // Publish all 9 events sequentially
      for (const evt of all9Events) {
        bus.publishEvent(evt);
        await new Promise((r) => setTimeout(r, 20));
      }

      // Wait for stream processing
      await new Promise((r) => setTimeout(r, 200));

      req.destroy();

      // Empirical Assertions:
      expect(receivedEvents.length).toBe(9);

      const receivedTypes = receivedEvents.map((e) => e.type);
      expect(receivedTypes).toEqual([
        'persona:start',
        'persona:chunk',
        'llm:prompt',
        'llm:token',
        'omniroute:metric',
        'ast:lookup',
        'nit:suppression',
        'persona:complete',
        'job:complete',
      ]);

      // Verify specific data payloads on key events
      const startEvt = receivedEvents.find((e) => e.type === 'persona:start');
      expect(startEvt?.data.personaId).toBe('security');

      const omniEvt = receivedEvents.find((e) => e.type === 'omniroute:metric');
      expect(omniEvt?.data.provider).toBe('anthropic-v1');
      expect(omniEvt?.data.totalTokens).toBe(1670);

      const astEvt = receivedEvents.find((e) => e.type === 'ast:lookup');
      expect(astEvt?.data.symbolName).toBe('LiveStreamBus');

      const nitEvt = receivedEvents.find((e) => e.type === 'nit:suppression');
      expect(nitEvt?.data.findingTitle).toBe('Minor variable naming nit');

      const completeEvt = receivedEvents.find((e) => e.type === 'job:complete');
      expect(completeEvt?.data.verdict).toBe('SHIP');
      expect(completeEvt?.data.quorumSatisfied).toBe(true);
    });

    it('replays all 9 historical events to newly connected clients with valid token', async () => {
      const jobId = 'job_history_replay_test_888';

      // Publish 9 events prior to client connection
      const types: LiveStreamEvent['type'][] = [
        'persona:start',
        'persona:chunk',
        'persona:complete',
        'llm:prompt',
        'llm:token',
        'omniroute:metric',
        'ast:lookup',
        'nit:suppression',
        'job:complete',
      ];

      types.forEach((type) => {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type,
          persona: 'quality',
          data: { testType: type },
        });
      });

      // Verify history API with Bearer token
      const historyRes = await request(app)
        .get(`/api/live/history?jobId=${jobId}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(historyRes.status).toBe(200);
      expect(historyRes.body.count).toBe(9);

      // Verify new SSE client receives all 9 replayed events
      const replayedEvents: LiveStreamEvent[] = [];

      const req = http.get(`${baseUrl}/api/live/stream?jobId=${jobId}&token=${validToken}`, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const block of lines) {
            if (block.startsWith('data: ')) {
              const jsonStr = block.replace(/^data: /, '').trim();
              if (jsonStr) {
                try {
                  replayedEvents.push(JSON.parse(jsonStr));
                } catch (_) {}
              }
            }
          }
        });
      });

      await new Promise((r) => setTimeout(r, 250));
      req.destroy();

      expect(replayedEvents.length).toBe(9);
      expect(replayedEvents.map((e) => e.type)).toEqual(types);
    });

    it('stress tests high volume event buffer capping at 500 historical events', async () => {
      const jobId = 'job_ring_buffer_stress_777';

      // Emit 550 events
      for (let i = 1; i <= 550; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'security',
          data: { tokenIndex: i },
        });
      }

      const historyRes = await request(app)
        .get(`/api/live/history?jobId=${jobId}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(historyRes.status).toBe(200);
      expect(historyRes.body.count).toBe(500); // Verify capped at 500
      expect(historyRes.body.events[0].data.tokenIndex).toBe(51); // First 50 shifted off
      expect(historyRes.body.events[499].data.tokenIndex).toBe(550);
    });

    it('stress tests multiple concurrent SSE subscribers receiving synchronized broadcast events', async () => {
      const jobId = 'job_concurrent_subscribers_555';
      const subscriberCount = 5;
      const receivedCounts: number[] = new Array(subscriberCount).fill(0);
      const reqs: http.ClientRequest[] = [];

      await Promise.all(
        Array.from({ length: subscriberCount }, (_, i) => new Promise<void>((resolve) => {
          const req = http.get(`${baseUrl}/api/live/stream?jobId=${jobId}&token=${validToken}`, (res) => {
            let buffer = '';
            res.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n\n');
              buffer = lines.pop() || '';
              for (const block of lines) {
                if (block.startsWith('data: ')) {
                  receivedCounts[i]++;
                }
              }
            });
            resolve();
          });
          reqs.push(req);
        }))
      );

      await new Promise((r) => setTimeout(r, 50));

      // Broadcast 10 events to all connected clients
      for (let k = 1; k <= 10; k++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:chunk',
          persona: 'architecture',
          data: { broadcastIndex: k },
        });
      }

      await new Promise((r) => setTimeout(r, 200));

      reqs.forEach((r) => r.destroy());

      // Each subscriber must receive all 10 events
      receivedCounts.forEach((count, idx) => {
        expect(count).toBe(10);
      });
    });
  });
});
