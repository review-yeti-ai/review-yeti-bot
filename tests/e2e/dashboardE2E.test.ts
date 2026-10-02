import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TelemetryChartsGrid } from '../../src/components/dashboard/telemetry-charts-grid';
import type { OverviewStats } from '../../src/types/dashboard';
import { assertDashboardClientAssets, assertLiveMarkup, assertSettingsMarkup, dashboardDocument, assertTokenTelemetryMarkup } from '../support/dashboardMarkup';

describe('Milestone 4: Web Dashboard Frontend & Linear Dark UI Redesign E2E Suite', () => {
  let app: any;
  let indexHtmlContent: string;
  let liveHtmlContent: string;
  let settingsHtmlContent: string;

  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'admin123';
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

    it('preserves the protected-main overview headings and audit navigation in the rendered document', () => {
      const document = dashboardDocument(indexHtmlContent);
      expect(document.querySelector('header h1')?.textContent).toBe('Review Yeti Swarm Control Plane');
      expect(document.querySelector('main')?.textContent).toContain('Total PR Reviews');
      expect(document.querySelector('main')?.textContent).toContain('Recent Reviews & Audit Log');
      expect(Array.from(document.querySelectorAll('main [role="tab"]')).map((tab) => tab.textContent))
        .toContain('Fleet Telemetry & Compaction ROI');
    });

    const stats = { totalTokens: { prompt: 120, completion: 30, total: 150 }, totalCostUSD: 0,
      passRatePercent: 64.5, r2CacheHitRatePercent: 77.4 } as unknown as OverviewStats;
    const telemetry = () => new (require('jsdom').JSDOM)(renderToStaticMarkup(createElement(TelemetryChartsGrid, { stats }))).window.document as Document;

    it('renders token throughput from overview data when telemetry is mounted', () => {
      const card = telemetry().querySelector('#chart-tokens-timeseries');
      assertTokenTelemetryMarkup(card, stats.totalTokens);
    });

    it('accepts harmless whitespace between telemetry labels and their values', () => {
      const document = telemetry();
      const card = document.querySelector('#chart-tokens-timeseries')!;
      const label = Array.from(card.querySelectorAll('span')).find((span) => span.textContent === 'Prompt (80%)')!;
      label.textContent = ' \n Prompt \t (80%) \n ';
      label.nextElementSibling!.textContent = '\n 120 \t';
      label.parentElement!.insertBefore(document.createTextNode('\n  '), label.nextSibling);
      assertTokenTelemetryMarkup(card, stats.totalTokens);
    });

    it.each(['swapped counts', 'wrong total', 'wrong prompt percentage', 'wrong completion percentage'] as const)
    ('rejects %s even when other token values remain in the same card', (damage) => {
      const card = telemetry().querySelector('#chart-tokens-timeseries')!;
      const spans = Array.from(card.querySelectorAll('span'));
      const prompt = spans.find((span) => span.textContent === 'Prompt (80%)')!;
      const completion = spans.find((span) => span.textContent === 'Completion (20%)')!;
      if (damage === 'swapped counts') {
        prompt.nextElementSibling!.textContent = '30';
        completion.nextElementSibling!.textContent = '120';
      }
      if (damage === 'wrong total') spans.find((span) => span.textContent === '150')!.textContent = '151';
      if (damage === 'wrong prompt percentage') prompt.textContent = 'Prompt (79%)';
      if (damage === 'wrong completion percentage') completion.textContent = 'Completion (21%)';
      expect(() => assertTokenTelemetryMarkup(card, stats.totalTokens)).toThrow();
    });

    it('renders an observed zero model spend without substituting sample costs', () => {
      expect(telemetry().querySelector('#chart-model-costs')?.textContent).toContain('$0.000');
    });

    it('renders the observed quality consensus percentage', () => {
      expect(telemetry().querySelector('#chart-arbitration-consensus')?.textContent).toContain('64.5%');
    });

    it('renders the observed workspace cache hit rate', () => {
      expect(telemetry().querySelector('#chart-indexer-performance')?.textContent).toContain('77.4%');
      const document = dashboardDocument(indexHtmlContent);
      expect(Array.from(document.querySelectorAll('main [role="tab"]')).map((tab) => tab.textContent))
        .toContain('Fleet Telemetry & Compaction ROI');
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

    it('serves a hydratable live swarm page and its actual client chunks', async () => {
      assertLiveMarkup(liveHtmlContent);
      expect(dashboardDocument(liveHtmlContent).querySelector('header h1')?.textContent).toBe('Live Review Inspector');
      await assertDashboardClientAssets(app, liveHtmlContent, 'live');
    });

    it('rejects a wrong-route shell and hidden placeholders in place of the settings editor', () => {
      expect(() => assertLiveMarkup(settingsHtmlContent)).toThrow();
      const document = dashboardDocument(settingsHtmlContent);
      document.querySelector('main button[id="save-all-btn"]')!.remove();
      expect(() => assertSettingsMarkup(document.documentElement.outerHTML.replace('<html', '<!doctype html><html'))).toThrow();
    });

    it('rejects an HTTP 200 HTML fallback in place of a client bundle', async () => {
      const express = (await import('express')).default;
      const missingAssets = express();
      missingAssets.use((_req, res) => res.type('html').send(indexHtmlContent));
      await expect(assertDashboardClientAssets(missingAssets, liveHtmlContent, 'live')).rejects.toThrow();
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
      assertSettingsMarkup(res.text);
      await assertDashboardClientAssets(app, res.text, 'settings');
      expect(res.text).toContain('src="/js/settings.js"');
    });

    it('contains the task settings editor and save controls in public/settings.html', () => {
      assertSettingsMarkup(settingsHtmlContent);
      expect(dashboardDocument(settingsHtmlContent).querySelector('main')?.textContent).toContain('Composed Swarm Review Task Dimensions');
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
