# DOKS same-engine hosted parity — 2026-09-02

Status: the latest v1.24.0 known-defect comparison passed execution and verdict
parity; production activation remains disabled pending a separately approved
App-installation and required-check rollout.

This was a bounded set of manual, non-publishing qualification runs. It created
no schedule, recurring canary, traffic split, review comment, required check, or
production routing change. Every run retained the original 15-minute terminal
ceiling and `ACTION_DISPATCH_ALLOW_APP_GATE=false`.

## v1.24.0 fingerprinted known-defect follow-up

The v1.24.0 follow-up used `calltelemetry/ct-pr-operator-sandbox#5`, base
`01bb92b2294f5f9f77ae3e38a9a9672a5e9a8a2e`, head
`4faa73aaf995279db95ff537b149a2a35c7b901b`, and diff digest
`073cc4a9b4a34df110de96fc6c227f2ae23abaf3b6330dc647544b234cbfae58`.
The fixture contains a deliberate starts-with scope bypass at
`src/review-request.mjs:8`. The expected privacy-preserving anchor digest is
`6e3318591a38b875fba17892b6bd692e4aa6131f7271915458280904d6df0765`.

Both paths ran the exact v1.24.0 worker image:

`registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:af6297cd5ecd9241b8b3fa16af2f8d0913d159dfd22ed3b2b1d15585efb8f0e2`

The shared execution identity was:

- policy digest
  `7d517a7bffba5264c12699f2bf67b1a183522c69874ac7857f64499502494a81`;
- config digest
  `29f48968ca8617c1c8b5ff9b99bc75cf377f354d423e203cd495b0427ab8d371`;
- provider-topology digest
  `583bc1bd38ba0e1d83f0193648c6cad68359d563e77b312d828fe98b20f84f1a`;
  and
- eight direct `deepseek/deepseek-v4-flash-0731` lanes, each with one call and
  zero retries. No auto-router was used.

The manual DOKS run was
`ct-review-de2e54a52359606863c9dc06339670f5` /
`run_de2e54a52359606863c9dc06339670f5`:

- authenticated receipt to Job creation: 3 seconds;
- Pod scheduled: 5 seconds after receipt;
- image/process observed: 16 seconds after receipt;
- review-engine duration: 166.009 seconds;
- terminal completion: 186 seconds after receipt;
- calls/retries/optional failures: 8 / 0 / 0;
- GitHub reads/writes: 3 / 0;
- usage: 14,093 prompt / 9,383 completion / 23,476 total tokens;
- cost: `$0.00220593`;
- verdict/counts: `BLOCK`, P0 0, P1 4, P2 5; and
- the expected line-8 P1 anchor appeared three times.

The exact run Secret and receipt-inspector Pod were deleted immediately after
readback. The PR-scoped PVC recorded last use at `16:57:27Z`; the operator
deleted both the PVC and Lease at `17:29:28Z`, 32 minutes and 1 second later.
This observes the configured 30-minute idle retention plus reconciliation lag,
rather than relying only on manifest configuration.

The first comparable hosted run was
<https://github.com/calltelemetry/ct-review-actions/actions/runs/33658537502>:

- dispatch to review-engine start: 20 seconds;
- review-engine duration: 124.151 seconds;
- workflow completion: 148 seconds after dispatch;
- calls/retries/optional failures: 8 / 0 / 0;
- GitHub reads/writes: 3 / 0;
- usage: 14,497 prompt / 7,339 completion / 21,836 total tokens;
- cost: `$0.00268483`;
- verdict/counts: `BLOCK`, P0 0, P1 4, P2 5; and
- the expected line-8 P1 anchor appeared twice.

The v1.24.0 comparator accepted the two receipts as identical execution
identity and returned:

```json
{
  "comparable": true,
  "leftVerdict": "BLOCK",
  "rightVerdict": "BLOCK",
  "findingsDelta": 0,
  "severityDelta": {"P0": 0, "P1": 0, "P2": 0},
  "findingOverlap": {
    "anchor": {"matched": 5, "leftOnly": 4, "rightOnly": 4},
    "exact": {"matched": 0, "leftOnly": 9, "rightOnly": 9}
  }
}
```

The lack of exact content-digest matches records nondeterministic wording; it
does not erase the matching anchors, equal canonical severity distribution, or
shared blocking verdict. DOKS reached the engine four seconds faster in this
pair. Provider-generation variance dominated the total: the DOKS model panel
took 41.858 seconds longer.

