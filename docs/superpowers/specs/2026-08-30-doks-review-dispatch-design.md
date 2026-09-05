# DOKS Review Dispatch Design

**Status:** Proposed; non-authoritative until implemented, reviewed, released, and activated through the Review Yeti fleet control plane.

**Date:** 2026-08-30

## Purpose

Move Review Yeti execution from per-review hosted GitHub Action runners to bounded Kubernetes Jobs on the existing DigitalOcean Kubernetes cluster without weakening review correctness, publication safety, or rollback. GitHub remains the event source and review UI. PostgreSQL is the durable lifecycle authority. Kubernetes is an execution substrate, not the source of truth for whether a review may publish.

The current `review-yeti-ai/review-yeti-actions` workflow remains the production fallback throughout qualification. Consumer repositories remain configuration-light. Multica may observe runs and request authenticated manual re-drives later, but it is not in the critical webhook, dispatch, execution, or publication path.

## Non-negotiable constraints

- A review reaches a terminal GitHub check conclusion no later than 15 minutes after the accepted webhook delivery.
- No scheduled, periodic, or four-hour canary is permitted. Qualification is manual, bounded, non-publishing, and tied to an explicit change or approval.
- At most four review Jobs run concurrently until measured DOKS capacity supports a reviewed change.
- Only the exact admitted pull-request head may publish. A newer head supersedes the older run.
- Every admitted head receives one `Review Yeti / Gate` Check Run created by the Review Yeti GitHub App. The check is non-passing while the binding verdict blocks, required conversations are unresolved, execution fails, or the deadline expires.
- Production rulesets require `Review Yeti / Gate` from the Review Yeti App integration and require review-thread resolution. The runtime App cannot modify repository rulesets or grant itself a bypass.
- The public webhook receiver has no Kubernetes Job, PVC, Lease, Secret, or custom-resource permissions.
- Review workers never receive the GitHub App private key.
- Images are pinned by immutable digest. Floating `latest` or moving release tags are rejected at admission.
- A provider failure may fail the review according to existing policy; it may not silently change provider, model, policy, prompt, or publication semantics.
- The current central Action path stays available for immediate rollback until the DOKS path satisfies all rollout gates.

## Architecture

```text
GitHub App webhook
  -> public ingress: HMAC verification, event admission, exact-head Gate check
  -> PostgreSQL transaction: delivery + review_run + dispatch_outbox
  -> internal dispatcher: claim outbox and mint short-lived installation token
  -> PRReviewJob execution projection
  -> operator: capacity gate + PR workspace lease + PVC + hardened Job
  -> worker: exact-head checkout, review pipeline, signed ReviewReceipt.v1 callback
  -> PostgreSQL artifact + terminal receipt
  -> publisher finalizer: current-head recheck + publication fence + GitHub review/check

Optional observers
  <- run/status events for dashboard or Multica
```

### Authority boundaries

| Component | May do | Must not do |
|---|---|---|
| Webhook ingress | Verify HMAC, deduplicate delivery, persist admission and outbox, create in-progress check | Create Kubernetes resources or run a review in-process |
| Dispatcher | Claim durable outbox, mint repository-scoped installation token, create one-time run Secret and `PRReviewJob` | Publish a review or reinterpret policy |
| Operator | Enforce concurrency/deadline, manage Lease/PVC/Job lifecycle, report execution state | Hold GitHub App private key or decide review verdict |
| Worker | Fetch admitted base/head, execute the immutable review contract, submit signed receipt | Publish to GitHub, reuse another PR workspace, or receive the App private key |
| Publisher finalizer | Validate receipt, recheck exact head, claim publication fence, publish idempotently | Publish a stale, unsigned, incomplete, or policy-mismatched result |
| Multica | Read status and request authenticated manual re-drive in a later phase | Receive cluster mutation RBAC or sit in the required data path |

PostgreSQL `review_runs` remains the lifecycle authority. A `PRReviewJob` is an immutable execution projection keyed by `runId`. Kubernetes status may be reconciled back into PostgreSQL, but losing or recreating a custom resource cannot create a second publication right.

## Durable admission and dispatch

Webhook admission must complete in one PostgreSQL transaction:

1. Insert `github_deliveries.delivery_id` with the authenticated event metadata and payload digest.
2. Create or return the deterministic `review_runs` identity for repository, PR, base SHA, head SHA, snapshot/policy/config digests.
3. Supersede any nonterminal run for the same repository and PR with a different head SHA.
4. Insert one `review_dispatch_outbox` row keyed by `run_id`.
5. Commit before returning HTTP `202 Accepted`.

