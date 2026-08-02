import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OpenRouterModelService,
  FALLBACK_OPENROUTER_MODELS,
  openRouterModelService,
} from '../../src/services/openRouterModelService';

describe('Milestone 1 Empirical Challenger 2: Alias Matching & Cache TTL in OpenRouterModelService', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    openRouterModelService.clearCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. Model Alias Matching (getModel)', () => {
    it('matches short name vs full path vs vendor prefix in fallback dataset', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error - testing fallback'));
      const service = new OpenRouterModelService();

      // Test short name 'auto' vs full path 'openrouter/auto'
      const autoByShort = await service.getModel('auto');
      expect(autoByShort).not.toBeNull();
      expect(autoByShort?.id).toBe('openrouter/auto');

      // Test short name 'gemini-2.5-pro' vs full path 'openrouter/google/gemini-2.5-pro'
      const geminiByShort = await service.getModel('gemini-2.5-pro');
      expect(geminiByShort).not.toBeNull();
      expect(geminiByShort?.id).toBe('openrouter/google/gemini-2.5-pro');

      // Test vendor prefix 'google/gemini-2.5-pro'
      const geminiByVendor = await service.getModel('google/gemini-2.5-pro');
      expect(geminiByVendor).not.toBeNull();
      expect(geminiByVendor?.id).toBe('openrouter/google/gemini-2.5-pro');

      // Test short name 'claude-3.7-sonnet' vs full path 'openrouter/anthropic/claude-3.7-sonnet'
      const claudeByShort = await service.getModel('claude-3.7-sonnet');
      expect(claudeByShort).not.toBeNull();
      expect(claudeByShort?.id).toBe('openrouter/anthropic/claude-3.7-sonnet');
    });

    it('handles exact cache matches before alias loop searching', async () => {
      const mockLiveModels = {
        data: [
          { id: 'gpt-4o', name: 'OpenAI GPT-4o Short' },
          { id: 'openrouter/openai/gpt-4o', name: 'OpenAI GPT-4o Full' },
        ],
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockLiveModels,
      } as Response);

      const service = new OpenRouterModelService();

      const exactShort = await service.getModel('gpt-4o');
      expect(exactShort?.name).toBe('OpenAI GPT-4o Short');

      const exactFull = await service.getModel('openrouter/openai/gpt-4o');
      expect(exactFull?.name).toBe('OpenAI GPT-4o Full');
    });

    it('demonstrates ambiguity resolution when modelId is not exact key but matches multiple models', async () => {
      // Setup live models where both short id 'gpt-4o' and full path 'openrouter/openai/gpt-4o' exist in order
      const mockLiveModels = {
        data: [
          { id: 'gpt-4o', name: 'Short Model' },
          { id: 'openrouter/openai/gpt-4o', name: 'Full Path Model' },
        ],
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockLiveModels,
      } as Response);

      const service = new OpenRouterModelService();

      // Querying 'openai/gpt-4o' is not an exact key in cacheMap
      // It will loop through models:
      // index 0: id='gpt-4o'. Does 'openai/gpt-4o'.endsWith('/gpt-4o')? YES!
      // So getModel('openai/gpt-4o') returns index 0 ('Short Model') instead of index 1 ('Full Path Model')
      const result = await service.getModel('openai/gpt-4o');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('gpt-4o');
    });

    it('returns null for partial name substring matches or non-existent models', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));
      const service = new OpenRouterModelService();

      // 'pro' should NOT match 'openrouter/google/gemini-2.5-pro' because endsWith('/pro') is false
      expect(await service.getModel('pro')).toBeNull();

      // 'sonnet' should NOT match 'openrouter/anthropic/claude-3.7-sonnet' because endsWith('/sonnet') is false
      expect(await service.getModel('sonnet')).toBeNull();

      // Non-existent model string
      expect(await service.getModel('non-existent-provider/fake-model-1234')).toBeNull();
    });

    it('demonstrates case-sensitivity of getModel matching', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));
      const service = new OpenRouterModelService();

      // Capitalized model ID will fail cache.has and loop matching
      expect(await service.getModel('GPT-4O')).toBeNull();
      expect(await service.getModel('Openrouter/Auto')).toBeNull();
    });

    it('handles leading and trailing slashes', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));
      const service = new OpenRouterModelService();

      // Leading slash: '/gpt-4o' -> modelId.endsWith('/' + spec.id) -> '/gpt-4o'.endsWith('/gpt-4o') -> true!
      const leadingSlashResult = await service.getModel('/gpt-4o');
      expect(leadingSlashResult).not.toBeNull();
      expect(leadingSlashResult?.id).toBe('gpt-4o');

      // Trailing slash: 'gpt-4o/' -> returns null
      const trailingSlashResult = await service.getModel('gpt-4o/');
      expect(trailingSlashResult).toBeNull();
    });
  });

  describe('2. Cache Invalidation, TTL & Offline Fallback Dynamics', () => {
    it('serves cached models while within TTL without calling fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'openrouter/auto', name: 'Auto Router' }],
        }),
      } as Response);
      globalThis.fetch = mockFetch;

      const service = new OpenRouterModelService({ cacheTTLMs: 5000 });

      // First fetch
      await service.getModels();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second fetch within TTL
      await service.getModels();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('invalidates cache and re-fetches after TTL expires', async () => {
      let fetchCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return {
          ok: true,
          json: async () => ({
            data: [{ id: `model-v${fetchCount}`, name: `Version ${fetchCount}` }],
          }),
        } as Response;
      });

      const service = new OpenRouterModelService({ cacheTTLMs: 100 });

      const firstModels = await service.getModels();
      expect(firstModels[0].id).toBe('model-v1');

      // Wait 150ms for TTL to expire
      await new Promise((res) => setTimeout(res, 150));

      const secondModels = await service.getModels();
      expect(secondModels[0].id).toBe('model-v2');
      expect(fetchCount).toBe(2);
    });

    it('handles TTL expiration when live fetch fails by retaining stale cache without updating lastFetchTime', async () => {
      let attempt = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          return {
            ok: true,
            json: async () => ({
              data: [{ id: 'live-model-1', name: 'Live Model Initial' }],
            }),
          } as Response;
        }
        throw new Error('503 Service Unavailable');
      });

      const service = new OpenRouterModelService({ cacheTTLMs: 50 });

      // Initial fetch succeeds
      const initial = await service.getModels();
      expect(initial[0].id).toBe('live-model-1');
      const initialFetchTime = service.getCacheStatus().lastFetchTime;

      // Wait for TTL to expire
      await new Promise((res) => setTimeout(res, 80));

      // Re-fetch fails. Service should return stale cache.
      const staleResult = await service.getModels();
      expect(staleResult[0].id).toBe('live-model-1');
      expect(service.getCacheStatus().isUsingFallback).toBe(false);

      // Verify lastFetchTime was NOT updated on failure
      expect(service.getCacheStatus().lastFetchTime).toBe(initialFetchTime);

      // Calling again immediately will attempt fetch again because TTL is still expired
      await service.getModels();
      expect(attempt).toBe(3);
    });

    it('overwrites live cache with fallbacks when forceRefresh fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'custom-live-model', name: 'Custom Live' }],
        }),
      } as Response);

      const service = new OpenRouterModelService();
      const initial = await service.getModels();
      expect(initial).toHaveLength(1);
      expect(initial[0].id).toBe('custom-live-model');

      // Next fetch fails
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network drop'));

      // forceRefresh = true on failed fetch forces fallback population
      const refreshed = await service.getModels({ forceRefresh: true });
      expect(refreshed.length).toBe(FALLBACK_OPENROUTER_MODELS.length);
      expect(service.getCacheStatus().isUsingFallback).toBe(true);
    });

    it('clearCache resets cacheMap, lastFetchTime, and isUsingFallback completely', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));
      const service = new OpenRouterModelService();

      await service.getModels();
      expect(service.getCacheStatus().cachedCount).toBeGreaterThan(0);
      expect(service.getCacheStatus().isUsingFallback).toBe(true);

      service.clearCache();
      const status = service.getCacheStatus();
      expect(status.cachedCount).toBe(0);
      expect(status.lastFetchTime).toBeNull();
      expect(status.isUsingFallback).toBe(false);
    });
  });

  describe('3. Integration with calculateCost and isModalitySupported', () => {
    it('uses alias matching seamlessly in calculateCost', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));
      const service = new OpenRouterModelService();

      // 'auto' matches 'openrouter/auto' ($1.00 / $3.00 per 1M)
      const costShort = await service.calculateCost('auto', 1_000_000, 1_000_000);
      const costFull = await service.calculateCost('openrouter/auto', 1_000_000, 1_000_000);
      expect(costShort).toBe(4.00);
      expect(costFull).toBe(4.00);
    });

    it('uses alias matching seamlessly in isModalitySupported', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));
      const service = new OpenRouterModelService();

      // 'gemini-2.5-pro' matches 'openrouter/google/gemini-2.5-pro' (supports image, audio, video)
      expect(await service.isModalitySupported('gemini-2.5-pro', 'video')).toBe(true);
      expect(await service.isModalitySupported('openrouter/google/gemini-2.5-pro', 'video')).toBe(true);
    });
  });
});
