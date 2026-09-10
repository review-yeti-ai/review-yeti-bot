# DigitalOcean Kubernetes (DOKS) Review Operations

This guide covers operational management and cluster verification for running Review Yeti on **DigitalOcean Kubernetes (DOKS)**.

For the general architecture, async dispatch handshake, and cost analysis across any Kubernetes cluster, see the [Kubernetes & DOKS Execution Mode Guide](KUBERNETES_MODE.md).

---

## 🛠️ Installing the Runtime

From your Review Yeti repository checkout with `kubectl` configured for your target DOKS cluster:

```bash
# Set your container image registries and cluster network endpoints
REVIEW_OPERATOR_IMAGE='registry.example.com/review-yeti/operator@sha256:<digest>' \
REVIEW_DISPATCHER_IMAGE='registry.example.com/review-yeti/dispatcher@sha256:<digest>' \
REVIEW_WORKER_IMAGE='registry.example.com/review-yeti/worker@sha256:<digest>' \
KUBERNETES_SERVICE_IP='<service-ip>' \
KUBERNETES_API_ENDPOINT_CIDR='<control-plane-cidr>' \
scripts/install-doks-review-runtime.sh
```

The installer verifies:
- Immutable container digests (`sha256:...`).
- Least-privilege RBAC definitions in an isolated namespace.
- Application of the `review-yeti.ai/v1alpha2` Custom Resource Definition (CRD).

Both the installer and `scripts/deploy-review-job-dispatcher.sh` are
deliberately install/upgrade boundaries: they apply at `replicas: 0` and
refuse to activate a deployment. Neither script has -- nor is meant to have
-- a path to move the worker image forward once a dispatcher is already
serving production traffic.

---

## 🔁 Advancing the Production Worker Digest

Production runs the review-job-dispatcher's worker image at a single pinned
digest, stored in the `ct-review-job-dispatcher` ConfigMap's
`REVIEW_JOB_WORKER_IMAGE` key. A merge to `main` does not, by itself, reach
production: it only makes a new commit's image available to pull. Advancing
the live dispatcher to that commit is a separate, explicit operational step.
In the CallTelemetry production cluster, Flux owns this key from
`calltelemetry/ct-infrastructure` on `main`, at
`clusters/doks-nyc1/apps/ct-review-system/cm-ct-review-job-dispatcher.yaml`.
The runtime helper discovers that ownership; it does not compete with the
controller.

First produce the read-only plan against the already-active dispatcher:

```bash
# Read-only plan; retain its identity/hash snapshot for review.
scripts/advance-review-worker.sh \
  --context <explicit-context> --source-sha <reviewed-full-40-hex-sha> \
  --target-image ghcr.io/review-yeti-ai/review-yeti-worker@sha256:<index-digest> \
  > worker-plan.json

# Inspect .action and .management before doing anything else.
jq '{action,management,targetImage}' worker-plan.json
```

When `.action` is `gitops-update-required`, `--apply` is deliberately
unavailable. Update the exact digest and release annotations in the
`ct-infrastructure` manifest, update its stage-2 provenance fixture, and land
that change through the protected pull-request path. Wait until Flux reports
the exact merge revision as Ready and applied:

```bash
kubectl --context <explicit-context> --namespace flux-system \
  get kustomization flux-system -o json \
  | jq -e --arg revision 'main@sha1:<ct-infrastructure-merge-sha>' '
      .status.lastAppliedRevision==$revision
      and any(.status.conditions[]?; .type=="Ready" and .status=="True")'
```

Regenerate `worker-plan.json` from live state. The only valid Flux-managed
actions now are `restart` (the ConfigMap has converged but the pod is stale) or
`noop` (the owned ready pod already reports the target). After separate
approval of that fresh plan, persist the guarded restart/no-op receipt:

```bash
scripts/advance-review-worker.sh \
  --context <same-context> --source-sha <same-reviewed-sha> \
  --target-image ghcr.io/review-yeti-ai/review-yeti-worker@sha256:<same-index-digest> \
  --expected-state worker-plan.json --receipt <new-private-receipt-path> --apply
```

