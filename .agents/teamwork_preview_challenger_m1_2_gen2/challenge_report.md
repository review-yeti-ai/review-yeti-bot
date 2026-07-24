# Challenge Report: Milestone 1 Iteration 2 Re-Test

**Challenger**: Challenger 2
**Date**: 2026-07-24
**Target Project**: `ct-review-bot` (Milestone 1 Iteration 2 Remediation)
**Verdict**: **FAIL** (Overall test suite failure in `npm test`: 1 failed test in `constitution.test.ts`; Diff State Manager & Persistence layer stress suite 100% PASS: 14/14)

---

## Challenge Summary

**Overall Risk Assessment**: **MEDIUM**

Re-testing of the remediated Diff State Manager and Persistence layer demonstrates that all 5 previous iteration challenges related to diff state tracking, partial file edits, fingerprint hash collisions, JSON storage disk overwrites, and hyphen normalization have been **successfully remediated** and verified with 14/14 passing stress test scenarios.

However, standard `npm test` still fails out-of-the-box with **1 failing unit test** in `tests/unit/constitution.test.ts` due to a regression/defect in `src/constitution/constitutionEngine.ts` regex parsing for backtick expressions starting with escaped slashes.

---

## Stress Test Results (14 Scenarios)

| Test Scenario | Module | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| **1.1 Shifted line numbers** | `diffHash` | Identical SHA-256 fingerprint when line numbers shift | `computeFindingHash` returned identical fingerprint | **PASS** |
| **1.2 Line ending variations (CRLF vs LF)** | `diffHash` | Identical hunk hash across CRLF/LF line endings | `computeHunkHash` matched | **PASS** |
| **1.3 Whitespace & blank line variations** | `diffHash` | Snippets and comments normalized | `normalizeSnippet` and `computeFindingHash` matched | **PASS** |
| **1.4 Hunk line number shift** | `diffHash` | Identical hunk hash despite hunk line offset | `computeHunkHash` matched | **PASS** |
| **1.5 Multi-finding same-file collision** | `diffHash` / `DiffStateManager` | Findings at line 10 and 90 generate distinct fingerprint hashes | Hash line range inclusion prevented collision (`hash1 !== hash2`) | **PASS** |
| **1.6 RuleId vs comment hyphen normalization** | `diffHash` | Matching hashes for `ruleId: 'SEC-001'` vs `comment: 'SEC-001'` | `normalizeComment` produced identical hashes | **PASS** |
| **2.1 Status transition: IDENTIFIED -> RESOLVED** | `DiffStateManager` | Finding marked `RESOLVED` when fixed in commit 2 | Status set to `RESOLVED` with `resolvedAtCommit: 'sha2'` | **PASS** |
| **2.2 Non-critical finding duplicate suppression** | `DiffStateManager` | Transition `RESOLVED` -> `SUPPRESSED` when non-critical finding recurs | Status set to `SUPPRESSED` | **PASS** |
| **2.3 Critical finding regression re-open** | `DiffStateManager` | Transition `RESOLVED` -> `IDENTIFIED` when critical finding recurs | Status re-opened to `IDENTIFIED` | **PASS** |
| **2.4 Untouched finding in partial file edit** | `DiffStateManager` | Untouched finding at line 10 stays `IDENTIFIED` when line 200 is edited | Hunk range overlap check `hStart <= fEnd && hEnd >= fStart` kept line 10 `IDENTIFIED` | **PASS** |
| **3.1 SQL Injection safety** | `SqliteDiffStateStorage` | Parameterized statements handle single/double quotes & SQL keywords | Query executed cleanly and safely | **PASS** |
| **3.2 Concurrent JSON reads/writes** | `JsonFileDiffStateStorage` | 10 concurrent PR state writes preserved | All 10 PR states written & read back accurately | **PASS** |
| **3.3 Automatic SQLite -> JSON failover** | `createDiffStateStorage` | Failover to JSON engine when DB path invalid | Storage created as `JsonFileDiffStateStorage` | **PASS** |
| **3.4 Cross-instance JSON disk re-sync** | `JsonFileDiffStateStorage` | Disk `mtime` check re-loads disk state before write | Instance 2 preserved Instance 1 state (`state101` not null) | **PASS** |

---

## Root Test Suite Verification Findings

### [HIGH] Challenge 1: `npm test` Failure in `tests/unit/constitution.test.ts`

- **Assumption Challenged**: Executing standard `npm test` passes 100% of unit and integration tests.
- **Attack Scenario**:
  1. CI pipeline or developer executes `npm test`.
  2. Test `parses backtick regexes containing escaped slashes` in `tests/unit/constitution.test.ts` executes `parseConstitution("# API Security Policy\n- Prohibit internal route exposure \`\\/api\\/v1\\/\`.")`.
  3. `constitutionEngine.ts` regex `/`\/((?:\\\/|[^\/])+)\/([gimsuy]*)`/` attempts to match \`/...\/\`.
  4. Because the backtick string starts with `\` (backslash), line 86 fails to extract the pattern, leaving `parsed.rules[0].pattern` as `undefined`.
  5. Vitest throws `AssertionError: expected undefined not to be undefined` at line 95.
- **Blast Radius**: CI pipeline build failure and false negative in unit test suite.
- **Mitigation**: Update `src/constitution/constitutionEngine.ts` regex at line 86 to handle leading backslashes before slashes: `match(/`\\?\/((?:\\\/|[^\/])+)\\?\/([gimsuy]*)`/);`.
- **Empirical Evidence**: `npm test` output:
  ```text
  FAIL tests/unit/constitution.test.ts > Operational Constitution Engine > parses backtick regexes containing escaped slashes
  AssertionError: expected undefined not to be undefined
   ❯ tests/unit/constitution.test.ts:95:37
  ```

---

## Detailed Evaluation of Remediation Targets

1. **Partial File Edits Finding Resolution (RESOLVED & VERIFIED)**:
   - In `src/persistence/diffStateManager.ts`, the commit update process was updated to evaluate line range overlap between reviewed hunks and existing findings:
     ```typescript
     const isFindingInReviewedHunk = reviewedHunks.some(
       hunk => hunk.filePath === f.filePath && (hunk.newStart <= f.endLine && (hunk.newStart + hunk.newLines) >= f.startLine)
     );
     ```
   - In test scenario 2.4, modifying line 200 of `src/bigFile.ts` while leaving line 10 untouched correctly preserves Finding A (line 10) in status `IDENTIFIED`.

2. **Fingerprint Hash Uniqueness (RESOLVED & VERIFIED)**:
   - In `src/utils/diffHash.ts`, `computeFindingHash()` now includes `startLine` and `endLine` in the hash computation payload.
   - In test scenario 1.5, two identical security findings at lines 10 and 90 yield distinct fingerprints, preventing state map overwrite.

3. **Cross-Instance JSON Storage Disk Re-Sync (RESOLVED & VERIFIED)**:
   - `JsonFileDiffStateStorage` checks `fs.statSync(this.filePath).mtimeMs` before executing `savePRState()`.
   - In test scenario 3.4, Instance 2 re-loads updated state from disk prior to saving PR 200, successfully preserving PR 101 state written by Instance 1.

4. **Hyphen Normalization (RESOLVED & VERIFIED)**:
   - `normalizeComment()` is applied consistently across both `ruleId` and `comment` fields.
   - In test scenario 1.6, findings with `ruleId: 'SEC-001'` and `comment: 'SEC-001'` produce identical hashes.

---

## Unchallenged Areas

- **SQLite WAL Mode Multi-process Concurrency**: Default single-process file locking was tested; WAL mode multi-process lock contention was out of scope for Milestone 1.
