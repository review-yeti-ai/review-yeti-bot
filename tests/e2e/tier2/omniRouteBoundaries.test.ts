import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { OmniRouteClient } from '@src/gateway/omniRouteClient';

describe('Tier 2 Boundary & Corner Case Tests: OmniRoute Gateway & Provider Failover', () => {
  let harness: E2ETestHarness;
  let client: OmniRouteClient;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-omniroute-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockGithub.reset();
    harness.mockOmniRoute.resetState();
    client = new OmniRouteClient({
      baseUrl: `http://127.0.0.1:${harness.mockOmniRoute.port}`,
      accessToken: 'valid-access-token-123',
      refreshToken: 'valid-refresh-token',
      fallbackProviders: ['anthropic', 'google'],
    });
  });

  test('1. LLM provider timeout/failover boundary - automatically fails over to fallback provider on 5xx errors', async () => {
    // Inject 503 Service Unavailable for primary provider 'openai'
    harness.mockOmniRoute.configure({
      failProvider: {
        provider: 'openai',
        status: 503,
        message: 'OpenAI Upstream Overloaded',
        failCount: 1,
      },
    });

    const res = await client.completion({
      provider: 'openai',
      persona: 'security',
      prompt: 'Review diff hunk',
    });

    // Should automatically fall back to 'anthropic'
    expect(res.status).toBe(200);
    expect(res.providerUsed).toBe('anthropic');

    const reqs = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = reqs.filter(r => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBe(2);
    expect(chatReqs[0].body.provider).toBe('openai');
    expect(chatReqs[1].body.provider).toBe('anthropic');
  });

  test('2. Rate limits 429 boundary - handles HTTP 429 Too Many Requests response gracefully', async () => {
    harness.mockOmniRoute.configure({
      failProvider: {
        provider: 'openai',
        status: 429,
        message: 'Rate limit exceeded: 60 RPM limit reached',
        failCount: 1,
      },
    });

    // Request without autoRetry fallback for 5xx
    const res = await client.completion(
      {
        provider: 'openai',
        persona: 'performance',
        prompt: 'Check memory footprint',
      },
      false
    );

    expect(res.status).toBe(429);
    expect(res.data?.error?.message).toContain('Rate limit exceeded');
  });

  test('3. Invalid API keys 401 boundary - refreshes expired OAuth access token automatically', async () => {
    // Set token expired in mock server
    harness.mockOmniRoute.configure({ tokenExpired: true });

    const res = await client.completion({
      provider: 'openai',
      persona: 'architecture',
      prompt: 'Check coupling',
    });

    // Client auto-refreshes token via refreshOAuthToken() and retries
    expect(res.status).toBe(200);
    expect(client.getAccessToken()).toBe('new-access-token-456');

    // Test with invalid refresh token
    const badClient = new OmniRouteClient({
      baseUrl: `http://127.0.0.1:${harness.mockOmniRoute.port}`,
      accessToken: 'expired-token',
      refreshToken: 'invalid-refresh-token',
    });

    harness.mockOmniRoute.configure({ tokenExpired: true });
    await expect(badClient.refreshOAuthToken()).rejects.toThrow('Token refresh failed with status 400');
  });

  test('4. Empty model completions boundary - handles completion responses with minimal or missing content', async () => {
    const res = await client.completion({
      provider: 'anthropic',
      persona: 'quality',
      prompt: '', // Empty prompt
    });

    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    expect(res.tokensUsed).toBeDefined();
    expect(res.tokensUsed.total).toBeGreaterThan(0);
  });

  test('5. Token count overflows and reasoning trace boundary - accurately tracks high token usage and reasoning trace', async () => {
    const res = await client.completion({
      provider: 'openai',
      persona: 'security',
      effortLevel: 'reasoning',
      prompt: 'Deep reasoning analysis of multi-file diff',
    });

    expect(res.status).toBe(200);
    expect(res.tokensUsed.prompt).toBe(400);
    expect(res.tokensUsed.completion).toBe(500);
    expect(res.tokensUsed.total).toBe(900);
    expect(res.reasoningTrace).toContain('<thinking>');
  });
});
