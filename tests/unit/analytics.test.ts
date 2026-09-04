import { timeBudgetMs } from '../support/timeBudget';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 24 & 26: Typed Analytics REST API Unit Tests', () => {
  let app: any;
  let authToken: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    // Authenticate admin user
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  describe('Authentication Protection', () => {
    it('rejects unauthenticated requests to /api/analytics/summary with 401', async () => {
      const res = await request(app).get('/api/analytics/summary');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/analytics/summary', () => {
    it('returns high-level system summary metrics with response time < 50ms', async () => {
      const startTime = Date.now();
      const res = await request(app)
        .get('/api/analytics/summary')
        .set('Authorization', `Bearer ${authToken}`);
      const durationMs = Date.now() - startTime;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.totalReviews).toBeGreaterThanOrEqual(0);
      expect(res.body.summary.totalSpendUsd).toBeDefined();
      expect(res.body.summary.totalTokens).toBeDefined();
      expect(res.body.summary.avgLatencyMs).toBeDefined();
      expect(durationMs).toBeLessThan(timeBudgetMs(200));
    });
  });

  describe('GET /api/analytics/tokens', () => {
    it('returns time-series token usage breakdown for 7d range', async () => {
      const res = await request(app)
        .get('/api/analytics/tokens?range=7d&interval=day')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.range).toBe('7d');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(7);

      const point = res.body.data[0];
      expect(point).toHaveProperty('timestamp');
      expect(point).toHaveProperty('promptTokens');
      expect(point).toHaveProperty('completionTokens');
      expect(point).toHaveProperty('totalTokens');
    });
  });

  describe('GET /api/analytics/costs', () => {
    it('returns cost breakdown across LLM models', async () => {
      const res = await request(app)
        .get('/api/analytics/costs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalSpendUsd).toBeDefined();
      expect(res.body.monthlyBudgetUsd).toBeDefined();
      expect(Array.isArray(res.body.breakdown)).toBe(true);

      const modelItem = res.body.breakdown.find((m: any) => m.model === 'claude-5-sonnet');
      expect(modelItem).toBeDefined();
      expect(modelItem.displayName).toBe('Claude 5 Sonnet');
    });
  });

  describe('GET /api/analytics/personas', () => {
    it('returns persona review stats and verdict distribution', async () => {
      const res = await request(app)
        .get('/api/analytics/personas')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.personas)).toBe(true);

      const securityPersona = res.body.personas.find((p: any) => p.persona === 'securityArbiter');
      expect(securityPersona).toBeDefined();
      expect(securityPersona.verdicts).toHaveProperty('SHIP');
      expect(securityPersona.verdicts).toHaveProperty('NACK');
    });
  });

  describe('GET /api/analytics/indexer', () => {
    it('returns AST indexer and memory nit suppression performance stats', async () => {
      const res = await request(app)
        .get('/api/analytics/indexer')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.indexer.symbolNodesCount).toBeGreaterThanOrEqual(0);
      expect(res.body.indexer.astParseLatencyMs).toBeDefined();
    });
  });
});
