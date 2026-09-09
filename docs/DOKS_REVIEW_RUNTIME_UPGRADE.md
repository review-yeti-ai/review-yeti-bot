# Active Review Yeti runtime image advancement

`scripts/advance-review-runtime.sh` updates one named Deployment in
`ct-review-system`:

| Component | Deployment | Container |
| --- | --- | --- |
| api | ct-review-action-dispatch | action-dispatch |
| dispatcher | ct-review-job-dispatcher | review-job-dispatcher |
| operator | ct-review-yeti-operator | operator |

The default is a read-only plan. A write requires `--apply` and a new
`--receipt` path. One JSON patch changes the selected image, guarded by UID,
resourceVersion, generation and current-image tests. It does not apply a full
manifest, use force-conflicts, change replicas, issue an extra restart, update
the worker ConfigMap, or alter environment/Secret references. The selected
image uses the helper's field-manager identity; unrelated fields are not
patched or force-owned.

## Source identity and authorization

The caller supplies an independently reviewed lowercase 40-hex source SHA.
The helper allowlists the component's image repositories and uses `crane` to
verify that the registry's exact source-SHA tag resolves to the requested
manifest/index digest. A mismatch or unavailable registry fails before a write.
This is registry provenance, not a cryptographic build attestation or a
substitute for source review and current deployment authorization. No provider
calls or credential-broker operations are added.

## Durable evidence and recovery

Receipts contain only before/after identities, images, replica counts,
generation, protected-shape hashes and the worker ConfigMap's non-secret runner
mode/image. Raw environment data and Secret contents are never emitted.

Before each patch, a new exclusive `<receipt>.intent` records the observed
before-state and intended after-state. An intent is explicitly unconfirmed
(`afterObserved=false`), never proof of a completed rollout. If the patch
response or readback is lost, an upgrade intent can be supplied to `--rollback`.
The live UID, exact image, expected generation and protected shape must match
before any recovery write. Existing receipts and intents are never overwritten.

Rollback also rejects unrelated Deployment or worker ConfigMap changes.
Controller status updates can change resourceVersion without changing the
Deployment specification; the helper verifies generation and declared shape,
then uses the freshly read resourceVersion in the atomic patch to reject a
concurrent change. Rollout/readback failure returns non-zero. A failed rollout
may still have an observed receipt marked `rollout_failed`; that is not success.

Keep the intent and final receipt. Neither grants authority on another target.

## Invocation

A plan requires `--component`, `--expected-current-image`, `--expected-uid`,
`--expected-resource-version`, `--target-image` and `--source-sha`. Image
arguments must include a full lowercase SHA-256 digest. Apply additionally uses
`--apply --receipt PATH`.

Rollback uses `--rollback PATH_TO_UPGRADE_RECEIPT --apply --receipt NEW_PATH`.
An upgrade intent can replace the source receipt only when live reconciliation
proves its intended after-state.

## Deployment boundary

The API service runs `dist/dispatchIndex.js`, not the job dispatcher's
`dist/reviewJobDispatcherIndex.js`. Use the `api` component for that separate
Deployment. Advancing images does not configure callback ingress, RBAC, or
operator environment; those declarative changes require reviewed readback
before activation. See [worker failure recovery](worker-failure-recovery.md).

The native operator template declares `REVIEW_YETI_COMPLETION_URL` as empty;
Helm exposes `publishing.completionUrl` (empty by default, omitted from the
rendered environment). The installer deliberately does not interpolate a
callback URL from ambient environment variables and retains its zero-replica
and active-deployment refusal guards. After the CRD, API/ingress, dispatcher
and worker prerequisites are verified, set the reviewed HTTPS completion URL
in private deployment configuration. Render and review it, then activate only
that environment entry on the named active operator container with a separate
JSON patch guarded by fresh UID, resourceVersion, generation, image and prior
environment tests. Preserve every unrelated field and replica count; do not
apply the whole dormant template. Capture separate activation intent/readback
evidence: the image-only helper does not perform this step, and changing the
environment invalidates its earlier image rollback receipt.

A worker ConfigMap image is configuration, not provenance. Never infer its
source from another component's tag, a checkout, or an old version annotation.
The invoking identity must already have scoped Deployment get/patch and
ConfigMap/rollout read access. This helper grants no RBAC, changes no identity,
and does not weaken dormant installer guards.
