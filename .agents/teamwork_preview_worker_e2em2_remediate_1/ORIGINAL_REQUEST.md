## 2026-07-24T14:05:11Z
<USER_REQUEST>
You are teamwork_preview_worker for E2E-M2 Tier 1 Audit & Integrity Remediation.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_e2em2_remediate_1`.
Please create your working directory if it does not exist, and write your BRIEFING.md and progress.md.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task:
Execute the remediation plan specified in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em2_remediate_1/remediation_plan.md`:

1. Build genuine `src/` modules:
   - `src/quorum/quorumEngine.ts`: Real `evaluateQuorum()` implementation (fan-out persona evaluation, threshold checking, consensus decision, nit filtering).
   - `src/gateway/omniRouteClient.ts`: Real `OmniRouteClient` class (HTTP prompt routing, OAuth token refresh `/v1/oauth/token`, multi-provider failover pool, effort level headers).
   - `src/ticket/ticketProviderClient.ts`: Real `TicketProviderClient` class (Linear GraphQL queries, Jira REST v3 API, GitHub Issues REST API integration).
   - Update `src/constitution/constitutionEngine.ts`: Support `enabled: false` bypass in evaluation logic.

2. Refactor Tier 1 test files under `tests/e2e/tier1/`:
   - `tests/e2e/tier1/quorum.test.ts`: Remove inline test functions; import and test `src/quorum/quorumEngine.ts`.
   - `tests/e2e/tier1/omniRoute.test.ts`: Remove direct HTTP requests in test file; import and test `src/gateway/omniRouteClient.ts`.
   - `tests/e2e/tier1/ticket.test.ts`: Remove direct test fetch calls; import and test `src/ticket/ticketProviderClient.ts`.
   - `tests/e2e/tier1/constitution.test.ts`: Remove inline `if (configDisabled.enabled)` cheat in Test 5.
   - `tests/e2e/tier1/diffState.test.ts`: Fix state isolation defect so Tests 3 & 5 pass independently.
   - `tests/e2e/tier1/webhook.test.ts`: Add negative E2E test cases for missing tickets and constitution violations (verifying `REQUEST_CHANGES` responses).

3. Refactor `src/app.ts`:
   - Implement real HMAC SHA-256 validation (`crypto.createHmac('sha256', secret)` with length check and `crypto.timingSafeEqual`).
   - Parse real diff hunks (replace hardcoded `hunks: []`).
   - Execute real review evaluation on comment commands (replace hardcoded `event: 'APPROVE'`).

4. Fix `tests/e2e/harness/stateManager.ts`:
   - Align table and column names (`pr_states` and `pr_state_id`) with `src/persistence/db.ts` to eliminate SQLite schema init errors and JSON fallback warnings.

5. Run test suite:
   - `./node_modules/.bin/vitest run --config vitest.config.e2e.ts tests/e2e/tier1`
   - `./node_modules/.bin/vitest run --config vitest.config.e2e.ts tests/unit/harnessSmoke.test.ts`
   Ensure 100% of tests pass cleanly.

Write your completion report to `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_e2em2_remediate_1/handoff.md` with passing test output logs and send a completion message.
</USER_REQUEST>
