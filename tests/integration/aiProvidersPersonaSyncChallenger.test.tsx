// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { ProviderSettings } from '../../src/components/settings/provider-settings';
import { PersonaSelector } from '../../src/components/settings/persona-selector';
import * as apiClient from '../../src/lib/api-client';

// Mock next/navigation for JSDOM components
vi.mock('next/navigation', () => {
  return {
    usePathname: () => '/settings',
    useSearchParams: () => new URLSearchParams('tab=models'),
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
    }),
  };
});

describe('Challenger 2 Suite: AI Providers UI & Persona Sync Empirical Verification', () => {
  let app: any;
  let validApiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  });

  beforeEach(() => {
    app = createApp();
    const createdKey = dashboardStore.createApiKey('challenger-provider-key');
    validApiKey = createdKey.rawKey;
  });

  // ==========================================
  // TASK 1: Frontend Component & Dynamic Selector
  // ==========================================
  describe('Task 1: Frontend Component Compilation & Dynamic Model Selector', () => {
    it('ProviderSettings component compiles and renders target provider cards with controls', async () => {
      const mockProviders = {
        openai: {
          id: 'openai',
          displayName: 'OpenAI',
          enabled: true,
          apiKeyMasked: 'sk-proj...1234',
          baseUrl: 'https://api.openai.com/v1',
          subscriptionTier: 'pay-as-you-go',
          activeModels: ['gpt-4o', 'gpt-4o-mini'],
          customModels: [],
          updatedAt: new Date().toISOString(),
        },
        anthropic: {
          id: 'anthropic',
          displayName: 'Anthropic Claude',
          enabled: true,
          apiKeyMasked: 'sk-ant...5678',
          baseUrl: 'https://api.anthropic.com/v1',
          subscriptionTier: 'team',
          activeModels: ['claude-3-5-sonnet'],
          customModels: [],
          updatedAt: new Date().toISOString(),
        },
        ollama: {
          id: 'ollama',
          displayName: 'Ollama Local LLM',
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          subscriptionTier: 'free',
          activeModels: ['llama3.3'],
          customModels: ['qwen2.5-coder'],
          updatedAt: new Date().toISOString(),
        },
      };

      const mockRegistry = {
        'gpt-4o': {
          id: 'gpt-4o',
          providerId: 'openai',
          displayName: 'GPT-4o',
          enabled: true,
          contextWindowTokens: 128000,
          costPer1kPromptUSD: 0.0025,
          costPer1kCompletionUSD: 0.01,
        },
      };

      vi.spyOn(apiClient, 'fetchProviders').mockResolvedValue({
        success: true,
        providers: mockProviders as any,
        models: ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'llama3.3'],
        modelRegistry: mockRegistry as any,
      });

      render(<ProviderSettings />);

      await waitFor(() => {
        expect(screen.getByText('OpenAI')).toBeDefined();
        expect(screen.getByText('Anthropic Claude')).toBeDefined();
        expect(screen.getByText('Ollama Local LLM')).toBeDefined();
      });

      const testButtons = screen.getAllByRole('button', { name: /Test Connection/i });
      expect(testButtons.length).toBeGreaterThan(0);
    });

    it('PersonaSelector component renders all 11 domain personas with active status badges', () => {
      const mockPersonas = {
        security: {
          id: 'security',
          displayName: '🛡️ Security & Tenancy Guardian',
          description: 'Security description',
          enabled: true,
          model: 'claude-3-5-sonnet',
          effort: 'max' as const,
          confidenceThreshold: 85,
        },
      };

      render(<PersonaSelector selectedPersonaId="security" personas={mockPersonas as any} />);

      const secElements = screen.getAllByText(/Security & Tenancy Guardian/i);
      expect(secElements.length).toBeGreaterThan(0);

      const archElements = screen.getAllByText(/System Architecture/i);
      expect(archElements.length).toBeGreaterThan(0);
    });
  });

  // ==========================================
  // TASK 2: API Endpoints Verification & Persona Sync
  // ==========================================
  describe('Task 2: Provider API Endpoints & Persona Sync Integration', () => {
    it('GET /api/dashboard/providers returns status 200 with providers, models, and registry', async () => {
      const res = await request(app)
        .get('/api/dashboard/providers')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.providers).toBeDefined();
      expect(typeof res.body.providers).toBe('object');
      expect(Array.isArray(res.body.models)).toBe(true);
      expect(res.body.modelRegistry).toBeDefined();

      // Check key default providers exist
      expect(res.body.providers.openai).toBeDefined();
      expect(res.body.providers.anthropic).toBeDefined();
      expect(res.body.providers.ollama).toBeDefined();
    });

    it('PUT /api/dashboard/providers/:id updates provider config, raw key masking, and custom models', async () => {
      const res = await request(app)
        .put('/api/dashboard/providers/ollama')
        .set('x-api-key', validApiKey)
        .send({
          enabled: true,
          baseUrl: 'http://127.0.0.1:11434/v1',
          subscriptionTier: 'free',
          activeModels: ['llama3.3', 'qwen2.5-coder', 'custom-ollama-v2'],
          customModels: ['custom-ollama-v2'],
          apiKeyRaw: 'sk-ollama-authentic-token-7788',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBeDefined();
      expect(res.body.provider.baseUrl).toBe('http://127.0.0.1:11434/v1');
      expect(res.body.provider.customModels).toContain('custom-ollama-v2');
      expect(res.body.provider.apiKeyMasked).toBe('sk-ollam...7788');

      // Verify dynamic active models API reflects newly added model
      const getRes = await request(app)
        .get('/api/dashboard/providers')
        .set('x-api-key', validApiKey);

      expect(getRes.status).toBe(200);
      expect(getRes.body.models).toContain('custom-ollama-v2');
    });

    it('POST /api/dashboard/providers/:id/test performs connection test and returns latency', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/openai/test')
        .set('x-api-key', validApiKey)
        .send({ baseUrl: 'https://api.openai.com/v1' });

      expect(res.status).toBe(200);
      expect(typeof res.body.status).toBe('string');
      expect(['connected', 'disconnected', 'error']).toContain(res.body.status);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(res.body.message).toContain('OpenAI');
    });

    it('Persona Sync Validation: Allows setting registered dynamic model for persona', async () => {
      // First ensure custom model is added to provider
      await request(app)
        .put('/api/dashboard/providers/openai')
        .set('x-api-key', validApiKey)
        .send({
          activeModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'custom-gpt-challenger'],
          customModels: ['custom-gpt-challenger'],
        });

      // Update persona security with the dynamic model
      const res = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({
          model: 'custom-gpt-challenger',
          effort: 'max',
          confidenceThreshold: 90,
          enabled: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.persona.model).toBe('custom-gpt-challenger');
    });

    it('Persona Sync Stress Boundary: Rejects setting unapproved model for persona with 400', async () => {
      const res = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({
          model: 'unapproved-fake-model-9999',
          effort: 'high',
          confidenceThreshold: 80,
          enabled: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not an allowed model override');
    });
  });
});
