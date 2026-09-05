# DOKS same-head qualification — 2026-09-02

Status: transport reliability and canonical fail-closed semantics passed;
production quality parity and activation remain blocked.

This was one manual, event-free, non-publishing comparison. It created no
schedule, recurring canary, traffic split, dispatcher change, or GitHub write.
The production App gate remained `false` throughout.

## Exact review target and hosted baseline

- Repository/PR: `review-yeti-ai/ct-pr-operator-sandbox#5`
- Base: `01bb92b2294f5f9f77ae3e38a9a9672a5e9a8a2e`
- Head: `4faa73aaf995279db95ff537b149a2a35c7b901b`
- Full diff digest:
  `073cc4a9b4a34df110de96fc6c227f2ae23abaf3b6330dc647544b234cbfae58`
- Hosted run:
  <https://github.com/review-yeti-ai/ct-pr-operator-sandbox/actions/runs/33584627620>
- Central Action source: `review-yeti-ai/review-yeti-actions@2edadbd3d1fb1dac1ac1778ea4d75c278086a343`

The hosted run completed all six personas. It returned `FIX_FIRST` with one
anchored P1 finding for the intentionally vulnerable repository-prefix check.
Four lanes used OpenRouter DeepSeek and two used Synthetic GLM. All six lanes
terminated; the OpenRouter testing lane recovered once from malformed output.
The Action panel took 71.074 seconds. The complete GitHub job ran from
`02:49:00Z` to `02:52:05Z`. Reported OpenRouter cost was `$0.00223168`;
Synthetic cost was unavailable, so that number is a lower bound.

## Additive capability and releases

- Same-head capability and operator admission: PR #401, released as `v1.22.0`.
- Operator idempotency/fail-stop repair: PR #403, released as `v1.22.1`.
- Production canonical-verdict and high-effort parity: PR #405, merge
  `12e0f40031d95efae09a5909a5d8c805a4ec2820`.
- Reviewed release PR #406: `v1.22.2`, exact release commit
  `9df7e5c0c0b98c018e82c3405d9d3867630266f0`.
- Release/benchmark run:
  <https://github.com/review-yeti-ai/review-yeti-bot/actions/runs/33589016864>
  passed in 11m24s; rolling `v1` was then promoted to the same commit.

The first live same-head attempt exposed an operator matcher bug and failed
closed before acceptance. PR #403 taught reconciliation the same-head Secret
and environment contract, stopped an owned mismatched Job, and retained the
workspace lease until the Pod was actually terminal.

The first successful transport proof on `v1.22.1` completed in 90 seconds
receipt-to-terminal and 78.623 seconds panel time, but its receipt persisted the
model arbiter's raw `SHIP` despite ten findings. PR #405 fixed that real semantic
bug by applying the same canonical production verdict policy used by the App,
recording aggregate P0/P1/P2 counts, and running same-head review at high effort.
The deterministic synthetic full-panel profile remains low effort.

## Exact `v1.22.2` runtime

- Operator (unchanged from the reviewed `v1.22.1` repair):
  `registry.digitalocean.com/review-yeti/review-yeti-operator@sha256:45303cb84606b9826665ee12a9acb8203a4afded71f4e6eb73982107e2fb5623`
- Worker OCI index:
  `registry.digitalocean.com/review-yeti/review-yeti-worker@sha256:2772f6b042dc373704bd6d65daab0d5a5e4eff94f088a5073549d678273c99aa`
- Worker amd64 manifest:
  `sha256:84ab2fbe01cbf637ff29169bfb74dfcc00e4afa10f2b1a675f6eb37217022973`
- Attestation manifest:
  `sha256:387ed118c760e57002802646d3dd13d598bc704e861311e7db89ab6b38544a36`
- Worker self-test runtime digest:
  `b1dc54751091f770e1ff2751cf72826fd87be0b276726af927c7f7e68e2a86fa`
- Self-test Node runtime: `24.20.0`

The worker was built from the exact release commit for `linux/amd64` with SBOM
and provenance. Its read-only, credential-free self-test passed before use.

## Final manual DOKS result

- Run: `run_9df7e5c0c0b98c018e82c3405d9d3867`
- `PRReviewJob`: `ct-review-9df7e5c0c0b98c018e82c3405d9d3867`
- Profile: `same-head`
- Provider/model: OpenRouter / `deepseek/deepseek-v4-flash-0731`
- Requested model resolved directly; no auto-router and no GLM fallback was used.
- Provider calls: 8, the exact six-persona plus moderator/arbiter minimum; no
  correction or extra panel call was required. The aggregate receipt does not
  expose lower-level SDK/provider retry telemetry.
