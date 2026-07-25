import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 25 & 26: ECharts Dark Dashboard & Enhanced Settings UX E2E Tests', () => {
  let app: any;
  let htmlContent: string;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();
    const indexPath = path.resolve(__dirname, '../../public/index.html');
    htmlContent = fs.readFileSync(indexPath, 'utf-8');
  });

  describe('Dashboard HTML & ECharts Canvas Structural Verification', () => {
    it('contains ECharts library CDN script tag in public/index.html', () => {
      expect(htmlContent).toContain('echarts.min.js');
    });

    it('contains container element for Token Consumption Time-Series chart', () => {
      expect(htmlContent).toContain('id="chart-tokens-timeseries"');
    });

    it('contains container element for Model Cost Breakdown chart', () => {
      expect(htmlContent).toContain('id="chart-model-costs"');
    });

    it('contains container element for Persona Verdicts & Latency chart', () => {
      expect(htmlContent).toContain('id="chart-persona-verdicts"');
    });

    it('contains container element for Nit Suppression & Indexer Performance chart', () => {
      expect(htmlContent).toContain('id="chart-indexer-performance"');
    });
  });

  describe('Enhanced Settings UX Elements Verification', () => {
    it('contains Reasoning Effort Level slider control (#effort-slider)', () => {
      expect(htmlContent).toContain('id="effort-slider"');
      expect(htmlContent).toContain('min="1"');
      expect(htmlContent).toContain('max="5"');
    });

    it('contains Per-Persona Model Allocation dropdown selectors', () => {
      expect(htmlContent).toContain('id="model-security"');
      expect(htmlContent).toContain('id="model-analysis"');
      expect(htmlContent).toContain('claude-5-sonnet');
      expect(htmlContent).toContain('gpt-5.6-sol');
    });

    it('contains Confidence Threshold Dial slider (#confidence-slider)', () => {
      expect(htmlContent).toContain('id="confidence-slider"');
    });

    it('contains instant feature toggle controls', () => {
      expect(htmlContent).toContain('id="toggle-memory-engine"');
      expect(htmlContent).toContain('id="toggle-nit-suppression"');
    });
  });

  describe('Dashboard Settings API End-to-End Synchronization', () => {
    it('updates reasoning effort level and model allocations via PUT /api/dashboard/settings', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const updateRes = await request(app)
        .put('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reasoningEffortLevel: 4,
          personaModels: {
            securityArbiter: 'claude-5-sonnet',
            codeAnalysis: 'gpt-5.6-sol',
          },
          confidenceThreshold: 75,
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.settings.reasoningEffortLevel).toBe(4);
    });
  });
});
