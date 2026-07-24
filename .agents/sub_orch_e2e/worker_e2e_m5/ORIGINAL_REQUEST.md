## 2026-07-24T09:52:29-05:00
<USER_REQUEST>
You are a Worker agent assigned to Milestone E2E-M5: Implement Tier 4 Real-World Application Scenarios for `ct-review-bot`.

Working Directory: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_e2e/worker_e2e_m5`
Project Root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

CRITICAL ARCHITECTURAL REQUIREMENT:
All test cases MUST interact PURELY via HTTP POST requests to `${appUrl}/api/webhook/github`. DO NOT make out-of-band calls to `new OmniRouteClient`, `evaluateQuorum`, `new DiffStateManager`, or manual `fetch` calls to mock GitHub ports inside test functions. All AI reviews and comment postings MUST be driven natively by `src/app.ts`.

Your Tasks:
1. Create `tests/e2e/tier4/realWorldScenarios.test.ts`.
2. Implement AT LEAST 5 comprehensive, genuine real-world application PR workflow scenarios:
   - **Scenario 1: Enterprise Microservice Refactor PR Lifecycle**: Full multi-commit PR lifecycle. PR opened with ticket `[PROJ-801]` -> `src/app.ts` executes ticket check, constitution check, 4-persona quorum review via OmniRoute -> Inline comments and `APPROVE` review published to GitHub -> Subsequent push with new commit SHA -> Incremental diff re-evaluation.
   - **Scenario 2: Emergency Hotfix PR Workflow**: Fast-track hotfix PR payload -> Ticket validation `[HOTFIX-999]` -> Quorum review with high-priority security finding -> `REQUEST_CHANGES` review published natively to GitHub.
   - **Scenario 3: Monorepo Multi-Module PR with OmniRoute Provider Failover**: PR modifying multiple modules -> `.ct-review.yaml` custom quorum config -> OmniRoute primary provider 503 error -> Native failover to secondary provider -> Quorum consensus aggregated and published natively.
   - **Scenario 4: Contributor PR with Missing Ticket & Secret Exposure Remediation**: PR opened without ticket and containing AWS secret key -> Dual-gate rejection with `REQUEST_CHANGES` review -> Author updates PR title with `[SEC-404]` and removes secret -> Synchronize webhook sent -> Pipeline passes and issues `APPROVE` review.
   - **Scenario 5: Multi-commit Nit Suppression & Diff State Preservation**: PR iteration where commit 1 generates nit comments -> Commit 2 updates unrelated file -> Diff state manager preserves previous state and suppresses duplicate comments on unchanged lines.
3. Utilize existing test harness utilities in `tests/e2e/harness/`.
4. Build & Test Verification:
   - Run `npm run build`
   - Run `./node_modules/.bin/vitest run tests/e2e/tier4/realWorldScenarios.test.ts --config vitest.config.e2e.ts`
   - Run full E2E test suite `./node_modules/.bin/vitest run --config vitest.config.e2e.ts`
5. Write handoff report to `.agents/sub_orch_e2e/worker_e2e_m5/handoff.md` and message the orchestrator (`72a8331a-dd28-4aa2-a01b-79a86287c45e`).
</USER_REQUEST>
