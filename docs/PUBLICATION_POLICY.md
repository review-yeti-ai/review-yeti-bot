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

## Implementation

- Shared planner: `src/review/findingPublication.js`
- Duplicate detection: `src/review/claimSimilarity.js`
- Action adapter: `.github/workflows/pipelines/review-pipeline.js`
