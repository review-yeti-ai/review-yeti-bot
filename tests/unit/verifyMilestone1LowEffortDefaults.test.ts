import { describe, it, expect } from 'vitest';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { createDefaultV3Config, translateCodeRabbitToV3, translateLegacyConfigToV3 } from '../../src/config/configLoader';
import { reviewsSchema } from '../../src/config/schema';
import { generateCtReviewConfig } from '../../src/onboarding/configGenerator';
import { TokenBudgetManager, evaluateEffortAndBudget } from '../../src/pipeline/tokenBudgetManager';
import path from 'path';
import os from 'os';

describe('Milestone 1 Verification: Universal Low Effort Defaults', () => {
  const all12Personas = [
    'security',
    'architecture',
    'performance',
    'quality',
    'database',
    'api_contract',
    'docs_compliance',
    'reliability',
    'devops',
    'finops',
    'red_team',
    'review_flowchart',
  ];

  it('1. dashboardStore defaultData() initializes all 12 reviewer personas with low effort', () => {
    const cleanStorePath = path.join(os.tmpdir(), `test-m1-clean-${Date.now()}.json`);
    const cleanStore = new DashboardStore(cleanStorePath);
    const personas = cleanStore.getPersonaSettings();
    all12Personas.forEach((id) => {
      const persona = personas[id];
      expect(persona, `Persona '${id}' must be defined`).toBeDefined();
      expect(persona.effort, `Persona '${id}' effort must be 'low'`).toBe('low');
      expect(persona.effortLevel, `Persona '${id}' effortLevel must be 'low'`).toBe('low');
    });
  });

  it('2. reviewsSchema defaults reviewer_effort to low', () => {
    const parsed = reviewsSchema.parse({});
    expect(parsed.reviewer_effort).toBe('low');
  });

  it('3. createDefaultV3Config() sets reviewer_effort and provider efforts to low', () => {
    const config = createDefaultV3Config();
    expect(config.reviews.reviewer_effort).toBe('low');
    config.reviewers.providers.forEach((p) => {
      expect(p.effort, `Provider '${p.id}' effort must be 'low'`).toBe('low');
    });
  });

  it('4. translateCodeRabbitToV3 and translateLegacyConfigToV3 fall back to low effort', () => {
    const crConfig = translateCodeRabbitToV3({});
    expect(crConfig.reviewer_effort).toBe('low');
    expect(crConfig.reviews.reviewer_effort).toBe('low');

    const legacyConfig = translateLegacyConfigToV3({});
    expect(legacyConfig.reviewer_effort).toBe('low');
  });

  it('5. generateCtReviewConfig() sets reviewer_effort and provider efforts to low', () => {
    // `personas`/`pathFilters` are not part of ConfigGenerationOptions (the real
    // fields are selectedPersonaIds/customPathFilters); omit them so the
    // generator falls back to its defaults exactly as this fixture always
    // exercised at runtime, rather than silently forcing empty overrides.
    const generated = generateCtReviewConfig({
      profile: 'balanced',
      ticketEnforcement: false,
    });
    expect(generated.config.reviews.reviewer_effort).toBe('low');
    generated.config.reviewers.providers.forEach((p) => {
      expect(p.effort, `Generated provider '${p.id}' effort must be 'low'`).toBe('low');
    });
  });

  it('6. TokenBudgetManager defaults to low effort tier', () => {
    const budgetManager = new TokenBudgetManager();
    const budget = budgetManager.calculateBudget({});
    expect(budget.effortTier).toBe('low');
    expect(budget.providerEffortSetting).toBe('low');

    const evaluated = evaluateEffortAndBudget([]);
    expect(evaluated.effortTier).toBe('low');
    expect(evaluated.providerEffortSetting).toBe('low');
  });
});
