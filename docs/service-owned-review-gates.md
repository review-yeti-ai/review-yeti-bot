# Service-owned review gates

Status: additive implementation in progress for API-3210. These modules do not
install a schema, start a publisher, change a required check, or admit CI by
themselves. The existing raw `Review Yeti` worker output remains separate.

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
3. Only the first `reserved` to `creating` claim may create a pending check.
   Every later claim without a persisted check ID reconciles exact App and
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

The bounded external publication currently holds the admission lock. This
prevents an old successful publisher from passing its check after a new
same-head generation is admitted. Production integration must keep token
resolution and the complete HTTP work inside the configured lease, limit lock
waits and preserve service shutdown behavior. Reconciliation is bounded by both
page count and a total deadline, not merely a per-page timeout.

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
This typed module is not yet connected to authentication, persistence or a
worker callback route.

Admission now supersedes on full identity, including same-head base/config or
policy changes, while rejecting stale persisted identities. A legitimate return
to a historically superseded identity still needs fresh live authority and an
explicit new generation; the persistence layer alone cannot authorize it.

## Required integration before activation

- Resolve current PR/base and actual trusted effective policy/config identity;
  the legacy `pending-base-policy` placeholder is not review evidence.
- Fence admission by full candidate identity, including same-head base/policy
  changes, and reject stale event hints using current GitHub truth.
- Install the additive schema and wire a service-owned publisher. Persist the
  pending check ID before handing the attempt to a worker.
- Authenticate terminal evidence against the exact dispatched execution and
  commit the authoritative terminal decision and delivery intent atomically.
- Persist worker-crash, dispatch-failure, reaper and retry-exhaustion outcomes;
  an uncertain create must remain visibly non-success until reconciled or an
  explicitly new generation is requested.
- Re-evaluate close, draft, push, policy, rerequest and human-risk events without
  changing author readiness automatically.
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
