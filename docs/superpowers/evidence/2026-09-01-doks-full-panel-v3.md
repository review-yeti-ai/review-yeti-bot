# DOKS full-panel qualification v3 — 2026-09-01

Status: passed as one manual, non-publishing, operator-controlled DOKS run.
The complete six-persona panel, moderator, and arbiter finished through the
explicit OpenRouter DeepSeek route. No scheduled workload, GitHub write,
traffic split, or production Action routing change was created.

## Reviewed source and immutable runtime

- Source: `ea05dac5b1d50a2aaffefe739a00d0b424123499`
- Deadline fix: PR #397, `fix(doks): preserve full-panel deadline budget`
- Operator image:
  `registry.digitalocean.com/calltelemetry/review-yeti-operator@sha256:47d802d640f16e4619d712f660eae1b7ceb1afc5cec90b41fe7c879c9c8a301d`
- Worker image:
  `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:f89ae42380abc44ed52145eff2b774175b6d6ce98e0d3da2abc0cc27fe6892ad`
- Worker self-test runtime-manifest digest:
  `1cd51aa24e665019d40fe38fb61577dd0219de5afc8cdde3abce3eab41725558`
- Run: `run_ea05dac5b1d50a2aaffefe739a00d0b4`
- `PRReviewJob`: `ct-review-ea05dac5b1d50a2aaffefe739a00d0b4`

Both images were built from the exact merged source for `linux/amd64`, pushed
as immutable OCI indexes, and include provenance and SBOM attestations. The
worker passed its read-only container self-test before cluster use.

## Admission and deadline RCA

The first admission attempt failed safely before Job creation because the live
v1alpha2 CRD predated the reviewed `qualificationProfile` and
`qualificationModel` fields. The unused run Secret was deleted immediately.
The reviewed CRD diff was additive: the two optional fields and one fail-closed
pairing/non-auto validation. Applying it retained `v1alpha2` as the only stored
version and preserved the existing successful receipt-only object.

The second admission proved the PR #397 repair in the operator-generated Job:

| Contract | Observed |
| --- | --- |
| Original terminal window | 900 seconds |
| Kubernetes Job deadline | 838 seconds |
| Worker qualification deadline | 778,000 milliseconds |
| Worker-to-Job receipt reserve | 60 seconds |
| Job-to-terminal reserve | at least 60 seconds |
| Backoff limit | 0 |
| Service-account token | disabled |
| Publication mode | `disabled` |

Before PR #397, the operator omitted `REVIEW_QUALIFICATION_TIMEOUT_MS`, which
made this profile silently use the worker's 120-second default. The live Job
now derives its worker deadline from the authenticated remaining terminal
window and retains both receipt/finalization reserves.

## Result

| Field | Value |
| --- | --- |
| Status | `succeeded` |
| Requested/resolved model | `deepseek/deepseek-v4-flash-0731` |
| Provider calls | 8 |
| Personas | 6/6 |
| Optional failures | 0 |
| Findings | 9 |
| Quorum | `true` |
| Arbiter verdict | `SHIP` |
| Usage | 11,894 prompt / 5,827 completion / 17,721 total tokens |
| Cost | `$0.00329672` |
| Panel duration | 42.335 seconds |
| GitHub writes | 0 |
| Result digest | `0aae27e4a0e5fd3b79cabba8d5e30564338da8d6892b459573b4a99cf43a0d02` |

The requested model resolved directly, so this run did not consume the GLM
fallback. All eight expected first-attempt calls completed; no correction or
transport retry was required.

## DOKS timing

| Stage | UTC timestamp | From receipt |
| --- | --- | ---: |
| Authenticated receipt | `2026-09-02T01:09:35Z` | 0s |
| Job created | `2026-09-02T01:09:36Z` | 1s |
| Pod scheduled | `2026-09-02T01:09:38Z` | 3s |
| Process started | `2026-09-02T01:09:46Z` | 11s |
| Panel started | `2026-09-02T01:09:47.449Z` | 12.449s |
| Panel completed | `2026-09-02T01:10:29.784Z` | 54.784s |
| CR completed | `2026-09-02T01:10:32Z` | 57s |

The worker ran on `workers-memory-8gb-3qb9f1`, used the exact pinned image,
exited 0, and had zero restarts.

## Cleanup and production readback

The receipt inspector Pod and run-scoped OpenRouter Secret were deleted by
exact identity. The 1 GiB PR-scoped PVC was released with
`review-yeti.ai/last-used-at=2026-09-02T01:10:32.838453864Z`; its separately
reviewed idle-reclamation contract is 1,800 seconds so it can be reused by the
same PR during that window.

After the run:

- `ACTION_DISPATCH_ALLOW_APP_GATE=false`;
- `ct-review-action-dispatch` remained on
  `sha256:59f19384715ed75a587543687256bb807b3cc2044c0f67921fece27062b164e6`;
- `ct-review-job-dispatcher` remained on
  `sha256:db2d14e07cf28ac11ba46fa391934e26805fb175f9aa69180a194ff7e2342e54`;
- only the isolated operator advanced to the reviewed PR #397 digest; and
- the central GitHub Action remained the production review authority.

## Gate interpretation

This run satisfies the DOKS full-engine terminal-reliability gate for the
deterministic qualification fixture. It does not yet prove review-quality
parity on a real PR, GitHub publication, required-check enforcement, unresolved
thread blocking, or production routing. The next safe gate is one manual,
non-publishing same-head comparison between DOKS and the hosted Action. No
scheduled canary or automatic traffic split is authorized.
