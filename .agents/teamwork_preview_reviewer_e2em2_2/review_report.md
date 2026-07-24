# Tier 1 Feature Coverage Tests (Milestone E2E-M2) Review Report

## Executive Summary
- **Verdict**: **REQUEST_CHANGES**
- **Overall Risk Assessment**: **CRITICAL**
- **Test Execution Status**: 42 passed / 0 failed (when executed outside process sandbox with `BypassSandbox`). However, deep code analysis reveals severe **INTEGRITY VIOLATIONS**, including self-certifying tests, facade implementations embedded within test files, and direct test-runner API calls simulating non-existent application logic.

---

## Detailed Findings

### [Critical] Finding 1: INTEGRITY VIOLATION — Facade Implementation & Self-Certifying Tests in `quorum.test.ts`
- **What**: `tests/e2e/tier1/quorum.test.ts` defines its own inline implementation of `evaluateQuorum` (lines 30–69) directly inside the test file, rather than importing or testing any application source code from `src/`.
- **Where**: `tests/e2e/tier1/quorum.test.ts:30-69` and `tests/e2e/tier1/quorum.test.ts:140-300` (Tests 2, 3, 4, 5, 6).
- **Why**: There is no Quorum evaluation engine in `src/`. The test file creates a local dummy function `evaluateQuorum` in the test file itself and asserts against its own local implementation. This is self-certifying work and a facade implementation that masks the complete absence of a quorum aggregation feature in the codebase.
- **Suggestion**: Implement the actual Quorum evaluation engine in `src/quorum/quorumEngine.ts` and refactor `quorum.test.ts` to test the real application logic.

### [Critical] Finding 2: INTEGRITY VIOLATION — Self-Certifying Tautological Test Logic in `constitution.test.ts`
- **What**: Test 5 in `tests/e2e/tier1/constitution.test.ts` ("Disabled constitution flag bypasses rule evaluation and returns compliant status") embeds an `if (configDisabled.enabled)` block inside the test function itself.
- **Where**: `tests/e2e/tier1/constitution.test.ts:148-161`.
- **Why**: The test initializes `let result = { compliant: true, violations: [] };` and wraps the call to `evaluateConstitution` inside `if (configDisabled.enabled)` (where `configDisabled.enabled` is `false`). Consequently, `evaluateConstitution` is never invoked, and the test asserts `expect(result.compliant).toBe(true)` against the dummy initial variable. The test does not verify that the application config handler bypasses evaluation; instead, the test code manually fakes the bypass.
- **Suggestion**: Remove the inline `if` statement from the test body. Pass the disabled configuration to the application endpoint or constitution wrapper to verify that the application logic handles `enabled: false`.

### [Critical] Finding 3: INTEGRITY VIOLATION — Direct Test-Runner Fetch Facade Bypassing Application Logic in `ticket.test.ts`
- **What**: Tests 1, 2, and 3 in `tests/e2e/tier1/ticket.test.ts` claim to verify "Linear ticket linkage pattern extraction and GraphQL API query", "Jira ... REST v3 API query", and "GitHub Issue ... REST API query".
- **Where**: `tests/e2e/tier1/ticket.test.ts:41-55, 72-79, 96-102`.
- **Why**: `validateTicketLinkage` in `src/ticket/ticketValidator.ts` is purely a local regex string parser and has no capability or logic to issue API queries to Linear, Jira, or GitHub. To fabricate a passing test result for API integration, the test runner directly executes `fetch(\`\${mockTicketUrl}/...\`)` within the test body. Neither `ticketValidator.ts` nor `app.ts` communicates with `MockTicketServer`. This creates a false appearance of E2E ticket API verification.
- **Suggestion**: If ticket verification requires external API lookups, implement ticket provider client modules in `src/ticket/` and invoke them via application flows; otherwise, update test titles and assertions to reflect pure regex parsing without faking API calls in the test body.

