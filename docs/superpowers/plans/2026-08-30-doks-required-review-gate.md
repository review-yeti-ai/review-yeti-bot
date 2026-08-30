# DOKS Required Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the direct Review Yeti GitHub App behave as a required exact-head CI gate that remains non-passing for binding review failures and unresolved required conversations.

**Architecture:** Review Yeti creates one fixed-name Check Run per admitted head, stores its ID with the durable review run, and finalizes it from verified receipts plus a live paginated review-thread snapshot. Thread webhooks enqueue a lightweight gate-only reconciliation; they never dispatch a Kubernetes Job or call a model. Repository rulesets—not runtime pods—require the App-sourced check and native conversation resolution.

**Tech Stack:** Node.js 24+, TypeScript 5, PostgreSQL, GitHub App Checks REST API, GitHub GraphQL API, GitHub rulesets, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-doks-review-dispatch-design.md`

## Global Constraints

- Prerequisite: complete Tasks 1, 2, and 9 of `2026-08-30-doks-review-dispatch.md` before this plan.
- Check name is exactly `Review Yeti / Gate`; `external_id` is the durable `runId` and the check belongs to the admitted head SHA.
- Only `success` passes. Never use `neutral` or `skipped` for an admitted required review.
- A thread resolution cannot override a binding `BLOCK`; only a fresh exact-head `SHIP` receipt can do that.
- Re-query current head and all review threads immediately before writing `success`.
- Gate-only reconciliation performs zero provider requests and creates zero Kubernetes resources.
- Runtime GitHub App credentials have no repository-administration permission and cannot edit rulesets.
- Keep the existing central Action required check unchanged until manual non-publishing and ruleset qualification pass.

---

### Task 1: Query exact-head review threads and compute a fail-closed gate decision

**Files:**

- Create: `src/github/reviewThreadGate.ts`
- Modify: `src/github/installationClient.ts`
- Create: `tests/unit/reviewThreadGate.test.ts`
- Modify: `tests/unit/installationClientExpansion.test.ts`

**Interfaces:**

- Consumes: an installation token, admitted `owner`, `repo`, `prNumber`, `headSha`, stored binding verdict, and stored unthreaded blocking finding IDs.
- Produces:

```ts
export interface ReviewThreadState {
  nodeId: string;
  isResolved: boolean;
  rootAuthorLogin?: string;
  rootCommentUrl?: string;
}

export interface ReviewThreadSnapshot {
  observedHeadSha: string;
  threads: ReviewThreadState[];
}

export type ReviewGateConclusion =
  | 'success'
  | 'action_required'
  | 'failure'
  | 'timed_out'
  | 'cancelled';

export interface ReviewGateDecision {
  conclusion: ReviewGateConclusion;
  reason:
    | 'ready'
    | 'binding_verdict'
    | 'unresolved_conversations'
    | 'unthreaded_blockers'
    | 'stale_head';
  unresolvedCount: number;
  unresolvedYetiCount: number;
  unthreadedBlockingFindingIds: string[];
}

