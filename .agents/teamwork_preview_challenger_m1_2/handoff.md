# Handoff Report: Milestone 1 Incremental Diff State Manager & Persistence Layer

**Agent**: Challenger 2
**Date**: 2026-07-24
**Verdict**: **FAIL**

---

## 1. Observation

- **Root Test Command Failure**:
  Command: `npm test`
  Output: Exit code 1.
  Errors:
  `FAIL tests/e2e/tier1/config.test.ts`
  `FAIL tests/e2e/tier1/constitution.test.ts`
  `FAIL tests/e2e/tier1/quorum.test.ts`
  `FAIL tests/e2e/tier1/ticket.test.ts`
  `FAIL tests/e2e/tier1/diffState.test.ts`
  `FAIL tests/e2e/tier1/omniRoute.test.ts`
  `FAIL tests/e2e/tier1/webhook.test.ts`
  `Error: Failed to load url @harness/e2eTestRunner (resolved id: @harness/e2eTestRunner) in ...`

- **Critical Logic Flaw in `src/persistence/diffStateManager.ts`**:
  Lines 165–175:
  ```ts
  const isFileModified = hunks.some(h => h.filePath === prevFinding.filePath);
  if (prevFinding.status === 'IDENTIFIED') {
    if (isFileModified) {
      updatedFindingsMap.set(hash, {
        ...prevFinding,
        status: 'RESOLVED',
        resolvedAtCommit: headSha,
        updatedAt: now,
      });
    }
  }
  ```
  Empirical test result from `tests/unit/diffStateStress.test.ts` (Test 2.4):
  In a multi-commit PR modifying `bigFile.ts` at line 200, an untouched finding at line 10 had its status changed from `IDENTIFIED` to `RESOLVED` because `isFileModified` was `true`.

- **Fingerprint Hash Collision in `src/utils/diffHash.ts`**:
  Lines 58–66:
  ```ts
  export function computeFindingHash(input: FindingInput): string {
    const normalizedCode = normalizeSnippet(input.codeSnippet);
    const normalizedSummary = input.ruleId
      ? input.ruleId.toLowerCase().trim()
      : normalizeComment(input.comment);

    const rawString = `${input.filePath}|${input.persona.toLowerCase()}|${normalizedCode}|${normalizedSummary}`;
    return crypto.createHash('sha256').update(rawString, 'utf8').digest('hex');
  }
  ```
  Empirical test result (Test 1.5): Two identical code snippet findings at line 10 and line 90 in the same file generated identical SHA-256 hashes (`computeFindingHash(f1) === computeFindingHash(f2)`), causing one finding to be overwritten in `incomingFindingsMap`.

- **JSON Storage Overwrite Risk in `src/persistence/db.ts`**:
  Lines 364–369: `savePRState` flushes internal `this.data` map without re-reading the file state.
  Empirical test result (Test 3.4): Instance 2 overwrote Instance 1's write, resulting in lost PR state updates.

---

## 2. Logic Chain

1. `npm test` runs `vitest run` using `vitest.config.ts`. Because `vitest.config.ts` matches `tests/**/*.test.ts` without path aliases (`@harness` and `@src`), 7 E2E test files fail during module import.
2. In `DiffStateManager.processPRCommitUpdate`, incremental diff analysis filters hunks so that `hunksToReview` only contains modified code blocks. Reviewers assess ONLY these hunks and emit findings for them. Unmodified hunks are not sent to reviewers, so no findings are generated for unmodified hunks.
3. When `DiffStateManager` checks previous findings, it checks `isFileModified = hunks.some(h => h.filePath === prevFinding.filePath)`. If any hunk in the file was modified, `isFileModified` is true for ALL findings in that file. Findings located in untouched hunks are not returned in `quorumFindings`. `DiffStateManager` interprets their absence as a code fix and changes their status to `RESOLVED`.
4. Therefore, active bugs/vulnerabilities in unchanged sections of modified files are silently closed as resolved.
5. In `computeFindingHash`, line numbers are omitted from the fingerprint input string. Two occurrences of the same error in a single file produce identical hashes. In `DiffStateManager`, `incomingFindingsMap.set(hash, f)` overwrites the first occurrence, dropping findings from tracking.

---

## 3. Caveats

- `better-sqlite3` native bindings required rebuilding (`npm rebuild better-sqlite3`) to run in this Node environment. SQLite persistence functions properly when native bindings are present.
- Unit tests (`npx vitest run tests/unit`) and E2E tests run via `npm run test:e2e:tier1` pass. The failure of `npm test` is strictly a configuration issue in `vitest.config.ts`.

---

## 4. Conclusion

The Milestone 1 Incremental Diff State Manager & Persistence layer receives a **FAIL** verdict.

Key blockers:
1. **Critical Defect**: Untouched findings in modified files are incorrectly marked as `RESOLVED`.
2. **Build/Test Failure**: `npm test` fails out of the box due to missing vitest path aliases.
3. **Data Loss Defect**: Fingerprint hash collisions cause duplicate findings in single files to be lost.

---

## 5. Verification Method

To independently verify these findings:

1. **Verify `npm test` failure**:
   Run command: `npm test`
   Observe 7 failed test suites due to `@harness/e2eTestRunner` resolution error.

2. **Verify empirical stress test suite**:
   Run command: `npx vitest run tests/unit/diffStateStress.test.ts`
   Inspect Test 2.4 (`CRITICAL EDGE CASE: Partial file edits resolve untouched findings in modified file!`). Observe `findingA?.status` evaluates to `'RESOLVED'`.
