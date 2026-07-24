# Challenge Report: Milestone 1 Incremental Diff State Manager & Persistence

**Challenger**: Challenger 2
**Date**: 2026-07-24
**Target Project**: `ct-review-bot` (Milestone 1)
**Verdict**: **FAIL**

---

## Challenge Summary

**Overall Risk Assessment**: **HIGH**

While the core SHA-256 diff hashing algorithm correctly normalizes line endings (CRLF vs LF) and line-number shifts, empirical testing revealed critical logic flaws in `DiffStateManager` state transitions, test suite configuration errors causing `npm test` to fail out of the box, fingerprint hash collisions dropping findings within single files, and cross-instance data loss risk in the JSON atomic persistence layer.

---

## Challenges & Empirical Findings

### [CRITICAL] Challenge 1: Partial File Edits Incorrectly Resolve Untouched Findings in Modified Files

- **Assumption Challenged**: `DiffStateManager` assumes that if *any* hunk in a file is modified in a commit (`isFileModified = hunks.some(h => h.filePath === prevFinding.filePath)`), all existing findings in that file not present in the current review pass are `RESOLVED`.
- **Attack Scenario**:
  1. A PR touches `src/bigFile.ts`, containing Hunk A (line 10, Finding A) and Hunk B (line 200, Finding B). Both findings are tracked as `IDENTIFIED`.
  2. In a subsequent commit, the author modifies ONLY line 200 (fixing Finding B).
  3. Incremental diff review computes `hunksToReview`, which contains ONLY Hunk B (line 200). Hunk A (line 10) was not changed, so it is not re-sent to AI reviewers.
  4. AI reviewers evaluate Hunk B and return no findings for Hunk B.
  5. `DiffStateManager` processes the update. `isFileModified` evaluates to `true` for `src/bigFile.ts`.
  6. `DiffStateManager` sees Finding A is not in `quorumFindings` and marks Finding A as **`RESOLVED`**, despite Finding A at line 10 being untouched and unfixed!
- **Blast Radius**: Active critical security vulnerabilities and code quality bugs are silently closed as resolved whenever a developer touches any other part of the same file in a later commit.
- **Mitigation**: Resolution logic must check whether the finding's line range falls within one of the modified `hunksToReview`, rather than checking file-level modification.
- **Empirical Evidence**: Test `2.4` in `tests/unit/diffStateStress.test.ts` reproduced this exact state transition error.

---

### [HIGH] Challenge 2: `npm test` Execution Failure Out-of-the-Box

- **Assumption Challenged**: Standard `npm test` executes the complete test suite successfully.
- **Attack Scenario**:
  1. Developer or CI pipeline executes `npm test`.
  2. `package.json` runs `vitest run` using root `vitest.config.ts`.
  3. `vitest.config.ts` includes `tests/**/*.test.ts`, matching E2E test files (`tests/e2e/tier1/*.test.ts`).
  4. `vitest.config.ts` lacks path aliases (`resolve.alias` for `@harness` and `@src`).
  5. Vitest fails to resolve `@harness/e2eTestRunner` in 7 E2E test suites.
- **Blast Radius**: CI/CD build failure, broken default developer feedback loop.
- **Mitigation**: Update `vitest.config.ts` to exclude `tests/e2e/**` (delegating them to `vitest.config.e2e.ts`) or add `@harness` and `@src` aliases to `vitest.config.ts`.
- **Empirical Evidence**: Command `npm test` returned exit code 1 with 7 failed suites.

---

### [MEDIUM] Challenge 3: Fingerprint Hash Collisions Drop Identical Findings in Single File

- **Assumption Challenged**: `computeFindingHash` generates unique fingerprint hashes for all findings in a PR.
- **Attack Scenario**:
  1. A file `src/handler.ts` contains two separate instances of unhandled errors at line 10 and line 90.
  2. The reviewer emits two findings with identical `persona`, `codeSnippet`, and `comment`.
  3. `computeFindingHash` ignores line numbers and constructs the hash using `${filePath}|${persona}|${normalizedCode}|${normalizedSummary}`.
  4. Both findings yield identical SHA-256 hashes.
  5. `DiffStateManager` puts findings into `incomingFindingsMap.set(hash, f)`, overwriting the first finding with the second.
