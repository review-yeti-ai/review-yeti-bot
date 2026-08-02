import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OpenRouterModelService,
  parsePriceToPer1M,
  parseModalities,
  FALLBACK_OPENROUTER_MODELS,
  openRouterModelService,
} from '../openRouterModelService';

describe('OpenRouterModelService Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    openRouterModelService.clearCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. Price Parsing (parsePriceToPer1M)', () => {
    it('converts float string USD per token to USD per 1M tokens', () => {
      expect(parsePriceToPer1M('0.0000025')).toBe(2.5);
      expect(parsePriceToPer1M('0.000015')).toBe(15);
      expect(parsePriceToPer1M('0')).toBe(0);
    });

    it('handles numeric input', () => {
      expect(parsePriceToPer1M(0.00000125)).toBe(1.25);
    });

    it('returns 0 for undefined, null, non-numeric, or negative inputs', () => {
      expect(parsePriceToPer1M(undefined)).toBe(0);
      expect(parsePriceToPer1M(null as any)).toBe(0);
      expect(parsePriceToPer1M('invalid')).toBe(0);
      expect(parsePriceToPer1M('-0.0001')).toBe(0);
    });
  });

  describe('2. Modality Parsing (parseModalities)', () => {
    it('parses input modality from architecture string', () => {
      expect(parseModalities('text+image->text')).toEqual(['text', 'image']);
      expect(parseModalities('text+image+audio+video->text')).toEqual(['text', 'image', 'audio', 'video']);
      expect(parseModalities('text->text')).toEqual(['text']);
    });

    it('defaults to ["text"] when missing or invalid', () => {
      expect(parseModalities(undefined)).toEqual(['text']);
      expect(parseModalities('')).toEqual(['text']);
      expect(parseModalities(123 as any)).toEqual(['text']);
    });
  });

  describe('3. Live Model Fetching & Parsing', () => {
    it('fetches and parses live models successfully', async () => {
      const mockResponse = {
        data: [
          {
            id: 'openrouter/anthropic/claude-3.7-sonnet',
            name: 'Claude 3.7 Sonnet',
            description: 'Hybrid reasoning model',
            context_length: 200000,
            architecture: { modality: 'text+image->text' },
            pricing: { prompt: '0.000003', completion: '0.000015' },
            top_provider: { max_completion_tokens: 8192 },
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const service = new OpenRouterModelService({ apiKey: 'test-key' });
      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('openrouter/anthropic/claude-3.7-sonnet');
      expect(models[0].promptCostPer1M).toBe(3);
      expect(models[0].completionCostPer1M).toBe(15);
      expect(models[0].modalities).toEqual(['text', 'image']);
      expect(models[0].isFallback).toBe(false);

      const status = service.getCacheStatus();
      expect(status.cachedCount).toBe(1);
      expect(status.isUsingFallback).toBe(false);
    });
  });

  describe('4. Offline Fallback Dataset', () => {
    it('falls back to hardcoded models when live fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const service = new OpenRouterModelService();
      const models = await service.getModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'openrouter/auto')).toBe(true);
      expect(models.some((m) => m.id === 'openrouter/anthropic/claude-3.7-sonnet')).toBe(true);

      const status = service.getCacheStatus();
      expect(status.isUsingFallback).toBe(true);
      expect(status.cachedCount).toBe(models.length);
    });

    it('falls back to hardcoded models when HTTP status is not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const service = new OpenRouterModelService();
      const models = await service.getModels();

      expect(models.length).toBe(FALLBACK_OPENROUTER_MODELS.length);
      const status = service.getCacheStatus();
      expect(status.isUsingFallback).toBe(true);
    });
  });

  describe('5. Cache Management & TTL', () => {
    it('returns cached models on subsequent calls within TTL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '0.000001', completion: '0.000003' } }],
        }),
      } as Response);
      globalThis.fetch = mockFetch;

      const service = new OpenRouterModelService({ cacheTTLMs: 60_000 });
      await service.getModels();
      await service.getModels();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('re-fetches models when forceRefresh option is specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '0.000001', completion: '0.000003' } }],
        }),
      } as Response);
      globalThis.fetch = mockFetch;

      const service = new OpenRouterModelService();
      await service.getModels();
      await service.getModels({ forceRefresh: true });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clears cache and status correctly via clearCache()', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));

      const service = new OpenRouterModelService();
      await service.getModels();
      expect(service.getCacheStatus().cachedCount).toBeGreaterThan(0);

      service.clearCache();
      const status = service.getCacheStatus();
      expect(status.cachedCount).toBe(0);
      expect(status.lastFetchTime).toBeNull();
      expect(status.isUsingFallback).toBe(false);
    });
  });

  describe('6. Cost Calculation & Modality Checks', () => {
    it('calculates cost accurately based on token counts and per-1M pricing', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));

      const service = new OpenRouterModelService();

      // openrouter/auto has $1.00 prompt / $3.00 completion per 1M
      const cost = await service.calculateCost('openrouter/auto', 1_000_000, 1_000_000);
      expect(cost).toBe(4.00);

      // Half million prompt + quarter million completion
      const partialCost = await service.calculateCost('openrouter/auto', 500_000, 250_000);
      expect(partialCost).toBe(1.25); // 0.5 * 1.00 + 0.25 * 3.00 = 0.5 + 0.75 = 1.25
    });

    it('uses baseline fallback rate for unknown models', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));

      const service = new OpenRouterModelService();
      const cost = await service.calculateCost('unknown-custom-model', 1_000_000, 1_000_000);
      expect(cost).toBe(4.00);
    });

    it('checks modality support correctly', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));

      const service = new OpenRouterModelService();

      // Gemini 2.5 Pro supports image, audio, video
      expect(await service.isModalitySupported('openrouter/google/gemini-2.5-pro', 'image')).toBe(true);
      expect(await service.isModalitySupported('openrouter/google/gemini-2.5-pro', 'video')).toBe(true);

      // DeepSeek R1 is text-only
      expect(await service.isModalitySupported('openrouter/deepseek/deepseek-r1', 'image')).toBe(false);
      expect(await service.isModalitySupported('openrouter/deepseek/deepseek-r1', 'text')).toBe(true);
    });

    it('getModel matches models with or without vendor prefix', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline'));

      const service = new OpenRouterModelService();
      const modelByFullId = await service.getModel('openrouter/anthropic/claude-3.7-sonnet');
      expect(modelByFullId).not.toBeNull();

      const modelByShortId = await service.getModel('claude-3.7-sonnet');
      expect(modelByShortId).not.toBeNull();
      expect(modelByShortId?.id).toBe('openrouter/anthropic/claude-3.7-sonnet');
    });
  });

  describe('7. Singleton Export', () => {
    it('exports singleton openRouterModelService instance', () => {
      expect(openRouterModelService).toBeInstanceOf(OpenRouterModelService);
    });
  });
});
