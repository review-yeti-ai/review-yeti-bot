import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SecureSecretStore,
  TokenMetricsTracker,
  EffortScaler,
  TokenManager,
  OAuthTokenData,
  EncryptedPayload,
} from '../../src/router/tokenManager';

describe('TokenManager Subsystem Unit Tests', () => {
  describe('SecureSecretStore (AES-256-GCM)', () => {
    it('encrypts and decrypts secrets correctly', () => {
      const store = new SecureSecretStore();
      const key = 'openai_api_key';
      const secret = 'sk-proj-test1234567890abcdef';

      store.setSecret(key, secret);
      expect(store.hasSecret(key)).toBe(true);

      const decrypted = store.getSecret(key);
      expect(decrypted).toBe(secret);
    });

    it('derives key via PBKDF2 for non-hex passphrases and supports custom salt', () => {
      const passphrase = 'my-super-secret-passphrase';
      const salt = 'custom-salt-123';
      const store = new SecureSecretStore(passphrase, salt);
      store.setSecret('key1', 'secret-value-1');

      // Second store with same passphrase and salt can decrypt
      const store2 = new SecureSecretStore(passphrase, salt);
      store2.importEncryptedStore(store.exportEncryptedStore());
      expect(store2.getSecret('key1')).toBe('secret-value-1');

      // Store with different salt fails decryption
      const store3 = new SecureSecretStore(passphrase, 'different-salt');
      store3.importEncryptedStore(store.exportEncryptedStore());
      expect(store3.getSecret('key1')).toBeNull();
    });

    it('decrypts legacy single-round SHA-256 encrypted secrets and auto-migrates to PBKDF2', () => {
      const passphrase = 'legacy-passphrase';
      const defaultSalt = 'ct-review-bot-master-salt';
      const legacyKey = crypto.createHash('sha256').update(passphrase).digest();

      // Manually craft payload encrypted with legacy single-round SHA-256 key
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      let ciphertext = cipher.update('legacy-secret-payload', 'utf8', 'hex');
      ciphertext += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');

      const legacyPayload: EncryptedPayload = {
        iv: iv.toString('hex'),
        authTag,
        ciphertext,
        algorithm: 'aes-256-gcm',
        updatedAt: new Date().toISOString(),
      };

      // Instantiate store with passphrase (masterKey uses PBKDF2, legacyMasterKey uses SHA-256)
      const store = new SecureSecretStore(passphrase);
      store.importEncryptedStore({ legacy_item: legacyPayload });

      // First getSecret triggers fallback and transparent re-encryption to PBKDF2
      const decrypted = store.getSecret('legacy_item');
      expect(decrypted).toBe('legacy-secret-payload');

      // Verify that after migration, a store initialized without legacyMasterKey but with PBKDF2 key can decrypt it
      const exportedAfterMigration = store.exportEncryptedStore();
      const pbkdf2KeyOnly = crypto.pbkdf2Sync(passphrase, Buffer.from(defaultSalt, 'utf8'), 100000, 32, 'sha256');
      const hexPBKDF2Store = new SecureSecretStore(pbkdf2KeyOnly.toString('hex'));
      hexPBKDF2Store.importEncryptedStore(exportedAfterMigration);
      expect(hexPBKDF2Store.getSecret('legacy_item')).toBe('legacy-secret-payload');
    });

    it('returns null for non-existent secret', () => {
      const store = new SecureSecretStore();
      expect(store.getSecret('non_existent')).toBeNull();
    });

    it('returns null if authTag or payload is corrupted', () => {
      const store = new SecureSecretStore();
      store.setSecret('testKey', 'my-secret-val');

      const exported = store.exportEncryptedStore();
      expect(exported['testKey']).toBeDefined();

      // Corrupt auth tag
      exported['testKey'].authTag = '00000000000000000000000000000000';

      const store2 = new SecureSecretStore();
      store2.importEncryptedStore(exported);
      expect(store2.getSecret('testKey')).toBeNull();
    });

    it('exports and imports encrypted store payload', () => {
      const store1 = new SecureSecretStore('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      store1.setSecret('key1', 'secret1');
      store1.setSecret('key2', 'secret2');

      const exported = store1.exportEncryptedStore();

      const store2 = new SecureSecretStore('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      store2.importEncryptedStore(exported);

      expect(store2.getSecret('key1')).toBe('secret1');
      expect(store2.getSecret('key2')).toBe('secret2');
    });

    it('deletes secrets correctly', () => {
      const store = new SecureSecretStore();
      store.setSecret('temp', 'val');
      expect(store.hasSecret('temp')).toBe(true);
      expect(store.deleteSecret('temp')).toBe(true);
      expect(store.hasSecret('temp')).toBe(false);
    });
  });

  describe('TokenMetricsTracker', () => {
    let tracker: TokenMetricsTracker;

    beforeEach(() => {
      tracker = new TokenMetricsTracker();
    });

    it('records usage and calculates per-persona metrics', () => {
      tracker.recordUsage({
        requestId: 'req-1',
        persona: 'security',
        effortLevel: 'high',
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        durationMs: 150,
        timestamp: new Date().toISOString(),
      });

      tracker.recordUsage({
        requestId: 'req-2',
        persona: 'security',
        effortLevel: 'medium',
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 200,
        completionTokens: 400,
        totalTokens: 600,
        durationMs: 250,
        timestamp: new Date().toISOString(),
      });

      const metrics = tracker.getPersonaMetrics('security');
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.promptTokens).toBe(300);
      expect(metrics.completionTokens).toBe(600);
      expect(metrics.totalTokens).toBe(900);
      expect(metrics.averageTokensPerRequest).toBe(450);
      expect(metrics.averageDurationMs).toBe(200);
    });

    it('calculates global metrics across all personas and providers', () => {
      tracker.recordUsage({
        requestId: 'req-1',
        persona: 'security',
        effortLevel: 'high',
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 100,
        completionTokens: 100,
        totalTokens: 200,
        durationMs: 100,
        timestamp: new Date().toISOString(),
      });

      tracker.recordUsage({
        requestId: 'req-2',
        persona: 'architecture',
        effortLevel: 'medium',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        promptTokens: 300,
        completionTokens: 300,
        totalTokens: 600,
        durationMs: 200,
        timestamp: new Date().toISOString(),
      });

      const global = tracker.getGlobalMetrics();
      expect(global.totalRequests).toBe(2);
      expect(global.totalTokens).toBe(800);
      expect(global.byPersona.security.totalRequests).toBe(1);
      expect(global.byPersona.architecture.totalRequests).toBe(1);
      expect(global.byPersona.performance.totalRequests).toBe(0);

      expect(global.byProvider['openai']).toEqual({ totalRequests: 1, totalTokens: 200 });
      expect(global.byProvider['anthropic']).toEqual({ totalRequests: 1, totalTokens: 600 });
    });

    it('resets metrics correctly', () => {
      tracker.recordUsage({
        requestId: 'req-1',
        persona: 'quality',
        effortLevel: 'low',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        promptTokens: 50,
        completionTokens: 50,
        totalTokens: 100,
        durationMs: 50,
        timestamp: new Date().toISOString(),
      });

      tracker.resetMetrics();
      const global = tracker.getGlobalMetrics();
      expect(global.totalRequests).toBe(0);
      expect(global.totalTokens).toBe(0);
    });
  });

  describe('EffortScaler', () => {
    it('returns base matrix config for effort levels', () => {
      const lowCfg = EffortScaler.getEffortConfig('low');
      expect(lowCfg.effortLevel).toBe('low');
      expect(lowCfg.maxOutputTokens).toBe(1000);
      expect(lowCfg.temperature).toBe(0.1);

      const highCfg = EffortScaler.getEffortConfig('high');
      expect(highCfg.effortLevel).toBe('high');
      expect(highCfg.maxOutputTokens).toBe(8000);
      expect(highCfg.temperature).toBe(0.3);
    });

    it('promotes security persona from medium to high', () => {
      const cfg = EffortScaler.getEffortConfig('medium', 'security');
      expect(cfg.effortLevel).toBe('high');
    });

    it('promotes effort tier for diffs > 500 lines', () => {
      const cfgLow = EffortScaler.getEffortConfig('low', 'quality', 600);
      expect(cfgLow.effortLevel).toBe('medium');

      const cfgMed = EffortScaler.getEffortConfig('medium', 'quality', 600);
      expect(cfgMed.effortLevel).toBe('high');

      const cfgHigh = EffortScaler.getEffortConfig('high', 'quality', 600);
      expect(cfgHigh.effortLevel).toBe('reasoning');
    });

    it('formats provider-specific reasoning parameters', () => {
      const openaiCfg = EffortScaler.getEffortConfig('high', undefined, undefined, 'openai');
      expect(openaiCfg.providerExtraParams.reasoning_effort).toBe('medium');

      const anthropicCfg = EffortScaler.getEffortConfig('reasoning', undefined, undefined, 'anthropic');
      expect(anthropicCfg.providerExtraParams.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 4096,
      });
    });
  });

  describe('TokenRefreshManager & Single-Flight Mutex', () => {
    it('retrieves static API key when present', async () => {
      const tm = new TokenManager();
      tm.setSecretKey('api_key_openai', 'sk-static-test-key');
      const token = await tm.getValidAccessToken('openai');
      expect(token).toBe('sk-static-test-key');
    });

    it('returns cached OAuth token if not expiring soon', async () => {
      const tm = new TokenManager();
      tm.setOAuthTokenData('anthropic', {
        accessToken: 'access-123',
        refreshToken: 'refresh-123',
        expiresAt: Date.now() + 3600000,
      });

      const token = await tm.getValidAccessToken('anthropic');
      expect(token).toBe('access-123');
    });

    it('preemptively refreshes token when within expiry window', async () => {
      const tm = new TokenManager();
      const customHandler = vi.fn().mockImplementation(async (rToken: string): Promise<OAuthTokenData> => {
        return {
          accessToken: 'new-access-456',
          refreshToken: rToken,
          expiresAt: Date.now() + 3600000,
        };
      });

      tm.registerRefreshConfig({
        providerId: 'google',
        preemptiveRefreshWindowMs: 60000,
        customRefreshHandler: customHandler,
      });

      tm.setOAuthTokenData('google', {
        accessToken: 'old-access-123',
        refreshToken: 'refresh-999',
        expiresAt: Date.now() + 30000, // expiring in 30s < 60s window
      });

      const token = await tm.getValidAccessToken('google');
      expect(token).toBe('new-access-456');
      expect(customHandler).toHaveBeenCalledTimes(1);
      expect(customHandler).toHaveBeenCalledWith('refresh-999');
    });

    it('single-flight mutex: concurrent requests invoke refresh handler only once', async () => {
      const tm = new TokenManager();

      let calls = 0;
      const customHandler = vi.fn().mockImplementation(async (): Promise<OAuthTokenData> => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          accessToken: `token-call-${calls}`,
          expiresAt: Date.now() + 3600000,
        };
      });

      tm.registerRefreshConfig({
        providerId: 'deepseek',
        customRefreshHandler: customHandler,
      });

      tm.setOAuthTokenData('deepseek', {
        accessToken: 'expired-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Date.now() - 1000, // expired
      });

      const results = await Promise.all([
        tm.getValidAccessToken('deepseek'),
        tm.getValidAccessToken('deepseek'),
        tm.getValidAccessToken('deepseek'),
        tm.getValidAccessToken('deepseek'),
        tm.getValidAccessToken('deepseek'),
      ]);

      expect(customHandler).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        'token-call-1',
        'token-call-1',
        'token-call-1',
        'token-call-1',
        'token-call-1',
      ]);
    });

    it('automatically triggers refreshAccessToken when tokenDataCache is unpopulated', async () => {
      const tm = new TokenManager();

      const customHandler = vi.fn().mockImplementation(async (rToken: string): Promise<OAuthTokenData> => {
        return {
          accessToken: 'freshly-refreshed-token-789',
          refreshToken: rToken || 'fallback-refresh',
          expiresAt: Date.now() + 3600000,
        };
      });

      tm.registerRefreshConfig({
        providerId: 'unpopulated-provider',
        refreshToken: 'stored-refresh-token',
        customRefreshHandler: customHandler,
      });

      // tokenDataCache is NOT populated via setOAuthTokenData
      const token = await tm.getValidAccessToken('unpopulated-provider');
      expect(token).toBe('freshly-refreshed-token-789');
      expect(customHandler).toHaveBeenCalledTimes(1);
      expect(customHandler).toHaveBeenCalledWith('stored-refresh-token');
    });
  });
});
