import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';

function setupOmniRouteFetchMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes('/v1/chat/completions')) {
      const body = JSON.parse(init?.body || '{}');
      const messages = body.messages || [];
      const promptText = messages.map((m: any) => m.content).join('\n');
      const nonceMatch = promptText.match(/CT_REVIEW_NONCE:([a-f0-9\-]+)/);
      const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';

      let mockObj: any = {
        decision: 'APPROVE',
        findings: [],
        verdict: 'SHIP',
        rationale: 'Live diagnostic execution verified code structure and performance constraints.',
      };

      if (promptText.includes('"role":"moderator"') || promptText.includes('"role": "moderator"')) {
        mockObj = { decision: 'RECONCILED', findings: [] };
      } else if (promptText.includes('"role":"arbiter"') || promptText.includes('"role": "arbiter"')) {
        mockObj = { verdict: 'SHIP', rationale: 'All persona checks passed successfully.' };
      }

      const content = `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify(mockObj)}\nCT_REVIEW_END:${reqNonce}`;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'cmpl-mock-diag',
          model: body.model || 'glm-5.2',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 },
        }),
      } as any;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as any;
  });
}

describe('POST /api/onboarding/diagnostic (Requirement R1: Live API-Driven Scanner)', () => {
  let app: any;
  let authToken: string;

  beforeEach(async () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    process.env.WEBHOOK_SECRET = 'whsec_test_secret_key_12345';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body?.token || 'demo_token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should execute live onboarding diagnostic scan with Probes 1, 2, and 3', async () => {
    setupOmniRouteFetchMock();

    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        appId: '12345',
        providerIds: ['openai', 'anthropic', 'google', 'groq'],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Probe 1: Webhook Delivery & Signature Check
    expect(res.body.probe1_webhook).toBeDefined();
    expect(res.body.probe1_webhook.status).toBe('accepted');
    expect(res.body.probe1_webhook.deliveryId).toMatch(/^del_/);
    expect(res.body.probe1_webhook.latencyMs).toBeGreaterThan(0);

    // Probe 2: Provider Latency & TTFT Metrics
    expect(res.body.probe2_latency).toBeDefined();
    expect(res.body.probe2_latency.activeProviders).toBe(4);
    expect(res.body.probe2_latency.providers).toHaveLength(4);
    expect(res.body.probe2_latency.avgLatencyMs).toBeGreaterThan(0);
    expect(res.body.probe2_latency.providers[0]).toHaveProperty('latencyMs');
    expect(res.body.probe2_latency.providers[0]).toHaveProperty('ttftMs');
    expect(res.body.probe2_latency.providers[0]).toHaveProperty('costPer1kPromptUSD');
    expect(res.body.probe2_latency.providers[0]).toHaveProperty('costPer1kCompletionUSD');

    // Probe 3: Live Panel Engine Arbitration & Persona Evaluations
    expect(res.body.probe3_arbitration).toBeDefined();
    expect(res.body.probe3_arbitration.personasEvaluated).toBeGreaterThanOrEqual(11);
    expect(res.body.probe3_arbitration.distinctProvidersUsed).toBe(4);
    expect(res.body.probe3_arbitration.quorumPassed).toBe(true);
    expect(res.body.probe3_arbitration.verdict).toBe('SHIP');
    expect(res.body.probe3_arbitration.personaEvaluations).toBeDefined();
    expect(res.body.probe3_arbitration.personaEvaluations.length).toBeGreaterThan(0);
    expect(res.body.probe3_arbitration.personaEvaluations[0]).toHaveProperty('passed', true);
    expect(res.body.probe3_arbitration.personaEvaluations[0]).toHaveProperty('durationMs');
    expect(res.body.probe3_arbitration.moderator).toBeDefined();
    expect(res.body.probe3_arbitration.arbiter).toBeDefined();
  });

  it('should output live API latency metrics in probe2_latency and probe3_arbitration', async () => {
    setupOmniRouteFetchMock();

    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        providerIds: ['openai', 'anthropic', 'google'],
      });

    expect(res.status).toBe(200);
    expect(res.body.probe2_latency.providers.length).toBe(3);
    res.body.probe2_latency.providers.forEach((p: any) => {
      expect(typeof p.latencyMs).toBe('number');
      expect(p.latencyMs).toBeGreaterThan(0);
      expect(typeof p.ttftMs).toBe('number');
      expect(p.ttftMs).toBeGreaterThan(0);
    });

    expect(res.body.probe3_arbitration.panelDurationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.body.probe3_arbitration.personaEvaluations)).toBe(true);
  });

  it('should return HTTP 400 Bad Request when API key credentials are missing or invalid', async () => {
    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        providerIds: ['invalid_provider'],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('credentials missing, unconfigured, or invalid');
  });

  it('should return HTTP 400 Bad Request when credentials simulated as invalid', async () => {
    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        simulateInvalidCredentials: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('credentials missing, unconfigured, or invalid');
  });

  it('should fail fast with HTTP 400 Bad Request on connection timeouts during diagnostic scan', async () => {
    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        simulateTimeout: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('timed out');
  });

  it('should fail fast with HTTP 400 Bad Request on network errors during diagnostic scan', async () => {
    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        simulateNetworkError: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Network connection error');
  });

  it('should calculate quorum correctly and set verdict to REQUEST_CHANGES if <3 providers configured', async () => {
    setupOmniRouteFetchMock();

    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        providerIds: ['openai', 'anthropic'],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.probe3_arbitration.distinctProvidersUsed).toBe(2);
    expect(res.body.probe3_arbitration.quorumPassed).toBe(false);
    expect(res.body.probe3_arbitration.verdict).toBe('REQUEST_CHANGES');
  });
});
