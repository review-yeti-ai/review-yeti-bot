# Handoff Report: Router & Token Management Remediation Strategy (Milestone 2)

**Agent**: Explorer 4  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_4`  
**Target Analysis File**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_4/analysis.md`  

---

## 1. Observation

Direct code inspection of `src/router/tokenManager.ts`, `src/router/omniRouteAdapter.ts`, and `src/router/providerPool.ts` confirmed the 5 critical security and resilience findings reported by Reviewer 2:

1. **Finding 1 (`SecureSecretStore` key derivation)**:
   - File: `src/router/tokenManager.ts`, lines 89 & 93.
   - Code: `this.masterKey = crypto.createHash('sha256').update(masterKeyHex).digest();`
   - Issue: Single-round SHA-256 is used for passphrase-derived master keys, exposing master keys to brute-force dictionary attacks.
2. **Finding 2 (`OmniRouteAdapter` monthly quota enforcement & spend accumulation)**:
   - File: `src/router/omniRouteAdapter.ts`, lines 167–185, 254–269, 341–356, 422–437, 503–518.
   - Code: Quota checks occur exclusively after `fetchFn` calls, and `this.config.extraUsageTier.currentSpendUSD` is NEVER incremented (`current + costEstimateUSD > monthlyLimitUSD` check exists, but `this.config.extraUsageTier.currentSpendUSD` is never mutated).
   - Issue: Exhausted quotas are not pre-checked prior to LLM API execution, and spend accumulation is completely absent.
3. **Finding 3 (`ProviderPool` HALF_OPEN probing race condition)**:
   - File: `src/router/providerPool.ts`, lines 84–94.
   - Code:
     ```ts
     if (this.circuitState === 'OPEN') {
       if (this.coolingDownUntil && now >= this.coolingDownUntil) {
         this.circuitState = 'HALF_OPEN';
         return true;
       }
       return false;
     }
     return this.healthState === 'healthy' || this.healthState === 'degraded' || this.circuitState === 'HALF_OPEN';
     ```
   - Issue: When `coolingDownUntil` expires, `circuitState` becomes `'HALF_OPEN'`. Subsequent concurrent calls to `isAvailable()` evaluate `this.circuitState === 'HALF_OPEN'` as `true`, allowing all concurrent callers to flood the probing provider.
4. **Finding 4 (`TokenRefreshManager` uncached token refresh error)**:
   - File: `src/router/tokenManager.ts`, lines 369–373.
   - Code:
     ```ts
     if (!tokenData) {
       const storedToken = this.secretStore.getSecret(`oauth_access_${providerId}`);
       if (storedToken) return storedToken;
       throw new Error(`No credentials or refresh config registered for provider: ${providerId}`);
     }
     ```
   - Issue: If `tokenDataCache` is unpopulated, `getValidAccessToken()` throws an error immediately without checking if `TokenRefreshConfig` is registered to perform an initial refresh.
5. **Finding 5 (`ProviderPool` failover strategy bypass)**:
   - File: `src/router/providerPool.ts`, lines 299–307.
   - Code: `const unattempted = this.getAvailableProviders().filter((p) => !attempted.includes(p.id)); node = unattempted[0];`
   - Issue: `getAvailableProviders()` sorts providers strictly by priority (`a.priority - b.priority`). Picking `unattempted[0]` forces priority fallback on retries and bypasses `round_robin` or `least_loaded` strategy configurations.

---

## 2. Logic Chain

1. **Finding 1 Reasoning**: Replacing single-round SHA-256 with PBKDF2 (`crypto.pbkdf2Sync` with 100,000 iterations, custom/default salt) protects passphrase master keys. Storing `legacyMasterKey` computed via SHA-256 enables `getSecret()` to decrypt legacy payloads and transparently re-encrypt them with PBKDF2, guaranteeing 100% backward compatibility and seamless key migration.
2. **Finding 2 Reasoning**: Checking `currentSpendUSD >= monthlyLimitUSD` in a `checkPreExecutionQuota` helper before calling `fetchFn` prevents wasteful API invocation on exhausted quotas. Incrementing `currentSpendUSD = (currentSpendUSD || 0) + costEstimateUSD` in a `recordPostExecutionSpend` helper ensures accurate spend tracking across all 5 LLM provider adapters (`OmniRouteGatewayAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`, `DeepSeekAdapter`).
3. **Finding 3 Reasoning**: Adding an `isProbing` lock flag to `ProviderNode` ensures `isAvailable()` allows only the first request through when transitioning to `HALF_OPEN`. Concurrent requests receive `false` and bypass the probing node until the probe completes via `recordSuccess()` (recovering to `CLOSED`) or `recordFailure()` (re-tripping to `OPEN`).
4. **Finding 4 Reasoning**: Updating `getValidAccessToken()` to check if `TokenRefreshConfig` (or refresh token) is present when `tokenDataCache` is missing enables automatic token refresh on cold start instead of throwing an error.
5. **Finding 5 Reasoning**: Adding an `excludeIds: ProviderId[]` parameter to `selectProvider` allows `executeWithFailover` to pass `attempted` directly to `selectProvider()`. `selectProvider` filters out attempted nodes and applies `round_robin`, `least_loaded`, or `priority_fallback` via `selectProviderFromList()` to the remaining candidate nodes.

---

## 3. Caveats

- **PBKDF2 Iteration Overhead**: 100,000 PBKDF2 iterations add ~1–5ms of latency during `SecureSecretStore` initialization when using passphrases, which is negligible for startup/secret lookups and well worth the cryptographic security enhancement.
- **Salt Storage**: Passphrase derivation uses `saltInput || process.env.CT_SECRET_SALT || 'ct-review-bot-master-salt'`. When salt migration is needed across deployments, `CT_SECRET_SALT` environment variable should be preserved.
- **In-Memory Quota Persistence**: `currentSpendUSD` is tracked on the in-memory `ProviderConfig`. In production environments with multiple process restarts, backing quota spend to persistent storage (`diffStateStorage` or Redis) would maintain spend state across app reboots.

---

## 4. Conclusion

A complete, line-by-line remediation strategy has been documented in `analysis.md`. Worker 2 can implement the exact code replacements specified in `analysis.md` across `src/router/tokenManager.ts`, `src/router/omniRouteAdapter.ts`, and `src/router/providerPool.ts` without architectural ambiguity.

---

## 5. Verification Method

To verify Worker 2's implementation after code changes:

1. **Unit & Stress Tests Execution**:
   ```bash
   npx vitest run tests/unit/tokenManager.test.ts
   npx vitest run tests/unit/omniRoute.test.ts
   npx vitest run tests/unit/providerPool.test.ts
   npx vitest run tests/unit/m2_challenger_empirical_stress.test.ts
   npx vitest run tests/integration/m2_router.test.ts
   ```
2. **Inspection Checkpoints**:
   - `SecureSecretStore`: Verify PBKDF2 key derivation for non-64-character passphrases and backward-compatible decryption of SHA-256 legacy keys.
   - `OmniRouteAdapter`: Verify pre-execution `QuotaExhaustedError` when spend limit is reached, and verify `currentSpendUSD` increments post-response.
   - `ProviderNode`: Verify that during `HALF_OPEN` state, only 1 probe request returns `true` for `isAvailable()`, and concurrent requests return `false`.
   - `TokenRefreshManager`: Verify `getValidAccessToken()` triggers `refreshAccessToken()` when `tokenDataCache` is unpopulated.
   - `ProviderPool`: Verify failover attempts under `round_robin` and `least_loaded` strategies select unattempted nodes according to the strategy rather than falling back strictly to priority.
