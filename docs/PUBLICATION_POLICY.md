# Publication policy

How review output is placed on a pull request, and why.

## Problem this solves

Finding details need to be actionable where the code changes, without
duplicating the same text in a large pull-request conversation comment.
Publishing one review per persona is also too noisy.

## Policy

| Surface | What goes there |
|---------|-----------------|
| **One `COMMENT` pull request review** | The verdict panel: exact-head metadata, finding counts, model and usage details. Later pushes update this same review rather than adding another. |
| **Resolvable line comments** | Every cross-persona-deduped **P0/P1** finding, on an exact changed line. No bot-defined numeric cap. |
| **Resolvable file comments** | P0/P1 findings on changed binary, gitlink, or patchless files that have no valid line anchor. |
| **Counts only** | P2 findings are advisory. They appear as counts in the review and never open resolve-required threads. |

Individual personas never submit their own reviews or root issue comments. The
final arbiter phase owns the one review and all actionable conversations.

Invalid paths and incorrect lines are rejected and counted in the review rather
than suppressing independently validated conversations. The bot never invents a
nearby anchor and never falls back to a generic issue comment.

## Idempotency

Publication is bound to the exact reviewed head SHA:

- Each finding carries a stable per-finding marker, so a retry updates in place.
- The root review carries a stable per-PR summary marker, so it is updated
  across pushes instead of duplicated.
- Unresolved conversations are verified through GitHub's paginated GraphQL
  `reviewThreads` connection before the run reports success.

Rerunning a review on an unchanged head does not repeat findings the previous
run already posted.

## Same-PR decision memory

Before parallel review begins, the Action reads one authenticated, paginated snapshot of the pull
request's review threads. Only finding markers authored by the authenticated Review Yeti publisher
become memory. Every persona receives the same bounded ledger as user data; raw human replies,
author names, reactions, and command reasons are never sent to a model. Memory is same-PR only.

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