- GitHub reads/writes: 3 / 0
- Personas: 6/6; optional failures: 0; quorum: true
- Canonical verdict: `BLOCK`
- Canonical counts: P0 0, P1 4, P2 7, total 11
- Usage: 14,111 prompt / 9,595 completion / 23,706 total tokens
- Cost: `$0.00266189`
- Result digest:
  `14c74f909b05f81913c2a1f968fbd05b6013f2babe4da55f0582a46652e1c007`

The receipt contained no diff, prompt, response, finding text, token, private
key, or authenticated URL. It explicitly recorded
`verdictSource: canonical-production-policy`.

## DOKS timing and safety contract

| Stage | UTC | From receipt |
| --- | --- | ---: |
| Authenticated receipt | `04:10:59Z` | 0s |
| Job created | `04:11:00Z` | 1s |
| Pod scheduled | `04:11:01Z` | 2s |
| Image/process observed | `04:11:10Z` | 11s |
| Panel started | `04:11:11.288Z` | 12.288s |
| Panel completed | `04:13:57.145Z` | 178.145s |
| CR terminal | `04:13:59Z` | 180s |

The generated Job had an 838-second Kubernetes deadline, 778-second internal
deadline, zero backoff, five-minute TTL, no service-account token, and an exact
worker digest. The run Secret contained only `GITHUB_READ_TOKEN` and
`OPENROUTER_API_KEY`; it and the hardened read-only inspector were deleted
immediately after terminal readback.

## Comparison and activation decision

| Evidence | Engine/provider topology | Panel time | Verdict | Findings | Known cost |
| --- | --- | ---: | --- | ---: | ---: |
| Hosted Action | central Action; 4 OpenRouter + 2 Synthetic | 71.074s | `FIX_FIRST` | 1 P1 | at least `$0.00223168` |
| DOKS `v1.22.1` transport proof | bot engine; 9/9 calls OpenRouter | 78.623s | raw `SHIP` | 10 aggregate | `$0.00386755` |
| DOKS `v1.22.2` canonical/high | bot engine; 8/8 calls OpenRouter | 165.857s | `BLOCK` | 4 P1 + 7 P2 | `$0.00266189` |

The hosted 2-vCPU Blacksmith job ran for 185 seconds end to end. It spent about
111 seconds reaching panel dispatch, then about 71 seconds in model review. DOKS
reached the worker process in 11 seconds and panel execution in 12.288 seconds,
but its different OpenRouter-only bot engine spent 165.857 seconds in review.
The total wall clocks were therefore similar (185 seconds hosted versus 180
seconds DOKS), with DOKS removing setup latency but not yet matching panel
latency.

The DOKS worker requests 500m CPU and 768 MiB memory and caps at one CPU and
1,536 MiB. For its roughly 169-second process lifetime, that is a reservation
envelope of about 0.0235 vCPU-hours and 0.0352 GiB-hours, with a limit envelope
of 0.0469 vCPU-hours and 0.0704 GiB-hours. The hosted 2-vCPU job represented
about 0.1028 vCPU-hours of runner capacity. These are capacity-time comparisons,
not measured CPU utilization or invoice totals; DOKS only saves incremental
money when the existing cluster has spare capacity.

The final run proves actual OpenRouter terminal reliability: all eight outer
calls terminated successfully without an extra panel/correction call, the
requested model resolved directly, exact-head GitHub reads were stable, and the
complete workload finished in three minutes. It also proves that DOKS no longer
converts findings into an unsafe green receipt.

It does **not** prove production review-quality parity. The hosted baseline and
DOKS run use different review engines and provider distributions. Both use high
reasoning effort, so effort is not the source of the verdict delta. The DOKS
result is safely stricter, but enabling it as a required production check could
over-block pull requests. Production activation therefore remains off. The next
quality gate must compare the same engine, persona assignment, and provider
policy on both execution substrates before any required-check or unresolved-
thread authority is enabled.

## Cleanup and production readback

The previous run's PVC and Lease were observed deleted after the 1,800-second
idle window. The final run repeated that proof: its last-use timestamp was
`04:13:59.744906805Z`, and at `04:44:01Z` both
`ct-review-ws-5-ad3fa646bc9504612787` and
`ct-review-lease-5-ad3fa646bc9504612787` were absent without manual deletion.
The run Secret and inspector were deleted immediately after receipt readback;
the worker Job and Pod disappeared through their five-minute TTL. The succeeded
`PRReviewJob` remains as the non-secret terminal record.

Final live readback retained all production invariants:

- `ACTION_DISPATCH_ALLOW_APP_GATE=false`;
- `ct-review-action-dispatch` remained on
  `sha256:59f19384715ed75a587543687256bb807b3cc2044c0f67921fece27062b164e6`;
- `ct-review-job-dispatcher` remained on
  `sha256:db2d14e07cf28ac11ba46fa391934e26805fb175f9aa69180a194ff7e2342e54`;
- the operator remained healthy on its reviewed immutable digest; and
- the hosted Action remained the production review authority.
