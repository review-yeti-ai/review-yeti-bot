import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderPool, providerConfigSchema } from '../../src/gateway/providerPool';

describe('providerPool.ts — Comprehensive Unit Expansion Tests', () => {
  let pool: ProviderPool;

  beforeEach(() => {
    pool = new ProviderPool();
  });

  it('providerConfigSchema validates required fields (id, type, apiKey, models)', () => {
    const valid = providerConfigSchema.safeParse({
      id: 'p1',
      type: 'openai',
      apiKey: 'sk-123',
      models: ['gpt-4o'],
    });
    expect(valid.success).toBe(true);

    const invalid = providerConfigSchema.safeParse({
      id: 'p1',
      // missing type & apiKey & models
    });
    expect(invalid.success).toBe(false);
  });

  it('providerConfigSchema rejects empty models array', () => {
    const res = providerConfigSchema.safeParse({
      id: 'p1',
      type: 'openai',
      apiKey: 'sk-123',
      models: [],
    });
    expect(res.success).toBe(false);
  });

  it('registerProvider adds provider to pool and returns validated config', () => {
    const config = {
      id: 'anthropic-pool-test',
      type: 'anthropic',
      apiKey: 'sk-ant-123',
      models: ['claude-5-sonnet', 'claude-3-5-sonnet'],
    };

    const registered = pool.registerProvider(config);

    expect(registered.id).toBe('anthropic-pool-test');
    expect(pool.hasProvider('anthropic-pool-test')).toBe(true);
    expect(pool.getProvider('anthropic-pool-test')?.apiKey).toBe('sk-ant-123');
  });

  it('registerProvider throws error when attempting to register duplicate provider ID', () => {
    const config = {
      id: 'dup-id',
      type: 'custom',
      apiKey: 'key-1',
      models: ['model-1'],
    };

    pool.registerProvider(config);

    expect(() => pool.registerProvider(config)).toThrow("Provider with id 'dup-id' is already registered");
  });

  it('getProvider returns undefined for non-existent provider ID', () => {
    expect(pool.getProvider('non-existent-id')).toBeUndefined();
  });

  it('listProviders returns array of all registered provider configurations', () => {
    expect(pool.listProviders()).toHaveLength(0);

    pool.registerProvider({ id: 'a', type: 't', apiKey: 'k', models: ['m1'] });
    pool.registerProvider({ id: 'b', type: 't', apiKey: 'k', models: ['m2'] });

    const list = pool.listProviders();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('removeProvider deletes provider by ID and returns boolean success status', () => {
    pool.registerProvider({ id: 'temp', type: 't', apiKey: 'k', models: ['m1'] });
    expect(pool.hasProvider('temp')).toBe(true);

    const removed = pool.removeProvider('temp');
    expect(removed).toBe(true);
    expect(pool.hasProvider('temp')).toBe(false);

    const removeNonExistent = pool.removeProvider('temp');
    expect(removeNonExistent).toBe(false);
  });

  it('isModelAllowed checks allowlisted models for registered providers', () => {
    pool.registerProvider({
      id: 'multi-model-provider',
      type: 'openai-compatible',
      apiKey: 'sk-123',
      models: ['gpt-5.6-sol', 'deepseek-v4-pro', 'glm-5.2'],
    });

    expect(pool.isModelAllowed('multi-model-provider', 'gpt-5.6-sol')).toBe(true);
    expect(pool.isModelAllowed('multi-model-provider', 'deepseek-v4-pro')).toBe(true);
    expect(pool.isModelAllowed('multi-model-provider', 'glm-5.2')).toBe(true);
    expect(pool.isModelAllowed('multi-model-provider', 'unauthorized-model')).toBe(false);
    expect(pool.isModelAllowed('non-existent-provider', 'gpt-5.6-sol')).toBe(false);
  });

  it('clear removes all providers from pool', () => {
    pool.registerProvider({ id: 'p1', type: 't', apiKey: 'k', models: ['m1'] });
    pool.registerProvider({ id: 'p2', type: 't', apiKey: 'k', models: ['m2'] });

    expect(pool.listProviders()).toHaveLength(2);
    pool.clear();
    expect(pool.listProviders()).toHaveLength(0);
  });
});
