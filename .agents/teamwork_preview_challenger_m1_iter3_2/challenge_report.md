# Challenger 2 Report: Milestone 1 State Persistence Stress Testing

**Target Project**: `ct-review-bot` (Milestone 1, Iteration 3)  
**Evaluator**: Challenger 2 (Empirical Challenger)  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_challenger_m1_iter3_2`  
**Date**: 2026-07-24  

---

## Verdict: FAIL

Although `npm run build` succeeds and the basic unit test suite passes, empirical adversarial stress testing of state persistence (`src/persistence/diffStateManager.ts`, `src/persistence/db.ts`, and `src/utils/diffHash.ts`) uncovered **3 CRITICAL BUGS** that cause state corruption, duplicate findings, and failure to resolve findings on line deletions.

---

## Challenge Summary

- **Overall Risk Assessment**: **HIGH**
- **Tested Modules**: `src/persistence/diffStateManager.ts`, `src/persistence/db.ts`, `src/utils/diffHash.ts`
- **Verification Method**: Empirical stress test harness (`test_empirical.ts`) executed via `npx ts-node`.

---

## Confirmed Vulnerabilities & Failure Modes

### 1. [HIGH] Deletion Hunk Range Overlap Bug (`diffStateManager.ts`)

- **Component**: `src/persistence/diffStateManager.ts` (lines 171–176)
- **Mechanism**: When calculating whether a previous finding falls inside a modified diff hunk, the manager evaluates:
  ```typescript
  const hStart = h.newStart > 0 ? h.newStart : h.oldStart;
  const linesCount = h.newStart > 0 ? h.newLines : h.oldLines;
  const hEnd = linesCount > 0 ? hStart + linesCount - 1 : hStart;
  ```
  For line deletion diff hunks (e.g. `oldStart: 10, oldLines: 5, newStart: 10, newLines: 0`), `h.newStart` is `10` (> 0), so `linesCount` is assigned `h.newLines` (`0`). `hEnd` becomes `10` instead of covering lines 10–14 (`oldStart` + `oldLines` - 1).
- **Attack / Failure Scenario**: Lines 10–14 containing a finding on line 12 are deleted in a PR commit update. Because `hEnd` evaluates to 10, `isFindingInModifiedHunk` returns `false` (`hEnd (10) >= fStart (12)` is false).
- **Blast Radius**: Findings on deleted code lines remain in state `IDENTIFIED` indefinitely instead of transitioning to `RESOLVED`.
- **Empirical Evidence**: In `test_empirical.ts` (Test 1), when lines 10–14 were deleted, the finding status remained `'IDENTIFIED'` instead of transitioning to `'RESOLVED'`.
- **Mitigation**: Base modified hunk line range checks for previous finding resolution on `oldStart` and `oldLines` (the line numbers of the previous commit where the finding was originally anchored), or calculate both old and new hunk boundaries.

---

### 2. [HIGH] Fingerprint Hash Includes Line Number, Breaking Line-Shift Resiliency (`diffHash.ts`)

- **Component**: `src/utils/diffHash.ts` (lines 65–75)
- **Mechanism**: `computeFindingHash` embeds `${lineRange}` (e.g. `'10-10'`) into the SHA-256 raw input string:
  ```typescript
  const start = input.startLine ?? input.lineNumber;
  const end = input.endLine ?? input.startLine ?? input.lineNumber;
  const lineRange = start !== undefined ? `${start}-${end ?? start}` : '';
  const rawString = `${input.filePath}|${lineRange}|${input.persona.toLowerCase()}|${normalizedCode}|${normalizedSummary}`;
  ```
- **Attack / Failure Scenario**: In multi-commit PR updates, if lines are inserted above an existing finding, the reviewer tools report the finding at its new line number (e.g. line 25 instead of line 10). Because `${lineRange}` is part of the hash, the SHA-256 hash changes completely (`99b65d60...` vs `765b8b25...`).
- **Blast Radius**: `DiffStateManager` fails to correlate the shifted finding with its previous state, creating duplicate active findings (`IDENTIFIED`) for the same underlying issue across commits.
- **Flawed Test Alert**: Existing unit test `1.1` in `tests/unit/diffStateStress.test.ts` passed only because `startLine` was accidentally omitted from test input fixtures `fLine10` and `fLine500`, masking this defect.
- **Empirical Evidence**: In `test_empirical.ts` (Test 2), `computeFindingHash` produced distinct hashes (`99b65d60...` vs `765b8b25...`) for identical code snippets and comments when line numbers shifted.
- **Mitigation**: Omit absolute line numbers from `computeFindingHash` (or rely on `normalizedCode`, `persona`, `filePath`, and `ruleId/comment`) so fingerprints remain invariant across line shifts.

---

### 3. [MEDIUM] SQLite `updateFindingStatus` Does Not Clear `resolvedAtCommit` on Re-Opening (`db.ts`)

- **Component**: `src/persistence/db.ts` (lines 297–304)
- **Mechanism**: In `SqliteDiffStateStorage.updateFindingStatus`:
  ```typescript
  const resolvedAt = status === 'RESOLVED' ? commitSha : null;
  this.db.prepare(`
    UPDATE tracked_findings
    SET status = ?, last_seen_commit = ?, resolved_at_commit = COALESCE(?, resolved_at_commit), updated_at = ?
    WHERE pr_state_id = ? AND fingerprint_hash = ?
  `).run(status, commitSha, resolvedAt, now, prRow.id, fingerprintHash);
  ```
  When `status` is updated to `'IDENTIFIED'` (re-opening a resolved finding), `resolvedAt` is `null`. `COALESCE(null, resolved_at_commit)` retains the old non-null `resolved_at_commit` timestamp.
- **Attack / Failure Scenario**: When a critical finding is re-opened, calling `updateFindingStatus` sets `status = 'IDENTIFIED'`, but `resolved_at_commit` remains populated with the previous resolution commit SHA.
- **Blast Radius**: Audit log inconsistency where active findings report a non-null `resolved_at_commit`.
- **Empirical Evidence**: In `test_empirical.ts` (Test 3), `resolvedAtCommit` retained `'c1'` after the finding status was changed back to `'IDENTIFIED'`.
- **Mitigation**: Update SQL statement to `CASE WHEN ? = 'RESOLVED' THEN ? ELSE NULL END` or explicitly set `resolved_at_commit = ?`.

---

## Stress Test Harness Results

Summary of empirical stress harness (`test_empirical.ts`) execution:

| Test | Scenario | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Deletion Hunk Overlap (`newLines = 0`) | Status -> `RESOLVED` | Status -> `IDENTIFIED` | ❌ FAIL |
| 2 | Line-Shifted Finding Fingerprint | `hash1 === hash2` | `hash1 !== hash2` | ❌ FAIL |
| 3 | SQLite Re-Open `resolvedAtCommit` | `resolvedAtCommit === null` | `resolvedAtCommit === 'c1'` | ❌ FAIL |
| 4 | SQLite CRUD & Prepared Statements | Success | Success | ✅ PASS |
| 5 | Atomic JSON Concurrent Writes | Success | Success | ✅ PASS |

---

## Build & Test Execution Summary

1. `npm run build`: **PASSED** (`tsc` executed with 0 compilation errors).
2. `npm test`: **PASSED** (10 test files passed, 90 unit/integration tests passed).
3. `test_empirical.ts`: **FAILED** (3 specific failure modes reproduced empirically).

---

## Conclusion

Milestone 1 state persistence cannot be recommended for PASS due to the 3 empirical failure modes detailed above.
