# Service-owned review gates

Status: additive implementation in progress for API-3210, not deployed acceptance.
PostgresStore installs additive schema; the dedicated dispatch service can run
the new controller only under explicit configuration. Controller and new-review
admission both default off. No required checks, author readiness, provider policy
or CI triggers are changed. The worker still owns the separate raw `Review Yeti`
findings check; only the service owns `Review Yeti Gate`.

## Ownership and identity

The service, not a worker or workflow payload, owns `Review Yeti Gate`.
`reviewGateClient.ts` requires an explicitly configured App ID and a
repository-scoped installation token. One immutable external ID binds numeric
repository ID, owner/name, PR, base/head, effective policy digest, run ID,
independent review generation and execution attempt. An identically named
check from another App or attempt is not authority.

`reviewGatePolicy.ts` separates review eligibility from author readiness.
A reviewed draft remains a draft; only a later admission transaction may
combine current readiness with eligible exact-candidate evidence. Findings,
incomplete coverage/quorum, provider failure and missing evidence do not pass.
The narrowly permitted human accepted-risk case retains actor, permission,
event and after-review timing evidence. A central exemption needs its own
exact-candidate audit; zero executed lanes alone cannot imply success.

## Durable publication

`reviewGateRepository.ts` uses the existing admission's repository/PR advisory
lock and an additive `review_gate_attempts` table. Review generation is distinct
from execution attempt: a failure before worker projection can advance the
review generation without advancing the execution counter.

1. Reserve an immutable attempt and supersede the older gate atomically.
2. Commit a unique publication claim before external work. A separate UUID
   lease token prevents an expired claim from becoming valid when the same
   service identity reacquires the work.
3. Only a `reserved` to `creating` claim may create a pending check. If client
   preparation fails before any check operation, a fenced recovery under the
   same PR lock restores `reserved` with backoff. Once creation is invoked,
   even a timeout or lost acknowledgement never restores create permission.
   Every later uncertain claim without a persisted check ID reconciles exact App and
   external identity. An empty read after a lost acknowledgement never buys
   another POST.
4. Verify the returned check identity and desired state, then persist its ID
   and published version while the same lease is still current.
5. Later publication addresses only that stored check ID. Missing, malformed,
   conflicting or duplicate identities fail closed; no alternate check is
   created to hide a failure.

Unclaimed reserved attempts that are superseded are cancelled locally without
creating an obsolete check. Already attempted or bound publications retain
their cancellation intent for reconciliation. Network errors retain durable,
redacted retry state with bounded service backoff; no Actions runner waits.

The bounded external publication holds the admission lock. This
prevents an old successful publisher from passing its check after a new
same-head generation is admitted. Startup uses bounded repository-token factories,
bounded client preparation, five-second lock acquisition limits and non-overlapping
service ticks; shutdown clears both timers. Reconciliation is bounded by both
page count and a total deadline, not merely a per-page timeout.

Admission revalidates current head, base and the complete prepared policy while
holding its shared PR lock, before any writes. A previously prepared request that
arrives late cannot supersede a newer candidate; unavailable or unbounded fresh
reads fail closed. Nonpublishing work cannot supersede authoritative work.
Admission stores normalized prepared config and its source fingerprints in the
same transaction as the run, outbox and gate reservation. Dispatch cannot claim
an enrolled run until its current gate ID is bound and the pending state is
published. Projection acknowledgement advances the same gate to in-progress,
never success. The reaper atomically queues non-success for expired attempts or
pre-worker dispatch failures and retires their outbox work. It cannot overwrite
an accepted terminal result. A possibly started worker retains its execution
identity so explicit retry gets a fresh Job and Secret even after a lost ACK.

## Trusted input boundaries

`authoritativeReviewReader.ts` reads current PR identity and immutable policy
files through repository-scoped installation credentials. It validates the
numeric repository and PR, pins file reads to a full commit SHA, verifies the
Git blob identity, and bounds response bytes and elapsed time. Redirects,
malformed content and transport failures fail closed without exposing response
bodies or credential values. Timed-out response streams are cancelled.

`authoritativeReviewIdentity.ts` binds the current open candidate to the actual
resolved config/policy digests and immutable source descriptors. This is a pure
identity boundary, not a substitute for the trusted network resolver. The
existing Bifrost worker config resolver is shared without changing its provider
selection, persona defaults or turn clamp.

`WorkerReviewCompletion.v1` carries bounded `WorkerReviewResult.v1` persona
evidence, not a worker-selected check ID, conclusion, URL or override. The
service re-derives canonical eligibility using its own expected lanes and file
coverage. Worker summary counts are consistency checks only. Infrastructure
failure uses a bounded error classification, never raw provider transcripts.
The completion route authenticates the exact persisted worker-token digest,
coordinates, execution, generation and enrolled App. Canonical result, gate
publication intent, terminal run and dispatch retirement commit atomically.
The service reads fresh head/base/policy and exact diff coverage; changed or
closed candidates cancel without fabricating review evidence. Duplicate identical
callbacks are idempotent; changed results conflict. Late callbacks cannot revive
expired or reaped attempts. Raw provider text is never an eligibility override.

The dispatcher loads the stored preparation and projects only its credential-free
`PreparedReviewExecution.v1` envelope. The operator preserves it verbatim; the
worker verifies the actual model/URL and effective config digest before inference.
Legacy Jobs omit the field and retain their old behavior. The callback sends
one bounded typed result; an unknown HTTP outcome does not authorize a second,
different failure result. Missing delivery remains recoverable non-success.

