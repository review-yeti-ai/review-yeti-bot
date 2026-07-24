# White-Box Gap Analysis & Tier 5 Adversarial Test Specifications Report

**Agent Identity**: challenger_m6_1 (EMPIRICAL CHALLENGER: critic, specialist)  
**Target Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Target Scope**: `src/config/`, `src/ticket/`, `src/constitution/`, `src/persistence/`, `src/utils/` and unit/E2E test suite.  

---

## 1. Observation

Direct empirical observations from source code inspection and test execution:

1. **Test Suite Baseline**:
   - `vitest run tests/unit/config.test.ts tests/unit/constitution.test.ts tests/unit/diffState.test.ts tests/unit/logger.test.ts` passed 27 out of 27 unit tests.
   - `better-sqlite3` native binary version mismatch (`NODE_MODULE_VERSION 137` vs Node runtime `147`) triggers automatic fallback from SQLite to `JsonFileDiffStateStorage` in `src/persistence/db.ts:434`.

2. **`src/config/configLoader.ts` & `src/config/schema.ts`**:
   - **Line 75-77 (`configLoader.ts`)**: `if (typeof parsedRaw !== 'object' || parsedRaw === null) { parsedRaw = {}; }`. In JavaScript, `typeof [1, 2, 3] === 'object'`. Passing a YAML list (e.g. `- item1\n- item2`) is treated as a valid object, merged via `deepMergeConfig`, and safe-parsed by Zod without throwing `ConfigValidationError`.
   - **Line 25-27 (`configLoader.ts`)**: `if (targetVal === undefined || targetVal === null) { continue; }`. Passing `null` for an object property in user config does not clear or disable it; it silently falls back to `DEFAULT_ORG_CONFIG`.
   - **Line 26 (`schema.ts`)**: `providers: z.array(TicketProviderEnum).default(['linear', 'jira', 'github'])`. Setting `providers: []` is permitted by Zod schema, but causes `validateTicketLinkage` to fail all PRs in `strict` mode.

3. **`src/ticket/ticketProviderClient.ts` & `src/ticket/ticketValidator.ts`**:
   - **Line 35 (`ticketProviderClient.ts`)**: `query: 'query { issue(id: "' + ticketId + '") { id title state { name } } }'`. `ticketId` is concatenated directly into GraphQL query string without escaping quotes (`"`) or GraphQL syntax, creating GraphQL injection risk.
   - **Lines 47 & 62 (`ticketProviderClient.ts`)**: Parameters `key`, `owner`, `repo`, `issueNum` in REST endpoints are passed directly into URLs without `encodeURIComponent()`.
   - **Lines 17-19 (`ticketValidator.ts`)**: Ticket pattern regexes `TICKET_PATTERNS.LINEAR` and `JIRA` match any uppercase letter sequence followed by digits `([A-Za-z0-9_]{1,32}-\d+)`. Generic strings like `UTF-8`, `SHA-256`, `ISO-8601`, `COVID-19`, `LOG-1` in PR titles/bodies are extracted as ticket references.
   - **Lines 55-65 (`ticketValidator.ts`)**: Custom regex evaluation in `config.patterns` swallows `SyntaxError` in catch block without logging or throwing. Unbounded regexes provided in user config can cause catastrophic ReDoS backtracking.

4. **`src/constitution/constitutionEngine.ts`**:
   - **Lines 56-60 & 61-71 (`constitutionEngine.ts`)**: Heading check uses `line.startsWith('## ') || line.startsWith('### ')`. Single hash headings like `# Forbidden Patterns` set `title = "Forbidden Patterns"` but do NOT set `currentType = 'forbidden_pattern'`, causing top-level forbidden rules to be misclassified.
   - **Line 192 (`constitutionEngine.ts`)**: Conventional commit regex `/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_-]+\))?:/i` does not support breaking change indicator `!` (e.g., `feat!: breaking change` or `fix(scope)!: fix bug`).
   - **Lines 137-144 (`constitutionEngine.ts`)**: `checkNonRegexForbiddenRule` splits multi-word descriptions into keywords (len > 2) and checks `keywords.every(kw => lowerText.includes(kw))`. If `"console"` appears on line 1 and `"log"` appears on line 100 of a file, it falsely triggers a rule violation for `Do not use console.log`.

