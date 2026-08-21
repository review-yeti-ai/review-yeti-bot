import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { createApp } from '../../src/app';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';

describe('Empirical Verification: Persona Store Defaults & Onboarding Diagnostic API (Gen3 Remediation Challenger 2)', () => {
  let app: any;

  beforeAll(() => {
    app = createApp();
  });

  describe('Verification 1: dashboardStore.ts Persona Model Settings Return "openrouter/auto"', () => {
    it('verifies default instance getPersonaSettings() returns "openrouter/auto" for model, modelId, and "openrouter" for providerId across all personas', () => {
      const personas = dashboardStore.getPersonaSettings();
      const personaKeys = Object.keys(personas);

      expect(personaKeys.length).toBeGreaterThan(0);
      expect(personaKeys).toContain('security');
      expect(personaKeys).toContain('architecture');
      expect(personaKeys).toContain('performance');

      for (const [id, persona] of Object.entries(personas)) {
        expect(persona.model, `Persona ${id} model should be 'openrouter/auto'`).toBe('openrouter/auto');
        if (persona.modelId !== undefined) {
          expect(persona.modelId, `Persona ${id} modelId should be 'openrouter/auto'`).toBe('openrouter/auto');
        }
        if (persona.providerId !== undefined) {
          expect(persona.providerId, `Persona ${id} providerId should be 'openrouter'`).toBe('openrouter');
        }
      }
    });

    it('verifies a newly constructed DashboardStore instance retains "openrouter/auto" defaults', () => {
      const tmpFile = path.join(process.cwd(), 'fixtures/tmp/emp_test_store.json');
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch {}
      }

      try {
        const freshStore = new DashboardStore(tmpFile);
        const personas = freshStore.getPersonaSettings();

        for (const [id, persona] of Object.entries(personas)) {
          expect(persona.model).toBe('openrouter/auto');
          if (persona.modelId) expect(persona.modelId).toBe('openrouter/auto');
          if (persona.providerId) expect(persona.providerId).toBe('openrouter');
        }
      } finally {
        if (fs.existsSync(tmpFile)) {
          try { fs.unlinkSync(tmpFile); } catch {}
        }
      }
    });
  });

  describe('Verification 2: POST /api/onboarding/diagnostic Returns HTTP 200 with Diagnostic Metrics when Test Keys Provided', () => {
    beforeEach(() => {
      // Configure test provider keys in store
      const testProviders = ['openai', 'anthropic', 'google', 'groq', 'xai', 'gemini'];
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

    it('returns HTTP 200 with all probe metrics when valid test provider keys are configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/chat/completions')) {
          const body = JSON.parse(init?.body || '{}');
          const messages = body.messages || [];
          const promptText = messages.map((m: any) => m.content).join('\n');
          const nonceMatch = promptText.match(/CT_REVIEW_NONCE:([a-f0-9\-]+)/);
          const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
          let mockObj: any = { decision: 'APPROVE', findings: [], verdict: 'SHIP', rationale: 'Empirical Verification' };
          if (promptText.includes('"role":"moderator"') || promptText.includes('"role": "moderator"')) {
            mockObj = { decision: 'RECONCILED', findings: [] };
          } else if (promptText.includes('"role":"arbiter"') || promptText.includes('"role": "arbiter"')) {
            mockObj = { verdict: 'SHIP', rationale: 'Quorum passed' };
          }
          const content = `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify(mockObj)}\nCT_REVIEW_END:${reqNonce}`;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'cmpl-emp-test',
              model: body.model || 'glm-5.2',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
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
            providerIds: ['openai', 'anthropic', 'google'],
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Probe 1: Webhook delivery check
        expect(res.body.probe1_webhook).toBeDefined();
        expect(res.body.probe1_webhook.status).toBe('accepted');
        expect(res.body.probe1_webhook.deliveryId).toMatch(/^del_/);
        expect(res.body.probe1_webhook.latencyMs).toBeGreaterThanOrEqual(0);

        // Probe 2: Latency metrics check
        expect(res.body.probe2_latency).toBeDefined();
        expect(res.body.probe2_latency.activeProviders).toBe(3);
        expect(res.body.probe2_latency.providers).toHaveLength(3);
        expect(res.body.probe2_latency.avgLatencyMs).toBeGreaterThanOrEqual(0);

        // Probe 3: Arbitration panel quorum check
        expect(res.body.probe3_arbitration).toBeDefined();
        expect(res.body.probe3_arbitration.personasEvaluated).toBeGreaterThanOrEqual(11);
        expect(res.body.probe3_arbitration.quorumPassed).toBe(true);
        expect(res.body.probe3_arbitration.verdict).toBe('SHIP');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('returns HTTP 400 error when provider credentials are invalid or unconfigured', async () => {
      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          providerIds: ['unconfigured_provider'],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('API key credentials missing, unconfigured, or invalid');
    });

    it('fails closed when the arbiter response is missing its rationale', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/chat/completions')) {
          const body = JSON.parse(init?.body || '{}');
          const messages = body.messages || [];
          const promptText = messages.map((m: any) => m.content).join('\n');
          const nonceMatch = promptText.match(/CT_REVIEW_NONCE:([a-f0-9\-]+)/);
          const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
          const content = `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP' })}\nCT_REVIEW_END:${reqNonce}`;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content } }],
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

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('arbiter');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
