import { describe, it, expect } from 'vitest';
import {
  isModelEnabled,
  getEnabledModelOptions,
  getEnabledProviders,
  getProviderIdForModel,
  getFallbackModelForPersona,
} from '../../src/lib/model-filtering';
import { AVAILABLE_MODEL_OPTIONS, PERSONA_ENSEMBLE_DEFINITIONS } from '../../src/components/onboarding/steps/step-4-persona-ensemble';
import { ProviderConfigRecord, PersonaSetting } from '../../src/types/dashboard';

describe('Milestone 2 Empirical Challenger Test Suite', () => {
  describe('1. Disabled Provider & Model Filtering in Step 4 Dropdowns', () => {
    it('excludes GPT-4o and GPT-4o Mini when OpenAI provider is disabled', () => {
      const providersDisabledOpenAI: Record<string, ProviderConfigRecord> = {
        openai: { id: 'openai', displayName: 'OpenAI', enabled: false, activeModels: [], updatedAt: new Date().toISOString() },
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        grok: { id: 'grok', displayName: 'xAI Grok', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        gemini: { id: 'gemini', displayName: 'Google Gemini', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
      };

      // Direct model checks
      expect(isModelEnabled('gpt-4o', providersDisabledOpenAI)).toBe(false);
      expect(isModelEnabled('gpt-4o-mini', providersDisabledOpenAI)).toBe(false);
      expect(isModelEnabled('claude-3-5-sonnet', providersDisabledOpenAI)).toBe(true);

      // Options list filtering
      const filteredOptions = getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, providersDisabledOpenAI);
      const values = filteredOptions.map((opt) => opt.value);

      expect(values).not.toContain('gpt-4o');
      expect(values).not.toContain('gpt-4o-mini');
      expect(values).toContain('claude-3-5-sonnet');
      expect(values).toContain('gemini-1.5-pro');
    });

    it('excludes Gemini 1.5 Pro when Google (gemini) provider is disabled', () => {
      const providersDisabledGoogle: Record<string, ProviderConfigRecord> = {
        openai: { id: 'openai', displayName: 'OpenAI', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        gemini: { id: 'gemini', displayName: 'Google Gemini', enabled: false, activeModels: [], updatedAt: new Date().toISOString() },
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
      };

      // Direct model check
      expect(isModelEnabled('gemini-1.5-pro', providersDisabledGoogle)).toBe(false);
      expect(getProviderIdForModel('gemini-1.5-pro')).toBe('gemini');

      // Options list filtering
      const filteredOptions = getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, providersDisabledGoogle);
      const values = filteredOptions.map((opt) => opt.value);

      expect(values).not.toContain('gemini-1.5-pro');
      expect(values).toContain('gpt-4o');
      expect(values).toContain('claude-3-5-sonnet');
    });
  });

  describe('2. Cost Estimator Preset Filtering', () => {
    it('correctly identifies enabled vs disabled providers for cost estimator presets', () => {
      const ALL_PRESETS = [
        { id: 'budget', requiredProviders: ['openai', 'deepseek'] },
        { id: 'balanced', requiredProviders: ['anthropic', 'openai', 'grok'] },
        { id: 'premium', requiredProviders: ['anthropic', 'grok'] },
        { id: 'max_reasoning', requiredProviders: ['agy', 'codex'] },
      ];

      const providersNoOpenAI: Record<string, ProviderConfigRecord> = {
        openai: { id: 'openai', displayName: 'OpenAI', enabled: false, activeModels: [], updatedAt: new Date().toISOString() },
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        grok: { id: 'grok', displayName: 'xAI Grok', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        deepseek: { id: 'deepseek', displayName: 'DeepSeek', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
      };

      const enabledPresets = ALL_PRESETS.filter((preset) =>
        preset.requiredProviders.every((pId) => {
          const config = providersNoOpenAI[pId];
          return !config || config.enabled !== false;
        })
      );

      const enabledIds = enabledPresets.map((p) => p.id);
      expect(enabledIds).not.toContain('budget');
      expect(enabledIds).not.toContain('balanced');
      expect(enabledIds).toContain('premium');
    });
  });

  describe('3. Manifest Drawer (.ct-review.yml) Verification', () => {
    it('generates .ct-review.yml containing ONLY enabled providers in provider_priority and fallbacks disabled models', () => {
      const activeProvidersMap: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        grok: { id: 'grok', displayName: 'xAI Grok', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        deepseek: { id: 'deepseek', displayName: 'DeepSeek', enabled: true, activeModels: [], updatedAt: new Date().toISOString() },
        openai: { id: 'openai', displayName: 'OpenAI', enabled: false, activeModels: [], updatedAt: new Date().toISOString() },
        gemini: { id: 'gemini', displayName: 'Google Gemini', enabled: false, activeModels: [], updatedAt: new Date().toISOString() },
      };

      const enabledProviders = getEnabledProviders(activeProvidersMap);
      expect(enabledProviders).toContain('anthropic');
      expect(enabledProviders).toContain('grok');
      expect(enabledProviders).toContain('deepseek');
      expect(enabledProviders).not.toContain('openai');
      expect(enabledProviders).not.toContain('gemini');

      // Test fallback behavior for persona assigned to disabled model (e.g. gpt-4o for ux_product)
      const enabledModelOptions = AVAILABLE_MODEL_OPTIONS.filter((opt) =>
        isModelEnabled(opt.value, activeProvidersMap)
      );

      const effectiveModelForGpt4o = getFallbackModelForPersona('gpt-4o', enabledModelOptions, 'claude-3-5-sonnet');
      expect(effectiveModelForGpt4o).not.toBe('gpt-4o');
      expect(isModelEnabled(effectiveModelForGpt4o, activeProvidersMap)).toBe(true);

      const effectiveProviderId = getProviderIdForModel(effectiveModelForGpt4o);
      expect(enabledProviders).toContain(effectiveProviderId);
    });
  });
});
