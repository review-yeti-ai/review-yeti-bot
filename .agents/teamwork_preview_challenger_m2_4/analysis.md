# Challenge & Stress Test Report: Crypto, Token Concurrency & Spend Accumulation

**Agent**: Challenger 2 (Empirical Stress Tester & Critic)  
**Milestone**: Milestone 2 Iteration 2  
**Target Project**: `ct-review-bot`  
**Date**: 2026-07-24  
**Verdict**: **FAIL** (2 Critical Vulnerabilities Discovered)

---

## Executive Summary

As Challenger 2, an empirical stress testing suite (`tests/unit/m2_challenger_token_crypto_stress.test.ts`) comprising 11 high-concurrency, edge-case, and boundary scenarios was designed, executed, and integrated into the project test runner. All 184 tests across 17 test files in the project pass cleanly.

While PBKDF2 key derivation, legacy single-round SHA-256 migration, single-flight refresh mutex, and mathematical spend accumulation operate as designed in normal flows, empirical stress testing exposed **two critical architectural/concurrency vulnerabilities** in `TokenManager` and `OmniRouteAdapter`:

1. **CRITICAL**: Unpopulated `tokenDataCache` bypasses token expiration verification and returns expired access tokens from `SecureSecretStore` without triggering auto-refresh.
2. **CRITICAL**: Post-execution spend quota checks discard completed LLM response payloads and permit high-concurrency remote API overshoot.

---

## Challenge Dimensions & Findings

### 1. PBKDF2 Key Derivation Resilience & Legacy Single-Round SHA-256 Migration

#### Observations & Verification
- **PBKDF2 Key Derivation**: Verified in `SecureSecretStore`. Non-hex passphrases use `crypto.pbkdf2Sync(masterKeyHex, salt, 100000, 32, 'sha256')`. AES-256-GCM encryption/decryption functions correctly.
- **Legacy SHA-256 Secret Migration**: Verified in `SecureSecretStore.getSecret()`. Secrets encrypted under legacy single-round SHA-256 (`crypto.createHash('sha256').update(passphrase).digest()`) trigger the fallback decipher in `getSecret()`, re-encrypt the secret using the PBKDF2 master key, save the updated payload to in-memory `store`, and log migration via `logger.info`. Subsequent reads decrypt directly using the PBKDF2 key.
- **High-Concurrency Stress**: Verified 100 parallel set/get secret operations without data corruption or key collision.

#### Edge Case Finding: 64-Character Hex Passphrase Migration Blind Spot
- **File**: `src/router/tokenManager.ts:91`
- **Issue**: If `masterKeyHex` is a 64-character hexadecimal string, the constructor assumes it is a raw 32-byte hex key (`Buffer.from(masterKeyHex, 'hex')`) and skips initializing `this.legacyMasterKey`.
- **Impact**: If a legacy deployment used a 64-character hex passphrase under single-round SHA-256, `legacyMasterKey` remains `undefined`, causing migration to fail and returning `null`.

---

### 2. Token Manager & TokenRefreshManager Auto-Refresh Behavior

#### Observations & Verification
- **Single-Flight Mutex Lock**: Verified under 50 concurrent `getValidAccessToken()` calls. Exactly 1 HTTP refresh request is dispatched via `inFlightRefreshes` map, and all 50 concurrent callers receive the same refreshed access token.
- **Preemptive Expiry Window**: Verified that when `tokenData.expiresAt - Date.now() <= preemptiveRefreshWindowMs` (default 60s), `getValidAccessToken()` proactively triggers `refreshAccessToken()`.

#### Critical Vulnerability 1: Unpopulated `tokenDataCache` Exposes Expired Tokens
- **File**: `src/router/tokenManager.ts:398-409`
- **Code Snippet**:
  ```typescript
  if (!tokenData) {
    const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
    if (storedToken) return storedToken; // <--- BUG: Returns stored token immediately!

    const hasRefreshToken = Boolean(
      this.secretStore.getSecret(`oauth_refresh_${providerId}`) || config?.refreshToken
    );

    if (config && (config.customRefreshHandler || config.tokenUrl || hasRefreshToken)) {
      return this.refreshAccessToken(providerId, fetchFn);
    }
  }
  ```
- **Failure Scenario**:
  1. On application restart, process reboot, or state rehydration, `tokenDataCache` is empty (`tokenData` is `undefined`).
  2. `secretStore` contains a stored access token `oauth_access_provider1` (which is expired) and a refresh token `oauth_refresh_provider1`.
  3. `getValidAccessToken('provider1')` is called.
  4. Line 400 sees `storedToken` in `secretStore` and **immediately returns `storedToken`** without checking whether it is expired or populating `tokenDataCache`.
  5. Line 406 (`refreshAccessToken`) is **NEVER reached**.
- **Blast Radius**: Downstream LLM requests receive an expired OAuth token, resulting in HTTP 401 Unauthorized errors on API requests. `tokenDataCache` remains unpopulated, keeping the application stuck in an un-refreshed state.
- **Empirical Test**: Demonstrated in `tests/unit/m2_challenger_token_crypto_stress.test.ts:2.1`.

---

### 3. Multi-Provider Spend Accumulation & Pre-Execution Quota Stress

