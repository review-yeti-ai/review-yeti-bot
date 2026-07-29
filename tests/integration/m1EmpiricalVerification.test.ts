import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import { createDefaultV3Config, translateCodeRabbitToV3, translateLegacyConfigToV3 } from '../../src/config/configLoader';
import { reviewsSchema } from '../../src/config/schema';
import { generateCtReviewConfig } from '../../src/onboarding/configGenerator';

describe('Milestone 1 Empirical Verification Suite - Low Effort Defaults', () => {
  const tempTestDir = path.join(process.cwd(), 'fixtures', 'tmp', 'm1-empirical-verify');

  beforeEach(() => {
    if (!fs.existsSync(tempTestDir)) {
      fs.mkdirSync(tempTestDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. Default Reviewer Personas in dashboardStore.ts', () => {
    it('verifies exactly 12 default reviewer personas exist in defaultData()', () => {
      const storeFile = path.join(tempTestDir, 'fresh-store.json');
      const store = new DashboardStore(storeFile);
      const personas = store.getPersonaSettings();
      const keys = Object.keys(personas);

      expect(keys.length).toBe(12);
      expect(keys.sort()).toEqual([
        'api_contract',
        'architecture',
        'database',
        'devops',
        'docs_compliance',
        'finops',
        'performance',
        'quality',
        'red_team',
        'reliability',
        'review_flowchart',
        'security',
      ].sort());
    });

    it('verifies every default persona has effort: "low" and effortLevel: "low"', () => {
      const storeFile = path.join(tempTestDir, 'fresh-store.json');
      const store = new DashboardStore(storeFile);
      const personas = store.getPersonaSettings();

      for (const [id, persona] of Object.entries(personas)) {
        expect(persona.effort, `Persona ${id} effort`).toBe('low');
        expect(persona.effortLevel, `Persona ${id} effortLevel`).toBe('low');
      }
    });
  });

  describe('2. Persona Resetting & Initialization', () => {
    it('verifies fresh store initialization sets effort: "low" and effortLevel: "low" for all personas', () => {
      const storeFile = path.join(tempTestDir, 'init-store.json');
      const store = new DashboardStore(storeFile);
      const allPersonas = store.getPersonaSettings();

      Object.values(allPersonas).forEach((p) => {
        expect(p.effort).toBe('low');
        expect(p.effortLevel).toBe('low');
      });
    });

    it('verifies updating standard persona without specifying effort preserves or receives "low" effort', () => {
      const storeFile = path.join(tempTestDir, 'update-store.json');
      const store = new DashboardStore(storeFile);

      // Update persona setting without effort patch
      const updated = store.updatePersonaSetting('security', {
        displayName: 'Custom Security Guardian',
      });

      expect(updated.effort).toBe('low');
      expect(updated.effortLevel).toBe('low');

      // Verify stored persona
      const retrieved = store.getPersonaSetting('security');
      expect(retrieved?.effort).toBe('low');
      expect(retrieved?.effortLevel).toBe('low');
    });

    it('verifies updating settings initializes personas with "low" effort defaults', () => {
      const storeFile = path.join(tempTestDir, 'update-settings-store.json');
      const store = new DashboardStore(storeFile);

      const updatedSettings = store.updateSettings({
        personaSettings: {
          architecture: {
            id: 'architecture',
            displayName: 'Updated Architecture',
            enabled: true,
            model: 'grok-cli/grok-4.5',
            effort: 'low',
            confidenceThreshold: 75,
            description: 'Arch test',
          },
        },
      });

      expect(updatedSettings.personaSettings?.architecture?.effort).toBe('low');
    });
  });

  describe('3. Config Loader, Schema Validator & YAML Generator Defaults', () => {
    it('verifies createDefaultV3Config() defaults reviewer_effort and all provider efforts to "low"', () => {
      const config = createDefaultV3Config();

      expect(config.reviews.reviewer_effort).toBe('low');
      expect(config.reviewers.providers.length).toBeGreaterThan(0);
      for (const provider of config.reviewers.providers) {
        expect(provider.effort, `Provider ${provider.id} effort`).toBe('low');
      }
    });

    it('verifies translateCodeRabbitToV3 defaults reviewer_effort to "low" when omitted or invalid', () => {
      const configOmitted = translateCodeRabbitToV3({});
      expect(configOmitted.reviews.reviewer_effort).toBe('low');
      expect(configOmitted.reviewer_effort).toBe('low');
      expect(configOmitted.reviewers.providers[0].effort).toBe('low');

      const configInvalid = translateCodeRabbitToV3({ reviews: { reviewer_effort: 'invalid_tier' } });
      expect(configInvalid.reviews.reviewer_effort).toBe('low');
      expect(configInvalid.reviewer_effort).toBe('low');
    });

    it('verifies translateLegacyConfigToV3 defaults reviewer_effort to "low"', () => {
      const config = translateLegacyConfigToV3({});
      expect(config.reviewer_effort).toBe('low');
      expect(config.reviews.reviewer_effort).toBe('low');
    });

    it('verifies reviewsSchema validator defaults reviewer_effort to "low"', () => {
      const parsed = reviewsSchema.parse({});
      expect(parsed.reviewer_effort).toBe('low');
    });

    it('verifies YAML generator (generateCtReviewConfig) defaults reviewer_effort and provider efforts to "low"', () => {
      const { yamlText, config } = generateCtReviewConfig({});

      expect(config.reviews.reviewer_effort).toBe('low');
      for (const provider of config.reviewers.providers) {
        expect(provider.effort, `Generated provider ${provider.id} effort`).toBe('low');
      }

      expect(yamlText).toContain('reviewer_effort: low');
      expect(yamlText).toContain('effort: low');
      expect(yamlText).not.toMatch(/reviewer_effort:\s*(medium|high|xhigh|max)/);
    });
  });
});
