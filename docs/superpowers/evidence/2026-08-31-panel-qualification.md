# Panel qualification — 2026-08-31

Status: passed as one manual, non-publishing DOKS qualification after a bounded
structured-output correction fix. This proves the real persona, moderator, and arbiter
pipeline can complete through the selected OpenRouter model; it does not qualify review
recall, false-positive rate, or production routing.

## Landed contract

- PR #346 merged at `c2e8ca676eac9ed1189f4e858c7dcf6c5a4236af`.
- PR #347 merged at `06746910a36ccbb31fd58b8ee434d9ec042c7eea`.
- Worker image:
  `registry.digitalocean.com/review-yeti/review-yeti-worker@sha256:7c9a3a915e16aceba2e52bb97bc03ebb2589a3adc9610b2edf3d3cb01d0d3249`.
- The panel path now requires actual top-level role fields rather than accepting a fenced copy
  of the request's `outputSchema`. It permits one corrective turn and then fails closed.
- The qualification fixture reserves two persona turns so that correction remains bounded.

## Manual DOKS result

Job: `ct-review-panel-qual-70f1e65`

| Field | Value |
| --- | --- |
| Run | `run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| Provider | `openrouter` |
| Requested/resolved model | `deepseek/deepseek-v4-flash-0731` |
| Worker terminal state | `Complete` (`1/1`) |
| Panel duration | 35.152s (`21:54:14.112Z` → `21:54:49.264Z`) |
| Provider calls | `5` (persona correction, persona result, moderator, arbiter correction, arbiter result) |
| Persona count | `1` |
| Findings count | `0` |
| Quorum | `satisfied=true` |
| Arbiter verdict | `SHIP` |
| Usage | 4,859 prompt / 985 completion / 5,844 total tokens |
| Cost | `$0.000466614` |
| GitHub writes | `0` |
| Publication mode | `disabled` |
| Result digest | `b1ace9efa9736aea3f9c9bb4313d446b846af246f58b8c187823facef1c460c0` |

The receipt contained only aggregate identity, model, counts, verdict, timing, usage, cost,
and a digest. It contained no finding body, raw provider response, or credential.

## RCA and bounded recovery

The first qualification against the panel contract reached OpenRouter successfully but the
DeepSeek response copied the fenced prompt and put the proposed verdict under `outputSchema`.
The worker correctly failed closed because no top-level verdict existed. The isolated diagnostic
confirmed the same shape for the persona response. PR #347 added explicit role validation,
instructional correction, and a one-attempt cap. The corrected qualification completed with
the same exact model and image digest above.

## Cleanup and production readback

The qualification Job, Pod, and run-scoped OpenRouter Secret were deleted by exact name. No
qualification Jobs, Pods, Secrets, PVCs, Leases, operator Deployment, scheduled canary, traffic
split, provider policy, or GitHub publication was left behind. `ct-review-system` contains only
the pre-existing `ct-review-action-dispatch` Deployment and its two Pods:

`registry.digitalocean.com/review-yeti/ct-review-bot@sha256:59f19384715ed75a587543687256bb807b3cc2044c0f67921fece27062b164e6`

## Decision

The bounded panel transport/format path is ready for fixture-quality comparison. Keep production
routing unchanged until separate quality evidence is reviewed. This one successful run is not
an approval to cut over OpenRouter or to claim parity with another provider.