export function decideReviewGate(input: {
  admittedHeadSha: string;
  snapshot: ReviewThreadSnapshot;
  bindingVerdict: 'SHIP' | 'BLOCK';
  reviewYetiLogin: string;
  unthreadedBlockingFindingIds: string[];
}): ReviewGateDecision;
```

- [ ] **Step 1: Write failing gate-decision tests**

Add cases for exact-head clean `SHIP`, stale head, `BLOCK` with no threads, any unresolved human thread, unresolved Review Yeti thread, resolved threads, and body-only blocking findings. Assert resolving all threads cannot turn `BLOCK` into `success`.

```ts
expect(decideReviewGate({
  admittedHeadSha: 'a'.repeat(40),
  snapshot: {
    observedHeadSha: 'a'.repeat(40),
    threads: [{ nodeId: 'PRRT_1', isResolved: false, rootAuthorLogin: 'review-yeti[bot]' }],
  },
  bindingVerdict: 'SHIP',
  reviewYetiLogin: 'review-yeti[bot]',
  unthreadedBlockingFindingIds: [],
})).toMatchObject({
  conclusion: 'action_required',
  reason: 'unresolved_conversations',
  unresolvedCount: 1,
  unresolvedYetiCount: 1,
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/unit/reviewThreadGate.test.ts`

Expected: FAIL because `reviewThreadGate.ts` does not exist.

- [ ] **Step 3: Add a paginated GraphQL method**

Add `GitHubInstallationClient.getReviewThreadSnapshot(owner, repo, prNumber)` using this query and pagination until `hasNextPage` is false:

```graphql
query ReviewYetiThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              url
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

Use `POST /graphql`, the existing installation token, the existing GitHub API version/user-agent conventions, and a maximum of 100 pages. Treat a missing PR, missing head, malformed page, repeated cursor, or page-limit breach as an error; never convert incomplete thread data into a passing snapshot.

- [ ] **Step 4: Implement the pure decision function**

Evaluate in this order: stale head, binding verdict, unthreaded blocker, unresolved conversations, success. Count all unresolved threads for native conversation parity and separately count unresolved threads whose normalized root author equals the configured App login.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/unit/reviewThreadGate.test.ts tests/unit/installationClientExpansion.test.ts`

Expected: PASS, including two-page pagination and fail-closed malformed responses.

- [ ] **Step 6: Type-check and commit**

Run: `npm run lint`

```bash
git add src/github/reviewThreadGate.ts src/github/installationClient.ts tests/unit/reviewThreadGate.test.ts tests/unit/installationClientExpansion.test.ts
git commit -m "feat(github): compute exact-head review thread gate"
```

---

### Task 2: Publish one fixed-name required Check Run from the App

**Files:**

- Create: `src/github/reviewGateCheck.ts`
- Modify: `src/github/installationClient.ts`
- Modify: `src/persistence/postgresStore.ts`
- Modify: `src/persistence/reviewRunRepository.ts`
- Create: `tests/unit/reviewGateCheck.test.ts`
- Modify: `tests/integration/webhookAdmission.test.ts`

**Interfaces:**

- Consumes: durable `runId`, exact `headSha`, `ReviewGateDecision`, receipt/check summary, and durable run details URL.
- Produces:

```ts
export const REVIEW_GATE_CHECK_NAME = 'Review Yeti / Gate';

export interface ReviewGateCheckRecord {
  runId: string;
  checkRunId: number;
  headSha: string;
  status: 'in_progress' | 'completed';
  conclusion?: ReviewGateConclusion;
}

export interface ReviewGateCheckPublisher {
  create(input: {
    owner: string;
    repo: string;
    runId: string;
    headSha: string;
    detailsUrl: string;
  }): Promise<ReviewGateCheckRecord>;
  complete(input: {
    record: ReviewGateCheckRecord;
    decision: ReviewGateDecision;
    title: string;
    summary: string;
    annotations: Array<{
      path: string;
      startLine: number;
      endLine: number;
      level: 'failure' | 'warning' | 'notice';
      message: string;
    }>;
  }): Promise<ReviewGateCheckRecord>;
}
```

- [ ] **Step 1: Write failing Check API tests**

Require fixed name, `external_id=runId`, exact head, `details_url`, `in_progress` admission, completed decision conclusion, and annotation batching at 50 per PATCH. Reject a record whose stored head differs from the run. Assert admitted policy-exempt runs write an explicit `success`, not `neutral` or no check.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/unit/reviewGateCheck.test.ts tests/integration/webhookAdmission.test.ts`

Expected: FAIL because the durable gate publisher/columns do not exist.

- [ ] **Step 3: Add migration-safe check columns**

Add `check_run_id BIGINT`, `check_head_sha CHAR(40)`, `check_status TEXT`, and `check_conclusion TEXT` to `review_runs` with `ADD COLUMN IF NOT EXISTS`. Add repository methods `attachCheckRun()` and `completeCheckRun()` that compare run ID and exact head in the update predicate.

- [ ] **Step 4: Implement Check creation and completion**

Create the Check immediately after the admission transaction using the short-lived App installation token. If Check creation fails, retain the run/outbox and retry from a dedicated publication lease; do not start execution without a durable Check ID. Use `action_required`, `failure`, `timed_out`, `cancelled`, or `success` exactly as decided.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/unit/reviewGateCheck.test.ts tests/integration/webhookAdmission.test.ts tests/unit/installationClientExpansion.test.ts`

Expected: PASS.

```bash
git add src/github/reviewGateCheck.ts src/github/installationClient.ts src/persistence/postgresStore.ts src/persistence/reviewRunRepository.ts tests/unit/reviewGateCheck.test.ts tests/integration/webhookAdmission.test.ts
git commit -m "feat(github): publish durable Review Yeti gate check"
```

---

### Task 3: Reconcile resolved threads without rerunning a model

**Files:**

- Create: `src/review/reviewGateReconciler.ts`
- Create: `src/persistence/reviewGateRepository.ts`
- Modify: `src/persistence/postgresStore.ts`
- Modify: `src/github/eventHandler.ts`
- Modify: `src/review/reviewAdmissionService.ts`
- Modify: `src/review/reviewFinalizer.ts`
- Create: `tests/integration/reviewThreadGateReconciliation.test.ts`
- Modify: `tests/unit/webhook.test.ts`

**Interfaces:**

- Consumes: authenticated `pull_request_review_thread` action `resolved`; review-comment `created`, `edited`, or `deleted`; durable run/receipt/check; live thread snapshot.
- Produces:

```ts
export interface ReviewGateReconcileClaim {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  reason: 'thread_resolved' | 'review_comment_changed' | 'receipt_finalized';
  leaseOwner: string;
  leaseExpiresAt: number;
}

export class ReviewGateReconciler {
  reconcile(claim: ReviewGateReconcileClaim): Promise<ReviewGateDecision>;
}
```

- [ ] **Step 1: Write failing event and reconciliation tests**

Prove duplicate thread webhooks coalesce, reconciliation makes zero provider/Kubernetes calls, the final resolved thread moves a stored `SHIP` run to `success`, a stored `BLOCK` remains `action_required`, a newer head cancels the old check, and GraphQL failure leaves the existing check non-passing.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/integration/reviewThreadGateReconciliation.test.ts tests/unit/webhook.test.ts`

Expected: FAIL because no gate outbox/reconciler exists.

- [ ] **Step 3: Add a coalescing gate outbox**

Add:

```sql
CREATE TABLE IF NOT EXISTS review_gate_outbox (
  repository_id BIGINT NOT NULL,
  pr_number INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','terminal')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repository_id, pr_number)
);
```

Upsert events to `pending`, preserving one row per PR. Claim with `FOR UPDATE SKIP LOCKED` and a renewable lease.

- [ ] **Step 4: Implement event admission**

Authenticate and persist thread/review-comment deliveries through the same delivery deduplication boundary. Enqueue only gate reconciliation. Do not invoke `runReviewPipeline`, the dispatch outbox, or provider code.

- [ ] **Step 5: Implement fail-closed reconciliation**

Load the latest exact-head terminal receipt/check for the PR, fetch current head/thread snapshot, recompute the decision, and update only that check. If the current head lacks a terminal receipt, leave/create its Check `in_progress`; do not borrow the old head's result.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/integration/reviewThreadGateReconciliation.test.ts tests/unit/webhook.test.ts tests/unit/reviewThreadGate.test.ts tests/unit/reviewGateCheck.test.ts`

Expected: PASS with provider and Kubernetes spies at zero calls.

```bash
git add src/review/reviewGateReconciler.ts src/persistence/reviewGateRepository.ts src/persistence/postgresStore.ts src/github/eventHandler.ts src/review/reviewAdmissionService.ts src/review/reviewFinalizer.ts tests/integration/reviewThreadGateReconciliation.test.ts tests/unit/webhook.test.ts
git commit -m "feat(github): reconcile resolved review threads without model calls"
```

---

### Task 4: Qualify the required App-sourced ruleset safely

**Files:**

- Create: `scripts/verify-review-gate-ruleset.mjs`
- Create: `tests/unit/reviewGateRuleset.test.ts`
- Modify: `docs/DOKS_REVIEW_OPERATIONS.md`
- Modify in central control-plane repository at activation only: ruleset/allowlist files discovered from exact current head

**Interfaces:**

- Consumes: repository, target branch, expected Review Yeti integration ID, expected check name.
- Produces a read-only JSON report with `requiredCheckPresent`, `expectedSourceMatches`, `threadResolutionRequired`, `bypassActors`, `bypassVisibility: 'complete' | 'redacted'`, and `effectiveEnforcement`.

- [ ] **Step 1: Write failing ruleset report tests**

Use fixtures for inherited organization rulesets, wrong integration ID, evaluate-only enforcement, missing conversation resolution, App bypass, redacted bypass data, and a fully active rule. Runtime/readiness mode exits nonzero unless the rule is active, App-sourced, and thread-resolution-required. Activation-audit mode additionally exits nonzero unless bypass visibility is complete and the Review Yeti App is absent from bypass actors.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/unit/reviewGateRuleset.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement read-only effective-ruleset verification**

Read repository rulesets with inherited parents, normalize `required_status_checks` and `required_review_thread_resolution`, and print no token or authenticated URL. Runtime readiness may call this verifier with the App's metadata-read installation token; GitHub may redact bypass actors from that response. A one-time activation audit uses an administrator-provided credential only in the local command environment to prove the bypass list, then discards it. Neither mode may PATCH a ruleset.

- [ ] **Step 4: Run a manual non-publishing gate proof**

In a qualification repository:

1. create `Review Yeti / Gate` from the App on an exact head;
2. require that exact context from the App integration;
3. require conversation resolution;
4. demonstrate `action_required`, `failure`, and `timed_out` each block merge;
5. demonstrate unresolved Yeti and human threads block;
6. resolve the final thread for a stored `SHIP` receipt and prove success without provider calls;
7. demonstrate a stored `BLOCK` remains blocked until a new exact-head `SHIP` run;
8. remove the qualification rule and confirm the central Action path remains unchanged.

This is a one-time manual proof, never a scheduled canary.

- [ ] **Step 5: Verify, document, and commit**

Run: `npm test -- tests/unit/reviewGateRuleset.test.ts tests/unit/reviewThreadGate.test.ts tests/unit/reviewGateCheck.test.ts tests/integration/reviewThreadGateReconciliation.test.ts`

Expected: PASS.

```bash
git add scripts/verify-review-gate-ruleset.mjs tests/unit/reviewGateRuleset.test.ts docs/DOKS_REVIEW_OPERATIONS.md
git commit -m "test(github): qualify required Review Yeti merge gate"
```

## Acceptance checklist

- [ ] Every admitted head receives exactly one `Review Yeti / Gate` Check from the Review Yeti App.
- [ ] Required check is tied to the expected App integration ID and exact current head.
- [ ] `action_required`, `failure`, and `timed_out` block the qualification PR.
- [ ] Any required unresolved conversation prevents `success`.
- [ ] Thread resolution never overrides a binding `BLOCK`.
- [ ] Gate-only reconciliation causes zero provider requests and zero Kubernetes resources.
- [ ] Runtime App cannot mutate the ruleset and has no bypass.
- [ ] The central Action remains the production fallback until separate activation approval.
