# DOKS dispatcher, worker, and workspace qualification — 2026-09-01

Status: the manual Action admission path and the DOKS worker path both
completed without publication. A lifecycle defect was found and fixed: the
deployed v1alpha2 operator recorded `last-used-at` but did not invoke the
existing guarded workspace collector after a terminal review, and its Role
omitted the two delete verbs required by that collector. The fix is covered by
regression tests and is live in the operator-only deployment; the production
Action deployment remains unchanged.

## Manual Action admission

- Workflow run: [33471161856](https://github.com/review-yeti-ai/ct-pr-operator-sandbox/actions/runs/33471161856)
- Trigger: one operator-approved `workflow_dispatch`; no schedule or canary
- Mode: `execution-backend=doks`, `publish-mode=disabled`
- Result: success in 25 seconds
- First admission: `DISPATCHED/PENDING/false`
- Identical retry: `DISPATCHED/PENDING/false`

The durable store recorded the second delivery against the existing immutable
run instead of creating a second run or CR. This confirms the idempotency
boundary. The admission request does not invoke a provider or write to GitHub.

## Dispatcher and operator lifecycle receipt

The admitted run was projected by the live dispatcher and completed through the
v1alpha2 operator as a receipt-only worker:

| Stage | UTC |
| --- | --- |
| Received | 03:36:56.291 |
| CR/job projection | 03:36:57 |
| Pod scheduled | 03:36:58 |
| Image/process observed | 03:37:06 |
| Completed | 03:37:09 |

This is approximately 0.7 seconds to projection, 1.7 seconds to scheduling,
9.7 seconds to process start, and 12.7 seconds from receipt to completion.
The receipt-only run made zero provider calls and zero GitHub writes. Its
workspace PVC was intentionally retained for same-PR reuse, which exposed the
missing idle-collector invocation described above.

## DOKS panel worker

A separate manual panel Job exercised the persona, moderator, and arbiter
engine from DOKS using OpenRouter GLM:

- Job: `ct-review-panel-qual-f8fdedd1`
- Run: `run_88f32348b540f67e3dc4fc02099b20fa`
- Worker image: `registry.digitalocean.com/review-yeti/review-yeti-worker@sha256:64a2dbd9e5e620ab279ca79d56821e414dd2c70a4155b0ca89829f6751b748d5`
- Requested/resolved model: `z-ai/glm-5.3-flash`
- Result: `SHIP`, quorum satisfied, zero GitHub writes, publication disabled
- Provider calls: 5
- Usage: 4,821 prompt / 381 completion / 5,202 total tokens
- Provider cost: `$0.000395385`
- Panel duration: 133.350 seconds

This qualifies the DOKS execution and transport path only. It does not claim
quality parity or authorize a production routing change.

## Cleanup finding and safe next step

The production deployments were unchanged during this work:

- `ct-review-action-dispatch`: 2/2 Ready, image digest unchanged
- `ct-review-job-dispatcher`: 1/1 Ready
- `ct-review-yeti-operator`: 1/1 Ready at `sha256:c976628f6afa0cdbe8907c806557b2677c92f44d206f8d6f81b6cfec3a226f09`
- `ACTION_DISPATCH_ALLOW_APP_GATE=false`

After the Role patch and operator rollout, the previously stuck workspace
entered deletion and both the PVC and reclamation Lease disappeared. The CR
remained `Succeeded` with its original timing receipt. No unrelated PV for the
claim remained. No scheduled workload, traffic split, or production
publication is part of this qualification.
