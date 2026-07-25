import { describe, it, expect } from 'vitest';
import {
  V3_PROVIDER_MODELS,
  R4_ALLOWED_MODELS,
  providerSchema,
  personaSchema,
  ctReviewConfigV3Schema,
} from '../../src/config/schema';

describe('schema.ts — Comprehensive Unit Expansion Tests', () => {
  it('V3_PROVIDER_MODELS exports expected default provider-to-model mappings', () => {
    expect(V3_PROVIDER_MODELS.codex).toBe('codex/gpt-5.6-sol-high');
    expect(V3_PROVIDER_MODELS.grok).toBe('grok-cli/grok-4.5');
    expect(V3_PROVIDER_MODELS['agy-opus']).toBe('agy/claude-opus-4-6-thinking');
    expect(V3_PROVIDER_MODELS.claude).toBe('claude/claude-opus-4-8');
  });

  it('R4_ALLOWED_MODELS includes required 4-persona models', () => {
    expect(R4_ALLOWED_MODELS).toContain('claude-5-sonnet');
    expect(R4_ALLOWED_MODELS).toContain('gpt-5.6-sol');
    expect(R4_ALLOWED_MODELS).toContain('deepseek-v4-pro');
    expect(R4_ALLOWED_MODELS).toContain('glm-5.2');
  });

  it('providerSchema validates default or R4_ALLOWED_MODELS model names', () => {
    const validR4 = providerSchema.safeParse({
      id: 'claude',
      enabled: true,
      model: 'claude-5-sonnet',
      effort: 'high',
      review_timeout_s: 30,
      arbiter_timeout_s: 30,
    });
    expect(validR4.success).toBe(true);

    const invalidModel = providerSchema.safeParse({
      id: 'claude',
      enabled: true,
      model: 'unsupported-custom-model-x',
      effort: 'high',
      review_timeout_s: 30,
      arbiter_timeout_s: 30,
    });
    expect(invalidModel.success).toBe(false);
  });

  it('providerSchema accepts all valid effort levels', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const effort of efforts) {
      const res = providerSchema.safeParse({
        id: 'codex',
        enabled: true,
        model: V3_PROVIDER_MODELS.codex,
        effort,
        review_timeout_s: 10,
        arbiter_timeout_s: 10,
      });
      expect(res.success).toBe(true);
    }
  });

  it('personaSchema validates persona ID format regex (lowercase, alphanumeric, hyphens)', () => {
    const valid = personaSchema.safeParse({
      id: 'valid-persona-name-123',
      enabled: true,
      required: true,
      charter: 'builtin:security',
      paths: ['**'],
      providers: ['claude'],
    });
    expect(valid.success).toBe(true);

    const invalidCaps = personaSchema.safeParse({
      id: 'InvalidCaps',
      enabled: true,
      required: true,
      charter: 'builtin:security',
      paths: ['**'],
      providers: ['claude'],
    });
    expect(invalidCaps.success).toBe(false);
  });

  it('personaSchema validates built-in charters vs custom charters (min 12 chars)', () => {
    const validCustom = personaSchema.safeParse({
      id: 'custom-lane',
      enabled: true,
      required: true,
      charter: 'This is a custom charter description that is long enough.',
      paths: ['**'],
      providers: ['claude'],
    });
    expect(validCustom.success).toBe(true);

    const shortCustom = personaSchema.safeParse({
      id: 'custom-lane',
      enabled: true,
      required: true,
      charter: 'Too short',
      paths: ['**'],
      providers: ['claude'],
    });
    expect(shortCustom.success).toBe(false);
  });

  it('ctReviewConfigV3Schema rejects duplicate persona IDs', () => {
    const config = {
      version: 3,
      profile: 'balanced',
      quorum: 1,
      personas: [
        { id: 'dup-id', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        { id: 'dup-id', enabled: true, required: false, charter: 'builtin:correctness', paths: ['**'], providers: ['claude'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'ordered',
        overall_timeout_s: 60,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
    };

    const res = ctReviewConfigV3Schema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toContain('persona ids must be unique');
    }
  });

  it('ctReviewConfigV3Schema rejects config when quorum exceeds enabled providers count', () => {
    const config = {
      version: 3,
      profile: 'balanced',
      quorum: 3, // Only 1 provider enabled!
      personas: [
        { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'ordered',
        overall_timeout_s: 60,
        providers: [
          { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        ],
        arbiter: { order: ['claude'] },
      },
    };

    const res = ctReviewConfigV3Schema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toContain('quorum exceeds enabled distinct providers');
    }
  });
});
