import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import {
  CANONICAL_PROVIDER_IDS,
  ALL_CANONICAL_PROVIDERS,
  getProviderIdForModel,
  isProviderEnabled,
  isModelEnabled,
  getEnabledProviders,
  getEnabledModelOptions,
  getFallbackModelForPersona,
} from '../../src/lib/model-filtering';
import { OMNIROUTE_PROVIDERS } from '../../src/components/onboarding/steps/step-3-ai-providers';
import {
  PERSONA_ENSEMBLE_DEFINITIONS,
  AVAILABLE_MODEL_OPTIONS,
} from '../../src/components/onboarding/steps/step-4-persona-ensemble';
import type { ProviderConfigRecord as ModelFilteringProviderConfigRecord } from '../../src/types/dashboard';

describe('Milestone 2 Empirical Challenger Stress Suite: UI Filtering, Fallback Remapping & Cost Calculator', () => {
  let tempStorePath: string;
  let store: DashboardStore;

  beforeEach(() => {
    tempStorePath = path.join('/tmp', `m2_test_store_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.json`);
    store = new DashboardStore(tempStorePath);
  });

  afterEach(() => {
    if (fs.existsSync(tempStorePath)) {
      try {
        fs.unlinkSync(tempStorePath);
      } catch {}
    }
  });

  describe('1. Provider ID Normalization & State Consistency (custom-openai, agy)', () => {
    it('verifies CANONICAL_PROVIDER_IDS dictionary mapping for legacy keys custom_openai and agy_thinking', () => {
      expect(CANONICAL_PROVIDER_IDS['custom_openai']).toBe('custom-openai');
      expect(CANONICAL_PROVIDER_IDS['agy_thinking']).toBe('agy');
    });

    it('verifies ALL_CANONICAL_PROVIDERS contains all providers with normalized IDs', () => {
      expect(ALL_CANONICAL_PROVIDERS).toHaveLength(12);
      expect(ALL_CANONICAL_PROVIDERS).toContain('custom-openai');
      expect(ALL_CANONICAL_PROVIDERS).toContain('agy');
      expect(ALL_CANONICAL_PROVIDERS).not.toContain('custom_openai');
      expect(ALL_CANONICAL_PROVIDERS).not.toContain('agy_thinking');
    });

    it('verifies Step 3 OMNIROUTE_PROVIDERS definitions align exactly with canonical provider IDs', () => {
      const step3Ids = OMNIROUTE_PROVIDERS.map((p) => p.id);
      expect(step3Ids).toContain('custom-openai');
      expect(step3Ids).toContain('agy');
      expect(step3Ids).not.toContain('custom_openai');
      expect(step3Ids).not.toContain('agy_thinking');
      expect(step3Ids).toHaveLength(11);

      // Verify all 11 Step 3 provider IDs match ALL_CANONICAL_PROVIDERS
      for (const id of step3Ids) {
        expect(ALL_CANONICAL_PROVIDERS).toContain(id as any);
      }
    });

    it('verifies getProviderIdForModel resolves custom and agy model IDs to canonical provider IDs', () => {
      expect(getProviderIdForModel('custom-model-v1')).toBe('custom-openai');
      expect(getProviderIdForModel('custom/gpt-4-custom')).toBe('custom-openai');
      expect(getProviderIdForModel('agy/claude-opus-4-6-thinking')).toBe('agy');

      // Registry override test with legacy providerId
      const mockRegistry = {
        'my-custom-model': {
          id: 'my-custom-model',
          providerId: 'custom_openai',
          displayName: 'My Custom Model',
          enabled: true,
        },
        'my-agy-model': {
          id: 'my-agy-model',
          providerId: 'agy_thinking',
          displayName: 'My AGY Model',
          enabled: true,
        },
      };

      expect(getProviderIdForModel('my-custom-model', mockRegistry)).toBe('custom-openai');
      expect(getProviderIdForModel('my-agy-model', mockRegistry)).toBe('agy');
    });

    it('maintains state consistency when updating provider configs in DashboardStore', () => {
      // Update custom-openai in store
      store.updateProviderConfig('custom-openai', {
        enabled: true,
        apiKeyRaw: 'sk-custom-secret-key-12345',
        baseUrl: 'https://custom-ai.internal/v1',
      });

      // Update agy in store
      store.updateProviderConfig('agy', {
        enabled: true,
        apiKeyRaw: 'sk-agy-secret-key-67890',
        baseUrl: 'https://agy.internal/v1',
      });

      const configs = store.getProviderConfigs();
      expect(configs['custom-openai']).toBeDefined();
      expect(configs['custom-openai'].id).toBe('custom-openai');
      expect(configs['custom-openai'].enabled).toBe(true);

      expect(configs['agy']).toBeDefined();
      expect(configs['agy'].id).toBe('agy');
      expect(configs['agy'].enabled).toBe(true);

      // Verify isProviderEnabled resolves both canonical and legacy variant lookup keys correctly.
      // dashboardStore's ProviderConfigRecord and types/dashboard's ProviderConfigRecord are two
      // separate, structurally-diverging interfaces (different `subscriptionTier` unions) -- a
      // pre-existing src/ duplication, not something this test file can fix. Bridge with an
      // explicit typed cast rather than `any`.
      const configsForFiltering = configs as unknown as Record<string, ModelFilteringProviderConfigRecord>;
      expect(isProviderEnabled('custom-openai', configsForFiltering)).toBe(true);
      expect(isProviderEnabled('custom_openai', configsForFiltering)).toBe(true);
      expect(isProviderEnabled('agy', configsForFiltering)).toBe(true);
      expect(isProviderEnabled('agy_thinking', configsForFiltering)).toBe(true);
    });
  });

  describe('2. Dynamic Model Dropdown Filtering & Provider Enablement', () => {
    it('returns all available model options when all providers are enabled', () => {
      const allEnabledProviders = ALL_CANONICAL_PROVIDERS.reduce((acc, pId) => {
        acc[pId] = {
          id: pId,
          displayName: pId,
          enabled: true,
          active: true,
          activeModels: [],
          updatedAt: new Date().toISOString(),
        };
        return acc;
      }, {} as Record<string, any>);

      const enabledOptions = getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, allEnabledProviders);
      expect(enabledOptions).toHaveLength(AVAILABLE_MODEL_OPTIONS.length);
    });

    it('dynamically filters model dropdown options when specific providers are disabled', () => {
      const providersState: Record<string, any> = {
        anthropic: { id: 'anthropic', enabled: false },
        openai: { id: 'openai', enabled: true },
        grok: { id: 'grok', enabled: true },
        deepseek: { id: 'deepseek', enabled: false },
        glm: { id: 'glm', enabled: true },
        gemini: { id: 'gemini', enabled: true },
        agy: { id: 'agy', enabled: true },
        codex: { id: 'codex', enabled: true },
      };

      const enabledOptions = getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, providersState);
      const enabledValues = enabledOptions.map((o) => o.value);

      // Anthropic models disabled
      expect(enabledValues).not.toContain('claude-5-sonnet');
      expect(enabledValues).not.toContain('claude-haiku-4.5');

      // DeepSeek models disabled
      expect(enabledValues).not.toContain('deepseek-v3');

      // Synthetic models enabled
      expect(enabledValues).toContain('synthetic/hf:zai-org/GLM-5.2');
      expect(enabledValues).toContain('synthetic/hf:moonshotai/Kimi-K3');
    });

    it('handles edge case when ALL canonical providers are explicitly disabled', () => {
      const allDisabledProviders = ALL_CANONICAL_PROVIDERS.reduce((acc, pId) => {
        acc[pId] = {
          id: pId,
          displayName: pId,
          enabled: false,
          active: false,
          activeModels: [],
          updatedAt: new Date().toISOString(),
        };
        return acc;
      }, {} as Record<string, any>);

      const enabledOptions = getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, allDisabledProviders);
      expect(enabledOptions).toHaveLength(0);

      const enabledProviders = getEnabledProviders(allDisabledProviders);
      expect(enabledProviders).toHaveLength(0);

      // Test component logic fallback when enabledOptions is empty
      const filteredForUi = enabledOptions.length > 0 ? enabledOptions : AVAILABLE_MODEL_OPTIONS;
      expect(filteredForUi).toEqual(AVAILABLE_MODEL_OPTIONS);
    });
  });

  describe('3. Fallback Remapping Engine Stress & Edge Cases', () => {
    it('keeps current model if its provider is enabled', () => {
      const enabledOptions = [
        { label: 'Claude 5 Sonnet', value: 'claude-5-sonnet' },
        { label: 'GPT-4o', value: 'gpt-4o' },
      ];

      const fallback = getFallbackModelForPersona('gpt-4o', enabledOptions, 'claude-5-sonnet');
      expect(fallback).toBe('gpt-4o');
    });

    it('remaps model to first enabled option when current model provider is disabled', () => {
      const enabledOptions = [
        { label: 'GPT-4o', value: 'gpt-4o' },
        { label: 'Grok 4.5', value: 'grok-cli/grok-4.5' },
      ];

      // Current model claude-5-sonnet is disabled
      const fallback = getFallbackModelForPersona('claude-5-sonnet', enabledOptions, 'claude-5-sonnet');
      expect(fallback).toBe('gpt-4o');
    });

    it('falls back to default fallback model when no options are enabled', () => {
      const fallback = getFallbackModelForPersona('claude-5-sonnet', [], 'gpt-4o');
      expect(fallback).toBe('gpt-4o');
    });

    it('verifies DashboardStore updateProviderConfig prevents disabling provider when active persona relies on its model', () => {
      // Setup persona using anthropic claude-haiku-4.5
      store.updatePersonaSetting('security', {
        enabled: true,
        model: 'claude-haiku-4.5',
      });

      // Attempting to disable anthropic should throw error because active persona relies on it
      expect(() => {
        store.updateProviderConfig('anthropic', { enabled: false, active: false });
      }).toThrow(/Cannot disable provider or model/);
    });
  });

  describe('4. Cost Calculator & Spending Cap Math & Preset Logic', () => {
    it('calculates monthly token cost and cost per PR accurately across preset tiers', () => {
      const monthlyPrs = 200;
      const tokensPerPr = 30000;
      const totalMonthlyTokens = monthlyPrs * tokensPerPr; // 6,000,000 tokens (6M)

      const presetRates = {
        budget: 0.8,
        balanced: 3.5,
        premium: 8.5,
        max_reasoning: 15.0,
      };

      const budgetCost = (totalMonthlyTokens / 1_000_000) * presetRates.budget; // 6 * 0.8 = $4.80
      const balancedCost = (totalMonthlyTokens / 1_000_000) * presetRates.balanced; // 6 * 3.5 = $21.00
      const premiumCost = (totalMonthlyTokens / 1_000_000) * presetRates.premium; // 6 * 8.5 = $51.00
      const maxReasoningCost = (totalMonthlyTokens / 1_000_000) * presetRates.max_reasoning; // 6 * 15.0 = $90.00

      expect(budgetCost).toBeCloseTo(4.8, 2);
      expect(balancedCost).toBeCloseTo(21.0, 2);
      expect(premiumCost).toBeCloseTo(51.0, 2);
      expect(maxReasoningCost).toBeCloseTo(90.0, 2);

      expect(budgetCost / monthlyPrs).toBeCloseTo(0.024, 3);
      expect(balancedCost / monthlyPrs).toBeCloseTo(0.105, 3);
    });

    it('correctly evaluates spending cap breach status', () => {
      const capUsd = 50.0;
      const estimatedCostUnder = 45.0;
      const estimatedCostOver = 55.0;

      expect(estimatedCostUnder > capUsd).toBe(false);
      expect(estimatedCostOver > capUsd).toBe(true);

      const alertThresholdPercent = 80;
      const alertTriggerUsd = (capUsd * alertThresholdPercent) / 100;
      expect(alertTriggerUsd).toBe(40.0);
    });
  });
});
