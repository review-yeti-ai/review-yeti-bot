# Milestone 1 Code Review & Stress-Test Report

**Reviewer**: Reviewer 2 & Critic (teamwork_preview_reviewer_m1_2)  
**Date**: 2026-07-24  
**Verdict**: REJECT (REQUEST_CHANGES)

---

## Executive Summary

Milestone 1 implements foundational modules for ticket linkage validation (`src/ticket/ticketValidator.ts`), repository constitution parsing and evaluation (`src/constitution/constitutionEngine.ts`), SHA-256 diff hunk hashing and finding fingerprinting (`src/utils/diffHash.ts`), dual-engine persistence (SQLite with automatic JSON file fallback in `src/persistence/db.ts`), and diff state transition management (`src/persistence/diffStateManager.ts`).

While the core implementation logic across all components is solid, robustly implemented, and free of malicious shortcuts or hardcoding, **`npm test` fails out of the box** due to a configuration flaw in `vitest.config.ts` where E2E test files are included without the required `@harness` path alias.

---

## Test Execution Results

- **`npm run build`**: **PASS** (Clean TypeScript compilation with 0 errors)
- **`npm test`**: **FAIL** (Exit code 1 - 2 E2E test suites fail due to unresolved `@harness` alias)
- **`npx vitest run tests/unit tests/integration`**: **PASS** (47/47 unit & integration tests pass)
- **`npm run test:e2e`**: **PASS** (58/58 E2E tests pass)

---

## Review Findings

### 1. [Major / Blocking] `npm test` Fails due to `vitest.config.ts` Path Alias Misconfiguration
- **What**: Executing `npm test` fails with 2 suite failures in `tests/e2e/tier1/config.test.ts` and `tests/e2e/tier1/quorum.test.ts`.
- **Where**: `vitest.config.ts` line 7 vs `package.json` line 10.
- **Why**: `vitest.config.ts` sets `include: ['tests/**/*.test.ts']`, which captures E2E test files under `tests/e2e/`. However, `vitest.config.ts` does not define `resolve.alias` for `@harness` (which is only configured in `vitest.config.e2e.ts`), resulting in `Error: Failed to load url @harness/e2eTestRunner`.
- **Suggestion**: Exclude `tests/e2e/` from `vitest.config.ts` (`exclude: ['node_modules/', 'dist/', 'tests/e2e/']`) so `npm test` runs unit and integration tests cleanly, or add the `@harness` alias to `vitest.config.ts`.

### 2. [Minor / Quality] `evaluateConstitution` Fallback Matching for Plain-Text Rules
- **What**: When a constitution rule is parsed without an inline regex (e.g., `- Forbidden: Do not use eval()`), `evaluateConstitution` only checks hardcoded keyword strings (`console.log`, `pr description must contain`).
- **Where**: `src/constitution/constitutionEngine.ts` lines 128-146.
- **Why**: Non-regex rules in markdown will be ignored during evaluation unless they match specific hardcoded strings.
- **Suggestion**: Auto-generate a RegExp or perform lower-case substring search on the rule description when no explicit `/pattern/` is provided in the markdown bullet.

---

## Component Verification Details

### 1. Ticket Linkage Validation (`src/ticket/ticketValidator.ts`)
- Verified regex patterns for Linear (`PROJ-123`, `[PROJ-123]`), Jira (`KEY-456`, `[KEY-456]`), GitHub (`#789`, `owner/repo#101`, `GH-202`), and custom regex patterns.
- Verified mode handling: `strict` mode correctly invalidates PRs without ticket linkage and returns descriptive errors; `advisory` mode logs warning and permits PR.
- Verified deduplication of tickets across title and body text.

### 2. Constitution Parser & Engine (`src/constitution/constitutionEngine.ts`)
- Verified markdown parser for headings (`#`, `##`, `###`), bullet types (`-`, `*`, `+`, `1.`, `- [ ]`, `- [x]`), and inline regex extraction (`/pattern/flags`).
- Verified RegExp state safety (`rule.pattern.lastIndex = 0`) preventing state leaks across file iterations during evaluation.

### 3. SHA-256 Diff Hashing & Fingerprinting (`src/utils/diffHash.ts`)
- Verified CRLF to LF normalization in `normalizeSnippet` and line-end trimming in `computeHunkHash`.
- Verified `computeFindingHash` excludes line numbers, ensuring finding fingerprints remain stable when code shifts vertically.

### 4. Persistence Engine (`src/persistence/db.ts` & `src/persistence/diffStateManager.ts`)
- Verified SQLite schema initialization, foreign key constraints, indexes, and transactions.
- Verified automatic failover from SQLite to `JsonFileDiffStateStorage` when `better-sqlite3` native bindings are missing.
- Verified atomic JSON file writes via temporary file creation, `fsyncSync`, and `renameSync`.
- Verified multi-commit finding transitions: `IDENTIFIED` -> `RESOLVED` on code fix, re-opening critical findings on regression, suppressing resolved nits.

---

## Integrity Violation Audit

- **Hardcoded test outputs in source code**: None detected.
- **Facade / Dummy implementations**: None detected.
- **Bypasses or shortcuts**: None detected.
- **Fabricated attestation artifacts**: None detected.

---

## Stress-Testing & Adversarial Analysis

- **Scenario 1: Line Number Shift**: Modified code above line 10 to shift finding to line 50. Handled correctly; finding hash remains identical (`computeFindingHash` ignores line numbers).
- **Scenario 2: Windows Line Endings (`\r\n`)**: Input with `\r\n` produces identical hash as `\n` input.
- **Scenario 3: SQLite Native Module Failover**: Simulated `better-sqlite3` missing binary. `createDiffStateStorage` successfully catches exception and falls back to atomic JSON file storage.
- **Scenario 4: Re-opened Critical Finding**: Re-introducing critical finding after resolution changes status back to `IDENTIFIED` and clears `resolvedAtCommit`. Re-introducing resolved nit sets status to `SUPPRESSED`.