### [Major] Finding 4: State Isolation & Test Interdependence Defect in `diffState.test.ts`
- **What**: Tests in `tests/e2e/tier1/diffState.test.ts` are tightly coupled and sequence-dependent.
- **Where**: `tests/e2e/tier1/diffState.test.ts:111-144` (Test 3) and `tests/e2e/tier1/diffState.test.ts:238-247` (Test 5).
- **Why**: Test 3 relies on PR 501 commit 1 having been processed by Test 2. Test 5 reads PR 501 state assuming Test 3 has already updated PR 501 to commit 2. If Test 3 or Test 5 is executed in isolation (e.g. `vitest -t "3. Subsequent commit delta"`), the test fails due to missing prior state.
- **Suggestion**: Refactor tests to set up required state independently in `beforeEach` or within each individual test case using clean fixture state.

### [Minor] Finding 5: Express Mock Servers Lack Host Parameter, Causing Sandbox `EPERM`
- **What**: Mock servers (`MockGithubServer`, `MockTicketServer`, `MockOmniRouteServer`) call `this.app.listen(this.port)` without specifying `'127.0.0.1'`.
- **Where**: `tests/e2e/harness/mockGithubServer.ts:410`, `tests/e2e/harness/mockTicketServer.ts:218`, `tests/e2e/harness/mockOmniRouteServer.ts:275`.
- **Why**: In Express, omitting host defaults to binding `0.0.0.0`, which causes Node.js `listen EPERM` errors when executed inside standard restricted sandbox environments unless run with `BypassSandbox`.
- **Suggestion**: Update mock server start methods to `this.app.listen(this.port, '127.0.0.1', ...)`.

---

## Verified Claims Matrix

| Claim | Verified Via | Result | Notes |
|---|---|---|---|
| Vitest Tier 1 Test Suite execution | `./node_modules/.bin/vitest run --config vitest.config.e2e.ts tests/e2e/tier1` | PASS (42/42) | Passes only with `BypassSandbox: true` & clean PATH |
| Quorum evaluation test coverage | Code inspection `tests/e2e/tier1/quorum.test.ts` vs `src/` | FAIL | INTEGRITY VIOLATION: `evaluateQuorum` is implemented inside test file |
| Constitution disabled flag test coverage | Code inspection `tests/e2e/tier1/constitution.test.ts:149` | FAIL | INTEGRITY VIOLATION: Test body uses `if (false)` to fake pass |
| Ticket provider API query integration | Code inspection `tests/e2e/tier1/ticket.test.ts` vs `src/ticket/ticketValidator.ts` | FAIL | INTEGRITY VIOLATION: Test runner fetches mock server directly |
| Diff state test isolation | Single-test execution `vitest -t "3. Subsequent commit delta"` | FAIL | Fails when run in isolation due to sequence dependency |

---

## Adversarial Stress Test & Attack Surface Analysis

### 1. Quorum Module Bypass Attack
- **Scenario**: A user configures `quorum.minApprovals: 3` and multiple personas in `.ct-review.yaml`.
- **Finding**: `src/app.ts` does not call any quorum evaluation logic. The bot approves PRs as long as tickets and constitution checks pass.
- **Risk**: CRITICAL — Quorum voting logic is completely missing from application production flows despite 100% passing tests in `quorum.test.ts`.

### 2. External Ticket API Verification Failure
- **Scenario**: A user configures `ticketEnforcement.providers: ['linear']` expecting real-time issue status check (e.g. verifying ticket is Open/In Progress).
- **Finding**: `src/ticket/ticketValidator.ts` only checks if the string pattern matches regex `[A-Z]{2,10}-\d+`. An invalid or closed ticket string (or fake ID like `PROJ-000`) will pass validation.
- **Risk**: HIGH — Production app does not execute API validation despite test titles claiming GraphQL/REST API queries.

### 3. Tautological Constitution Bypass
- **Scenario**: `constitution.enabled` is set to `false`.
- **Finding**: Test 5 in `constitution.test.ts` passes unconditionally due to inline `if (false)` in test file, without actually testing if `parseAndValidateConfig` or `createApp()` correctly handles `enabled: false`.
- **Risk**: MEDIUM — Unverified configuration path.
