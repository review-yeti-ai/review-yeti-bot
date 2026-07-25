import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';

describe('Milestone 14: Backend Auth Portal & Dashboard API Integration Tests', () => {
  let app: any;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    app = createApp();
  });

  describe('Authentication Portal API (/api/auth)', () => {
    it('POST /api/auth/login authenticates admin successfully', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.username).toBe('admin');
    });

    it('POST /api/auth/login rejects invalid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/auth/session validates an active session token', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      const token = loginRes.body.token;

      const sessionRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(sessionRes.status).toBe(200);
      expect(sessionRes.body.authenticated).toBe(true);
      expect(sessionRes.body.user.username).toBe('admin');
    });

    it('DELETE /api/auth/session invalidates session token', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      const token = loginRes.body.token;

      const deleteRes = await request(app)
        .delete('/api/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(deleteRes.status).toBe(200);

      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(checkRes.status).toBe(401);
      expect(checkRes.body.authenticated).toBe(false);
    });

    it('API Key creation, listing, validation, and revocation', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      // 1. Create API key
      const createRes = await request(app)
        .post('/api/auth/apikeys')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'CI Deployment Key' });

      expect(createRes.status).toBe(201);
      expect(createRes.body.apiKey.rawKey).toMatch(/^ct_live_/);
      const keyId = createRes.body.apiKey.id;
      const rawKey = createRes.body.apiKey.rawKey;

      // 2. Validate API key against store
      expect(dashboardStore.validateApiKey(rawKey)).toBe(true);

      // 3. List API keys (should mask raw key)
      const listRes = await request(app)
        .get('/api/auth/apikeys')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.apiKeys.length).toBeGreaterThan(0);
      const keyRecord = listRes.body.apiKeys.find((k: any) => k.id === keyId);
      expect(keyRecord).toBeDefined();
      expect(keyRecord.maskedKey).toMatch(/^ct_live_\.\.\./);
      expect(keyRecord.rawKey).toBeUndefined();

      // 4. Revoke API key
      const deleteRes = await request(app)
        .delete(`/api/auth/apikeys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.removedId).toBe(keyId);
      expect(dashboardStore.validateApiKey(rawKey)).toBe(false);
    });
  });

  describe('Dashboard Overview, Repositories, & Settings API (/api/dashboard)', () => {
    it('GET /api/dashboard/overview returns system metrics', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/dashboard/overview')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.overview.totalRepositories).toBeGreaterThanOrEqual(1);
      expect(res.body.overview.totalTokens).toBeDefined();
      expect(res.body.overview.providerHealth).toBeDefined();
    });

    it('GET & PATCH /api/dashboard/repositories updates automation state', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const getRes = await request(app)
        .get('/api/dashboard/repositories')
        .set('Authorization', `Bearer ${token}`);
      expect(getRes.status).toBe(200);

      const patchRes = await request(app)
        .patch('/api/dashboard/repositories/calltelemetry/cisco-cdr')
        .set('Authorization', `Bearer ${token}`)
        .send({ automationEnabled: false, customProfile: 'assertive' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.repository.automationEnabled).toBe(false);
      expect(patchRes.body.repository.customProfile).toBe('assertive');

      expect(dashboardStore.isAutomationEnabled('calltelemetry', 'cisco-cdr')).toBe(false);

      // Restore toggle
      await request(app)
        .patch('/api/dashboard/repositories/calltelemetry/cisco-cdr')
        .set('Authorization', `Bearer ${token}`)
        .send({ automationEnabled: true });
      expect(dashboardStore.isAutomationEnabled('calltelemetry', 'cisco-cdr')).toBe(true);
    });

    it('GET & PUT /api/dashboard/settings updates platform settings', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const getRes = await request(app)
        .get('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`);
      expect(getRes.status).toBe(200);

      const putRes = await request(app)
        .put('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerCostCaps: {
            monthlyBudgetUSD: 250.0,
          },
        });

      expect(putRes.status).toBe(200);
      expect(putRes.body.settings.providerCostCaps.monthlyBudgetUSD).toBe(250.0);
    });
  });
});
