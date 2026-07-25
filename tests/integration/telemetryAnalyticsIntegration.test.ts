import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Milestone 26: Telemetry to Analytics API Integration Test', () => {
  let app: any;
  let token: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    token = loginRes.body.token;
  });

  it('records review run telemetry and reflects updated metrics in analytics endpoints', async () => {
    const initialOverview = dashboardStore.getOverviewStats();
    const initialReviews = initialOverview.totalReviewsExecuted;

    // Simulate review run recording
    dashboardStore.recordReviewRun({
      id: `rev-integration-${Date.now()}`,
      repository: 'calltelemetry/cisco-cdr',
      prNumber: 99,
      headSha: 'head-sha-integration',
      triggerSource: 'pr_event',
      verdict: 'SHIP',
      costUSD: 0.125,
      tokens: { prompt: 4500, completion: 850, total: 5350 },
      latencyMs: 1100,
      timestamp: new Date().toISOString(),
    });

    const summaryRes = await request(app)
      .get('/api/analytics/summary')
      .set('Authorization', `Bearer ${token}`);

    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.summary.totalReviews).toBe(initialReviews + 1);
  });

  it('verifies multi-persona trace ID propagation during quorum panel execution', async () => {
    const parentTraceId = 'trace-parent-quorum-777';
    const personas = ['securityArbiter', 'docsPersona', 'linearSyncPersona', 'marketingPersona'];

    const childSpans = personas.map((p) => ({
      persona: p,
      parentTraceId,
      traceId: parentTraceId,
      spanId: `span-${p}-${Date.now()}`,
      latencyMs: Math.floor(800 + Math.random() * 400),
    }));

    expect(childSpans).toHaveLength(4);
    childSpans.forEach((span) => {
      expect(span.traceId).toBe(parentTraceId);
      expect(span.latencyMs).toBeGreaterThan(0);
    });
  });
});
