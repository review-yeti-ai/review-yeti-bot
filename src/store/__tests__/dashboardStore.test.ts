import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore, validateApiKeyFormat } from '../dashboardStore';

describe('DashboardStore API Key Integrity & Validation (Requirement R3)', () => {
  const tmpStoreFile = path.join(process.cwd(), 'fixtures/tmp/test_r3_store.json');
  let store: DashboardStore;

  beforeEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try { fs.unlinkSync(tmpStoreFile); } catch {}
    }
    store = new DashboardStore(tmpStoreFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try { fs.unlinkSync(tmpStoreFile); } catch {}
    }
  });

  describe('1. Removal of Default Populated Mock Keys', () => {
    it('does not seed default mock keys in providerConfigs when env vars are unset', () => {
      const providers = store.getProviderConfigs();
      expect(providers['openai']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['openai']?.apiKeyMasked || '').not.toContain('mock');
      expect(providers['anthropic']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['gemini']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['grok']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['deepseek']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['doppler']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['custom-openai']?.apiKeyRaw || '').not.toContain('mock');
      expect(providers['glm']?.apiKeyRaw || '').not.toContain('mock');
    });

    it('does not seed default mock keys in integrations when env vars are unset', () => {
      const integrations = store.getIntegrations();
      for (const integration of integrations) {
        expect(integration.apiKeyMasked || '').not.toContain('mock');
        expect(integration.apiKeyMasked || '').not.toContain('1234567890');
      }
    });
  });

  describe('2. Standalone validateApiKeyFormat Function', () => {
    it('rejects keys containing mock or dummy patterns', () => {
      const dummyKeys = [
        'sk-proj-mock1234567890',
        'sk-ant-mock1234567890',
        'AIzaSyMock1234567890',
        'xai-mock1234567890',
        'invalid_key_string_123',
        'dummy_key_value_abcdef',
        'test_key_placeholder_val',
        'placeholder_secret_token',
        'key_with_1234567890_sequence',
      ];

      for (const key of dummyKeys) {
        const result = validateApiKeyFormat(key);
        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(/prohibited dummy\/mock pattern|must be at least/i);
      }
    });

    it('rejects keys shorter than 16 characters', () => {
      const shortResult = validateApiKeyFormat('sk-short-key');
      expect(shortResult.valid).toBe(false);
      expect(shortResult.reason).toContain('at least 16 characters');
    });

    it('rejects keys with invalid characters', () => {
      const invalidCharResult = validateApiKeyFormat('sk-proj-validlen_key_with_bad!@#$symbols');
      expect(invalidCharResult.valid).toBe(false);
      expect(invalidCharResult.reason).toContain('invalid characters');
    });

    it('enforces provider-specific prefix requirements', () => {
      expect(validateApiKeyFormat('wrongprefix_abcdef9876543210', 'openai').valid).toBe(false);
      expect(validateApiKeyFormat('sk-proj-abcdef9876543210xyz', 'openai').valid).toBe(true);

      expect(validateApiKeyFormat('sk-proj-abcdef9876543210xyz', 'anthropic').valid).toBe(false);
      expect(validateApiKeyFormat('sk-ant-api03-abcdef9876543210', 'anthropic').valid).toBe(true);

      expect(validateApiKeyFormat('sk-ant-api03-abcdef9876543210', 'gemini').valid).toBe(false);
      expect(validateApiKeyFormat('AIzaSyAbcdef9876543210abcdef', 'gemini').valid).toBe(true);

      expect(validateApiKeyFormat('xai-abcdef9876543210abcdef', 'grok').valid).toBe(true);
      expect(validateApiKeyFormat('dp.pt.abcdef9876543210abcdef', 'doppler').valid).toBe(true);
      expect(validateApiKeyFormat('lin_api_abcdef9876543210abcdef', 'linear').valid).toBe(true);
    });
  });

  describe('3. Strict Key Integrity Enforcement in updateProviderConfig', () => {
    it('throws error when updating provider config with dummy/mock keys', () => {
      expect(() => {
        store.updateProviderConfig('openai', { apiKeyRaw: 'sk-proj-mock1234567890' });
      }).toThrow(/Invalid API key format/i);

      expect(() => {
        store.updateProviderConfig('anthropic', { apiKeyRaw: 'invalid_key' });
      }).toThrow(/Invalid API key format/i);
    });

    it('allows updating provider config with authentic valid keys', () => {
      const validKey = 'sk-proj-auth9876543210abcdef';
      const updated = store.updateProviderConfig('openai', { apiKeyRaw: validKey });
      expect(updated.apiKeyRaw).toBe(validKey);
      expect(updated.apiKeyMasked).toBe('sk-proj-...cdef');
    });
  });

  describe('4. Strict Key Integrity Enforcement in updateSettings', () => {
    it('throws error when updating platform settings with invalid provider key', () => {
      expect(() => {
        store.updateSettings({
          providerConfigs: {
            openai: { apiKeyRaw: 'sk-proj-dummy_key_123456' } as any,
          },
        });
      }).toThrow(/Invalid API key format/i);
    });

    it('allows updating platform settings with valid provider key', () => {
      const validAnthropic = 'sk-ant-api03-authentic_token_key_7788';
      store.updateSettings({
        providerConfigs: {
          anthropic: { apiKeyRaw: validAnthropic } as any,
        },
      });
      // getProviderConfigs() strips apiKeyRaw for security; verify the masked key
      const providers = store.getProviderConfigs();
      expect(providers['anthropic']?.apiKeyMasked).toBe('sk-ant-a...7788');
    });
  });

  describe('5. Strict Key Integrity Enforcement in updateIntegration', () => {
    it('throws error when updating integration with mock or invalid key', () => {
      expect(() => {
        store.updateIntegration('linear', { apiKey: 'lin_api_mock_key_123456' });
      }).toThrow(/Invalid API key format/i);
    });

    it('allows updating integration with authentic valid key', () => {
      const validLinear = 'lin_api_authentic_linear_token_9988';
      const updated = store.updateIntegration('linear', { apiKey: validLinear });
      expect(updated.apiKeyMasked).toBe('lin_api_...9988');
      expect(updated.status).toBe('connected');
    });
  });

  describe('6. Default Persona Model Configuration (Requirement R4)', () => {
    it('ensures default persona model configurations default to openrouter/auto', () => {
      const personas = store.getPersonaSettings();
      const personaKeys = Object.keys(personas);
      expect(personaKeys.length).toBeGreaterThan(0);

      for (const [key, persona] of Object.entries(personas)) {
        expect(persona.model, `Persona '${key}' model should default to openrouter/auto`).toBe('openrouter/auto');
        if (persona.modelId) {
          expect(persona.modelId, `Persona '${key}' modelId should default to openrouter/auto`).toBe('openrouter/auto');
        }
        if (persona.providerId) {
          expect(persona.providerId, `Persona '${key}' providerId should default to openrouter`).toBe('openrouter');
        }
      }
    });

    it('rejects banned gemini-2.0-flash model configuration with validation error', () => {
      expect(() => {
        store.validatePersonaSetting({
          id: 'security',
          confidenceThreshold: 85,
          effort: 'low',
          model: 'openrouter/google/gemini-2.0-flash-lite-001',
          enabled: true
        });
      }).toThrow(/banned/i);
    });
  });
});
