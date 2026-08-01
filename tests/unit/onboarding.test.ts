import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { scanRepositoryStack } from '../../src/onboarding/stackScanner';
import { generateCtReviewConfig } from '../../src/onboarding/configGenerator';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Milestone 29: Zero-Config Onboarding Wizard', () => {
  const currentRepoPath = path.resolve(__dirname, '../../');

  describe('stackScanner', () => {
    it('should scan repository stack in sub-second duration', async () => {
      const scanResult = await scanRepositoryStack(currentRepoPath);

      expect(scanResult).toBeDefined();
      expect(scanResult.detection.scanDurationMs).toBeLessThan(5000);
      expect(scanResult.detection.totalFilesScanned).toBeGreaterThan(0);
      expect(scanResult.detection.manifestsFound).toContain('package.json');
      expect(scanResult.detection.languages.TypeScript).toBeGreaterThan(0);

      const personaIds = scanResult.recommendedPersonas.map((p) => p.id);
      expect(personaIds).toContain('security-arbiter');
      expect(personaIds).toContain('ts-node-architect');
    });
  });

  describe('configGenerator', () => {
    it('should auto-generate valid CtReviewConfigV3 YAML string', async () => {
      const scanResult = await scanRepositoryStack(currentRepoPath);
      const generated = generateCtReviewConfig({
        scanResult,
        profile: 'balanced',
        ticketEnforcement: true,
      });

      expect(generated.yamlText).toContain('version: 3');
      expect(generated.yamlText).toContain('profile: balanced');
      expect(generated.yamlText).toContain('ticket_enforcement: true');
      expect(generated.config.version).toBe(3);
      expect(generated.config.personas.length).toBeGreaterThan(0);
      expect(generated.config.personas.some((p) => p.required)).toBe(true);
    });
  });

  describe('Onboarding REST API Endpoints', () => {
    let app: any;
    let authToken: string;

    beforeEach(async () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      process.env.WEBHOOK_SECRET = 'secret';
      process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

      app = createApp();

      const testProviders = ['openai', 'anthropic', 'gemini', 'grok', 'google', 'groq', 'xai'];
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

      const loginRes = await request(createApp())
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      authToken = loginRes.body?.token || 'demo_token';
    });

    it('POST /api/onboarding/wizard/scan should return stack scan results', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/scan')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ repoPath: currentRepoPath });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scanResult.detection.scanDurationMs).toBeLessThan(1000);
      expect(res.body.scanResult.detection.manifestsFound).toContain('package.json');
    });

    it('POST /api/onboarding/wizard/scan should return 400 for invalid repository path', async () => {
      const res = await request(app)
        .post('/api/onboarding/wizard/scan')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ repoPath: '/invalid/nonexistent/directory/path' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid repository path');
    });

    it('POST /api/onboarding/wizard/generate should return valid YAML text and config', async () => {
      const scanResult = await scanRepositoryStack(currentRepoPath);

      const res = await request(app)
        .post('/api/onboarding/wizard/generate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          scanResult,
          profile: 'assertive',
          ticketEnforcement: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.yamlText).toContain('version: 3');
      expect(res.body.yamlText).toContain('profile: assertive');
      expect(res.body.config.version).toBe(3);
    });

    it('POST /api/onboarding/diagnostic should execute genuine Probes 1, 2, and 3 with full metrics', async () => {
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
            appId: '12345',
            providerIds: ['openai', 'anthropic', 'gemini', 'grok'],
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Probe 1 check
        expect(res.body.probe1_webhook).toBeDefined();
        expect(res.body.probe1_webhook.status).toBe('accepted');
        expect(res.body.probe1_webhook.deliveryId).toMatch(/^del_/);
        expect(res.body.probe1_webhook.latencyMs).toBeGreaterThan(0);

        // Probe 2 check
        expect(res.body.probe2_latency).toBeDefined();
        expect(res.body.probe2_latency.activeProviders).toBe(4);
        expect(res.body.probe2_latency.providers).toHaveLength(4);
        expect(res.body.probe2_latency.providers[0]).toHaveProperty('ttftMs');
        expect(res.body.probe2_latency.providers[0]).toHaveProperty('costPer1kPromptUSD');

        // Probe 3 check
        expect(res.body.probe3_arbitration).toBeDefined();
        expect(res.body.probe3_arbitration.personasEvaluated).toBeGreaterThanOrEqual(11);
        expect(res.body.probe3_arbitration.distinctProvidersUsed).toBe(4);
        expect(res.body.probe3_arbitration.quorumPassed).toBe(true);
        expect(res.body.probe3_arbitration.verdict).toBe('SHIP');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('POST /api/onboarding/diagnostic should fail quorum when fewer than 3 distinct providers are configured', async () => {
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
            providerIds: ['openai', 'anthropic'],
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.probe3_arbitration.distinctProvidersUsed).toBe(2);
        expect(res.body.probe3_arbitration.quorumPassed).toBe(false);
        expect(res.body.probe3_arbitration.verdict).toBe('REQUEST_CHANGES');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});

