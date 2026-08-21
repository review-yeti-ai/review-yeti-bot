import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Empirical Challenger M4_1: UI Routes, SSE Stream, Terminal Logs, Settings & Dark Mode Suite', () => {
  let app: any;
  let authToken = '';
  const origAdminPassword = process.env.ADMIN_PASSWORD;

  beforeAll(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret_m41';
    process.env.ADMIN_PASSWORD = 'admin_m41_pass';

    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin_m41_pass' });
    authToken = loginRes.body.token || '';
  });

  afterAll(() => {
    if (origAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD;
    } else {
      process.env.ADMIN_PASSWORD = origAdminPassword;
    }
  });

  describe('1. UI Route & HTML Serving Verification (/dashboard/live and /dashboard/settings)', () => {
    it('GET /dashboard/live returns 200 text/html with required DOM structure', async () => {
      const res = await request(app).get('/dashboard/live');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Live Agent');
      expect(res.text).toContain('id="terminal-feed"');
      expect(res.text).toContain('id="inspector-prompt"');
      expect(res.text).toContain('id="connection-status"');
    });

    it('GET /dashboard/settings returns 200 text/html with required DOM structure', async () => {
      const res = await request(app).get('/dashboard/settings');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('id="persona-settings-grid"');
      expect(res.text).toContain('id="save-all-btn"');
      expect(res.text).toContain('id="active-personas-badge"');
    });
  });

  describe('2. Dark Mode CSS Variables Verification (hsl(220, 15%, 8%))', () => {
    const themeCssPath = path.join(__dirname, '../../public/css/theme.css');

    it('verifies theme.css defines --bg-app as hsl(220, 15%, 8%) and applies to body', () => {
      expect(fs.existsSync(themeCssPath)).toBe(true);
      const content = fs.readFileSync(themeCssPath, 'utf8');

      // Check root definition of --bg-app
      expect(content).toMatch(/--bg-app:\s*hsl\(220,\s*15%,\s*8%\);/);

      // Check body styling references var(--bg-app)
      expect(content).toMatch(/body\s*\{[^}]*background-color:\s*var\(--bg-app\);/);

      // Check secondary dark mode variables
      expect(content).toContain('--bg-surface: hsl(220, 14%, 12%)');
      expect(content).toContain('--bg-surface-elevated: hsl(220, 12%, 16%)');
      expect(content).toContain('--accent-primary: hsl(250, 85%, 65%)');
      expect(content).toContain('--border-subtle: hsl(220, 10%, 18%)');
    });
  });

  describe('3. System Prompt & Persona Settings Updates via Settings Forms', () => {
    it('updates custom system prompt via PATCH /api/dashboard/settings/personas/:personaId', async () => {
      const customPrompt = 'Strict security review mode: scan for hardcoded secrets and OWASP Top 10 vulnerabilities.';
      const res = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          customPrompt,
          model: 'claude-3-5-sonnet',
          effort: 'max',
          confidenceThreshold: 90,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.persona.customPrompt).toBe(customPrompt);
      expect(res.body.persona.confidenceThreshold).toBe(90);

      // Verify persistence via GET /api/dashboard/settings
      const getRes = await request(app)
        .get('/api/dashboard/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.settings.personaSettings.security.customPrompt).toBe(customPrompt);
      expect(getRes.body.settings.personaSettings.security.confidenceThreshold).toBe(90);
    });

    it('updates platform settings and custom prompts via PUT /api/dashboard/settings', async () => {
      const payload = {
        personaSettings: {
          architecture: {
            customPrompt: 'Focus on clean architecture, boundary enforcement, and ADR compliance.',
            enabled: true,
            model: 'claude-3-5-sonnet',
            effort: 'high',
            confidenceThreshold: 80,
          },
        },
        autoReviewSettings: {
          enabled: true,
          triggers: ['pr_opened', '@ct-review'],
          review_drafts: true,
          labels: ['ct-review'],
        },
      };

      const res = await request(app)
        .put('/api/dashboard/settings')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.settings.personaSettings.architecture.customPrompt).toContain('ADR compliance');
    });
  });

  describe('4. Live SSE Client Handling & Log Streaming Verification', () => {
    let bus: LiveStreamBus;

    beforeEach(() => {
      bus = LiveStreamBus.getInstance();
      bus.clearHistory();
    });

    it('publishes and replays terminal stream events for live clients', async () => {
      const jobId = 'job_m41_test_stream';

      // Publish sample events to bus
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'agent_start',
        persona: 'security',
        data: { message: 'Security agent started review' },
      });

      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'llm_chunk',
        persona: 'security',
        data: { chunk: 'Scanning authentication layer...' },
      });

      const history = bus.getHistory(jobId);
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('agent_start');
      expect(history[1].type).toBe('llm_chunk');
    });

    it('connects to GET /api/live/stream endpoint and receives headers text/event-stream', async () => {
      const { createLiveRouter } = await import('../../src/api/liveApi');
      const express = (await import('express')).default;
      const { EventEmitter } = await import('events');

      const liveApp = express();
      liveApp.use(express.json());
      liveApp.use('/api/live', createLiveRouter());

      const sseRes = await new Promise<{ statusCode: number; headers: Record<string, string> }>((resolve) => {
        const req: any = new EventEmitter();
        req.method = 'GET';
        req.url = `/api/live/stream?jobId=job_m41_sse_live&token=${authToken}`;
        req.path = '/api/live/stream';
        req.query = { jobId: 'job_m41_sse_live', token: authToken };
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
        res.write = () => true;
        res.flushHeaders = () => {};

        liveApp(req, res);

        setImmediate(() => {
          resolve({ statusCode: res.statusCode, headers: res.headers });
        });
      });

      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.headers['content-type']).toBe('text/event-stream');
      expect(sseRes.headers['cache-control']).toBe('no-cache');
    });
  });

  describe('5. Navigation Drawer Markup & Mobile Toggle Verification', () => {
    const htmlPath = path.join(__dirname, '../../public/settings.html');
    const appJsPath = path.join(__dirname, '../../public/js/app.js');

    it('verifies mobile drawer toggle element exists in HTML layout', () => {
      const html = fs.readFileSync(htmlPath, 'utf8');
      expect(html).toContain('id="mobile-toggle"');
      expect(html).toContain('id="sidebar-backdrop"');
      expect(html).toContain('class="sidebar"');
    });

    it('verifies app.js attaches click handler for mobile drawer toggling', () => {
      const js = fs.readFileSync(appJsPath, 'utf8');
      expect(js).toContain("document.getElementById('mobile-toggle')");
      expect(js).toContain("sidebar.classList.toggle('open')");
      expect(js).toContain("sidebarBackdrop.classList.toggle('active')");
    });
  });
});
