# Durable worker failure recovery

Publishing workers can report a typed `WorkerTerminalFailure.v1`,
`WorkerTerminalSuccess.v1`, or `WorkerReviewCompletion.v1` to the Action
dispatch service at `/api/dispatch/completion`. A failure callback carries only
immutable attempt coordinates, a bounded failure class, and a redacted
diagnostic (`reason`, optional `providerStatus`, and a UTF-8 bounded `logTail`),
never provider response text. It cannot approve a review or change a provider.

## Activation and compatibility

The callback is additive and opt-in. Deploy the database-compatible service and
dispatcher before enabling `REVIEW_YETI_COMPLETION_URL` on the operator. The
operator projects that trusted HTTPS URL as `REVIEW_COMPLETION_URL`; it is not
read from pull-request content. Do not enable it until the service exposing the
callback route is actually updated and reachable. Apply the manifest's exact
`/api/dispatch/completion` ingress path; the admission-only path does not route
callbacks. Do not expose a broad API prefix. The job dispatcher, operator,
and worker images alone are not proof that the HTTP API service was updated.

For the execution identity rollout, apply the updated `PRReviewJob` CRD schema
before enabling a dispatcher that writes `spec.executionAttempt`. The field is
optional during the mixed-version window: a new operator uses it when present,
while CRs persisted by an older dispatcher decode only a validated `-aN`
Secret suffix, with an unsuffixed Secret meaning attempt `1`. Keep that legacy
fallback until all pre-schema CRs have expired; an explicit field and a
mismatched Secret name fail closed.

An unset URL preserves the callback-disabled worker path during a mixed-version rollout.
An explicitly invalid URL is an error, not an instruction to disable reporting.
URLs with credentials or fragments are rejected; redirects are not followed.
Each HTTP callback has a bounded timeout. A delivery failure preserves the
original worker failure; it does not turn the review green. Existing deadline
recovery remains available when a process dies without making a callback.
Deploy the success-capable service before the success-capable worker. Old
workers continue sending only the failure event. A new worker treats an old
service's rejected success event as an execution failure, so version skew cannot
silently claim durable completion.

## Trusted binding and split-write recovery

The normative run Secret name contract is `ct-review-run-<id>[-aN]`, where
`<id>` must equal the 32 lowercase hexadecimal characters in `run_<id>`.
`N` is canonical decimal in `1..2147483647`: digits only, no sign or leading
zero. Writers emit the unsuffixed name for explicit attempt `1`; legacy readers
also accept `-a1`. An explicit CR attempt must match its canonical Secret name.
The projection, provisioner and projector share the pure builder/deriver in
`src/k8s/reviewJobProjection.ts`. The projector fills only an absent attempt in
a comparison copy, preserving the observed CR and every other compared field.

The TypeScript and Go builder tests mirror these cases for the same run ID:

| Secret suffix | Legacy result |
| --- | --- |
| absent | attempt `1` |
| `-a1` | attempt `1` |
| `-a2` | attempt `2` |
| `-a2147483647` | attempt `2147483647` |
| `-a0`, `-a-1`, `-anonsense`, `-a2147483648`, `-a+2`, `-a01` | reject |

A Secret belonging to another run is rejected regardless of suffix. The Go
builder validates the name pattern before parsing the numeric suffix, so
`ParseInt` accepting signed or zero-padded text does not admit those names.

The trusted dispatcher provisions repository-scoped installation tokens in the
existing per-execution Kubernetes Secret, then persists the delivered publish
token's SHA-256 digest before projecting work. The API authenticates the bearer
against that exact digest using a constant-time comparison, and also verifies
repository ID, owner/name, PR, base/head, policy/config digests and execution
attempt. A token prefix or permission to read a public check is not authentication
for this callback. Tokens and their raw contents are never stored in receipts.

The dispatcher needs `get` and `create` on Secrets for split-write recovery.
This is a namespace-level RBAC read grant, not a name-scoped Kubernetes grant;
the code restricts reads to an exact identity-derived run Secret. There is no
new Secret list, patch or delete permission. Preserve that distinction when
reviewing a deployment's namespace isolation.

