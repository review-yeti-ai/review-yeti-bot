# DOKS Review Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Execute in order, preserve the production `calltelemetry/ct-review-actions` route until the explicit activation task, and stop at every approval gate. Do not create a scheduled canary.

**Goal:** Run Review Yeti reviews as bounded DOKS Jobs with durable dispatch, exact-head publication, and a same-PR reusable workspace PVC that is removed after 30 idle minutes.

**Architecture:** The GitHub App ingress persists delivery, run, and outbox state in PostgreSQL. An internal dispatcher projects admitted runs into `PRReviewJob` resources. A leader-elected Go operator controls four active Jobs and manages repository+PR scoped PVC/Lease lifecycle. Workers return signed, idempotent receipts; a separate finalizer rechecks the PR head and publishes. The existing central GitHub Action remains the production fallback through manual qualification.

**Tech Stack:** Node.js 24+, TypeScript 5, PostgreSQL, Express, GitHub App installation tokens, Go 1.22, controller-runtime 0.18, Kubernetes batch Jobs/Leases/PVCs, DOKS block storage, Vitest, Go test.

**Spec:** `docs/superpowers/specs/2026-08-30-doks-review-dispatch-design.md`

**Required companion plans:** The opt-in Action ingress is specified in `docs/superpowers/plans/2026-08-30-action-doks-opt-in.md` and may be implemented before cluster activation because it defaults to local execution and publishes nothing remotely. After Task 9 and before Task 10, execute both `docs/superpowers/plans/2026-08-30-doks-required-review-gate.md` and `docs/superpowers/plans/2026-08-30-doks-fast-worker-image.md`. Task 10 consumes their Check API, image, pre-pull, RBAC, and NetworkPolicy outputs.

## Global constraints

- Work on an isolated branch/worktree. Never reset or overwrite unrelated work.
- Use failing tests before each behavior change and make focused commits after green verification.
- Keep `calltelemetry/ct-review-actions` unchanged until Task 12's explicit activation approval.
- No scheduled/time-based canary, no automatic traffic split, and no silent provider/model failover.
- Preserve the 15-minute webhook-to-terminal limit in every task. A Kubernetes Job timeout is not allowed to reset that clock.
- PostgreSQL is the run/publication source of truth. Kubernetes resources are execution projections.
- Never place the App private key, webhook secret, or long-lived GitHub credential in a worker Pod.
- Never use `do-block-storage-retain`, `ReadWriteMany`, a shared fleet PVC, or a head-SHA-specific PVC for PR workspaces.
- Review all generated CRD/RBAC manifests before applying them to any cluster.
- The production ruleset requires `Review Yeti / Gate` from the Review Yeti App integration and native review-thread resolution. Runtime pods have no repository-administration permission.
- The dedicated worker image must meet the companion plan's 300 MiB/50% size gate and 5/20/60-second warm/reused, warm/new-PVC, and cold-node process-start p95 gates.

---

### Task 1: Freeze executable contracts and add migration-safe database primitives

**Files:**

- Modify: `src/review/reviewRun.ts`
- Modify: `src/persistence/postgresStore.ts`
- Modify: `src/persistence/reviewRunRepository.ts`
- Create: `src/persistence/reviewDispatchRepository.ts`
- Create: `tests/unit/reviewDispatchRepository.test.ts`
- Modify: `tests/integration/reviewRunRecovery.test.ts`

**Step 1: Write failing repository tests**

Cover these exact cases:

```ts
it('admits delivery, run, and one outbox row atomically');
it('returns the existing run for a duplicate delivery');
it('supersedes an older nonterminal head and queues only the new head');
it('claims pending dispatch rows with a renewable lease');
it('recovers an expired dispatch lease without duplicating the run');
it('never requeues a run that already holds a terminal receipt');
```

Define the public types before implementation:

```ts
export interface ReviewAdmission {
  deliveryId: string;
  repositoryId: number;
  installationId: number;
  receivedAt: number;
  terminalDeadline: number;
  payloadDigest: string;
  run: ReviewRun;
}

export interface ReviewDispatchClaim {
  runId: string;
  deliveryId: string;
  repositoryId: number;
  installationId: number;
  leaseOwner: string;
  leaseExpiresAt: number;
}
```

**Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/unit/reviewDispatchRepository.test.ts tests/integration/reviewRunRecovery.test.ts`

Expected: FAIL because the dispatch repository and atomic admission contract do not exist.

**Step 3: Add idempotent PostgreSQL schema**

Inside the existing `PostgresStore.initialize()` advisory-lock transaction add:

```sql
CREATE TABLE IF NOT EXISTS github_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  repository_id BIGINT NOT NULL,
  installation_id BIGINT NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  run_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_dispatch_outbox (
  run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
  delivery_id TEXT UNIQUE NOT NULL REFERENCES github_deliveries(delivery_id),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','projected','terminal')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  projection_name TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS review_dispatch_claim_idx
  ON review_dispatch_outbox (status, available_at, lease_expires_at);
```

Add `repository_id`, `installation_id`, `delivery_id`, `received_at`, and `terminal_deadline` columns to `review_runs` with backfill-safe `ADD COLUMN IF NOT EXISTS`. Do not make a new column `NOT NULL` until existing rows are backfilled.

**Step 4: Implement atomic admission and `SKIP LOCKED` claims**

Implement `ReviewDispatchRepository.admit()`, `claimNext()`, `heartbeat()`, `markProjected()`, `releaseForRetry()`, and `markTerminal()`. `admit()` must run delivery insert, review-run create/supersede, delivery-to-run update, and outbox insert in one transaction. Use database timestamps passed through injectable clocks in tests.

**Step 5: Run focused and baseline recovery tests**

Run: `npm test -- tests/unit/reviewDispatchRepository.test.ts tests/integration/reviewRunRecovery.test.ts tests/unit/reviewRunStoreExpansion.test.ts tests/unit/reviewRunStoreV3.test.ts`

Expected: PASS.

**Step 6: Type-check and commit**

Run: `npm run lint`

Run: `git add src/review/reviewRun.ts src/persistence/postgresStore.ts src/persistence/reviewRunRepository.ts src/persistence/reviewDispatchRepository.ts tests/unit/reviewDispatchRepository.test.ts tests/integration/reviewRunRecovery.test.ts && git commit -m "feat(dispatch): add durable review admission outbox"`

---

### Task 2: Make webhook ingress acknowledge durable admission only

**Files:**

- Modify: `src/github/webhookServer.ts`
- Modify: `src/github/eventHandler.ts`
- Modify: `src/app.ts`
- Create: `src/review/reviewAdmissionService.ts`
- Modify: `tests/unit/webhook.test.ts`
- Create: `tests/integration/webhookAdmission.test.ts`

**Step 1: Write failing ingress tests**

Assert that an authenticated pull-request event:

- returns HTTP `202` only after the database transaction commits;
- returns the same `runId` for a duplicate delivery;
- does not call `runReviewPipeline`, `setImmediate`, Kubernetes, or a provider;
- computes `terminalDeadline = receivedAt + 900_000`;
- rejects missing repository numeric ID or installation ID;
- still returns 401 for invalid HMAC and 400 for authenticated malformed JSON.

**Step 2: Confirm the old in-process behavior fails the tests**

Run: `npm test -- tests/unit/webhook.test.ts tests/integration/webhookAdmission.test.ts`

Expected: FAIL because `src/app.ts` currently starts the pipeline with `setImmediate`.

**Step 3: Implement the admission service**

`ReviewAdmissionService.admit()` accepts only parsed, authenticated event data and calls the repository transaction from Task 1. Move delivery deduplication out of the JSON-file `ReviewRunStore` for this route. Change `WebhookServerOptions.onEvent` to support an explicit response status:

```ts
export interface WebhookHandlerResult {
  statusCode: 200 | 202;
  body: Record<string, unknown>;
}
```

Remove the review `setImmediate` branch. Keep PR-close handling durable by persisting a close outbox action instead of starting `PRCloseDispatcher` in the web process.

**Step 4: Prove ingress has no execution side effects**

Run: `npm test -- tests/unit/webhook.test.ts tests/integration/webhookAdmission.test.ts`

Expected: PASS with one outbox row and zero pipeline/provider/Kubernetes calls.

**Step 5: Commit**

Run: `git add src/github/webhookServer.ts src/github/eventHandler.ts src/app.ts src/review/reviewAdmissionService.ts tests/unit/webhook.test.ts tests/integration/webhookAdmission.test.ts && git commit -m "refactor(webhook): persist review dispatch before acknowledgement"`

---

### Task 3: Harden the immutable `PRReviewJob` v1alpha1 projection

**Files:**

- Modify: `k8s-operator/api/v1alpha1/prreviewjob_types.go`
- Modify: `k8s-operator/api/v1alpha1/zz_generated.deepcopy.go`
- Modify: `k8s-operator/api/v1alpha1/prreviewjob_types_test.go`
- Modify: `k8s-operator/api/v1alpha1/crd_schema_validation_test.go`
- Modify: `k8s-operator/config/crd/bases/review.calltelemetry.com_prreviewjobs.yaml`

**Step 1: Write failing API validation tests**

Add cases requiring `runId`, `deliveryId`, `repositoryId`, `receivedAt`, `terminalDeadline`, `policyDigest`, `configDigest`, digest-pinned `workerImage`, and `runSecretName`. Reject:

- a moving image tag including `latest` or `v1`;
- deadlines later than `receivedAt + 900s`;
- non-40-character base/head SHA;
- non-64-character digests;
- zero repository ID or PR number;
- secret names outside the namespace/DNS-name contract.

**Step 2: Run and confirm failure**

Run: `(cd k8s-operator && go test ./api/v1alpha1)`

Expected: FAIL on missing fields and validations.

**Step 3: Add the contract**

Keep the package path stable for this first implementation, but change the schema fields to the design contract. Separate Job cleanup from workspace cleanup:

```go
type PRReviewJobSpec struct {
    RunID             string      `json:"runId"`
    DeliveryID        string      `json:"deliveryId"`
    RepositoryID      int64       `json:"repositoryId"`
    Repo              string      `json:"repo"`
    PRNumber          int32       `json:"prNumber"`
    HeadSHA           string      `json:"headSha"`
    BaseSHA           string      `json:"baseSha"`
    ReceivedAt        metav1.Time `json:"receivedAt"`
    TerminalDeadline  metav1.Time `json:"terminalDeadline"`
    PolicyDigest      string      `json:"policyDigest"`
    ConfigDigest      string      `json:"configDigest"`
    WorkerImage       string      `json:"workerImage"`
    RunSecretName     string      `json:"runSecretName"`
}
```

Remove per-run `PVCStorageSize` and `TTLSecondsAfterFinished`; workspace size and 1,800-second idle TTL are operator configuration, while finished Jobs use a fixed 300-second cleanup TTL.

**Step 4: Regenerate and verify CRD artifacts**

Run the repository's controller-gen target if available; otherwise update generated deepcopy/schema artifacts with the pinned controller tooling and verify there is no unreviewed schema drift.

Run: `(cd k8s-operator && go test ./api/v1alpha1)`

Expected: PASS.

**Step 5: Commit**

Run: `git add k8s-operator/api/v1alpha1 k8s-operator/config/crd/bases/review.calltelemetry.com_prreviewjobs.yaml && git commit -m "feat(operator): define immutable review job projection"`

---

### Task 4: Implement same-PR workspace identity and exclusive Lease acquisition

**Files:**

- Create: `k8s-operator/pkg/workspace/identity.go`
- Create: `k8s-operator/pkg/workspace/identity_test.go`
- Create: `k8s-operator/pkg/workspace/lease.go`
- Create: `k8s-operator/pkg/workspace/lease_test.go`
- Modify: `k8s-operator/controllers/prreviewjob_controller.go`
- Modify: `k8s-operator/controllers/prreviewjob_controller_test.go`

**Step 1: Write failing identity and lease tests**

Required cases:

```go
func TestWorkspaceKeySameRepositoryAndPRAcrossHeads(t *testing.T)
func TestWorkspaceKeyDiffersForRepositoryOrPR(t *testing.T)
func TestAcquireLeaseRejectsDifferentActiveRun(t *testing.T)
func TestAcquireLeaseRenewsSameRun(t *testing.T)
func TestAcquireLeaseTakesExpiredLeaseWithResourceVersion(t *testing.T)
func TestTerminatingPVCIsNeverAcquired(t *testing.T)
```

**Step 2: Confirm failure**

Run: `(cd k8s-operator && go test ./pkg/workspace ./controllers)`

Expected: FAIL because workspace identity and Lease handling do not exist.

**Step 3: Implement deterministic identity**

Use exactly:

```go
func Key(repositoryID int64, prNumber int32) string
func PVCName(repositoryID int64, prNumber int32) string
func LeaseName(repositoryID int64, prNumber int32) string
```

Hash `review-yeti-workspace-v1\n<repositoryID>\n<prNumber>` with SHA-256. PVC and Lease names include the first 20 hex characters and PR number. Store the full hash, repository ID, and PR number as labels.

**Step 4: Implement Lease acquisition**

Use `coordination.k8s.io/v1 Lease`, `holderIdentity=runId`, and optimistic updates. Lease duration is the remaining Job deadline plus 60 seconds. Do not reuse a claim until the previous Job's Pods are terminal. Reconcile a waiting run after the active lease changes or expires.

**Step 5: Create/reuse the PVC safely**

Build a `ReadWriteOnce`, `1Gi` PVC with `storageClassName: do-block-storage`, required identity labels, `last-used-at`, and `review-yeti.ai/workspace-protection`. Do not set a `PRReviewJob` owner reference. Reject an existing claim whose labels do not reproduce the expected hash.

**Step 6: Verify tests and commit**

Run: `(cd k8s-operator && go test ./pkg/workspace ./controllers)`

Expected: PASS.

Run: `git add k8s-operator/pkg/workspace k8s-operator/controllers/prreviewjob_controller.go k8s-operator/controllers/prreviewjob_controller_test.go && git commit -m "feat(operator): lease reusable pull request workspaces"`

---

### Task 5: Implement the exact 30-minute idle PVC collector

**Files:**

- Replace: `k8s-operator/pkg/cleanup/ttl.go`
- Replace: `k8s-operator/pkg/cleanup/ttl_test.go`
- Modify: `k8s-operator/pkg/cleanup/ttl_stress_test.go`
- Create: `k8s-operator/controllers/workspace_controller.go`
- Create: `k8s-operator/controllers/workspace_controller_test.go`
- Modify: `k8s-operator/controllers/ttl_empirical_test.go`

**Step 1: Write boundary and race tests with a fake clock**

Required tests:

```go
func TestWorkspaceRemainsAt1799SecondsIdle(t *testing.T)
func TestWorkspaceDeletesAt1800SecondsIdle(t *testing.T)
func TestSamePRReuseAt1799SecondsResetsIdleClock(t *testing.T)
func TestDifferentPRCannotResetIdleClock(t *testing.T)
func TestCollectorRefusesPVCWithActiveLease(t *testing.T)
func TestCollectorRefusesPVCReferencedByNonterminalPod(t *testing.T)
func TestAcquireDeleteRaceUsesResourceVersionPrecondition(t *testing.T)
func TestClosedPRStillWaitsThirtyMinutes(t *testing.T)
```

**Step 2: Confirm the current completion-TTL behavior fails**

Run: `(cd k8s-operator && go test ./pkg/cleanup ./controllers -run 'Workspace|TTL|Reuse|Race')`

Expected: FAIL because the current collector deletes a per-run PVC based on CR completion.

**Step 3: Separate Job cleanup from workspace cleanup**

Jobs receive `ttlSecondsAfterFinished: 300`. On terminal Pod observation, the review reconciler releases the Lease, removes `/workspace/runs/<runId>` through the worker's normal cleanup, and patches PVC `last-used-at` with the release time. It does not delete the PVC.

Implement `WorkspaceReconciler` over labeled PVCs. It requeues for the remaining idle duration and deletes only after all five spec conditions pass. Use `client.Preconditions{ResourceVersion: &pvc.ResourceVersion}` for deletion. A PVC with `deletionTimestamp` is not reusable.

**Step 4: Remove the protection finalizer only after safety checks**

When eligible, remove `review-yeti.ai/workspace-protection` and issue a preconditioned delete. Emit structured events for `WorkspaceReused`, `WorkspaceExpired`, `WorkspaceDeletionBlocked`, and `WorkspaceIdentityMismatch`.

**Step 5: Run package and full operator tests**

Run: `(cd k8s-operator && go test ./...)`

Expected: PASS, including exact 1,799/1,800-second behavior and race tests.

**Step 6: Commit**

Run: `git add k8s-operator/pkg/cleanup k8s-operator/controllers/workspace_controller.go k8s-operator/controllers/workspace_controller_test.go k8s-operator/controllers/ttl_empirical_test.go && git commit -m "feat(operator): expire idle PR workspaces after thirty minutes"`

---

### Task 6: Harden the Job and make the operator queue restart-safe

**Files:**

- Modify: `k8s-operator/controllers/prreviewjob_controller.go`
- Modify: `k8s-operator/controllers/prreviewjob_controller_test.go`
- Replace: `k8s-operator/pkg/queue/manager.go`
- Replace: `k8s-operator/pkg/queue/manager_test.go`
- Modify: `k8s-operator/controllers/concurrency_empirical_test.go`
- Modify: `k8s-operator/controllers/duplicate_reconcile_empirical_test.go`
- Modify: `k8s-operator/main.go`

**Step 1: Write failing manifest, deadline, and restart tests**

Assert:

- no more than four nonterminal Jobs after 50 concurrent reconciles;
- restarting queue/operator state reconstructs the four active slots from API objects;
- `activeDeadlineSeconds` is derived from the original webhook deadline and never exceeds 840;
- a run with less than 120 seconds left fails without creating a Pod;
- Job uses `backoffLimit: 0`, 300-second finished TTL, digest image, no service-account token, non-root/read-only/drop-all security, and the Task 4 PVC;
- resources begin at `500m/768Mi` request and `1/1536Mi` limit;
- the worker environment contains no App private key or webhook secret.

**Step 2: Confirm failure**

Run: `(cd k8s-operator && go test ./controllers ./pkg/queue)`

Expected: FAIL because the existing queue is process-local, defaults to three, and the Job floats `latest` without a deadline or security contract.

**Step 3: Make Kubernetes state authoritative for active capacity**

Run the controller with leader election and one serialized admission path. Reconstruct active count by listing nonterminal owned Jobs/CRs during startup and before slot grant. Keep FIFO order from `receivedAt`, with `runId` as a stable tie-breaker. Set the default and deployment value to four.

`main.go` must create a real controller-runtime manager, register both reconcilers, health/ready checks, metrics, leader election, and signal handling; remove the current initialize-and-exit behavior.

**Step 4: Build the hardened Job**

Use the immutable fields from Task 3, computed deadline, Task 4 PVC, and run Secret. Set Pod and container security contexts explicitly. The worker service account has `automountServiceAccountToken: false` and no RoleBinding.

**Step 5: Verify race detector and commit**

Run: `(cd k8s-operator && go test -race ./...)`

Expected: PASS.

Run: `git add k8s-operator/controllers k8s-operator/pkg/queue k8s-operator/main.go && git commit -m "feat(operator): enforce bounded restart-safe review jobs"`

---

### Task 7: Replace both TypeScript Job runners with one durable projection dispatcher

**Files:**

- Create: `src/k8s/prReviewJobProjection.ts`
- Create: `src/k8s/reviewDispatchWorker.ts`
- Create: `src/cli/runDispatchWorker.ts`
- Modify: `src/k8s/k8sJobDispatcher.ts`
- Delete: `src/infrastructure/k8sJobRunner.ts`
- Modify: `tests/unit/k8sJobDispatcher.test.ts`
- Modify: `tests/unit/k8sJobRunnerAndAppConfig.test.ts`
- Modify: `tests/integration/m43m44EmpiricalChallenger.test.ts`
- Create: `tests/integration/reviewDispatchWorker.test.ts`

**Step 1: Write failing projection/idempotency tests**

Test one custom resource per `runId`, deterministic DNS-safe names, digest image validation, one-time Secret creation, successful recovery when Secret/CR already exists, database lease heartbeat, and retry after an API 429/5xx without duplicate execution. Convert the existing `m43m44EmpiricalChallenger` coverage from direct Job simulation to custom-resource projection/recovery coverage so removing `K8sJobRunner` does not strand an old import.

Assert the dispatcher creates no PVC and no Job directly. Those belong only to the operator.

**Step 2: Confirm failure**

Run: `npm test -- tests/unit/k8sJobDispatcher.test.ts tests/unit/k8sJobRunnerAndAppConfig.test.ts tests/integration/m43m44EmpiricalChallenger.test.ts tests/integration/reviewDispatchWorker.test.ts`

Expected: FAIL because two current implementations create Jobs/PVCs directly and one polls synchronously.

**Step 3: Implement the projection worker**

`ReviewDispatchWorker` loops over durable claims, refuses expired runs, derives the deterministic custom-resource and Secret names, and starts custom-resource projection and repository-scoped installation-token/Secret preparation concurrently. It marks projection only after the custom resource exists; the operator independently waits for the matching Secret before Job creation. Use exponential backoff bounded by `terminalDeadline`; never sleep beyond the claim heartbeat interval.

The run Secret contains only:

- short-lived `GITHUB_INSTALLATION_TOKEN`;
- the admitted provider credentials;
- random `RESULT_CALLBACK_TOKEN`.

Store the callback-token SHA-256 in PostgreSQL. Never log Secret data.

**Step 4: Retire duplicate direct Job code**

Turn `K8sJobDispatcher` into the narrow custom-resource client or rename it to `PRReviewJobProjector`; update all imports. Delete `K8sJobRunner` and the fixed shared-PVC configuration. Remove the `KUBERNETES_WORKER_DISPATCH` throw only after this durable path is fully wired and remains disabled by default.

**Step 5: Verify and commit**

Run: `npm test -- tests/unit/k8sJobDispatcher.test.ts tests/unit/k8sJobRunnerAndAppConfig.test.ts tests/integration/m43m44EmpiricalChallenger.test.ts tests/integration/reviewDispatchWorker.test.ts`

Run: `npm run lint`

Expected: PASS.

Run: `git add src/k8s src/cli/runDispatchWorker.ts src/infrastructure/k8sJobRunner.ts tests/unit/k8sJobDispatcher.test.ts tests/unit/k8sJobRunnerAndAppConfig.test.ts tests/integration/m43m44EmpiricalChallenger.test.ts tests/integration/reviewDispatchWorker.test.ts && git commit -m "refactor(dispatch): project durable runs through the operator"`

---

### Task 8: Make workspace reuse safe inside the worker

**Files:**

- Create: `src/workspace/prWorkspace.ts`
- Create: `tests/unit/prWorkspace.test.ts`
- Modify: `src/cli/runLiveReview.ts`
- Create: `src/review/reviewContextLoader.ts`
- Create: `tests/integration/prWorkspaceReuse.test.ts`

**Step 1: Write failing filesystem tests**

Using temporary directories and local bare Git fixtures, prove:

- two heads of the same repository+PR reuse Git objects but receive different clean `/runs/<runId>` worktrees;
- a different repository identity is rejected even if the filesystem path matches;
- a dirty or mismatched exact-head worktree is deleted and recreated;
- admitted base/head SHAs must both be fetched and resolved exactly;
- per-run worktree is removed at terminal while `git-cache` remains;
- artifacts/results are uploaded before per-run cleanup and are not required from PVC afterward.

**Step 2: Confirm failure**

Run: `npm test -- tests/unit/prWorkspace.test.ts tests/integration/prWorkspaceReuse.test.ts`

Expected: FAIL because the current worker does not implement this workspace contract.

**Step 3: Implement the safe layout**

Use:

```text
/workspace/identity.json
/workspace/git-cache/repository.git
/workspace/runs/<runId>/
```

`identity.json` contains repository numeric ID, full name, and workspace-key hash. Create/fetch the bare cache with the short-lived installation token, create a detached exact-head worktree, validate `git rev-parse HEAD`, and remove the credential-bearing remote URL immediately after fetch. Redact URL/userinfo from all exceptions and logs.

**Step 4: Verify and commit**

Run: `npm test -- tests/unit/prWorkspace.test.ts tests/integration/prWorkspaceReuse.test.ts`

Expected: PASS.

Run: `git add src/workspace/prWorkspace.ts src/cli/runLiveReview.ts src/review/reviewContextLoader.ts tests/unit/prWorkspace.test.ts tests/integration/prWorkspaceReuse.test.ts && git commit -m "feat(worker): safely reuse exact-head PR workspaces"`

---

### Task 9: Add authenticated `ReviewReceipt.v1` handoff and exact-head finalization

**Files:**

- Create: `src/review/reviewReceipt.ts`
- Create: `src/persistence/reviewReceiptRepository.ts`
- Create: `src/api/reviewReceiptRouter.ts`
- Create: `src/review/reviewFinalizer.ts`
- Create: `src/review/reviewDeadlineWorker.ts`
- Modify: `src/github/publicationReceipt.ts`
- Modify: `src/persistence/postgresStore.ts`
- Modify: `src/app.ts`
- Create: `tests/unit/reviewReceipt.test.ts`
- Create: `tests/integration/reviewReceiptHandoff.test.ts`
- Create: `tests/integration/reviewDeadlineWorker.test.ts`
- Modify: `tests/unit/publicationIdempotency.test.ts`

**Step 1: Write failing receipt and publication tests**

Cover valid callback, wrong/expired/consumed callback token, mismatched run/head/policy/image/provider/prompt/result digest, duplicate callback, newer current head, ambiguous GitHub publication response, finalizer restart, and a nonterminal run that reaches its original 15-minute deadline without a callback.

**Step 2: Confirm failure**

Run: `npm test -- tests/unit/reviewReceipt.test.ts tests/integration/reviewReceiptHandoff.test.ts tests/integration/reviewDeadlineWorker.test.ts tests/unit/publicationIdempotency.test.ts`

Expected: FAIL because workers currently have no durable result handoff.

**Step 3: Implement canonical receipt validation**

Implement the complete `ReviewReceiptV1` interface from the spec. Add `review_receipts` with unique `run_id`, canonical digest, JSON payload, token-consumed timestamp, and publication status. Authenticate by constant-time comparison with the database callback-token hash. Make exact duplicate callbacks idempotent; reject conflicting duplicates.

Expose the callback on the internal Service only and enforce worker-to-receiver NetworkPolicy. It must not be routed by the public Ingress.

**Step 4: Implement the publisher finalizer**

Claim a durable finalizer lease, mint a fresh installation token, read current PR head, compare all admitted fields, then use the existing publication fence/idempotency receipt. A stale head becomes `superseded`; a timeout becomes a terminal check conclusion; neither publishes findings.

Add `ReviewDeadlineWorker` to claim nonterminal database runs at `terminal_deadline`, atomically fence subsequent receipts, conclude the GitHub check as timed out, and request deletion of the projected custom resource/Job. The timeout conclusion must not wait for Kubernetes cleanup or a worker callback.

**Step 5: Remove publishing authority from worker mode**

`runLiveReview.ts` submits the receipt and exits. It has no `publishReview` path. App private-key references in worker manifests/tests must be absent.

**Step 6: Verify and commit**

Run: `npm test -- tests/unit/reviewReceipt.test.ts tests/integration/reviewReceiptHandoff.test.ts tests/integration/reviewDeadlineWorker.test.ts tests/unit/publicationIdempotency.test.ts tests/integration/reviewRunRecovery.test.ts`

Expected: PASS.

Run: `git add src/review/reviewReceipt.ts src/review/reviewFinalizer.ts src/review/reviewDeadlineWorker.ts src/persistence/reviewReceiptRepository.ts src/persistence/postgresStore.ts src/api/reviewReceiptRouter.ts src/github/publicationReceipt.ts src/app.ts tests/unit/reviewReceipt.test.ts tests/integration/reviewReceiptHandoff.test.ts tests/integration/reviewDeadlineWorker.test.ts tests/unit/publicationIdempotency.test.ts && git commit -m "feat(review): finalize signed worker receipts at exact head"`

---

### Task 10: Package least-privilege DOKS deployment and storage controls

**Files:**

- Create: `k8s/operator-deployment.yaml.tpl`
- Create: `k8s/dispatcher-deployment.yaml.tpl`
- Create: `k8s/internal-result-service.yaml`
- Create: `k8s/review-network-policies.yaml`
- Create: `k8s/resource-quota.yaml`
- Modify: `k8s/rbac.yaml`
- Replace: `k8s/worker-rbac.yaml`
- Modify: `k8s/bot-deployment.yaml.tpl`
- Modify: `k8s/config.yaml`
- Delete: `k8s/workspace-pvc.yaml`
- Create: `tests/unit/k8sDeploymentManifests.test.ts`

**Step 1: Write failing manifest-policy tests**

Parse every manifest and assert:

- ingress service account has no Kubernetes mutation RBAC;
- dispatcher may create/get/watch/patch only `PRReviewJob` and Secrets in the dedicated `ct-review-system` namespace; Kubernetes RBAC cannot restrict dynamic Secret creation by name, so admission tests reject any Secret without the deterministic run name and labels;
- operator may manage `PRReviewJob`, Jobs, PVCs, Leases, Pods/status/events, but not cluster-scoped resources;
- worker has no RoleBinding and `automountServiceAccountToken: false`;
- no fixed/shared workspace PVC or `ReadWriteMany` remains;
- no manifest uses a Retain storage class or floating image;
- NetworkPolicies isolate ingress, dispatcher, operator, worker, PostgreSQL, GitHub/provider egress, and the internal receipt route;
- operator defaults to four active Jobs and workspace idle TTL 1,800 seconds.

**Step 2: Confirm failure**

Run: `npm test -- tests/unit/k8sDeploymentManifests.test.ts`

Expected: FAIL on the current default-service-account binding, shared RWX claim, and missing operator deployment.

**Step 3: Implement deployment manifests**

Create distinct service accounts for ingress, dispatcher, operator, and worker. Enable operator leader election. Put database/App credentials only where needed. Provider credentials may reach the one-time run Secret; App private key remains ingress/dispatcher/finalizer-only. Because Kubernetes RBAC cannot constrain `create secrets` by dynamic resource name, isolate that permission to the dedicated namespace and enforce deterministic Secret name/labels in dispatcher and manifest-policy tests. The operator patches the created Secret with the Job owner reference and explicitly deletes it at terminal reconciliation. Use ExternalSecret/Doppler-managed Secret references already approved for the cluster, not literal secret values.

Delete the shared workspace manifest and both duplicate declarations of `ct-review-bot-workspace-pvc`. Do not delete the durable service data PVC until PostgreSQL/artifact migration is separately proven.

**Step 4: Render and statically validate**

Run: `kubectl apply --dry-run=client -f k8s/namespace.yaml`

Render templates with immutable test digests, then run `kubectl apply --dry-run=client` and `kubectl auth reconcile --dry-run=client` where supported.

Run: `npm test -- tests/unit/k8sDeploymentManifests.test.ts`

Expected: PASS.

**Step 5: Commit**

Run: `git add k8s tests/unit/k8sDeploymentManifests.test.ts && git commit -m "chore(k8s): package least-privilege DOKS review execution"`

---

### Task 11: Instrument reliability, workspace lifecycle, and actual cost

**Files:**

- Modify: `src/telemetry/metrics.ts`
- Create: `src/telemetry/reviewCost.ts`
- Create: `tests/unit/reviewCost.test.ts`
- Modify: `k8s-operator/pkg/metrics/metrics.go`
- Modify: `k8s-operator/pkg/metrics/metrics_test.go`
- Create: `docs/DOKS_REVIEW_OPERATIONS.md`

**Step 1: Write failing metric/cost tests**

Require stage timings, deadline misses, active/queued Jobs, PVC create/reuse/delete, idle age, lease conflict, PV deletion latency, requested/actual CPU-memory seconds, provider/model tokens/cost/retries, and fallback GitHub runner minutes. Labels must use bounded repository IDs/hashes, not PR numbers, SHAs, prompts, secrets, or raw exception text.

**Step 2: Confirm failure**

Run: `npm test -- tests/unit/reviewCost.test.ts && (cd k8s-operator && go test ./pkg/metrics)`

Expected: FAIL on missing measures.

**Step 3: Implement telemetry and cost receipt**

Add one per-run cost summary that separates:

```ts
interface ReviewCostSummary {
  runId: string;
  requestedCpuSeconds: number;
  observedCpuSeconds?: number;
  requestedMemoryGiBSeconds: number;
  observedMemoryGiBSeconds?: number;
  pvcGiBMinutes: number;
  providerBilledUsd: number;
  fallbackRunnerMinutes: number;
}
```

Document queries for 15-minute SLO, terminal rate, workspace reuse/deletion, provider spend, and incremental DOKS node/storage spend. Add alerts for any nonterminal run at 13 minutes, PVC deletion stuck 10 minutes, active Jobs over four, publication mismatch, or missing terminal receipt.

**Step 4: Verify and commit**

Run: `npm test -- tests/unit/reviewCost.test.ts && (cd k8s-operator && go test ./pkg/metrics)`

Expected: PASS.

Run: `git add src/telemetry/metrics.ts src/telemetry/reviewCost.ts tests/unit/reviewCost.test.ts k8s-operator/pkg/metrics docs/DOKS_REVIEW_OPERATIONS.md && git commit -m "feat(observability): measure DOKS review reliability and cost"`

---

### Task 12: Verify in isolation, manually qualify, and stop before production activation

**Files:**

- Create: `scripts/verify-doks-review-dispatch.sh`
- Create: `scripts/qualify-doks-review-dispatch.ts`
- Create: `docs/superpowers/evidence/doks-review-dispatch-evidence-template.md`
- Modify: `docs/DOCUMENTATION_AUTHORITY.md`
- Modify: `docs/ARCHITECTURE.md`

**Step 1: Build one deterministic verification command**

The script must run:

```bash
npm ci --ignore-scripts
npm run lint
npm test -- tests/unit/webhook.test.ts tests/integration/webhookAdmission.test.ts \
  tests/unit/reviewDispatchRepository.test.ts tests/integration/reviewDispatchWorker.test.ts \
  tests/unit/prWorkspace.test.ts tests/integration/prWorkspaceReuse.test.ts \
  tests/unit/reviewReceipt.test.ts tests/integration/reviewReceiptHandoff.test.ts \
  tests/integration/reviewDeadlineWorker.test.ts \
  tests/unit/reviewThreadGate.test.ts tests/unit/reviewGateCheck.test.ts \
  tests/integration/reviewThreadGateReconciliation.test.ts \
  tests/unit/reviewDispatchTiming.test.ts tests/unit/workerContainerContract.test.ts \
  tests/unit/publicationIdempotency.test.ts tests/unit/k8sDeploymentManifests.test.ts \
  tests/unit/reviewCost.test.ts
(cd k8s-operator && go test -race ./...)
```

It also renders manifests and runs client-side schema validation. Any failure exits nonzero.

**Step 2: Run an isolated namespace smoke test**

Use a disposable namespace, synthetic Git repository, non-publishing callback, and digest-pinned images. Prove duplicate admission, operator restart, dispatcher restart, worker failure, superseded head, deadline expiry, same-PR PVC reuse, cross-PR isolation, and receipt idempotency.

Also prove the required Check contract: unresolved conversations and binding blocks produce `action_required`; execution errors produce `failure`; deadline expiry produces `timed_out`; only exact-head `SHIP` with no unresolved required conversations produces `success`. A thread-resolution event must reconcile the gate without creating a Job or provider request.

Explicitly verify storage lifecycle:

1. inspect `do-block-storage` and record `reclaimPolicy: Delete`;
2. run head A and head B for the same repository+PR and record the same PVC UID;
3. at 1,799 seconds of fake-clock/integration time prove the claim remains;
4. reuse and prove `last-used-at` resets;
5. leave idle for 1,800 seconds and prove PVC deletion;
6. prove bound PV deletion;
7. query DigitalOcean by captured volume ID and prove the block volume no longer exists.

Do not test the real 30-minute wait in every CI run; unit/integration tests use an injected clock. The one DOKS lifecycle proof may use real elapsed time or a separately configured qualification-only controller TTL, but the production manifest must remain exactly 1,800 seconds.

**Step 3: Run manual non-publishing qualifications**

Run exactly one manual six-scenario provider qualification and ten recent exact-head fixture replays through DOKS. No cron, recurring workflow, or background heartbeat is created. Record terminal status, defect recall, clean false positives, total/stage latency, provider/model, tokens, provider cost, CPU/memory, PVC reuse, and publication suppression.

Required gate:

- 16/16 terminal;
- 0 over 15 minutes;
- quality no worse than the approved released Action baseline;
- 0 duplicate/stale publications (and 0 publications during non-publishing qualification);
- 0 App private key or Kubernetes token in worker environment/logs;
- at most four active Jobs.
- required `Review Yeti / Gate` is sourced from the Review Yeti App and unresolved conversations demonstrably block merge;
- worker image and the three dispatch tiers meet the companion performance gates.

**Step 4: Run one approved live parallel review**

Only after explicit approval, dispatch one real PR through both paths. The central Action is the sole publisher. DOKS stores a nonbinding receipt for comparison. If any terminal, quality, deadline, security, or cleanup gate fails, stop and keep the Action as production.

**Step 5: Document evidence and request activation approval**

Fill the evidence template with exact commit/image digests, cluster/context, commands, run IDs, timestamps, provider routes, costs, PVC/PV/volume identities, and pass/fail outcomes. Link the proposed service design from the optional-service documentation while preserving its non-authoritative status.

Stop here. Do not modify `calltelemetry/ct-review-actions`, required checks, fleet allowlists, or consumer repositories without a new explicit production activation approval.

Run: `git add scripts/verify-doks-review-dispatch.sh scripts/qualify-doks-review-dispatch.ts docs/superpowers/evidence/doks-review-dispatch-evidence-template.md docs/DOCUMENTATION_AUTHORITY.md docs/ARCHITECTURE.md && git commit -m "docs(ops): add DOKS review qualification and rollback gates"`

---

### Task 13: Production activation and rollback rehearsal (separate explicit approval required)

**Files:**

- Modify in central control-plane repository: `calltelemetry/ct-review-actions` allowlist/routing files discovered at execution time
- Modify: `docs/DOKS_REVIEW_OPERATIONS.md`
- Add: exact-head protected review and activation evidence

**Step 1: Re-fetch and rebase exact current heads**

Verify the Review Yeti release tag/image digest, central workflow head, DOKS deployment digest, and protected branch state. Do not assume paths or refs from this plan are still current.

**Step 2: Rehearse rollback before activation**

In a non-publishing fixture, remove DOKS routing and prove the central Action starts and publishes under its current 15-minute contract. Record the one-change rollback and owner.

**Step 3: Opt in one repository**

Use the central control plane, not consumer repository edits. Keep provider/model policy unchanged so execution-platform and provider changes are not confounded. Observe every run until it reaches a terminal result; unchanged or missing state is not a pass.

**Step 4: Apply the production gate**

Require 100% terminal completion, zero stale/duplicate publication, zero 15-minute misses, approved review quality, and verified PVC/PV/provider-volume cleanup. If any gate fails, immediately remove the allowlist entry and restore the central Action route.

**Step 5: Expand only through separately reviewed batches**

Do not auto-expand, schedule a canary, or disable the fallback based on elapsed time. Each expansion has exact-head protected review, terminal CI, post-merge verification, and a current rollback receipt.

---

## Final implementation review checklist

- [ ] Every spec requirement maps to an implementation task and an executable acceptance test.
- [ ] Public interfaces use the same field names and types across TypeScript, SQL, Go, CRD YAML, and receipts.
- [ ] Database migration is safe for existing `review_runs` rows and concurrent service startup.
- [ ] Duplicate delivery, process restart, operator restart, same-PR new head, and publication ambiguity are fail-closed.
- [ ] PVC identity is repository numeric ID + PR number, never head SHA alone.
- [ ] PVC is reusable only by the same PR, serially, and remains at 1,799 seconds idle.
- [ ] PVC, PV, and DigitalOcean block volume are gone after 1,800 seconds idle when not reused.
- [ ] Job cleanup TTL is distinct from workspace idle TTL.
- [ ] Four-Job cap and 15-minute end-to-end deadline survive restarts.
- [ ] Worker has neither App private key nor Kubernetes API token.
- [ ] Images are immutable digests; no `latest` remains in the execution path.
- [ ] `Review Yeti / Gate` is required from the App integration; unresolved conversations cannot pass and thread-only reconciliation makes no model call.
- [ ] Worker image is prebuilt, worker-only, pre-pulled, at most 300 MiB compressed and at least 50% smaller than the service image.
- [ ] Dispatch process-start p95 is at most 5s warm/reused, 20s warm/new-PVC, and 60s on a qualification cold node.
- [ ] Manual non-publishing parallel qualification passes; no scheduled canary exists.
- [ ] Production activation remains a separate explicit approval with a rehearsed one-change rollback.
