# Panel publication policy

> [!IMPORTANT]
> **Optional service document.** This record describes the publication design shared by the App
> and the public Action. It is not the internal fleet publication contract. Verify it against
> current source before operational use. See [Documentation authority](DOCUMENTATION_AUTHORITY.md).

Last updated: 2026-09-06

## Problem this solves

Publishing **one `COMMENT` review per persona with inline findings** created:

1. Dozens of **resolve-required review threads** under `required_conversation_resolution`
2. Merge stuck at `mergeStateStatus: BLOCKED` while required checks were green
3. Status-check rollup flapping (`PENDING` ↔ `SUCCESS`) as each review write re-fired webhooks

## Policy

| Phase | GitHub surface | Purpose |
|-------|----------------|---------|
| Persona lanes | **Issue comments** only (`POST .../issues/{n}/comments`) | Advisory progress + finding summaries. Marker: `<!-- ct-review-persona ... -->` |
| Arbiter (final) | **One** Pull Request Review (`APPROVE` / `REQUEST_CHANGES`) | Binding verdict + exact-head ledger. Marker: `<!-- ct-review-final ... -->` |
| Arbiter (final) | **Inline review comments** (optional, capped) | Only **P0/P1**, cross-persona **deduped**, max **10** threads |

Personas must **never** call `POST .../pulls/{n}/reviews` with inline comments.

## The Action surface

The Action publishes the same shape from a single lane rather than a persona panel:

| Artifact | GitHub surface | Purpose |
|----------|----------------|---------|
| Sticky summary | **One** issue comment per pull request | Full summary. Anchor: `<!-- review-yeti-bot:summary:v1:{repo}#{pr} -->` — stable across pushes, so later rounds patch it. Earlier rounds collapse into `<details>` history as **digests** (verdict, head, counts, finding titles), max 8 rounds, and the whole comment is held under 60,000 characters against GitHub's 65,536 limit |
| Exact-head receipt | **One** `COMMENT` review per reviewed head | Compact gate signal. A review's `commit_id` is immutable, so each reviewed head needs its own; retries of one head deduplicate rather than re-post. Marker: `<!-- review-yeti-bot:v2:... -->` |
| Findings | **Inline review comments** (capped) | Only **P0/P1**, near-duplicate **deduped** across personas, max **10** threads. Over-cap findings are listed in the sticky summary, never dropped |

Findings without a publishable line anchor become file-level conversations or, failing that, a
named section in the summary. The Action never relocates a finding to a nearby line to make it
publishable.

**Both lookups are bounded.** The sticky comment is found by reading issue comments newest-first
and stopping at the first anchor match; existing reviews are read through the GraphQL `reviews`
connection with `last:`, because the REST list is oldest-first with no `direction` and capping its
pages would drop exactly the newest entries dedupe depends on.

**Publisher identity is required, and matching fails closed.** The summary anchor is derived from
the repository and pull request number alone, so anyone who can read the pull request URL can write
a comment containing it. A comment or review is only adopted — patched in place, or treated as an
existing round for dedupe — when its author matches this run's authenticated publisher. If that
identity cannot be established, publication fails rather than adopting an unverified comment.

## Implementation

| | App | Action |
|---|---|---|
| Helpers | `src/github/panelPublication.ts` | `src/review/findingPublication.js`, `src/review/claimSimilarity.js` |
| Pipeline | `src/app.ts` publish stage | `.github/workflows/pipelines/review-pipeline.js` (`postOrOutputComment`) |
| Thread cap | `MAX_FINAL_INLINE_COMMENTS` (alias) | `MAX_PUBLISHED_REVIEW_THREADS` |
| Tests | `tests/unit/panelPublication.test.ts`, `tests/integration/personaAppPipelineV3.test.ts` | `tests/unit/actionReviewPublication.test.ts`, `tests/unit/findingPublication.test.ts` |

The cap and its ranking (`capPublicationThreads`, `MAX_PUBLISHED_REVIEW_THREADS`) live in
`src/review/findingPublication.js` beside the planner, so the size of the cap and the rule for
which findings survive versus overflow exist in one place rather than one copy per surface. The
App's `MAX_FINAL_INLINE_COMMENTS` is an alias of that constant, not a second definition, so the two
surfaces cannot be given different merge-blocking behaviour by editing one of them. The companion
rule — which severities are actionable — is likewise one definition (`ACTIONABLE_SEVERITIES` /
`isActionableSeverity`), read by the Action's rejected/overflow filtering and by the App's
`ACTIONABLE_SEVERITIES` set. The App's *ranking* still lives in `dedupeActionableFindings`;
converging it onto `capPublicationThreads` is the remaining step.

## Outdated conversations

A review thread goes outdated when the lines it was anchored to no longer exist — the code it
objected to was rewritten or removed. It can never resolve itself, so under
`required_conversation_resolution` it blocks the merge while pointing at code that is gone. Each
publish resolves the threads that are outdated, unresolved, and written by this publisher, capped at
50 per run. A person's thread is never touched, and a still-current bot thread stays open because
its finding still stands. If the defect survived the rewrite, the next round reports it again at its
new location.

## Known gap

Resolving a conversation does not yet suppress that finding on the next run: the Action has no
decision ledger, so a still-present defect is re-reported under a new thread after each push.
`src/review/decisionLedger.js` covered this before `2f28719a` and has not been restored.

## Deploy note

Ship this revision to the live App (production review-yeti deployment) before expecting production PRs to stop accumulating persona review threads.
