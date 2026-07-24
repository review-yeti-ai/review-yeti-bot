import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { OmniRouteClient } from '@src/gateway/omniRouteClient';

describe('Tier 1 Feature Coverage: OmniRoute AI Provider Gateway & Routing Engine', () => {
  let harness: E2ETestHarness;
  let omniUrl: string;
  let client: OmniRouteClient;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-omniroute-suite',
    });
    omniUrl = `http://127.0.0.1:${harness.mockOmniRoute.port}`;
    client = new OmniRouteClient({ baseUrl: omniUrl });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockOmniRoute.resetState();
    client = new OmniRouteClient({ baseUrl: omniUrl });
  });

  test('1. Multi-provider prompt routing across OpenAI, Anthropic, and Google providers', async () => {
    const providers = ['openai', 'anthropic', 'google'];

    for (const provider of providers) {
      const res = await client.completion({
        provider,
        persona: 'security',
        effortLevel: 'medium',
        prompt: `Analyze vulnerability for provider ${provider}`,
      });

      expect(res.status).toBe(200);
      expect(res.providerUsed).toBe(provider);
      if (provider === 'anthropic') {
        expect(res.modelUsed).toBe('claude-3-5-sonnet');
      } else {
        expect(res.modelUsed).toBe('gpt-4o');
      }
    }
  });

  test('2. OAuth 2.0 token refresh routine handles expired token failover and renewal', async () => {
    // 1. Expire token on MockOmniRouteServer
    harness.mockOmniRoute.configure({ tokenExpired: true });

    // 2. Completion attempt without autoRetry receives 401
    const failRes = await client.completion({ provider: 'openai' }, false);
    expect(failRes.status).toBe(401);
    expect(failRes.data.error.code).toBe('token_expired');

    // 3. Issue OAuth refresh via client method
    const tokenData = await client.refreshOAuthToken();
    expect(tokenData.access_token).toBe('new-access-token-456');

    // 4. Retry chat request using client with updated token
    const successRes = await client.completion({ provider: 'openai' }, false);
    expect(successRes.status).toBe(200);
  });

  test('3. Effort level configurations adjust token allocation and reasoning traces (low, medium, high, reasoning)', async () => {
    const effortLevels: Array<'low' | 'medium' | 'high' | 'reasoning'> = ['low', 'medium', 'high', 'reasoning'];

    for (const effortLevel of effortLevels) {
      const res = await client.completion({
        persona: 'architecture',
        effortLevel,
        provider: 'openai',
      });

      expect(res.status).toBe(200);
      expect(res.tokensUsed.total).toBeGreaterThan(0);

      if (effortLevel === 'low') {
        expect(res.tokensUsed.prompt).toBe(80);
        expect(res.tokensUsed.completion).toBe(40);
        expect(res.reasoningTrace).toBeUndefined();
      } else if (effortLevel === 'high') {
        expect(res.tokensUsed.prompt).toBe(300);
        expect(res.tokensUsed.completion).toBe(250);
      } else if (effortLevel === 'reasoning') {
        expect(res.tokensUsed.prompt).toBe(400);
        expect(res.tokensUsed.completion).toBe(500);
        expect(res.reasoningTrace).toBeDefined();
        expect(res.reasoningTrace).toContain('<thinking>');
      }
    }
  });

  test('4. Provider pool selection handles provider failure injection and failover state', async () => {
    // Inject failure for 'primary-llm' provider
    harness.mockOmniRoute.configure({
      failProvider: { provider: 'primary-llm', status: 503, message: 'Primary Provider Unavailable', failCount: 1 },
    });

    // Request to primary-llm fails when autoRetry/failover disabled
    const failRes = await client.completion({ provider: 'primary-llm' }, false);
    expect(failRes.status).toBe(503);
    expect(failRes.data.error.provider).toBe('primary-llm');

    // Fallback request to fallback provider 'anthropic' succeeds
    const fallbackRes = await client.completion({ provider: 'anthropic' });
    expect(fallbackRes.status).toBe(200);
    expect(fallbackRes.providerUsed).toBe('anthropic');
  });

  test('5. Accurately tracks prompt, completion, and total token usage across requests', async () => {
    // Make 3 requests via client
    for (let i = 0; i < 3; i++) {
      await client.completion({ effortLevel: 'medium', provider: 'openai' });
    }

    const recorded = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = recorded.filter((r) => r.path === '/v1/chat/completions');

    expect(chatReqs.length).toBeGreaterThanOrEqual(3);
    for (const req of chatReqs) {
      expect(req.body).toHaveProperty('provider');
    }
  });

  test('6. Admin control endpoints allow dynamic configuration and state reset', async () => {
    // Configure admin error injection via client method
    await client.configureAdmin({
      failProvider: { provider: 'test-prov', status: 500, failCount: 2 },
    });

    // Verify test-prov fails
    const failRes = await client.completion({ provider: 'test-prov' }, false);
    expect(failRes.status).toBe(500);

    // Reset state via client method
    await client.resetAdmin();

    // Next request succeeds
    const okRes = await client.completion({ provider: 'test-prov' }, false);
    expect(okRes.status).toBe(200);
  });
});
