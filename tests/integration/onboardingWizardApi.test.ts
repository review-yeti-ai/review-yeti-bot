import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import path from 'node:path';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Tier 1 & Tier 2 Onboarding & GitHub App API Integration Suite', () => {
  let app: any;
  let validApiKey: string;
  let validRsaPrivateKeyPem: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.GITHUB_APP_ID = '123456';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0TestKey...';

    // Generate real RSA 2048 private key PEM for RS256 JWT verification test
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    validRsaPrivateKeyPem = privateKey;
  });

  beforeEach(() => {
    app = createApp();
    const keyRecord = dashboardStore.createApiKey(`test-key-${Date.now()}`);
    validApiKey = keyRecord.rawKey;

    const testProviders = ['openai', 'anthropic', 'google', 'groq', 'xai', 'gemini', 'codex', 'grok', 'claude'];
    const getKey = (p: string) => {
      if (p === 'anthropic' || p === 'claude') return 'sk-ant-a1b2c3d4e5f6g7h8i9j0k1l2';
      if (p === 'google' || p === 'gemini') return 'AIzaSya1b2c3d4e5f6g7h8i9j0k1l2';
      if (p === 'grok' || p === 'xai') return 'xai-a1b2c3d4e5f6g7h8i9j0k1l2';
      if (p === 'groq') return 'gsk_a1b2c3d4e5f6g7h8i9j0k1l2';
      return 'sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2';
    };
    for (const p of testProviders) {
      dashboardStore.updateProviderConfig(p, {
        status: 'connected',
        apiKeyRaw: getKey(p),
        enabled: true,
        active: true,
      });
    }
  });

  // =========================================================================
  // Feature 1: Onboarding Tech Stack Scanning & YAML Config Generation (9 tests)
  // =========================================================================
  describe('Feature 1: Onboarding Tech Stack Scanner & YAML Generator APIs', () => {
    it('POST /api/onboarding/wizard - scans default process.cwd fallback when body is empty', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scanResult).toBeDefined();
      expect(res.body.scanResult.detection).toBeDefined();
      expect(res.body.generatedConfig).toBeDefined();
      expect(typeof res.body.yamlText).toBe('string');
    });

    it('POST /api/onboarding/wizard - scans specified valid repository path', async () => {
      const targetPath = process.cwd();
      const res = await request(app)
        .post('/api/onboarding/wizard')
        .send({ repoPath: targetPath });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scanResult).toBeDefined();
      expect(res.body.result).toBeDefined();
    });

    it('POST /api/onboarding/wizard - returns 400 error for invalid non-existent repo path', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard')
        .send({ repoPath: '/invalid/nonexistent/directory/path/99999' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid repository path');
    });

    it('POST /api/onboarding/wizard - returns 400 error when repoPath is a file instead of directory', async () => {
      const filePath = path.join(process.cwd(), 'package.json');
      const res = await request(app)
        .post('/api/onboarding/wizard')
        .send({ repoPath: filePath });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid repository path');
    });

    it('POST /api/onboarding/wizard/scan - tech stack scanning endpoint executes successfully', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/scan')
        .send({ repoPath: process.cwd() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scanResult).toBeDefined();
      expect(res.body.yamlText).toBeDefined();
    });

    it('POST /api/onboarding/wizard/scan - returns 400 error for non-existent path', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/scan')
        .send({ repoPath: '/path/does/not/exist/foo' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid repository path');
    });

    it('POST /api/onboarding/wizard/generate - generates YAML config with default parameters', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/generate')
        .send({
          scanResult: {
            detectedLanguages: ['TypeScript', 'Node.js'],
            detectedFrameworks: ['Express', 'Next.js'],
            configFilesFound: ['package.json', 'tsconfig.json'],
            detection: { confidence: 0.95, scanDurationMs: 12 },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.yamlText).toBeDefined();
      expect(res.body.yamlText).toContain('version: 3');
      expect(res.body.config).toBeDefined();
    });

    it('POST /api/onboarding/wizard/generate - generates YAML with custom profile, ticket enforcement, and persona selections', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/generate')
        .send({
          scanResult: {
            detectedLanguages: ['TypeScript'],
            detectedFrameworks: ['React'],
            configFilesFound: ['package.json'],
            detection: { confidence: 0.9, scanDurationMs: 10 },
          },
          profile: 'assertive',
          ticketEnforcement: true,
          selectedPersonaIds: ['security', 'architecture', 'database'],
          customPathFilters: ['src/**/*.ts', 'api/**/*.ts'],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.yamlText).toContain('ticket_enforcement: true');
      expect(res.body.config).toBeDefined();
      expect(res.body.config.personas).toBeDefined();
    });

    it('POST /api/onboarding/wizard/generate - generates YAML with chill profile and disabled ticket enforcement', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/generate')
        .send({
          profile: 'chill',
          ticketEnforcement: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.yamlText).toContain('ticket_enforcement: false');
    });
  });

  // =========================================================================
  // Feature 2: GitHub App Configuration & Monitored Repositories (8 tests)
  // =========================================================================
  describe('Feature 2: GitHub App Config & Monitored Repositories APIs', () => {
    it('GET /api/github/app-config - retrieves active configuration and monitored repo count', async () => {
      const res = await request(app)
        .get('/api/github/app-config')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.appConfig).toBeDefined();
      expect(typeof res.body.appConfig.monitoredReposCount).toBe('number');
    });

    it('POST /api/github/app-config - updates GitHub App credentials and settings', async () => {
      const res = await request(app)
        .post('/api/github/app-config')
        .set('x-api-key', validApiKey)
        .send({
          appId: '987654',
          installationId: 'inst_112233',
          webhookSecret: 'super-secret-key-123',
          privateKeyPem: validRsaPrivateKeyPem,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.appConfig.appId).toBe('987654');
      expect(res.body.appConfig.installationId).toBe('inst_112233');
      expect(res.body.appConfig.privateKeyPemRaw.trim()).toBe(validRsaPrivateKeyPem.trim());
    });

    it('PUT /api/github/app-config - updates GitHub App credentials using PUT method', async () => {
      const res = await request(app)
        .put('/api/github/app-config')
        .set('x-api-key', validApiKey)
        .send({
          appId: '555444',
          webhookSecret: 'put-updated-secret',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.appConfig.appId).toBe('555444');
    });

    it('DELETE /api/github/app-config - resets GitHub App configuration credentials', async () => {
      const res = await request(app)
        .delete('/api/github/app-config')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('reset successfully');
      expect(res.body.appConfig.appId).toBe('');
      expect(res.body.appConfig.installationId).toBe('');
    });

    it('GET /api/github/app-config/monitored-repos - lists monitored organization repositories', async () => {
      const res = await request(app)
        .get('/api/github/app-config/monitored-repos')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.repositories)).toBe(true);
      expect(typeof res.body.totalCount).toBe('number');
      expect(typeof res.body.activeCount).toBe('number');
    });

    it('PATCH /api/github/app-config/monitored-repos - updates repo toggle and profile via body', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set('x-api-key', validApiKey)
        .send({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          automationEnabled: false,
          customProfile: 'assertive',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.repository.automationEnabled).toBe(false);
      expect(res.body.repository.customProfile).toBe('assertive');
    });

    it('PATCH /api/github/app-config/monitored-repos/:owner/:repo - updates status via URL params', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
        .set('x-api-key', validApiKey)
        .send({
          automationEnabled: true,
          customProfile: 'balanced',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.repository.owner).toBe('calltelemetry');
      expect(res.body.repository.repo).toBe('cisco-cdr');
      expect(res.body.repository.automationEnabled).toBe(true);
      expect(res.body.repository.customProfile).toBe('balanced');
    });

    it('PATCH /api/github/app-config/monitored-repos - returns 400 error when owner/repo is missing', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set('x-api-key', validApiKey)
        .send({ automationEnabled: true });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('owner and repo parameters are required');
    });
  });

  // =========================================================================
  // Feature 3: Verification, Enforcement Policy & Manifest Callback (7 tests)
  // =========================================================================
  describe('Feature 3: RS256 Key Verification, Policy & Manifest Callback APIs', () => {
    it('POST /api/github/app-config/verify - verifies valid RS256 private key PEM and generates JWT', async () => {
      const res = await request(app)
        .post('/api/github/app-config/verify')
        .set('x-api-key', validApiKey)
        .send({
          appId: '123456',
          privateKeyPem: validRsaPrivateKeyPem,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.verified).toBe(true);
      expect(res.body.jwtGenerated).toBe(true);
      expect(res.body.tokenPrefix).toBeDefined();
    });

    it('POST /api/github/app-config/verify - returns 400 error when appId or privateKeyPem is missing', async () => {
      const res = await request(app)
        .post('/api/github/app-config/verify')
        .set('x-api-key', validApiKey)
        .send({ appId: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required GitHub App ID or RSA Private Key PEM');
    });

    it('POST /api/github/app-config/verify - returns 400 error for invalid/corrupted RSA key', async () => {
      const res = await request(app)
        .post('/api/github/app-config/verify')
        .set('x-api-key', validApiKey)
        .send({
          appId: '123456',
          privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nNOT_A_VALID_KEY\n-----END RSA PRIVATE KEY-----',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.verified).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('GET /api/github/enforcement-policy - retrieves enterprise PR review policy rules', async () => {
      const res = await request(app)
        .get('/api/github/enforcement-policy')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.policy).toBeDefined();
      expect(typeof res.body.policy.require_all_reviews).toBe('boolean');
      expect(res.body.policy.failure_action).toBeDefined();
    });

    it('PUT /api/github/enforcement-policy - updates enterprise PR enforcement settings', async () => {
      const res = await request(app)
        .put('/api/github/enforcement-policy')
        .set('x-api-key', validApiKey)
        .send({
          require_all_reviews: false,
          require_ticket_link: true,
          failure_action: 'warn_only',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.policy.require_all_reviews).toBe(false);
      expect(res.body.policy.require_ticket_link).toBe(true);
      expect(res.body.policy.failure_action).toBe('warn_only');
    });

    it('GET /api/github/manifest-callback - returns 400 error when code parameter is missing', async () => {
      const res = await request(app)
        .get('/api/github/manifest-callback')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(400);
      expect(res.text).toContain('Missing code parameter');
    });

    it('GET /api/github/manifest-callback - converts manifest code and redirects on success', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 998877,
          pem: validRsaPrivateKeyPem,
          client_id: 'client_123',
          client_secret: 'secret_456',
          webhook_secret: 'wh_secret_789',
        }),
      } as any);

      try {
        const res = await request(app)
          .get('/api/github/manifest-callback?code=mock_github_code_123')
          .set('x-api-key', validApiKey);

        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('/dashboard/github-app?status=auto_registered');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // =========================================================================
  // Feature 5: Provider Connectivity Testing & Diagnostic Scan APIs (6 tests)
  // =========================================================================
  describe('Feature 5: Provider Connectivity & Diagnostic Probe APIs', () => {
    it('POST /api/dashboard/providers/:id/test - tests connectivity with valid HTTP endpoint', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      } as any);

      try {
        const res = await request(app)
          .post('/api/dashboard/providers/openai/test')
          .set('x-api-key', validApiKey)
          .send({ baseUrl: 'https://api.openai.com/v1' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('connected');
        expect(res.body.latencyMs).toBeGreaterThan(0);
        expect(res.body.message).toContain('verified successfully');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('POST /api/dashboard/providers/:id/test - returns 400 error for invalid URL schema', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/custom_provider/test')
        .set('x-api-key', validApiKey)
        .send({ baseUrl: 'ftp://invalid-provider-url.com' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('disconnected');
      expect(res.body.error).toContain('Invalid or missing base URL');
    });

    it('POST /api/dashboard/providers/:id/test - handles custom base URL override and authentication errors', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as any);

      try {
        const res = await request(app)
          .post('/api/dashboard/providers/anthropic/test')
          .set('x-api-key', validApiKey)
          .send({ baseUrl: 'https://api.anthropic.com' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.status).toBe('error');
        expect(res.body.statusCode).toBe(401);
        expect(res.body.message).toContain('Authentication failed');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('POST /api/onboarding/diagnostic - runs diagnostic scan with probe 1, 2, and 3', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/chat/completions')) {
          const body = JSON.parse(init?.body || '{}');
          const messages = body.messages || [];
          const promptText = messages.map((m: any) => m.content).join('\n');
          const nonceMatch = promptText.match(/CT_REVIEW_NONCE:([a-f0-9\-]+)/);
          const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
          let mockObj: any = { decision: 'APPROVE', findings: [], verdict: 'SHIP', rationale: 'Verified' };
          if (promptText.includes('"role":"moderator"') || promptText.includes('"role": "moderator"')) {
            mockObj = { decision: 'RECONCILED', findings: [] };
          } else if (promptText.includes('"role":"arbiter"') || promptText.includes('"role": "arbiter"')) {
            mockObj = { verdict: 'SHIP', rationale: 'All persona checks passed' };
          }
          const content = `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify(mockObj)}\nCT_REVIEW_END:${reqNonce}`;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'cmpl-mock',
              model: body.model || 'glm-5.2',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      try {
        const res = await request(app)
          .post('/api/onboarding/diagnostic')
          .send({
            appId: '123456',
            providerIds: ['openai', 'anthropic', 'google', 'groq'],
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Probe 1: Webhook delivery
        expect(res.body.probe1_webhook).toBeDefined();
        expect(res.body.probe1_webhook.status).toBe('accepted');
        expect(res.body.probe1_webhook.deliveryId).toBeDefined();
        expect(typeof res.body.probe1_webhook.latencyMs).toBe('number');

        // Probe 2: Latency ping
        expect(res.body.probe2_latency).toBeDefined();
        expect(res.body.probe2_latency.activeProviders).toBe(4);
        expect(Array.isArray(res.body.probe2_latency.providers)).toBe(true);
        expect(res.body.probe2_latency.providers.length).toBe(4);

        // Probe 3: Persona arbitration quorum
        expect(res.body.probe3_arbitration).toBeDefined();
        expect(res.body.probe3_arbitration.personasEvaluated).toBe(11);
        expect(res.body.probe3_arbitration.quorumPassed).toBe(true);
        expect(res.body.probe3_arbitration.verdict).toBe('SHIP');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('POST /api/onboarding/diagnostic - accepts custom provider list and calculates metrics', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/chat/completions')) {
          const body = JSON.parse(init?.body || '{}');
          const messages = body.messages || [];
          const promptText = messages.map((m: any) => m.content).join('\n');
          const nonceMatch = promptText.match(/CT_REVIEW_NONCE:([a-f0-9\-]+)/);
          const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
          let mockObj: any = { decision: 'APPROVE', findings: [], verdict: 'SHIP', rationale: 'Verified' };
          if (promptText.includes('"role":"moderator"') || promptText.includes('"role": "moderator"')) {
            mockObj = { decision: 'RECONCILED', findings: [] };
          } else if (promptText.includes('"role":"arbiter"') || promptText.includes('"role": "arbiter"')) {
            mockObj = { verdict: 'SHIP', rationale: 'All persona checks passed' };
          }
          const content = `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify(mockObj)}\nCT_REVIEW_END:${reqNonce}`;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'cmpl-mock',
              model: body.model || 'glm-5.2',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      try {
        const res = await request(app)
          .post('/api/onboarding/diagnostic')
          .send({
            providerIds: ['openai', 'anthropic', 'xai'],
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.probe2_latency.activeProviders).toBe(3);
        expect(res.body.probe2_latency.providers).toHaveLength(3);
        expect(res.body.probe3_arbitration.distinctProvidersUsed).toBe(3);
        expect(res.body.probe3_arbitration.quorumPassed).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('POST /api/onboarding/diagnostic - handles single provider and evaluates quorum accordingly', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/chat/completions')) {
          const body = JSON.parse(init?.body || '{}');
          const messages = body.messages || [];
          const promptText = messages.map((m: any) => m.content).join('\n');
          const nonceMatch = promptText.match(/CT_REVIEW_NONCE:([a-f0-9\-]+)/);
          const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
          let mockObj: any = { decision: 'APPROVE', findings: [], verdict: 'SHIP', rationale: 'Verified' };
          if (promptText.includes('"role":"moderator"') || promptText.includes('"role": "moderator"')) {
            mockObj = { decision: 'RECONCILED', findings: [] };
          } else if (promptText.includes('"role":"arbiter"') || promptText.includes('"role": "arbiter"')) {
            mockObj = { verdict: 'SHIP', rationale: 'All persona checks passed' };
          }
          const content = `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify(mockObj)}\nCT_REVIEW_END:${reqNonce}`;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'cmpl-mock',
              model: body.model || 'glm-5.2',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      try {
        const res = await request(app)
          .post('/api/onboarding/diagnostic')
          .send({
            providerIds: ['openai'],
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.probe2_latency.activeProviders).toBe(1);
        expect(res.body.probe3_arbitration.quorumPassed).toBe(false);
        expect(res.body.probe3_arbitration.verdict).toBe('REQUEST_CHANGES');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