Duplicate deliveries return the already-admitted `runId`. They never enqueue a second execution. Pull-request close events mark the workspace non-reusable but do not bypass the 30-minute idle storage rule.

The dispatcher claims rows with `FOR UPDATE SKIP LOCKED`. Each claim has a renewable database lease. A crash before custom-resource creation returns the outbox row to `pending`; a crash after creation observes the deterministic `runId` resource and records it without duplication.

## Fifteen-minute deadline

`receivedAt` is the authenticated webhook admission time and is carried through every layer. The terminal deadline is `receivedAt + 900 seconds`.

- Queue/dispatch has a target budget of 60 seconds.
- The operator refuses to start a Job when less than 120 seconds remain.
- `activeDeadlineSeconds` is `min(840, terminalDeadline - now - 60)`, reserving at least 60 seconds for receipt validation and publication/failure conclusion.
- Worker provider calls inherit the remaining run deadline. No provider request can extend the run deadline.
- Job `backoffLimit` is `0`; retries are explicit durable attempts with the same run identity and bounded remaining time.
- At 5 and 10 minutes the check output may be updated with current stage and elapsed time. These are progress updates for an active review, not scheduled probes.
- At 15 minutes the finalizer concludes the GitHub check as timed out even if Kubernetes cleanup is still converging.

A database-backed deadline sweeper claims every nonterminal run whose `terminalDeadline` has passed, fences any later worker receipt, concludes the check as timed out, and requests Kubernetes cancellation. This sweeper is required for the 15-minute guarantee; a Job deadline or operator status alone is insufficient when callbacks or the cluster control plane are unavailable.

## GitHub merge gate and unresolved conversations

The Kubernetes Job is runner-like execution capacity, but Review Yeti does not register it as a GitHub Actions self-hosted runner. GitHub integration is through the Checks API, which avoids a required workflow run while still exposing queued/in-progress/completed state, annotations, a details URL, re-request actions, and a branch-protection result.

The exact check name is `Review Yeti / Gate`. The App creates one check per admitted `headSha` with `external_id=runId`, status `in_progress`, and a details URL to the durable run. It completes with only these conclusions:

| Condition | Check conclusion | Merge effect when required |
|---|---|---|
| exact-head binding verdict is `SHIP`, publication receipt is verified, and no required conversation is unresolved | `success` | passes Review Yeti gate |
| binding verdict blocks, a blocking finding lacks a resolvable thread, or a required conversation is unresolved | `action_required` | blocks |
| execution/receipt/policy validation fails | `failure` | blocks |
| original 15-minute deadline expires | `timed_out` | blocks |
| a newer head supersedes the run | `cancelled` on the old SHA | old result cannot satisfy the new SHA |

`neutral` and `skipped` are never used for an admitted required review because GitHub treats them as success-like for required checks. A policy-exempt PR receives an explicit `success` receipt explaining the trusted base-SHA exemption; absence of a check is not a valid skip.

Before any transition to `success`, the finalizer queries the current PR head and paginates every live review thread. The query records thread node ID, `isResolved`, first-comment author and URL, and the exact head observed with the thread snapshot. The gate distinguishes:

- all unresolved conversations, because the native ruleset requires conversation resolution;
- unresolved Review Yeti finding threads, for check annotations and remediation summaries;
- blocking findings that fell back to a body-only comment and therefore cannot be resolved as a thread.

Resolving a thread does not override a binding `BLOCK` verdict. A fresh exact-head re-review must produce `SHIP`. When the stored verdict is already `SHIP`, resolving the final required conversation may move the check to `success` without another model call.

The App subscribes to `pull_request_review_thread` resolution events and relevant review-comment changes. These events enqueue an idempotent gate-only reconciliation that re-queries current head and all threads; it does not dispatch a Kubernetes Job or call a model. A new PR head always creates a new review run/check. The native ruleset remains the final protection if GitHub does not deliver a thread event.

Production activation configures an organization or repository ruleset with:

- required status check context `Review Yeti / Gate`;
- expected source set to the Review Yeti GitHub App integration ID;
- `required_review_thread_resolution: true`;
- no Review Yeti App bypass actor;
- the existing exact-head/update/approval requirements left intact.

This ruleset mutation is an administrative activation step outside runtime credentials. The App needs `checks:write`, pull requests read/write for its reviews, and contents read; it does not need repository administration permission.

## PR-scoped workspace PVC

### Why this is not a Kubernetes ephemeral volume

A Kubernetes generic ephemeral volume is owned by one Pod and cannot be reused by a later Job. The required behavior therefore uses a normal `PersistentVolumeClaim` that the operator treats as an ephemeral, PR-scoped cache.

