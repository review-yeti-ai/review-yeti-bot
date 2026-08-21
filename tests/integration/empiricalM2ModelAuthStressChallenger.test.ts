import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import {
  isProviderEnabled,
  isModelEnabled,
  getEnabledProviders,
  getEnabledModelOptions,
  getProviderIdForModel,
  getFallbackModelForPersona,
} from '@/lib/model-filtering';
import { requireAuth } from '@/api/authMiddleware';
import { ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';

describe('Empirical Stress Harness: Model Filtering & Auth Middleware', () => {
  describe('1. Model Filtering: All Providers Disabled', () => {
    it('returns empty list for getEnabledProviders when all providers are explicitly disabled', () => {
      const allDisabledProviders: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: false, updatedAt: '' },
        openai: { id: 'openai', displayName: 'OpenAI', enabled: false, updatedAt: '' },
        grok: { id: 'grok', displayName: 'Grok', enabled: false, updatedAt: '' },
        deepseek: { id: 'deepseek', displayName: 'DeepSeek', enabled: false, updatedAt: '' },
        glm: { id: 'glm', displayName: 'GLM', enabled: false, updatedAt: '' },
        gemini: { id: 'gemini', displayName: 'Gemini', enabled: false, updatedAt: '' },
        doppler: { id: 'doppler', displayName: 'Doppler', enabled: false, updatedAt: '' },
        ollama: { id: 'ollama', displayName: 'Ollama', enabled: false, updatedAt: '' },
        'custom-openai': { id: 'custom-openai', displayName: 'Custom OpenAI', enabled: false, updatedAt: '' },
        codex: { id: 'codex', displayName: 'Codex', enabled: false, updatedAt: '' },
        agy: { id: 'agy', displayName: 'AGY', enabled: false, updatedAt: '' },
      };

      const enabledList = getEnabledProviders(allDisabledProviders);
      expect(enabledList).toEqual([]);
    });

    it('returns false for isProviderEnabled for any provider when all are disabled', () => {
      const allDisabledProviders: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: false, updatedAt: '' },
        openai: { id: 'openai', displayName: 'OpenAI', enabled: false, updatedAt: '' },
      };

      expect(isProviderEnabled('anthropic', allDisabledProviders)).toBe(false);
      expect(isProviderEnabled('openai', allDisabledProviders)).toBe(false);
    });

    it('filters out all model options in getEnabledModelOptions when all providers are disabled', () => {
      const allDisabledProviders: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: false, updatedAt: '' },
        openai: { id: 'openai', displayName: 'OpenAI', enabled: false, updatedAt: '' },
        grok: { id: 'grok', displayName: 'Grok', enabled: false, updatedAt: '' },
        deepseek: { id: 'deepseek', displayName: 'DeepSeek', enabled: false, updatedAt: '' },
        glm: { id: 'glm', displayName: 'GLM', enabled: false, updatedAt: '' },
        gemini: { id: 'gemini', displayName: 'Gemini', enabled: false, updatedAt: '' },
        doppler: { id: 'doppler', displayName: 'Doppler', enabled: false, updatedAt: '' },
        ollama: { id: 'ollama', displayName: 'Ollama', enabled: false, updatedAt: '' },
        'custom-openai': { id: 'custom-openai', displayName: 'Custom OpenAI', enabled: false, updatedAt: '' },
        codex: { id: 'codex', displayName: 'Codex', enabled: false, updatedAt: '' },
        agy: { id: 'agy', displayName: 'AGY', enabled: false, updatedAt: '' },
      };

      const options = [
        { label: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet' },
        { label: 'GPT-4o', value: 'gpt-4o' },
        { label: 'DeepSeek V3', value: 'deepseek-v3' },
      ];

      const filtered = getEnabledModelOptions(options, allDisabledProviders);
      expect(filtered).toEqual([]);
    });

    it('getFallbackModelForPersona falls back to default fallback when enabledOptions is empty', () => {
      const fallback = getFallbackModelForPersona('gpt-4o', [], 'claude-3-5-sonnet');
      expect(fallback).toBe('claude-3-5-sonnet');
    });
  });

  describe('2. Model Filtering: Unconfigured Providers Evaluation', () => {
    it('returns false for unconfigured provider when providers record contains other configured providers', () => {
      const partialProviders: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, updatedAt: '' },
      };

      // 'openai' and 'grok' are NOT in partialProviders
      expect(isProviderEnabled('openai', partialProviders)).toBe(false);
      expect(isProviderEnabled('grok', partialProviders)).toBe(false);
      expect(isProviderEnabled('anthropic', partialProviders)).toBe(true);
    });

    it('returns true for isProviderEnabled when providers map is undefined or empty object (default initial state)', () => {
      expect(isProviderEnabled('openai', undefined)).toBe(true);
      expect(isProviderEnabled('openai', {})).toBe(true);
    });

    it('evaluates model enablement for custom / registry models with unconfigured providers', () => {
      const modelRegistry: Record<string, ModelRegistryItem> = {
        'custom-llama-model': {
          id: 'custom-llama-model',
          displayName: 'Custom Llama',
          providerId: 'ollama',
          enabled: true,
          updatedAt: '',
        },
      };

      const providers: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, updatedAt: '' },
      };

      // ollama is unconfigured in providers, so custom-llama-model must be disabled
      expect(isModelEnabled('custom-llama-model', providers, modelRegistry)).toBe(false);
    });

    it('correctly maps unconfigured legacy/variant provider IDs to canonical IDs before evaluation', () => {
      const providers: Record<string, ProviderConfigRecord> = {
        anthropic: { id: 'anthropic', displayName: 'Anthropic', enabled: true, updatedAt: '' },
      };

      // agy_thinking should canonicalize to 'agy', which is unconfigured, so false
      expect(isProviderEnabled('agy_thinking', providers)).toBe(false);
      expect(isProviderEnabled('custom_openai', providers)).toBe(false);
    });
  });

  describe('3. Auth Middleware: Query Parameter Bypass Attempts', () => {
    let app: Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use(requireAuth);
      app.get('/api/dashboard/integrations', (_req, res) => {
        res.status(200).json({ success: true, integrations: [] });
      });
      app.get('/health', (_req, res) => {
        res.status(200).json({ status: 'ok' });
      });
    });

    it('blocks GET /api/dashboard/integrations?bypass=/health without valid credentials', async () => {
      const res = await request(app).get('/api/dashboard/integrations?bypass=/health');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('blocks GET /api/dashboard/integrations?redirect=/api/health without valid credentials', async () => {
      const res = await request(app).get('/api/dashboard/integrations?redirect=/api/health');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('blocks GET /api/dashboard/integrations?token=invalid_token&bypass=/health', async () => {
      const res = await request(app).get('/api/dashboard/integrations?token=invalid_token&bypass=/health');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('allows GET /health as public route', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('blocks GET /api/dashboard/integrations#health without valid credentials', async () => {
      const res = await request(app).get('/api/dashboard/integrations#health');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
