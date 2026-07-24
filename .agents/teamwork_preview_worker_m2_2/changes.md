# Changes Implemented for Milestone 2 Remediation (OmniRoute Router & Token Management)

## Overview
Worker 2 implemented 5 critical resilience, key security, and load balancing fixes across `src/router/tokenManager.ts`, `src/router/omniRouteAdapter.ts`, and `src/router/providerPool.ts`, accompanied by comprehensive unit and integration test coverage.

---

## 1. `src/router/tokenManager.ts`

### `SecureSecretStore` PBKDF2 Key Derivation & Automatic Migration
- **PBKDF2 Derivation**: Passphrases (non-64 hex strings) passed to `SecureSecretStore` or set in `process.env.CT_SECRET_MASTER_KEY` now use `crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256')` instead of single-round SHA-256. Direct 64-character hex keys continue using `Buffer.from(key, 'hex')`.
- **Custom Salt Support**: Constructor accepts `saltInput?: string | Buffer`, defaulting to `process.env.CT_SECRET_SALT || 'ct-review-bot-master-salt'`.
- **Legacy Fallback & Auto-Migration**: `SecureSecretStore` retains `this.legacyMasterKey` computed via single-round SHA-256. When `getSecret(key)` fails primary PBKDF2 deciphering, it attempts decryption with `this.legacyMasterKey`. Upon success, it automatically re-encrypts the secret using `this.masterKey` via `this.setSecret(key, decrypted)` for seamless key migration.

### `TokenRefreshManager` Uncached Token Handling
- **Auto-Trigger Refresh**: `getValidAccessToken(providerId, fetchFn)` now checks if `tokenDataCache` is missing/unpopulated. If no stored access token exists in `secretStore` but a `TokenRefreshConfig` or refresh token is registered, it automatically invokes `this.refreshAccessToken(providerId, fetchFn)` instead of prematurely throwing an error.

---

## 2. `src/router/omniRouteAdapter.ts`

### Pre-Execution Quota Check & Post-Execution Spend Accumulation
- **Pre-execution Quota Check (`checkPreExecutionQuota`)**: Evaluates `config.extraUsageTier`. If `enabled` is true, `monthlyLimitUSD` is defined, and `currentSpendUSD >= monthlyLimitUSD`, it immediately throws `QuotaExhaustedError` prior to making any HTTP fetch requests to LLM providers.
- **Post-execution Spend Accumulation (`recordPostExecutionSpend`)**: Calculates token costs from prompt and completion token counts and increments `config.extraUsageTier.currentSpendUSD` by `costEstimateUSD`. If the updated spend exceeds `monthlyLimitUSD`, `QuotaExhaustedError` is thrown.
- **Adapter Integration**: Integrated `checkPreExecutionQuota` and `recordPostExecutionSpend` across all 5 provider adapters (`OmniRouteGatewayAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`, `DeepSeekAdapter`).

---

## 3. `src/router/providerPool.ts`

### `ProviderNode` `HALF_OPEN` Atomic Probing Lock
- **Probing Lock State**: Added `private isProbing = false;` and `private probeStartTime: number | null = null;` to `ProviderNode`.
- **Mutual Exclusion**: When `circuitState` transitions from `OPEN` to `HALF_OPEN` (or is in `HALF_OPEN`), the first caller to `isAvailable()` acquires `isProbing = true` and receives `true`. Concurrent calls while `isProbing === true` receive `false` (with a 30s deadlock timeout guard), ensuring only 1 probe request is allowed through.
- **Lock Release**: Reset `isProbing = false` and `probeStartTime = null` in `recordSuccess()` (recovers to `CLOSED`) and `recordFailure()` (re-trips to `OPEN`).

### `ProviderPool` Strategy-Respecting Failover with `excludeIds`
- **Candidate Selection Helper**: Extracted `selectProviderFromList(candidates)` to apply the active `LoadBalancingStrategy` (`priority_fallback`, `round_robin`, or `least_loaded`) to any filtered candidate list.
- **Exclude IDs Support**: Updated `selectProvider(preferredProviderId?, excludeIds = [])` to filter candidate nodes by `!excludeIds.includes(p.id)`.
- **Failover Delegate**: Refactored `executeWithFailover` to call `this.selectProvider(attempt === 0 ? preferredProviderId : undefined, attempted)` on every retry attempt, ensuring failover retries strictly obey `round_robin`, `least_loaded`, or `priority_fallback` strategies instead of defaulting to hardcoded priority fallback.

---

## 4. Test Suite Enhancements & Verification

### Updated & Added Test Files:
1. `tests/unit/tokenManager.test.ts`:
   - Unit tests for PBKDF2 derivation with custom salt.
   - Unit tests for legacy single-round SHA-256 decryption fallback and auto-migration to PBKDF2.
   - Unit tests for `getValidAccessToken()` auto-triggering token refresh when `tokenDataCache` is unpopulated.
2. `tests/unit/omniRoute.test.ts`:
   - Unit tests verifying `checkPreExecutionQuota` throws `QuotaExhaustedError` prior to dispatching fetch requests.
   - Unit tests verifying `recordPostExecutionSpend` accumulates spend across execution calls.
3. `tests/unit/providerPool.test.ts`:
   - Unit tests for `HALF_OPEN` atomic `isProbing` lock state ensuring concurrent requests receive `false`.
   - Unit tests for `selectProvider` with `excludeIds` applying `round_robin` and `least_loaded` strategies.
   - Unit tests for `executeWithFailover` using `least_loaded` strategy among remaining candidates.
4. `tests/integration/m2_router.test.ts`:
   - Integration tests for pre-execution quota checks and auto-token refresh during router pool failover execution.
5. `tests/unit/m2_challenger_empirical_stress.test.ts`:
   - High-concurrency empirical stress test 3.5 verifying that 50 concurrent `isAvailable()` calls in `HALF_OPEN` state allow exactly 1 probe request while rejecting 49 concurrent calls.

### Build & Test Results:
- `npm run build`: 0 errors (100% clean TypeScript compilation).
- `npm test`: 161 / 161 tests passed across 15 test files (100% pass rate).