### Identity and isolation

The workspace key is:

```text
sha256("review-yeti-workspace-v1\n" + githubRepositoryNumericId + "\n" + prNumber)
```

The PVC name is `ct-rw-<first-20-hex>-pr-<prNumber>`, truncated to 63 characters. The GitHub numeric repository ID prevents owner/name reuse and fork collisions. Head SHA is intentionally excluded so a later commit on the same PR can reuse Git objects. Only a run whose repository ID and PR number reproduce the stored workspace-key hash may acquire the claim.

Required labels and annotations are:

```yaml
metadata:
  labels:
    review-yeti.ai/workspace: "true"
    review-yeti.ai/repository-id: "123456789"
    review-yeti.ai/pr-number: "42"
    review-yeti.ai/workspace-key-hash: "<64 lowercase hex>"
  annotations:
    review-yeti.ai/last-used-at: "2026-08-30T20:00:00Z"
    review-yeti.ai/last-head-sha: "<40 lowercase hex>"
    review-yeti.ai/reuse-disabled: "false"
```

The claim is `ReadWriteOnce`, initially `1Gi`, and explicitly selects `storageClassName: do-block-storage`. That class must be reverified to have `reclaimPolicy: Delete` before deployment. `do-block-storage-retain` is forbidden for these workspaces.

The PVC has no owner reference to an individual `PRReviewJob`, Job, or Pod. It has the `review-yeti.ai/workspace-protection` finalizer so the operator can serialize last-use checks with deletion. Result receipts and model outputs are stored in the durable artifact store, never solely on this cache.

### Exclusive reuse

Each workspace has a `coordination.k8s.io/v1 Lease` with the same identity suffix. The operator acquires it using Kubernetes resource-version preconditions:

- `holderIdentity` is `runId`.
- `leaseDurationSeconds` covers the remaining Job deadline plus cleanup grace.
- The operator renews the lease while the Job or its Pod is nonterminal.
- A different run for the same PR waits until the old Pod is fully terminated and the lease is released.
- A newer admitted head supersedes the older database run; its Job is deleted, its Pod termination is observed, then the same PR may reacquire the claim.
- A claim with `deletionTimestamp` is never mounted. The operator creates a fresh claim after deletion completes.

The worker stores a bare Git object cache under `/workspace/git-cache` and creates a clean, exact-head worktree under `/workspace/runs/<runId>`. Before review it verifies repository identity, fetches the admitted base and head, removes any previous directory for that run ID, and checks out the exact SHA. On release it deletes `/workspace/runs/<runId>` while preserving only validated Git objects. A dirty checkout or a checkout belonging to a different repository fails closed.

### Thirty-minute idle garbage collection

The workspace idle TTL is exactly 1,800 seconds and is distinct from `Job.spec.ttlSecondsAfterFinished`.

The operator sets `last-used-at` when it releases a lease after the Pod is terminal. Reacquisition by the same repository ID and PR number cancels pending garbage collection and resets the idle clock when that run releases. No other PR can reset or reuse the clock.

The workspace reconciler may delete a PVC only when all conditions are true:

1. `now - last-used-at >= 1,800 seconds`.
2. The matching Lease has no unexpired holder.
3. No nonterminal Job or Pod references the claim.
4. The claim identity labels reproduce its workspace-key hash.
5. The PVC resource version still matches the version inspected before deletion.

At 1,799 seconds the PVC must remain. At 1,800 seconds it becomes eligible. A same-PR acquisition that races with collection wins only if it updates the Lease/PVC before the collector's preconditioned delete; otherwise it waits for deletion and creates a fresh claim. A closed or merged PR is marked `reuse-disabled: "true"`; it is still retained until 30 minutes after last use unless an authorized security purge explicitly deletes it sooner.

The operator records PVC deletion, then observes that the bound PV disappears. The deployment smoke test additionally verifies through DigitalOcean that the backing block-storage volume is removed. A stuck terminating PVC/PV raises an alert; it is not silently treated as reclaimed.

Job resources have an independent short cleanup TTL of 300 seconds after completion. Deleting a Job never deletes the reusable workspace PVC.

## Kubernetes execution contract

`PRReviewJob.spec` carries only non-secret execution identity and immutable digests:

```yaml
spec:
  runId: "rr_..."
  deliveryId: "..."
  repositoryId: 123456789
  repo: "review-yeti-ai/backend-api"
  prNumber: 42
  headSha: "<40 hex>"
  baseSha: "<40 hex>"
  receivedAt: "2026-08-30T20:00:00Z"
  terminalDeadline: "2026-08-30T20:15:00Z"
  policyDigest: "<64 hex>"
  configDigest: "<64 hex>"
  workerImage: "registry.digitalocean.com/...@sha256:<64 hex>"
  runSecretName: "ct-review-run-<digest>"
```

