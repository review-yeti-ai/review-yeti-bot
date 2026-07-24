# Original User Request for Sub-Orchestrator M1

## Initial Request — 2026-07-24T08:48:02-05:00

You are the Sub-Orchestrator for Milestone 1 (Core Foundations, Config Parser & Diff State Persistence) of `ct-review-bot`.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.
Global project spec: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md`.
Original request: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/ORIGINAL_REQUEST.md`.

Your Mission:
Deliver Milestone 1:
1. Initialize project scaffold: Node.js + TypeScript setup with `package.json`, `tsconfig.json`, build scripts, Jest/Vitest test configuration, and dependencies (`express`, `@octokit/core`, `js-yaml`, `zod`, `better-sqlite3` or JSON atomic storage).
2. Implement Config Loader & Parser (`src/config/`): parse `.ct-review.yaml` and `.coderabbit.yaml`, merging with default org configs, schema validation with Zod.
3. Implement Ticket Linkage Engine (`src/ticket/ticketValidator.ts`): regex and structural validation for Linear (`[PROJ-123]`), Jira (`[KEY-456]`), and GitHub (`#789`) in PR title/body.
4. Implement Operational Constitution Engine (`src/constitution/constitutionEngine.ts`): parse and enforce `constitution.md` rules.
5. Implement Incremental Diff State Manager (`src/persistence/diffStateManager.ts`): SHA-256 diff delta tracking to persist identified/resolved nits and PXs across PR commits so previously resolved items are not re-flagged and token load is minimized.
6. Write unit and integration tests under `tests/unit/` and `tests/integration/` verifying all M1 components. Ensure 100% build and test pass.

## Follow-up — 2026-07-24T09:22:57-05:00

You are the Successor Sub-Orchestrator (Generation 2) for Milestone 1 of ct-review-bot.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_m1`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

Your parent is `493af411-ba43-4f27-9bdc-f0ffe4f00a2f` — use this ID for all escalation and status reporting (`send_message`).

Your Next Action:
1. Dispatch Worker Iteration 3 (`teamwork_preview_worker`) with MANDATORY INTEGRITY WARNING, instructing it to apply the Explorer 3 remediation strategy from `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_gen3/analysis.md`:
   - Fix `src/constitution/constitutionEngine.ts` line 86 to handle escaped slashes in backticks (`const regexMatch = ruleContent.match(/`\\?\/((?:\\\/|\\.|[^\/])+?)\\?\/([gimsuy]*)`/);`).
   - Fix `tests/unit/app.test.ts` to replace synthetic `/error-trigger` test with genuine `/webhook` exception handling test using `vi.spyOn`.
   - Run `npm run build` (confirm 0 compilation errors) and `npm test` (confirm 75/75 tests pass with 0 failures).
2. Dispatch 2 Reviewers (`teamwork_preview_reviewer`), 2 Challengers (`teamwork_preview_challenger`), and 1 Forensic Auditor (`teamwork_preview_auditor`).
3. Confirm Reviewer verdicts (APPROVE), Challenger verdicts (PASS), and Forensic Auditor verdict (CLEAN).
4. When gate passes, write final `handoff.md` and send completion update to parent `493af411-ba43-4f27-9bdc-f0ffe4f00a2f`.
