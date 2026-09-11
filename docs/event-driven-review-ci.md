# Event-driven review CI admission

Source-only, opt-in controller. This does not enable a workflow, change branch
protection, replace existing validation, or prove deployed acceptance.

## Identity and ownership

Review eligibility and author readiness are independent. A successful review
on a draft is retained; expensive CI requires the current open, non-draft PR.
The service owns the review attempt, one validation UUID, dispatch outbox,
execution claim and `Review Yeti CI` check. Event payloads carry coordinates,
never a verdict, executable ref, provider setting, URL or check ID authority.

H is the reviewed PR head. B is its current target-branch tip. C is the
synthetic merge candidate with ordered parents B/H. W is the independently
allowlisted workflow revision. A workflow running at W and checking out C
does not make its ambient Actions check evidence for H. The service publishes
the bound App check on H only after trusted run/job readback proves the
configured required jobs all succeeded for the admitted C/W/run/attempt.

The GitHub reader checks the named base branch independently before and after
reading C. A PR response whose base SHA lags the branch tip fails closed.
Admission, execution claim and terminal publication repeat current
PR/base/head/policy/Gate/C verification under the shared PR admission lock.

## Durable transitions

- A merge-eligible review completion and its CI request/outbox intent commit
  together. Failed transactions expose neither half; duplicate completion does
  not create another request.
- The coordinate-only `review-yeti-ci-request` event wakes the base-owned
  receiver. The existing service sweep also reconciles durable work; no CI
  runner is allocated to wait for a review.
- Before a workflow dispatch or expensive execution claim, the same intended
  App's persisted pending CI check must be bound and externally published.
- The configured workflow receives only `requestId` and `epoch`, with run name
  `review-yeti-ci:<UUID>:<epoch>`. Dedicated GitHub OIDC and exact run readback
  fence the actual claiming run/attempt.
- Lost dispatch acknowledgements enter reconciliation. An empty run listing
  does not prove a POST failed. Bounded recovery fences the old delivery epoch
  before another dispatch; at most one execution can claim the expensive work.
  This does not promise exactly one GitHub workflow object.
- A claimed execution is not restarted merely because a lease expires.
  Completion reads actual run/jobs, not artifacts or callback conclusions.
  Failed, skipped, missing or stale required jobs cannot publish success.
- Check creation has one committed intent. Unknown creation outcomes reconcile
  by exact App/identity; no duplicate POST is authorized by missing readback.

## Disabled-by-default deployment inputs

The authoritative review controller and its existing finite repository
enrollment are prerequisites. CI uses the same intended App, with separately
minted, repository-scoped permissions for read, repository dispatch, workflow
dispatch and check publication. Candidate jobs receive none of those tokens.

| Variable | Contract |
| --- | --- |
| `REVIEW_CI_ENABLED` | Absent/`false` installs no CI router or sweep. Only exact `true` opts in. |
| `REVIEW_CI_ADMISSION_ENABLED` | Defaults false; pauses new admission while existing work drains. |
| `REVIEW_CI_REPOSITORY_DISPATCH_ENABLED` | Defaults false; must be true before new admission is enabled. |
| `REVIEW_CI_REPOSITORIES` | Strict JSON, at most 100 unique enrolled repositories and 128 KiB. |
| `REVIEW_CI_TICK_MS` | Existing-service sweep interval, default 5000; inclusive bounds 1000–60000. |

Each repository record contains numeric repository/owner IDs, owner/name,
separate relay and validation workflow ID/path/ref/SHA tuples, and a digested
lane plan with exact required job names. No wildcard or mutable-latest trust
fallback exists. Dispatch uses a configured named branch/tag and verifies W;
advancing the workflow ref requires a reviewed allowlist update.

`POST /api/dispatch/ci/event` accepts only the nine-field
`review-yeti-ci-request.v1` or UUID-only `review-yeti-ci-wake.v1` hint.
`POST /api/dispatch/ci/claim` accepts only `{requestId, epoch}`. Both require
the separate `review-yeti-ci-control` audience and exact role-specific workflow
tuple. Direct workflows only: reusable caller/callee substitution is rejected.
Malformed requests return 400, missing/unauthorized identity 401/403, stale
claim 409, and recoverable control errors a redacted 503. HTTP acknowledgement
alone is never acceptance evidence.

## Rollout and rollback boundary

Land source with switches off. Prove the configured consumer's full validation
coverage, trusted dependency preparation, credential-free candidate execution,
exact-head App publication and replay/failure paths before activation. Draft
request/rerequest lifecycle and merge-group handling are subsequent integrated
contracts, not capabilities claimed by this source slice.

Pause new admission first during rollback; keep controller reconciliation and
publication running for already admitted work. Do not erase durable claims,
forge completion, or remove a required check to resolve a failing run. Consumer
flags can stop new job execution, but are not substitutes for service draining.
Private dependency pins and the manual-only nightly full suite are unchanged.