The dispatcher deterministically names and projects the custom resource while preparing its one-time Secret concurrently. The operator may ensure/reuse the PR PVC as soon as it observes the projection, but it cannot create the review Job until the named Secret exists, validates for the same `runId`, and a capacity slot is granted. The Secret contains a repository-scoped, short-lived GitHub installation token, provider credentials required by the admitted policy, and a random result-callback bearer token. The database stores only the callback-token hash. After creating the Job, the operator patches the Secret with that Job's controller owner reference; terminal reconciliation also explicitly deletes the Secret so cleanup does not depend only on owner-reference garbage collection. It never contains the GitHub App private key.

Worker Job defaults:

- `backoffLimit: 0`
- `ttlSecondsAfterFinished: 300`
- computed `activeDeadlineSeconds`, never beyond the 15-minute run deadline
- digest-pinned worker image and `imagePullPolicy: IfNotPresent`
- requests `500m CPU / 768Mi`, limits `1 CPU / 1536Mi` for initial qualification
- non-root user, runtime-default seccomp, read-only root filesystem, no privilege escalation, all Linux capabilities dropped
- `automountServiceAccountToken: false`
- workspace PVC mounted at `/workspace`; writable `emptyDir` only for `/tmp`
- NetworkPolicy egress limited to DNS, GitHub, admitted model-provider endpoints, and the internal receipt endpoint

Resource values are qualification defaults, not permanent truth. Change them only from observed p50/p95 CPU, memory, scheduling, and deadline data.

## Fast worker dispatch and image contract

Dispatch speed is measured as distinct spans rather than one opaque duration:

```ts
interface ReviewDispatchTimingV1 {
  version: 'ReviewDispatchTiming.v1';
  runId: string;
  tier: 'warm_reused' | 'warm_new_workspace' | 'cold_node';
  webhookReceivedAt: number;
  admissionCommittedAt: number;
  projectionCreatedAt: number;
  workspaceReadyAt: number;
  jobCreatedAt: number;
  podScheduledAt: number;
  imageReadyAt: number;
  processStartedAt: number;
  checkoutReadyAt: number;
  firstProviderRequestAt: number;
}
```

Qualification has three explicit tiers:

| Tier | Condition | p95 webhook-to-process target | p95 webhook-to-first-provider-request target |
|---|---|---:|---:|
| warm/reused | worker digest present on node and same-PR PVC reused | 5s | 10s |
| warm/new workspace | worker digest present; new block PVC required | 20s | 30s |
| cold node | autoscaled node must pull image and attach/create storage | 60s | 90s |

These targets do not extend the 15-minute terminal deadline. A missed startup target is a performance failure with stage attribution, not permission to wait longer.

The worker uses a dedicated `Dockerfile.worker`, not the dashboard/service image. It contains Node.js 24, CA certificates, Git, ripgrep, compiled worker code, and only the worker runtime dependency closure. It contains no Next.js frontend, dashboard assets, test fixtures, compiler, npm cache, `gh` CLI, App private key, or service entrypoint. The runtime image is non-root/read-only and is pinned by digest.

The worker image is built once per reviewed release and pushed to the DigitalOcean registry in the DOKS region; it is never built during review dispatch. Layers place the stable Node/runtime dependencies before compiled worker code. BuildKit cache mounts accelerate image publication but are not part of dispatch latency.

`imagePullPolicy: IfNotPresent` is safe because the Job uses an immutable digest. A tiny, secret-free DaemonSet references the same digest to pre-pull it on every eligible current or newly autoscaled review node. The DaemonSet makes no GitHub or provider calls and is not a canary. Release activation waits for every eligible node to report the new digest ready before routing reviews to it.

PVC creation/binding begins as soon as the immutable custom resource is accepted and runs concurrently with token/Secret preparation. The preparation window is bounded to the four active runs plus the next four FIFO runs; later custom resources remain queued without allocating a PVC until they enter that window. Queued runs still cannot create a review Pod before a capacity slot is available. Reused claims skip provisioning. The Job has one container, no service-mesh injection, no init container, no Kubernetes API token, and no per-run package installation.

The worker image gate requires both:

- compressed image size at most 300 MiB and at least 50% smaller than the current service image; and
- container process-start p95 at most 2 seconds after kubelet reports the image ready on a warm node.

If the dependency closure cannot meet the size gate without unsafe dynamic-import omissions, the release fails. Pre-pulling may improve warm dispatch but cannot waive the cold-image correctness and size tests.

