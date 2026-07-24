## 2026-07-24T14:05:36Z

You are Worker Iteration 2 for Milestone 1 of ct-review-bot.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1_gen2`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task:
Remediate all issues identified during Iteration 1 review, challenge, and audit:

1. **`vitest.config.ts` Fix**:
   - Update `vitest.config.ts` `resolve.alias` to include `'@src': path.resolve(__dirname, 'src')` and `'@harness': path.resolve(__dirname, 'tests/e2e/harness')`.
   - Update `include` in `vitest.config.ts` to `['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts']` so standard `npm test` runs unit and integration tests cleanly without failing on E2E test files.

2. **Ticket Linkage Engine (`src/ticket/ticketValidator.ts`)**:
   - Make `LINEAR` and `JIRA` ticket regexes case-insensitive (e.g. `/i` flag or `[A-Za-z]`) so lowercase keys like `proj-123` or `key-456` are extracted.
   - Update GitHub issue regex prefix matching from `(?:^|\s)` to `(?:^|[\s(\[:])` so issues enclosed in parentheses `(#789)`, brackets `[#789]`, or after colons are extracted.
   - Update ticket project prefix length limit from `[A-Z]{2,10}` to `[A-Za-z0-9_]{1,32}` to allow prefixes longer than 10 characters.

3. **Operational Constitution Engine (`src/constitution/constitutionEngine.ts`)**:
   - Update regex pattern extractor to parse backtick regexes containing escaped slashes like `` `/\/api\/v1\//` `` using `/`\/((?:\\\/|[^\/])+)\/([gimsuy]*)/`.
   - Implement keyword/phrase checking for natural language non-regex forbidden rules (e.g. `- Never use eval in code`, `- Prohibit hardcoded JWT secrets`) so non-regex rules are evaluated against PR titles, bodies, and file patches.
   - Expand directive matching beyond hardcoded magic strings to evaluate PR summary requirements and general directive guidelines against PR metadata.

4. **Incremental Diff State Manager (`src/persistence/diffStateManager.ts` & `src/utils/diffHash.ts`)**:
   - Fix finding resolution logic in `DiffStateManager.processPRCommitUpdate()`: Check if modified hunk line ranges (`startLine` to `endLine`) overlap/intersect with `prevFinding.lineNumber` (or line range) rather than checking file-level modification (`isFileModified`). Untouched findings in unmodified sections of a file MUST NOT be marked `RESOLVED` when only modified hunks are reviewed.
   - Update `computeFindingHash()` in `src/utils/diffHash.ts` to include `lineNumber` (or line range) and optional `ruleId`/`findingId` so multiple identical findings in the same file do not collide in `incomingFindingsMap`.
   - Ensure consistent hyphen normalization between `ruleId` and `comment` in `diffHash.ts`.
   - Ensure `JsonFileDiffStateStorage` re-reads from disk before saving if disk file modified time changed.

5. **Express App & Logger (`src/app.ts`, `src/utils/logger.ts`, `tests/unit/app.test.ts`)**:
   - Wrap async route handling in `src/app.ts` `webhookHandler` in `try { ... } catch (err) { next(err); }` and return HTTP 500 JSON error payload on exception.
   - Update `Logger.shouldLog` in `src/utils/logger.ts` so `logger.setLevel()` programmatically sets the active log level cleanly.
   - Add unit tests in `tests/unit/app.test.ts` covering `/webhook` POST requests, HMAC verification, and event payload handling.

Steps to execute:
1. Apply fixes to all target files using code editing tools.
2. Run `npm run build` using `run_command` and confirm zero compilation errors.
3. Run `npm test` using `run_command` and confirm 100% pass across all unit and integration tests.
4. Run `npm run test:e2e` using `run_command` and confirm 100% E2E test pass.
5. Document all changes in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1_gen2/changes.md`.
6. Write a handoff report in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1_gen2/handoff.md`.
7. Send a completion message to parent when done.
