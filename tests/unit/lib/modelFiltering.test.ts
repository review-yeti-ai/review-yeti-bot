import { describe, it, expect } from 'vitest';
import {
  getProviderIdForModel,
  isProviderEnabled,
  isModelEnabled,
  getEnabledProviders,
  getEnabledModelOptions,
  getFallbackModelForPersona,
  CANONICAL_PROVIDER_IDS,
  ALL_CANONICAL_PROVIDERS,
} from '@/lib/model-filtering';
import { ProviderConfigRecord } from '@/types/dashboard';

describe('Model Filtering & Provider Normalization Unit Tests', () => {
  it('maps legacy provider IDs to canonical IDs', () => {
    expect(CANONICAL_PROVIDER_IDS['custom_openai']).toBe('custom-openai');
    expect(CANONICAL_PROVIDER_IDS['agy_thinking']).toBe('agy');
  });

  it('correctly resolves provider ID for various model names', () => {
    expect(getProviderIdForModel('claude-3-5-sonnet')).toBe('anthropic');
    expect(getProviderIdForModel('gpt-4o')).toBe('openai');
    expect(getProviderIdForModel('gpt-4o-mini')).toBe('openai');
    expect(getProviderIdForModel('grok-cli/grok-4.5')).toBe('grok');
    expect(getProviderIdForModel('glm-5.2')).toBe('glm');
    expect(getProviderIdForModel('deepseek-v3')).toBe('deepseek');
    expect(getProviderIdForModel('gemini-1.5-pro')).toBe('gemini');
    expect(getProviderIdForModel('agy/claude-opus-4-6-thinking')).toBe('agy');
    expect(getProviderIdForModel('synthetic/hf:moonshotai/Kimi-K3')).toBe('glm');
    expect(getProviderIdForModel('opencode-go/glm-5.2')).toBe('glm');
    expect(getProviderIdForModel('codex/gpt-5.6-sol-high')).toBe('codex');
    expect(getProviderIdForModel('llama3.3')).toBe('ollama');
  });

  it('determines provider enablement correctly', () => {
    const providers: Record<string, ProviderConfigRecord> = {
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: false,
        active: false,
        updatedAt: new Date().toISOString(),
      },
      anthropic: {
        id: 'anthropic',
        displayName: 'Anthropic',
        enabled: true,
        active: true,
        updatedAt: new Date().toISOString(),
      },
    };

    expect(isProviderEnabled('openai', providers)).toBe(false);
    expect(isProviderEnabled('anthropic', providers)).toBe(true);
    // Unconfigured provider strictly returns false when provider map is present
    expect(isProviderEnabled('grok', providers)).toBe(false);
  });

  it('determines model enablement based on provider enablement', () => {
    const providers: Record<string, ProviderConfigRecord> = {
      openai: {
        id: 'openai',
        displayName: 'OpenAI',
        enabled: false,
        updatedAt: new Date().toISOString(),
      },
      anthropic: {
        id: 'anthropic',
        displayName: 'Anthropic',
        enabled: true,
        updatedAt: new Date().toISOString(),
      },
    };

    expect(isModelEnabled('gpt-4o', providers)).toBe(false);
    expect(isModelEnabled('gpt-4o-mini', providers)).toBe(false);
    expect(isModelEnabled('claude-3-5-sonnet', providers)).toBe(true);
  });

  it('returns array of active enabled providers', () => {
    const providers: Record<string, ProviderConfigRecord> = {
      openai: { id: 'openai', displayName: 'OpenAI', enabled: false, updatedAt: '' },
      deepseek: { id: 'deepseek', displayName: 'DeepSeek', enabled: false, updatedAt: '' },
      anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, updatedAt: '' },
      grok: { id: 'grok', displayName: 'Grok', enabled: true, updatedAt: '' },
    };

    const enabled = getEnabledProviders(providers);
    expect(enabled).not.toContain('openai');
    expect(enabled).not.toContain('deepseek');
    expect(enabled).toContain('anthropic');
    expect(enabled).toContain('grok');
  });

  it('filters model options correctly', () => {
    const modelOptions = [
      { label: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet' },
      { label: 'GPT-4o', value: 'gpt-4o' },
      { label: 'DeepSeek V3', value: 'deepseek-v3' },
    ];

    const providers: Record<string, ProviderConfigRecord> = {
      openai: { id: 'openai', displayName: 'OpenAI', enabled: false, updatedAt: '' },
      anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, updatedAt: '' },
      deepseek: { id: 'deepseek', displayName: 'DeepSeek', enabled: true, updatedAt: '' },
    };

    const filtered = getEnabledModelOptions(modelOptions, providers);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((f) => f.value)).not.toContain('gpt-4o');
    expect(filtered.map((f) => f.value)).toContain('claude-3-5-sonnet');
    expect(filtered.map((f) => f.value)).toContain('deepseek-v3');
  });

  it('provides fallback model when current model belongs to a disabled provider', () => {
    const enabledOptions = [
      { label: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet' },
      { label: 'DeepSeek V3', value: 'deepseek-v3' },
    ];

    expect(getFallbackModelForPersona('gpt-4o', enabledOptions)).toBe('claude-3-5-sonnet');
    expect(getFallbackModelForPersona('claude-3-5-sonnet', enabledOptions)).toBe('claude-3-5-sonnet');
  });
});
