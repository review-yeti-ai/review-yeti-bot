import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import { createDashboardRouter } from '../../src/api/dashboardApi';

describe('Milestone 1: Strict Enabled Model Guard & Disablement Integration Tests', () => {
  let tempDbPath: string;
  let store: DashboardStore;
  let app: express.Express;

  beforeEach(() => {
    tempDbPath = path.join('/tmp', `test_dashboard_m1_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
    store = new DashboardStore(tempDbPath);

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

  it('getDynamicActiveModels() includes models from enabled providers and excludes disabled providers', () => {
    store.updatePersonaSetting('security', { model: 'claude-haiku-4.5', enabled: true });
    const initialModels = store.getDynamicActiveModels();
    expect(initialModels).toContain('claude-haiku-4.5');

    // First remap active personas using anthropic so we can disable anthropic
    store.updatePersonaSetting('security', { model: 'gpt-4o' });
    store.updatePersonaSetting('quality', { model: 'gpt-4o' });
    store.updatePersonaSetting('api_contract', { model: 'gpt-4o' });
    store.updatePersonaSetting('docs_compliance', { model: 'gpt-4o' });

    // Now disable anthropic provider
    store.updateProviderConfig('anthropic', { enabled: false, active: false });

    const modelsAfterDisable = store.getDynamicActiveModels();
    expect(modelsAfterDisable).not.toContain('claude-haiku-4.5');
    expect(modelsAfterDisable).not.toContain('claude-3-7-sonnet');
    expect(modelsAfterDisable).not.toContain('claude-opus-4-8');
  });

  it('throws validation error when disabling a provider used by active personas without remapping', () => {
    store.updatePersonaSetting('security', { model: 'claude-haiku-4.5', enabled: true });
    const personas = store.getPersonaSettings();
    expect(personas.security.model).toBe('claude-haiku-4.5');
    expect(personas.security.enabled).toBe(true);

    expect(() => {
      store.updateProviderConfig('anthropic', { enabled: false, active: false });
    }).toThrow(/Cannot disable provider/i);
  });

  it('atomically remaps active personas and disables provider without validation error', () => {
    // 1. Remap impacted active personas using anthropic to gpt-4o
    const updatedSecurity = store.updatePersonaSetting('security', { model: 'gpt-4o' });
    const updatedQuality = store.updatePersonaSetting('quality', { model: 'gpt-4o' });
    const updatedApiContract = store.updatePersonaSetting('api_contract', { model: 'gpt-4o' });
    const updatedDocsCompliance = store.updatePersonaSetting('docs_compliance', { model: 'gpt-4o' });

    expect(updatedSecurity.model).toBe('gpt-4o');
    expect(updatedQuality.model).toBe('gpt-4o');

    // 2. Disable anthropic provider
    const updatedProvider = store.updateProviderConfig('anthropic', { enabled: false, active: false });
    expect(updatedProvider.enabled).toBe(false);

    // 3. Verify validatePersonaSetting passes for all active personas
    const currentPersonas = store.getPersonaSettings();
    for (const [id, persona] of Object.entries(currentPersonas)) {
      if (persona.enabled !== false) {
        expect(() => store.validatePersonaSetting(persona, id)).not.toThrow();
      }
    }
  });

  it('rejects assigning a model from a disabled provider via updatePersonaSetting', () => {
    // Remap security to gpt-4o and disable anthropic
    store.updatePersonaSetting('security', { model: 'gpt-4o' });
    store.updatePersonaSetting('quality', { model: 'gpt-4o' });
    store.updatePersonaSetting('api_contract', { model: 'gpt-4o' });
    store.updatePersonaSetting('docs_compliance', { model: 'gpt-4o' });
    store.updateProviderConfig('anthropic', { enabled: false, active: false });

    // Attempt to set security persona back to claude-haiku-4.5 (belonging to disabled provider)
    expect(() => {
      store.updatePersonaSetting('security', { model: 'claude-haiku-4.5' });
    }).toThrow(/is not an allowed model override/i);
  });

  it('REST API /api/dashboard/providers returns models filtered strictly by enabled providers', async () => {
    const res = await request(app).get('/api/dashboard/providers');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.providers).toBeDefined();
    expect(res.body.models).toBeDefined();
    expect(Array.isArray(res.body.models)).toBe(true);
  });
});
