# DOKS worker timing qualification — 2026-08-31

Status: receipt-only qualification evidence. No provider request, GitHub write, review publication, traffic split, or scheduled canary was used.

## Comparison baseline

The hosted `calltelemetry/ct-review-actions` `Review Yeti` workflow was measured over the latest 50 runs. Of those, 45 were terminal runs excluding skipped and cancelled conclusions.

| Path | Sample | p50 | p95 | Maximum | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Hosted Action runner occupancy | 45 | 213s | 352s | 374s | `startedAt` → `updatedAt` |
| Hosted Action creation → finish | 45 | 227s | 357s | 1,208s | includes GitHub runner queue time |
| DOKS receipt-only, new PVC | 1 | 14.1s | n/a | 14.1s | receipt timestamp; image already present on node |
| DOKS receipt-only, reused PVC | 1 | 11.5s | n/a | 11.5s | receipt timestamp; image already present on node |

The hosted sample had 39 successes, 6 failures, 2 skips, and 3 cancellations. The two largest queue delays were 259s and 930s; those are not worker execution time.

## DOKS samples

Both samples used the immutable worker image:

`registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:20a224b38ee0ee0c2323032735a9062fa27470afe2337a4eb21c0f3025bbe6e4`

The image self-test passed on Node `24.20.0`. The operator was run locally with the explicit enable flag against the existing `ct-review-system` namespace; the deployment remained absent. The CRD was installed only to exercise the versioned controller and the qualification objects were deleted afterward.

### New PVC (`run_...a4`)

- receipt accepted: `2026-08-31T17:00:01.151Z`
- Job created/status start: `17:00:02Z`
- pod scheduled: `17:00:04.506Z`
- PVC attach succeeded: `17:00:08Z`
- container started: `17:00:14Z`
- receipt log: `17:00:15.277Z`
- ReviewJob terminal: `17:00:18Z`, `Succeeded`
- receipt-to-container start: approximately `12.8s`
- receipt-to-worker receipt: approximately `14.1s`
- receipt-to-terminal status: approximately `16.8s`

### Reused PVC (`run_...a5`)

- same PVC UID: `1a421214-65a2-4134-b564-069d4fdfa24c`
- receipt accepted: `2026-08-31T17:01:05.115Z`
- Job created/status start: `17:01:05Z`
- pod scheduled: `17:01:05.930Z`
- PVC attach succeeded: `17:01:10Z`
- container started: `17:01:15Z`
- receipt log: `17:01:16.624Z`
- ReviewJob terminal: `17:01:19Z`, `Succeeded`
- receipt-to-container start: approximately `9.9s`
- receipt-to-worker receipt: approximately `11.5s`
- receipt-to-terminal status: approximately `13.9s`

The backing `do-block-storage` volume was 1 GiB with reclaim policy `Delete`; it was removed during cleanup. No qualification object, Job, pod, PVC, Lease, or versioned CRD remains. The worker/operator route is therefore back to its pre-qualification disabled state.

## Failures found and corrected

1. The first image could not start because Kubernetes could not verify symbolic `USER node` with `runAsNonRoot=true`. The worker image now uses numeric `USER 1000:1000`.
2. The first corrected image still failed to write the receipt because the generated pod lacked `fsGroup`. The Job builder now sets numeric user/group 1000, `fsGroup: 1000`, and `fsGroupChangePolicy: OnRootMismatch`.

Both defects were caught before any provider or GitHub operation. Focused tests, the full Go operator suite, race checks, and `go vet` pass.

## Interpretation and next gate

These are one-sample timing observations, not p95 claims. The warm/reused sample is faster than the hosted Action by roughly 20×, but its approximately 9.9s receipt-to-process-start span misses the design target of 5s for the warm/reused tier. New-PVC startup is approximately 12.8s to process start, below the 20s warm/new-workspace target in this run.

The next safe change is stage-level durable receipts and an isolated operator/dispatcher deployment boundary. Do not activate DOKS review traffic or provider calls until at least 20 samples per tier are collected and the 15-minute terminal, correctness, publication, and cleanup gates pass.