The hosted harness landed through
<https://github.com/calltelemetry/ct-review-actions/pull/188>. A first dispatch,
<https://github.com/calltelemetry/ct-review-actions/actions/runs/33658368293>,
failed before Docker/provider execution because the temporary registry secrets
were absent. This was a harness credential-plumbing failure and produced no
receipt. After a short-lived read-only registry credential was installed, the
comparable run passed.

GitHub's token action then reported that numeric `app-id` was deprecated. The
official `client-id` migration landed through
<https://github.com/calltelemetry/ct-review-actions/pull/191>. Post-migration run
<https://github.com/calltelemetry/ct-review-actions/actions/runs/33659280689>
passed in 40 seconds dispatch-to-finish and 13.593 seconds inside the engine,
with 8 calls, zero retries, zero writes, `BLOCK`, and the same P0 0/P1 4/P2 5
distribution. It emitted no App-ID deprecation warning. The obsolete App-ID
repository secret and every short-lived registry credential were deleted; the
App client ID and source App configuration remain recoverable from Doppler.

This known-defect comparison clears the earlier verdict-variance blocker for
this fixture. It does not authorize fleet production activation. The App gate
remained false, the hosted Action remained authoritative, and the next rollout
requires separate approval plus clean- and larger-fixture evidence.

## Prior v1.23.0 baseline

## Exact execution identity

- Repository/PR: `calltelemetry/ct-review-actions#183`
- Base: `6bf3a84b4f7c26649faf640e0d21d9596b548a68`
- Head: `e6b0a418c4140555a8c2c1e59f6bf80ca23cfd9e`
- Diff digest: `95d8fef4ebc8f4c9cfb8b1d3da998d80d3a88c57aab65cb81c152d019a3d8ffb`
- Review Yeti release: `v1.23.0`, commit
  `c885dde208b38d8b0c3c01402e6ddace60ece31d`
- Worker:
  `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:002b8f1dd3070b1f8a8ca48738954fdcf2ed4cfcd2bed5607520fe7161e04a1b`
- Operator:
  `registry.digitalocean.com/calltelemetry/review-yeti-operator@sha256:a393ef864b51c7ba639e26c210fbf6207c434421cdde25b92878a66655872afb`
- Policy digest:
  `7d517a7bffba5264c12699f2bf67b1a183522c69874ac7857f64499502494a81`
- Config digest:
  `61f38a39543fa123c1f1730ab0b1a10875e3577a450d021794bda58e0a85c0aa`
- Provider-topology digest:
  `583bc1bd38ba0e1d83f0193648c6cad68359d563e77b312d828fe98b20f84f1a`
- Requested model: direct `deepseek/deepseek-v4-flash-0731`; no auto-router.

All six personas, moderator, and arbiter resolved to that same direct model in
the comparable pair. Each lane made one call and recorded zero lower-level
retries.

## Hosted qualification harness

The one-time hosted workflow landed through
`calltelemetry/ct-review-actions#183` (merge
`743444236adf18f639cd719b0ea7260ff225e327`). It is `workflow_dispatch` only,
read-only, non-publishing, digest-pinned, and capped at 15 minutes.

Initial run
<https://github.com/calltelemetry/ct-review-actions/actions/runs/33642757291>
failed in 13 seconds before a GitHub read or model call because the workflow
used `/workspace/receipt.json` instead of the worker's fail-closed canonical
path `/workspace/.review-yeti/receipt.json`. The regression repair landed
through `calltelemetry/ct-review-actions#184` (merge
`4d408600d73468d6ae6081537eaa5b011d425fbe`); post-merge validation passed in
30 seconds.

The first model-backed hosted attempt after the repair,
<https://github.com/calltelemetry/ct-review-actions/actions/runs/33643882034>,
failed closed after 241.166 seconds. It made nine calls. Five personas
completed normally; `testing` hit a 195.004-second total deadline and its two
fast retries returned invalid native JSON objects. Completed attempts reported
`$0.03035993`; the timed-out attempt had no usage/cost record, so this is a
lower bound. The failure receipt recorded three GitHub reads, zero writes, the
exact engine/topology identity, and no review content or credential.

The final hosted attempt,
<https://github.com/calltelemetry/ct-review-actions/actions/runs/33646032754>,
passed in 73 seconds end to end. Its panel took 52.698 seconds with eight calls,
zero retries, 63,167 tokens, and `$0.01392855`. It returned the canonical
`FIX_FIRST` verdict with P0 0, P1 0, and P2 7.

