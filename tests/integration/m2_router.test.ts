import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, getProviderPool, getTokenManager } from '../../src/app';
import { OmniRouteAdapter, ProviderConfig } from '../../src/router/omniRouteAdapter';
import { ProviderPool } from '../../src/router/providerPool';
import { TokenManager } from '../../src/router/tokenManager';
import { MockOmniRouteServer } from '../e2e/harness/mockOmniRouteServer';

describe('Milestone 2 OmniRoute Router & Token Management Integration Suite', () => {
  let mockServer: MockOmniRouteServer;
  let mockPort: number;

  beforeEach(async () => {
    mockServer = new MockOmniRouteServer(0); // Use dynamic free port
    await mockServer.start();
    mockPort = mockServer.port;
  });

  afterEach(async () => {
    await mockServer.stop();
  });

  describe('1. Express App Status & Health Endpoint Integration', () => {
    it('GET /health includes active router subsystem status summary', async () => {
      const app = createApp();
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('ct-review-bot');
      expect(res.body.router).toBeDefined();
      expect(res.body.router.activeProviders).toBeGreaterThan(0);
      expect(res.body.router.poolStatus).toBe('ok');
    });

    it('GET /api/router/status returns complete pool snapshot, circuit breaker states, and token metrics', async () => {
      const app = createApp();
      const pool = getProviderPool();
      const tokenMgr = getTokenManager();

      tokenMgr.recordUsage({
        requestId: 'integration-req-1',
        persona: 'security',
        effortLevel: 'high',
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 150,
        completionTokens: 250,
        totalTokens: 400,
        durationMs: 180,
        timestamp: new Date().toISOString(),
      });

      const res = await request(app).get('/api/router/status');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.strategy).toBe('priority_fallback');
      expect(res.body.providers).toBeDefined();
      expect(res.body.providers.openai).toBeDefined();
      expect(res.body.providers.openai.healthState).toBe('healthy');
      expect(res.body.providers.openai.circuitState).toBe('CLOSED');
      expect(res.body.metrics).toBeDefined();
      expect(res.body.metrics.totalRequests).toBeGreaterThanOrEqual(1);
    });
  });

  describe('2. Multi-Provider Router Engine with Token Management & Failover', () => {
    it('executes multi-persona requests, tracking metrics in TokenManager', async () => {
      const baseUrl = `http://127.0.0.1:${mockPort}`;
      const providers: ProviderConfig[] = [
        {
          id: 'omniroute-primary',
          providerType: 'omniroute_gateway',
          displayName: 'OmniRoute Gateway',
          baseUrl,
          apiKey: 'valid-access-token-123',
          billingTier: 'subscription_flat',
          defaultModel: 'gpt-4o',
          supportedModels: ['gpt-4o'],
          priority: 1,
          enabled: true,
        },
      ];

      const adapter = new OmniRouteAdapter({ providers });
      const tokenMgr = new TokenManager();

      const personas = ['security', 'architecture', 'performance', 'quality'] as const;

      for (const persona of personas) {
        const effortConfig = tokenMgr.getEffortConfig('medium', persona);
        const startTime = Date.now();

        const llmRes = await adapter.complete({
          prompt: `Perform ${persona} code review on PR #101`,
          persona,
          effortLevel: effortConfig.effortLevel,
          provider: 'omniroute-primary',
        });

        const duration = Date.now() - startTime;
        expect(llmRes.content).toBeDefined();

        tokenMgr.recordUsage({
          requestId: `req-${persona}`,
          persona,
          effortLevel: effortConfig.effortLevel,
          provider: llmRes.providerUsed,
          model: llmRes.modelUsed,
          promptTokens: llmRes.tokensUsed.prompt,
          completionTokens: llmRes.tokensUsed.completion,
          totalTokens: llmRes.tokensUsed.total,
          durationMs: duration,
          timestamp: new Date().toISOString(),
        });
      }

      const globalMetrics = tokenMgr.getGlobalMetrics();
      expect(globalMetrics.totalRequests).toBe(4);
      expect(globalMetrics.byPersona.security.totalRequests).toBe(1);
      expect(globalMetrics.byPersona.architecture.totalRequests).toBe(1);
      expect(globalMetrics.byPersona.performance.totalRequests).toBe(1);
      expect(globalMetrics.byPersona.quality.totalRequests).toBe(1);
    });

    it('performs live failover when primary provider returns 503 error', async () => {
      const baseUrl = `http://127.0.0.1:${mockPort}`;

      mockServer.configure({
        failProvider: {
          provider: 'openai',
          status: 503,
          message: 'Primary OpenAI Service Unavailable',
          failCount: 3,
        },
      });

      const pool = new ProviderPool('priority_fallback');
      pool.registerProvider({ id: 'openai', name: 'OpenAI GPT-4o', priority: 1 });
      pool.registerProvider({ id: 'anthropic', name: 'Anthropic Claude', priority: 2 });

      const adapter = new OmniRouteAdapter({
        providers: [
          {
            id: 'openai',
            providerType: 'omniroute_gateway',
            displayName: 'OpenAI Proxy',
            baseUrl,
            apiKey: 'valid-access-token-123',
            billingTier: 'subscription_flat',
            defaultModel: 'gpt-4o',
            supportedModels: ['gpt-4o'],
            priority: 1,
            enabled: true,
          },
          {
            id: 'anthropic',
            providerType: 'omniroute_gateway',
            displayName: 'Anthropic Proxy',
            baseUrl,
            apiKey: 'valid-access-token-123',
            billingTier: 'subscription_flat',
            defaultModel: 'claude-3-5-sonnet',
            supportedModels: ['claude-3-5-sonnet'],
            priority: 2,
            enabled: true,
          },
        ],
      });

      const { result, providerUsed } = await pool.executeWithFailover(async (node) => {
        return await adapter.complete({
          prompt: 'Review diff',
          persona: 'security',
          effortLevel: 'medium',
          provider: node.id,
        });
      });

      expect(providerUsed).toBe('anthropic');
      expect(result.content).toBeDefined();

      const snapshot = pool.getStatusSnapshot();
      expect(snapshot.providers['openai'].metrics.failedRequests).toBe(1);
      expect(snapshot.providers['anthropic'].metrics.successfulRequests).toBe(1);
    });

    it('handles rate limit (429) circuit breaker trip and recovery flow', async () => {
      const pool = new ProviderPool('priority_fallback');
      pool.registerProvider({ id: 'primary-node', name: 'Primary Node', priority: 1 });
      pool.registerProvider({ id: 'secondary-node', name: 'Secondary Node', priority: 2 });

      const primary = pool.getProvider('primary-node')!;

      primary.recordStart();
      primary.recordFailure(429, 'Too Many Requests', '1');

      expect(primary.circuitState).toBe('OPEN');
      expect(primary.isAvailable()).toBe(false);

      const selected = pool.selectProvider();
      expect(selected.id).toBe('secondary-node');

      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(primary.isAvailable()).toBe(true);
      expect(primary.circuitState).toBe('HALF_OPEN');

      primary.recordStart();
      primary.recordSuccess(120);

      expect(primary.circuitState).toBe('CLOSED');
      expect(primary.healthState).toBe('healthy');
    });

    it('handles OAuth token expiration (401) and seamless token refresh', async () => {
      const baseUrl = `http://127.0.0.1:${mockPort}`;
      const tokenMgr = new TokenManager();

      tokenMgr.registerRefreshConfig({
        providerId: 'omniroute',
        tokenUrl: `${baseUrl}/v1/oauth/token`,
        refreshToken: 'valid-refresh-token',
        preemptiveRefreshWindowMs: 5000,
      });

      tokenMgr.setOAuthTokenData('omniroute', {
        accessToken: 'expired-access-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Date.now() - 1000,
      });

      const refreshedToken = await tokenMgr.getValidAccessToken('omniroute');
      expect(refreshedToken).toBe('new-access-token-456');

      const adapter = new OmniRouteAdapter({
        providers: [
          {
            id: 'omniroute',
            providerType: 'omniroute_gateway',
            displayName: 'OmniRoute Gateway',
            baseUrl,
            apiKey: refreshedToken,
            billingTier: 'subscription_flat',
            defaultModel: 'gpt-4o',
            supportedModels: ['gpt-4o'],
            priority: 1,
            enabled: true,
          },
        ],
      });

      const res = await adapter.complete({
        prompt: 'test prompt',
        persona: 'quality',
        effortLevel: 'low',
      });

      expect(res.content).toBeDefined();
    });

    it('enforces pre-execution quota checks during router pool failover execution', async () => {
      const baseUrl = `http://127.0.0.1:${mockPort}`;
      const pool = new ProviderPool('priority_fallback');
      pool.registerProvider({ id: 'primary-quota-exceeded', name: 'Primary', priority: 1 });
      pool.registerProvider({ id: 'fallback-valid', name: 'Fallback', priority: 2 });

      const adapter = new OmniRouteAdapter({
        providers: [
          {
            id: 'primary-quota-exceeded',
            providerType: 'omniroute_gateway',
            displayName: 'Exhausted Provider',
            baseUrl,
            billingTier: 'extra_usage_tier',
            extraUsageTier: {
              enabled: true,
              monthlyLimitUSD: 10.0,
              currentSpendUSD: 10.0, // Quota already reached
              costPer1kPromptTokens: 0.01,
              costPer1kCompletionTokens: 0.02,
            },
            defaultModel: 'gpt-4o',
            supportedModels: ['gpt-4o'],
            priority: 1,
            enabled: true,
          },
          {
            id: 'fallback-valid',
            providerType: 'omniroute_gateway',
            displayName: 'Healthy Fallback Provider',
            baseUrl,
            apiKey: 'valid-access-token-123',
            billingTier: 'subscription_flat',
            defaultModel: 'gpt-4o',
            supportedModels: ['gpt-4o'],
            priority: 2,
            enabled: true,
          },
        ],
      });

      const { result, providerUsed } = await pool.executeWithFailover(async (node) => {
        return await adapter.complete({
          prompt: 'Test prompt for pre-execution quota failover',
          persona: 'security',
          effortLevel: 'low',
          provider: node.id,
        });
      });

      expect(providerUsed).toBe('fallback-valid');
      expect(result.content).toBeDefined();
    });
  });
});
