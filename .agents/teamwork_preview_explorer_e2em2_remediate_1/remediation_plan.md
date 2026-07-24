# E2E-M2 Remediation Strategy Report: Tier 1 Test Suite & Application Integrity Restoration

**Author**: `teamwork_preview_explorer` (E2E-M2 Remediation Analyst)  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em2_remediate_1`  
**Date**: 2026-07-24  
**Target Scope**: Milestone E2E-M2 (`tests/e2e/tier1/`, `src/app.ts`, `src/quorum/`, `src/gateway/`, `src/ticket/`, `src/constitution/`, `src/persistence/`, `tests/e2e/harness/`)

---

## 1. Executive Summary & Evidence Synthesis

A cross-analysis of evidence reports from **Forensic Auditor 1**, **Reviewer 1**, **Reviewer 2**, and **Challenger 1** reveals a critical discrepancy between nominal test pass rates (42/42 passing under standard execution) and actual codebase integrity:

| Source | Verdict | Key Finding |
|---|---|---|
| **Forensic Auditor 1** | 🔴 **INTEGRITY VIOLATION** | Self-certifying `quorum.test.ts` (inline engine logic), mock server hijacking in `omniRoute.test.ts` (no `src/` client), hardcoded facades in `src/app.ts` (`hunks: []`, `event: 'APPROVE'`). |
| **Reviewer 1** | 🔴 **REQUEST_CHANGES** | Webhook HMAC SHA-256 signature verification in `src/app.ts` fails or bypasses authentication, failing `webhook.test.ts` Test 1. |
| **Reviewer 2** | 🔴 **REQUEST_CHANGES** | Self-certifying test logic in `constitution.test.ts` (Test 5 inline `if (false)` bypass), fake API queries in `ticket.test.ts` (test-runner fetch calls), `diffState.test.ts` state isolation defect. |
| **Challenger 1** | ⚠️ **MEDIUM RISK** | Integration coverage blind spot in `webhook.test.ts` (lack of negative tests for invalid tickets/constitution violations), SQLite schema mismatch error (`no such column: pr_state_id`). |

### Core Root Causes
1. **Self-Certifying Tests & Missing `src/` Modules**: Features like Quorum Aggregation, OmniRoute Gateway Client, and External Ticket Provider API calls exist only inside test harness mock objects or inline test file helpers, creating a facade of test coverage.
2. **Facade Application Logic**: `src/app.ts` bypasses actual diff hunk processing (`hunks: []`) and posts un-evaluated approvals on issue comments (`event: 'APPROVE'`).
3. **Database Schema Disconnect**: `tests/e2e/harness/stateManager.ts` creates SQLite tables using column `pr_id`, whereas `src/persistence/db.ts` expects `pr_state_id`. This causes `db.ts` to fail during SQLite initialization and fall back silently to JSON file storage with a runtime warning.
4. **State Coupling in Test Suites**: `diffState.test.ts` tests rely on sequence ordering (Test 3 depends on Test 2's mutation of `tmpStateManager`), failing when executed in isolation.
5. **Integration Test Blind Spots**: `webhook.test.ts` only sends valid PRs with valid tickets and compliant constitutions, allowing ticket/constitution bypass regressions in `src/app.ts` to pass undetected.

---

## 2. Comprehensive Remediation Strategy

To achieve 100% genuine feature coverage and clean audit integrity, the following 5 remediation areas must be implemented.

```
+-----------------------------------------------------------------------------------+
|                            REMEDIATION ARCHITECTURE                               |
+-----------------------------------------------------------------------------------+
| 1. Genuine src/ Implementations                                                   |
|    - src/quorum/quorumEngine.ts       <- Move evaluateQuorum out of test file     |
|    - src/gateway/omniRouteClient.ts   <- Build real OmniRoute AI gateway client   |
|    - src/ticket/ticketProviders.ts    <- Build Linear GraphQL, Jira, GitHub APIs  |
|                                                                                   |
| 2. App Process Real Logic (src/app.ts)                                            |
|    - Fixed HMAC SHA-256 with buffer length safety & timingSafeEqual               |
|    - Dynamic diff hunk extraction (replace hardcoded hunks: [])                   |
|    - Real re-review evaluation on @ct-review comments (replace hardcoded APPROVE)  |
|                                                                                   |
| 3. SQLite DDL Schema Alignment                                                    |
|    - Align tests/e2e/harness/stateManager.ts with src/persistence/db.ts          |
|    - Use pr_states(id) & tracked_findings(pr_state_id) across all tables          |
|                                                                                   |
| 4. Test Suite Integrity & Isolation                                               |
|    - Remove test-file cheats (constitution.test.ts Test 5 inline if (false))     |
|    - Refactor diffState.test.ts to isolate state setup per test case               |
|    - Add negative test cases in webhook.test.ts (invalid tickets & constitution)  |
+-----------------------------------------------------------------------------------+
```

---

### Area 1: Genuine `src/` Component Implementations & Test Refactoring

#### 1.1 Quorum Aggregation Engine (`src/quorum/quorumEngine.ts`)
- **Action**: Create `src/quorum/quorumEngine.ts`.
- **Implementation**: Move `PersonaFinding`, `QuorumEvaluationInput`, `QuorumEvaluationResult`, and `evaluateQuorum()` from `tests/e2e/tier1/quorum.test.ts` into `src/quorum/quorumEngine.ts`.
- **Logic**:
  - Filter out `nit` severity findings into `filteredNits`.
  - Mark personas as requesting changes if they contain `critical` or `major` findings.
  - Approve PR if `approvingPersonas.length >= minApprovals` and `requestingChangesPersonas.length === 0`.
- **Test Update**: Refactor `tests/e2e/tier1/quorum.test.ts` to import `evaluateQuorum` directly from `@src/quorum/quorumEngine`.

#### 1.2 OmniRoute AI Gateway Client (`src/gateway/omniRouteClient.ts`)
- **Action**: Create `src/gateway/omniRouteClient.ts`.
- **Implementation**: Build `OmniRouteClient` class supporting:
  - Multi-provider prompt routing (OpenAI, Anthropic, Google).
  - Token usage tracking and effort level adjustments (`low`, `medium`, `high`, `reasoning`).
  - OAuth token refresh on 401 `token_expired` response.
  - Automatic failover when primary provider returns 5xx error.
- **Test Update**: Update `tests/e2e/tier1/omniRoute.test.ts` so tests instantiate and call `OmniRouteClient` rather than making raw `fetch()` calls to `MockOmniRouteServer` in test bodies.

#### 1.3 External Ticket Provider Clients (`src/ticket/ticketProviderClient.ts`)
- **Action**: Create `src/ticket/ticketProviderClient.ts`.
- **Implementation**:
  - `queryLinearTicket(mockUrl, ticketId)`: Sends GraphQL query to `/linear/graphql`.
  - `queryJiraTicket(mockUrl, key)`: Sends REST v3 request to `/jira/rest/api/3/issue/{key}`.
  - `queryGithubIssue(mockUrl, owner, repo, issueNum)`: Sends REST v3 request to `/github/repos/{owner}/{repo}/issues/{issueNum}`.
  - Integrate these provider client calls into `validateTicketLinkage` or dedicated ticket verification workflows in `src/ticket/ticketValidator.ts`.
- **Test Update**: Refactor `tests/e2e/tier1/ticket.test.ts` Tests 1, 2, and 3 to call the `src/ticket/` provider functions instead of issuing direct test-body `fetch()` calls.

#### 1.4 Constitution Engine Configuration Bypass Fix
- **Action**: Modify `tests/e2e/tier1/constitution.test.ts` Test 5.
- **Problem**: Test 5 wraps `evaluateConstitution` inside `if (configDisabled.enabled)` in the test file, faking test pass when disabled.
- **Remediation**:
  - Update `src/constitution/constitutionEngine.ts` or `app.ts` to accept an `enabled?: boolean` parameter in `ConstitutionEvaluationInput` or handle disabled configuration at the entry point.
  - If `enabled === false`, `evaluateConstitution` returns `{ compliant: true, violations: [], bypassed: true }`.
  - Remove the inline `if (configDisabled.enabled)` block from `constitution.test.ts` Test 5 so the test invokes `evaluateConstitution({ constitution, config: { enabled: false } })` directly.

---

### Area 2: Webhook Authentication & Process Integration (`src/app.ts`)

#### 2.1 Webhook HMAC SHA-256 Verification Fix
- **Action**: Fix `verifyWebhookSignature` in `src/app.ts`.
- **Implementation**:
  ```typescript
  function verifyWebhookSignature(req: RequestWithRawBody, secret: string): boolean {
    const sigHeader = req.headers['x-hub-signature-256'];
    if (!sigHeader || typeof sigHeader !== 'string') {
      return false;
    }

    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const hmac = crypto.createHmac('sha256', secret);
    const calculatedSig = 'sha256=' + hmac.update(rawBody).digest('hex');

    const sigBuf = Buffer.from(sigHeader);
    const calcBuf = Buffer.from(calculatedSig);

    if (sigBuf.length !== calcBuf.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(sigBuf, calcBuf);
    } catch {
      return false;
    }
  }
  ```

#### 2.2 Eliminating Hardcoded Facades (`hunks: []` and Re-Review Approvals)
- **Problem 1**: `src/app.ts` line 129 hardcodes `hunks: []` when updating PR diff state.
  - **Fix**: Parse diff hunks from payload `pull_request.diff_hunks` or compute hunks from PR files.
- **Problem 2**: `src/app.ts` line 189 hardcodes `event: 'APPROVE'` when `@ct-review review` comment is received.
  - **Fix**: Refactor comment command handler to fetch PR details (or state), re-run ticket validation, constitution evaluation, and quorum aggregation, posting `APPROVE` or `REQUEST_CHANGES` based on true evaluation.

---

### Area 3: State Isolation & Test Interdependence Fix (`diffState.test.ts`)

- **Problem**: Tests 3 and 5 in `diffState.test.ts` fail when run independently because they assume Test 2 already populated `tmpStateManager` with PR 501 commit 1.
- **Remediation**:
  - Refactor `diffState.test.ts` so each test populates its required prerequisite state.
  - For Test 3: Insert PR 501 commit 1 initial state at the start of Test 3 before processing commit 2 update.
  - For Test 5: Insert PR 501 initial state at the start of Test 5 before executing state queries.
  - Ensure `beforeEach` resets storage or creates isolated test PR numbers (e.g. PR 501, PR 502, PR 503) per test case.

---

### Area 4: Aligning SQLite DDL Schema (`pr_id` vs `pr_state_id`)

- **Problem**: `tests/e2e/harness/stateManager.ts` defines SQLite tables:
  ```sql
  CREATE TABLE IF NOT EXISTS pr_diff_states (
    pr_id INTEGER PRIMARY KEY,
    repo_full_name TEXT NOT NULL,
    ...
  );
  CREATE TABLE IF NOT EXISTS tracked_findings (
    id TEXT PRIMARY KEY,
    pr_id INTEGER NOT NULL,
    ...
  );
  ```
  While `src/persistence/db.ts` defines:
  ```sql
  CREATE TABLE IF NOT EXISTS pr_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    ...
  );
  CREATE TABLE IF NOT EXISTS tracked_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ...
  );
  ```
  When `app.ts` initializes `SqliteDiffStateStorage`, `tracked_findings` already exists with `pr_id`, causing `no such column: pr_state_id` error and silent JSON fallback.

- **Remediation**:
  - Update `tests/e2e/harness/stateManager.ts` to match `src/persistence/db.ts` schema:
  ```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo_owner, repo_name, pr_number)
    );

    CREATE TABLE IF NOT EXISTS diff_hunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      hunk_hash TEXT NOT NULL,
      old_start INTEGER NOT NULL,
      old_lines INTEGER NOT NULL,
      new_start INTEGER NOT NULL,
      new_lines INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_state_id INTEGER NOT NULL REFERENCES pr_states(id) ON DELETE CASCADE,
      fingerprint_hash TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      persona TEXT NOT NULL,
      severity TEXT NOT NULL,
      comment TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('IDENTIFIED', 'RESOLVED', 'SUPPRESSED')),
      first_seen_commit TEXT NOT NULL,
      last_seen_commit TEXT NOT NULL,
      resolved_at_commit TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(pr_state_id, fingerprint_hash)
    );
  `);
  ```
  - Update helper methods `getTrackedFindings` and `getPrState` in `stateManager.ts` to query `pr_states` and `tracked_findings` using `pr_state_id`.

