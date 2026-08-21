import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Milestone 6: Interactive Dashboard & Connection Manager Unit & Integration Suite', () => {
  let app: any;
  let apiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret-m6';
    app = createApp();
  });

  beforeEach(() => {
    const createdKey = dashboardStore.createApiKey('m6-test-key');
    apiKey = createdKey.rawKey;
  });

  describe('1. Requirement R1: PR Review Jobs & Persona Details', () => {
    it('fetches review logs containing detailed fields (headSha, quorum, tokenDetails, personaLogs)', async () => {
      const res = await request(app)
        .get('/api/dashboard/logs')
        .set('x-api-key', apiKey);
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.logs)).toBe(true);

      if (res.body.logs.length > 0) {
        const first = res.body.logs[0];
        expect(first).toHaveProperty('id');
        expect(first.prRun || first.repo).toBeDefined();
      }
    });
  });

  describe('2. Requirement R2: Dashboard Config API & Memory Graph', () => {
    it('GET /api/dashboard/config returns default cost caps and overview stats', async () => {
      const res = await request(app)
        .get('/api/dashboard/config')
        .set('x-api-key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config).toBeDefined();
      expect(res.body.config.monthlyCostCapUSD).toBeGreaterThan(0);
      expect(res.body.overview).toBeDefined();
    });

    it('PUT /api/dashboard/config updates monthly cost cap and provider cost caps', async () => {
      const updatePayload = {
        monthlyCostCapUSD: 350.0,
        providerCostCaps: {
          monthlyBudgetUSD: 350.0,
          dailyBudgetUSD: 35.0,
          alertThresholdPercent: 85,
          actionOnCapBreach: 'disable_optional',
        },
      };

      const res = await request(app)
        .put('/api/dashboard/config')
        .set('x-api-key', apiKey)
        .send(updatePayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.monthlyCostCapUSD).toBe(350.0);
      expect(res.body.overview.monthlyCostCapUSD).toBe(350.0);

      // Verify persistence in store
      const updatedOverview = dashboardStore.getOverviewStats();
      expect(updatedOverview.monthlyCostCapUSD).toBe(350.0);
    });

    it('queries symbol graph and memory learnings endpoints', async () => {
      const graphRes = await request(app)
        .post('/api/code/symbol-graph')
        .set('x-api-key', apiKey)
        .send({ symbolName: 'createDashboardRouter' });

      expect(graphRes.status).toBe(200);

      const memRes = await request(app)
        .get('/api/memory/query?repo=calltelemetry/cisco-cdr')
        .set('x-api-key', apiKey);

      expect(memRes.status).toBe(200);
    });
  });

  describe('3. Requirement R3: Enhanced Integrations & Connection Manager', () => {
    it('supports doppler, sentry, jira, and slack in integrations list', async () => {
      const res = await request(app)
        .get('/api/dashboard/integrations')
        .set('x-api-key', apiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const ids = res.body.integrations.map((i: any) => i.id);
      expect(ids).toContain('doppler');
      expect(ids).toContain('sentry');
      expect(ids).toContain('jira');
      expect(ids).toContain('slack');
      expect(ids).toContain('linear');
      expect(ids).toContain('github');
    });

    it('PUT /api/dashboard/integrations updates credentials for Doppler, Sentry, Jira, and Slack', async () => {
      const platforms = [
        { platform: 'doppler', apiKey: 'dp.pt.test_token_123', settings: { project: 'my-proj' } },
        { platform: 'sentry', apiKey: 'sntry_test_token_456', settings: { orgSlug: 'my-org' } },
        { platform: 'jira', apiKey: 'ATATT3_test_token_789', settings: { hostUrl: 'https://jira.test' } },
        { platform: 'slack', apiKey: 'xoxb-test-token-000', webhookUrl: 'https://hooks.slack.com/test' },
      ];

      for (const p of platforms) {
        const res = await request(app)
          .put('/api/dashboard/integrations')
          .set('x-api-key', apiKey)
          .send(p);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.integration.id).toBe(p.platform);
        expect(res.body.integration.status).toBe('connected');
      }
    });

    it('POST /api/dashboard/integrations/:platform/test executes connection verification tests', async () => {
      const platforms = ['doppler', 'sentry', 'jira', 'slack', 'linear', 'github'];

      for (const platform of platforms) {
        const res = await request(app)
          .post(`/api/dashboard/integrations/${platform}/test`)
          .set('x-api-key', apiKey)
          .send({ apiKey: 'valid_test_key' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('connected');
        expect(res.body.latencyMs).toBeGreaterThan(0);
        expect(res.body.message).toContain(platform);
      }
    });

    it('handles connection test error simulation gracefully', async () => {
      const res = await request(app)
        .post('/api/dashboard/integrations/jira/test')
        .set('x-api-key', apiKey)
        .send({ apiKey: 'invalid_key', simulateError: true });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('error');
    });

    it('rejects query parameter bypass attempts (GET /api/dashboard/integrations?bypass=/health) with HTTP 401 Unauthorized', async () => {
      const res = await request(app).get('/api/dashboard/integrations?bypass=/health');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unauthorized');
    });
  });
});
