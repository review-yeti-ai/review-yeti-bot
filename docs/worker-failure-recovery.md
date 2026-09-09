# Durable worker failure recovery

Publishing workers can report a typed `WorkerTerminalFailure.v1` to the Action
dispatch service at `/api/dispatch/completion`. The callback carries only
immutable attempt coordinates and a bounded failure class, never provider
response text. It cannot approve a review or change a provider.

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

An unset URL preserves the legacy worker path during a mixed-version rollout.
An explicitly invalid URL is an error, not an instruction to disable reporting.
URLs with credentials or fragments are rejected; redirects are not followed.
Each HTTP callback has a bounded timeout. A delivery failure preserves the
original worker failure; it does not turn the review green. Existing deadline
recovery remains available when a process dies without making a callback.

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

This change does not implement success callbacks, replace raw check publishers,
alter required checks, or establish event-driven consumer CI. Those lifecycle
and rollout requirements have separate acceptance evidence. A merged source PR
and passing local tests do not establish deployed recovery.

## Focused verification

Run the worker, admission, dispatch repository and Secret-provisioner unit/API
tests, the Go operator tests, and the real PostgreSQL lifecycle test. Set
`REVIEW_YETI_TEST_DATABASE_URL` to a disposable database; the integration test
uses session-local temporary tables. The real SQL case covers same-head retry,
failure before projection acknowledgement, uncertain projection, stale attempt
rejection and rollback after the outbox write. Do not point verification at a
production database or use a full provider suite for this contract.