5. **`src/persistence/db.ts` & `src/persistence/diffStateManager.ts`**:
   - **Line 137 (`db.ts`)**: `UNIQUE(pr_state_id, fingerprint_hash)` in SQLite schema. Passing state containing duplicate finding hashes to `savePRState` throws `SqliteError: UNIQUE constraint failed`.
   - **Line 332-334 (`db.ts`)**: `JsonFileDiffStateStorage` handles disk corrupt JSON during `init()` by logging a warning and re-initializing `this.data = {}`. Subsequent flush overwrites disk state with empty data without backup.
   - **Line 51-67 & 72-75 (`diffStateManager.ts`)**: `computeHunkHash` does not include `oldStart`, `oldLines`, `newStart`, `newLines`. Moving a code hunk to a different line position produces identical hash, causing `hunksToReview` to skip re-evaluating moved code.
   - **Lines 170-182 (`diffStateManager.ts`)**: `overlapsNew` compares pre-shift finding line range `[fStart, fEnd]` against post-shift hunk range `[newStart, newEnd]`. Line insertions above a finding shift its line numbers and trigger false resolution (`RESOLVED`) of untouched findings downstream.
   - **Lines 170-171 (`diffStateManager.ts`)**: `h.filePath !== prevFinding.filePath` ignores file renames (`src/app.ts` -> `src/application.ts`), leaving findings orphaned on old file paths.

---

## 2. Logic Chain

1. **Config Loader Type Handling**:
   - *Observation*: `typeof [1, 2, 3] === 'object'` in JS.
   - *Logic*: `parseAndValidateConfig("- item1\n- item2")` parses YAML as an array `[1, 2, 3]`. `typeof` check evaluates `true`, `deepMergeConfig` maps array indices to object keys `{0: item1, 1: item2}`, and Zod accepts the object with default values.
   - *Conclusion*: Top-level YAML arrays bypass validation instead of throwing `ConfigValidationError`.

2. **GraphQL Injection Vulnerability**:
   - *Observation*: `queryLinearTicket` constructs GraphQL payload via string concatenation: `query { issue(id: "` + ticketId + `") ... }`.
   - *Logic*: An input like `ticketId = '123") { id } } mutation { deleteEverything }'` breaks out of GraphQL string literals and injects malicious AST nodes into upstream server requests.
   - *Conclusion*: Vulnerable to GraphQL query injection due to missing query parameterization / string escaping.

3. **Diff State Line Shift False Resolution**:
   - *Observation*: `isFindingInModifiedHunk` checks `newStart <= fEnd && newEnd >= fStart`.
   - *Logic*: If a PR inserts 20 lines at line 1, a finding at line 15 (now at line 35) is checked against `newStart=1, newEnd=20`. Since `1 <= 15` and `20 >= 15`, `isFindingInModifiedHunk` returns `true`. Because the finding is no longer at line 15 in `quorumFindings`, the state manager marks it as `RESOLVED`.
   - *Conclusion*: Upstream line insertions falsely resolve untouched downstream findings.

4. **Natural Language Constitution False Positives**:
   - *Observation*: `checkNonRegexForbiddenRule` tests `keywords.every(kw => lowerText.includes(kw))`.
   - *Logic*: For rule `Never use console.log`, `keywords = ['console', 'log']`. Any file containing both `console` and `log` anywhere in the text (even in separate variable names) matches.
   - *Conclusion*: Generates false positive compliance failures on benign code.

---

## 3. Caveats

- **SQLite Native Binding**: Tests in the current container environment execute using `JsonFileDiffStateStorage` failover due to `better-sqlite3` Node version mismatch. SQLite behavior was verified via code path analysis.
- **External Network Access**: In accordance with system instructions, no network calls were made to real Jira, Linear, or GitHub APIs; verification relies on isolated mock unit tests.

---

## 4. Conclusion

