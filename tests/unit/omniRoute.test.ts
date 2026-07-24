import { describe, it, expect, vi } from 'vitest';
import {
  OmniRouteAdapter,
  synthesizeSystemPrompt,
  calculateTokenCost,
  QuotaExhaustedError,
  ProviderConfig,
  LLMRequest,
} from '../../src/router/omniRouteAdapter';

describe('OmniRouteAdapter Unit Tests', () => {
  describe('synthesizeSystemPrompt & calculateTokenCost Helpers', () => {
    it('synthesizes default persona system prompts correctly', () => {
      const securityPrompt = synthesizeSystemPrompt('security');
      expect(securityPrompt).toContain('Senior Security Engineer');

      const archPrompt = synthesizeSystemPrompt('architecture');
      expect(archPrompt).toContain('Principal Software Architect');

      const perfPrompt = synthesizeSystemPrompt('performance');
      expect(perfPrompt).toContain('Performance Optimization Engineer');

      const qualityPrompt = synthesizeSystemPrompt('quality');
      expect(qualityPrompt).toContain('Senior Code Quality Lead');
    });

    it('prepends custom system prompt to persona prompt when provided', () => {
      const custom = 'Follow company guidelines.';
      const synthesized = synthesizeSystemPrompt('security', custom);
      expect(synthesized).toContain('Follow company guidelines.');
      expect(synthesized).toContain('Senior Security Engineer');
      expect(synthesized).toMatch(/^Follow company guidelines\.\n\nYou are a Senior Security Engineer/);
    });

    it('calculates token cost according to pricing formula', () => {
      const tokens = { prompt: 1000, completion: 2000, total: 3000 };
      const cost = calculateTokenCost(tokens, 0.0015, 0.002);
      // prompt: 1.0 * 0.0015 = 0.0015
      // completion: 2.0 * 0.002 = 0.004
      // total = 0.0055
      expect(cost).toBe(0.0055);
    });
  });

  describe('OmniRouteAdapter Multi-Provider Execution', () => {
    const mockProviders: ProviderConfig[] = [
      {
        id: 'openai-primary',
        providerType: 'openai',
        displayName: 'OpenAI GPT-4o',
        baseUrl: 'http://127.0.0.1:9999/openai',
        apiKey: 'sk-test-openai',
        billingTier: 'subscription_flat',
        defaultModel: 'gpt-4o',
        supportedModels: ['gpt-4o', 'gpt-4o-mini'],
        priority: 1,
        enabled: true,
      },
      {
        id: 'anthropic-secondary',
        providerType: 'anthropic',
        displayName: 'Anthropic Claude',
        baseUrl: 'http://127.0.0.1:9999/anthropic',
        apiKey: 'sk-ant-test',
        billingTier: 'usage_based',
        defaultModel: 'claude-3-5-sonnet-20241022',
        supportedModels: ['claude-3-5-sonnet-20241022'],
        priority: 2,
        enabled: true,
      },
      {
        id: 'gemini-fallback',
        providerType: 'gemini',
        displayName: 'Google Gemini',
        baseUrl: 'http://127.0.0.1:9999/gemini',
        apiKey: 'AIzaSyTestKey',
        billingTier: 'extra_usage_tier',
        extraUsageTier: {
          enabled: true,
          monthlyLimitUSD: 10,
          currentSpendUSD: 9.999,
          costPer1kPromptTokens: 0.01,
          costPer1kCompletionTokens: 0.02,
        },
        defaultModel: 'gemini-1.5-pro',
        supportedModels: ['gemini-1.5-pro'],
        priority: 3,
        enabled: true,
      },
      {
        id: 'deepseek-cheap',
        providerType: 'deepseek',
        displayName: 'DeepSeek Reasoner',
        baseUrl: 'http://127.0.0.1:9999/deepseek',
        apiKey: 'sk-ds-test',
        billingTier: 'subscription_flat',
        defaultModel: 'deepseek-reasoner',
        supportedModels: ['deepseek-reasoner'],
        priority: 4,
        enabled: true,
      },
      {
        id: 'omniroute-gateway',
        providerType: 'omniroute_gateway',
        displayName: 'OmniRoute Gateway Proxy',
        baseUrl: 'http://127.0.0.1:9999/gateway',
        apiKey: 'bearer-omni-test',
        billingTier: 'subscription_flat',
        defaultModel: 'omni-standard',
        supportedModels: ['omni-standard'],
        priority: 5,
        enabled: true,
      },
    ];

    it('executes OpenAI provider request with correct headers and payload format', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        expect(url).toContain('/v1/chat/completions');
        expect(init.headers['Authorization']).toBe('Bearer sk-test-openai');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('gpt-4o');
        expect(body.messages[0].content).toContain('Senior Security Engineer');

        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Security review complete: No issues found.' } }],
            usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
            model: 'gpt-4o',
          }),
        };
      });

      const adapter = new OmniRouteAdapter({
        providers: mockProviders,
        httpFetch: mockFetch as any,
      });

      const req: LLMRequest = {
        prompt: 'function foo() { return 42; }',
        persona: 'security',
        effortLevel: 'medium',
        provider: 'openai',
      };

      const res = await adapter.complete(req);
      expect(res.content).toBe('Security review complete: No issues found.');
      expect(res.providerUsed).toBe('openai');
      expect(res.tokensUsed).toEqual({ prompt: 150, completion: 50, total: 200 });
    });

    it('executes Anthropic provider request with x-api-key header', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        expect(url).toContain('/v1/messages');
        expect(init.headers['x-api-key']).toBe('sk-ant-test');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('claude-3-5-sonnet-20241022');
        expect(body.system).toContain('Principal Software Architect');

        return {
          ok: true,
          json: async () => ({
            content: [{ text: 'Architecture review pass' }],
            usage: { input_tokens: 200, output_tokens: 100 },
            model: 'claude-3-5-sonnet-20241022',
          }),
        };
      });

      const adapter = new OmniRouteAdapter({
        providers: mockProviders,
        httpFetch: mockFetch as any,
      });

      const res = await adapter.complete({
        prompt: 'class Architecture {}',
        persona: 'architecture',
        effortLevel: 'high',
        provider: 'anthropic',
      });

      expect(res.content).toBe('Architecture review pass');
      expect(res.providerUsed).toBe('anthropic');
      expect(res.tokensUsed).toEqual({ prompt: 200, completion: 100, total: 300 });
    });

    it('executes Gemini provider request with x-goog-api-key header', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        expect(url).toContain('/v1beta/models/gemini-1.5-pro:generateContent');
        expect(init.headers['x-goog-api-key']).toBe('AIzaSyTestKey');

        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'Gemini performance result' }] } }],
            usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 500 },
          }),
        };
      });

      // Override spend limit to allow execution
      const providers = JSON.parse(JSON.stringify(mockProviders));
      providers[2].extraUsageTier.currentSpendUSD = 0;

      const adapter = new OmniRouteAdapter({
        providers,
        httpFetch: mockFetch as any,
      });

      const res = await adapter.complete({
        prompt: 'performance check',
        persona: 'performance',
        effortLevel: 'low',
        provider: 'gemini',
      });

      expect(res.content).toBe('Gemini performance result');
      expect(res.providerUsed).toBe('gemini');
      expect(res.tokensUsed.total).toBe(1000);
      expect(res.costEstimateUSD).toBeDefined();
    });

    it('recordPostExecutionSpend updates currentSpendUSD beyond monthlyLimitUSD without throwing QuotaExhaustedError', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Gemini performance result' }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000 },
        }),
      }));

      const providers = JSON.parse(JSON.stringify(mockProviders));
      const adapter = new OmniRouteAdapter({
        providers, // Gemini has currentSpendUSD 9.999 out of 10.00
        httpFetch: mockFetch as any,
      });

      const res = await adapter.complete({
        prompt: 'heavy prompt',
        persona: 'performance',
        effortLevel: 'high',
        provider: 'gemini',
      });

      expect(res.content).toBe('Gemini performance result');
      expect(providers[2].extraUsageTier?.currentSpendUSD).toBe(10.029);

      // Subsequent pre-execution check throws QuotaExhaustedError
      await expect(
        adapter.complete({
          prompt: 'next prompt',
          persona: 'performance',
          effortLevel: 'high',
          provider: 'gemini',
        })
      ).rejects.toThrow(QuotaExhaustedError);
    });

    it('executes DeepSeek provider request and extracts reasoningTrace', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        expect(url).toContain('/v1/chat/completions');
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: 'DeepSeek audit complete.',
                  reasoning_content: 'Analyzed AST tree step by step for memory leaks.',
                },
              },
            ],
            usage: { prompt_tokens: 300, completion_tokens: 300, total_tokens: 600 },
            model: 'deepseek-reasoner',
          }),
        };
      });

      const adapter = new OmniRouteAdapter({
        providers: mockProviders,
        httpFetch: mockFetch as any,
      });

      const res = await adapter.complete({
        prompt: 'audit memory allocations',
        persona: 'performance',
        effortLevel: 'reasoning',
        provider: 'deepseek',
      });

      expect(res.content).toBe('DeepSeek audit complete.');
      expect(res.reasoningTrace).toBe('Analyzed AST tree step by step for memory leaks.');
      expect(res.providerUsed).toBe('deepseek');
    });

    it('executes OmniRoute Gateway request as default fallback when provider is omitted', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        expect(url).toContain('/v1/chat/completions');
        const body = JSON.parse(init.body);
        expect(body.persona).toBe('quality');
        return {
          ok: true,
          json: async () => ({
            content: 'Gateway output text',
            providerUsed: 'omniroute_gateway',
            modelUsed: 'omni-standard',
            tokensUsed: { prompt: 100, completion: 100, total: 200 },
          }),
        };
      });

      const adapter = new OmniRouteAdapter({
        providers: mockProviders,
        defaultProviderId: 'omniroute-gateway',
        httpFetch: mockFetch as any,
      });

      const res = await adapter.complete({
        prompt: 'quality review',
        persona: 'quality',
        effortLevel: 'low',
      });

      expect(res.content).toBe('Gateway output text');
      expect(res.providerUsed).toBe('omniroute_gateway');
    });

    it('checkPreExecutionQuota throws QuotaExhaustedError BEFORE dispatching fetch if limit is reached', async () => {
      const mockFetch = vi.fn();
      const providers = JSON.parse(JSON.stringify(mockProviders));
      providers[2].extraUsageTier.currentSpendUSD = 10.0;
      providers[2].extraUsageTier.monthlyLimitUSD = 10.0;

      const adapter = new OmniRouteAdapter({
        providers,
        httpFetch: mockFetch as any,
      });

      await expect(
        adapter.complete({
          prompt: 'pre-check test',
          persona: 'performance',
          effortLevel: 'low',
          provider: 'gemini',
        })
      ).rejects.toThrow(QuotaExhaustedError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('recordPostExecutionSpend accumulates spend across multiple execution calls', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'response text' }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000 },
        }),
      }));

      const providers = JSON.parse(JSON.stringify(mockProviders));
      providers[2].extraUsageTier.currentSpendUSD = 1.0;
      providers[2].extraUsageTier.monthlyLimitUSD = 20.0;
      providers[2].extraUsageTier.costPer1kPromptTokens = 0.01;
      providers[2].extraUsageTier.costPer1kCompletionTokens = 0.02;

      const adapter = new OmniRouteAdapter({
        providers,
        httpFetch: mockFetch as any,
      });

      await adapter.complete({
        prompt: 'request 1',
        persona: 'performance',
        effortLevel: 'low',
        provider: 'gemini',
      });

      // 1.0 + (1.0 * 0.01 + 1.0 * 0.02) = 1.03
      expect(providers[2].extraUsageTier.currentSpendUSD).toBe(1.03);

      await adapter.complete({
        prompt: 'request 2',
        persona: 'performance',
        effortLevel: 'low',
        provider: 'gemini',
      });

      // 1.03 + 0.03 = 1.06
      expect(providers[2].extraUsageTier.currentSpendUSD).toBe(1.06);
    });
  });
});
