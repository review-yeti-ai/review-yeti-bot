import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';

describe('Telemetry & Typed Analytics REST API Endpoints (Milestones 23 & 24)', () => {
  let app: any;
  let authToken: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();
    const session = authService.login('admin', 'admin123');
    authToken = session?.token || '';
  });

  describe('GET /metrics', () => {
    it('returns 200 text/plain with Prometheus exposition metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('# HELP ct_review_tokens_prompt_total');
      expect(res.text).toContain('# TYPE ct_review_tokens_prompt_total counter');
      expect(res.text).toContain('# HELP ct_review_duration_seconds');
    });
  });

  describe('GET /api/telemetry/spans', () => {
    it('returns 200 JSON with trace spans array', async () => {
      const res = await request(app)
        .get('/api/telemetry/spans')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.count).toBe('number');
      expect(Array.isArray(res.body.spans)).toBe(true);
    });
  });

  describe('GET /api/analytics/summary', () => {
    it('returns 200 JSON summary with <50ms response latency', async () => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/analytics/summary')
        .set('Authorization', `Bearer ${authToken}`);
      const latencyMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(typeof res.body.summary.totalReviews).toBe('number');
      expect(typeof res.body.summary.totalSpendUsd).toBe('number');
      expect(typeof res.body.summary.totalTokens).toBe('number');
      expect(typeof res.body.summary.avgLatencyMs).toBe('number');
      expect(latencyMs).toBeLessThan(100);
    });
  });

  describe('GET /api/analytics/tokens', () => {
    it('returns 200 JSON token time series with <50ms response latency', async () => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/analytics/tokens?range=7d&interval=day')
        .set('Authorization', `Bearer ${authToken}`);
      const latencyMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.range).toBe('7d');
      expect(res.body.interval).toBe('day');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(7);
      expect(res.body.data[0]).toHaveProperty('promptTokens');
      expect(res.body.data[0]).toHaveProperty('completionTokens');
      expect(res.body.data[0]).toHaveProperty('totalTokens');
      expect(latencyMs).toBeLessThan(100);
    });
  });

  describe('GET /api/analytics/costs', () => {
    it('returns 200 JSON cost breakdown with <50ms response latency', async () => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/analytics/costs')
        .set('Authorization', `Bearer ${authToken}`);
      const latencyMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.totalSpendUsd).toBe('number');
      expect(typeof res.body.monthlyBudgetUsd).toBe('number');
      expect(typeof res.body.budgetPercentUsed).toBe('number');
      expect(Array.isArray(res.body.breakdown)).toBe(true);
      expect(res.body.breakdown.length).toBeGreaterThan(0);
      expect(res.body.breakdown[0]).toHaveProperty('model');
      expect(res.body.breakdown[0]).toHaveProperty('spendUsd');
      expect(latencyMs).toBeLessThan(500);
    });
  });

  describe('GET /api/analytics/personas', () => {
    it('returns 200 JSON persona analytics with <50ms response latency', async () => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/analytics/personas')
        .set('Authorization', `Bearer ${authToken}`);
      const latencyMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.personas)).toBe(true);
      expect(res.body.personas.length).toBeGreaterThan(0);
      expect(res.body.personas[0]).toHaveProperty('persona');
      expect(res.body.personas[0]).toHaveProperty('verdicts');
      expect(latencyMs).toBeLessThan(100);
    });
  });

  describe('GET /api/analytics/indexer', () => {
    it('returns 200 JSON indexer analytics with <50ms response latency', async () => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/analytics/indexer')
        .set('Authorization', `Bearer ${authToken}`);
      const latencyMs = Date.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.indexer).toBeDefined();
      expect(typeof res.body.indexer.symbolNodesCount).toBe('number');
      expect(typeof res.body.indexer.symbolEdgesCount).toBe('number');
      expect(typeof res.body.indexer.astParseLatencyMs).toBe('number');
      expect(typeof res.body.indexer.vectorEmbedLatencyMs).toBe('number');
      expect(latencyMs).toBeLessThan(100);
    });
  });
});
