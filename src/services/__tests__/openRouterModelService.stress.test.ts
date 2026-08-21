import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OpenRouterModelService,
  parsePriceToPer1M,
  parseModalities,
  FALLBACK_OPENROUTER_MODELS,
} from '../openRouterModelService';

describe('Empirical Stress Testing: OpenRouterModelService (Challenger 1)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Default fetch to reject so unit tests use offline fallbacks deterministically unless explicitly mocked
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Offline network mock'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. Price Parsing & Zero/Missing Pricing Stress Scenarios', () => {
    it('handles undefined, null, empty object, and missing pricing fields gracefully', () => {
      expect(parsePriceToPer1M(undefined)).toBe(0);
      expect(parsePriceToPer1M(null as any)).toBe(0);
      expect(parsePriceToPer1M('')).toBe(0);
      expect(parsePriceToPer1M('   ')).toBe(0);
    });

    it('handles zero pricing correctly (free models)', () => {
      expect(parsePriceToPer1M(0)).toBe(0);
      expect(parsePriceToPer1M('0')).toBe(0);
      expect(parsePriceToPer1M('0.000000')).toBe(0);
    });

    it('handles negative pricing strings and numbers by returning 0', () => {
      expect(parsePriceToPer1M(-0.000005)).toBe(0);
      expect(parsePriceToPer1M('-0.000005')).toBe(0);
      expect(parsePriceToPer1M('-100')).toBe(0);
    });

    it('handles non-numeric strings and corrupted inputs by returning 0', () => {
      expect(parsePriceToPer1M('free')).toBe(0);
      expect(parsePriceToPer1M('N/A')).toBe(0);
      expect(parsePriceToPer1M('{}')).toBe(0);
      expect(parsePriceToPer1M('NaN')).toBe(0);
    });

    it('handles extremely small fractional pricing per token accurately without float underflow', () => {
      // 0.00000015 USD per token = $0.15 per 1M tokens
      expect(parsePriceToPer1M('0.00000015')).toBe(0.15);
      // 0.00000001 USD per token = $0.01 per 1M tokens
      expect(parsePriceToPer1M('0.00000001')).toBe(0.01);
    });

    it('handles high-value pricing numbers without crashing', () => {
      expect(parsePriceToPer1M(0.001)).toBe(1000);
      expect(parsePriceToPer1M('0.01')).toBe(10000);
    });
  });

  describe('2. Network Failure & Malformed Response Simulations in getModels()', () => {
    it('falls back to hardcoded dataset on HTTP 500, 503, 429, 404 errors', async () => {
      for (const status of [500, 503, 429, 404]) {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status,
          statusText: `HTTP ${status} Failure`,
        } as Response);

        const service = new OpenRouterModelService({ apiKey: 'test-key' });
        const models = await service.getModels();

        expect(models.length).toBe(FALLBACK_OPENROUTER_MODELS.length);
        expect(service.getCacheStatus().isUsingFallback).toBe(true);
      }
    });

    it('falls back to hardcoded dataset on network fetch exceptions (DNS / connection reset / timeout)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const service = new OpenRouterModelService();
      const models = await service.getModels();

      expect(models.length).toBeGreaterThan(0);
      expect(service.getCacheStatus().isUsingFallback).toBe(true);
    });

    it('handles malformed JSON body responses (data property missing or not an array)', async () => {
      const invalidPayloads = [
        {},
        { data: 'not-an-array' },
        { data: null },
        { data: 12345 },
        null,
        { error: 'Internal Server Error' },
      ];

      for (const payload of invalidPayloads) {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => payload,
        } as Response);

        const service = new OpenRouterModelService();
        const models = await service.getModels();

        expect(models.length).toBe(FALLBACK_OPENROUTER_MODELS.length);
        expect(service.getCacheStatus().isUsingFallback).toBe(true);
      }
    });

    it('handles live fetch returning an empty array of models gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      const service = new OpenRouterModelService();
      const models = await service.getModels();

      expect(models).toEqual([]);
      expect(service.getCacheStatus().isUsingFallback).toBe(false);
      expect(service.getCacheStatus().cachedCount).toBe(0);
    });

    it('handles live models missing architecture, description, context_length or pricing fields', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'custom/barebones-model',
              // missing name, description, context_length, architecture, pricing
            },
          ],
        }),
      } as Response);

      const service = new OpenRouterModelService();
      const models = await service.getModels();

      expect(models).toHaveLength(1);
      const spec = models[0];
      expect(spec.id).toBe('custom/barebones-model');
      expect(spec.name).toBe('custom/barebones-model');
      expect(spec.contextLength).toBe(4096); // default fallback context length
      expect(spec.promptCostPer1M).toBe(0);
      expect(spec.completionCostPer1M).toBe(0);
      expect(spec.modalities).toEqual(['text']);
      expect(spec.isFallback).toBe(false);
    });
  });

  describe('3. Large Prompt Tokens & Extreme Inputs in calculateCost()', () => {
    it('calculates cost accurately for large prompt token counts (100M - 1B tokens)', async () => {
      const service = new OpenRouterModelService();

      // Claude 3.7 Sonnet: $3.00 prompt / $15.00 completion per 1M
      // 100 Million prompt tokens -> $300.00
      // 50 Million completion tokens -> $750.00
      // Total = $1050.00
      const cost100M = await service.calculateCost(
        'openrouter/anthropic/claude-3.7-sonnet',
        100_000_000,
        50_000_000
      );
      expect(cost100M).toBe(1050.00);

      // 1 Billion prompt tokens -> $3000.00
      // 500 Million completion tokens -> $7500.00
      // Total = $10500.00
      const cost1B = await service.calculateCost(
        'openrouter/anthropic/claude-3.7-sonnet',
        1_000_000_000,
        500_000_000
      );
      expect(cost1B).toBe(10500.00);
    });

    it('handles zero prompt and completion tokens correctly', async () => {
      const service = new OpenRouterModelService();
      const cost = await service.calculateCost('openrouter/auto', 0, 0);
      expect(cost).toBe(0);
    });

    it('evaluates empirical behavior with negative token counts (allows negative result)', async () => {
      const service = new OpenRouterModelService();
      // openrouter/auto ($1.00 / $3.00 per 1M)
      const cost = await service.calculateCost('openrouter/auto', -1_000_000, -1_000_000);
      // Empirical observation: negative token counts yield negative cost (-4.00) because calculateCost lacks negative clamping
      expect(cost).toBe(-4.00);
    });

    it('evaluates empirical behavior with NaN and Infinity token inputs', async () => {
      const service = new OpenRouterModelService();
      const nanCost = await service.calculateCost('openrouter/auto', NaN, 1000);
      expect(Number.isNaN(nanCost)).toBe(true);

      // openrouter/auto promptCostPer1M = 1.00 > 0, so Infinity * 1.00 = Infinity
      const infCost = await service.calculateCost('openrouter/auto', Infinity, 1000);
      expect(infCost).toBe(Infinity);
    });

    it('calculates cost for free / zero-pricing models as 0', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'free/open-model',
              name: 'Free Model',
              pricing: { prompt: 0, completion: 0 },
            },
          ],
        }),
      } as Response);

      const service = new OpenRouterModelService();
      const cost = await service.calculateCost('free/open-model', 500_000_000, 500_000_000);
      expect(cost).toBe(0);
    });
  });

  describe('4. Modality Parsing & Edge Cases', () => {
    it('parses complex modality string representations', () => {
      expect(parseModalities('text+image+audio+video->text')).toEqual(['text', 'image', 'audio', 'video']);
      expect(parseModalities('image+text->image')).toEqual(['text', 'image']);
      expect(parseModalities('audio->text')).toEqual(['audio']);
      expect(parseModalities('video->video')).toEqual(['video']);
    });

    it('defaults to ["text"] for unknown or malformed modality strings', () => {
      expect(parseModalities('code->text')).toEqual(['text']);
      expect(parseModalities('embedding')).toEqual(['text']);
      expect(parseModalities(null as any)).toEqual(['text']);
    });
  });

  describe('5. getModel Matching Stress & Edge Cases', () => {
    it('returns null for empty or non-existent model IDs', async () => {
      const service = new OpenRouterModelService();
      expect(await service.getModel('')).toBeNull();
      expect(await service.getModel('completely-unknown-model-xyz')).toBeNull();
    });

    it('handles matching with vendor prefixes and trailing suffixes', async () => {
      const service = new OpenRouterModelService();
      // Match full model ID
      const full = await service.getModel('openrouter/anthropic/claude-3.7-sonnet');
      expect(full).not.toBeNull();
      expect(full?.id).toBe('openrouter/anthropic/claude-3.7-sonnet');

      // Match partial ID
      const short = await service.getModel('claude-3.7-sonnet');
      expect(short).not.toBeNull();
      expect(short?.id).toBe('openrouter/anthropic/claude-3.7-sonnet');
    });
  });
});
