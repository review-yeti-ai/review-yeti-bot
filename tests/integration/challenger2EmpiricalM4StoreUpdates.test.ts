import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore, validateApiKeyFormat } from '../../src/store/dashboardStore';
import { providerPool } from '../../src/gateway/providerPool';

describe('Challenger 2 Empirical M4: Provider Config Updates & Store State Persistence', () => {
  const fixtureDir = path.join(process.cwd(), 'fixtures/tmp');
  let tmpStoreFile: string;
  let store: DashboardStore;

  beforeEach(() => {
    providerPool.clear();
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    tmpStoreFile = path.join(fixtureDir, `challenger2_m4_store_${process.pid}_${Math.random().toString(36).slice(2)}.json`);
    if (fs.existsSync(tmpStoreFile)) {
      try { fs.unlinkSync(tmpStoreFile); } catch {}
    }
    store = new DashboardStore(tmpStoreFile);
  });

  afterEach(() => {
    providerPool.clear();
    if (tmpStoreFile && fs.existsSync(tmpStoreFile)) {
      try { fs.unlinkSync(tmpStoreFile); } catch {}
    }
  });

  describe('1. Fail-Fast Validation & Non-Persistence of Mock/Dummy Keys in updateProviderConfig', () => {
    const dummyKeyTestCases = [
      { provider: 'openai', key: 'sk-proj-mock123456789012', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'openai', key: 'sk-proj-dummy_key_12345678', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'openai', key: 'sk-proj-test_key_123456789', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'openai', key: 'sk-proj-1234567890abcdef', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'anthropic', key: 'sk-ant-mock12345678901234', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'anthropic', key: 'sk-ant-placeholder_token_val', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'gemini', key: 'AIzaSyMock12345678901234', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'grok', key: 'xai-invalid_key_string123', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'deepseek', key: 'sk-ds-0000000000000000', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'glm', key: 'sk-glm-1234567812345678', reasonPattern: /prohibited dummy\/mock pattern/i },
      { provider: 'doppler', key: 'dp.pt.test-key-1234567890', reasonPattern: /prohibited dummy\/mock pattern/i },
      // Invalid length (<16 chars)
      { provider: 'openai', key: 'sk-proj-short', reasonPattern: /at least 16 characters/i },
      // Invalid prefix
      { provider: 'openai', key: 'invalidprefix_98765432101234', reasonPattern: /must start with valid prefix/i },
      { provider: 'anthropic', key: 'sk-proj-validopenai_key1234', reasonPattern: /must start with 'sk-ant-'/i },
      { provider: 'gemini', key: 'sk-ant-api03-validanthropic', reasonPattern: /must start with 'AIzaSy'/i },
      { provider: 'grok', key: 'sk-proj-notagrokkey123456', reasonPattern: /must start with 'xai-'/i },
      // Invalid characters
      { provider: 'openai', key: 'sk-proj-validlen_with_bad!@#$symbol', reasonPattern: /invalid characters/i },
    ];

    for (const tc of dummyKeyTestCases) {
      it(`fails fast and prevents persisting invalid key '${tc.key}' for '${tc.provider}'`, () => {
        // Record initial state before update attempt
        const initialConfig = store.getProviderConfig(tc.provider);
        const initialRawKey = initialConfig?.apiKeyRaw;

        // Attempt update with dummy/mock key -> must throw
        expect(() => {
          store.updateProviderConfig(tc.provider, { apiKeyRaw: tc.key });
        }).toThrow(tc.reasonPattern);

        // Verify state in current store instance (in-memory) was not altered
        const currentConfig = store.getProviderConfig(tc.provider);
        expect(currentConfig?.apiKeyRaw).toBe(initialRawKey);
        expect(currentConfig?.apiKeyRaw).not.toBe(tc.key);

        // Verify state on disk was not polluted with invalid key
        const reloadedStore = new DashboardStore(tmpStoreFile);
        const reloadedConfig = reloadedStore.getProviderConfig(tc.provider);
        expect(reloadedConfig?.apiKeyRaw).toBe(initialRawKey);
        expect(reloadedConfig?.apiKeyRaw).not.toBe(tc.key);
      });
    }
  });

  describe('2. State Persistence on Valid Provider Config Updates', () => {
    it('persists valid key updates to memory and disk for OpenAI', () => {
      const validKey = 'sk-proj-valid_openai_secret_token_998877';
      const updated = store.updateProviderConfig('openai', { apiKeyRaw: validKey });

      expect(updated.apiKeyRaw).toBe(validKey);
      expect(updated.apiKeyMasked).toBe('sk-proj-...8877');
      expect(updated.apiKey).toBe('sk-proj-...8877');

      // Verify in-memory state
      expect(store.getProviderConfig('openai')?.apiKeyRaw).toBe(validKey);

      // Verify disk persistence
      const reloadedStore = new DashboardStore(tmpStoreFile);
      const persisted = reloadedStore.getProviderConfig('openai');
      expect(persisted?.apiKeyRaw).toBe(validKey);
      expect(persisted?.apiKeyMasked).toBe('sk-proj-...8877');
    });

    it('persists valid key updates to memory and disk for Anthropic', () => {
      const validKey = 'sk-ant-api03-authentic_anthropic_key_998877';
      store.updateProviderConfig('anthropic', { apiKeyRaw: validKey });

      const reloadedStore = new DashboardStore(tmpStoreFile);
      expect(reloadedStore.getProviderConfig('anthropic')?.apiKeyRaw).toBe(validKey);
    });

    it('persists valid key updates using apiKey property instead of apiKeyRaw', () => {
      const validKey = 'sk-proj-valid_via_apikey_prop_99001122';
      store.updateProviderConfig('openai', { apiKey: validKey });

      expect(store.getProviderConfig('openai')?.apiKeyRaw).toBe(validKey);

      const reloadedStore = new DashboardStore(tmpStoreFile);
      expect(reloadedStore.getProviderConfig('openai')?.apiKeyRaw).toBe(validKey);
    });

    it('supports multiple sequential valid updates and maintains file integrity', () => {
      const providers: Array<{ id: string; key: string }> = [
        { id: 'openai', key: 'sk-proj-seq_openai_key_abcdef998877' },
        { id: 'anthropic', key: 'sk-ant-api03-seq_anthropic_key_abcdef99' },
        { id: 'gemini', key: 'AIzaSySeq_Gemini_Key_abcdef998877' },
        { id: 'grok', key: 'xai-seq_grok_key_abcdef998877' },
        { id: 'deepseek', key: 'sk-ds-seq_deepseek_key_abcdef998877' },
      ];

      for (const p of providers) {
        store.updateProviderConfig(p.id, { apiKeyRaw: p.key });
      }

      const reloadedStore = new DashboardStore(tmpStoreFile);
      for (const p of providers) {
        expect(reloadedStore.getProviderConfig(p.id)?.apiKeyRaw).toBe(p.key);
      }
    });
  });

  describe('3. Platform Settings Updates (updateSettings) Integrity & Transaction Bounds', () => {
    it('rejects updateSettings when any providerConfig in batch contains invalid dummy key', () => {
      const validKey = 'sk-proj-valid_openai_key_776655443322';
      const dummyKey = 'sk-ant-mock12345678901234';

      expect(() => {
        store.updateSettings({
          providerConfigs: {
            openai: { apiKeyRaw: validKey } as any,
            anthropic: { apiKeyRaw: dummyKey } as any,
          },
        });
      }).toThrow(/Invalid API key format/i);

      // Confirm fail-fast: valid key in same batch was NOT applied or saved
      const reloadedStore = new DashboardStore(tmpStoreFile);
      expect(reloadedStore.getProviderConfig('openai')?.apiKeyRaw).not.toBe(validKey);
      expect(reloadedStore.getProviderConfig('anthropic')?.apiKeyRaw).not.toBe(dummyKey);
    });

    it('evaluates store state integrity when persona validation fails after providerConfig updates in updateSettings', () => {
      const validKey = 'sk-proj-valid_openai_key_999988887777';

      // Attempt updateSettings with valid providerConfig but invalid persona model
      expect(() => {
        store.updateSettings({
          providerConfigs: {
            openai: { apiKeyRaw: validKey } as any,
          },
          personaSettings: {
            security: {
              model: 'invalid-nonexistent-model-xyz',
            } as any,
          },
        });
      }).toThrow(/is not an allowed model override/i);

      // Check disk state: Should NOT be saved to disk because saveData wasn't reached
      const reloadedStore = new DashboardStore(tmpStoreFile);
      expect(reloadedStore.getProviderConfig('openai')?.apiKeyRaw).not.toBe(validKey);
    });
  });

  describe('4. Integration Config Updates (updateIntegration) Key Validation & Persistence', () => {
    const integrationTestCases = [
      { id: 'linear', validKey: 'lin_api_valid_linear_token_abcdef99', dummyKey: 'lin_api_mock_token_12345' },
      { id: 'context7', validKey: 'ctx_live_valid_context7_token_abcdef99', dummyKey: 'ctx_live_dummy_token_12345' },
      { id: 'posthog', validKey: 'phc_valid_posthog_client_key_abcdef99', dummyKey: 'phc_test_key_placeholder' },
      { id: 'doppler', validKey: 'dp.pt.valid_doppler_personal_token_abcdef', dummyKey: 'dp.pt.1234567890123456' },
      { id: 'slack', validKey: 'xoxb-valid-slack-bot-token-abcdef998877', dummyKey: 'xoxb-mock-slack-token-1234' },
      { id: 'jira', validKey: 'ATATT3valid_jira_api_token_abcdef998877', dummyKey: 'ATATT3mock_jira_token_1234' },
    ];

    for (const tc of integrationTestCases) {
      it(`fails fast and rejects dummy key for integration '${tc.id}'`, () => {
        expect(() => {
          store.updateIntegration(tc.id, { apiKey: tc.dummyKey });
        }).toThrow(/Invalid API key format/i);

        const reloadedStore = new DashboardStore(tmpStoreFile);
        const integration = reloadedStore.getIntegration(tc.id);
        expect(integration?.apiKeyMasked || '').not.toContain('mock');
        expect(integration?.apiKeyMasked || '').not.toContain('dummy');
      });

      it(`persists valid key for integration '${tc.id}'`, () => {
        const updated = store.updateIntegration(tc.id, { apiKey: tc.validKey });
        expect(updated.apiKeyMasked).toBeDefined();

        const reloadedStore = new DashboardStore(tmpStoreFile);
        const integration = reloadedStore.getIntegration(tc.id);
        expect(integration?.apiKeyMasked).toBeDefined();
        expect(integration?.status).toBe('connected');
      });
    }
  });

  describe('5. Internal Store API Key Management (createApiKey, validateApiKey, deleteApiKey)', () => {
    it('creates formatted internal API keys, validates via hash, and persists deletion', () => {
      const created = store.createApiKey('Test Key 1');
      expect(created.id).toMatch(/^key_/);
      expect(created.rawKey).toMatch(/^ct_live_[a-f0-9]{32}$/);
      expect(created.maskedKey).toMatch(/^ct_live_\.\.\.[a-f0-9]{4}$/);

      // Validate authentic key returns true and updates lastUsedAt
      const isValid = store.validateApiKey(created.rawKey);
      expect(isValid).toBe(true);

      // Validate fake key returns false
      expect(store.validateApiKey('ct_live_fakekey000000000000000000000')).toBe(false);

      // Reload store from disk and verify key persistence
      const reloadedStore1 = new DashboardStore(tmpStoreFile);
      const keys1 = reloadedStore1.getApiKeys();
      expect(keys1.some((k) => k.id === created.id)).toBe(true);
      expect(keys1.find((k) => k.id === created.id)?.lastUsedAt).toBeDefined();

      // Delete key and verify disk persistence
      const deleted = store.deleteApiKey(created.id);
      expect(deleted).toBe(true);

      const reloadedStore2 = new DashboardStore(tmpStoreFile);
      const keys2 = reloadedStore2.getApiKeys();
      expect(keys2.some((k) => k.id === created.id)).toBe(false);
    });
  });

  describe('6. Empirical Assessment & Characterization of Store Edge Cases', () => {
    it('empirical finding 1: repeated updateProviderConfig calls fail to update providerPool due to swallowed registration error', () => {
      const key1 = 'sk-proj-valid_key_first_call_abcdef9988';
      const key2 = 'sk-proj-valid_key_second_call_abcdef9988';

      // First update registers in providerPool (using non-empty baseUrl)
      store.updateProviderConfig('openai', { apiKeyRaw: key1, baseUrl: 'https://api.openai.com/v1' });
      expect(providerPool.getProvider('openai')?.apiKey).toBe(key1);

      // Second update to same provider updates DashboardStore memory & disk...
      store.updateProviderConfig('openai', { apiKeyRaw: key2, baseUrl: 'https://api.openai.com/v1' });
      expect(store.getProviderConfig('openai')?.apiKeyRaw).toBe(key2);

      // ...BUT providerPool retains key1 because registerProvider throws 'already registered' and try-catch swallows it
      const poolEntry2 = providerPool.getProvider('openai');
      expect(poolEntry2?.apiKey).toBe(key1); // Documents the providerPool stale key edge case
    });

    it('empirical finding 2: empty string baseUrl in default provider config causes Zod validation failure in providerPool', () => {
      providerPool.removeProvider('openai');
      const keyViaApiKeyProp = 'sk-proj-valid_key_via_apikey_prop_abcdef99';

      // When updateProviderConfig is called without baseUrl override, default provider record has baseUrl: ""
      store.updateProviderConfig('openai', { apiKey: keyViaApiKeyProp });

      // DashboardStore properly sets apiKeyRaw
      expect(store.getProviderConfig('openai')?.apiKeyRaw).toBe(keyViaApiKeyProp);

      // BUT providerPool registration fails Zod schema validation because baseUrl is empty string "" (which violates min(1))
      const poolEntry = providerPool.getProvider('openai');
      expect(poolEntry).toBeUndefined(); // Documents Zod schema mismatch edge case
    });

    it('empirical finding 3: updateSettings leaves in-memory providerConfigs dirty when subsequent persona validation fails', () => {
      const initialKey = store.getProviderConfig('openai')?.apiKeyRaw;
      const dirtyKey = 'sk-proj-valid_openai_key_in_mem_check_9988';

      try {
        store.updateSettings({
          providerConfigs: {
            openai: { apiKeyRaw: dirtyKey } as any,
          },
          personaSettings: {
            security: {
              model: 'invalid-model-name-for-testing',
            } as any,
          },
        });
      } catch (_) {}

      // In-memory store reflects dirtyKey because providerConfigs was assigned at line 2150 before persona validation threw at line 2163
      expect(store.getProviderConfig('openai')?.apiKeyRaw).toBe(dirtyKey);

      // Disk state is clean (saveData was not reached)
      const reloadedStore = new DashboardStore(tmpStoreFile);
      expect(reloadedStore.getProviderConfig('openai')?.apiKeyRaw).toBe(initialKey);
    });
  });
});
