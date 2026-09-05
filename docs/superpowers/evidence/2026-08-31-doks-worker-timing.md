# DOKS worker timing qualification — 2026-08-31

Status: one manual, receipt-only DOKS qualification passed after two infrastructure fixes. No
provider request, GitHub write, review publication, traffic split, or scheduled canary was used.

## Comparison baseline

The hosted `review-yeti-ai/review-yeti-actions` Review Yeti workflow baseline remains the prior
45-terminal-run sample:

| Path | Sample | p50 | p95 | Maximum | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Hosted Action runner occupancy | 45 | 213s | 352s | 374s | `startedAt` → `updatedAt` |
| Hosted Action creation → finish | 45 | 227s | 357s | 1,208s | includes GitHub runner queue time |

Those runs had 39 successes, 6 failures, 2 skips, and 3 cancellations. The two largest queue
delays were 259s and 930s; they are not worker execution time.

These hosted figures and the DOKS observations below are measurements, not a claim that either
path is production-equivalent. DOKS has only one completed warm/reused receipt-only sample in
this qualification.

## Qualification setup

- Operator source head: `c9d6dbe` (`fix(operator): record fast worker start timing`).
- Operator image: `registry.digitalocean.com/review-yeti/review-yeti-operator@sha256:63b610857dd9458a73480482e36505852dbfa1a409d6d779d36339e786a2a5cf`.
- Worker image: `registry.digitalocean.com/review-yeti/review-yeti-worker@sha256:481f73b96132d2d95d2c71bb8cb281e65987bd40491be5717ece8767854801cf` (amd64 manifest of the immutable qualification tag).
- Kubernetes API egress was restricted to the exact Service IP `10.245.0.1/32`, translated DOKS endpoint `100.65.15.150/32`, and public endpoint `104.248.111.134/32`, TCP/443, plus DNS.
- The v1alpha2 CRD and operator were installed only in `ct-review-system`; the checked-in deployment remained `replicas: 0` and disabled.
- The synthetic projection used `publicationMode: disabled`, no Secret object, and a PR-scoped 1 GiB `do-block-storage` PVC.

## DOKS receipts

### Diagnostic run (`run_222…`)

The first enabled run created a new PVC and reached `Succeeded` in approximately 10 seconds with
zero provider calls and zero GitHub writes. It exposed two issues before any review work:

1. the initial NetworkPolicy allowed the public API address but not the in-cluster/translated
   DOKS API path, so leader election timed out;
2. a very fast worker was already `Terminated` at observation time, so the controller omitted
   `processStartedAt`.

Both were fixed and reviewed before the successful retry.

### Successful reused-PVC run (`run_333…`)

The exact synthetic receipt was:

| Stage | UTC timestamp | Delta from receipt |
| --- | --- | ---: |
| `receivedAt` | 2026-08-31T19:39:36Z | 0s |
| `jobCreatedAt` | 2026-08-31T19:39:37Z | 1s |
| `podScheduledAt` | 2026-08-31T19:39:37Z | 1s |
| `imageObservedAt` | 2026-08-31T19:39:43Z | 7s |
| `processStartedAt` | 2026-08-31T19:39:43Z | 7s |
| `completedAt` | 2026-08-31T19:39:46Z | 10s |

The worker persisted `ReviewYetiReceiptOnly.v1` on the reusable PR workspace with:

- `status: succeeded`;
- `providerCalls: 0`;
- `githubWrites: 0`;
- `publicationMode: disabled`;
- worker receipt `startedAt`/`completedAt`: 2026-08-31T19:39:43.766Z.

This is a dispatch/startup measurement only. It does not qualify a provider, model response,
review recall, false-positive rate, publication finalizer, or required-check behavior.

## Fixes landed

1. PR #336 packaged a pinned-Go static operator image (`FROM scratch`, numeric UID/GID 1000).
2. PR #340 added exact egress for the in-cluster Service, translated DOKS endpoint, and public
   API endpoint. The first two rules are required because DOKS translates Service traffic before
   NetworkPolicy evaluation.
3. PR #341 records `Terminated.StartedAt` so fast workers still produce a complete lifecycle
   receipt.

The non-fatal leader-election event warning (`events` is not granted to the operator Role) is
retained as a least-privilege observability follow-up; it did not affect lease acquisition or the
qualification result.

## Cleanup and decision

The synthetic CR, Job, reader Pod, operator Deployment, ServiceAccount, Role, RoleBinding,
NetworkPolicies, v1alpha2 CRD, Lease, PVC, and backing PV were removed. The cluster readback shows
only the pre-existing `ct-review-action-dispatch` Deployment at `2/2`, with its image unchanged.

The next safe step is a manual, non-publishing provider qualification through the same DOKS
projection, starting with one deterministic fixture and a 15-minute hard stop. It must prove
100% terminal completion before review-quality comparison. Twenty samples per tier remain a
confidence gate before production activation, not a prerequisite for this next test. No provider
or production routing flip is authorized by this receipt-only result.
