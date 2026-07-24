## 2026-07-24T13:50:08Z
You are the Worker subagent for Milestone 1 of ct-review-bot.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task:
Implement the complete code and test suite for Milestone 1 based on the specifications produced by Explorers 1, 2, and 3:
- Explorer 1 analysis: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_1/analysis.md`
- Explorer 2 analysis: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_2/analysis.md`
- Explorer 3 analysis: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_3/analysis.md`

Files to create / implement in project root (`/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`):
1. **Scaffold & Build**:
   - `package.json`
   - `tsconfig.json`
   - `vitest.config.ts`
2. **Core Service & Utilities**:
   - `src/app.ts` (Express server setup with `express.json({ verify: ... })`)
   - `src/index.ts` (Service entrypoint)
   - `src/utils/logger.ts` (Structured JSON/console logger)
   - `src/utils/diffHash.ts` (SHA-256 fingerprinting for diff hunks and review findings)
3. **Config Loader & Parser** (`src/config/`):
   - `src/config/schema.ts` (Zod `CtReviewConfig` matching PROJECT.md interface contract)
   - `src/config/defaultOrgConfig.ts` (Default org configuration)
   - `src/config/configLoader.ts` (Loads `.ct-review.yaml` or `.coderabbit.yaml`, merges with org defaults, validates schema)
4. **Ticket Linkage Engine** (`src/ticket/`):
   - `src/ticket/ticketValidator.ts` (Linear `[PROJ-123]`, Jira `[KEY-456]`, GitHub `#789` regex scanning, strict vs advisory modes)
5. **Operational Constitution Engine** (`src/constitution/`):
   - `src/constitution/constitutionEngine.ts` (Parses `constitution.md`, extracts directives, evaluates rule compliance)
6. **Incremental Diff State Manager** (`src/persistence/`):
   - `src/persistence/db.ts` (SQLite storage via `better-sqlite3` with atomic JSON storage fallback)
   - `src/persistence/diffStateManager.ts` (Diff state manager tracking finding fingerprints, statuses `IDENTIFIED`/`RESOLVED`/`SUPPRESSED`, and diff deltas)
7. **Unit & Integration Test Suite**:
   - `tests/unit/config.test.ts`
   - `tests/unit/ticket.test.ts`
   - `tests/unit/constitution.test.ts`
   - `tests/unit/diffState.test.ts`
   - `tests/integration/m1_foundations.test.ts`

Steps to execute:
1. Write all source and test files using `write_to_file`.
2. Run `npm install` using `run_command`.
3. Run `npm run build` using `run_command` and confirm zero TypeScript errors.
4. Run `npm test` using `run_command` and verify 100% test pass across all unit and integration tests.
5. Document all changes in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1/changes.md`.
6. Write a handoff report in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1/handoff.md`.
7. Send a message to parent with build/test results when complete.
