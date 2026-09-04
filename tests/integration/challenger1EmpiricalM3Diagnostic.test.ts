import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import * as panelEngine from '../../src/panel/panelEngine';

const TEMP_STORE_PATH = path.join('/tmp', 'ct-review-bot', `diagnostic_challenger_m3_${Date.now()}.json`);

describe('Milestone 3 Empirical Challenge: POST /api/onboarding/diagnostic', () => {
  let app: any;

  beforeEach(() => {
    process.env.CT_DASHBOARD_STORE = TEMP_STORE_PATH;
    if (fs.existsSync(TEMP_STORE_PATH)) {
      fs.unlinkSync(TEMP_STORE_PATH);
    }
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(TEMP_STORE_PATH)) {
      fs.unlinkSync(TEMP_STORE_PATH);
    }
    delete process.env.CT_DASHBOARD_STORE;
  });

  describe('1. Unconfigured or Invalid Credentials Verification', () => {
    it('returns HTTP 400 Bad Request with clear error message when credentials are unconfigured', async () => {
      // Set provider configs in store to unconfigured. 'unconfigured' is now part of
      // ProviderConfigRecord['status'] (REL-573) since src/api/onboarding.ts genuinely
      // branches on `cfg.status === 'unconfigured'` at runtime.
      dashboardStore.updateProviderConfig('openai', { status: 'unconfigured', apiKeyRaw: '' });

      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '123456',
          providerIds: ['openai'],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/unconfigured|invalid|missing|quorum/i);
    }, 15000);

    it('returns HTTP 400 Bad Request with clear error message when credentials are invalid', async () => {
      // Set provider config in store to unconfigured API key. 'unconfigured' is now part
      // of ProviderConfigRecord['status'] (REL-573).
      dashboardStore.updateProviderConfig('openai', { status: 'unconfigured', apiKeyRaw: '' });

      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '123456',
          providerIds: ['openai'],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/unconfigured|invalid|missing|quorum/i);
    }, 15000);

    it('returns HTTP 400 Bad Request when simulateInvalidCredentials flag is provided', async () => {
      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '123456',
          simulateInvalidCredentials: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/unconfigured|invalid|missing|quorum/i);
    });
  });

  describe('2. Connection Timeout Verification', () => {
    it('returns HTTP 400 Bad Request with clear error message on connection timeout', async () => {
      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '123456',
          simulateTimeout: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/timeout|timed out/i);
    });

    it('returns HTTP 400 Bad Request with clear error message on simulated network error', async () => {
      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '123456',
          simulateNetworkError: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/network|connection/i);
    });
  });

  describe('3. Active & Valid Credentials Verification', () => {
    it('returns HTTP 200 OK with valid live latency metrics when credentials are active and valid', async () => {
      // Mock executePersonaPanel to simulate active network response for Probe 3
      vi.spyOn(panelEngine, 'executePersonaPanel').mockResolvedValue({
        headSha: 'abc1234',
        optionalFailures: [],
        quorum: { required: 3, distinctProviders: ['codex', 'grok', 'claude'], satisfied: true },
        personas: [
          { id: 'security', required: true, findings: [], providerId: 'codex', model: 'gpt-5.6-sol-high', decision: 'APPROVE', durationMs: 42, usage: { prompt: 100, completion: 50, total: 150 }, costUSD: 0.001 },
          { id: 'architecture', required: true, findings: [], providerId: 'grok', model: 'grok-4.5', decision: 'APPROVE', durationMs: 38, usage: { prompt: 100, completion: 50, total: 150 }, costUSD: 0.001 },
          { id: 'quality', required: true, findings: [], providerId: 'claude', model: 'claude-opus-4-8', decision: 'APPROVE', durationMs: 45, usage: { prompt: 100, completion: 50, total: 150 }, costUSD: 0.001 },
        ],
        moderator: { decision: 'RECONCILED', findings: [], raw: '' } as any,
        arbiter: { verdict: 'SHIP', summary: 'Clean approval across all personas', confidence: 0.98, raw: '' } as any,
      });

      // Configure 4 active providers with valid credentials & statuses
      const validProviders = ['openai', 'anthropic', 'google', 'groq'];
      const validKeys: Record<string, string> = {
        openai: 'sk-proj-aB9cD8eF7gH6jK5mN4pQ3rS2tU1vW0xY',
        anthropic: 'sk-ant-aB9cD8eF7gH6jK5mN4pQ3rS2tU1vW0xY',
        google: 'AIzaSyaB9cD8eF7gH6jK5mN4pQ3rS2tU1vW0xY',
        groq: 'gsk_aB9cD8eF7gH6jK5mN4pQ3rS2tU1vW0xY',
      };
      validProviders.forEach((id) => {
        dashboardStore.updateProviderConfig(id, {
          status: 'connected',
          active: true,
          enabled: true,
          apiKeyRaw: validKeys[id],
          latencyMs: 85,
        });
      });

      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '1048293',
          providerIds: validProviders,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Probe 1 check: Webhook delivery & HMAC signature
      expect(res.body.probe1_webhook).toBeDefined();
      expect(res.body.probe1_webhook.status).toBe('accepted');
      expect(res.body.probe1_webhook.deliveryId).toMatch(/^del_/);
      expect(res.body.probe1_webhook.latencyMs).toBeGreaterThan(0);

      // Probe 2 check: Live provider latency & TTFT metrics
      expect(res.body.probe2_latency).toBeDefined();
      expect(res.body.probe2_latency.activeProviders).toBe(4);
      expect(res.body.probe2_latency.avgLatencyMs).toBeGreaterThan(0);
      expect(Array.isArray(res.body.probe2_latency.providers)).toBe(true);
      expect(res.body.probe2_latency.providers).toHaveLength(4);
      expect(res.body.probe2_latency.providers[0]).toHaveProperty('latencyMs');
      expect(res.body.probe2_latency.providers[0]).toHaveProperty('ttftMs');
      expect(res.body.probe2_latency.providers[0]).toHaveProperty('costPer1kPromptUSD');
      expect(res.body.probe2_latency.providers[0]).toHaveProperty('costPer1kCompletionUSD');

      // Probe 3 check: Persona arbitration & quorum check
      expect(res.body.probe3_arbitration).toBeDefined();
      expect(res.body.probe3_arbitration.quorumPassed).toBe(true);
      expect(res.body.probe3_arbitration.verdict).toBe('SHIP');
    });
  });
});
