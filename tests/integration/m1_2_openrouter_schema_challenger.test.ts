import { describe, it, expect } from 'vitest';
import {
  R4_ALLOWED_MODELS,
  V3_PROVIDER_MODELS,
  WELL_KNOWN_PROVIDER_IDS,
  ProviderIdEnum,
  providerSchema,
  personaSchema,
  ctReviewConfigV3Schema,
} from '../../src/config/schema';
import { sanitizeV3Config, ConfigValidationError } from '../../src/config/configLoader';

describe('Milestone 1 (R4) — OpenRouter Default Model & Schema Validation Stress Test', () => {

  describe('1. R4_ALLOWED_MODELS & V3_PROVIDER_MODELS Constant Inspections', () => {
    it('contains openrouter/auto in R4_ALLOWED_MODELS', () => {
      expect(R4_ALLOWED_MODELS).toContain('openrouter/auto');
    });

    it('verifies openrouter/auto is the first entry in R4_ALLOWED_MODELS', () => {
      expect(R4_ALLOWED_MODELS[0]).toBe('openrouter/auto');
    });

    it('validates structure and contents of R4_ALLOWED_MODELS', () => {
      expect(Array.isArray(R4_ALLOWED_MODELS)).toBe(true);
      expect(R4_ALLOWED_MODELS.length).toBeGreaterThan(20);
      R4_ALLOWED_MODELS.forEach((model) => {
        expect(typeof model).toBe('string');
        expect(model.trim()).toBe(model);
        expect(model.length).toBeGreaterThan(0);
      });
    });

    it('validates V3_PROVIDER_MODELS structure and values', () => {
      expect(V3_PROVIDER_MODELS).toEqual({
        synthetic: 'glm-5.2',
        'synthetic.new': 'synthetic-new/glm-5.2-high',
        codex: 'codex/gpt-5.6-sol-high',
        grok: 'grok-cli/grok-4.5',
        'agy-opus': 'agy/claude-opus-4-6-thinking',
        claude: 'claude/claude-opus-4-8',
        opencode: 'opencode-go/glm-5.2',
      });
    });

    it('verifies WELL_KNOWN_PROVIDER_IDS matches V3_PROVIDER_MODELS keys', () => {
      expect(WELL_KNOWN_PROVIDER_IDS).toEqual(Object.keys(V3_PROVIDER_MODELS));
    });
  });

  describe('2. OpenRouter Default Model Clean Validation Pass', () => {
    const openrouterModel = 'openrouter/google/gemini-2.0-flash-lite-001';

    it('personaSchema validates persona override using openrouter model', () => {
      const persona = {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**'],
        providers: ['openrouter'],
        model: openrouterModel,
      };
      const result = personaSchema.safeParse(persona);
      expect(result.success).toBe(true);
    });

    it('providerSchema validates provider using openrouter model', () => {
      const provider = {
        id: 'openrouter',
        enabled: true,
        model: openrouterModel,
        effort: 'low',
        review_timeout_s: 120,
        arbiter_timeout_s: 120,
      };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });

    it('ctReviewConfigV3Schema validates full config with openrouter provider and persona model override', () => {
      const config = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        personas: [
          {
            id: 'sec-lane',
            enabled: true,
            required: true,
            charter: 'builtin:security',
            paths: ['**'],
            providers: ['openrouter'],
            model: openrouterModel,
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 300,
          providers: [
            {
              id: 'openrouter',
              enabled: true,
              model: openrouterModel,
              effort: 'low',
              review_timeout_s: 120,
              arbiter_timeout_s: 120,
            },
          ],
          arbiter: { order: ['openrouter'] },
        },
      };
      const result = ctReviewConfigV3Schema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('sanitizeV3Config accepts openrouter model for openrouter provider and personas', () => {
      const rawConfig = {
        version: 3,
        quorum: 1,
        personas: [
          {
            id: 'sec-lane',
            enabled: true,
            required: true,
            charter: 'builtin:security',
            paths: ['**'],
            providers: ['openrouter'],
            model: openrouterModel,
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 300,
          providers: [
            {
              id: 'openrouter',
              enabled: true,
              model: openrouterModel,
              effort: 'low',
              review_timeout_s: 120,
              arbiter_timeout_s: 120,
            },
          ],
          arbiter: { order: ['openrouter'] },
        },
      };
      const sanitized = sanitizeV3Config(rawConfig);
      expect(sanitized.personas[0].model).toBe(openrouterModel);
      expect(sanitized.reviewers.providers[0].model).toBe(openrouterModel);
    });
  });

  describe('3. Validation Rejection of Invalid Model Strings & Inputs', () => {
    const invalidModels = [
      'invalid-model-string',
      'invalid-openrouter/gemini-2.0',
      'completely-fake-openrouter-model',
      'completely-fake-gemini',
    ];

    invalidModels.forEach((invalidModel) => {
      it(`personaSchema rejects invalid model string: "${invalidModel}"`, () => {
        const persona = {
          id: 'sec-lane',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['**'],
          providers: ['openrouter'],
          model: invalidModel,
        };
        const result = personaSchema.safeParse(persona);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain('is not in R4_ALLOWED_MODELS');
        }
      });

      it(`providerSchema rejects invalid model string: "${invalidModel}"`, () => {
        const provider = {
          id: 'openrouter',
          enabled: true,
          model: invalidModel,
          effort: 'low',
          review_timeout_s: 120,
          arbiter_timeout_s: 120,
        };
        const result = providerSchema.safeParse(provider);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain('must use exact allowlisted model');
        }
      });
    });

    it('providerSchema rejects empty string model', () => {
      const provider = {
        id: 'openrouter',
        enabled: true,
        model: '',
        effort: 'low',
        review_timeout_s: 120,
        arbiter_timeout_s: 120,
      };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('personaSchema rejects non-string model types', () => {
      [12345, true, {}, []].forEach((badModel) => {
        const persona = {
          id: 'sec-lane',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['**'],
          providers: ['openrouter'],
          model: badModel,
        };
        const result = personaSchema.safeParse(persona);
        expect(result.success).toBe(false);
      });
    });

    it('sanitizeV3Config throws ConfigValidationError on unknown unsupported persona model', () => {
      const rawConfig = {
        version: 3,
        quorum: 1,
        personas: [
          {
            id: 'sec-lane',
            enabled: true,
            required: true,
            charter: 'builtin:security',
            paths: ['**'],
            providers: ['synthetic'],
            model: 'unsupported_model_without_prefix',
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 300,
          providers: [
            {
              id: 'synthetic',
              enabled: true,
              model: 'glm-5.2',
              effort: 'low',
              review_timeout_s: 120,
              arbiter_timeout_s: 120,
            },
          ],
          arbiter: { order: ['synthetic'] },
        },
      };
      expect(() => sanitizeV3Config(rawConfig)).toThrow(ConfigValidationError);
    });

    it('ProviderIdEnum rejects invalid provider IDs', () => {
      const invalidIds = ['123startwithnumber', 'UPPERCASE', 'has spaces', 'invalid@symbol', '_startwithunderscore'];
      invalidIds.forEach((badId) => {
        const result = ProviderIdEnum.safeParse(badId);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('4. Additional Allowed R4 Models Validation', () => {
    it('personaSchema validates all models present in R4_ALLOWED_MODELS', () => {
      R4_ALLOWED_MODELS.forEach((model) => {
        const persona = {
          id: 'test-lane',
          enabled: true,
          required: true,
          charter: 'builtin:correctness',
          paths: ['**'],
          providers: ['synthetic'],
          model: model,
        };
        const result = personaSchema.safeParse(persona);
        expect(result.success, `Model '${model}' should pass personaSchema validation`).toBe(true);
      });
    });
  });
});