The short-lived read-only DigitalOcean registry credentials were deleted from
the GitHub repository immediately after each artifact was collected.

## DOKS qualification

The first manual DOKS attempt,
`ct-review-eeccfd86818b1935a30691384368bcbf`, exposed an operator procedure
error rather than a provider failure. Doppler output was requested with `--raw`
but without `--plain`, so the Secret contained a formatted table with Unicode
box-drawing characters. The OpenRouter SDK correctly refused to build an HTTP
header, the Job failed in 20 seconds, and OpenRouter was never reached. The run
Secret was deleted immediately. Future manual procedures must use
`--plain --raw`, strip trailing newlines, and validate ASCII plus the expected
credential prefix before Secret creation.

The corrected run was:

- Run: `run_868c45583e4e8b6bc26a8fd7f954184b`
- `PRReviewJob`: `ct-review-868c45583e4e8b6bc26a8fd7f954184b`
- Receipt to Job creation: 3 seconds
- Pod scheduling: 3 seconds
- Image/process observed: 11 seconds
- Panel duration: 23.025 seconds
- CR terminal: 37 seconds after authenticated receipt
- Calls/retries: 8 / 0
- GitHub reads/writes: 3 / 0
- Usage: 37,294 prompt / 14,415 completion / 51,709 total tokens
- Cost: `$0.01106255`
- Canonical verdict: `SHIP`
- Severity counts: P0 0, P1 0, P2 3

The Job used the exact worker image ID, zero backoff, no Kubernetes API token,
a read-only root filesystem, and the original 15-minute deadline. Its run
Secret contained exactly `GITHUB_READ_TOKEN` and `OPENROUTER_API_KEY`. The
Secret and hardened receipt-inspector Pods were deleted immediately after
readback. The PR-scoped PVC and Lease were left for the reviewed 1,800-second
same-PR reuse/expiry controller.

The Review Yeti App credential available to the Action-dispatch deployment
could not resolve an installation for `calltelemetry/ct-review-actions` and
GitHub returned 404. The manual qualification used the existing Multica App to
mint a repository-restricted read token. This is valid for the isolated proof,
but production activation must first establish the intended App installation
and ownership model for every participating repository.

## Fail-closed comparison and decision

The v1.23.0 comparator returned:

```json
{
  "comparable": true,
  "leftVerdict": "FIX_FIRST",
  "rightVerdict": "SHIP",
  "findingsDelta": -4,
  "severityDelta": {"P0": 0, "P1": 0, "P2": -4}
}
```

This proves that DOKS runs the same review engine and provider topology, not a
reduced substitute. It also shows that DOKS removed hosted setup latency and,
for this pair, completed the model panel 29.673 seconds faster at `$0.002866`
less reported provider cost.

It does not prove review-quality agreement. With identical execution identity,
the model produced four fewer P2 findings on DOKS and crossed the canonical
verdict boundary from `FIX_FIRST` to `SHIP`. The sanitized receipt does not
persist finding content, so the current evidence cannot distinguish matching
findings from duplicates or different anchors. Production required-check and
unresolved-thread authority therefore remain disabled.

The next safe enhancement is a bounded, non-content finding fingerprint in the
receipt followed by one manual known-fixture comparison. No recurring canary or
automatic production activation is authorized.

## Cleanup and production readback

No active `PRReviewJob` or worker Job remained after the comparison. Both new
run Secrets, all inspector Pods, and two older unreferenced manual
qualification Secrets were deleted by exact name. The deleted credentials are
recreatable from Doppler/the GitHub App and are not evidence stores. Terminal
custom resources remain as non-secret execution records.

Final production invariants remained unchanged:

- `ACTION_DISPATCH_ALLOW_APP_GATE=false`;
- `ct-review-action-dispatch` remained on
  `sha256:59f19384715ed75a587543687256bb807b3cc2044c0f67921fece27062b164e6`;
- `ct-review-job-dispatcher` remained on
  `sha256:db2d14e07cf28ac11ba46fa391934e26805fb175f9aa69180a194ff7e2342e54`;
- the operator remained healthy on `sha256:a393ef864b51c7ba639e26c210fbf6207c434421cdde25b92878a66655872afb`;
  and
- the hosted Action remained the production review authority.