Admission now supersedes on full identity, including same-head base/config or
policy changes, while rejecting stale persisted identities. A legitimate return
to a historically superseded identity still needs fresh live authority and an
explicit new generation; the persistence layer alone cannot authorize it.

## Explicit controller and admission controls

`AUTHORITATIVE_REVIEW_ENABLED=true` enables controller/completion wiring only.
It requires all of these service-owned inputs:

- `AUTHORITATIVE_REVIEW_APP_ID=4385771`, matching `GITHUB_APP_ID`.
- `AUTHORITATIVE_REVIEW_REPOSITORY_IDS`: finite unique numeric IDs, a subset of
  the existing Action OIDC repository allowlist, with app-gate permission enabled.
- `AUTHORITATIVE_REVIEW_POLICY_SOURCE`: strict JSON with `repositoryId`, `owner`,
  `repo`, `ref`, and `path`. The service resolves the configured ref, then reads
  and fingerprints the policy file at its immutable SHA. Candidate inputs cannot
  choose this source.
- Explicit credential-free `BIFROST_BASE_URL` and `REVIEW_MODEL`, matching workers.
- Optional `AUTHORITATIVE_REVIEW_TICK_MS`: 1,000–60,000; default 5,000. These are
  service reconciliation ticks, not scheduled CI jobs or parked runners.

`AUTHORITATIVE_REVIEW_ADMISSION_ENABLED=true` separately permits new enrolled
review requests. Its default is false. While paused, enrolled app-gate requests
return 503 before token mint/admission; they never silently use the legacy lane.
Existing completion, reaping and publication keep draining. Unenrolled and
nonpublishing legacy requests retain their existing route.

## Direct GitHub App webhook admission

The dedicated dispatch service can receive signed GitHub App deliveries at
`POST /api/webhooks/github`, eliminating a repository-owned Actions dispatch
job. This transport is independently default-off and preserves the existing
finite Actions/OIDC repository and owner allowlists:

- `GITHUB_APP_WEBHOOK_ENABLED=true` mounts the signed route. It requires a
  32–1,024 byte `GITHUB_WEBHOOK_SECRET`, plus finite
  `GITHUB_APP_WEBHOOK_REPOSITORY_IDS` and `GITHUB_APP_WEBHOOK_OWNER_IDS` values
  that are subsets of the existing app-gate allowlists.
- `GITHUB_APP_WEBHOOK_ADMISSION_ENABLED=true` admits new `pull_request` and
  `merge_group` work. Its default is false so ingress, signature verification,
  and delivery can be proven before the old producer is removed.
- Pull requests admit only open, non-draft exact candidates from `opened`,
  `synchronize`, `reopened`, and `ready_for_review` deliveries. The GitHub
  delivery ID remains the idempotency boundary.
- Merge groups publish one `Review Yeti` check on the synthetic head. A
  PostgreSQL advisory transaction serializes replicas and stores the terminal
  check ID. The gate succeeds only when every constituent at or ahead of the
  current queue entry has a latest exact-head successful `Review Yeti` check
  from the configured App and a second queue read is unchanged. Unavailable,
  partial, changed, or malformed evidence completes the synthetic check as
  failure instead of leaving it pending. The initial transport accepts at most
  100 queue entries and performs check lookups with concurrency five, keeping
  request and rate-limit pressure explicit and bounded.

The GitHub App registration must have an active webhook, subscribe to both
`pull_request` and `merge_group`, and grant read access to merge queues. The
runtime installation token is still minted for exactly one repository with
only `checks:write`, `contents:read`, `pull_requests:read`, and
`merge_queues:read`; broader effective grants are refused. Expose only the exact
webhook path at ingress and preserve the namespace's deny-by-default network
policy.

Cut over in this order: deploy the route with admission paused; configure and
prove signed delivery; remove the repository producer under its old required
checks; enable direct admission; then prove one pull-request check and one
merge-group check at their exact heads before changing further consumers.

Rollback must restore the captured old protections/triggers before disabling a
required route. Pause new admission first and reconcile existing attempts; do not
turn off all controllers with outstanding gate publications, drop additive tables,
remove persisted CRD fields or infer that a skipped workflow is a safe replacement.

## Remaining integration before production cutover

- Re-evaluate close, draft, push, policy, rerequest and human-risk events without
  changing author readiness automatically. Wire the pure accepted-risk and
  audited exemption policy to trusted event evidence; empty review output is not
  an exemption. Historical superseded identities and explicit rerequests of
  already successful reviews still need the fresh-generation event path.
- Complete same-head crash/retry/lost-ACK proof in the deployed pilot. An uncertain
  create must remain non-success until reconciled or explicitly superseded.
- Prove deployed canary behavior before changing any protection or removing
  consumer waiters. API-3211 owns durable CI admission, API-3213 protected pilot
  migration, and API-3215 independent zero-runner-wait acceptance.

## Focused verification

The unit tests exercise the GitHub transport, immutable identity, eligibility
policy and publisher. `tests/integration/reviewGateRepository.postgres.test.ts`
uses a disposable PostgreSQL schema for real SQL, concurrent claims, generation
history, rollback, stale publication, lost create acknowledgement and
same-worker lease reuse. Set `REVIEW_YETI_TEST_DATABASE_URL` to an owned test
database; absent configuration explicitly skips those integration tests and
does not constitute database proof.
