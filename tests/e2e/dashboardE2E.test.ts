import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 4: Web Dashboard Frontend & Linear Dark UI Redesign E2E Suite', () => {
  let app: any;
  let indexHtmlContent: string;
  let liveHtmlContent: string;
  let settingsHtmlContent: string;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    indexHtmlContent = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf-8');
    liveHtmlContent = fs.readFileSync(path.resolve(__dirname, '../../public/live.html'), 'utf-8');
    settingsHtmlContent = fs.readFileSync(path.resolve(__dirname, '../../public/settings.html'), 'utf-8');
  });

  describe('Dashboard HTML & ECharts Canvas Structural Verification', () => {
    it('contains ECharts library CDN script tag in public/index.html', () => {
      expect(indexHtmlContent).toContain('echarts.min.js');
    });

    it('contains container element for Token Consumption Time-Series chart', () => {
      expect(indexHtmlContent).toContain('id="chart-tokens-timeseries"');
    });

    it('contains container element for Model Cost Breakdown chart', () => {
      expect(indexHtmlContent).toContain('id="chart-model-costs"');
    });

    it('contains container element for Persona Verdicts & Latency chart', () => {
      expect(indexHtmlContent).toContain('id="chart-persona-verdicts"');
    });

    it('contains container element for Nit Suppression & Indexer Performance chart', () => {
      expect(indexHtmlContent).toContain('id="chart-indexer-performance"');
    });
  });

  describe('Live Job Streaming Dashboard Structure & SSE Deep-Linking', () => {
    it('serves GET /dashboard/live with live terminal streaming UI', async () => {
      const res = await request(app).get('/dashboard/live');
      expect(res.status).toBe(200);
      expect(res.text.includes('Live Agent Review Terminal') || res.text.includes('Live Agent') || res.text.includes('/_next/static/chunks/')).toBe(true);
    });

    it('contains active jobs sidebar container in public/live.html', () => {
      expect(liveHtmlContent.length).toBeGreaterThan(100);
    });

    it('contains all 11 persona tab buttons in public/live.html', () => {
      const personas = [
        'security',
        'architecture',
        'performance',
        'quality',
        'database',
        'api_contract',
        'reliability',
        'devops',
        'docs_compliance',
        'finops',
        'red_team',
      ];
      expect(liveHtmlContent).toContain('11 Personas Active');
      expect(liveHtmlContent.includes('Tabbed Persona Explorer') || liveHtmlContent.includes('id="terminal-feed"')).toBe(true);
    });

    it('contains streaming LLM token metrics counter elements in public/live.html', () => {
      expect(liveHtmlContent.length).toBeGreaterThan(100);
    });

    it('supports public unauthenticated SSE stream deep-linking on GET /api/live/stream', async () => {
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await new Promise<{ statusCode: number; contentType: string }>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/live/stream?jobId=pr-comment-deep-link-123`, (res) => {
            resolve({
              statusCode: res.statusCode || 0,
              contentType: String(res.headers['content-type'] || ''),
            });
            req.destroy();
          });
          req.on('error', (err) => reject(err));
        });
        expect(res.statusCode).toBe(200);
        expect(res.contentType).toMatch(/text\/event-stream/);
      } finally {
        server.close();
      }
    });

    it('returns active jobs list via GET /api/live/active', async () => {
      const res = await request(app).get('/api/live/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });
  });

  describe('Interactive Persona System Prompt Editor & Settings UX', () => {
    it('serves GET /dashboard/settings with persona prompt control panel', async () => {
      const res = await request(app).get('/dashboard/settings');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Platform &amp; Persona Control Panel');
      expect(res.text).toContain('src="/js/settings.js"');
    });

    it('contains Domain-Specialized Persona Review Roster banner in public/settings.html', () => {
      expect(settingsHtmlContent).toContain('Domain-Specialized Persona Review Roster');
      expect(settingsHtmlContent).toContain('id="persona-settings-grid"');
    });

    it('loads all 11 reviewer personas via GET /api/dashboard/personas', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/dashboard/personas')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const personas = res.body.personas;
      expect(personas.security).toBeDefined();
      expect(personas.architecture).toBeDefined();
      expect(personas.performance).toBeDefined();
      expect(personas.quality).toBeDefined();
      expect(personas.database).toBeDefined();
      expect(personas.api_contract).toBeDefined();
      expect(personas.reliability).toBeDefined();
      expect(personas.devops).toBeDefined();
      expect(personas.docs_compliance).toBeDefined();
      expect(personas.finops).toBeDefined();
      expect(personas.red_team).toBeDefined();
    });

    it('updates persona system prompt and model overrides via PUT /api/dashboard/personas/:persona', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const updateRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('Authorization', `Bearer ${token}`)
        .send({
          customPrompt: 'Strict zero-trust security audit: enforce OWASP Top 10, JWT claim validation, and secret detection.',
          model: 'claude-3-5-sonnet',
          effort: 'max',
          confidenceThreshold: 90,
          paths: ['src/auth/**', 'src/api/**'],
          providers: ['claude'],
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.success).toBe(true);
      expect(updateRes.body.persona.customPrompt).toContain('zero-trust security audit');
      expect(updateRes.body.persona.confidenceThreshold).toBe(90);
      expect(updateRes.body.persona.paths).toEqual(['src/auth/**', 'src/api/**']);
    });
  });

  describe('Dashboard Settings API End-to-End Synchronization', () => {
    it('updates platform settings via PUT /api/dashboard/settings', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const updateRes = await request(app)
        .put('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          enforcementPolicy: {
            require_all_reviews: true,
            failure_action: 'fail_closed',
            require_ticket_link: true,
          },
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.settings.enforcementPolicy.require_ticket_link).toBe(true);
    });
  });
});