The default is read-only, including old positional invocations. A full SHA
may still be positional (mixed case is normalized); release tags and implicit
apply are no longer supported. Context and target digest are mandatory.
--dry-run is a plan alias and cannot be combined with --apply.

The operator machine now requires **Node.js on PATH** for receipt publication
(built-in fs only, no npm package). The helper checks this prerequisite before
any cluster call. Its filesystem must support exclusive/no-follow file creation
and file/directory fsync; unsupported persistence fails closed. The dispatcher
image already includes Node, used for the fixed non-secret running attestation.

The existing source-tag resolver verifies the exact full-SHA tag against the
caller-supplied digest, then reads that immutable index and requires Linux
amd64 and arm64 entries. The worker GHCR and CallTelemetry DOCR repositories
are allowlisted; moving tags, platform digests and registry fallbacks are not.
This proves registry source-tag matching, not a cryptographic build attestation.
The caller supplies independently reviewed source.

Every Kubernetes request selects the explicit context and fixed namespace
ct-review-system, with a 30-second API timeout; ambient context never changes.
The helper requires the already-active, enabled, prebaked dispatcher and named
review-job-dispatcher container. The reviewed plan binds both object
UIDs/resourceVersions, Deployment generation/image/replicas, current worker
image, Flux ownership coordinates when present, and hashes of all protected
configuration. Raw configuration and secrets are not persisted.

For a Flux-owned mismatched key, apply stops before receipt/intent creation or
any Kubernetes write. After Flux converges, apply persists a new mode-0600
`<receipt>.intent`, then a guarded patch changes only the owned
review-yeti.ai/worker-upgrade pod-template annotation. Unmanaged installations
retain the key-only compare-and-swap followed by the same guarded restart. No
forced apply, field-ownership reclamation, Flux suspension, activation,
replica/image change, or gateway/auth/permission change occurs. A matching key
is a no-op only when all expected owned ready dispatcher pods actually report
the target worker image; otherwise the plan explicitly requires a restart.
Rollout is bounded to 180 seconds; exact object/configuration and owned
running-pod readback must pass before a success receipt is written.

Every owned ready running pod must attest **prebaked mode**, using the actual
runtime reader's trimmed REVIEW_JOB_RUNNER_MODE / RUNNER_MODE precedence and
prebaked default. The probe emits only mode and worker image, never the whole
environment. Admission checks this before mutation/no-op, and final readback
checks it after rollout. A generic or unreadable running lane is refused, not
converted or activated by a restart. Only a stale image in an already-prebaked
lane is eligible for the guarded restart. Older owned pods can establish
prebaked admission after a lost restart ACK, but cannot prove the current
restart completed.

There is no Kubernetes transaction spanning both objects. Individual CAS
patches and pre/post-restart checks detect drift, but an inter-object race can
leave a partial update. Rejected writes, lost acknowledgements, rollout failure,
and unreadable/drifted readback stop without retry or automatic rollback.
Retain the intent and outcome receipt; failure receipts do not claim an
observed final state. A killed process may leave only the pre-write intent.
Use a private local receipt directory: existing files, leaf symlinks and
missing/symlink parents are rejected, and files are created without overwrite.
Both intent and outcome use the same Node fs O_EXCL/O_NOFOLLOW creation primitive,
not Bash noclobber or a pathname precheck as the publication guard. Every occupied
destination, including late FIFO/directory symlinks, is refused. File and parent
directory fsync plus a regular-file identity/size/mode check precede success.
A failed write can leave a new incomplete file; it is not reused or deleted
automatically, and a failed outcome write leaves the prior intent intact.
Intent, no-op and outcome serialization must succeed before their file writer
is invoked. Serialization failure publishes no receipt or success; a failed
intent prevents all patch attempts, and a failed outcome preserves the prior
durable intent unchanged.

