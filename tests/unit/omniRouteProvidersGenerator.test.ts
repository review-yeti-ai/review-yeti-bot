import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import {
  OMNIROUTE_GENERATED_PROVIDERS,
  OMNIROUTE_GENERATED_MODEL_LIST,
  ProviderType,
} from '../../src/types/providers.generated';

describe('Milestone 1: Generated Provider Metadata (providers.generated.ts)', () => {
  it('exports metadata for all 9 AI provider families plus codex/agy', () => {
    const requiredProviders: ProviderType[] = [
      'openai',
      'anthropic',
      'gemini',
      'grok',
      'deepseek',
      'glm',
      'doppler',
      'ollama',
      'custom-openai',
      'codex',
      'agy',
    ];

    for (const providerId of requiredProviders) {
      expect(OMNIROUTE_GENERATED_PROVIDERS[providerId]).toBeDefined();
      expect(OMNIROUTE_GENERATED_PROVIDERS[providerId].id).toBe(providerId);
      expect(OMNIROUTE_GENERATED_PROVIDERS[providerId].displayName).toBeTruthy();
      expect(OMNIROUTE_GENERATED_PROVIDERS[providerId].defaultBaseUrl).toBeTruthy();
      expect(Array.isArray(OMNIROUTE_GENERATED_PROVIDERS[providerId].supportedModels)).toBe(true);
    }
  });

  it('validates specific provider family configurations', () => {
    expect(OMNIROUTE_GENERATED_PROVIDERS.openai.displayName).toBe('OpenAI');
    expect(OMNIROUTE_GENERATED_PROVIDERS.openai.supportedModels).toContain('gpt-4o');
    expect(OMNIROUTE_GENERATED_PROVIDERS.openai.supportsCustomModels).toBe(true);
    expect(OMNIROUTE_GENERATED_PROVIDERS.openai.requiresApiKey).toBe(true);

    expect(OMNIROUTE_GENERATED_PROVIDERS.anthropic.displayName).toBe('Anthropic Claude');
    expect(OMNIROUTE_GENERATED_PROVIDERS.anthropic.supportedModels).toContain('claude-3-5-sonnet');

    expect(OMNIROUTE_GENERATED_PROVIDERS.ollama.supportsCustomModels).toBe(true);
    expect(OMNIROUTE_GENERATED_PROVIDERS.ollama.requiresApiKey).toBe(false);

    expect(OMNIROUTE_GENERATED_PROVIDERS.glm.requiresApiKey).toBe(false);
  });

  it('exports a non-empty OMNIROUTE_GENERATED_MODEL_LIST containing active models', () => {
    expect(Array.isArray(OMNIROUTE_GENERATED_MODEL_LIST)).toBe(true);
    expect(OMNIROUTE_GENERATED_MODEL_LIST.length).toBeGreaterThan(10);
    expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('gpt-4o');
    expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('claude-3-5-sonnet');
    expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('gemini-1.5-pro');
    expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('grok-cli/grok-4.5');
    expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('deepseek-v3');
    expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('glm-5.2');
  });
});

describe('Milestone 2: DashboardStore & Backend API Sync', () => {
  let app: any;
  let validApiKey: string;

  beforeEach(() => {
    app = createApp();
    const keyRecord = dashboardStore.createApiKey('test-provider-key');
    validApiKey = keyRecord.rawKey;
  });

  it('provides default provider configs for all 9 provider families in DashboardStore', () => {
    const providers = dashboardStore.getProviderConfigs();
    expect(providers.openai).toBeDefined();
    expect(providers.anthropic).toBeDefined();
    expect(providers.gemini).toBeDefined();
    expect(providers.grok).toBeDefined();
    expect(providers.deepseek).toBeDefined();
    expect(providers.glm).toBeDefined();
    expect(providers.doppler).toBeDefined();
    expect(providers.ollama).toBeDefined();
    expect(providers['custom-openai']).toBeDefined();
  });

  it('dynamically registers and validates custom/active models for persona validation', () => {
    dashboardStore.updateProviderConfig('ollama', {
      enabled: true,
      activeModels: ['llama3.3', 'my-custom-local-llm'],
      customModels: ['my-custom-local-llm'],
    });

    const activeModels = dashboardStore.getDynamicActiveModels();
    expect(activeModels).toContain('my-custom-local-llm');

    // validatePersonaSetting should allow dynamically added model
    expect(() => {
      dashboardStore.validatePersonaSetting({
        id: 'security',
        displayName: 'Security Guardian',
        enabled: true,
        effort: 'high',
        confidenceThreshold: 85,
        model: 'my-custom-local-llm',
      });
    }).not.toThrow();
  });

  it('GET /api/dashboard/providers returns active provider configurations and model registry', async () => {
    const res = await request(app)
      .get('/api/dashboard/providers')
      .set('x-api-key', validApiKey);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.providers).toBeDefined();
    expect(res.body.providers.openai).toBeDefined();
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.modelRegistry).toBeDefined();
  });

  it('PUT /api/dashboard/providers/:id updates single provider settings', async () => {
    const res = await request(app)
      .put('/api/dashboard/providers/openai')
      .set('x-api-key', validApiKey)
      .send({
        enabled: true,
        subscriptionTier: 'enterprise',
        activeModels: ['gpt-4o', 'o3-mini'],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.provider).toBeDefined();
    expect(res.body.provider.id).toBe('openai');
    expect(res.body.provider.subscriptionTier).toBe('Enterprise');
    expect(res.body.provider.activeModels).toEqual(['gpt-4o', 'o3-mini']);
  });

  it('POST /api/dashboard/providers/:id/test executes live connection health check', async () => {
    const res = await request(app)
      .post('/api/dashboard/providers/openai/test')
      .set('x-api-key', validApiKey)
      .send({ baseUrl: 'https://api.openai.com/v1' });

    expect(res.status).toBe(200);
    expect(typeof res.body.status).toBe('string');
    expect(['connected', 'disconnected', 'error']).toContain(res.body.status);
    expect(typeof res.body.latencyMs).toBe('number');
    expect(res.body.message).toContain('OpenAI');
  });
});
