# Handoff Report — Milestone 2 Remediation (OmniRoute Router & Token Management)

## 1. Observation
- **Target Files Modified**:
  - `src/router/tokenManager.ts` (Lines 80–136, 391–450): Replaced single-round SHA-256 with PBKDF2 (`crypto.pbkdf2Sync` with 100,000 iterations and salt) in `SecureSecretStore`, added legacy SHA-256 fallback with automatic re-encryption to PBKDF2. Updated `TokenRefreshManager.getValidAccessToken()` to auto-trigger `refreshAccessToken()` when `tokenDataCache` is unpopulated.
  - `src/router/omniRouteAdapter.ts` (Lines 117–190, 202, 285, 369, 448): Created export helpers `checkPreExecutionQuota` and `recordPostExecutionSpend`. Updated `OmniRouteGatewayAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`, and `DeepSeekAdapter` to enforce pre-execution quota checks (throwing `QuotaExhaustedError` prior to HTTP calls) and post-execution spend accumulation on `config.extraUsageTier.currentSpendUSD`.
  - `src/router/providerPool.ts` (Lines 74–130, 208–350): Added atomic `isProbing` lock state to `ProviderNode` during `HALF_OPEN` state so that only 1 probe request is allowed through while concurrent requests receive `false` from `isAvailable()`. Updated `ProviderPool.selectProvider` and `executeWithFailover` to accept `excludeIds` and select unattempted providers strictly using the configured load balancing strategy (`round_robin`, `least_loaded`, `priority_fallback`).
- **Test Files Updated/Added**:
  - `tests/unit/tokenManager.test.ts`
  - `tests/unit/omniRoute.test.ts`
  - `tests/unit/providerPool.test.ts`
  - `tests/integration/m2_router.test.ts`
  - `tests/unit/m2_challenger_empirical_stress.test.ts`
- **Build Command Output**:
  - `npm run build`: Exit code 0, 0 errors (`tsc` completed successfully).
- **Test Command Output**:
  - `npm test`: Exit code 0, 161 passed (15 passed test files, 161 total tests passed, 0 failures).

## 2. Logic Chain
1. *Observation*: Explorer 4 identified that `SecureSecretStore` key derivation used single-round SHA-256 for passphrase keys, which is vulnerable to offline dictionary attacks.
   *Reasoning*: Updating key derivation to PBKDF2 (`100,000` iterations) hardens master key derivation. Retaining a legacy SHA-256 fallback key in `getSecret()` and automatically calling `this.setSecret(key, decrypted)` upon legacy decryption success allows seamless, zero-downtime key migration for pre-existing encrypted stores.
2. *Observation*: `TokenRefreshManager.getValidAccessToken()` threw an error when `tokenDataCache` was unpopulated, ignoring registered `TokenRefreshConfig` or refresh tokens.
   *Reasoning*: Checking if `config` or refresh token exists when `tokenData` is missing and auto-invoking `refreshAccessToken()` restores expected token lifecycle management after service restarts or cold starts.
3. *Observation*: Provider adapters in `OmniRouteAdapter` invoked `fetchFn` before evaluating quota limits and failed to accumulate `currentSpendUSD`.
   *Reasoning*: Moving quota evaluation before `fetchFn` in `checkPreExecutionQuota` prevents wasteful paid API requests when limits are exceeded. Calculating token cost and incrementing `currentSpendUSD` in `recordPostExecutionSpend` ensures monthly spending limits are accurately tracked and enforced across all provider adapters.
4. *Observation*: `ProviderNode.isAvailable()` allowed all concurrent requests to pass when `circuitState` transitioned to `HALF_OPEN`, causing recovery thundering herds.
   *Reasoning*: Introducing an atomic `isProbing` lock in `HALF_OPEN` state allows exactly 1 probe request through while returning `false` to concurrent callers until the probe succeeds (recovering to `CLOSED`) or fails (re-tripping to `OPEN`).
5. *Observation*: `ProviderPool.executeWithFailover` selected failover candidates by hardcoding priority order (`unattempted[0]`), bypassing configured `round_robin` and `least_loaded` strategies.
   *Reasoning*: Refactoring `selectProvider` to accept `excludeIds` and delegating failover selection to `selectProvider` guarantees all failover retries strictly obey the pool's configured load balancing strategy.

## 3. Caveats
- No caveats. All 5 remediations were fully implemented, verified via build and test suites, and zero regressions were found across existing codebase components.

## 4. Conclusion
Milestone 2 Remediation of `ct-review-bot` router and token management subsystems is 100% complete and fully verified. Key security is upgraded to PBKDF2 with automatic legacy migration, monthly spend quota limits are pre-enforced and post-accumulated, `HALF_OPEN` circuit breaker probing is atomic and single-flight, uncached token refresh is automatically triggered, and provider failover strictly honors configured load balancing strategies.

## 5. Verification Method
To independently verify this work:

1. **Build Verification**:
   ```bash
   npm run build
   ```
   *Expected result*: Exit code 0, 0 TypeScript compilation errors.

2. **Test Suite Verification**:
   ```bash
   npm test
   ```
   *Expected result*: All 15 test files pass with 161 total test cases passing (100% pass rate).

3. **Target File Inspection**:
   - Inspect `src/router/tokenManager.ts` for `crypto.pbkdf2Sync` and legacy migration in `SecureSecretStore`, and auto-refresh trigger in `TokenRefreshManager`.
   - Inspect `src/router/omniRouteAdapter.ts` for `checkPreExecutionQuota` and `recordPostExecutionSpend`.
   - Inspect `src/router/providerPool.ts` for `isProbing` lock in `ProviderNode` and `excludeIds` strategy handling in `ProviderPool`.
