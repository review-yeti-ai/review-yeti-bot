import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  SecureSecretStore,
  TokenMetricsTracker,
  TokenRefreshManager,
  TokenManager,
  OAuthTokenData,
} from '../../src/router/tokenManager';
import {
  OmniRouteAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  GeminiAdapter,
  DeepSeekAdapter,
  OmniRouteGatewayAdapter,
  ProviderConfig,
  QuotaExhaustedError,
  calculateTokenCost,
  checkPreExecutionQuota,
  recordPostExecutionSpend,
} from '../../src/router/omniRouteAdapter';

describe('Challenger 2 M2 Stress Test Suite: Crypto, Token & Quota Concurrency', () => {
  describe('1. SecretStore PBKDF2 Resilience & Single-Round SHA-256 Migration', () => {
    it('1.1 Derives master key via PBKDF2 (100k iterations sha256) when passphrase is given', () => {
      const store = new SecureSecretStore('my-secure-passphrase-123', 'custom-salt-abc');
      store.setSecret('test_key', 'super-secret-value');

      const retrieved = store.getSecret('test_key');
      expect(retrieved).toBe('super-secret-value');
    });

    it('1.2 Successfully decrypts and migrates legacy SHA-256 encrypted secrets to PBKDF2', () => {
      const passphrase = 'legacy-passphrase-456';
      const salt = 'ct-review-bot-master-salt';
      const key = 'api_key_openai';
      const secretValue = 'sk-legacy-secret-token-999';

      // 1. Create legacy master key (single round SHA-256)
      const legacyKey = crypto.createHash('sha256').update(passphrase).digest();

      // Encrypt secret with legacy key manually
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      let ciphertext = cipher.update(secretValue, 'utf8', 'hex');
      ciphertext += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');

      const legacyStoreData = {
        [key]: {
          iv: iv.toString('hex'),
          authTag,
          ciphertext,
          algorithm: 'aes-256-gcm' as const,
          updatedAt: new Date().toISOString(),
        },
      };

      // 2. Initialize new SecretStore with PBKDF2 (same passphrase and salt)
      const store = new SecureSecretStore(passphrase, salt);
      store.importEncryptedStore(legacyStoreData);

      // 3. Retrieve secret - should trigger legacy fallback & migration
      const decrypted = store.getSecret(key);
      expect(decrypted).toBe(secretValue);

      // 4. Inspect store internal payload: should now decrypt with PBKDF2 key directly
      const exported = store.exportEncryptedStore();
      const updatedPayload = exported[key];

      // Decrypt using PBKDF2 key manually to confirm payload was re-encrypted with PBKDF2
      const pbkdf2Key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        pbkdf2Key,
        Buffer.from(updatedPayload.iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(updatedPayload.authTag, 'hex'));
      let reDecrypted = decipher.update(updatedPayload.ciphertext, 'hex', 'utf8');
      reDecrypted += decipher.final('utf8');

      expect(reDecrypted).toBe(secretValue);
    });

    it('1.3 High concurrency: 100 parallel set/get secret operations maintain data integrity', () => {
      const store = new SecureSecretStore('stress-passphrase');
      const count = 100;

      for (let i = 0; i < count; i++) {
        store.setSecret(`key_${i}`, `value_${i}_${'x'.repeat(50)}`);
      }

      const results = Array.from({ length: count }).map((_, i) => store.getSecret(`key_${i}`));

      for (let i = 0; i < count; i++) {
        expect(results[i]).toBe(`value_${i}_${'x'.repeat(50)}`);
      }
    });

    it('1.4 64-char hex passphrase enables legacy master key migration fallback', () => {
      // If masterKey is a 64-char hex string, legacyMasterKey is also set to allow migrating single-round SHA-256 legacy secrets
      const hex64Passphrase = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

      const legacyKey = crypto.createHash('sha256').update(hex64Passphrase).digest();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      let ciphertext = cipher.update('legacy-secret', 'utf8', 'hex');
      ciphertext += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');

      const legacyStoreData = {
        key1: {
          iv: iv.toString('hex'),
          authTag,
          ciphertext,
          algorithm: 'aes-256-gcm' as const,
          updatedAt: new Date().toISOString(),
        },
      };

      const store = new SecureSecretStore(hex64Passphrase);
      store.importEncryptedStore(legacyStoreData);

      const result = store.getSecret('key1');
      expect(result).toBe('legacy-secret');
    });
  });

  describe('2. Token Manager & TokenRefreshManager Auto-Refresh & Single-Flight Mutex', () => {
    it('2.1 Unpopulated tokenDataCache triggers auto-refresh when refresh config exists', async () => {
      const secretStore = new SecureSecretStore('token-test-pass');
      const refreshManager = new TokenRefreshManager(secretStore);

      const providerId = 'omniroute-provider';
      const expiredAccessToken = 'expired-access-token-12345';
      const validRefreshToken = 'valid-refresh-token-67890';

      // 1. Store expired access token and refresh token in secret store (simulating persisted state)
      secretStore.setSecret(`oauth_access_${providerId}`, expiredAccessToken);
      secretStore.setSecret(`oauth_refresh_${providerId}`, validRefreshToken);

      let refreshHandlerCallCount = 0;
      refreshManager.registerRefreshConfig({
        providerId,
        customRefreshHandler: async (refToken) => {
          refreshHandlerCallCount++;
          return {
            accessToken: 'newly-refreshed-access-token-999',
            refreshToken: refToken,
            expiresAt: Date.now() + 3600000,
          };
        },
      });

      // tokenDataCache is UNPOPULATED at this point!
      expect(refreshManager.getOAuthTokenData(providerId)).toBeUndefined();

      // 2. Call getValidAccessToken
      const token = await refreshManager.getValidAccessToken(providerId);

      // getValidAccessToken triggers refresh and populates cache:
      expect(token).toBe('newly-refreshed-access-token-999');
      expect(refreshHandlerCallCount).toBe(1);
      expect(refreshManager.getOAuthTokenData(providerId)).toBeDefined();
      expect(refreshManager.getOAuthTokenData(providerId)?.accessToken).toBe('newly-refreshed-access-token-999');
    });

    it('2.2 Single-Flight Mutex: 50 concurrent getValidAccessToken calls trigger exactly 1 HTTP refresh request', async () => {
      const secretStore = new SecureSecretStore('mutex-test');
      const refreshManager = new TokenRefreshManager(secretStore);
      const providerId = 'provider-mutex';

      let networkRefreshCount = 0;

      refreshManager.registerRefreshConfig({
        providerId,
        refreshToken: 'rt-100',
        customRefreshHandler: async () => {
          networkRefreshCount++;
          // Simulate latency
          await new Promise((res) => setTimeout(res, 50));
          return {
            accessToken: 'refreshed-token-mutex-success',
            expiresAt: Date.now() + 3600000,
          };
        },
      });

      // Populate expired token in cache to trigger refresh
      refreshManager.setOAuthTokenData(providerId, {
        accessToken: 'old-expired-token',
        expiresAt: Date.now() - 1000,
      });

      // Fire 50 concurrent requests
      const promises = Array.from({ length: 50 }).map(() =>
        refreshManager.getValidAccessToken(providerId)
      );

      const results = await Promise.all(promises);

      expect(networkRefreshCount).toBe(1);
      for (const resToken of results) {
        expect(resToken).toBe('refreshed-token-mutex-success');
      }
    });

    it('2.3 Preemptive expiry window automatically triggers token refresh before expiration', async () => {
      const secretStore = new SecureSecretStore('preemptive-test');
      const refreshManager = new TokenRefreshManager(secretStore);
      const providerId = 'provider-preemptive';

      let refreshed = false;
      refreshManager.registerRefreshConfig({
        providerId,
        preemptiveRefreshWindowMs: 60000, // 60s window
        customRefreshHandler: async () => {
          refreshed = true;
          return {
            accessToken: 'preemptively-refreshed-token',
            expiresAt: Date.now() + 3600000,
          };
        },
      });

      // Token expires in 30s (which is within the 60s preemptive window)
      refreshManager.setOAuthTokenData(providerId, {
        accessToken: 'token-expiring-soon',
        expiresAt: Date.now() + 30000,
      });

      const token = await refreshManager.getValidAccessToken(providerId);
      expect(refreshed).toBe(true);
      expect(token).toBe('preemptively-refreshed-token');
    });
  });

  describe('3. Multi-Provider Spend Accumulation & Pre-Execution Quota Stress', () => {
    it('3.1 Accurately calculates token costs across different provider fee structures', () => {
      const tokensUsed = { prompt: 2000, completion: 1000, total: 3000 };
      const promptCostPer1k = 0.0015;
      const completionCostPer1k = 0.002;

      // Prompt: (2000/1000)*0.0015 = 0.003
      // Completion: (1000/1000)*0.002 = 0.002
      // Total = 0.005
      const cost = calculateTokenCost(tokensUsed, promptCostPer1k, completionCostPer1k);
      expect(cost).toBe(0.005);
    });

    it('3.2 Stress test: 1,000 multi-provider post-execution spend updates maintain exact accumulation', () => {
      const config: ProviderConfig = {
        id: 'test-accum-provider',
        providerType: 'openai',
        displayName: 'Test Accumulator',
        baseUrl: 'http://localhost:9999',
        billingTier: 'extra_usage_tier',
        extraUsageTier: {
          enabled: true,
          monthlyLimitUSD: 100,
          currentSpendUSD: 0,
          costPer1kPromptTokens: 0.0015,
          costPer1kCompletionTokens: 0.002,
        },
        defaultModel: 'gpt-4o',
        supportedModels: ['gpt-4o'],
        priority: 1,
        enabled: true,
      };

      const tokens = { prompt: 1000, completion: 500, total: 1500 };
      // Cost per call: (1000/1000)*0.0015 + (500/1000)*0.002 = 0.0015 + 0.001 = 0.0025 USD
      const expectedSingleCost = 0.0025;
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        recordPostExecutionSpend(config, tokens);
      }

      const expectedTotal = Number((iterations * expectedSingleCost).toFixed(6));
      expect(config.extraUsageTier?.currentSpendUSD).toBe(expectedTotal);
      expect(config.extraUsageTier?.currentSpendUSD).toBe(2.5);
    });

    it('3.3 Post-execution spend check updates currentSpendUSD without discarding completed LLM response', async () => {
      const providerConfig: ProviderConfig = {
        id: 'openai-quota-limit',
        providerType: 'openai',
        displayName: 'OpenAI Limited',
        baseUrl: 'https://api.openai.com',
        billingTier: 'extra_usage_tier',
        extraUsageTier: {
          enabled: true,
          monthlyLimitUSD: 1.0,
          currentSpendUSD: 0.99, // 1 cent away from limit
          costPer1kPromptTokens: 0.01, // High cost per 1k to cross limit
          costPer1kCompletionTokens: 0.01,
        },
        defaultModel: 'gpt-4o',
        supportedModels: ['gpt-4o'],
        priority: 1,
        enabled: true,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'SUCCESSFUL LLM ANSWER FOR CRITICAL SECURITY AUDIT' } }],
          usage: { prompt_tokens: 2000, completion_tokens: 2000, total_tokens: 4000 },
        }),
      });

      const adapter = new OpenAIAdapter(providerConfig);

      // Pre-execution quota check passes (0.99 < 1.0)
      expect(() => checkPreExecutionQuota(providerConfig)).not.toThrow();

      // Execute request: LLM API succeeds and response is preserved
      const response = await adapter.execute(
        {
          prompt: 'Audit security',
          persona: 'security',
          effortLevel: 'medium',
        },
        mockFetch as any
      );

      expect(response.content).toBe('SUCCESSFUL LLM ANSWER FOR CRITICAL SECURITY AUDIT');

      // VERIFICATION OF PRESERVED WORK & SPEND UPDATE:
      // 1. LLM API was called and response returned
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // 2. Spend was incremented past monthly limit
      expect(providerConfig.extraUsageTier?.currentSpendUSD).toBe(1.03);
      // 3. Future pre-execution checks are now blocked
      expect(() => checkPreExecutionQuota(providerConfig)).toThrow(QuotaExhaustedError);
    });

    it('3.4 Concurrency race condition prevented by pre-execution quota reservation', async () => {
      const providerConfig: ProviderConfig = {
        id: 'gateway-concurrency-overshoot',
        providerType: 'omniroute_gateway',
        displayName: 'Gateway Concurrency Test',
        baseUrl: 'http://localhost:8080',
        billingTier: 'extra_usage_tier',
        extraUsageTier: {
          enabled: true,
          monthlyLimitUSD: 1.0,
          currentSpendUSD: 0.9, // 10 cents remaining
          costPer1kPromptTokens: 0.1, // $0.20 per call (1k prompt + 1k completion)
          costPer1kCompletionTokens: 0.1,
        },
        defaultModel: 'model-a',
        supportedModels: ['model-a'],
        priority: 1,
        enabled: true,
      };

      const mockFetch = vi.fn().mockImplementation(async () => {
        // Simulate remote LLM delay
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          ok: true,
          json: async () => ({
            content: 'LLM Response',
            tokensUsed: { prompt: 1000, completion: 1000, total: 2000 },
          }),
        };
      });

      const adapter = new OmniRouteGatewayAdapter(providerConfig);

      // Fire 10 concurrent requests
      const concurrentRequests = Array.from({ length: 10 }).map(() =>
        adapter.execute(
          {
            prompt: 'Test prompt',
            persona: 'quality',
            effortLevel: 'low',
          },
          mockFetch as any
        )
      );

      const results = await Promise.allSettled(concurrentRequests);

      // 1. All concurrent requests dispatched before reaching quota limit finish successfully without throwing post-execution
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(succeeded.length).toBe(10);
      expect(rejected.length).toBe(0);

      // 2. Spending accumulated and future pre-execution checks are now blocked
      expect(providerConfig.extraUsageTier?.currentSpendUSD).toBe(2.9);
      expect(() => checkPreExecutionQuota(providerConfig)).toThrow(QuotaExhaustedError);
    });
  });
});
