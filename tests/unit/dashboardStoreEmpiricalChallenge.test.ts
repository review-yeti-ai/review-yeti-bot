import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';

describe('Empirical Challenge: DashboardStore OpenRouter Default Model Configuration (R4)', () => {
  const tmpDir = path.join(process.cwd(), 'fixtures/tmp');
  const testStoreFile = path.join(tmpDir, 'test_r4_empirical_store.json');
  let store: DashboardStore;

  const EXPECTED_DEFAULT_MODEL = 'openrouter/google/gemini-2.0-flash-lite-001';
  const EXPECTED_DEFAULT_PROVIDER = 'openrouter';

  const STANDARD_PERSONA_IDS = [
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

  const ALIAS_MAPPINGS: Record<string, string> = {
    documentation: 'docs_compliance',
    linear_sync: 'finops',
    ux_product: 'red_team',
    'sec-lane': 'security',
    'arch-lane': 'architecture',
    'qual-lane': 'quality',
    'correctness-lane': 'quality',
    'contract-lane': 'api_contract',
    'policy-lane': 'reliability',
    'perf-lane': 'performance',
    'db-lane': 'database',
    'finops-lane': 'finops',
    'docs-lane': 'docs_compliance',
    'devops-lane': 'devops',
    'redteam-lane': 'red_team',
    'flowchart-lane': 'review_flowchart',
  };

  const cleanup = () => {
    if (fs.existsSync(testStoreFile)) {
      try { fs.unlinkSync(testStoreFile); } catch {}
    }
  };

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('1. Default Persona Initialization', () => {
    it('initializes all 12 standard personas with openrouter/google/gemini-2.0-flash-lite-001', () => {
      store = new DashboardStore(testStoreFile);
      const personas = store.getPersonaSettings();

      expect(Object.keys(personas).length).toBeGreaterThanOrEqual(12);

      for (const id of STANDARD_PERSONA_IDS) {
        const persona = personas[id];
        expect(persona, `Persona '${id}' should exist`).toBeDefined();
        expect(persona.model, `Persona '${id}' model must be default model`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(persona.modelId, `Persona '${id}' modelId must be default model`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(persona.providerId, `Persona '${id}' providerId must be openrouter`).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('returns openrouter/google/gemini-2.0-flash-lite-001 for individual getPersonaSetting queries', () => {
      store = new DashboardStore(testStoreFile);

      for (const id of STANDARD_PERSONA_IDS) {
        const persona = store.getPersonaSetting(id);
        expect(persona, `getPersonaSetting('${id}') should return persona`).toBeDefined();
        expect(persona!.model, `getPersonaSetting('${id}').model`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(persona!.modelId, `getPersonaSetting('${id}').modelId`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(persona!.providerId, `getPersonaSetting('${id}').providerId`).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('returns openrouter/google/gemini-2.0-flash-lite-001 for all alias persona lookups', () => {
      store = new DashboardStore(testStoreFile);

      for (const [alias, targetId] of Object.entries(ALIAS_MAPPINGS)) {
        const persona = store.getPersonaSetting(alias);
        expect(persona, `Alias '${alias}' should resolve to a valid persona`).toBeDefined();
        expect(persona!.model, `Alias '${alias}' model should be default model`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(persona!.modelId, `Alias '${alias}' modelId should be default model`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(persona!.providerId, `Alias '${alias}' providerId should be openrouter`).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });
  });

  describe('2. Hydration & Resilience under Corrupted/Partial File States', () => {
    it('recovers gracefully from corrupted JSON backing file and loads default models', () => {
      fs.writeFileSync(testStoreFile, '{ invalid json content !!!', 'utf8');
      store = new DashboardStore(testStoreFile);

      const personas = store.getPersonaSettings();
      for (const id of STANDARD_PERSONA_IDS) {
        expect(personas[id].model).toBe(EXPECTED_DEFAULT_MODEL);
        expect(personas[id].providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('hydrates empty JSON file ({}) with default OpenRouter persona settings', () => {
      fs.writeFileSync(testStoreFile, '{}', 'utf8');
      store = new DashboardStore(testStoreFile);

      const personas = store.getPersonaSettings();
      for (const id of STANDARD_PERSONA_IDS) {
        expect(personas[id].model).toBe(EXPECTED_DEFAULT_MODEL);
        expect(personas[id].providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('hydrates partial settings object without personaSettings with defaults', () => {
      fs.writeFileSync(testStoreFile, JSON.stringify({ settings: { defaultMaxTurns: 15 } }), 'utf8');
      store = new DashboardStore(testStoreFile);

      const personas = store.getPersonaSettings();
      for (const id of STANDARD_PERSONA_IDS) {
        expect(personas[id].model).toBe(EXPECTED_DEFAULT_MODEL);
        expect(personas[id].providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('merges missing persona properties when loaded file contains sparse persona entries', () => {
      const sparseData = {
        settings: {
          personaSettings: {
            security: { customPrompt: 'Custom prompt only' },
            quality: { enabled: true },
          },
        },
      };
      fs.writeFileSync(testStoreFile, JSON.stringify(sparseData), 'utf8');
      store = new DashboardStore(testStoreFile);

      const personas = store.getPersonaSettings();
      expect(personas.security.model).toBe(EXPECTED_DEFAULT_MODEL);
      expect(personas.security.providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
      expect(personas.security.customPrompt).toBe('Custom prompt only');

      expect(personas.quality.model).toBe(EXPECTED_DEFAULT_MODEL);
      expect(personas.quality.providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
    });

    it('handles loaded persona entry missing model/modelId by falling back to default data model', () => {
      const emptyModelData = {
        settings: {
          personaSettings: {
            performance: { enabled: true }, // no model or modelId specified
          },
        },
      };
      fs.writeFileSync(testStoreFile, JSON.stringify(emptyModelData), 'utf8');
      store = new DashboardStore(testStoreFile);

      const persona = store.getPersonaSetting('performance');
      expect(persona!.model).toBe(EXPECTED_DEFAULT_MODEL);
      expect(persona!.modelId).toBe(EXPECTED_DEFAULT_MODEL);
      expect(persona!.providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
    });
  });

  describe('3. Store Resets & Fallback Functions', () => {
    it('restores default OpenRouter model after backing file deletion and store re-initialization', () => {
      store = new DashboardStore(testStoreFile);
      expect(fs.existsSync(testStoreFile)).toBe(true);

      fs.unlinkSync(testStoreFile);

      const newStore = new DashboardStore(testStoreFile);
      const personas = newStore.getPersonaSettings();

      for (const id of STANDARD_PERSONA_IDS) {
        expect(personas[id].model).toBe(EXPECTED_DEFAULT_MODEL);
        expect(personas[id].providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('preserves default model when updating non-model fields on persona', () => {
      store = new DashboardStore(testStoreFile);
      const updated = store.updatePersonaSetting('security', { confidenceThreshold: 90 });

      expect(updated.confidenceThreshold).toBe(90);
      expect(updated.model).toBe(EXPECTED_DEFAULT_MODEL);
      expect(updated.providerId).toBe(EXPECTED_DEFAULT_PROVIDER);

      const reRead = store.getPersonaSetting('security');
      expect(reRead!.model).toBe(EXPECTED_DEFAULT_MODEL);
    });

    it('maintains openrouter default model override in platform settings', () => {
      store = new DashboardStore(testStoreFile);
      const settings = store.getSettings();

      expect(settings.defaultModelOverrides.openrouter).toBe(EXPECTED_DEFAULT_MODEL);
    });

    it('includes EXPECTED_DEFAULT_MODEL in getDynamicActiveModels()', () => {
      store = new DashboardStore(testStoreFile);
      const activeModels = store.getDynamicActiveModels();

      expect(activeModels).toContain(EXPECTED_DEFAULT_MODEL);
    });

    it('handles updateSettings with partial personaSettings update and preserves default models for unmentioned personas', () => {
      store = new DashboardStore(testStoreFile);
      store.updateSettings({
        personaSettings: {
          security: { confidenceThreshold: 95 } as any,
        },
      });

      const personas = store.getPersonaSettings();
      for (const id of STANDARD_PERSONA_IDS) {
        expect(personas[id].model, `Persona ${id} should retain default model after updateSettings`).toBe(EXPECTED_DEFAULT_MODEL);
        expect(personas[id].providerId, `Persona ${id} should retain default providerId after updateSettings`).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });

    it('verifies default exported singleton instance dashboardStore has openrouter default model across all personas', () => {
      const personas = dashboardStore.getPersonaSettings();
      for (const id of STANDARD_PERSONA_IDS) {
        expect(personas[id].model).toBe(EXPECTED_DEFAULT_MODEL);
        expect(personas[id].providerId).toBe(EXPECTED_DEFAULT_PROVIDER);
      }
    });
  });
});
