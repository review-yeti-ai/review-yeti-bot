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
the live dispatcher to that commit is a separate, explicit operational step,
run against an already-active dispatcher:

```bash
# Read-only plan; retain its identity/hash snapshot for review.
scripts/advance-review-worker.sh \
  --context <explicit-context> --source-sha <reviewed-full-40-hex-sha> \
  --target-image ghcr.io/review-yeti-ai/review-yeti-worker@sha256:<index-digest> \
  > worker-plan.json

# ONLY after separate approval of that plan and its current coordinates:
scripts/advance-review-worker.sh \
  --context <same-context> --source-sha <same-reviewed-sha> \
  --target-image ghcr.io/review-yeti-ai/review-yeti-worker@sha256:<same-index-digest> \
  --expected-state worker-plan.json --receipt <new-private-receipt-path> --apply
```

The default is read-only, including old positional invocations. A full SHA
may still be positional (mixed case is normalized); release tags and implicit
apply are no longer supported. Context and target digest are mandatory.
--dry-run is a plan alias and cannot be combined with --apply.

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
image, and hashes of all protected configuration. Raw configuration and
secrets are not persisted.

Apply persists a new mode-0600 `<receipt>.intent` before writing. A JSON Patch
compare-and-swap changes only data.REVIEW_JOB_WORKER_IMAGE. After an exact
readback and drift check, another guarded patch changes only the owned
review-yeti.ai/worker-upgrade pod-template annotation to restart the dispatcher.
No forced apply, field-ownership reclamation, activation, replica/image change,
or gateway/auth/permission change occurs. A matching key is a no-op only when
all expected owned ready dispatcher pods actually report the target worker
image; otherwise the plan explicitly requires a restart. Rollout is bounded
to 180 seconds; exact object/configuration and owned running-pod readback must
pass before a success receipt is written.

There is no Kubernetes transaction spanning both objects. Individual CAS
patches and pre/post-restart checks detect drift, but an inter-object race can
leave a partial update. Rejected writes, lost acknowledgements, rollout failure,
and unreadable/drifted readback stop without retry or automatic rollback.
Retain the intent and outcome receipt; failure receipts do not claim an
observed final state. A killed process may leave only the pre-write intent.
Use a private local receipt directory: existing files, leaf symlinks and
missing/symlink parents are rejected, and files are created without overwrite.

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
