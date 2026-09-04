import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import supertest from 'supertest';
import { isProviderEnabled, getEnabledModelOptions, ALL_CANONICAL_PROVIDERS } from '@/lib/model-filtering';
import { AVAILABLE_MODEL_OPTIONS } from '@/components/onboarding/steps/step-4-persona-ensemble';
import { requireAuth } from '@/api/authMiddleware';
import { ProviderConfigRecord } from '@/types/dashboard';

describe('M2 Remediation Fixes Verification Suite', () => {
  describe('1. Model Filtering Strict Provider Enablement', () => {
    it('returns false for unconfigured providers when providers map is present and non-empty', () => {
      const providers: Record<string, ProviderConfigRecord> = {
        openai: { id: 'openai', displayName: 'OpenAI', enabled: true, active: true, updatedAt: '', activeModels: [] },
      };

      // Configured provider returns true
      expect(isProviderEnabled('openai', providers)).toBe(true);

      // Unconfigured providers MUST strictly return false
      expect(isProviderEnabled('anthropic', providers)).toBe(false);
      expect(isProviderEnabled('grok', providers)).toBe(false);
      expect(isProviderEnabled('deepseek', providers)).toBe(false);
      expect(isProviderEnabled('gemini', providers)).toBe(false);
    });

    it('returns true for all providers when providers map is undefined or empty', () => {
      expect(isProviderEnabled('openai', undefined)).toBe(true);
      expect(isProviderEnabled('openai', {})).toBe(true);
      expect(isProviderEnabled('grok', undefined)).toBe(true);
      expect(isProviderEnabled('grok', {})).toBe(true);
    });
  });

  describe('2. Step 4 Persona Ensemble Model Options (No Fallback Leak)', () => {
    it('returns empty array when all providers are disabled (no fallback to all options)', () => {
      const allDisabledProviders: Record<string, ProviderConfigRecord> = {};
      ALL_CANONICAL_PROVIDERS.forEach((pId) => {
        allDisabledProviders[pId] = { id: pId, displayName: pId, enabled: false, active: false, updatedAt: '', activeModels: [] };
      });

      const enabledOpts = getEnabledModelOptions(AVAILABLE_MODEL_OPTIONS, allDisabledProviders);
      expect(enabledOpts).toHaveLength(0);
    });
  });

  describe('3. Auth Middleware Strict Protected Routes Query Parameter Bypass Prevention', () => {
    let app: Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use(requireAuth);

      app.get('/api/dashboard/integrations', (_req, res) => {
        res.status(200).json({ success: true });
      });
      app.get('/api/personas/security', (_req, res) => {
        res.status(200).json({ success: true });
      });
      app.get('/api/settings/config', (_req, res) => {
        res.status(200).json({ success: true });
      });
      app.get('/api/telemetry/events', (_req, res) => {
        res.status(200).json({ success: true });
      });
    });

    it('rejects query parameter bypass attempts on protected routes with HTTP 401 Unauthorized', async () => {
      const bypassPaths = [
        '/api/dashboard/integrations?bypass=/health',
        '/api/personas/security?bypass=/health',
        '/api/settings/config?bypass=/ready',
        '/api/telemetry/events?bypass=/version',
        '/api/dashboard/overview?redirect=/about',
      ];

      for (const targetUrl of bypassPaths) {
        const res = await supertest(app).get(targetUrl);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Unauthorized');
      }
    });
  });
});
