import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { createDashboardRouter } from '../../src/api/dashboardApi';

describe('Milestone 1: Strict Enabled Model Guard & Disablement Stress & Corner Cases', () => {
  let tempDbPath: string;
  let store: DashboardStore;
  let app: express.Express;

  beforeEach(() => {
    tempDbPath = path.join('/tmp', `test_dashboard_m1_stress_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
    dashboardStore.filePath = tempDbPath;
    store = dashboardStore;

    app = express();
    app.use(express.json());
    app.use('/api/dashboard', createDashboardRouter());
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
    } catch (_) {}
  });

  // CORNER CASE 1: All Providers Disabled
  describe('Corner Case 1: All Providers Disabled', () => {
    it('blocks disabling the last enabled provider when active personas depend on it', () => {
      // First disable all providers except openai
      const providers = store.getProviderConfigs();
      for (const [pId, p] of Object.entries(providers)) {
        if (pId !== 'openai') {
          // Remap personas off this provider first if needed
          const personas = store.getPersonaSettings();
          for (const [id, persona] of Object.entries(personas)) {
            if (persona.enabled !== false && (persona.model.includes(pId) || p.activeModels?.includes(persona.model))) {
              store.updatePersonaSetting(id, { model: 'gpt-4o' });
            }
          }
          try {
            store.updateProviderConfig(pId, { enabled: false, active: false });
          } catch (_) {}
        }
      }

      // Ensure all active personas are using gpt-4o
      const activePersonas = store.getPersonaSettings();
      for (const [id, persona] of Object.entries(activePersonas)) {
        if (persona.enabled !== false) {
          store.updatePersonaSetting(id, { model: 'gpt-4o' });
        }
      }

      // Now attempt to disable openai (the last remaining provider with active personas)
      expect(() => {
        store.updateProviderConfig('openai', { enabled: false, active: false });
      }).toThrow(/Cannot disable provider or model 'openai'/i);

      // Verify openai remains enabled
      const openaiConfig = store.getProviderConfig('openai');
      expect(openaiConfig?.enabled).toBe(true);
    });

    it('allows disabling all providers if ALL personas are disabled first, returning empty dynamic models', () => {
      // Disable all personas
      const personas = store.getPersonaSettings();
      for (const id of Object.keys(personas)) {
        store.updatePersonaSetting(id, { enabled: false });
      }

      // Disable all providers
      const providers = store.getProviderConfigs();
      for (const pId of Object.keys(providers)) {
        store.updateProviderConfig(pId, { enabled: false, active: false });
      }

      // Dynamic active models must be empty
      const activeModels = store.getDynamicActiveModels();
      expect(activeModels).toEqual([]);

      // Attempting to assign any model to a persona should fail
      expect(() => {
        store.updatePersonaSetting('security', { model: 'gpt-4o' });
      }).toThrow(/is not an allowed model override/i);
    });
  });

  // CORNER CASE 2: Disabled Model/Provider with No Active Personas
  describe('Corner Case 2: Model or Provider Disabled with No Active Personas', () => {
    it('successfully disables provider when all personas using its models are disabled (enabled: false)', () => {
      // Security, quality, api_contract, docs_compliance use anthropic models in default data
      // Disable these personas
      store.updatePersonaSetting('security', { enabled: false });
      store.updatePersonaSetting('quality', { enabled: false });
      store.updatePersonaSetting('api_contract', { enabled: false });
      store.updatePersonaSetting('docs_compliance', { enabled: false });

      // Disabling anthropic provider should succeed without error
      expect(() => {
        store.updateProviderConfig('anthropic', { enabled: false, active: false });
      }).not.toThrow();

      const anthropicConfig = store.getProviderConfig('anthropic');
      expect(anthropicConfig?.enabled).toBe(false);

      // Active models should no longer contain claude models
      const activeModels = store.getDynamicActiveModels();
      expect(activeModels).not.toContain('claude-3-5-sonnet');
    });

    it('successfully removes a model from activeModels when no active persona is assigned to it', () => {
      const anthropicConfig = store.getProviderConfig('anthropic');
      expect(anthropicConfig?.activeModels).toContain('claude-3-7-sonnet');

      // Check if any active persona uses claude-3-7-sonnet (none in default data)
      const activePersonas = store.getPersonaSettings();
      const using37 = Object.values(activePersonas).filter(p => p.enabled !== false && p.model === 'claude-3-7-sonnet');
      expect(using37.length).toBe(0);

      // Disable claude-3-7-sonnet from anthropic's activeModels
      const newActive = anthropicConfig!.activeModels.filter(m => m !== 'claude-3-7-sonnet');
      expect(() => {
        store.updateProviderConfig('anthropic', { activeModels: newActive });
      }).not.toThrow();

      const activeModels = store.getDynamicActiveModels();
      expect(activeModels).not.toContain('claude-3-7-sonnet');
    });
  });

  // CORNER CASE 3: Multiple Active Personas Remapping
  describe('Corner Case 3: Multiple Active Personas Remapping', () => {
    it('handles atomic remapping of 5+ active personas across different providers', () => {
      // Assign 5 personas to Anthropic models
      store.updatePersonaSetting('security', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('quality', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('api_contract', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('docs_compliance', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('red_team', { model: 'claude-opus-4-8', enabled: true });

      // Attempting to disable anthropic now fails
      expect(() => {
        store.updateProviderConfig('anthropic', { enabled: false, active: false });
      }).toThrow(/Cannot disable provider or model 'anthropic'/i);

      // Remap all 5 personas to valid models from other providers (e.g. gpt-4o from openai, deepseek-v3 from deepseek)
      store.updatePersonaSetting('security', { model: 'gpt-4o' });
      store.updatePersonaSetting('quality', { model: 'gpt-4o' });
      store.updatePersonaSetting('api_contract', { model: 'deepseek-v3' });
      store.updatePersonaSetting('docs_compliance', { model: 'gpt-4o' });
      store.updatePersonaSetting('red_team', { model: 'deepseek-v3' });

      // Now disable anthropic
      expect(() => {
        store.updateProviderConfig('anthropic', { enabled: false, active: false });
      }).not.toThrow();

      expect(store.getProviderConfig('anthropic')?.enabled).toBe(false);

      // Verify all 5 personas validate cleanly
      const personas = store.getPersonaSettings();
      expect(personas.security.model).toBe('gpt-4o');
      expect(personas.api_contract.model).toBe('deepseek-v3');
      expect(personas.red_team.model).toBe('deepseek-v3');

      for (const [id, persona] of Object.entries(personas)) {
        if (persona.enabled !== false) {
          expect(() => store.validatePersonaSetting(persona, id)).not.toThrow();
        }
      }
    });

    it('rolls back provider state if partial remapping leaves any active persona on disabled provider', () => {
      // 4 personas on anthropic
      store.updatePersonaSetting('security', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('quality', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('api_contract', { model: 'claude-3-5-sonnet', enabled: true });
      store.updatePersonaSetting('docs_compliance', { model: 'claude-3-5-sonnet', enabled: true });

      // Remap only 3 of them
      store.updatePersonaSetting('security', { model: 'gpt-4o' });
      store.updatePersonaSetting('quality', { model: 'gpt-4o' });
      store.updatePersonaSetting('api_contract', { model: 'gpt-4o' });
      // docs_compliance is left on claude-3-5-sonnet!

      // Disabling anthropic must throw and keep anthropic enabled
      expect(() => {
        store.updateProviderConfig('anthropic', { enabled: false, active: false });
      }).toThrow(/Active persona '📝 Documentation & Compliance' relies on model 'claude-3-5-sonnet'/i);

      expect(store.getProviderConfig('anthropic')?.enabled).toBe(true);
    });
  });

  // ADVERSARIAL CASE 4: Custom Models & Model Registry Dynamics
  describe('Adversarial Case 4: Custom Models & Model Registry Dynamics', () => {
    it('supports custom models as valid remapping targets and enforces strict guard on custom models', () => {
      // Add custom model to ollama
      const ollamaConfig = store.getProviderConfig('ollama') || {
        id: 'ollama',
        displayName: 'Ollama Local LLM',
        enabled: true,
        activeModels: [],
        customModels: [],
        updatedAt: new Date().toISOString(),
      };

      const customModel = 'custom-llama-3.3-q8';
      store.updateProviderConfig('ollama', {
        enabled: true,
        active: true,
        customModels: [customModel],
        activeModels: [customModel],
      });

      // Confirm customModel is in dynamic active models
      expect(store.getDynamicActiveModels()).toContain(customModel);

      // Remap security persona to customModel
      expect(() => {
        store.updatePersonaSetting('security', { model: customModel });
      }).not.toThrow();

      expect(store.getPersonaSetting('security')?.model).toBe(customModel);

      // Attempt to disable ollama provider now -> should fail because security persona uses customModel
      expect(() => {
        store.updateProviderConfig('ollama', { enabled: false, active: false });
      }).toThrow(/Cannot disable provider or model 'ollama'/i);
    });

    it('rejects setting a persona model to a non-existent or invalid model string', () => {
      expect(() => {
        store.updatePersonaSetting('security', { model: 'non-existent-model-xyz' });
      }).toThrow(/is not an allowed model override/i);

      expect(() => {
        store.updatePersonaSetting('security', { model: '' });
      }).toThrow(/must be a non-empty string/i);
    });
  });

  // REST API INTEGRATION STRESS
  describe('REST API Endpoint Validation & Guard Stress', () => {
    it('PUT /api/dashboard/personas/:id returns 400 when assigning disabled model', async () => {
      // Remap all anthropic personas to gpt-4o and disable anthropic
      store.updatePersonaSetting('security', { model: 'gpt-4o' });
      store.updatePersonaSetting('quality', { model: 'gpt-4o' });
      store.updatePersonaSetting('api_contract', { model: 'gpt-4o' });
      store.updatePersonaSetting('docs_compliance', { model: 'gpt-4o' });
      store.updateProviderConfig('anthropic', { enabled: false, active: false });

      const res = await request(app)
        .put('/api/dashboard/personas/security')
        .send({ model: 'claude-3-5-sonnet' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/is not an allowed model override/i);
    });

    it('PUT /api/dashboard/providers/:id returns 400 when disabling provider in-use', async () => {
      const res = await request(app)
        .put('/api/dashboard/providers/anthropic')
        .send({ enabled: false, active: false });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Cannot disable provider or model 'anthropic'/i);
    });
  });
});