For a separately approved rollback, first acquire a new read-only plan:
use the same command with `--rollback <retained-upgrade-receipt-or-intent>`,
`--target-image <recorded-prior-worker-digest>`, and the reviewed source SHA
that proves that prior index. Review that fresh plan, then repeat with
`--expected-state <new-plan> --receipt <new-path> --apply`. The record must bind
the same context, objects, protected shapes, and original or singly restarted
generation/owned marker. The current worker key must be either the recorded
prior or attempted target. Unrelated drift is refused, not repaired.
Fresh resourceVersions are CAS inputs; rollback is a new restart, not a reset
of Kubernetes history. No chained/general-purpose rollback is provided.

**A worker key update or dispatcher restart invalidates older image-only
runtime-upgrade receipts.** Restoring prior bytes cannot restore ConfigMap
resourceVersion or Deployment generation. Never edit or weaken those receipts'
guards; a future runtime image rollback needs a new independently validated
plan. Local tests do not authorize or prove a runtime deployment.

This is intentionally a distinct, deliberately manual action from the `v1`
action-tag promotion described in the release workflows: promoting `v1` moves
which release of this repository's GitHub Action consumers pin to, gated
behind its own canary window; `advance-review-worker.sh` moves which worker
image the production dispatcher in `ct-review-system` actually runs. Neither
step implies the other.

---

## Distinguishing queue delay, stream inactivity and the panel deadline

These are separate failure stages; increasing every timeout does not repair
all of them:

- **Queued without a worker:** inspect admission time, terminal deadline and
  reservation state. Eligible work is admitted oldest-first at the existing
  capacity limit. A pending worker-creation reservation still occupies its
  slot. Expired or invalid requests do not block healthy queued work.
- **Worker active, provider stalled:** the publishing policy permits 180
  seconds without meaningful provider output. Text, reasoning or tool-call
  progress resets this inactivity timer; heartbeat-only traffic does not.
  A progressing stream may run longer than 180 seconds.
- **Overall panel deadline:** the existing 900-second budget still bounds
  the complete panel. Expiry propagates cancellation and rejects late results;
  progress does not reset this overall clock. Five investigation turns is an
  upper bound, not a requirement to consume the full budget.

For new authoritative prepared admissions, the API serializes this policy
into the digest-bound execution envelope. A worker-only rollout cannot change
already-admitted policy. Upgrade the reviewed API and worker together when
changing publishing defaults, and include the operator for admission fixes.
Never edit a queued envelope or its digest to retrofit a new policy.

The native publishing client implements the progress-aware idle policy above.
The legacy OmniRoute adapter retains its existing hard provider-timeout cap
and now links caller cancellation; it does not advertise progress-reset idle
support. Passing a longer panel budget must not silently widen that legacy cap.

Qualify changes with synthetic active-stream, stalled-stream, caller-abort and
late-result tests, plus reservation/FIFO controller tests. Then verify one
current-head review on the exact deployed images. Record the queue and worker
times separately; an accepted dispatch, healthy pod, or green wrapper is not
a completed review. Capture only bounded, sanitized diagnostic categories;
do not retain raw review prompts or credentials.

## 📋 Operational Verification & Qualification Order

To verify your cluster deployment before rolling out to production repositories:

1. **Verify CRD & Namespaces**:
   ```bash
   kubectl get crd | grep prreviewjobs
   kubectl get pods -n review-yeti-system
   ```
2. **Run a Receipt-Only Worker Test**:
   Execute one receipt-only worker with `publicationMode=disabled` to verify container startup, git access, and network egress without making live model calls or writing to GitHub.
3. **Run Single Deterministic Review**:
   Execute a manual review against a known sample PR diff fixture and verify that persona evaluations complete and output valid JSON.
4. **End-to-End Validation**:
   Dispatch a test review from a GitHub Actions workflow using `execution-backend: doks` and verify:
   - Initial check run appears as `review-status: DISPATCHED`, `gate-decision: PENDING`.
   - GitHub Actions runner exits in under 10 seconds.
   - Worker pod schedules on the DOKS cluster and processes the diff.
   - Worker updates the check run to `success` or `failure` and posts the consolidated review comment.
