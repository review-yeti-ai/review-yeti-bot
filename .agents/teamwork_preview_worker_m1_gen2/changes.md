# Worker Iteration 2 Change Log

## Task Summary
Remediated all 5 issue areas identified during Milestone 1 review, challenge, and forensic audit for `ct-review-bot`.

---

## 1. `vitest.config.ts` Fix
- **Files Modified**: `vitest.config.ts`
- **Changes**:
  - Updated `resolve.alias` to map `'@src'` -> `path.resolve(__dirname, 'src')` and `'@harness'` -> `path.resolve(__dirname, 'tests/e2e/harness')`.
  - Updated `test.include` to `['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts']` so standard `npm test` executes unit and integration tests cleanly without failing on E2E test suite files.

---

## 2. Ticket Linkage Engine (`src/ticket/ticketValidator.ts` & `tests/unit/ticket.test.ts`)
- **Files Modified**: `src/ticket/ticketValidator.ts`, `tests/unit/ticket.test.ts`
- **Changes**:
  - Updated `LINEAR` and `JIRA` ticket regexes to use case-insensitive `/gi` flags and expanded prefix matching to support lowercase keys (e.g., `proj-123`, `key-456`).
  - Updated `GITHUB` ticket regex prefix boundary from `(?:^|\s)` to `(?:^|[\s(\[:])` and cleaned leading delimiter characters so issue references enclosed in parentheses `(#789)`, brackets `[#789]`, or after colons `: #789` are extracted cleanly.
  - Expanded ticket project prefix length limit from `[A-Z]{2,10}` to `[A-Za-z0-9_]{1,32}` to support project prefixes up to 32 characters long.
  - Added unit test coverage for lowercase ticket keys, bracket/paren/colon GitHub issue references, and long ticket prefixes.

---

## 3. Operational Constitution Engine (`src/constitution/constitutionEngine.ts` & `tests/unit/constitution.test.ts`)
- **Files Modified**: `src/constitution/constitutionEngine.ts`, `tests/unit/constitution.test.ts`
- **Changes**:
  - Updated backtick regex pattern extractor in `parseConstitution` to support escaped slashes like `` `/\/api\/v1\//` `` using `/`\\?\/((?:\\\/|[^\/])+)\\?\/([gimsuy]*)`/` and unescaping `/` backslashes cleanly.
  - Added `prohibit` to rule classification regex so non-regex rules starting with `- Prohibit ...` are categorized as `forbidden_pattern`.
  - Implemented `checkNonRegexForbiddenRule` to evaluate natural language non-regex forbidden rules (e.g., `- Never use eval in code`, `- Prohibit hardcoded JWT secrets`) against PR titles, bodies, and file content/patches using phrase and keyword token matching.
  - Expanded directive evaluation beyond fixed magic strings to evaluate PR titles (including conventional commits format) and PR summaries/descriptions against PR metadata.
  - Added unit test coverage for backtick escaped slashes, non-regex natural language forbidden rules, and expanded directive guidelines.

---

## 4. Incremental Diff State Manager (`src/persistence/diffStateManager.ts`, `src/utils/diffHash.ts`, `src/persistence/db.ts`, `tests/unit/diffState.test.ts`, `tests/unit/diffStateStress.test.ts`)
- **Files Modified**: `src/persistence/diffStateManager.ts`, `src/utils/diffHash.ts`, `src/persistence/db.ts`, `tests/unit/diffState.test.ts`, `tests/unit/diffStateStress.test.ts`
- **Changes**:
  - Fixed finding resolution in `DiffStateManager.processPRCommitUpdate()`: Replaced file-level `isFileModified` check with modified hunk line range overlap/intersection check (`hStart <= fEnd && hEnd >= fStart`). Untouched findings in unmodified sections of a modified file are preserved as `IDENTIFIED` when only other hunks in the file are reviewed.
  - Updated `computeFindingHash()` in `src/utils/diffHash.ts` to include `startLine`/`endLine` (or `lineNumber`) and optional `ruleId`/`findingId` in raw hash payload so multiple identical findings on different lines of the same file produce distinct hashes and do not collide in `incomingFindingsMap`.
  - Ensured consistent hyphen normalization across `ruleId` and `comment` using `normalizeComment`.
  - Updated `JsonFileDiffStateStorage` in `src/persistence/db.ts` to track disk `mtimeMs` and re-read state from disk before saving if another instance modified the file.
  - Updated unit and stress test suites to verify line range overlap resolution, finding hash differentiation, and cross-instance disk reloading.

---

## 5. Express App & Logger (`src/app.ts`, `src/gateway/omniRouteClient.ts`, `src/utils/logger.ts`, `tests/unit/logger.test.ts`, `tests/unit/app.test.ts`)
- **Files Modified**: `src/app.ts`, `src/gateway/omniRouteClient.ts`, `src/utils/logger.ts`, `tests/unit/logger.test.ts`, `tests/unit/app.test.ts`
- **Changes**:
  - Wrapped async route handling in `src/app.ts` `webhookHandler` in `try { ... } catch (err) { next(err); }` and returned HTTP 500 JSON error payload (`{ error: 'Internal Server Error', message: ... }`) on unhandled exceptions.
  - Extracted `changedFiles` from webhook request payload and passed to `evaluateConstitution` in `src/app.ts` so diff file rules are evaluated during webhook processing.
  - Fixed TypeScript type casting in `omniRouteClient.ts`.
  - Updated `Logger.shouldLog` in `src/utils/logger.ts` to use `this.currentLevel` directly so `logger.setLevel()` programmatically sets the active log level cleanly.
  - Added unit test suite in `tests/unit/app.test.ts` covering `/webhook` POST endpoints, HMAC signature verification (success and 401 failure), `pull_request` & `issue_comment` event handling, and HTTP 500 error mapping.

---

## Build and Test Verification Results
- **`npm run build`**: 100% compilation success with zero TypeScript errors.
- **`npm test`**: 100% pass across all unit and integration test suites (9 test files, 75 tests passed).
- **`npm run test:e2e`**: 100% pass across all E2E test suites (8 test files, 60 tests passed).
