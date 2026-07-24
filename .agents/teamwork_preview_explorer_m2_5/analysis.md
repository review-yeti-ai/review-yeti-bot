# Remediation Analysis: Crypto Migration, Token Cache & Quota Concurrency (Explorer 5)

**Agent**: Explorer 5 (M2 Iteration 3 Explorer)  
**Target Project**: `ct-review-bot`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_5`  
**Date**: 2026-07-24  

---

## Executive Summary

During Iteration 2, Challenger 2 identified 2 critical defects and 1 edge case in `TokenManager`, `SecureSecretStore`, and `OmniRouteAdapter`:

1. **CRITICAL**: Unpopulated `tokenDataCache` in `TokenRefreshManager.getValidAccessToken()` (`src/router/tokenManager.ts:398-409`) returns expired access tokens directly from `SecureSecretStore` on application restart without triggering `refreshAccessToken()`.
2. **CRITICAL**: Post-Execution Spend Exception in `recordPostExecutionSpend()` (`src/router/omniRouteAdapter.ts:135-165`) throws `QuotaExhaustedError` *after* remote LLM API execution completes, discarding valid AI review responses and allowing high-concurrency remote API overshoot.
3. **EDGE CASE**: 64-Character Hex Passphrase Migration Bypass in `SecureSecretStore` (`src/router/tokenManager.ts:91, 99`) skips initializing `legacyMasterKey` when passphrase length is 64 hex characters, preventing legacy single-round SHA-256 secret migration.

This report formulates precise, line-by-line code change instructions for the Worker to fix all 3 defects, preserve existing functionality, and ensure 100% test pass rate across the test suite (`npm test`).

---

## Detailed Defect & Remediation Analysis

### Defect 1: Unpopulated `tokenDataCache` Returns Expired OAuth Tokens

#### 1. Root Cause Analysis
- **File**: `src/router/tokenManager.ts` (lines 391–421)
- **Problem**: In `TokenRefreshManager.getValidAccessToken(providerId, fetchFn)`, when `tokenDataCache` is unpopulated (e.g. after process restart or before token state rehydration):
  ```typescript
  if (!tokenData) {
    const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
    if (storedToken) return storedToken; // <--- BUG: Returns unvalidated, expired token!
    ...
  }
  ```
  If `storedToken` exists in `secretStore`, `getValidAccessToken()` immediately returns `storedToken` without verifying expiration or populating `tokenDataCache`. `refreshAccessToken` is never called, leaving the application with an expired OAuth token that fails on downstream LLM API calls with HTTP 401 Unauthorized.

#### 2. Proposed Code Fix
Modify `getValidAccessToken()` in `src/router/tokenManager.ts` so that when `tokenData` is undefined:
1. First check if a `TokenRefreshConfig` or refresh token (`oauth_refresh_${providerId}` in `secretStore` or `config.refreshToken`) is registered.
2. If refresh capability exists, invoke `this.refreshAccessToken(providerId, fetchFn)` to fetch a fresh token, populate `tokenDataCache`, and update `secretStore`.
3. If NO refresh configuration/token exists, fall back to returning `storedToken` from `secretStore`.
4. If neither exists, throw the standard error.

**Exact Code Replacement in `src/router/tokenManager.ts` (lines 398–411)**:
```typescript
    if (!tokenData) {
      const hasRefreshToken = Boolean(
        this.secretStore.getSecret(`oauth_refresh_${providerId}`) || config?.refreshToken
      );

      if (config && (config.customRefreshHandler || config.tokenUrl || hasRefreshToken)) {
        return this.refreshAccessToken(providerId, fetchFn);
      }

      const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
      if (storedToken) return storedToken;

      throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
    }