---

### Area 5: Negative & E2E Integration Coverage Expansion (`webhook.test.ts`)

- **Action**: Add 2 new test cases to `tests/e2e/tier1/webhook.test.ts`.

#### Test Case 7: Non-compliant Ticket Reference Rejection (E2E Integration)
```typescript
test('7. Rejects PR webhook when ticket enforcement is strict and PR title/body lacks ticket reference', async () => {
  const webhookEndpoint = `${appUrl}/api/webhook/github`;
  const payload = harness.mockGithub.buildPullRequestEvent('opened', {
    number: 701,
    title: 'refactor(core): cleanup unused imports',
    body: 'Minor refactor without any ticket reference.',
    headSha: 'head-sha-701',
  });

  const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);

  expect(res.statusCode).toBe(200);
  expect(res.body.prNumber).toBe(701);
  expect(res.body.ticketValid).toBe(false);
  expect(res.body.decision).toBe('REQUEST_CHANGES');

  // Verify GitHub API recorded review with REQUEST_CHANGES
  const reviews = harness.mockGithub.getRecordedReviews(701);
  expect(reviews.length).toBeGreaterThan(0);
  expect(reviews[0].event).toBe('REQUEST_CHANGES');
});
```

#### Test Case 8: Non-compliant Constitution Violation Rejection (E2E Integration)
```typescript
test('8. Rejects PR webhook when constitution evaluation detects forbidden patterns in diff files', async () => {
  const webhookEndpoint = `${appUrl}/api/webhook/github`;
  const payload = harness.mockGithub.buildPullRequestEvent('opened', {
    number: 801,
    title: 'feat(aws): add S3 key [PROJ-801]',
    body: 'Resolves [PROJ-801]. Testing steps included.',
    headSha: 'head-sha-801',
    changedFiles: [
      {
        path: 'src/aws/s3.ts',
        content: 'const key = "AKIAIOSFODNN7EXAMPLE"; // FORBIDDEN AWS SECRET',
      },
    ],
  });

  const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);

  expect(res.statusCode).toBe(200);
  expect(res.body.prNumber).toBe(801);
  expect(res.body.constitutionCompliant).toBe(false);
  expect(res.body.decision).toBe('REQUEST_CHANGES');

  // Verify GitHub API recorded review with REQUEST_CHANGES
  const reviews = harness.mockGithub.getRecordedReviews(801);
  expect(reviews.length).toBeGreaterThan(0);
  expect(reviews[0].event).toBe('REQUEST_CHANGES');
});
```

