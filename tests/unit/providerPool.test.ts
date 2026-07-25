import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderPool, ProviderConfig } from '../../src/gateway/providerPool';

describe('ProviderPool Unit Tests', () => {
  let pool: ProviderPool;

  beforeEach(() => {
    pool = new ProviderPool();
  });

  describe('Dynamic Provider Registration & Schema Validation', () => {
    it('registers a valid provider configuration', () => {
      const config: ProviderConfig = {
        id: 'openai-prod',
        type: 'openai',
        apiKey: 'sk-proj-test123456',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini'],
      };

      const registered = pool.registerProvider(config);
      expect(registered).toEqual(config);
      expect(pool.hasProvider('openai-prod')).toBe(true);
    });

    it('registers a provider without optional baseUrl', () => {
      const config: ProviderConfig = {
        id: 'anthropic-prod',
        type: 'anthropic',
        apiKey: 'sk-ant-test123456',
        models: ['claude-3-5-sonnet-20240620'],
      };

      const registered = pool.registerProvider(config);
      expect(registered.id).toBe('anthropic-prod');
      expect(registered.baseUrl).toBeUndefined();
      expect(pool.hasProvider('anthropic-prod')).toBe(true);
    });

    it('rejects provider registration with missing id', () => {
      const invalid = {
        id: '',
        type: 'openai',
        apiKey: 'sk-test',
        models: ['gpt-4o'],
      } as ProviderConfig;

      expect(() => pool.registerProvider(invalid)).toThrow();
    });

    it('rejects provider registration with empty models list', () => {
      const invalid = {
        id: 'empty-models',
        type: 'openai',
        apiKey: 'sk-test',
        models: [],
      } as unknown as ProviderConfig;

      expect(() => pool.registerProvider(invalid)).toThrow();
    });

    it('rejects provider registration with missing apiKey', () => {
      const invalid = {
        id: 'no-key',
        type: 'openai',
        apiKey: '',
        models: ['gpt-4o'],
      } as ProviderConfig;

      expect(() => pool.registerProvider(invalid)).toThrow();
    });
  });

  describe('Lookup & Listing Methods', () => {
    beforeEach(() => {
      pool.registerProvider({
        id: 'p1',
        type: 'openai',
        apiKey: 'key1',
        models: ['m1', 'm2'],
      });
      pool.registerProvider({
        id: 'p2',
        type: 'ollama',
        apiKey: 'key2',
        models: ['llama3'],
      });
    });

    it('retrieves registered provider by ID via getProvider', () => {
      const p1 = pool.getProvider('p1');
      expect(p1).toBeDefined();
      expect(p1?.id).toBe('p1');
      expect(p1?.type).toBe('openai');
    });

    it('returns undefined for non-existent provider via getProvider', () => {
      expect(pool.getProvider('non-existent')).toBeUndefined();
    });

    it('correctly reports existence via hasProvider', () => {
      expect(pool.hasProvider('p1')).toBe(true);
      expect(pool.hasProvider('p2')).toBe(true);
      expect(pool.hasProvider('p3')).toBe(false);
    });

    it('lists all registered providers via listProviders', () => {
      const list = pool.listProviders();
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.id)).toEqual(['p1', 'p2']);
    });
  });

  describe('Duplicate Prevention', () => {
    it('prevents registering duplicate provider IDs', () => {
      const config: ProviderConfig = {
        id: 'duplicate-id',
        type: 'openai',
        apiKey: 'key-1',
        models: ['gpt-4o'],
      };

      pool.registerProvider(config);

      const duplicateConfig: ProviderConfig = {
        id: 'duplicate-id',
        type: 'azure-openai',
        apiKey: 'key-2',
        models: ['gpt-4-turbo'],
      };

      expect(() => pool.registerProvider(duplicateConfig)).toThrow(
        "Provider with id 'duplicate-id' is already registered"
      );
    });
  });

  describe('Model Allowlisting', () => {
    beforeEach(() => {
      pool.registerProvider({
        id: 'allowlist-provider',
        type: 'openai',
        apiKey: 'sk-test',
        models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'],
      });
    });

    it('returns true when checking an allowlisted model', () => {
      expect(pool.isModelAllowed('allowlist-provider', 'gpt-4o')).toBe(true);
      expect(pool.isModelAllowed('allowlist-provider', 'gpt-4o-mini')).toBe(true);
      expect(pool.isModelAllowed('allowlist-provider', 'o1-preview')).toBe(true);
    });

    it('returns false for unlisted model for registered provider', () => {
      expect(pool.isModelAllowed('allowlist-provider', 'gpt-3.5-turbo')).toBe(false);
      expect(pool.isModelAllowed('allowlist-provider', 'claude-3-opus')).toBe(false);
    });

    it('returns false for unregistered provider ID', () => {
      expect(pool.isModelAllowed('unknown-provider', 'gpt-4o')).toBe(false);
    });
  });

  describe('Provider Removal', () => {
    it('removes an existing provider by ID', () => {
      pool.registerProvider({
        id: 'temp-provider',
        type: 'ollama',
        apiKey: 'none',
        models: ['mistral'],
      });

      expect(pool.hasProvider('temp-provider')).toBe(true);
      const removed = pool.removeProvider('temp-provider');
      expect(removed).toBe(true);
      expect(pool.hasProvider('temp-provider')).toBe(false);
    });

    it('returns false when attempting to remove non-existent provider', () => {
      expect(pool.removeProvider('ghost')).toBe(false);
    });
  });
});
