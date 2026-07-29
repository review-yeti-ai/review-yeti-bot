import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

const app = createApp();

describe('Milestone 1: Data Model, Store & API Synchronization', () => {
  beforeEach(() => {
    // Reset GitHub App Config and repo state for deterministic test execution
    dashboardStore.updateGitHubAppConfig({
      appId: '1029384',
      installationId: '59302194',
      webhookUrl: 'https://api.calltelemetry.com/api/webhooks/github',
      webhookSecret: 'whsec_test_secret_key_12345',
      privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0M...\n-----END RSA PRIVATE KEY-----',
      isVerified: true,
    });
  });

  describe('1. GitHub App Configuration', () => {
    it('returns complete GitHub App configuration with required fields', () => {
      const config = dashboardStore.getGitHubAppConfig();
      expect(config.appId).toBe('1029384');
      expect(config.installationId).toBe('59302194');
      expect(config.webhookUrl).toBe('https://api.calltelemetry.com/api/webhooks/github');
      expect(config.webhookSecret).toBe('whsec_test_secret_key_12345');
      expect(config.privateKeyPem).toContain('RSA PRIVATE KEY');
      expect(config.isVerified).toBe(true);
    });

    it('updates GitHub App config fields via store update', () => {
      const updated = dashboardStore.updateGitHubAppConfig({
        appId: '999888',
        webhookUrl: 'https://custom.webhook.url/events',
        isVerified: true,
      });
      expect(updated.appId).toBe('999888');
      expect(updated.webhookUrl).toBe('https://custom.webhook.url/events');
      expect(updated.isVerified).toBe(true);
    });
  });

  describe('2. Monitored Repositories', () => {
    it('returns monitored repositories array with all required properties', () => {
      const repos = dashboardStore.getRepositories();
      expect(repos.length).toBeGreaterThanOrEqual(3);

      repos.forEach((repo) => {
        expect(repo).toHaveProperty('id');
        expect(repo).toHaveProperty('name');
        expect(repo).toHaveProperty('full_name');
        expect(typeof repo.private).toBe('boolean');
        expect(typeof repo.automationEnabled).toBe('boolean');
        expect(['chill', 'balanced', 'assertive']).toContain(repo.strictnessProfile);
        expect(repo.defaultBranch).toBeDefined();
      });
    });

    it('PATCH /api/github/app-config/monitored-repos updates repository automation and strictness profile', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set('Authorization', 'Bearer demo_token_public')
        .send({
          full_name: 'calltelemetry/cisco-cdr',
          automationEnabled: false,
          strictnessProfile: 'assertive',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.repository.full_name).toBe('calltelemetry/cisco-cdr');
      expect(res.body.repository.automationEnabled).toBe(false);
      expect(res.body.repository.strictnessProfile).toBe('assertive');

      // Verify updated state in store
      const repos = dashboardStore.getRepositories();
      const ciscoCdr = repos.find((r) => r.full_name === 'calltelemetry/cisco-cdr');
      expect(ciscoCdr?.automationEnabled).toBe(false);
      expect(ciscoCdr?.strictnessProfile).toBe('assertive');
    });
  });

  describe('3. AI Providers Synchronization (All 11 Providers)', () => {
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

    it('contains all 11 AI provider configurations with required properties', () => {
      const providerConfigs = dashboardStore.getProviderConfigs();
      expect(Object.keys(providerConfigs).length).toBeGreaterThanOrEqual(11);

      requiredProviders.forEach((id) => {
        const provider = providerConfigs[id];
        expect(provider).toBeDefined();
        expect(provider.id).toBe(id);
        expect(provider.name).toBeDefined();
        expect(provider.apiKey).toBeDefined();
        expect(provider.baseUrl).toBeDefined();
        expect(provider.subscriptionTier).toBeDefined();
        expect(['Free', 'Pay-as-you-go', 'Pro', 'Team', 'Enterprise']).toContain(provider.subscriptionTier);
        expect(typeof provider.active).toBe('boolean');
        expect(['connected', 'error', 'untested', 'active']).toContain(provider.status);
      });
    });

    it('POST /api/dashboard/providers/:id/test executes connection and latency test', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/openai/test')
        .set('Authorization', 'Bearer demo_token_public')
        .send({ baseUrl: 'https://api.omniroute.internal/v1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('connected');
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.latencyMs).toBeGreaterThan(0);

      // Verify updated latencyMs in provider config
      const openaiConfig = dashboardStore.getProviderConfig('openai');
      expect(openaiConfig?.status).toBe('connected');
      expect(openaiConfig?.latencyMs).toBeGreaterThan(0);
    });
  });

  describe('4. Persona Model Ensemble Mappings (All 11 Reviewer Personas)', () => {
    const requiredPersonas = [
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

    it('contains all 11 reviewer personas with modelId, providerId, effortLevel, and confidenceThreshold', () => {
      const personas = dashboardStore.getPersonaSettings();

      requiredPersonas.forEach((id) => {
        const persona = personas[id];
        expect(persona).toBeDefined();
        expect(persona.id).toBe(id);
        expect(persona.modelId || persona.model).toBeDefined();
        expect(persona.providerId).toBeDefined();
        expect(persona.effortLevel || persona.effort).toBeDefined();
        expect(typeof persona.confidenceThreshold).toBe('number');
        expect(persona.confidenceThreshold).toBeGreaterThanOrEqual(0);
        expect(persona.confidenceThreshold).toBeLessThanOrEqual(100);
      });
    });

    it('updates persona ensemble mapping via updatePersonaSetting', () => {
      const updated = dashboardStore.updatePersonaSetting('security', {
        modelId: 'claude-3-7-sonnet',
        providerId: 'anthropic',
        effortLevel: 'max',
        confidenceThreshold: 90,
      });

      expect(updated.modelId).toBe('claude-3-7-sonnet');
      expect(updated.providerId).toBe('anthropic');
      expect(updated.effortLevel).toBe('max');
      expect(updated.confidenceThreshold).toBe(90);
    });
  });
});
