## 2026-07-24T14:45:16Z

<USER_REQUEST>
You are the Worker for Milestone 2 (OmniRoute Multi-LLM Router & Token Management) of ct-review-bot.
Working directory: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m2_1
Target project root: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Instructions & Architecture Requirements:
1. Read the following specifications and design blueprints before implementing:
   - Global project spec: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md
   - Milestone 2 spec: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m2/SCOPE.md
   - Explorer 1 analysis: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_1/analysis.md
   - Explorer 2 analysis: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_2/analysis.md
   - Explorer 3 analysis: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_3/analysis.md

2. Implement the following files in `src/router/`:
   a. `src/router/tokenManager.ts`:
      - `SecureSecretStore`: AES-256-GCM authenticated encryption using `node:crypto` with SHA-256 key derivation, 12-byte IV, 16-byte auth tag, export/import serialization.
      - `TokenMetricsTracker`: Aggregates prompt, completion, reasoning token usage per request, per persona (`security`, `architecture`, `performance`, `quality`), and per provider/model.
      - `EffortScaler`: Maps effort levels (`low`, `medium`, `high`, `reasoning`) to token budgets, temperatures, timeouts, and provider-specific reasoning parameters.
      - `TokenRefreshManager`: Async single-flight mutex lock for token refresh, preemptive expiry window, reactive 401 retry handling.
   b. `src/router/omniRouteAdapter.ts`:
      - `OmniRouteAdapter`: Multi-provider router interfacing across active provider subscriptions (OpenAI, Anthropic, Gemini, DeepSeek, OmniRoute Gateway).
      - Strict adherence to `LLMRequest` and `LLMResponse` interface contracts.
      - Support for API key subscriptions, usage-based billing, and extra-usage tier subscriptions (token spend cap handling).
      - Injectable HTTP transport (`httpFetch`) to allow clean unit test mocking.
   c. `src/router/providerPool.ts`:
      - `ProviderPool`: Manages active provider list with health state machine (`healthy`, `degraded`, `cooling_down`, `offline`, `HALF_OPEN`).
      - `CircuitBreaker`: Handles 429 Rate Limits (`Retry-After` header or exponential backoff) and 5xx server errors with consecutive failure limits and cooldown timers.
      - Load Balancing Strategies: `priority_fallback`, `round_robin`, `least_loaded`.
      - Failover Execution: Automatically attempts next healthy provider in pool when a provider fails.

3. Integrate with Express App & Main Entry Point:
   - `src/app.ts`: Add GET `/api/router/status` returning complete JSON status of provider pool, circuit breaker state, in-flight request counts, and token metrics. Update GET `/health` status summary.
   - `src/index.ts`: Ensure clean router initialization / export.

4. Create unit and integration test suites:
   - `tests/unit/omniRoute.test.ts`
   - `tests/unit/tokenManager.test.ts`
   - `tests/unit/providerPool.test.ts`
   - `tests/integration/m2_router.test.ts`

5. Verify Implementation:
   - Run `npm run build` and verify 0 TypeScript compilation errors.
   - Run `npm test` and verify 100% of tests pass across all unit and integration test suites (including existing M1 tests).

6. Document Work & Deliver Handoff:
   - Write summary of changes in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m2_1/changes.md`.
   - Send handoff message back with test execution output and build verification.
</USER_REQUEST>