```

---

### Defect 2: Post-Execution Spend Exception Discards Responses & Permits Quota Overshoot

#### 1. Root Cause Analysis
- **File**: `src/router/omniRouteAdapter.ts` (lines 120–165, adapter `execute()` methods)
- **Problem**:
  1. `recordPostExecutionSpend()` is executed *after* remote LLM HTTP API calls finish. If `newSpend > monthlyLimitUSD`, `recordPostExecutionSpend()` throws `QuotaExhaustedError`. This causes `adapter.execute()` to reject, throwing away the completed LLM completion response despite the external API already incurring financial charges.
  2. Under high concurrency, 10+ concurrent requests pass `checkPreExecutionQuota()` because `currentSpendUSD` has not been updated yet. All 10 requests execute remote API calls simultaneously, overshooting monthly budget limits by up to 200–300%, and then ALL 10 requests reject post-execution, discarding all responses.

#### 2. Proposed Code Fix
1. Update `recordPostExecutionSpend()` in `src/router/omniRouteAdapter.ts`:
   - NEVER throw `QuotaExhaustedError` inside `recordPostExecutionSpend()`.
   - Accumulate `currentSpendUSD`, log a warning (`logger.warn`) if `currentSpendUSD >= monthlyLimitUSD`, and return `costEstimateUSD`.
2. Add optional pre-execution budget reservation (`reservedSpendUSD?: number` in `ExtraUsageTierConfig`) and helper functions `reservePreExecutionSpend` and `releasePreExecutionReservation`:
   - `checkPreExecutionQuota()` checks `(currentSpendUSD + reservedSpendUSD) >= monthlyLimitUSD`.
   - Adapters reserve estimated spend before dispatching HTTP fetch, and release reservation in `finally`.
   - Subsequent callers hitting `checkPreExecutionQuota()` will be rejected BEFORE sending HTTP fetch requests once spend limit is reached or reserved.

**Exact Code Replacements in `src/router/omniRouteAdapter.ts`**:

1. Update `ExtraUsageTierConfig` interface (line 14):
```typescript
export interface ExtraUsageTierConfig {
  enabled: boolean;
  monthlyLimitUSD?: number;
  currentSpendUSD?: number;
  reservedSpendUSD?: number;
  costPer1kPromptTokens: number;
  costPer1kCompletionTokens: number;
}
```

2. Update `checkPreExecutionQuota` and add reservation helpers (lines 120–134):
```typescript
export function checkPreExecutionQuota(config: ProviderConfig): void {
  if (
    config.extraUsageTier?.enabled &&
    config.extraUsageTier.monthlyLimitUSD !== undefined
  ) {
    const current = config.extraUsageTier.currentSpendUSD || 0;
    const reserved = config.extraUsageTier.reservedSpendUSD || 0;
    if (current + reserved >= config.extraUsageTier.monthlyLimitUSD) {
      throw new QuotaExhaustedError(
        `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) already reached or reserved for provider: ${config.id}`,
        config.id
      );
    }
  }
}

export function reservePreExecutionSpend(config: ProviderConfig, estimatedUSD: number = 0.005): void {
  checkPreExecutionQuota(config);
  if (config.extraUsageTier?.enabled) {
    config.extraUsageTier.reservedSpendUSD = Number(
      ((config.extraUsageTier.reservedSpendUSD || 0) + estimatedUSD).toFixed(6)
    );
  }
}

export function releasePreExecutionReservation(config: ProviderConfig, estimatedUSD: number = 0.005): void {
  if (config.extraUsageTier?.enabled && config.extraUsageTier.reservedSpendUSD) {
    config.extraUsageTier.reservedSpendUSD = Math.max(
      0,
      Number((config.extraUsageTier.reservedSpendUSD - estimatedUSD).toFixed(6))
    );
  }
}
```

3. Update `recordPostExecutionSpend` (lines 135–165):
```typescript
export function recordPostExecutionSpend(
  config: ProviderConfig,
  tokensUsed: LLMTokensUsed
): number | undefined {
  if (
    config.billingTier === 'usage_based' ||
    (config.billingTier === 'extra_usage_tier' && config.extraUsageTier?.enabled)
  ) {
    const promptCost = config.extraUsageTier?.costPer1kPromptTokens ?? 0.0015;
    const completionCost = config.extraUsageTier?.costPer1kCompletionTokens ?? 0.002;
    const costEstimateUSD = calculateTokenCost(tokensUsed, promptCost, completionCost);

    if (config.extraUsageTier?.enabled) {
      const current = config.extraUsageTier.currentSpendUSD || 0;
      const newSpend = Number((current + costEstimateUSD).toFixed(6));
      config.extraUsageTier.currentSpendUSD = newSpend;

      if (
        config.extraUsageTier.monthlyLimitUSD !== undefined &&
        newSpend >= config.extraUsageTier.monthlyLimitUSD
      ) {
        logger.warn(
          `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) reached/exceeded for ${config.id} (current spend: $${newSpend})`
        );
      }
    }
    return costEstimateUSD;
  }
  return undefined;
}
```

4. Update each provider adapter's `execute()` method (`OmniRouteGatewayAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`, `DeepSeekAdapter`) to wrap execution in `try ... finally` block with reservation:
```typescript
  async execute(request: LLMRequest, fetchFn: typeof fetch): Promise<LLMResponse> {
    const estimatedUSD = 0.005;
    reservePreExecutionSpend(this.config, estimatedUSD);

    try {
      // ... HTTP fetch and parsing ...
      const costEstimateUSD = recordPostExecutionSpend(this.config, tokensUsed);
      return { ... };
    } finally {
      releasePreExecutionReservation(this.config, estimatedUSD);
    }
  }
