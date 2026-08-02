import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SWE_BENCH_DATASET,
  lookupSWEBenchScore,
  buildModelMatrix,
  getBestModelForBudget,
  getMostEfficientModel,
  formatModelMatrixTable,
  formatModelMatrixJSON,
  formatModelMatrixMarkdown,
  ModelMatrixResult,
} from '../modelMatrix';
import { openRouterModelService, OpenRouterModelSpec } from '../../services/openRouterModelService';

describe('src/analytics/modelMatrix.ts', () => {
  beforeEach(() => {
    // Mock openRouterModelService.getModels to return predictable fallback models for deterministic unit testing
    vi.spyOn(openRouterModelService, 'getModels').mockImplementation(async () =>
      openRouterModelService.getFallbackModels()
    );
  });

  describe('SWE_BENCH_DATASET & lookupSWEBenchScore', () => {
    it('contains all 11 curated benchmark models with accurate scores', () => {
      expect(SWE_BENCH_DATASET['claude-3.7-sonnet'].verifiedScorePercent).toBe(70.3);
      expect(SWE_BENCH_DATASET['gemini-2.5-pro'].verifiedScorePercent).toBe(63.8);
      expect(SWE_BENCH_DATASET['openrouter/auto'].verifiedScorePercent).toBe(52.0);
      expect(SWE_BENCH_DATASET['deepseek-r1'].verifiedScorePercent).toBe(49.2);
      expect(SWE_BENCH_DATASET['claude-3.5-sonnet'].verifiedScorePercent).toBe(49.0);
      expect(SWE_BENCH_DATASET['deepseek-v3'].verifiedScorePercent).toBe(48.4);
      expect(SWE_BENCH_DATASET['gpt-4o'].verifiedScorePercent).toBe(38.8);
      expect(SWE_BENCH_DATASET['qwen-2.5-72b'].verifiedScorePercent).toBe(38.0);
      expect(SWE_BENCH_DATASET['llama-3.3-70b'].verifiedScorePercent).toBe(35.8);
      expect(SWE_BENCH_DATASET['gemini-2.0-flash-lite'].verifiedScorePercent).toBe(28.5);
      expect(SWE_BENCH_DATASET['gpt-4o-mini'].verifiedScorePercent).toBe(26.2);
    });

    it('looks up scores via exact primary key', () => {
      const score = lookupSWEBenchScore('claude-3.7-sonnet');
      expect(score).not.toBeNull();
      expect(score?.canonicalName).toBe('Claude 3.7 Sonnet');
      expect(score?.verifiedScorePercent).toBe(70.3);
      expect(score?.liteScorePercent).toBe(64.9);
    });

    it('looks up scores via OpenRouter full model ID and vendor aliases', () => {
      const scoreFull = lookupSWEBenchScore('openrouter/anthropic/claude-3.7-sonnet');
      expect(scoreFull).not.toBeNull();
      expect(scoreFull?.canonicalName).toBe('Claude 3.7 Sonnet');

      const scoreShortAlias = lookupSWEBenchScore('anthropic/claude-3.7-sonnet');
      expect(scoreShortAlias).not.toBeNull();
      expect(scoreShortAlias?.canonicalName).toBe('Claude 3.7 Sonnet');

      const scoreAuto = lookupSWEBenchScore('auto');
      expect(scoreAuto).not.toBeNull();
      expect(scoreAuto?.canonicalName).toBe('OpenRouter Auto Router');
    });

    it('handles case-insensitivity, colons, and suffix resolution', () => {
      const scoreCase = lookupSWEBenchScore('OPENROUTER/ANTHROPIC/CLAUDE-3.7-SONNET:BETA');
      expect(scoreCase).not.toBeNull();
      expect(scoreCase?.canonicalName).toBe('Claude 3.7 Sonnet');
    });

    it('returns null for unknown model IDs', () => {
      const score = lookupSWEBenchScore('unknown-provider/unknown-model-v99');
      expect(score).toBeNull();
    });
  });

  describe('buildModelMatrix & Cost Metric Formulas', () => {
    it('builds full model matrix using model specs', async () => {
      const result = await buildModelMatrix();
      expect(result).toBeDefined();
      expect(result.benchmarkType).toBe('verified');
      expect(result.totalModels).toBeGreaterThan(0);
      expect(result.entries.length).toBe(result.totalModels);

      const claude37 = result.entries.find((e) => e.id.includes('claude-3.7-sonnet'));
      expect(claude37).toBeDefined();
      if (claude37) {
        expect(claude37.promptCostPer1M).toBe(3.0);
        expect(claude37.completionCostPer1M).toBe(15.0);
        expect(claude37.blendedCostPer1M).toBe(6.0);
        expect(claude37.sweScoreVerified).toBe(70.3);
        expect(claude37.activeSweScore).toBe(70.3);
        expect(claude37.costEfficiency).toBe(11.7167);
        expect(claude37.provider).toBe('Anthropic');
      }
    });

    it('verifies cost metric formulas with custom mock service', async () => {
      const mockSpec: OpenRouterModelSpec = {
        id: 'openrouter/anthropic/claude-3.7-sonnet',
        name: 'Anthropic: Claude 3.7 Sonnet',
        contextLength: 200000,
        promptCostPer1M: 3.0,
        completionCostPer1M: 15.0,
        modalities: ['text', 'image'],
        isFallback: true,
        fetchedAt: Date.now(),
      };

      const mockService = { getModels: async () => [mockSpec] };
      const result = await buildModelMatrix(undefined, mockService);

      const claude37 = result.entries[0];
      expect(claude37.promptCostPer1M).toBe(3.0);
      expect(claude37.completionCostPer1M).toBe(15.0);
      expect(claude37.totalCostPer1M).toBe(18.0);
      expect(claude37.averageCostPer1M).toBe(9.0);
      // Blended cost formula: (3 * 3.0 + 15.0) / 4 = 24 / 4 = 6.0
      expect(claude37.blendedCostPer1M).toBe(6.0);
      expect(claude37.sweScoreVerified).toBe(70.3);
      expect(claude37.activeSweScore).toBe(70.3);
      // Efficiency: 70.3 / 6.0 = 11.7167
      expect(claude37.costEfficiency).toBe(11.7167);
      expect(claude37.provider).toBe('Anthropic');
    });

    it('handles benchmarkType switching to lite', async () => {
      const resultLite = await buildModelMatrix({ benchmarkType: 'lite' });
      expect(resultLite.benchmarkType).toBe('lite');

      const claude37 = resultLite.entries.find((e) => e.id.includes('claude-3.7-sonnet'));
      expect(claude37).toBeDefined();
      if (claude37) {
        expect(claude37.sweScoreLite).toBe(64.9);
        expect(claude37.activeSweScore).toBe(64.9);
        expect(claude37.costEfficiency).toBe(10.8167);
      }
    });

    it('handles zero blended cost cleanly without NaN or Infinity', async () => {
      const freeModelSpec: OpenRouterModelSpec = {
        id: 'free/open-model',
        name: 'Free Open Model',
        contextLength: 32000,
        promptCostPer1M: 0,
        completionCostPer1M: 0,
        modalities: ['text'],
        isFallback: false,
        fetchedAt: Date.now(),
      };

      const mockService = {
        getModels: async () => [freeModelSpec],
      };

      const result = await buildModelMatrix(undefined, mockService);
      expect(result.entries.length).toBe(1);
      const entry = result.entries[0];
      expect(entry.blendedCostPer1M).toBe(0);
      // Free model without benchmark data has activeSweScore = 0
      expect(Number.isFinite(entry.costEfficiency)).toBe(true);
      expect(entry.costEfficiency).toBe(0);
    });

    it('handles zero blended cost model with non-zero benchmark score', async () => {
      const freeBenchModelSpec: OpenRouterModelSpec = {
        id: 'claude-3.7-sonnet',
        name: 'Free Claude 3.7',
        contextLength: 200000,
        promptCostPer1M: 0,
        completionCostPer1M: 0,
        modalities: ['text'],
        isFallback: false,
        fetchedAt: Date.now(),
      };

      const mockService = {
        getModels: async () => [freeBenchModelSpec],
      };

      const result = await buildModelMatrix(undefined, mockService);
      const entry = result.entries[0];
      expect(entry.blendedCostPer1M).toBe(0);
      expect(entry.activeSweScore).toBe(70.3);
      // Zero cost with score 70.3 -> 70.3 * 1000 = 70300
      expect(entry.costEfficiency).toBe(70300);
    });
  });

  describe('Sorting Options', () => {
    it('sorts by swe-score descending by default', async () => {
      const result = await buildModelMatrix({ sortBy: 'swe-score' });
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].activeSweScore).toBeGreaterThanOrEqual(result.entries[i].activeSweScore);
      }
    });

    it('sorts by cost ascending by default', async () => {
      const result = await buildModelMatrix({ sortBy: 'cost' });
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].blendedCostPer1M).toBeLessThanOrEqual(result.entries[i].blendedCostPer1M);
      }
    });

    it('sorts by efficiency descending by default', async () => {
      const result = await buildModelMatrix({ sortBy: 'efficiency' });
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].costEfficiency).toBeGreaterThanOrEqual(result.entries[i].costEfficiency);
      }
    });

    it('sorts by context descending by default', async () => {
      const result = await buildModelMatrix({ sortBy: 'context' });
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].contextLength).toBeGreaterThanOrEqual(result.entries[i].contextLength);
      }
    });

    it('sorts by name ascending by default', async () => {
      const result = await buildModelMatrix({ sortBy: 'name' });
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].name.localeCompare(result.entries[i].name)).toBeLessThanOrEqual(0);
      }
    });

    it('respects explicit sortOrder override', async () => {
      const result = await buildModelMatrix({ sortBy: 'swe-score', sortOrder: 'asc' });
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].activeSweScore).toBeLessThanOrEqual(result.entries[i].activeSweScore);
      }
    });
  });

  describe('Filtering Options & Pagination Limit', () => {
    it('filters by minScore', async () => {
      const result = await buildModelMatrix({ minScore: 50.0 });
      expect(result.entries.every((e) => e.activeSweScore >= 50.0)).toBe(true);
    });

    it('filters by maxCostPer1M', async () => {
      const result = await buildModelMatrix({ maxCostPer1M: 1.0 });
      expect(result.entries.every((e) => e.blendedCostPer1M <= 1.0)).toBe(true);
    });

    it('filters by minContext', async () => {
      const result = await buildModelMatrix({ minContext: 150000 });
      expect(result.entries.every((e) => e.contextLength >= 150000)).toBe(true);
    });

    it('filters by modality', async () => {
      const result = await buildModelMatrix({ modality: 'image' });
      expect(result.entries.every((e) => e.modalities.includes('image'))).toBe(true);
    });

    it('filters by search query', async () => {
      const result = await buildModelMatrix({ query: 'deepseek' });
      expect(result.entries.length).toBeGreaterThan(0);
      expect(
        result.entries.every(
          (e) =>
            e.id.toLowerCase().includes('deepseek') ||
            e.name.toLowerCase().includes('deepseek') ||
            e.provider.toLowerCase().includes('deepseek') ||
            (e.description && e.description.toLowerCase().includes('deepseek'))
        )
      ).toBe(true);
    });

    it('applies limit while maintaining totalModels count', async () => {
      const fullResult = await buildModelMatrix();
      const limitedResult = await buildModelMatrix({ limit: 3 });

      expect(limitedResult.entries.length).toBe(3);
      expect(limitedResult.totalModels).toBe(fullResult.totalModels);
    });
  });

  describe('Convenience Methods: getBestModelForBudget & getMostEfficientModel', () => {
    it('getBestModelForBudget finds highest score model within budget', async () => {
      // With high max cost ($10), should select Claude 3.7 Sonnet (70.3%)
      const bestHighBudget = await getBestModelForBudget(10.0);
      expect(bestHighBudget).not.toBeNull();
      expect(bestHighBudget?.activeSweScore).toBe(70.3);

      // With low max cost ($0.50), should pick model with blendedCostPer1M <= 0.50
      const bestLowBudget = await getBestModelForBudget(0.5);
      expect(bestLowBudget).not.toBeNull();
      expect(bestLowBudget!.blendedCostPer1M).toBeLessThanOrEqual(0.5);
    });

    it('getMostEfficientModel finds model with highest cost efficiency score', async () => {
      const mostEfficient = await getMostEfficientModel();
      expect(mostEfficient).not.toBeNull();
      expect(mostEfficient?.costEfficiency).toBeGreaterThan(100);

      const mostEfficientHighQuality = await getMostEfficientModel(40.0);
      expect(mostEfficientHighQuality).not.toBeNull();
      expect(mostEfficientHighQuality!.activeSweScore).toBeGreaterThanOrEqual(40.0);
    });
  });

  describe('Formatters (Table, JSON, Markdown)', () => {
    let sampleResult: ModelMatrixResult;

    beforeEach(async () => {
      sampleResult = await buildModelMatrix({ limit: 3 });
    });

    it('formatModelMatrixTable formats output nicely', () => {
      const table = formatModelMatrixTable(sampleResult);
      expect(table).toContain('SWE-BENCH PERFORMANCE MATRIX & COST METRICS');
      expect(table).toContain('MODEL ID');
      expect(table).toContain('BLENDED COST/1M ($)');
      expect(table.split('\n').length).toBeGreaterThan(5);
    });

    it('formatModelMatrixJSON produces valid JSON string', () => {
      const jsonStr = formatModelMatrixJSON(sampleResult);
      expect(typeof jsonStr).toBe('string');

      const parsed = JSON.parse(jsonStr);
      expect(parsed.totalModels).toBe(sampleResult.totalModels);
      expect(parsed.entries.length).toBe(3);
    });

    it('formatModelMatrixMarkdown produces markdown document with table', () => {
      const md = formatModelMatrixMarkdown(sampleResult);
      expect(md).toContain('# SWE-bench Performance & Cost Efficiency Matrix');
      expect(md).toContain('| Model ID | Provider | SWE-bench Score |');
      expect(md).toContain('|---|---|---|');
    });

    it('handles empty results formatting without errors', () => {
      const emptyResult: ModelMatrixResult = {
        entries: [],
        totalModels: 0,
        benchmarkType: 'verified',
        bestScoreModel: null,
        bestEfficiencyModel: null,
        cheapestModel: null,
        summary: {
          avgScore: 0,
          avgBlendedCostPer1M: 0,
          avgEfficiency: 0,
          modelsWithBenchmarkDataCount: 0,
          isUsingFallbackPricing: true,
        },
        timestamp: Date.now(),
      };

      const table = formatModelMatrixTable(emptyResult);
      expect(table).toContain('No models found matching criteria.');

      const md = formatModelMatrixMarkdown(emptyResult);
      expect(md).toContain('No models found matching criteria.');
    });
  });

  describe('Empirical Stress Testing Scenarios', () => {
    describe('Stress 1: Zero & Near-Zero Blended Cost', () => {
      it('handles free model without benchmark data cleanly', async () => {
        const freeUnbench: OpenRouterModelSpec = {
          id: 'free/unbenchmarked-llama',
          name: 'Free Unbenchmarked Llama',
          contextLength: 16000,
          promptCostPer1M: 0,
          completionCostPer1M: 0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const mockService = { getModels: async () => [freeUnbench] };
        const result = await buildModelMatrix(undefined, mockService);

        expect(result.entries.length).toBe(1);
        const entry = result.entries[0];
        expect(entry.blendedCostPer1M).toBe(0);
        expect(entry.activeSweScore).toBe(0);
        expect(entry.costEfficiency).toBe(0);
        expect(Number.isFinite(entry.costEfficiency)).toBe(true);
      });

      it('handles free model with benchmark data and observes zero-cost efficiency scaling', async () => {
        const freeBench: OpenRouterModelSpec = {
          id: 'claude-3.7-sonnet',
          name: 'Free Claude 3.7',
          contextLength: 200000,
          promptCostPer1M: 0,
          completionCostPer1M: 0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const mockService = { getModels: async () => [freeBench] };
        const result = await buildModelMatrix(undefined, mockService);

        const entry = result.entries[0];
        expect(entry.blendedCostPer1M).toBe(0);
        expect(entry.activeSweScore).toBe(70.3);
        // Formula fallback: activeSweScore * 1000 = 70300
        expect(entry.costEfficiency).toBe(70300);
      });

      it('exposes discontinuity where ultra-low paid model gets higher efficiency than free model', async () => {
        const freeBench: OpenRouterModelSpec = {
          id: 'claude-3.7-sonnet',
          name: 'Free Claude 3.7',
          contextLength: 200000,
          promptCostPer1M: 0,
          completionCostPer1M: 0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const ultraLowPaidBench: OpenRouterModelSpec = {
          id: 'gemini-2.5-pro',
          name: 'Ultra Cheap Gemini 2.5',
          contextLength: 1000000,
          promptCostPer1M: 0.0005,
          completionCostPer1M: 0.0005,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const mockService = { getModels: async () => [freeBench, ultraLowPaidBench] };
        const result = await buildModelMatrix({ sortBy: 'efficiency' }, mockService);

        const freeEntry = result.entries.find((e) => e.id === 'claude-3.7-sonnet')!;
        const ultraCheapEntry = result.entries.find((e) => e.id === 'gemini-2.5-pro')!;

        // Free Claude 3.7 (score 70.3, cost $0) -> efficiency = 70300
        // Ultra Cheap Gemini 2.5 (score 63.8, cost $0.0005) -> efficiency = 63.8 / 0.0005 = 127600
        expect(freeEntry.costEfficiency).toBe(70300);
        expect(ultraCheapEntry.costEfficiency).toBe(127600);
        // Demonstrates empirical anomaly: paid model ranks as more efficient than free model
        expect(ultraCheapEntry.costEfficiency).toBeGreaterThan(freeEntry.costEfficiency);
      });

      it('rounds micro-costs below 0.0000005 to 0 blended cost', async () => {
        const microCostModel: OpenRouterModelSpec = {
          id: 'micro/model',
          name: 'Micro Cost Model',
          contextLength: 4096,
          promptCostPer1M: 0.0000001,
          completionCostPer1M: 0.0000001,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const mockService = { getModels: async () => [microCostModel] };
        const result = await buildModelMatrix(undefined, mockService);

        const entry = result.entries[0];
        // (3*0.0000001 + 0.0000001)/4 = 0.0000001 -> roundTo(0.0000001, 6) = 0
        expect(entry.blendedCostPer1M).toBe(0);
        expect(entry.costEfficiency).toBe(0);
      });
    });

    describe('Stress 2: Unbenchmarked Models & Lookup Edge Cases', () => {
      it('correctly sets hasBenchmarkData to false and scores to 0 for unbenchmarked models', async () => {
        const unbenchmarkedSpec: OpenRouterModelSpec = {
          id: 'custom-org/novel-llm-v1',
          name: 'Novel LLM V1',
          contextLength: 128000,
          promptCostPer1M: 2.0,
          completionCostPer1M: 4.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const mockService = { getModels: async () => [unbenchmarkedSpec] };
        const result = await buildModelMatrix(undefined, mockService);

        const entry = result.entries[0];
        expect(entry.hasBenchmarkData).toBe(false);
        expect(entry.evalFramework).toBeUndefined();
        expect(entry.sweScoreVerified).toBe(0);
        expect(entry.sweScoreLite).toBe(0);
        expect(entry.activeSweScore).toBe(0);
        expect(entry.costEfficiency).toBe(0);
      });

      it('prevents false-positive score lookup for suffix/prefix variant names', () => {
        expect(lookupSWEBenchScore('vendor/gpt-4o-mini-experimental-v2')).toBeNull();
        expect(lookupSWEBenchScore('custom-claude-3.7-sonnet-derivative')).toBeNull();
        expect(lookupSWEBenchScore('deepseek-r1-distill-qwen-1.5b')).toBeNull();
      });

      it('accurately factors unbenchmarked models into overall matrix summary averages', async () => {
        const benchModel: OpenRouterModelSpec = {
          id: 'claude-3.7-sonnet',
          name: 'Claude 3.7',
          contextLength: 200000,
          promptCostPer1M: 3.0,
          completionCostPer1M: 15.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const unbench1: OpenRouterModelSpec = {
          id: 'unbench/model-1',
          name: 'Unbench 1',
          contextLength: 8000,
          promptCostPer1M: 1.0,
          completionCostPer1M: 1.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const unbench2: OpenRouterModelSpec = {
          id: 'unbench/model-2',
          name: 'Unbench 2',
          contextLength: 8000,
          promptCostPer1M: 1.0,
          completionCostPer1M: 1.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };

        const mockService = { getModels: async () => [benchModel, unbench1, unbench2] };
        const result = await buildModelMatrix(undefined, mockService);

        expect(result.totalModels).toBe(3);
        expect(result.summary.modelsWithBenchmarkDataCount).toBe(1);
        // avgScore = (70.3 + 0 + 0) / 3 = 23.43
        expect(result.summary.avgScore).toBe(23.43);
      });
    });

    describe('Stress 3: Sort Edge Cases & Tie-Breaking Behavior', () => {
      it('correctly breaks ties in activeSweScore using costEfficiency', async () => {
        const specA: OpenRouterModelSpec = {
          id: 'model-a',
          name: 'Model A (Expensive)',
          contextLength: 32000,
          promptCostPer1M: 10.0,
          completionCostPer1M: 10.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const specB: OpenRouterModelSpec = {
          id: 'model-b',
          name: 'Model B (Cheap)',
          contextLength: 32000,
          promptCostPer1M: 1.0,
          completionCostPer1M: 1.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };

        // Mock both having same benchmark score by using an existing model key for both or matching score
        const mockService = {
          getModels: async () => [
            { ...specA, id: 'gpt-4o' },
            { ...specB, id: 'openrouter/openai/gpt-4o' },
          ],
        };

        const result = await buildModelMatrix({ sortBy: 'swe-score', sortOrder: 'desc' }, mockService);

        expect(result.entries.length).toBe(2);
        // Both have score 38.8. Model B has blended cost $1.0 vs Model A blended cost $10.0
        // Model B efficiency (38.8) > Model A efficiency (3.88)
        expect(result.entries[0].id).toBe('openrouter/openai/gpt-4o');
        expect(result.entries[1].id).toBe('gpt-4o');
      });

      it('exposes secondary sort behavior when primary sort is inverted', async () => {
        const model1: OpenRouterModelSpec = {
          id: 'same-name-1',
          name: 'Alpha Model',
          contextLength: 32000,
          promptCostPer1M: 1.0,
          completionCostPer1M: 1.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };
        const model2: OpenRouterModelSpec = {
          id: 'same-name-2',
          name: 'Alpha Model',
          contextLength: 32000,
          promptCostPer1M: 2.0,
          completionCostPer1M: 2.0,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        };

        const mockService = { getModels: async () => [model1, model2] };
        const resultDesc = await buildModelMatrix({ sortBy: 'name', sortOrder: 'desc' }, mockService);

        // When names are equal, secondary sort compares id: a.id.localeCompare(b.id)
        // Notice secondaryDiff is NOT multiplied by orderFactor in implementation.
        // So same-name-1 remains before same-name-2 even with sortOrder desc.
        expect(resultDesc.entries[0].id).toBe('same-name-1');
        expect(resultDesc.entries[1].id).toBe('same-name-2');
      });
    });

    describe('Stress 4: Filtering by Modality & Max Budget', () => {
      const modalSpecs: OpenRouterModelSpec[] = [
        {
          id: 'text-only',
          name: 'Text Model',
          contextLength: 32000,
          promptCostPer1M: 0.1,
          completionCostPer1M: 0.1,
          modalities: ['text'],
          isFallback: false,
          fetchedAt: Date.now(),
        },
        {
          id: 'multimodal-vision',
          name: 'Vision Model',
          contextLength: 128000,
          promptCostPer1M: 2.0,
          completionCostPer1M: 5.0,
          modalities: ['text', 'image'],
          isFallback: false,
          fetchedAt: Date.now(),
        },
        {
          id: 'omni-media',
          name: 'Omni Media Model',
          contextLength: 1000000,
          promptCostPer1M: 5.0,
          completionCostPer1M: 10.0,
          modalities: ['text', 'image', 'audio', 'video'],
          isFallback: false,
          fetchedAt: Date.now(),
        },
      ];

      const mockService = { getModels: async () => modalSpecs };

      it('filters correctly by text, image, audio, and video modalities', async () => {
        const textOnly = await buildModelMatrix({ modality: 'text' }, mockService);
        expect(textOnly.entries.length).toBe(3);

        const imageOnly = await buildModelMatrix({ modality: 'image' }, mockService);
        expect(imageOnly.entries.length).toBe(2);
        expect(imageOnly.entries.map((e) => e.id)).toEqual(['multimodal-vision', 'omni-media']);

        const audioOnly = await buildModelMatrix({ modality: 'audio' }, mockService);
        expect(audioOnly.entries.length).toBe(1);
        expect(audioOnly.entries[0].id).toBe('omni-media');

        const videoOnly = await buildModelMatrix({ modality: 'video' }, mockService);
        expect(videoOnly.entries.length).toBe(1);
        expect(videoOnly.entries[0].id).toBe('omni-media');
      });

      it('filters strictly by maxCostPer1M and handles tight budget limits', async () => {
        const tightBudget = await buildModelMatrix({ maxCostPer1M: 0.15 }, mockService);
        expect(tightBudget.entries.length).toBe(1);
        expect(tightBudget.entries[0].id).toBe('text-only');

        const zeroBudget = await buildModelMatrix({ maxCostPer1M: 0.05 }, mockService);
        expect(zeroBudget.entries.length).toBe(0);
        expect(zeroBudget.totalModels).toBe(0);
        expect(zeroBudget.bestScoreModel).toBeNull();
        expect(zeroBudget.cheapestModel).toBeNull();
      });

      it('combines minScore, maxCostPer1M, and modality filtering seamlessly', async () => {
        // Use default fallback models
        const result = await buildModelMatrix({
          maxCostPer1M: 5.0,
          minScore: 45.0,
          modality: 'image',
        });

        expect(result.entries.every((e) => e.blendedCostPer1M <= 5.0)).toBe(true);
        expect(result.entries.every((e) => e.activeSweScore >= 45.0)).toBe(true);
        expect(result.entries.every((e) => e.modalities.includes('image'))).toBe(true);
      });
    });
  });
});

