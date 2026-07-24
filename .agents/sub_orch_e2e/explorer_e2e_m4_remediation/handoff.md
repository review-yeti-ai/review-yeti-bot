# Remediation Specification & Blueprint: Milestone E2E-M4 Integrity Violation

## 1. Observation

Direct examination of the codebase confirms all findings in the Forensic Integrity Audit Report:

1. **`src/app.ts` Webhook Handler Bypasses OmniRoute and Quorum (Hardcoded Result & Facade)**:
   - File: `src/app.ts`, lines 197–202:
     ```typescript
     // Determine review decision
     let decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'APPROVE';
     if (!ticketResult.valid || !constitutionResult.compliant) {
       decision = 'REQUEST_CHANGES';
     }
     ```
   - Neither `OmniRouteClient` nor `evaluateQuorum` are imported or invoked anywhere in `src/app.ts`. When a PR webhook arrives and ticket/constitution checks pass, `app.ts` unconditionally sets `decision = 'APPROVE'` without performing any AI persona reviews or panel consensus evaluations.

2. **Out-of-Band Execution in Tier 3 Tests**:
   - File: `tests/e2e/tier3/crossFeatureInteractions.test.ts`
   - **Test 1** (lines 95–130): Directly instantiates `new OmniRouteClient(...)`, invokes `evaluateQuorum(...)`, and manually executes `fetch(...)` to post inline GitHub comments inside the test body instead of testing `src/app.ts` end-to-end:
     ```typescript
     const omniClient = new OmniRouteClient({ baseUrl: `http://127.0.0.1:${harness.mockOmniRoute.port}` });
     const omniRes = await omniClient.completion({...});
     const quorumRes = evaluateQuorum({...});
     const inlineCommentRes = await fetch(`${githubUrl}/repos/.../comments`, {...});
     ```
   - **Test 3** (lines 221–257): Directly instantiates `new OmniRouteClient(...)` and `evaluateQuorum(...)` out-of-band in the test body.
   - **Test 4** (lines 265–313): Directly instantiates `createDiffStateStorage(...)` and `new DiffStateManager(...)` and calls `diffMgr.processPRCommitUpdate(...)` manually.
   - **Test 5** (lines 352–406): Directly calls internal functions `validateTicketLinkage(...)` and `evaluateConstitution(...)` instead of testing via webhook HTTP endpoint.
   - **Test 7** (lines 441–554): Directly instantiates `createDiffStateStorage(...)` and `DiffStateManager(...)` out-of-band.

3. **Vacuous Assertion in Test 2**:
   - File: `tests/e2e/tier3/crossFeatureInteractions.test.ts` (lines 190–193):
     ```typescript
     const omniRequests = harness.mockOmniRoute.getRecordedRequests();
     const pr202OmniReqs = omniRequests.filter((r) => r.body?.prNumber === 202);
     expect(pr202OmniReqs.length).toBe(0);
     ```
   - Test 2 asserted zero LLM requests when ticket validation failed. However, because `src/app.ts` contained zero OmniRoute calls for *any* PR, this assertion passed vacuously without verifying that ticket linkage actually gated/blocked downstream OmniRoute execution.

---

## 2. Logic Chain

1. **Problem Synthesis**:
   `src/app.ts` is currently a facade for AI review functionality. It validates webhook HMAC signatures, regex-checks ticket keys and constitution rules, and manages diff states, but skips AI persona completions (`OmniRouteClient`) and panel consensus (`evaluateQuorum`). Tests in `crossFeatureInteractions.test.ts` passed by simulating these omitted stages out-of-band in test code.

2. **Required Architecture**:
   To achieve authentic E2E integrity, `src/app.ts` must execute the complete review pipeline natively upon receiving a `pull_request` webhook:
   ```
   [GitHub Webhook: POST /api/webhook/github]
          │
          ▼
   1. HMAC Signature Verification
          │
          ▼
   2. Config & Constitution Loading (.ct-review.yaml, constitution.md)
          │
          ▼
   3. Ticket Linkage Gate (validateTicketLinkage)
          │ ──[Invalid]──► Set decision = 'REQUEST_CHANGES', skip OmniRoute, post review to GitHub
          ▼
   4. Constitution Gate (evaluateConstitution)
          │ ──[Non-compliant]──► Set decision = 'REQUEST_CHANGES', skip OmniRoute, post review to GitHub
          ▼
   5. Diff State Check (DiffStateManager.processPRCommitUpdate)
          │ ──[Unchanged Diff Delta]──► Skip OmniRoute, reuse/approve state
          ▼
   6. Native OmniRoute AI Reviews (OmniRouteClient.completion for each configured persona)
          │
          ▼
   7. Quorum Panel Evaluation (evaluateQuorum with persona findings)
          │
          ▼
   8. GitHub API Publication (POST inline comments & POST review summary)
          │
          ▼
   [HTTP Response: 200 OK with processed status & decision]
   ```

3. **Test Refactoring Principle**:
   `tests/e2e/tier3/crossFeatureInteractions.test.ts` must interact ONLY with application HTTP endpoints (`appUrl/api/webhook/github`). No test case may directly instantiate `OmniRouteClient`, `evaluateQuorum`, `DiffStateManager`, `validateTicketLinkage`, or make manual `fetch` calls to mock GitHub. Test assertions must verify application side-effects exclusively through `harness.mockGithub` (recorded reviews/comments) and `harness.mockOmniRoute` (recorded LLM requests).

---

## 3. Step-by-Step Technical Plan for Worker 2

### Work Package A: Native Implementation in `src/app.ts`

#### Step A.1: Imports & Client Initialization
In `src/app.ts`, add imports for `OmniRouteClient` and `evaluateQuorum`:
```typescript
import { OmniRouteClient } from './gateway/omniRouteClient';
import { evaluateQuorum, PersonaFinding } from './quorum/quorumEngine';
```

Add a helper/singleton accessor for `OmniRouteClient`:
```typescript
let omniRouteClient: OmniRouteClient | null = null;

