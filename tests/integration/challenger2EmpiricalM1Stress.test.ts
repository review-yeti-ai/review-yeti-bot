import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from '../../src/app';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import {
  personaSchema,
  providerSchema,
  ctReviewConfigV3Schema,
  R4_ALLOWED_MODELS,
  V3_PROVIDER_MODELS,
} from '../../src/config/schema';

describe('Challenger 2 — Milestone 1: Schema Validation & Model Ensemble Mapping Stress Suite', () => {
  const tempTestDir = path.join(process.cwd(), 'data', 'test-challenger-m1-2');
  let app: any;
  let validApiKey: string;

  beforeEach(() => {
    if (!fs.existsSync(tempTestDir)) {
      fs.mkdirSync(tempTestDir, { recursive: true });
    }
    app = createApp();
    const createdKey = dashboardStore.createApiKey('challenger2-m1-key');
    validApiKey = createdKey.rawKey;
  });

  afterEach(() => {
    if (fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. Persona Model Ensemble Mapping Integrity (All 11 Personas)', () => {
    const elevenPersonas = [
      'security',
      'architecture',
      'performance',
      'quality',
      'database',
      'api_contract',
      'reliability',
      'devops',
      'docs_compliance',
      'finops',
      'red_team',
    ];

    it('retrieves all 11 reviewer personas with valid initial model ensemble mappings', () => {
      const personas = dashboardStore.getPersonaSettings();
      elevenPersonas.forEach((id) => {
        const persona = personas[id];
        expect(persona, `Persona '${id}' must be defined`).toBeDefined();
        expect(persona.id).toBe(id);
        expect(persona.model || persona.modelId).toBeDefined();
        expect(persona.providerId).toBeDefined();
        expect(persona.effort || persona.effortLevel).toBeDefined();
        expect(typeof persona.confidenceThreshold).toBe('number');
        expect(persona.confidenceThreshold).toBeGreaterThanOrEqual(0);
        expect(persona.confidenceThreshold).toBeLessThanOrEqual(100);
      });
    });

    it('stress-tests updating model ensemble mappings for all 11 personas with various allowed models', () => {
      const testStoreFile = path.join(tempTestDir, 'persona-ensemble-store.json');
      const store = new DashboardStore(testStoreFile);

      const modelMatrix: Array<{ model: string; providerId: string }> = [
        { model: 'claude-3-5-sonnet', providerId: 'anthropic' },
        { model: 'claude-3-7-sonnet', providerId: 'anthropic' },
        { model: 'claude-opus-4-8', providerId: 'anthropic' },
        { model: 'gpt-4o', providerId: 'openai' },
        { model: 'gpt-4o-mini', providerId: 'openai' },
        { model: 'deepseek-v3', providerId: 'deepseek' },
        { model: 'glm-5.2', providerId: 'glm' },
        { model: 'grok-cli/grok-4.5', providerId: 'grok' },
        { model: 'codex/gpt-5.6-sol-high', providerId: 'codex' },
        { model: 'agy/claude-opus-4-6-thinking', providerId: 'agy' },
        { model: 'synthetic/v1', providerId: 'synthetic' },
      ];

      elevenPersonas.forEach((personaId, idx) => {
        const mapping = modelMatrix[idx % modelMatrix.length];
        const updated = store.updatePersonaSetting(personaId, {
          model: mapping.model,
          modelId: mapping.model,
          providerId: mapping.providerId,
          effort: (['low', 'medium', 'high', 'xhigh', 'max'] as const)[idx % 5],
          confidenceThreshold: 50 + (idx * 4),
        });

        expect(updated.id).toBe(personaId);
        expect(updated.model).toBe(mapping.model);
        expect(updated.providerId).toBe(mapping.providerId);
      });

      // Verify persistence across new store instance reload
      const reloadedStore = new DashboardStore(testStoreFile);
      const reloadedPersonas = reloadedStore.getPersonaSettings();

      elevenPersonas.forEach((personaId, idx) => {
        const expectedMapping = modelMatrix[idx % modelMatrix.length];
        const persona = reloadedPersonas[personaId];
        expect(persona.model).toBe(expectedMapping.model);
        expect(persona.providerId).toBe(expectedMapping.providerId);
      });
    });

    it('mirrors changes between documentation and docs_compliance persona aliases', () => {
      const testStoreFile = path.join(tempTestDir, 'docs-mirror-store.json');
      const store = new DashboardStore(testStoreFile);

      // Update documentation persona
      store.updatePersonaSetting('documentation', {
        model: 'gpt-4o',
        effort: 'high',
        confidenceThreshold: 88,
      });

      const personas1 = store.getPersonaSettings();
      expect(personas1.docs_compliance.model).toBe('gpt-4o');
      expect(personas1.docs_compliance.effort).toBe('high');
      expect(personas1.docs_compliance.confidenceThreshold).toBe(88);

      // Update docs_compliance persona
      store.updatePersonaSetting('docs_compliance', {
        model: 'claude-3-5-sonnet',
        effort: 'low',
        confidenceThreshold: 65,
      });

      const personas2 = store.getPersonaSettings();
      expect(personas2.documentation.model).toBe('claude-3-5-sonnet');
      expect(personas2.documentation.effort).toBe('low');
      expect(personas2.documentation.confidenceThreshold).toBe(65);
    });

    it('allows assigning dynamic custom models registered in provider config to personas', () => {
      const testStoreFile = path.join(tempTestDir, 'custom-model-store.json');
      const store = new DashboardStore(testStoreFile);

      // Register custom model on openai provider
      store.updateProviderConfig('openai', {
        enabled: true,
        activeModels: ['gpt-4o', 'custom-fine-tuned-v1'],
      });

      // Confirm dynamic active models includes custom model
      const activeModels = store.getDynamicActiveModels();
      expect(activeModels).toContain('custom-fine-tuned-v1');

      // Update security persona with custom model
      const updated = store.updatePersonaSetting('security', {
        model: 'custom-fine-tuned-v1',
      });
      expect(updated.model).toBe('custom-fine-tuned-v1');
    });

    it('rejects unallowed/unregistered model override during persona update', () => {
      const testStoreFile = path.join(tempTestDir, 'invalid-model-store.json');
      const store = new DashboardStore(testStoreFile);

      expect(() => {
        store.updatePersonaSetting('security', {
          model: 'unknown-non-allowlisted-model-xyz',
        });
      }).toThrow(/not an allowed model override/);
    });

    it('rejects invalid persona effort level', () => {
      const testStoreFile = path.join(tempTestDir, 'invalid-effort-store.json');
      const store = new DashboardStore(testStoreFile);

      expect(() => {
        store.updatePersonaSetting('security', {
          effort: 'ultra-mega' as any,
        });
      }).toThrow(/effort for 'security' must be one of low, medium, high, xhigh, max/);
    });

    it('rejects invalid confidence threshold out of bounds (<0 or >100)', () => {
      const testStoreFile = path.join(tempTestDir, 'invalid-confidence-store.json');
      const store = new DashboardStore(testStoreFile);

      expect(() => {
        store.updatePersonaSetting('security', {
          confidenceThreshold: 150,
        });
      }).toThrow(/confidenceThreshold for 'security' must be between 0 and 100/);

      expect(() => {
        store.updatePersonaSetting('security', {
          confidenceThreshold: -5,
        });
      }).toThrow(/confidenceThreshold for 'security' must be between 0 and 100/);
    });

    it('rejects updating non-existent persona ID', () => {
      const testStoreFile = path.join(tempTestDir, 'nonexistent-persona-store.json');
      const store = new DashboardStore(testStoreFile);

      expect(() => {
        store.updatePersonaSetting('ghost-persona-id', {
          model: 'gpt-4o',
        });
      }).toThrow(/Persona 'ghost-persona-id' not found/);
    });

    it('tests HTTP API PATCH /api/dashboard/settings/personas/:personaId for all 11 personas', async () => {
      for (let i = 0; i < elevenPersonas.length; i++) {
        const personaId = elevenPersonas[i];
        const res = await request(app)
          .patch(`/api/dashboard/settings/personas/${personaId}`)
          .set('x-api-key', validApiKey)
          .send({
            model: 'gpt-4o',
            effort: 'medium',
            confidenceThreshold: 75 + (i % 20),
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.persona.id).toBe(personaId);
        expect(res.body.persona.model).toBe('gpt-4o');
      }
    });
  });

  describe('2. Subscription Tiers Validation & Persistence Stress Suite', () => {
    const requiredProviders = [
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

    const validTiers = ['Free', 'Pay-as-you-go', 'Pro', 'Team', 'Enterprise'] as const;

    it('validates initial subscription tiers for all 11 provider configurations', () => {
      const configs = dashboardStore.getProviderConfigs();
      requiredProviders.forEach((id) => {
        const cfg = configs[id];
        expect(cfg, `Provider '${id}' configuration should exist`).toBeDefined();
        expect(validTiers).toContain(cfg.subscriptionTier);
      });
    });

    it('stress-tests setting all subscription tiers (uppercase & lowercase) across all 11 providers', async () => {
      const testStoreFile = path.join(tempTestDir, 'subscription-tiers-store.json');
      const store = new DashboardStore(testStoreFile);

      const testTiers = [
        'Free',
        'free',
        'Pay-as-you-go',
        'pay-as-you-go',
        'Pro',
        'pro',
        'Team',
        'team',
        'Enterprise',
        'enterprise',
      ];

      requiredProviders.forEach((providerId) => {
        testTiers.forEach((tierInput) => {
          const updated = store.updateProviderConfig(providerId, {
            subscriptionTier: tierInput as any,
          });

          // Normalization check: lowercase tier inputs must be capitalized
          const expectedTier =
            tierInput.toLowerCase() === 'free'
              ? 'Free'
              : tierInput.toLowerCase() === 'pay-as-you-go'
              ? 'Pay-as-you-go'
              : tierInput.toLowerCase() === 'pro'
              ? 'Pro'
              : tierInput.toLowerCase() === 'team'
              ? 'Team'
              : 'Enterprise';

          expect(updated.subscriptionTier).toBe(expectedTier);
        });
      });

      // Verify persistence to disk across store instance reloads
      const reloadedStore = new DashboardStore(testStoreFile);
      const reloadedConfigs = reloadedStore.getProviderConfigs();

      requiredProviders.forEach((providerId) => {
        const cfg = reloadedConfigs[providerId];
        expect(validTiers).toContain(cfg.subscriptionTier);
      });
    }, 15000);

    it('tests HTTP API PUT /api/dashboard/providers/:id with subscriptionTier updates', async () => {
      for (const tier of validTiers) {
        const res = await request(app)
          .put('/api/dashboard/providers/openai')
          .set('x-api-key', validApiKey)
          .send({ subscriptionTier: tier });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.provider.subscriptionTier).toBe(tier);
      }
    });
  });

  describe('3. Zod Schema Integrity & Edge Cases', () => {
    it('verifies R4_ALLOWED_MODELS exports expected core models', () => {
      expect(R4_ALLOWED_MODELS).toContain('claude-5-sonnet');
      expect(R4_ALLOWED_MODELS).toContain('gpt-5.6-sol');
      expect(R4_ALLOWED_MODELS).toContain('deepseek-v4-pro');
      expect(R4_ALLOWED_MODELS).toContain('glm-5.2');
      expect(R4_ALLOWED_MODELS).toContain('claude-3-7-sonnet');
      expect(R4_ALLOWED_MODELS).toContain('claude-3-5-sonnet');
    });

    it('verifies V3_PROVIDER_MODELS exports correct provider default mappings', () => {
      expect(V3_PROVIDER_MODELS.synthetic).toBe('glm-5.2');
      expect(V3_PROVIDER_MODELS.codex).toBe('codex/gpt-5.6-sol-high');
      expect(V3_PROVIDER_MODELS.grok).toBe('grok-cli/grok-4.5');
      expect(V3_PROVIDER_MODELS['agy-opus']).toBe('agy/claude-opus-4-6-thinking');
      expect(V3_PROVIDER_MODELS.claude).toBe('claude/claude-opus-4-8');
    });

    it('personaSchema validates valid persona objects', () => {
      const valid = personaSchema.safeParse({
        id: 'security-audit-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
        model: 'claude-3-5-sonnet',
        effort: 'high',
      });
      expect(valid.success).toBe(true);
    });

    it('personaSchema rejects invalid persona models not in R4_ALLOWED_MODELS', () => {
      const invalid = personaSchema.safeParse({
        id: 'security-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
        model: 'completely-fake-unsupported-model',
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0].message).toContain('not in R4_ALLOWED_MODELS');
      }
    });

    it('providerSchema rejects unknown model for provider not in R4_ALLOWED_MODELS or V3_PROVIDER_MODELS', () => {
      const res = providerSchema.safeParse({
        id: 'claude',
        enabled: true,
        model: 'invalid-model-name',
        effort: 'medium',
        review_timeout_s: 30,
        arbiter_timeout_s: 30,
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain('must use exact allowlisted model');
      }
    });

    it('ctReviewConfigV3Schema rejects duplicate provider entries in reviewers.providers', () => {
      const config = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        personas: [
          { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 60,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude'] },
        },
      };

      const res = ctReviewConfigV3Schema.safeParse(config);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain('provider ids must be unique');
      }
    });
  });
});
