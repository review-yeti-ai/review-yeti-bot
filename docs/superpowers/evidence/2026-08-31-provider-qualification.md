# Provider qualification — 2026-08-31

Status: passed as a manual, non-publishing DOKS Job. This proves one real
OpenRouter streamed transport through the worker image; it does not qualify review recall,
false-positive rate, panel arbitration, or production routing.

## Landed contract

- PR #344 merged at `57d2d1e1a52a432196298d8ccc276dd0a30dd0a2`.
- Worker image: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:64afa61b06e33c42239267cc1512f87eb6893dc9ae29d134396f6827d388f23b`.
- The worker uses `REVIEW_PROVIDER_QUALIFICATION_ONLY=true`, requires
  `REVIEW_PUBLICATION_MODE=disabled`, rejects `openrouter/auto`, and makes exactly one
  bounded `stream: true` request. Invalid mode combinations fail closed instead of falling
  through to live review.
- The receipt is secret-free and contains only run identity, requested/resolved model,
  response digest/length, usage, cost, and timestamps.

## Manual DOKS result

Job: `ct-review-provider-qual-66f4661c`

| Field | Value |
| --- | --- |
| Run | `run_66666666666666666666666666666666` |
| Provider | `openrouter` |
| Requested/resolved model | `deepseek/deepseek-v4-flash-0731` |
| Worker terminal state | `Complete` (`1/1`) |
| Provider duration | 4.327s (`20:25:08.220Z` → `20:25:12.547Z`) |
| Response | non-empty, 16 characters |
| Usage | 34 prompt / 34 completion / 68 total tokens |
| Cost | `$0.00000833` |
| Provider calls | `1` |
| GitHub writes | `0` |
| Publication mode | `disabled` |
| Response digest | `5fc83f8c6410457b15d9cb29240956999e9e3fbe3b62e75ace4bc8811f889c56` |

The worker’s log emitted the `ReviewYetiProviderQualification.v1` receipt before the Pod
terminated. No raw response text or credential appeared in the receipt.

## Failure found and corrected during qualification

The first manual Job (`run_444…`) failed before the provider call with a `DashboardStore`
stack overflow because the one-off manifest omitted the writable `/tmp` `emptyDir` required by
the worker’s read-only-root filesystem. The normal operator Job contract already mounts `/tmp`.
The corrected Job (`run_555…`) completed successfully; a final evidence rerun (`run_666…`)
also mounted `/tmp` and captured the sanitized receipt. This was a manifest/runtime setup
defect, not an OpenRouter timeout.

## Cleanup and production readback

The qualification Jobs and temporary OpenRouter Secret were deleted by exact name. The final
`ct-review-system` readback contained only the pre-existing `ct-review-action-dispatch`
Deployment and its two Pods. Its image remained:

`registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:59f19384715ed75a587543687256bb807b3cc2044c0f67921fece27062b164e6`

No operator Deployment, CRD, PVC, Lease, scheduled canary, traffic split, provider policy, or
production review route was changed.

## Decision

The transport slice is ready for a later manual fixture-backed panel qualification. Keep
production routing unchanged until that separate test proves panel behavior and publication
gates. Do not infer quality parity from this connectivity receipt.
