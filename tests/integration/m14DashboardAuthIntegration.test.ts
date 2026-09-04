import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, runReviewPipeline } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';
import { requireAuth } from '../../src/api/authMiddleware';
import express, { Express } from 'express';

describe('M14 Integration: Dashboard REST API & Auth Portal', () => {
  let app: Express;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    app = createApp();
  });

  describe('1. Authentication Portal API (/api/auth)', () => {
    it('POST /api/auth/login authenticates admin user with valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.token).toMatch(/^sess_/);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('admin');
      expect(res.body.user.role).toBe('admin');
      expect(res.body.expiresAt).toBeDefined();
    });

    it('POST /api/auth/login rejects login with wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'incorrect_password' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid username or password');
    });

    it('POST /api/auth/login returns 400 when missing required username field', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'admin123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid login request');
    });

    it('GET /api/auth/session validates active session token', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      const token = loginRes.body.token;

      const sessionRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(sessionRes.status).toBe(200);
      expect(sessionRes.body.success).toBe(true);
      expect(sessionRes.body.authenticated).toBe(true);
      expect(sessionRes.body.user.username).toBe('admin');
    });

    it('GET /api/auth/session rejects request with missing Authorization header', async () => {
      const res = await request(app).get('/api/auth/session');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.error).toBe('No active session token provided');
    });

    it('GET /api/auth/session rejects request with invalid Bearer token', async () => {
      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', 'Bearer sess_invalid_token_999999');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.error).toBe('Session expired or invalid');
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
      expect(deleteRes.body.success).toBe(true);
      expect(deleteRes.body.message).toBe('Session invalidated successfully');

      // Subsequent session check must fail
      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(checkRes.status).toBe(401);
      expect(checkRes.body.authenticated).toBe(false);
    });

    it('API Key Lifecycle: creation, listing with masking, store validation, and revocation', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      // 1. Create API key
      const createRes = await request(app)
        .post('/api/auth/apikeys')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Integration Test Bot Key' });

      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);
      expect(createRes.body.apiKey).toBeDefined();
      expect(createRes.body.apiKey.rawKey).toMatch(/^ct_live_[a-f0-9]{32}$/);
      expect(createRes.body.apiKey.maskedKey).toMatch(/^ct_live_\.\.\.[a-f0-9]{4}$/);

      const keyId = createRes.body.apiKey.id;
      const rawKey = createRes.body.apiKey.rawKey;

      // 2. Validate raw key against store
      expect(dashboardStore.validateApiKey(rawKey)).toBe(true);

      // 3. List API keys (verify masking and absence of raw secret)
      const listRes = await request(app)
        .get('/api/auth/apikeys')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.success).toBe(true);
      expect(Array.isArray(listRes.body.apiKeys)).toBe(true);

      const keyRecord = listRes.body.apiKeys.find((k: any) => k.id === keyId);
      expect(keyRecord).toBeDefined();
      expect(keyRecord.name).toBe('Integration Test Bot Key');
      expect(keyRecord.maskedKey).toBe(createRes.body.apiKey.maskedKey);
      expect(keyRecord.rawKey).toBeUndefined();

      // 4. Revoke API key
      const deleteRes = await request(app)
        .delete(`/api/auth/apikeys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
      expect(deleteRes.body.removedId).toBe(keyId);

      // 5. Verify revoked API key is no longer valid
      expect(dashboardStore.validateApiKey(rawKey)).toBe(false);

      // 6. Delete non-existent key returns 404
      const deleteNonExistent = await request(app)
        .delete('/api/auth/apikeys/key_non_existent')
        .set('Authorization', `Bearer ${token}`);
      expect(deleteNonExistent.status).toBe(404);
      expect(deleteNonExistent.body.success).toBe(false);
    });
  });

  describe('2. Security & Unauthorized Access Controls', () => {
    it('requireAuth middleware enforces authentication on protected routes', async () => {
      const protectedApp = express();
      protectedApp.use(express.json());
      protectedApp.get('/api/protected', requireAuth, (_req, res) => {
        res.status(200).json({ success: true, message: 'Access granted' });
      });

      // Attempt 1: Missing headers
      const missingHeadersRes = await request(protectedApp).get('/api/protected');
      expect(missingHeadersRes.status).toBe(401);
      expect(missingHeadersRes.body.error).toContain('Unauthorized');

      // Attempt 2: Invalid JWT / Bearer token
      const invalidJwtRes = await request(protectedApp)
        .get('/api/protected')
        .set('Authorization', 'Bearer sess_invalid_token_99999');
      expect(invalidJwtRes.status).toBe(401);

      // Attempt 3: Revoked API key
      const adminLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const adminToken = adminLogin.body.token;

      const createRes = await request(app)
        .post('/api/auth/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Temp Key For Revocation' });
      const rawKey = createRes.body.apiKey.rawKey;
      const keyId = createRes.body.apiKey.id;

      // Verify key works before revocation
      const validKeyRes = await request(protectedApp)
        .get('/api/protected')
        .set('x-api-key', rawKey);
      expect(validKeyRes.status).toBe(200);

      // Revoke the key
      await request(app)
        .delete(`/api/auth/apikeys/${keyId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Attempt 4: Access with revoked API key
      const revokedKeyRes = await request(protectedApp)
        .get('/api/protected')
        .set('x-api-key', rawKey);
      expect(revokedKeyRes.status).toBe(401);
      expect(revokedKeyRes.body.error).toContain('Unauthorized');
    });

    it('CHECK Security Vulnerability: /api/dashboard/* endpoints authentication protection check', async () => {
      // Create a revoked key for testing
      const adminLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const adminToken = adminLogin.body.token;

      const keyRes = await request(app)
        .post('/api/auth/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Revoked Key Test' });
      const revokedKey = keyRes.body.apiKey.rawKey;
      await request(app)
        .delete(`/api/auth/apikeys/${keyRes.body.apiKey.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Test 1: Missing headers on /api/dashboard/overview
      const resMissingHeader = await request(app).get('/api/dashboard/overview');

      // Test 2: Invalid JWT token on /api/dashboard/settings
      const resInvalidJwt = await request(app)
        .get('/api/dashboard/settings')
        .set('Authorization', 'Bearer invalid_jwt_token_12345');

      // Test 3: Revoked API key on /api/dashboard/repositories
      const resRevokedKey = await request(app)
        .get('/api/dashboard/repositories')
        .set('x-api-key', revokedKey);

      // Test 4: Unauthenticated mutation attempt on /api/dashboard/settings
      const resUnauthMutation = await request(app)
        .put('/api/dashboard/settings')
        .send({ providerCostCaps: { monthlyBudgetUSD: 0 } });

      // Audit result: Check if endpoints enforce authorization or allow unauthenticated access
      const isOverviewProtected = resMissingHeader.status === 401;
      const isSettingsProtected = resInvalidJwt.status === 401;
      const isReposProtected = resRevokedKey.status === 401;
      const isMutationProtected = resUnauthMutation.status === 401;

      // Assert expected protection status
      expect({
        isOverviewProtected,
        isSettingsProtected,
        isReposProtected,
        isMutationProtected,
      }).toEqual({
        isOverviewProtected: true,
        isSettingsProtected: true,
        isReposProtected: true,
        isMutationProtected: true,
      });
    });

    it('enforces authentication on /api/code/symbol-graph and /api/code/search endpoints', async () => {
      // 1. Unauthenticated requests must return 401
      const resGraphUnauth = await request(app)
        .post('/api/code/symbol-graph')
        .send({ symbolName: 'createApp' });
      expect(resGraphUnauth.status).toBe(401);
      expect(resGraphUnauth.body.success).toBe(false);

      const resSearchUnauth = await request(app)
        .post('/api/code/search')
        .send({ query: 'createApp' });
      expect(resSearchUnauth.status).toBe(401);
      expect(resSearchUnauth.body.success).toBe(false);

      // 2. Authenticated request with Bearer session token returns 200
      const adminLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const bearerToken = adminLogin.body.token;

      const resGraphBearer = await request(app)
        .post('/api/code/symbol-graph')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ symbolName: 'createApp' });
      expect(resGraphBearer.status).toBe(200);
      expect(resGraphBearer.body.success).toBe(true);

      const resSearchBearer = await request(app)
        .post('/api/code/search')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ query: 'createApp' });
      expect(resSearchBearer.status).toBe(200);
      expect(resSearchBearer.body.success).toBe(true);

      // 3. Authenticated request with x-api-key returns 200
      const keyRes = await request(app)
        .post('/api/auth/apikeys')
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ name: 'Integration Test Code Search Key' });
      const rawApiKey = keyRes.body.apiKey.rawKey;

      const resGraphApiKey = await request(app)
        .post('/api/code/symbol-graph')
        .set('x-api-key', rawApiKey)
        .send({ symbolName: 'createApp' });
      expect(resGraphApiKey.status).toBe(200);
      expect(resGraphApiKey.body.success).toBe(true);

      const resSearchApiKey = await request(app)
        .post('/api/code/search')
        .set('x-api-key', rawApiKey)
        .send({ query: 'createApp' });
      expect(resSearchApiKey.status).toBe(200);
      expect(resSearchApiKey.body.success).toBe(true);
    });
  });

  describe('3. Repository Automation Toggles & PR Review Pipeline', () => {
    it('disabling repository automation skips PR review execution', async () => {
      const owner = 'calltelemetry';
      const repo = 'cisco-cdr';

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      // 1. Ensure automation is enabled initially
      await request(app)
        .patch(`/api/dashboard/repositories/${owner}/${repo}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ automationEnabled: true });
      expect(dashboardStore.isAutomationEnabled(owner, repo)).toBe(true);

      // 2. Disable automation via PATCH /api/dashboard/repositories/:owner/:repo
      const patchRes = await request(app)
        .patch(`/api/dashboard/repositories/${owner}/${repo}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ automationEnabled: false, customProfile: 'assertive' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.repository.automationEnabled).toBe(false);
      expect(patchRes.body.repository.customProfile).toBe('assertive');
      expect(dashboardStore.isAutomationEnabled(owner, repo)).toBe(false);

      // 3. Trigger review pipeline for disabled repo
      const pipelineResult = await runReviewPipeline({
        owner,
        repo,
        prNumber: 42,
        headSha: 'a1b2c3d4e5f67890123456789012345678901234',
        baseSha: 'b2c3d4e5f67890123456789012345678901234a1',
        title: 'Test PR for disabled automation',
        body: '',
        sender: 'octocat',
        labels: [],
        triggerSource: 'pr_event',
        triggerAction: 'opened',
        deliveryId: 'delivery-m14-disabled-automation',
        installationId: '12345',
      });

      expect(pipelineResult).toEqual({
        status: 'skipped',
        reason: 'automation disabled per repo setting',
      });

      // 4. Batch toggle update via PATCH /api/dashboard/repositories
      const batchPatchRes = await request(app)
        .patch('/api/dashboard/repositories')
        .set('Authorization', `Bearer ${token}`)
        .send({ owner, repo, automationEnabled: true, customProfile: 'chill' });

      expect(batchPatchRes.status).toBe(200);
      expect(batchPatchRes.body.repository.automationEnabled).toBe(true);
      expect(batchPatchRes.body.repository.customProfile).toBe('chill');
      expect(dashboardStore.isAutomationEnabled(owner, repo)).toBe(true);
    });

    it('PATCH /api/dashboard/repositories returns 400 when owner or repo is missing', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const res = await request(app)
        .patch('/api/dashboard/repositories')
        .set('Authorization', `Bearer ${token}`)
        .send({ automationEnabled: false });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('owner and repo are required in body');
    });

    it('GET /api/dashboard/repositories/:owner/:repo returns 404 for non-existent repository', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/dashboard/repositories/unknown_org/non_existent_repo')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Repository unknown_org/non_existent_repo not found');
    });
  });

  describe('4. Settings Mutation (/api/dashboard/settings)', () => {
    it('GET /api/dashboard/settings returns current platform settings', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.settings).toBeDefined();
      expect(res.body.settings.defaultModelOverrides).toBeDefined();
      expect(res.body.settings.memoryEngineSettings).toBeDefined();
      expect(res.body.settings.providerCostCaps).toBeDefined();
    });

    it('PUT /api/dashboard/settings updates and persists platform settings', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });
      const token = loginRes.body.token;

      const updatePayload = {
        defaultModelOverrides: {
          codex: 'codex/gpt-5.6-turbo-custom',
        },
        memoryEngineSettings: {
          autoSuppressNits: false,
          learningConfidenceThreshold: 92,
        },
        providerCostCaps: {
          monthlyBudgetUSD: 500.0,
          dailyBudgetUSD: 50.0,
          alertThresholdPercent: 90,
          actionOnCapBreach: 'disable_optional' as const,
        },
      };

      const putRes = await request(app)
        .put('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`)
        .send(updatePayload);

      expect(putRes.status).toBe(200);
      expect(putRes.body.success).toBe(true);
      expect(putRes.body.settings.defaultModelOverrides.codex).toBe('codex/gpt-5.6-turbo-custom');
      expect(putRes.body.settings.memoryEngineSettings.autoSuppressNits).toBe(false);
      expect(putRes.body.settings.memoryEngineSettings.learningConfidenceThreshold).toBe(92);
      expect(putRes.body.settings.providerCostCaps.monthlyBudgetUSD).toBe(500.0);
      expect(putRes.body.settings.providerCostCaps.dailyBudgetUSD).toBe(50.0);
      expect(putRes.body.settings.providerCostCaps.alertThresholdPercent).toBe(90);
      expect(putRes.body.settings.providerCostCaps.actionOnCapBreach).toBe('disable_optional');

      // Verify persistence via GET /api/dashboard/settings
      const getRes = await request(app)
        .get('/api/dashboard/settings')
        .set('Authorization', `Bearer ${token}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.settings.memoryEngineSettings.learningConfidenceThreshold).toBe(92);
      expect(getRes.body.settings.providerCostCaps.monthlyBudgetUSD).toBe(500.0);

      // Verify store directly
      const storeSettings = dashboardStore.getSettings();
      expect(storeSettings.memoryEngineSettings.learningConfidenceThreshold).toBe(92);
      expect(storeSettings.providerCostCaps.monthlyBudgetUSD).toBe(500.0);
    });
  });
});