```

---

### Defect 3: 64-Character Hex Passphrase Skips Legacy Master Key Initialization

#### 1. Root Cause Analysis
- **File**: `src/router/tokenManager.ts` (lines 90–105)
- **Problem**: In `SecureSecretStore` constructor:
  ```typescript
  if (masterKeyHex) {
    if (masterKeyHex.length === 64 && /^[0-9a-fA-F]+$/.test(masterKeyHex)) {
      this.masterKey = Buffer.from(masterKeyHex, 'hex');
    } else {
      this.masterKey = crypto.pbkdf2Sync(masterKeyHex, this.salt, 100000, 32, 'sha256');
      this.legacyMasterKey = crypto.createHash('sha256').update(masterKeyHex).digest();
    }
  }
  ```
  If `masterKeyHex` is a 64-character hexadecimal string, `this.legacyMasterKey` is skipped and left `undefined`. If secrets were previously encrypted using single-round SHA-256 of that hex string, `getSecret()` fails to decipher them and returns `null`.

#### 2. Proposed Code Fix
Always initialize `this.legacyMasterKey = crypto.createHash('sha256').update(passphrase).digest()` whenever a string passphrase (`masterKeyHex` or `process.env.CT_SECRET_MASTER_KEY`) is supplied.

**Exact Code Replacement in `src/router/tokenManager.ts` (lines 90–107)**:
```typescript
    if (masterKeyHex) {
      this.legacyMasterKey = crypto.createHash('sha256').update(masterKeyHex).digest();
      if (masterKeyHex.length === 64 && /^[0-9a-fA-F]+$/.test(masterKeyHex)) {
        this.masterKey = Buffer.from(masterKeyHex, 'hex');
      } else {
        this.masterKey = crypto.pbkdf2Sync(masterKeyHex, this.salt, 100000, 32, 'sha256');
      }
    } else if (process.env.CT_SECRET_MASTER_KEY) {
      const envKey = process.env.CT_SECRET_MASTER_KEY;
      this.legacyMasterKey = crypto.createHash('sha256').update(envKey).digest();
      if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
        this.masterKey = Buffer.from(envKey, 'hex');
      } else {
        this.masterKey = crypto.pbkdf2Sync(envKey, this.salt, 100000, 32, 'sha256');
      }
    } else {
      this.masterKey = crypto.randomBytes(32);
    }
```

---

## Test Suite Alignment & Verification

To verify that the remediation works seamlessly, test assertions in `tests/unit/m2_challenger_token_crypto_stress.test.ts` and `tests/unit/omniRoute.test.ts` should be aligned with the fixed non-discarding quota behavior and working 64-char hex migration:

1. **Test 1.4 in `m2_challenger_token_crypto_stress.test.ts`**:
   Update assertion from `expect(result).toBeNull()` to `expect(result).toBe('legacy-secret')` to confirm legacy SHA-256 secret is successfully decrypted and migrated when masterKey is 64 hex chars.
2. **Test 2.1 in `m2_challenger_token_crypto_stress.test.ts`**:
   Update assertions to verify `getValidAccessToken()` returns `'newly-refreshed-access-token-999'`, `refreshHandlerCallCount` is `1`, and `tokenDataCache` is populated.
3. **Test 3.3 in `m2_challenger_token_crypto_stress.test.ts`**:
   Update assertion so that `adapter.execute()` succeeds returning the completed response payload, updates `currentSpendUSD`, and subsequent `checkPreExecutionQuota()` throws `QuotaExhaustedError`.
4. **Test 3.4 in `m2_challenger_token_crypto_stress.test.ts`**:
   Update assertion to confirm completed responses are not discarded, and pre-execution quota reservation/check prevents unlimited overshoot.

---

## Summary of Actionable Implementation Instructions for Worker

| Target File | Change Area | Rationale |
|---|---|---|
| `src/router/tokenManager.ts` | Constructor of `SecureSecretStore` | Set `legacyMasterKey` for all string passphrases (including 64-char hex) |
| `src/router/tokenManager.ts` | `TokenRefreshManager.getValidAccessToken()` | Trigger `refreshAccessToken()` when `tokenDataCache` is empty and refresh config exists |
| `src/router/omniRouteAdapter.ts` | `recordPostExecutionSpend()` & `checkPreExecutionQuota()` | Remove post-execution throw, add pre-execution spend reservation |
| `src/router/omniRouteAdapter.ts` | Provider Adapter `execute()` methods | Wrap execution in `try ... finally` with pre-execution spend reservation & release |
| `tests/unit/m2_challenger_token_crypto_stress.test.ts` | Tests 1.4, 2.1, 3.3, 3.4 | Update test assertions to verify corrected, non-buggy production behaviors |
