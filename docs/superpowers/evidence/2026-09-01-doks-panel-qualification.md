# DOKS panel qualification — 2026-09-01

Status: passed as one manual, non-publishing DOKS Job. This proves that the
real persona, moderator, and arbiter path can complete through OpenRouter from
the DOKS worker image. It does not qualify review recall, false-positive rate,
or production routing.

## Qualification contract

- Job: `ct-review-panel-qual-c1c04461`
- Run: `run_19a807082999a1512dd7e9ba7488e0eb`
- Worker image: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:7c9a3a915e16aceba2e52bb97bc03ebb2589a3adc9610b2edf3d3cb01d0d3249`
- Requested/resolved model: `deepseek/deepseek-v4-flash-0731`
- Worker qualification deadline: 600 seconds (10 minutes)
- Kubernetes Job deadline: 840 seconds (14 minutes)
- Publication mode: `disabled`
- GitHub writes: `0`
- Service-account token: disabled

## Result

The Job completed successfully. The worker receipt persisted at
`/workspace/.review-yeti/receipt.json` and contained no raw provider response
or credential.

| Field | Value |
| --- | --- |
| Provider calls | 5 |
| Persona count | 1 |
| Findings count | 0 |
| Quorum | `true` |
| Arbiter verdict | `SHIP` |
| Panel duration | 52.273s |
| Usage | 4,717 prompt / 1,026 completion / 5,743 total tokens |
| Cost | `$0.0005527215719999999` |
| Result digest | `05181e139ed1ef9d47b9d6f14e5dc451296e32e1ff6b107a971f3ac6511340ae` |

The worker log reported completion at `2026-09-01T04:25:09.633Z`; the
Kubernetes Job reached `Complete` at `2026-09-01T04:25:12Z`.

## Failure and threshold RCA

Two earlier manual panel attempts used shorter internal deadlines:

1. A 2-minute total deadline produced a 30-second per-call limit and failed
   closed when the arbiter stream exceeded 29.402 seconds.
2. A 4-minute total deadline completed transport but failed closed because the
   model's final response did not contain the required nonce fence.

A separate one-call provider qualification completed in 5.072 seconds with
`providerCalls: 1`, proving that DOKS networking, the OpenRouter key, and the
streaming transport were healthy. The successful 10-minute panel run then
completed all five calls, distinguishing the shorter-threshold and
structured-output failures from a connectivity outage.

## Cleanup and production readback

The qualification Job, Pod, PVC, and run-scoped Secret were deleted by exact
name after the receipt was inspected. No scheduled workload or traffic split
was created. The live production readback remained:

- `ct-review-action-dispatch`: 2/2 Ready, image digest unchanged at
  `sha256:59f19384715ed75a587543687256bb807b3cc2044c0f67921fece27062b164e6`
- `ct-review-job-dispatcher`: 1/1 Ready
- `ct-review-yeti-operator`: 1/1 Ready
- `ACTION_DISPATCH_ALLOW_APP_GATE=false`

This result is a DOKS execution/transport qualification only. It is not an
approval to flip production reviews or to claim quality parity with another
provider.