#### Observations & Verification
- **Token Cost Calculation**: Verified `calculateTokenCost()` across OpenAI, Anthropic, Gemini, DeepSeek, and OmniRoute Gateway adapters.
- **Accumulation Precision**: Verified 1,000 post-execution spend updates accumulated correctly with 6-decimal-place floating-point rounding (`Number((current + cost).toFixed(6))`).

#### Critical Vulnerability 2: Post-Execution Spend Exception Discards Completed LLM Response Payloads & Allows Concurrency Quota Overshoot
- **File**: `src/router/omniRouteAdapter.ts:135-165`, `src/router/omniRouteAdapter.ts:175-505`
- **Code Snippet in `recordPostExecutionSpend`**:
  ```typescript
  if (config.extraUsageTier?.enabled) {
    const current = config.extraUsageTier.currentSpendUSD || 0;
    const newSpend = Number((current + costEstimateUSD).toFixed(6));
    config.extraUsageTier.currentSpendUSD = newSpend;

    if (
      config.extraUsageTier.monthlyLimitUSD !== undefined &&
      newSpend > config.extraUsageTier.monthlyLimitUSD
    ) {
      throw new QuotaExhaustedError(
        `Extra usage monthly spend limit ($${config.extraUsageTier.monthlyLimitUSD}) exceeded for ${config.id}`,
        config.id
      );
    }
  }
  ```
- **Failure Scenario A: Completed Work Product Discarded**:
  1. Provider has `monthlyLimitUSD = $1.00` and `currentSpendUSD = $0.99`.
  2. `checkPreExecutionQuota()` passes because `$0.99 < $1.00`.
  3. Adapter executes `fetchFn()`. The remote LLM API processes the request, returns HTTP 200, and incurs cost.
  4. `recordPostExecutionSpend()` updates `currentSpendUSD` to `$1.05`. Because `$1.05 > $1.00`, it throws `QuotaExhaustedError`.
  5. The `execute()` method rejects with `QuotaExhaustedError`, **throwing away the valid, completed LLM review response**!
- **Failure Scenario B: High-Concurrency Quota Overshoot & Wasted API Billing**:
  1. Provider has `monthlyLimitUSD = $1.00` and `currentSpendUSD = $0.90`.
  2. 10 concurrent requests arrive simultaneously.
  3. All 10 requests run `checkPreExecutionQuota()`. All 10 pass because `currentSpendUSD` is `$0.90 < $1.00` for all in-flight callers before any request completes.
  4. All 10 requests execute remote LLM API calls concurrently (total cost $2.00, pushing spend to $2.90 — $1.90 over monthly limit!).
  5. As requests complete, `recordPostExecutionSpend` throws `QuotaExhaustedError` for every request that pushed spend over $1.00, discarding all completed responses.
- **Blast Radius**: Financial overspending on external LLM provider accounts; loss of completed AI review outputs; wasted API credits.
- **Empirical Test**: Demonstrated in `tests/unit/m2_challenger_token_crypto_stress.test.ts:3.3` & `3.4`.

---

## Challenge Test Suite Summary

File: `tests/unit/m2_challenger_token_crypto_stress.test.ts` (11 tests, 100% passing after capturing expected error behaviors)

| Test ID | Area | Scenario | Result |
|---|---|---|---|
| 1.1 | SecretStore | PBKDF2 key derivation with custom salt | PASS |
| 1.2 | SecretStore | Legacy single-round SHA-256 migration to PBKDF2 | PASS |
| 1.3 | SecretStore | 100 parallel set/get operations | PASS |
| 1.4 | SecretStore | 64-char hex passphrase migration bypass | PASS (proves flaw) |
| 2.1 | TokenManager | Unpopulated `tokenDataCache` auto-refresh | PASS (proves flaw) |
| 2.2 | TokenManager | 50 concurrent requests single-flight mutex lock | PASS |
| 2.3 | TokenManager | Preemptive expiry window auto-refresh | PASS |
| 3.1 | OmniRoute | Multi-provider token cost calculation accuracy | PASS |
| 3.2 | OmniRoute | 1,000 post-execution spend updates accumulation | PASS |
| 3.3 | OmniRoute | Post-execution spend exception discards response | PASS (proves flaw) |
| 3.4 | OmniRoute | High concurrency quota overshoot & response loss | PASS (proves flaw) |

---

## Remediation Recommendations for Implementer

1. **Fix `tokenDataCache` Auto-Refresh in `TokenRefreshManager.getValidAccessToken`**:
   - If `tokenDataCache` does NOT contain `providerId`, do NOT immediately return `secretStore.getSecret("oauth_access_" + providerId)`.
   - Check if a `refreshConfig` is registered and attempt `refreshAccessToken(providerId)` to re-establish `tokenDataCache` metadata and ensure token freshness.
2. **Fix Quota Management in `OmniRouteAdapter`**:
   - Separate quota reservation / pre-allocation from post-execution spend recording.
   - Do NOT throw `QuotaExhaustedError` inside `recordPostExecutionSpend()` after remote LLM API execution has already completed successfully. Instead, return the response, log a warning, and flag the provider as exhausted so `checkPreExecutionQuota()` blocks subsequent requests.
   - Introduce pre-execution estimated spend reservation (or atomic budget decrement) to prevent concurrent requests from overshooting monthly limits.
3. **Fix 64-Char Hex Passphrase Handling in `SecureSecretStore`**:
   - Always initialize `legacyMasterKey` when a string passphrase is provided, regardless of length or hex format, if legacy single-round SHA-256 migration support is required.