The code base exhibits high overall structural quality, but white-box analysis identified 9 critical gaps and latent bugs across the 5 target modules:
1. **Config Loader**: Top-level YAML arrays bypass schema validation (`src/config/configLoader.ts:75`).
2. **Config Schema**: `providers: []` in config schema locks out all PR approvals in strict mode (`src/config/schema.ts:26`).
3. **Ticket Client**: Unsanitized GraphQL query parameter concatenation in `queryLinearTicket` (`src/ticket/ticketProviderClient.ts:35`).
4. **Ticket Client**: Unencoded URI parameters in REST queries (`src/ticket/ticketProviderClient.ts:47, 62`).
5. **Ticket Validator**: False positive ticket extraction on technical tokens like `UTF-8` and `SHA-256` (`src/ticket/ticketValidator.ts:17`).
6. **Constitution Engine**: Top-level `#` headings misclassify forbidden rules (`src/constitution/constitutionEngine.ts:56`).
7. **Constitution Engine**: Conventional commit regex fails on breaking change `!` syntax (`src/constitution/constitutionEngine.ts:192`).
8. **Constitution Engine**: Unrelated keywords across a file trigger false positive forbidden violations (`src/constitution/constitutionEngine.ts:137`).
9. **Diff State Persistence**: Line insertions above untouched findings trigger false resolution (`src/persistence/diffStateManager.ts:179`).

---

## 5. Verification Method & Tier 5 Adversarial Test Specifications

Run the unit test suite to verify module mechanics:
```bash
PATH=/opt/homebrew/bin:/usr/bin:/bin ./node_modules/.bin/vitest run tests/unit/config.test.ts tests/unit/constitution.test.ts tests/unit/diffState.test.ts tests/unit/ticket.test.ts tests/unit/logger.test.ts
```

### Tier 5 Adversarial Test Specifications

#### Test Spec 1: Top-Level Array Config Parsing (`tests/unit/config.test.ts`)
- **Target**: `parseAndValidateConfig` in `src/config/configLoader.ts`
- **Scenario**: Pass `- item1\n- item2` (YAML array string) to `parseAndValidateConfig`.
- **Expected Result**: Should throw `ConfigValidationError` indicating configuration must be a key-value mapping object, not an array.

#### Test Spec 2: Linear GraphQL Injection (`tests/unit/ticket.test.ts`)
- **Target**: `queryLinearTicket` in `src/ticket/ticketProviderClient.ts`
- **Scenario**: Pass `ticketId = 'PROJ-123") { id } issue(id: "EVIL'` into `queryLinearTicket`.
- **Expected Result**: Special characters and quotes in `ticketId` must be sanitized or parameterized, preventing GraphQL query syntax mutation.

#### Test Spec 3: Diff State Line Shift Resolution (`tests/unit/diffState.test.ts`)
- **Target**: `processPRCommitUpdate` in `src/persistence/diffStateManager.ts`
- **Scenario**:
  1. Commit 1: Register finding at line 30 in `src/app.ts`.
  2. Commit 2: Insert 10 lines at lines 1-10 in `src/app.ts` (moving finding to line 40). `quorumFindings` is empty for lines 1-10.
- **Expected Result**: Finding at original line 30 must remain `IDENTIFIED` (with line shifted) and NOT be marked `RESOLVED`.

#### Test Spec 4: Conventional Commit Breaking Change Syntax (`tests/unit/constitution.test.ts`)
- **Target**: `evaluateConstitution` in `src/constitution/constitutionEngine.ts`
- **Scenario**: Evaluate constitution rule requiring conventional commit format against PR title `feat(auth)!: add OAuth2 login`.
- **Expected Result**: Title must be accepted as compliant without triggering a directive violation.

#### Test Spec 5: Non-Regex Forbidden Keyword False Positives (`tests/unit/constitution.test.ts`)
- **Target**: `checkNonRegexForbiddenRule` in `src/constitution/constitutionEngine.ts`
- **Scenario**: Rule `Never use console.log in production files`. Evaluate against file with line 1 `const console = window.console;` and line 100 `logger.info("logging complete");`.
- **Expected Result**: `checkNonRegexForbiddenRule` must return `false` (no violation).