## Receipt and publication

The worker submits `ReviewReceipt.v1` to an internal-only endpoint:

```ts
interface ReviewReceiptV1 {
  version: 'ReviewReceipt.v1';
  runId: string;
  deliveryId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  policyDigest: string;
  configDigest: string;
  workerImageDigest: string;
  providerRouteDigest: string;
  promptDigest: string;
  resultDigest: string;
  terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'superseded';
  artifacts: Record<string, string>;
  startedAt: string;
  completedAt: string;
}
```

The callback token authenticates one run and is consumed idempotently. The receiver recomputes the canonical receipt digest, validates every admitted identity/digest field, stores artifacts, and queues publication. A mismatched receipt fails the run and cannot publish.

Before publication the finalizer:

1. mints a fresh installation token;
2. reads the current PR head from GitHub;
3. compares it with the receipt head and database admission;
4. claims the existing database publication fence;
5. publishes with the existing idempotency key and records `PublicationReceipt`;
6. completes the check and run atomically as far as the GitHub/API boundary permits.

If the head changed, the run becomes `superseded` and only a cancelled/superseded check conclusion may be written. Recovery after an ambiguous GitHub response verifies existing reviews/checks before retrying.

## Capacity and cost controls

The operator runs with leader election and reconstructs active capacity from Kubernetes objects after restart; the existing process-local queue is not authoritative. It starts no more than four nonterminal review Jobs. Queued custom resources consume no worker CPU and do not create deliberately unschedulable Pods to trigger autoscaling.

Metrics must include:

- webhook-to-admission, queue, scheduling, checkout, model, publication, and total durations;
- active/queued/terminal Jobs and 15-minute deadline misses;
- workspace create/reuse/delete counts, idle age, mounted-Pod count, lease conflicts, PV/provider-volume deletion latency, and bytes provisioned;
- requested and actual CPU/memory seconds per run;
- provider/model request count, input/output/cached/reasoning tokens, billed provider cost, retry count, and terminal cause;
- GitHub Action fallback invocations and runner minutes during migration.

These measurements distinguish avoided hosted-runner cost from provider cost and incremental DOKS node/storage cost.

## Rollout and rollback

There is no traffic split and no scheduled canary.

1. Ship schema, admission, dispatcher, operator, worker receipt, publisher, manifests, and observability while the DOKS route is disabled.
2. Run unit/integration tests and an isolated namespace smoke test with synthetic repositories.
3. Run one manual non-publishing six-scenario provider qualification through DOKS.
4. Replay ten recent exact-head fixtures in non-publishing mode and compare terminal reliability, findings, false positives, latency, and cost with the released central Action.
5. With explicit approval, run one real PR through both paths; only the current Action publishes and the DOKS result is stored for comparison.
6. With separate explicit approval, opt one repository into DOKS publication while the central workflow remains one-change rollback.
7. Expand only after the acceptance gates remain satisfied.

Rollback removes the repository from the DOKS allowlist and restores the central `review-yeti-ai/review-yeti-actions` required workflow. It does not change provider routing or consumer repository configuration.

## Acceptance gates

- 100% terminal completion for the six-scenario qualification and ten-fixture replay.
- 0 runs exceed 15 minutes from webhook acceptance to check conclusion.
- 0 duplicate executions from duplicate deliveries or dispatcher/operator restart.
- 0 stale-head or duplicate publications.
- `Review Yeti / Gate` is required from the Review Yeti App source; `action_required`, `failure`, and `timed_out` demonstrably block a test PR.
- A `SHIP` receipt cannot pass while any required review conversation is unresolved; resolving the final thread triggers gate-only reconciliation without a provider call.
- A binding `BLOCK` verdict cannot be cleared by resolving its threads; a new exact-head `SHIP` receipt is required.
- At least the currently approved review-quality gate; DOKS does not lower defect recall or increase clean false positives.
- Same repository+PR reuses one PVC across different head SHAs, with serial access.
- Different PRs and repositories never reuse a PVC.
- Reuse at 1,799 seconds preserves the claim and resets idle expiration.
- No reuse deletes the claim at or after 1,800 seconds, followed by PV and DigitalOcean volume deletion.
- Operator/dispatcher restart reconstructs queue, leases, and active count without exceeding four Jobs.
- Worker Pod has no App private key and no Kubernetes API token.
- Worker image meets the 300 MiB/50% size gate and 2-second warm process-start gate.
- Warm/reused, warm/new-workspace, and cold-node dispatch meet the 5/20/60-second process-start p95 targets.
- Rollback to the central Action is rehearsed and completes without consumer-repository edits.
