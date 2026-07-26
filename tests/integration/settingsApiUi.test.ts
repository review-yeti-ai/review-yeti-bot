import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';

describe('Settings API & DashboardStore Persistence Suite (Milestone 40)', () => {
  let app: any;
  let validApiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  });

  beforeEach(() => {
    app = createApp();
    const createdKey = dashboardStore.createApiKey('test-settings-key');
    validApiKey = createdKey.rawKey;
  });

  it('GET /api/dashboard/settings returns platform settings', async () => {
    const res = await request(app)
      .get('/api/dashboard/settings')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    const settings = res.body.settings || res.body;
    expect(settings.defaultModelOverrides).toBeDefined();
    expect(settings.providerCostCaps).toBeDefined();
  });

  it('PUT /api/dashboard/settings updates and persists platform settings', async () => {
    const updatedModelOverrides = {
      codex: 'codex/gpt-5.6-sol-high',
      claude: 'claude-5-sonnet',
    };

    const res = await request(app)
      .put('/api/dashboard/settings')
      .set('x-api-key', validApiKey)
      .send({
        defaultModelOverrides: updatedModelOverrides,
        providerCostCaps: {
          monthlyBudgetUSD: 250.0,
          dailyBudgetUSD: 25.0,
          alertThresholdPercent: 85,
          actionOnCapBreach: 'fail_closed',
        },
      });

    expect(res.status).toBe(200);

    const checkRes = await request(app)
      .get('/api/dashboard/settings')
      .set('x-api-key', validApiKey);

    expect(checkRes.status).toBe(200);
    const settings = checkRes.body.settings || checkRes.body;
    expect(settings.defaultModelOverrides.claude).toBe('claude-5-sonnet');
    expect(settings.providerCostCaps.monthlyBudgetUSD).toBe(250.0);
  });

  it('GET /api/dashboard/repositories returns list of repository settings', async () => {
    const res = await request(app)
      .get('/api/dashboard/repositories')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    const repos = res.body.repositories || res.body;
    expect(Array.isArray(repos)).toBe(true);
    expect(repos.length).toBeGreaterThan(0);
  });

  it('PATCH /api/dashboard/repositories/:owner/:repo updates per-repo overrides', async () => {
    const res = await request(app)
      .patch('/api/dashboard/repositories/calltelemetry/cisco-cdr')
      .set('x-api-key', validApiKey)
      .send({
        automationEnabled: true,
        customProfile: 'assertive',
        modelOverrides: {
          'sec-lane': 'claude-5-sonnet',
          'perf-lane': 'gpt-5.6-sol',
        },
      });

    expect(res.status).toBe(200);
    const updated = res.body.repository || res.body;
    expect(updated.owner).toBe('calltelemetry');
    expect(updated.repo).toBe('cisco-cdr');
    expect(updated.customProfile).toBe('assertive');
    expect(updated.modelOverrides['sec-lane']).toBe('claude-5-sonnet');

    // Verify persistence via direct store call
    const stored = dashboardStore.getRepository('calltelemetry', 'cisco-cdr');
    expect(stored).toBeDefined();
    expect(stored?.customProfile).toBe('assertive');
    expect(stored?.modelOverrides?.['perf-lane']).toBe('gpt-5.6-sol');
  });

  it('DashboardStore calculates analytics, token time series, and cost breakdown correctly', () => {
    const store = new DashboardStore('/tmp/ct-review-bot/test_settings_store.json');
    store.recordReviewRun({
      id: 'test_run_1',
      repository: 'calltelemetry/cisco-cdr',
      prNumber: 42,
      headSha: 'head-sha-123',
      arbiterVerdict: 'SHIP',
      latencyMs: 1500,
      costUSD: 0.05,
      tokens: { prompt: 1000, completion: 500, total: 1500 },
      modelCosts: { 'claude-5-sonnet': 0.03, 'gpt-5.6-sol': 0.02 },
    });

    const summary = store.getAnalyticsSummary();
    expect(summary.totalSpendUsd).toBeGreaterThanOrEqual(0.05);

    const timeSeries = store.getTokenTimeSeries('7d');
    expect(Array.isArray(timeSeries)).toBe(true);
    expect(timeSeries.length).toBe(7);

    const costBreakdown = store.getCostBreakdown();
    expect(costBreakdown.totalSpendUsd).toBeGreaterThanOrEqual(0.05);
    expect(Array.isArray(costBreakdown.breakdown)).toBe(true);
  });

  it('enforces API key authentication on settings endpoints', async () => {
    const res = await request(app).get('/api/dashboard/settings');

    expect(res.status).toBe(401);
  });
});