If Secret creation succeeds before the database binding is acknowledged, the
next attempt reads and validates the same Secret and binds its actual token.
It never binds a newly minted replacement to the already-delivered object.
Legacy Secrets with the exact run/component labels and identity-derived name
remain readable. Additional repository identity metadata, when present, must
match. Repository names are annotations rather than size-limited labels.

## Failure and retry semantics

The callback serializes against admission's repository/PR transaction lock.
A matching failure can arrive while projection is pending, claimed or recorded
as projected. It atomically records the failure and retires the dispatch lease;
the authenticated worker proves that projection occurred even if its
acknowledgement was lost. An old dispatcher cannot subsequently release or
overwrite that execution. Both writes roll back if persistence fails.

A duplicate failure is idempotent. An explicit subsequent same-head review
request advances the existing execution counter and creates a fresh Job and
Secret identity. An old execution's callback cannot fail or approve the new
one. A failure before check creation can omit `checkId`; the check is useful
evidence but is not the callback's authority.

The deterministic non-production reaper acceptance harness attempts every
cleanup step even when the primary operation already failed. It preserves the
exact primary thrown value. When that value is an extensible object, the harness
attaches cleanup diagnostics; primitive or frozen values cannot carry those
diagnostics and are rethrown unchanged after cleanup. Unit coverage fixes this
identity-preservation boundary explicitly.

The service stores the latest failure in `review_runs.failure_diagnostics` as a
redacted JSON object with `failureClass`, `reason`, `providerStatus` (when the
provider supplied a valid HTTP status), `logTail`, and `executionAttempt`.
Legacy callbacks without `diagnostics` receive a fixed class-derived reason and
tail; service-side deadline recovery records the same fixed timeout/internal
diagnostic when a pod disappears before it can callback. The worker and service
both redact known token/key/prompt fields and cap the tail at 2,048 UTF-8 bytes
before persistence. A same-head retry preserves the previous diagnostic until
its replacement attempt reports a new one.

## Legacy success semantics

`WorkerTerminalSuccess.v1` is deliberately narrower than the authoritative
review-result contract. It contains the same immutable repository, pull
request, head/base, policy/config and execution coordinates as a failure, plus
the required ID of the green check the worker just completed. It does not carry
an approval field, findings, provider output, or a worker-selected digest.

The worker sends the event only after GitHub accepts the successful check
completion. The service validates the event and derives `result_digest` from
its canonical body. Under the same repository/PR lock used by admission, the
repository verifies the exact per-execution token digest and every persisted
coordinate, then atomically marks the run `succeeded` at stage `complete` and
the dispatch outbox `terminal`. It clears both leases and old failure details.
The token digest remains as non-secret authentication evidence for an exact
idempotent callback retry; a different check ID produces a conflict rather than
rewriting the recorded result.
Missing or non-current durable state is not acknowledged as success: the API
returns a conflict so the worker fails and deadline recovery remains active.

The worker marks a success body as attempted before awaiting its HTTP response.
If the service commits but its acknowledgement is lost, the worker does not
replace the green check or callback with contradictory failure evidence. If no
success reaches durable storage, the existing deadline reaper remains the
fail-closed recovery path.

For legacy abandoned-run recovery, `review_runs.delivery_id` and the matching
`review_dispatch_outbox.delivery_id` are a one-exact-attempt invariant. The
reaper locks both rows and never publishes when those identities diverge. It
instead atomically terminalizes the outbox, clears both leases, records a
bounded `dispatch_delivery_identity_mismatch` diagnostic containing only
delivery digests, and appends a `delivery_identity_mismatch` lifecycle event.
The repository returns this quarantine explicitly to the reaper (rather than
requiring it to infer the outcome from a missing publication callback). The run
remains without a result or success verdict, is counted by
`ct_review_reaper_delivery_identity_mismatch_total`, and is not eligible for
another legacy sweep.

