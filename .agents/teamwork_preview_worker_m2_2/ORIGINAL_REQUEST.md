## 2026-07-24T14:56:27Z

You are Worker 2 for Milestone 2 Remediation of ct-review-bot.
Working directory: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m2_2
Target project root: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Instructions & Tasks:
1. Read the remediation specification created by Explorer 4:
   `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_4/analysis.md`
2. Implement the 5 fixes in `src/router/`:
   a. `src/router/tokenManager.ts`:
      - `SecureSecretStore`: Implement PBKDF2 (`crypto.pbkdf2Sync` with salt and 100,000 iterations) for key derivation instead of single-round SHA-256. Retain a fallback for legacy single-round SHA-256 in `getSecret()` with automatic re-encryption to PBKDF2.
      - `TokenRefreshManager`: Update `getValidAccessToken()` so that if `tokenDataCache` is unpopulated/missing, it automatically triggers `refreshAccessToken()` if a `TokenRefreshConfig` or refresh token is registered.
   b. `src/router/omniRouteAdapter.ts`:
      - Implement pre-execution quota checks (`checkPreExecutionQuota`) to throw `QuotaExhaustedError` prior to making LLM requests if spend limit is exceeded or projected to be exceeded.
      - Implement post-execution spend accumulation (`recordPostExecutionSpend`) to calculate cost from prompt + completion tokens and update `currentSpendUSD` across provider adapters.
   c. `src/router/providerPool.ts`:
      - `ProviderNode`: Add atomic `isProbing` lock state during `HALF_OPEN` state so that only 1 probe request is allowed through while concurrent requests return `false` from `isAvailable()`.
      - `ProviderPool`: Update `executeWithFailover` and `selectProvider` to accept `excludeIds` and select unattempted providers strictly using the configured load balancing strategy (`round_robin`, `least_loaded`, `priority_fallback`).
3. Update or add unit & integration test cases in:
   - `tests/unit/tokenManager.test.ts`
   - `tests/unit/omniRoute.test.ts`
   - `tests/unit/providerPool.test.ts`
   - `tests/integration/m2_router.test.ts`
   - `tests/unit/m2_challenger_empirical_stress.test.ts`
4. Run `npm run build` (confirm 0 errors) and `npm test` (confirm 100% tests pass across all test files).
5. Document work in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m2_2/changes.md` and deliver handoff report.
