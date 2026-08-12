# Publication policy

How review output is placed on a pull request, and why.

## Problem this solves

Finding details need to be actionable where the code changes, while the
pull-request-level summary remains one sticky comment instead of growing a new
expanded copy on every push. Publishing one review per persona is also too noisy.

## Policy

| Surface | What goes there |
|---------|-----------------|
| **One sticky issue comment** | The full per-PR summary: verdict, mapped roster, telemetry, findings, and exact-head markers. Later pushes edit this same comment and retain prior rounds under collapsed bounded history. |
| **One `COMMENT` pull request review per reviewed head** | A compact exact-head receipt with the verdict/status and publication markers. GitHub binds it to the immutable commit; it is not the expanded summary. |
| **Resolvable line comments** | Every cross-persona-deduped **P0/P1** finding, on an exact changed line. No bot-defined numeric cap. |
| **Resolvable file comments** | P0/P1 findings on changed binary, gitlink, or patchless files that have no valid line anchor. |
| **Counts only** | P2 findings are advisory. They appear as counts in the review and never open resolve-required threads. |

Individual personas never submit their own reviews or issue comments. The final
arbiter phase owns the sticky summary, compact review receipt, and all actionable
conversations.

Invalid paths and incorrect lines are rejected and counted in the review rather
than suppressing independently validated conversations. The bot never invents a
nearby anchor and never falls back to an unstructured generic issue comment; the
single structured sticky summary is the intentional issue-comment surface.

Every finding must verify against the exact reviewed identity, an evidence receipt emitted by the
current lane, and the immutable snapshot before it reaches arbitration or publication. Rejected
findings are removed; snapshot, identity, evidence, side, or anchor uncertainty produces
`INCOMPLETE_REVIEW`/`BLOCKED`, never `SHIP`. There is no report-only publication path.

## Idempotency

Publication is bound to the exact reviewed head SHA:

- Each finding carries a stable per-finding marker, so a retry updates in place.
- One sticky issue comment carries the full per-PR summary and stable marker; it is
  edited in place across pushes, with earlier rounds retained under bounded,
  collapsed history instead of duplicating the expanded details.
- Each reviewed head also gets an immutable, compact review receipt so GitHub
  keeps the verdict and finding conversations attached to the exact commit.
- Unresolved conversations are verified through GitHub's paginated GraphQL
  `reviewThreads` connection before the run reports success.
- The Action rechecks the pull-request head immediately before it reads prior publication state
  and before every write; a changed head aborts publication without attempting a write.

Rerunning a review on an unchanged head does not repeat findings the previous
run already posted.

## Durable replay after runner interruption

The optional durable-resume artifact is an immutable, hashed exact-identity manifest and a fenced
mutable delivery outbox. It does not change normal publication behavior. An explicitly authorized
replay worker validates the exact base/head/policy identity and manifest digest before it obtains a
lease, then consults the authenticated GitHub publication ledger before each bounded batch. Ledger
records win over local progress, preventing a retry from duplicating a chunk that was published just
before cancellation. Lease fences prevent an expired worker from persisting after a replacement has
taken over. Retryable failures back off within a bounded attempt budget; rejected or exhausted
chunks remain visible as dead letters for operator action.

## Same-PR decision memory and remote advisory recall

Before parallel review begins, the Action reads one authenticated, paginated snapshot of the pull
request's review threads. Only finding markers authored by the authenticated Review Yeti publisher
become authoritative ledger memory. Every persona receives the same bounded ledger as user data;
raw human replies, author names, reactions, and command reasons are never sent to a model.

If API-backed advisory memory is enabled, the Action makes one bounded query to the single selected
provider and gives the resulting exact-head-scoped context to every reviewer lane. This provider
context may include normalized feedback transitions, PR session recap metadata, code signals, and
trusted-base rule signals. It is advisory only: it cannot change ledger state, arbitration,
publication, or maintainer-command handling. Provider outage degrades to the GitHub ledger alone.

An unresolved P0/P1 finding remains part of deterministic arbitration and therefore remains
blocking, even when no reviewer repeats it. A repeated open claim reuses the existing conversation.
GitHub resolution has unknown intent: it does not mean fixed, rejected, or accepted risk. When a
resolved claim is still demonstrated by the current diff, it is published as a fresh conversation.

Maintainers can explicitly suppress or restore one thread's claim by replying:

```text
/review-yeti ignore accepted until API-1234 is delivered
/review-yeti unignore API-1234 has landed; evaluate this normally again
```

Commands are honored only from collaborators whose current repository permission is `write`,
`maintain`, or `admin`. The command must be the first nonblank line and include a reason. Ignore
decisions are visible in the summary and fail closed when thread history or permission lookup is
incomplete.

## Durable partial review semantics

Publication success and review outcome success are separate. The Action may successfully publish
a blocked receipt and PR review when the model panel is partial or incomplete. That receipt is
durable evidence, but it never authorizes a merge.

Coverage is recomputed against the enabled persona roster resolved from the trusted PR base, not
the number of lanes that launched. Only structured `APPROVE` or `FINDINGS` lanes with a findings
array and provider/model provenance count as trustworthy. Error, timeout, empty, malformed, or
partial lanes do not count, although findings already emitted by failed or partial lanes remain
publishable evidence.

```yaml
coverage_policy:
  quorum: two_thirds
  min_personas: 3
  mandatory_personas: [security]
  provider_diversity_min: 2
```

`two_thirds` is `ceil(2 * expected / 3)`; `simple_majority` is
`floor(expected / 2) + 1`. Mandatory personas, the minimum roster, and provider diversity remain
required for a durable partial result.

| Coverage | Review status | Gate | Merge eligible |
| --- | --- | --- | --- |
| complete and clean | `SHIP` | `PASS` | `true` |
| complete with findings | `FIX_FIRST` or `BLOCK` | `BLOCKED` | `false` |
| partial: quorum met, roster incomplete | `PARTIAL_REVIEW` | `BLOCKED` | `false` |
| incomplete: below quorum or missing a safety floor | `INCOMPLETE_REVIEW` | `BLOCKED` | `false` |

Partial and incomplete results are non-mergeable even when every finding was published
successfully. Consumers should gate on `gate-decision=PASS` or `merge-eligible=true`, not on
publication success alone.

## Implementation

- Shared planner: `src/review/findingPublication.js`
- Duplicate detection: `src/review/claimSimilarity.js`
- Same-PR decision ledger: `src/review/decisionLedger.js`
- Action adapter: `.github/workflows/pipelines/review-pipeline.js`