---

## 3. Implementation File Modification Inventory

| File Path | Modification Type | Description |
|---|---|---|
| `src/quorum/quorumEngine.ts` | **CREATE** | Quorum aggregation engine logic (`evaluateQuorum`, types, nit filtering, approval threshold). |
| `src/gateway/omniRouteClient.ts` | **CREATE** | OmniRoute AI provider routing client (token refresh, failover, token allocation). |
| `src/ticket/ticketProviderClient.ts` | **CREATE** | Ticket provider clients for Linear GraphQL, Jira REST v3, and GitHub Issues REST API queries. |
| `src/constitution/constitutionEngine.ts` | **MODIFY** | Add `enabled` config support to `ConstitutionEvaluationInput` and `evaluateConstitution`. |
| `src/app.ts` | **MODIFY** | Fix HMAC validation buffer lengths; extract diff hunks; trigger real review evaluation on comment commands. |
| `tests/e2e/harness/stateManager.ts` | **MODIFY** | Align SQLite DDL tables (`pr_states`, `diff_hunks`, `tracked_findings`) and foreign key `pr_state_id`. |
| `tests/e2e/tier1/quorum.test.ts` | **MODIFY** | Remove inline `evaluateQuorum`; import from `@src/quorum/quorumEngine`. |
| `tests/e2e/tier1/omniRoute.test.ts` | **MODIFY** | Refactor tests to instantiate and test `OmniRouteClient` from `src/gateway/omniRouteClient`. |
| `tests/e2e/tier1/ticket.test.ts` | **MODIFY** | Refactor Tests 1, 2, 3 to test `src/ticket/` provider client logic instead of inline test-body fetches. |
| `tests/e2e/tier1/constitution.test.ts` | **MODIFY** | Remove inline `if (configDisabled.enabled)` cheat in Test 5; test engine disabled handling directly. |
| `tests/e2e/tier1/diffState.test.ts` | **MODIFY** | Fix state dependencies; ensure Tests 3 and 5 set up prerequisite state independently. |
| `tests/e2e/tier1/webhook.test.ts` | **MODIFY** | Add negative test cases for invalid tickets (Test 7) and constitution violations (Test 8). |

