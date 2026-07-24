## 2026-07-24T14:31:34Z
You are Worker 4 for Milestone 1 of ct-review-bot.
Your working directory is `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1_iter4`.
Target project root: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task:
Apply the Explorer 4 remediation strategy from `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_gen4/analysis.md`:

1. Fix 1: `tests/e2e/harness/mockGithubServer.ts` and `tests/e2e/tier2/webhookBoundaries.test.ts`.
   - Add `ConfigureMockGithubOptions` interface and implement `public configure(options)` in `MockGithubServer` to set `failFilesRequest` and `filesFailStatus` (429).
   - In `MockGithubServer.reset()`, reset `failFilesRequest` to `false` and `filesFailStatus` to `429`.
   - In route `GET /repos/:owner/:repo/pulls/:pr_number/files`, check `if (this.failFilesRequest)` and return HTTP status `this.filesFailStatus` with `{ message: 'API rate limit exceeded', ... }`.
   - Update `tests/e2e/tier2/webhookBoundaries.test.ts` Test 5 to invoke `harness.mockGithub.configure({ failFilesRequest: true, filesFailStatus: 429 })`.

2. Fix 2: `src/persistence/diffStateManager.ts` lines 170-176.
   - Replace hunk line range calculation with dual old/new line range overlap logic:
     ```ts
     const oldStart = h.oldStart;
     const oldEnd = h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : h.oldStart;
     const newStart = h.newStart;
     const newEnd = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart;

     const overlapsOld = oldStart <= fEnd && oldEnd >= fStart;
     const overlapsNew = newStart > 0 && (newStart <= fEnd && newEnd >= fStart);

     return overlapsOld || overlapsNew;
     ```

3. Fix 3: `src/utils/diffHash.ts` lines 62-76 (`computeFindingHash`).
   - Remove `${lineRange}` from SHA-256 raw string calculation:
     `const rawString = `${input.filePath}|${input.persona.toLowerCase()}|${normalizedCode}|${normalizedSummary}`;`

4. Fix 4: `src/persistence/db.ts` lines 297-305 and lines 408-422.
   - In `SqliteDiffStateStorage.updateFindingStatus`, set `resolved_at_commit = ?` directly (passing `resolvedAt` which is `null` when `status !== 'RESOLVED'`) instead of `COALESCE(?, resolved_at_commit)`.
   - In `JsonFileDiffStateStorage.updateFindingStatus`, set `finding.resolvedAtCommit = status === 'RESOLVED' ? commitSha : null`.

5. Build and Test Verification:
   - Run `npm run build` and confirm 0 compilation errors.
   - Run `npm test` and confirm unit/integration test suite passes cleanly with 0 failures.
   - Run `npm run test:e2e` and confirm 100% E2E tests pass cleanly with 0 failures.

6. Document all code changes and build/test outputs in `handoff.md` inside your working directory (`/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_worker_m1_iter4`).