function getOmniRouteClient(): OmniRouteClient {
  if (!omniRouteClient) {
    const omniUrl = process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:9090';
    omniRouteClient = new OmniRouteClient({
      baseUrl: omniUrl,
      fallbackProviders: ['anthropic', 'google'],
    });
  }
  return omniRouteClient;
}
```

#### Step A.2: Pipeline Execution Logic in Webhook Handler
In `src/app.ts`, update the `pull_request` event handling block (lines 101–229):

1. **Ticket & Constitution Gates**:
   If `!ticketResult.valid || !constitutionResult.compliant`, set `decision = 'REQUEST_CHANGES'` and **skip** OmniRoute calls. Post the review summary to GitHub mock server (`${githubApiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`) and return response.

2. **Diff Delta & Quorum Evaluation**:
   If ticket and constitution pass:
   - Check if `updateResult.hunksToReview` contains hunks (or if first pass):
     - If hunks exist:
       - Retrieve configured personas from `config.quorum.personas` (e.g. `['security', 'architecture', 'performance', 'quality']`).
       - Retrieve effort level from `config.quorum.effortLevel` (e.g. `'medium'`).
       - For each persona, invoke `getOmniRouteClient().completion({ provider: 'openai', persona, effortLevel: config.quorum.effortLevel, prompt: `Review diff for ${owner}/${repoName} PR #${prNumber}` })`.
       - Parse the returned `content` JSON from OmniRoute response to extract `findings: PersonaFinding[]`. Map findings into a `personaFindings` map (`Record<string, PersonaFinding[]>`).
       - Invoke `evaluateQuorum({ minApprovals: config.quorum.minApprovals, configuredPersonas: config.quorum.personas, personaFindings })`.
       - Update `decision = quorumResult.decision`.
     - Else (unchanged diff delta):
       - Keep `decision = 'APPROVE'` (or previous state decision) and skip issuing new OmniRoute calls.

3. **GitHub API Comments & Review Posting**:
   - If `githubApiBase` is set:
     - For each finding in `quorumResult.activeFindings`:
       Post inline comment request to `${githubApiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/comments` with `{ body: `[${finding.persona}:${finding.severity}] ${finding.comment}`, commit_id: headSha, path: finding.filePath || changedFiles[0]?.path || 'src/index.ts', line: finding.lineNumber || 1, side: 'RIGHT' }`.
     - Post summary review to `${githubApiBase}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews` with `{ body: `Automated Quorum Review Complete. Decision: ${decision}`, event: decision, commit_id: headSha }`.

---

### Work Package B: Refactoring `tests/e2e/tier3/crossFeatureInteractions.test.ts`

Refactor all 7 tests in `crossFeatureInteractions.test.ts` so that **all test interactions occur purely via HTTP POST requests to `appUrl/api/webhook/github`**.

#### Test 1: Full E2E Pipeline
- **Action**: Deliver `pull_request` ('opened') webhook payload with valid ticket `[PROJ-123]` to `${appUrl}/api/webhook/github`.
- **Assertions**:
  1. Webhook response: `statusCode === 200`, `body.status === 'processed'`, `body.decision === 'APPROVE'`, `body.ticketValid === true`, `body.constitutionCompliant === true`.
  2. `harness.mockOmniRoute.getRecordedRequests()`: Verify that `app.ts` natively issued OmniRoute completion requests for configured personas ('security', 'architecture', etc.).
  3. `harness.mockGithub.getRecordedReviews(101)`: Verify recorded review event is `'APPROVE'`.
  4. `harness.mockGithub.getRecordedInlineComments(101)`: Verify inline comment(s) were published to GitHub mock server by `app.ts`.

#### Test 2: Ticket Validation Gate
- **Action**: Deliver `pull_request` ('opened') webhook payload with missing ticket key to `${appUrl}/api/webhook/github`.
- **Assertions**:
  1. Webhook response: `statusCode === 200`, `body.ticketValid === false`, `body.decision === 'REQUEST_CHANGES'`.
  2. `harness.mockGithub.getRecordedReviews(202)`: Recorded review event is `'REQUEST_CHANGES'`.
  3. `harness.mockOmniRoute.getRecordedRequests()`: Filter recorded requests for PR 202 (or prompt containing 202). Assert length is `0` (authentically gated because `app.ts` skipped OmniRoute when ticket validation failed).

#### Test 3: Custom Config + OmniRoute Failover
- **Action**: Configure `harness.mockOmniRoute` with `failProvider: { provider: 'openai', status: 503, failCount: 2 }`. Deliver `pull_request` webhook to `${appUrl}/api/webhook/github`.
- **Assertions**:
  1. Webhook response: `statusCode === 200`, `body.decision === 'APPROVE'`.
  2. `harness.mockOmniRoute.getRecordedRequests()`: Verify primary provider attempt (which returned 503) followed by successful fallback provider attempt (e.g. 'anthropic') triggered natively by `OmniRouteClient` inside `app.ts`.
  3. `harness.mockGithub.getRecordedReviews(...)`: Review event is `'APPROVE'`.

#### Test 4: Incremental Diff Delta Skip
- **Action**:
  1. Deliver 1st `pull_request` ('synchronize') webhook with `headSha: 'commit-sha-unchanged-111'` to `${appUrl}/api/webhook/github`. Record count of OmniRoute requests.
  2. Deliver 2nd `pull_request` ('synchronize') webhook with identical `headSha` and diff hunks to `${appUrl}/api/webhook/github`.
- **Assertions**:
  1. OmniRoute request count after 2nd webhook equals request count after 1st webhook (0 additional OmniRoute requests issued, proving `app.ts` detected unchanged diff).
  2. 2nd webhook response `statusCode === 200`, `body.status === 'processed'`.

#### Test 5: Constitution Engine + Ticket Enforcement
- **Action**:
  - Scenario A: Deliver webhook with valid ticket `[PROJ-123]` but violating Constitution rule (AWS key `AKIAIOSFODNN7EXAMPLE`) to `${appUrl}/api/webhook/github`.
  - Scenario B: Deliver webhook with valid ticket `[PROJ-123]` and compliant constitution code to `${appUrl}/api/webhook/github`.
- **Assertions**:
  - Scenario A: Response `body.ticketValid === true`, `body.constitutionCompliant === false`, `body.decision === 'REQUEST_CHANGES'`. Review in `mockGithub` is `'REQUEST_CHANGES'`.
  - Scenario B: Response `body.ticketValid === true`, `body.constitutionCompliant === true`, `body.decision === 'APPROVE'`. Review in `mockGithub` is `'APPROVE'`.

#### Test 6: Gateway HMAC Reject Before Processing
- **Action**: Deliver webhooks with corrupted HMAC signature and missing HMAC signature header to `${appUrl}/api/webhook/github`.
- **Assertions**:
  1. Responses return `statusCode === 401`.
  2. `harness.mockTicket.getRecordedRequests()`, `harness.mockOmniRoute.getRecordedRequests()`, and `harness.mockGithub.getRecordedReviews()` remain empty for the rejected PR number.

#### Test 7: Multithreaded / Multi-commit PR Updates
- **Action**:
  1. Deliver Webhook 1 (PR 701, commit v1 with `eval(req.query.cmd);`) to `${appUrl}/api/webhook/github`.
  2. Deliver Webhook 2 (PR 702, commit v1 clean code) to `${appUrl}/api/webhook/github`.
  3. Deliver Webhook 3 (PR 701, commit v2 replacing `eval`) to `${appUrl}/api/webhook/github`.
- **Assertions**:
  1. PR 701 v1 review recorded as `'REQUEST_CHANGES'`.
  2. PR 702 v1 review recorded as `'APPROVE'`.
  3. PR 701 v2 review recorded as `'APPROVE'` (resolving previous security finding natively).

---

## 4. Caveats

- **Read-Only Scope**: This document specifies the analysis and blueprint. No files in `src/` or `tests/` were altered during this phase.
- **Environment Injections**: `AppProcessLauncher` passes `OMNIROUTE_BASE_URL` and `GITHUB_API_BASE_URL` to the child process (verified in `e2eTestRunner.ts` lines 47–50).
- **Alternative Interpretations**: None. The forensic audit evidence was 100% verified against codebase source files.

---

## 5. Conclusion

The integrity violations in Milestone E2E-M4 stem from `src/app.ts` hardcoding approval decisions while skipping OmniRoute and Quorum processing, combined with test cases simulating these components out-of-band. 

Implementing Work Package A in `src/app.ts` and Work Package B in `tests/e2e/tier3/crossFeatureInteractions.test.ts` will completely remediate all 4 forensic audit failures and ensure authentic end-to-end execution.

---

## 6. Verification Method

1. **Execute E2E Tier 3 Tests**:
   ```bash
   npx vitest run tests/e2e/tier3/crossFeatureInteractions.test.ts
   ```
2. **Execute Full Test Suite**:
   ```bash
   npm test
   ```
3. **Integrity Validation Check**:
   Grep `tests/e2e/tier3/crossFeatureInteractions.test.ts` to verify zero occurrences of:
   - `new OmniRouteClient`
   - `evaluateQuorum`
   - `new DiffStateManager`
   - `validateTicketLinkage`
   - Direct `fetch` calls to mock server ports inside test bodies.
