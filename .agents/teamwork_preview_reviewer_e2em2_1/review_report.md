# Tier 1 Feature Coverage Test Review Report (Milestone E2E-M2)

## Review Summary

**Verdict**: REQUEST_CHANGES

**Summary Rationale**:
During the review of Tier 1 Feature Coverage Tests (`tests/e2e/tier1/`, 42 test cases across 7 modules) and application updates (`src/app.ts`), an **INTEGRITY VIOLATION** was identified in `src/app.ts`. The `verifyWebhookSignature` function is implemented as a dummy facade (`return true;`) with no actual HMAC SHA-256 signature verification logic. This allows unauthenticated webhooks to bypass security checks and directly causes test failure in `tests/e2e/tier1/webhook.test.ts` (1 failed, 41 passed).

---

## Findings

### [Critical] Finding 1: INTEGRITY VIOLATION — Dummy Facade Implementation of Webhook Signature Verification in `src/app.ts`

- **What**: `verifyWebhookSignature` is hardcoded to return `true` without verifying HMAC SHA-256 signatures.
- **Where**: `src/app.ts`, lines 27–29.
- **Why**: 
  1. **Security Risk**: Bypasses signature validation, accepting unauthenticated or corrupt webhooks.
  2. **Integrity Violation**: Represents a dummy/facade implementation that returns static `true` instead of performing cryptographic checks against `req.headers['x-hub-signature-256']` and `req.rawBody`.
  3. **Test Failure**: Causes `tests/e2e/tier1/webhook.test.ts` test 1 (`1. Validates HMAC SHA-256 signatures on incoming webhooks (accepts valid, rejects corrupt or missing)`) to fail with `AssertionError: expected 200 to be 401`.
- **Suggestion**: Implement real HMAC SHA-256 validation in `src/app.ts`:
  ```ts
  function verifyWebhookSignature(req: RequestWithRawBody, secret: string): boolean {
    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature) return false;
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    } catch {
      return false;
    }
  }
  ```

---

## Verified Claims

- **Test Execution Suite**: `./node_modules/.bin/vitest run --config vitest.config.e2e.ts tests/e2e/tier1` → 7 test files, 42 tests total (41 PASSED, 1 FAILED).
  - `config.test.ts` (6 tests) → PASS
  - `constitution.test.ts` (6 tests) → PASS
  - `diffState.test.ts` (6 tests) → PASS
  - `omniRoute.test.ts` (6 tests) → PASS
  - `quorum.test.ts` (6 tests) → PASS
  - `ticket.test.ts` (6 tests) → PASS
  - `webhook.test.ts` (6 tests) → 5 PASS, 1 FAIL (`verifyWebhookSignature` facade issue)
- **Interface Compliance**: `tests/e2e/harness/*` modules (`mockGithubServer`, `mockOmniRouteServer`, `mockTicketServer`, `appProcessLauncher`, `stateManager`, `assertions`, `fixtureGenerator`) conform to test harness contracts.

---

## Stress-Testing & Attack Surface Analysis

- **Assumption 1**: `verifyWebhookSignature` in `src/app.ts` protects the bot against forged GitHub webhooks.
  - **Result**: FAILED. `verifyWebhookSignature` returns `true` for all payloads, allowing malicious/corrupt signature requests.
- **Assumption 2**: Diff hunk hashing and finding fingerprint hashing operate deterministically across line endings (`\r\n` vs `\n`).
  - **Result**: PASSED. Verified in `diffState.test.ts` line 55.
- **Assumption 3**: Quorum engine filters out nit severity findings and requires `minApprovals` for APPROVE status.
  - **Result**: PASSED. Verified in `quorum.test.ts`.

---

## Recommendation

Request changes to implement proper HMAC SHA-256 signature verification in `src/app.ts`. Re-run Vitest E2E tier1 suite to confirm 42/42 tests pass.
