import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp, providerPool } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { OMNIROUTE_GENERATED_PROVIDERS, OMNIROUTE_GENERATED_MODEL_LIST } from '../../src/types/providers.generated';

// Parser helper mirror functions to test parser resilience on modified inputs
function parseOmniRouteProvenance(omniRouteClientContent: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const match = omniRouteClientContent.match(/const OMNIROUTE_PROVIDER_PROVENANCE:\s*Record<string,\s*readonly string\[\]>\s*=\s*(\{[\s\S]*?\});/);
  if (match && match[1]) {
    try {
      const lines = match[1].split('\n');
      for (const line of lines) {
        const lineMatch = line.match(/['"]?([a-zA-Z0-9_-]+)['"]?:\s*\[(.*?)\]/);
        if (lineMatch) {
          const key = lineMatch[1];
          const prefixes = lineMatch[2]
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, ''))
            .filter(Boolean);
          map[key] = prefixes;
        }
      }
    } catch {}
  }
  return map;
}

function parseSchemaModels(schemaContent: string): { v3Models: Record<string, string>; allowedModels: string[] } {
  const v3Models: Record<string, string> = {};
  const allowedModels: string[] = [];

  const v3Match = schemaContent.match(/export const V3_PROVIDER_MODELS\s*=\s*(\{[\s\S]*?\})\s*as const;/);
  if (v3Match && v3Match[1]) {
    const lines = v3Match[1].split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/['"]?([a-zA-Z0-9_-]+)['"]?:\s*['"]([^'"]+)['"]/);
      if (lineMatch) {
        v3Models[lineMatch[1]] = lineMatch[2];
      }
    }
  }

  const allowedMatch = schemaContent.match(/export const R4_ALLOWED_MODELS\s*=\s*\[([\s\S]*?)\];/);
  if (allowedMatch && allowedMatch[1]) {
    const items = allowedMatch[1]
      .split('\n')
      .map((line) => {
        const m = line.match(/['"]([^'"]+)['"]/);
        return m ? m[1] : null;
      })
      .filter((x): x is string => x !== null);
    allowedModels.push(...items);
  }

  return { v3Models, allowedModels };
}

describe('AI Providers & Models Management System Empirical Test Suite', () => {
  let app: any;
  let apiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-12345';
    app = createApp();
  });

  beforeEach(() => {
    const keyRecord = dashboardStore.createApiKey('challenger-ai-providers-key');
    apiKey = keyRecord.rawKey;
    providerPool.clear();
  });

  describe('1. Task 1: Auto-Generator Verification (`scripts/generate-omniroute-providers.ts`)', () => {
    it('verifies that src/types/providers.generated.ts exists and contains valid exports', () => {
      const generatedPath = path.resolve(__dirname, '../../src/types/providers.generated.ts');
      expect(fs.existsSync(generatedPath)).toBe(true);

      const content = fs.readFileSync(generatedPath, 'utf8');
      expect(content).toContain('export type ProviderType =');
      expect(content).toContain('export const OMNIROUTE_GENERATED_PROVIDERS');
      expect(content).toContain('export const OMNIROUTE_GENERATED_MODEL_LIST');
    });

    it('validates all 11 provider definitions in OMNIROUTE_GENERATED_PROVIDERS', () => {
      const expectedProviders = [
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

      for (const provId of expectedProviders) {
        const prov = (OMNIROUTE_GENERATED_PROVIDERS as any)[provId];
        expect(prov).toBeDefined();
        expect(prov.id).toBe(provId);
        expect(typeof prov.displayName).toBe('string');
        expect(typeof prov.defaultBaseUrl).toBe('string');
        expect(Array.isArray(prov.provenancePrefixes)).toBe(true);
        expect(typeof prov.defaultModel).toBe('string');
        expect(Array.isArray(prov.supportedModels)).toBe(true);
        expect(typeof prov.supportsCustomModels).toBe('boolean');
        expect(typeof prov.requiresApiKey).toBe('boolean');
      }
    });

    it('verifies custom model capability flags for ollama, custom-openai, and deepseek', () => {
      expect(OMNIROUTE_GENERATED_PROVIDERS.ollama.supportsCustomModels).toBe(true);
      expect(OMNIROUTE_GENERATED_PROVIDERS['custom-openai'].supportsCustomModels).toBe(true);
      expect(OMNIROUTE_GENERATED_PROVIDERS.deepseek.supportsCustomModels).toBe(true);

      expect(OMNIROUTE_GENERATED_PROVIDERS.anthropic.supportsCustomModels).toBe(false);
      expect(OMNIROUTE_GENERATED_PROVIDERS.gemini.supportsCustomModels).toBe(false);
    });

    it('verifies generated model list contains expected standard models', () => {
      expect(Array.isArray(OMNIROUTE_GENERATED_MODEL_LIST)).toBe(true);
      expect(OMNIROUTE_GENERATED_MODEL_LIST.length).toBeGreaterThan(15);
      expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('gpt-4o');
      expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('claude-3-5-sonnet');
      expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('llama3.3');
      expect(OMNIROUTE_GENERATED_MODEL_LIST).toContain('custom-model-v1');
    });

    it('empirically tests input parsing with modified input strings', () => {
      const mockOmniRouteCode = `
        const OMNIROUTE_PROVIDER_PROVENANCE: Record<string, readonly string[]> = {
          'grok-cli': ['grok-cli', 'grok-v2', 'xai'],
          'codex': ['codex', 'cx-custom'],
          'agy': ['agy', 'thinking-v1'],
        };
      `;

      const provenanceMap = parseOmniRouteProvenance(mockOmniRouteCode);
      expect(provenanceMap['grok-cli']).toEqual(['grok-cli', 'grok-v2', 'xai']);
      expect(provenanceMap['codex']).toEqual(['codex', 'cx-custom']);
      expect(provenanceMap['agy']).toEqual(['agy', 'thinking-v1']);

      const mockSchemaCode = `
        export const V3_PROVIDER_MODELS = {
          grok: 'grok-cli/grok-4.5-turbo',
          synthetic: 'glm-5.2-high',
          codex: 'codex/gpt-5.6-sol-high',
        } as const;

        export const R4_ALLOWED_MODELS = [
          'gpt-4o',
          'claude-3-5-sonnet',
          'custom-test-model',
        ];
      `;

      const parsedSchema = parseSchemaModels(mockSchemaCode);
      expect(parsedSchema.v3Models['grok']).toBe('grok-cli/grok-4.5-turbo');
      expect(parsedSchema.v3Models['synthetic']).toBe('glm-5.2-high');
      expect(parsedSchema.allowedModels).toContain('custom-test-model');
    });
  });

  describe('2. Task 2: Edge Case 1 — Dynamic Model Registration for Custom Providers', () => {
    it('dynamically registers custom models for Ollama provider and updates active models list', () => {
      const ollamaConfig = {
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        activeModels: ['llama3.3', 'qwen2.5-coder'],
        customModels: ['ollama/custom-llama-3.3-70b-instruct', 'ollama/deepseek-r1:14b'],
      };

      dashboardStore.updateProviderConfig('ollama', ollamaConfig);

      const dynamicActive = dashboardStore.getDynamicActiveModels();
      expect(dynamicActive).toContain('llama3.3');
      expect(dynamicActive).toContain('qwen2.5-coder');
      expect(dynamicActive).toContain('ollama/custom-llama-3.3-70b-instruct');
      expect(dynamicActive).toContain('ollama/deepseek-r1:14b');
    });

    it('dynamically registers custom models for Custom OpenAI provider and reflects in provider pool', () => {
      const customOpenAiConfig = {
        enabled: true,
        baseUrl: 'https://vllm-proxy.company.internal/v1',
        apiKeyRaw: 'sk-custom-vllm-secret-key-123',
        activeModels: ['custom-gpt-4o-proxy'],
        customModels: ['vllm/mistral-7b-instruct-v0.2', 'custom/llama3-70b-quantized'],
      };

      dashboardStore.updateProviderConfig('custom-openai', customOpenAiConfig);

      const dynamicActive = dashboardStore.getDynamicActiveModels();
      expect(dynamicActive).toContain('custom-gpt-4o-proxy');
      expect(dynamicActive).toContain('vllm/mistral-7b-instruct-v0.2');
      expect(dynamicActive).toContain('custom/llama3-70b-quantized');
    });

    it('excludes models from getDynamicActiveModels when custom provider is disabled', () => {
      const disabledOllama = {
        enabled: false,
        baseUrl: 'http://localhost:11434/v1',
        activeModels: ['disabled-ollama-model-1'],
        customModels: ['disabled-ollama-model-2'],
      };

      dashboardStore.updateProviderConfig('ollama', disabledOllama);

      const dynamicActive = dashboardStore.getDynamicActiveModels();
      expect(dynamicActive).not.toContain('disabled-ollama-model-1');
      expect(dynamicActive).not.toContain('disabled-ollama-model-2');

      // Re-enable provider
      dashboardStore.updateProviderConfig('ollama', { ...disabledOllama, enabled: true });
      const reenabledActive = dashboardStore.getDynamicActiveModels();
      expect(reenabledActive).toContain('disabled-ollama-model-1');
      expect(reenabledActive).toContain('disabled-ollama-model-2');
    });
  });

  describe('3. Task 2: Edge Case 2 — Validation of Active Models in validatePersonaSetting()', () => {
    it('accepts valid persona configuration with standard allowed model', () => {
      const persona = {
        id: 'security',
        displayName: 'Security Specialist',
        confidenceThreshold: 85,
        effort: 'high',
        model: 'gpt-4o',
        enabled: true,
      };

      expect(() => dashboardStore.validatePersonaSetting(persona, 'security')).not.toThrow();
    });

    it('accepts persona with dynamic model registered under enabled custom provider', () => {
      dashboardStore.updateProviderConfig('ollama', {
        enabled: true,
        activeModels: ['llama3.3'],
        customModels: ['ollama/custom-sec-evaluator'],
      });

      const persona = {
        id: 'security',
        displayName: 'Security Specialist',
        confidenceThreshold: 90,
        effort: 'xhigh',
        model: 'ollama/custom-sec-evaluator',
        enabled: true,
      };

      expect(() => dashboardStore.validatePersonaSetting(persona, 'security')).not.toThrow();
    });

    it('rejects persona with model from a disabled provider', () => {
      dashboardStore.updateProviderConfig('ollama', {
        enabled: false,
        activeModels: [],
        customModels: ['ollama/disabled-sec-model'],
      });

      const persona = {
        id: 'security',
        displayName: 'Security Specialist',
        confidenceThreshold: 90,
        effort: 'high',
        model: 'ollama/disabled-sec-model',
        enabled: true,
      };

      expect(() => dashboardStore.validatePersonaSetting(persona, 'security')).toThrow(
        "model 'ollama/disabled-sec-model' for 'security' is not an allowed model override"
      );
    });

    it('rejects persona with completely unknown / unregistered model string', () => {
      const persona = {
        id: 'security',
        displayName: 'Security Specialist',
        confidenceThreshold: 80,
        effort: 'medium',
        model: 'nonexistent-model-xyz',
        enabled: true,
      };

      expect(() => dashboardStore.validatePersonaSetting(persona, 'security')).toThrow(
        "model 'nonexistent-model-xyz' for 'security' is not an allowed model override"
      );
    });

    it('rejects invalid persona fields (confidenceThreshold, effort, enabled)', () => {
      const invalidThreshold = {
        confidenceThreshold: 150,
        effort: 'high',
        model: 'gpt-4o',
        enabled: true,
      };
      expect(() => dashboardStore.validatePersonaSetting(invalidThreshold, 'test_p')).toThrow(
        "confidenceThreshold for 'test_p' must be between 0 and 100"
      );

      const invalidEffort = {
        confidenceThreshold: 80,
        effort: 'ultra-high',
        model: 'gpt-4o',
        enabled: true,
      };
      expect(() => dashboardStore.validatePersonaSetting(invalidEffort, 'test_p')).toThrow(
        "effort for 'test_p' must be one of low, medium, high, xhigh, max"
      );

      const invalidEnabled = {
        confidenceThreshold: 80,
        effort: 'high',
        model: 'gpt-4o',
        enabled: 'yes',
      };
      expect(() => dashboardStore.validatePersonaSetting(invalidEnabled, 'test_p')).toThrow(
        "enabled for 'test_p' must be a boolean"
      );
    });
  });

  describe('4. Task 2: Edge Case 3 — Health Test Connection Response for POST /api/dashboard/providers/:id/test', () => {
    it('returns successful health connection test response for registered provider', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/openai/test')
        .set('x-api-key', apiKey)
        .send({});

      expect(res.status).toBe(200);
      expect(typeof res.body.status).toBe('string');
      expect(['connected', 'disconnected', 'error']).toContain(res.body.status);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.latencyMs).toBeGreaterThan(0);
      expect(res.body.message).toContain('OpenAI');
    });

    it('handles test request for custom Ollama provider with custom baseUrl', async () => {
      dashboardStore.updateProviderConfig('ollama', {
        id: 'ollama',
        displayName: 'Local Ollama Cluster',
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
      });

      const res = await request(app)
        .post('/api/dashboard/providers/ollama/test')
        .set('x-api-key', apiKey)
        .send({ baseUrl: 'http://localhost:11434/v1' });

      expect(res.status).toBe(200);
      expect(typeof res.body.status).toBe('string');
      expect(['connected', 'configured', 'disconnected', 'error']).toContain(res.body.status);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.message).toContain('Local Ollama Cluster');
      expect(res.body.message).toContain('http://localhost:11434/v1');
    });

    it('handles unreachable endpoint gracefully without failing HTTP response code', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/custom-openai/test')
        .set('x-api-key', apiKey)
        .send({ baseUrl: 'http://127.0.0.1:59999/v1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('disconnected');
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.latencyMs).toBeGreaterThan(0);
    });

    it('requires authentication for provider test endpoint', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/openai/test')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