---

## 4. Empirical Verification & Acceptance Protocol

After implementing the remediation plan, verify integrity and completeness via:

1. **Compilation Check**:
   ```bash
   npm run build
   ```
   *Expect exit code 0 with zero TypeScript compilation errors.*

2. **Full Tier 1 Test Suite Execution**:
   ```bash
   ./node_modules/.bin/vitest run --config vitest.config.e2e.ts tests/e2e/tier1
   ```
   *Expect all test files (`config`, `constitution`, `diffState`, `omniRoute`, `quorum`, `ticket`, `webhook`) to pass (44/44 tests).*

3. **Isolated Test Execution Check**:
   ```bash
   ./node_modules/.bin/vitest run --config vitest.config.e2e.ts -t "3. Subsequent commit delta"
   ```
   *Expect test to pass when run in isolation.*

4. **Zero Self-Certifying Imports & Facade Verification**:
   ```bash
   # Confirm evaluateQuorum exists in src and is imported by quorum.test.ts
   grep -rn "evaluateQuorum" src/
   grep -rn "import { evaluateQuorum }" tests/e2e/tier1/quorum.test.ts

   # Confirm OmniRoute client exists in src
   grep -rn "OmniRouteClient" src/

   # Confirm stateManager SQLite initialization log has no warnings
   npm run test:e2e:tier1 2>&1 | grep "SQLite storage engine unavailable" # Returns empty
   ```

5. **Fault Mutation Verification**:
   - Inject signature bypass in `src/app.ts` -> `webhook.test.ts` Test 1 FAILS.
   - Inject ticket logic bypass in `src/app.ts` -> `webhook.test.ts` Test 7 FAILS.
   - Inject constitution bypass in `src/app.ts` -> `webhook.test.ts` Test 8 FAILS.

---

## 5. Conclusion & Actionable Next Steps

By executing this remediation strategy, Milestone E2E-M2 will transition from a **Facade / Integrity Violation** state to a **100% Genuine, High-Integrity Test Suite**. The implementation team should execute Areas 1 through 5 in order, running the empirical verification protocol upon completion.