- **Blast Radius**: One or more duplicate findings in the same file are dropped and never tracked or reported.
- **Mitigation**: Incorporate structural context (e.g. AST path, function scope, or line number bucket) into fingerprint hash calculation, or handle duplicate hash arrays in `DiffStateManager`.
- **Empirical Evidence**: Test `1.5` in `tests/unit/diffStateStress.test.ts`.

---

### [MEDIUM] Challenge 4: Cross-Instance JSON Storage Overwrite Risk

- **Assumption Challenged**: `JsonFileDiffStateStorage` provides safe persistence when multiple application instances operate on the same data file.
- **Attack Scenario**:
  1. Storage Instance 1 and Storage Instance 2 initialize pointing to `./data/pr_states.json`.
  2. Instance 1 writes state for PR 101.
  3. Instance 2 receives a webhook for PR 200 and calls `savePRState` without reading/re-syncing the file from disk first.
  4. Instance 2 overwrites `./data/pr_states.json` with its stale in-memory map, completely wiping out PR 101's updated state.
- **Blast Radius**: Total data loss for concurrent PR state updates in JSON fallback mode.
- **Mitigation**: Re-read file state before atomic write or implement file locking (`proper-lockfile`).
- **Empirical Evidence**: Test `3.4` in `tests/unit/diffStateStress.test.ts`.

---

### [LOW] Challenge 5: `ruleId` vs `comment` Hyphen Normalization Mismatch

- **Assumption Challenged**: Findings referring to the same rule produce identical hashes regardless of whether specified via `ruleId` or `comment`.
- **Attack Scenario**:
  - `computeFindingHash` normalizes `ruleId` via `.toLowerCase().trim()` (preserving hyphens, e.g., `"sec-001"`).
  - When `ruleId` is omitted, `normalizeComment("SEC-001")` applies `/[^\w\s]/g`, stripping hyphens (`"sec001"`).
  - A finding reported with `ruleId: 'SEC-001'` in commit 1 and `comment: 'SEC-001'` in commit 2 generates non-matching hashes.
- **Blast Radius**: Failure to deduplicate identical findings across different reviewer backends.
- **Mitigation**: Standardize rule ID and comment normalization regexes.
- **Empirical Evidence**: Test `1.6` in `tests/unit/diffStateStress.test.ts`.

---

## Stress Test Results

| Test Scenario | Module | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| Shifted line numbers (Line 10 vs 500) | `diffHash` | Identical SHA-256 fingerprint | `computeFindingHash` matched | **PASS** |
| CRLF vs LF line endings | `diffHash` | Identical hunk hash | `computeHunkHash` matched | **PASS** |
| Leading/trailing whitespace & blank lines | `diffHash` | Normalized code snippet | `normalizeSnippet` matched | **PASS** |
| Hunk line number shift | `diffHash` | Identical hunk hash | `computeHunkHash` matched | **PASS** |
| SQL Injection strings (`' OR '1'='1`) | `SqliteDiffStateStorage` | Prepared statements sanitize inputs | Query executed safely | **PASS** |
| SQLite to JSON fallback | `createDiffStateStorage` | Failover to JSON engine when DB path invalid | Storage created as `JsonFileDiffStateStorage` | **PASS** |
| Non-critical finding duplicate suppression | `DiffStateManager` | Transition `RESOLVED` -> `SUPPRESSED` | Status set to `SUPPRESSED` | **PASS** |
| Critical finding regression re-open | `DiffStateManager` | Transition `RESOLVED` -> `IDENTIFIED` | Status re-opened to `IDENTIFIED` | **PASS** |
| **Partial file edit finding resolution** | `DiffStateManager` | Untouched finding stays `IDENTIFIED` | Untouched finding marked `RESOLVED` | **FAIL** |
| **Root test suite execution (`npm test`)** | Root runner | All tests pass | 7 E2E suites fail with alias error | **FAIL** |
| **Same-file finding collision** | `diffHash` / `DiffStateManager` | Both findings tracked | Second finding overwrites first | **FAIL** |
| **JSON storage concurrent instances** | `JsonFileDiffStateStorage` | Concurrent updates preserved | Instance 2 overwrote Instance 1 | **FAIL** |

---

## Unchallenged Areas

- **Memory overhead under millions of PR states**: Insufficient high-volume dataset available in current test environment.
- **SQLite WAL mode performance under multi-thread write contention**: Standard single-connection SQLite mode tested.