A completed newer successful or failed `Review Yeti` check from the authenticated publisher App can
also make an abandoned attempt obsolete on the same head. This is recognized
only when the newer check has a valid `run_<id>:a<attempt>` external identity
and began in a strictly later GitHub timestamp second. The reaper never copies
that check's success or failure onto the old run and never patches the newer
check. While holding the old attempt's run and outbox locks, it instead
atomically terminalizes the outbox, clears both leases, leaves `result_digest`
unset, and records `superseded_publisher_owned_check` diagnostics plus a
`superseded_by_newer_check` lifecycle event. The one-shot retirement increments
`ct_review_reaper_superseded_attempt_total`; malformed, same-second,
non-terminal, foreign-App, or otherwise ambiguous identities remain fail
closed and retryable.

One pre-attempt-identity check is covered by an audited compatibility receipt:
run `run_b7c5c8f6d4e2fdfaa52f27d3f96bb5ce` for
`calltelemetry/cisco-cdr#4972` at
`01cc3c3070ae025c9a9bb8176c92106c30488151`, paired only with publisher-App
check `102735106478`. The receipt pins the durable run, repository, pull
request, head, execution attempt, admission/deadline timestamps, publisher App,
check name, and check start/completion timestamps. It accepts only that unique,
completed-success check with an exactly empty `external_id`, rereads the check
by immutable ID, and never patches it. Other empty-identity checks on the same
head are expected historical siblings and are not receipt candidates; selecting
them by shared App/name/head fields would make the pinned receipt ambiguous.
Recovery-only runs and every pinned-field mismatch remain fail closed. This is
a one-row historical migration boundary, not a generic empty-identity fallback;
another legacy row requires a separate independently reviewed receipt.

This change does not replace raw check publishers, alter required checks, or
establish event-driven consumer CI. Those lifecycle and rollout requirements
have separate acceptance evidence. A merged source PR and passing local tests
do not establish deployed recovery.

## Deterministic reaper counter acceptance

Never manufacture either reaper anomaly in production. A delivery-identity
mismatch is durable split-brain state between `review_runs` and
`review_dispatch_outbox`; creating it requires corrupting production data. A
superseded attempt is an abnormal abandoned-attempt recovery case; forcing it
requires stranding a live attempt or manipulating GitHub checks. Neither is an
acceptable observability probe.

REL-817 therefore uses a sanctioned integration harness instead. It creates a
random, owned schema in a disposable loopback PostgreSQL service, runs the real
repository transactions and abandoned-run reaper, and serves metrics from the
real dispatcher HTTP metrics server. Only GitHub transport is replaced: a
read-only fake response supplies the strictly newer, completed, same-head App
check needed by the superseded branch. The harness rejects GitHub writes.
The database URL must contain only its validated authority and path: all query
parameters are rejected before a PostgreSQL pool is constructed so libpq/pg
connection overrides cannot redirect the harness to another host, role, port,
database, service, or option set.

Each branch runs twice in one process lifetime. The acceptance receipt verifies
that each projected outbox row first carries a non-null expired lease, then
verifies the durable reason and lifecycle terminal class, an unset result
digest, terminal run/outbox state, and cleared leases after the real reaper.
Four HTTP scrapes prove both counters are positive, retain their values across
an unchanged scrape, increase after the second pair, and remain monotonic on a
final scrape. Teardown attempts every owned resource independently, including
the final admin-pool close; cleanup failures are aggregated after success and
cannot replace an earlier operation failure.

Run it only against an owned disposable PostgreSQL service. The harness rejects
non-loopback hosts and requires the disposable `postgres` user/database shape:

```bash
docker run --rm -d --name review-yeti-rel817-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  -p 127.0.0.1:55432:5432 postgres:17-alpine

REVIEW_YETI_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres \
  npm run test:acceptance:reaper

docker stop review-yeti-rel817-postgres
```

Do not substitute a production database, a production database port-forward,
production Kubernetes access, or a live GitHub token. Protected CI runs the
same command against its ephemeral PostgreSQL 17 service after the full test
suite.

## Focused verification

Run the worker, admission, dispatch repository and Secret-provisioner unit/API
tests, the Go operator tests, and the real PostgreSQL lifecycle test. Set
`REVIEW_YETI_TEST_DATABASE_URL` to a disposable database; the integration test
uses session-local temporary tables. The real SQL case covers same-head retry,
failure before projection acknowledgement, uncertain projection, stale attempt
rejection and rollback after the outbox write. Do not point verification at a
production database or use a full provider suite for this contract.
