import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import supertest from 'supertest';
import { createDashboardRouter } from '../../src/api/dashboardApi';
import { createIntegrationsRouter } from '../../src/dashboard/integrationsApi';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';
import { createOnboardingRouter } from '../../src/api/onboarding';
import { requireAuth } from '../../src/api/authMiddleware';
import { authService } from '../../src/dashboard/authService';
import { generateGitHubAppJwt } from '../../src/github/appAuth';
import crypto from 'crypto';

describe('Empirical Challenger M2: 6 Routes & Edge Cases Verification', () => {
  let app: Express;
  let bearerToken: string;
  let authHeaders: Record<string, string>;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Public auth middleware applied globally as in app.ts
    app.use(requireAuth);

    // Register routers as mounted in app.ts
    const dashboardRouter = createDashboardRouter();
    app.use('/api/dashboard', dashboardRouter);
    app.use('/api/personas', dashboardRouter);
    app.use('/api/dashboard', createIntegrationsRouter());
    app.use('/api/github', createGitHubAppApiRouter());
    app.use('/api/onboarding', createOnboardingRouter());

    // Login to obtain valid bearer token
    const session = authService.login('admin', 'admin123');
    bearerToken = session ? session.token : '';
    authHeaders = { Authorization: `Bearer ${bearerToken}` };
  });

  describe('1. Auth Middleware Security Edge Cases Across All 6 Route Categories', () => {
    it('rejects unauthenticated requests to protected API endpoints with 401 Unauthorized', async () => {
      const protectedEndpoints = [
        '/api/dashboard/overview',
        '/api/dashboard/repositories',
        '/api/dashboard/settings',
        '/api/dashboard/personas',
        '/api/dashboard/integrations',
        '/api/github/app-config',
        '/api/github/enforcement-policy',
      ];

      for (const endpoint of protectedEndpoints) {
        const res = await supertest(app).get(endpoint);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Unauthorized');
      }
    });

    it('allows public unauthenticated access to whitelist routes', async () => {
      const publicEndpoints = ['/health', '/ready', '/version', '/about'];

      for (const endpoint of publicEndpoints) {
        const res = await supertest(app).get(endpoint);
        expect(res.status).not.toBe(401);
      }
    });

    it('authenticates successfully with valid Bearer token', async () => {
      const res = await supertest(app)
        .get('/api/dashboard/overview')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('2. Persona Payload Updates Edge Cases (PUT /api/personas & PUT /api/dashboard/personas/:persona)', () => {
    it('rejects PUT /api/personas when personaId is missing', async () => {
      const res = await supertest(app)
        .put('/api/dashboard/personas')
        .set(authHeaders)
        .send({ confidenceThreshold: 85 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('personaId is required');
    });

    it('successfully updates persona settings via PUT /api/dashboard/personas/:persona', async () => {
      const patch = {
        confidenceThreshold: 88,
        enabled: true,
        customPrompt: 'Focus on zero-trust RBAC',
      };

      const res = await supertest(app)
        .put('/api/dashboard/personas/security')
        .set(authHeaders)
        .send(patch);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.persona.confidenceThreshold).toBe(88);
      expect(res.body.persona.customPrompt).toBe('Focus on zero-trust RBAC');
    });

    it('returns 404 for unknown/non-existent persona ID', async () => {
      const res = await supertest(app)
        .put('/api/dashboard/personas/non_existent_persona_999')
        .set(authHeaders)
        .send({ confidenceThreshold: 50 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('handles batch updates gracefully across multiple personas', async () => {
      const personaIds = ['security', 'architecture', 'performance'];
      for (const id of personaIds) {
        const res = await supertest(app)
          .put(`/api/dashboard/personas/${id}`)
          .set(authHeaders)
          .send({ confidenceThreshold: 90, enabled: true });
        expect(res.status).toBe(200);
        expect(res.body.persona.confidenceThreshold).toBe(90);
      }
    });
  });

  describe('3. Integration Connection Testing Edge Cases (POST /api/dashboard/integrations/:platform/test)', () => {
    it('rejects invalid or unsupported integration platform with 400 Bad Request', async () => {
      const res = await supertest(app)
        .post('/api/dashboard/integrations/unsupported_platform/test')
        .set(authHeaders)
        .send({ apiKey: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Must be one of: linear, github, context7');
    });

    it('handles uppercase platform parameters gracefully', async () => {
      const res = await supertest(app)
        .post('/api/dashboard/integrations/GITHUB/test')
        .set(authHeaders)
        .send({ apiKey: 'ghp_mock12345' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('connected');
      expect(res.body.latencyMs).toBeGreaterThanOrEqual(1);
    });

    it('handles simulateError and invalid_key credentials correctly', async () => {
      const res = await supertest(app)
        .post('/api/dashboard/integrations/slack/test')
        .set(authHeaders)
        .send({ apiKey: 'invalid_key' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('HTTP 401 Unauthorized');
    });

    it('returns connection verification status for integration test calls', async () => {
      const res = await supertest(app)
        .post('/api/dashboard/integrations/jira/test')
        .set(authHeaders)
        .send({ apiKey: 'jira_api_token_123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('connected');
      expect(res.body.message).toContain('verified successfully');
    });
  });

  describe('4. Onboarding Scan API & Response Contract Verification', () => {
    it('returns 400 Bad Request when non-existent repo path is provided', async () => {
      const res = await supertest(app)
        .post('/api/onboarding/wizard')
        .set(authHeaders)
        .send({ repoPath: '/non_existent/path/999' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid repository path');
    });

    it('returns valid scanResult structure matching client contract for valid repo path', async () => {
      const res = await supertest(app)
        .post('/api/onboarding/wizard')
        .set(authHeaders)
        .send({ repoPath: process.cwd() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const scanResult = res.body.scanResult || res.body.result;
      expect(scanResult).toBeDefined();
      expect(scanResult.detection).toBeDefined();
      expect(scanResult.detection.languages).toBeDefined();
      expect(res.body.generatedConfig || res.body.yamlText).toBeDefined();
    });
  });

  describe('5. RSA PEM Private Key Parsing & GitHub App Verification Edge Cases', () => {
    it('rejects POST /api/github/app-config/verify when appId or privateKeyPem is missing', async () => {
      const res = await supertest(app)
        .post('/api/github/app-config/verify')
        .set(authHeaders)
        .send({ appId: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required GitHub App ID or RSA Private Key PEM');
    });

    it('rejects malformed or invalid PEM key strings gracefully without 500 server crashes', async () => {
      const res = await supertest(app)
        .post('/api/github/app-config/verify')
        .set(authHeaders)
        .send({
          appId: '12345',
          privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nINVALID_DATA_STREAM\n-----END RSA PRIVATE KEY-----',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.verified).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('successfully generates RS256 JWT when given a valid RSA 2048 PEM key', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const jwt = generateGitHubAppJwt('12345', privateKey);
      expect(jwt).toBeDefined();
      expect(jwt.split('.').length).toBe(3);

      const res = await supertest(app)
        .post('/api/github/app-config/verify')
        .set(authHeaders)
        .send({
          appId: '12345',
          privateKeyPem: privateKey,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.verified).toBe(true);
      expect(res.body.jwtGenerated).toBe(true);
    });
  });
});
