import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore, validateApiKeyFormat } from '../../src/store/dashboardStore';

describe('Empirical Challenger M4: API Key Integrity & Validation (dashboardStore)', () => {
  const tmpStoreFile = path.join(process.cwd(), 'fixtures/tmp/test_m4_empirical_key_validation.json');
  let store: DashboardStore;

  beforeEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try {
        fs.unlinkSync(tmpStoreFile);
      } catch {}
    }
    store = new DashboardStore(tmpStoreFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try {
        fs.unlinkSync(tmpStoreFile);
      } catch {}
    }
  });

  describe('1. Specific Mock/Dummy Keys Rejection (Prompt Criteria 1)', () => {
    const specifiedMockKeys = [
      'sk-proj-mock123',
      'invalid_key_99',
      'sk-dummy-test',
      'mock_token_abc',
    ];

    it('rejects all prompt-specified mock keys via validateApiKeyFormat', () => {
      for (const key of specifiedMockKeys) {
        const result = validateApiKeyFormat(key);
        expect(result.valid).toBe(false);
        expect(result.reason).toBeDefined();
        // The reason should cite prohibited pattern or length requirements
        expect(result.reason).toMatch(/prohibited dummy\/mock pattern|must be at least 16 characters/i);
      }
    });

    it('throws error when setting specified mock keys in updateProviderConfig', () => {
      for (const key of specifiedMockKeys) {
        expect(() => {
          store.updateProviderConfig('openai', { apiKeyRaw: key });
        }).toThrow(/Invalid API key format/i);
      }
    });

    it('throws error when setting specified mock keys in updateIntegration', () => {
      for (const key of specifiedMockKeys) {
        expect(() => {
          store.updateIntegration('linear', { apiKey: key });
        }).toThrow(/Invalid API key format/i);
      }
    });

    it('throws error when setting specified mock keys in updateSettings', () => {
      for (const key of specifiedMockKeys) {
        expect(() => {
          store.updateSettings({
            providerConfigs: {
              openai: { apiKeyRaw: key } as any,
            },
          });
        }).toThrow(/Invalid API key format/i);
      }
    });
  });

  describe('2. Comprehensive Prohibited Pattern & Edge Cases Stress Testing', () => {
    const additionalProhibitedKeys = [
      'sk-proj-mock_key_with_extended_length_123',
      'sk-ant-invalid_key_full_length_check',
      'sk-ds-invalid-key-full-length-check',
      'sk-glm-invalidkeyfullengthcheck',
      'AIzaSy_dummy_key_full_length_check',
      'xai-test_key_full_length_check',
      'dp.pt.test-key-full-length-check',
      'lin_api_testkeyfulllengthcheck',
      'ctx_live_placeholder_token_string_val',
      'phc_1234567890_sequence_in_key',
      'sntry_12345678_sequence_in_key',
      'xoxb-00000000_sequence_in_key',
    ];

    it('rejects extended prohibited dummy/mock patterns', () => {
      for (const key of additionalProhibitedKeys) {
        const res = validateApiKeyFormat(key);
        expect(res.valid).toBe(false);
        expect(res.reason).toContain('prohibited dummy/mock pattern');
      }
    });

    it('rejects keys shorter than 16 characters', () => {
      const shortKeys = [
        'sk-proj-short',
        'sk-ant-12345',
        'short_key_abc',
        '123456789012345', // 15 chars
      ];

      for (const key of shortKeys) {
        const res = validateApiKeyFormat(key);
        expect(res.valid).toBe(false);
        expect(res.reason).toMatch(/must be at least 16 characters/i);
      }
    });

    it('rejects invalid inputs (empty, whitespace, non-strings)', () => {
      expect(validateApiKeyFormat('').valid).toBe(false);
      expect(validateApiKeyFormat('   ').valid).toBe(false);
      expect(validateApiKeyFormat(null as any).valid).toBe(false);
      expect(validateApiKeyFormat(undefined as any).valid).toBe(false);
      expect(validateApiKeyFormat(1234567890123456 as any).valid).toBe(false);
    });

    it('rejects keys containing illegal characters (spaces, special symbols)', () => {
      const illegalCharKeys = [
        'sk-proj-validlen key with spaces',
        'sk-ant-validlen!@#$%^&*()',
        'AIzaSyValidLen<script>alert(1)</script>',
        'xai-ValidLengthKeyWith\nNewline',
        'dp.pt.ValidLengthKeyWith\tTabChar',
      ];

      for (const key of illegalCharKeys) {
        const res = validateApiKeyFormat(key);
        expect(res.valid).toBe(false);
        expect(res.reason).toMatch(/invalid characters|must be at least/i);
      }
    });
  });

  describe('3. Provider-Specific Prefix Enforcement', () => {
    it('enforces OpenAI & custom-openai prefix checks', () => {
      const invalidOpenAI = 'invalidprefix_a1b2c3d4e5f6g7h8i9j0';
      expect(validateApiKeyFormat(invalidOpenAI, 'openai').valid).toBe(false);
      expect(validateApiKeyFormat(invalidOpenAI, 'custom-openai').valid).toBe(false);

      expect(validateApiKeyFormat('sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2', 'openai').valid).toBe(true);
      expect(validateApiKeyFormat('sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'openai').valid).toBe(true);
      expect(validateApiKeyFormat('sk-admin-a1b2c3d4e5f6g7h8i9j0k1l2', 'openai').valid).toBe(true);
      expect(validateApiKeyFormat('sk-svcacct-a1b2c3d4e5f6g7h8i9j0k1l2', 'openai').valid).toBe(true);
    });

    it('enforces Anthropic prefix checks', () => {
      expect(validateApiKeyFormat('sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2', 'anthropic').valid).toBe(false);
      expect(validateApiKeyFormat('sk-ant-api03-a1b2c3d4e5f6g7h8i9j0', 'anthropic').valid).toBe(true);
    });

    it('enforces Gemini / Google prefix checks', () => {
      expect(validateApiKeyFormat('sk-ant-api03-a1b2c3d4e5f6g7h8i9j0', 'gemini').valid).toBe(false);
      expect(validateApiKeyFormat('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3', 'gemini').valid).toBe(true);
      expect(validateApiKeyFormat('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3', 'google').valid).toBe(true);
    });

    it('enforces Grok / xAI prefix checks', () => {
      expect(validateApiKeyFormat('sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2', 'grok').valid).toBe(false);
      expect(validateApiKeyFormat('xai-a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'grok').valid).toBe(true);
      expect(validateApiKeyFormat('xai-a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'xai').valid).toBe(true);
    });

    it('enforces DeepSeek prefix checks', () => {
      expect(validateApiKeyFormat('deepseek-a1b2c3d4e5f6g7h8i9j0k1l2', 'deepseek').valid).toBe(false);
      expect(validateApiKeyFormat('sk-ds-a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'deepseek').valid).toBe(true);
      expect(validateApiKeyFormat('sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'deepseek').valid).toBe(true);
    });

    it('enforces GLM prefix checks', () => {
      expect(validateApiKeyFormat('zhipu-a1b2c3d4e5f6g7h8i9j0k1l2', 'glm').valid).toBe(false);
      expect(validateApiKeyFormat('sk-glm-a1b2c3d4e5f6g7h8i9j0k1l2m3', 'glm').valid).toBe(true);
      expect(validateApiKeyFormat('glm-a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'glm').valid).toBe(true);
    });

    it('enforces Integration prefix checks (Doppler, Linear, Context7, PostHog, Sentry, Jira, Slack)', () => {
      expect(validateApiKeyFormat('bad_doppler_a1b2c3d4e5f6g7h8i9j0', 'doppler').valid).toBe(false);
      expect(validateApiKeyFormat('dp.pt.a1b2c3d4e5f6g7h8i9j0k1l2m3', 'doppler').valid).toBe(true);
      expect(validateApiKeyFormat('dp.st.a1b2c3d4e5f6g7h8i9j0k1l2m3', 'doppler').valid).toBe(true);

      expect(validateApiKeyFormat('bad_linear_a1b2c3d4e5f6g7h8i9j0', 'linear').valid).toBe(false);
      expect(validateApiKeyFormat('lin_api_a1b2c3d4e5f6g7h8i9j0k1l2', 'linear').valid).toBe(true);

      expect(validateApiKeyFormat('bad_c7_a1b2c3d4e5f6g7h8i9j0k1l2', 'context7').valid).toBe(false);
      expect(validateApiKeyFormat('ctx_live_a1b2c3d4e5f6g7h8i9j0k1l2', 'context7').valid).toBe(true);

      expect(validateApiKeyFormat('bad_ph_a1b2c3d4e5f6g7h8i9j0k1l2', 'posthog').valid).toBe(false);
      expect(validateApiKeyFormat('phc_a1b2c3d4e5f6g7h8i9j0k1l2m3n4', 'posthog').valid).toBe(true);

      expect(validateApiKeyFormat('bad_sentry_a1b2c3d4e5f6g7h8i9j0', 'sentry').valid).toBe(false);
      expect(validateApiKeyFormat('sntry_a1b2c3d4e5f6g7h8i9j0k1l2m3', 'sentry').valid).toBe(true);
      expect(validateApiKeyFormat('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', 'sentry').valid).toBe(true);

      expect(validateApiKeyFormat('bad_jira_a1b2c3d4e5f6g7h8i9j0', 'jira').valid).toBe(false);
      expect(validateApiKeyFormat('ATATT3a1b2c3d4e5f6g7h8i9j0k1l2m3', 'jira').valid).toBe(true);

      expect(validateApiKeyFormat('bad_slack_a1b2c3d4e5f6g7h8i9j0', 'slack').valid).toBe(false);
      expect(validateApiKeyFormat('xoxb-987654321098-9876543210987-a1b2c3d4e5f6', 'slack').valid).toBe(true);
    });
  });

  describe('4. Acceptance of Authentic Valid Keys (Prompt Criteria 2)', () => {
    const validKeysByProvider: Record<string, string> = {
      openai: 'sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2m3n4',
      anthropic: 'sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2',
      gemini: 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4',
      grok: 'xai-a1b2c3d4e5f6g7h8i9j0k1l2m3n4',
      deepseek: 'sk-ds-a1b2c3d4e5f6g7h8i9j0k1l2m3n4',
      glm: 'sk-glm-a1b2c3d4e5f6g7h8i9j0k1l2m3n4',
      doppler: 'dp.pt.a1b2c3d4e5f6g7h8i9j0k1l2m3n4',
      linear: 'lin_api_a1b2c3d4e5f6g7h8i9j0k1l2m3',
      context7: 'ctx_live_a1b2c3d4e5f6g7h8i9j0k1l2',
      posthog: 'phc_a1b2c3d4e5f6g7h8i9j0k1l2m3n4',
      sentry: 'sntry_a1b2c3d4e5f6g7h8i9j0k1l2m3',
      jira: 'ATATT3a1b2c3d4e5f6g7h8i9j0k1l2m3',
      slack: 'xoxb-987654321098-9876543210987-a1b2c3d4e5f6',
    };

    it('accepts validly formatted keys for all providers & integrations', () => {
      for (const [providerOrIntegration, key] of Object.entries(validKeysByProvider)) {
        const res = validateApiKeyFormat(key, providerOrIntegration);
        expect(res.valid).toBe(true);
        expect(res.reason).toBeUndefined();
      }
    });

    it('successfully persists valid provider key and masks secret in updateProviderConfig', () => {
      const validKey = validKeysByProvider.openai;
      const record = store.updateProviderConfig('openai', { apiKeyRaw: validKey });
      expect(record.apiKeyRaw).toBe(validKey);
      expect(record.apiKeyMasked).toBe('sk-proj-...m3n4');
      expect(record.apiKey).toBe('sk-proj-...m3n4');
    });

    it('successfully persists valid integration key and masks secret in updateIntegration', () => {
      const validKey = validKeysByProvider.linear;
      const record = store.updateIntegration('linear', { apiKey: validKey });
      expect(record.apiKeyMasked).toBe('lin_api_...l2m3');
      expect(record.status).toBe('connected');
    });
  });
});
