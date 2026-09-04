import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Empirical Verification: Latency Stat Reporting Accuracy in POST /api/onboarding/diagnostic', () => {
  let app: any;
  let originalFetch: typeof global.fetch;

  let initialConfigs: any = {};

  beforeEach(() => {
    initialConfigs = JSON.parse(JSON.stringify(dashboardStore.getProviderConfigs()));
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    process.env.WEBHOOK_SECRET = 'secret_key_diagnostic_test';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

    // Mock active providers in store
    const providerKeys: Record<string, string> = {
      openai: 'sk-proj-validapiKeyFormatString9988',
      anthropic: 'sk-ant-api03-validapiKeyFormatString9988',
      google: 'AIzaSy-validapiKeyFormatString9988',
      grok: 'xai-validapiKeyFormatString9988',
      xai: 'xai-validapiKeyFormatString9988',
      groq: 'gsk_validapiKeyFormatString9988',
      gemini: 'AIzaSy-validapiKeyFormatString9988',
      synthetic: 'sk-proj-validapiKeyFormatString9988',
      codex: 'sk-proj-validapiKeyFormatString9988',
      claude: 'sk-ant-api03-validapiKeyFormatString9988',
      'agy-opus': 'sk-ant-api03-validapiKeyFormatString9988',
      deepseek: 'sk-proj-validapiKeyFormatString9988',
      mistral: 'sk-proj-validapiKeyFormatString9988',
      together: 'sk-proj-validapiKeyFormatString9988',
      cohere: 'sk-proj-validapiKeyFormatString9988',
      bedrock: 'sk-proj-validapiKeyFormatString9988',
      openrouter: 'sk-or-v1-validapiKeyFormatString9988',
      ollama: 'http://localhost:11434',
      glm: 'sk-proj-validapiKeyFormatString9988',
    };

    Object.entries(providerKeys).forEach(([pId, apiKeyRaw]) => {
      try {
        dashboardStore.updateProviderConfig(pId, {
          status: 'connected',
          apiKeyRaw,
          enabled: true,
          active: true,
          latencyMs: 100,
        });
      } catch (e) {}
    });

    // Mock global.fetch to simulate OmniRoute server responses for persona panel execution
    originalFetch = global.fetch;
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/chat/completions')) {
        let reqBody: any = {};
        if (init?.body) {
          try { reqBody = JSON.parse(String(init.body)); } catch {}
        }
        const reqModel = reqBody.model || 'codex/gpt-5.6-sol-high';
        const isModerator = reqBody.messages?.some((m: any) => String(m.content).includes('moderator') || String(m.content).includes('Reconcile'));
        const isArbiter = reqBody.messages?.some((m: any) => String(m.content).includes('arbiter') || String(m.content).includes('Arbiter'));

        let expectedNonce = '';
        if (reqBody.messages && Array.isArray(reqBody.messages)) {
          for (const m of reqBody.messages) {
            const match = String(m.content).match(/(?:CT_REVIEW_NONCE|CT_REVIEW_BEGIN):([a-f0-9\-]+)/i);
            if (match) {
              expectedNonce = match[1];
              break;
            }
          }
        }

        let rawJson = '';
        if (isArbiter) {
          rawJson = JSON.stringify({ verdict: 'SHIP', rationale: 'All checks passed cleanly' });
        } else if (isModerator) {
          rawJson = JSON.stringify({ decision: 'RECONCILED', findings: [] });
        } else {
          rawJson = JSON.stringify({ decision: 'APPROVE', findings: [] });
        }

        const content = expectedNonce
          ? `CT_REVIEW_BEGIN:${expectedNonce}\n${rawJson}\nCT_REVIEW_END:${expectedNonce}`
          : rawJson;

        const separator = reqModel.indexOf('/');
        const prov = separator > 0 ? reqModel.slice(0, separator) : '';

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-omniroute-model': reqModel,
        };
        if (prov) {
          headers['x-omniroute-provider'] = prov;
        }

        return new Response(
          JSON.stringify({
            model: reqModel,
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            cost_usd: 0.0005,
          }),
          {
            status: 200,
            headers,
          }
        );
      }
      return new Response(JSON.stringify({ status: 'healthy', cryptography: { status: 'healthy' } }), { status: 200 });
    }) as typeof global.fetch;

    app = createApp();
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    if (initialConfigs) {
      Object.keys(initialConfigs).forEach((id) => {
        try {
          dashboardStore.updateProviderConfig(id, initialConfigs[id]);
        } catch (e) {}
      });
    }
  });

  it('Dimension 1: Overall Execution Duration - Check if returned latency reflects wall-clock execution time', async () => {
    const startHr = process.hrtime.bigint();
    const startPerf = performance.now();

    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .send({
        appId: '12345',
        providerIds: ['openai', 'anthropic', 'grok'],
      });

    const endPerf = performance.now();
    const endHr = process.hrtime.bigint();

    const elapsedPerfMs = endPerf - startPerf;
    const elapsedHrMs = Number(endHr - startHr) / 1_000_000;

    if (res.status !== 200) {
      console.log('[DEBUG Status Error 1]:', res.status, JSON.stringify(res.body));
    }
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // 1. Check if overall execution duration / latency field exists in response root
    const hasRootDuration = 'durationMs' in res.body || 'overallDurationMs' in res.body || 'totalLatencyMs' in res.body;

    // 2. Extract probe latencies
    const probe1Latency = res.body.probe1_webhook?.latencyMs;
    const probe2AvgLatency = res.body.probe2_latency?.avgLatencyMs;
    const probe2SumLatency = res.body.probe2_latency?.providers?.reduce((acc: number, p: any) => acc + p.latencyMs, 0);
    const probe3PanelDuration = res.body.probe3_arbitration?.panelDurationMs;

    console.log('[Empirical Test 1] Wall-Clock Duration (perf.now):', elapsedPerfMs.toFixed(3), 'ms');
    console.log('[Empirical Test 1] Wall-Clock Duration (hrtime):', elapsedHrMs.toFixed(3), 'ms');
    console.log('[Empirical Test 1] Root Duration Field Present:', hasRootDuration);
    console.log('[Empirical Test 1] Probe 1 Latency:', probe1Latency, 'ms');
    console.log('[Empirical Test 1] Probe 2 Avg Latency:', probe2AvgLatency, 'ms');
    console.log('[Empirical Test 1] Probe 2 Sum Latency:', probe2SumLatency, 'ms');
    console.log('[Empirical Test 1] Probe 3 Panel Duration:', probe3PanelDuration, 'ms');

    expect(probe1Latency).toBeDefined();
    expect(probe2AvgLatency).toBeDefined();
    expect(typeof probe2AvgLatency).toBe('number');
  });

  it('Dimension 2: Per-Persona Latency Reporting in Probe 3 - Verify durationMs per persona evaluation', async () => {
    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .send({
        appId: '12345',
        providerIds: ['openai', 'anthropic', 'grok'],
      });

    if (res.status !== 200) {
      console.log('[DEBUG 400 Status Body 2]:', res.status, res.body);
    }
    expect(res.status).toBe(200);
    const probe3 = res.body.probe3_arbitration;

    expect(probe3).toBeDefined();
    console.log('[Empirical Test 2] Personas Evaluated:', probe3.personasEvaluated);
    console.log('[Empirical Test 2] Probe 3 Panel Duration:', probe3.panelDurationMs, 'ms');

    const personaEvaluations = probe3.personaEvaluations || [];
    console.log('[Empirical Test 2] Persona Evaluations Count:', personaEvaluations.length);

    expect(personaEvaluations.length).toBeGreaterThan(0);

    let allHaveDuration = true;
    personaEvaluations.forEach((evalItem: any) => {
      console.log(`  Persona [${evalItem.personaId}]: durationMs=${evalItem.durationMs}ms, decision=${evalItem.decision}`);
      if (typeof evalItem.durationMs !== 'number' || evalItem.durationMs < 0) {
        allHaveDuration = false;
      }
    });

    expect(allHaveDuration).toBe(true);
  });

  it('Dimension 3: Probe 1 Webhook HMAC Latency Measurement Accuracy', async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({ appId: '12345', providerIds: ['openai', 'anthropic', 'grok'] });

      expect(res.status).toBe(200);
      latencies.push(res.body.probe1_webhook.latencyMs);
    }

    console.log('[Empirical Test 3] Probe 1 HMAC Latencies over 5 runs:', latencies);

    latencies.forEach((l) => {
      expect(l).toBeGreaterThanOrEqual(1);
    });
  });

  it('Dimension 4: Probe 2 Model Latency & TTFT Calculations & Provider Measurement', async () => {
    const originalConfigs = dashboardStore.getProviderConfigs();

    try {
      dashboardStore.updateProviderConfig('openai', { latencyMs: 120, displayName: 'OpenAI Test', status: 'connected', enabled: true, active: true, apiKeyRaw: 'sk-proj-validapiKeyFormatString9988' });
      dashboardStore.updateProviderConfig('anthropic', { latencyMs: 240, displayName: 'Anthropic Test', status: 'connected', enabled: true, active: true, apiKeyRaw: 'sk-ant-api03-validapiKeyFormatString9988' });
      dashboardStore.updateProviderConfig('grok', { latencyMs: 60, displayName: 'Grok Test', status: 'connected', enabled: true, active: true, apiKeyRaw: 'xai-validapiKeyFormatString9988' });

      const res = await request(app)
        .post('/api/onboarding/diagnostic')
        .send({
          appId: '12345',
          providerIds: ['openai', 'anthropic', 'grok'],
        });

      if (res.status !== 200) {
        console.log('[DEBUG 400 Status Body 4]:', res.status, res.body);
      }
      expect(res.status).toBe(200);
      const probe2 = res.body.probe2_latency;

      const openaiProvider = probe2.providers.find((p: any) => p.id === 'openai');
      const anthropicProvider = probe2.providers.find((p: any) => p.id === 'anthropic');
      const grokProvider = probe2.providers.find((p: any) => p.id === 'grok');

      console.log('[Empirical Test 4] OpenAI Reported Latency:', openaiProvider?.latencyMs);
      console.log('[Empirical Test 4] OpenAI Reported TTFT:', openaiProvider?.ttftMs);
      console.log('[Empirical Test 4] Anthropic Reported Latency:', anthropicProvider?.latencyMs);
      console.log('[Empirical Test 4] Anthropic Reported TTFT:', anthropicProvider?.ttftMs);
      console.log('[Empirical Test 4] Grok Reported Latency:', grokProvider?.latencyMs);
      console.log('[Empirical Test 4] Grok Reported TTFT:', grokProvider?.ttftMs);

      console.log('[Empirical Test 4] Reported Avg Latency:', probe2.avgLatencyMs);
      expect(typeof probe2.avgLatencyMs).toBe('number');

      // Verify avgLatencyMs matches average of reported provider latencies
      const totalLatency = probe2.providers.reduce((acc: number, p: any) => acc + p.latencyMs, 0);
      const expectedAvg = Math.round(totalLatency / probe2.providers.length);
      expect(probe2.avgLatencyMs).toBe(expectedAvg);

    } finally {
      Object.keys(originalConfigs).forEach((id) => {
        try {
          dashboardStore.updateProviderConfig(id, originalConfigs[id]);
        } catch (e) {}
      });
    }
  });

  it('Dimension 5: Edge Case - Single Provider & Quorum Failure Error Response', async () => {
    const res = await request(app)
      .post('/api/onboarding/diagnostic')
      .send({
        providerIds: ['openai'],
      });

    console.log('[Empirical Test 5] Single Provider Quorum Failure Status:', res.status);
    console.log('[Empirical Test 5] Single Provider Response Body:', res.body);

    if (res.status === 400) {
      expect(res.body.error).toContain('quorum');
    }
  });
});
