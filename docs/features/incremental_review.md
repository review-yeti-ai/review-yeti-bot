# Incremental re-review on synchronize

Flag: `REVIEW_YETI_INCREMENTAL` on the publishing worker, default off.
Plan: `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`, section 4 W7 (REL-1084).
Code: `src/review/incrementalReview.ts` (the decision), `src/persistence/incrementalPriorReview.ts` (the prior record), `src/review/incrementalBaseHttp.ts` and `src/api/incrementalBaseRoute.ts` (the worker's planning read), `src/review/authoritativeCompletionContext.ts` (trusted verification).

W1 measured about 9M of 88.7M weekly review tokens (upper bound 26M) spent re-reviewing files that had not changed since the previous reviewed head. This feature targets that share.

## Enabling

| Setting | Where | Effect |
| --- | --- | --- |
| `REVIEW_YETI_INCREMENTAL` unset, empty, `0`, `false`, `off` | worker | Off. Every review is full. |
| `REVIEW_YETI_INCREMENTAL` `1`, `true`, `on`, `all` | worker | On for every repository. |
| `REVIEW_YETI_INCREMENTAL` `owner/repo,owner/other` | worker | On only for the listed repositories (case-insensitive). |
| `REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS` | dispatch service | Oldest prior review a carry-forward may rest on, 1 to 720 hours. Default 72. |

In Kubernetes, set `REVIEW_YETI_INCREMENTAL` on the operator Deployment (Helm: `publishing.incremental`, empty by default). The operator forwards a non-empty value verbatim to app-gate worker Jobs only. A value with a line break refuses app-gate Jobs. To revert, set it back to empty and let the operator roll. The age limit is read by the dispatch service; both the worker's planning read and the trusted verification use that one value.

## What happens

On a new head for a pull request, the worker asks the dispatch service for the prior review record (`POST /api/dispatch/incremental-base`, authenticated with the run's own bearer). The service selects the latest stored completion of another run of the same pull request that was stored before this run was admitted. The latest record is never skipped: if its run did not succeed, the review is full.

The worker then reads three GitHub comparisons, pinned to exact SHAs: previous head to new head, previous base to previous head, and new base to new head. A fourth read happens only when the merge base moved.

A changed file is carried forward only when all of these hold:

- It was in the prior review's diff.
- It is not touched, as old or new path, between the previous head and the new head.
- No lane of the prior review reported a finding on it, of any severity.

Carried-forward files stay listed to every lane with a one-line note in place of their patch. Every other file is sent in full. A file with an open finding is always re-reviewed in full, not just the hunk that carries the finding.

## Full-review fallbacks

Each of these is the review that runs today:

| Reason | Condition |
| --- | --- |
| `no-prior-review` | No earlier stored completion for the pull request. |
| `retry-attempt` | Any execution attempt after the first. This is also the recovery path for any incremental problem. |
| `same-head` | The prior review was of this head. |
| `prior-not-ship-complete` | The prior run did not succeed, or its result is not SHIP with complete coverage and quorum, has an error lane or a P0/P1 finding, or is an audited no-reviewable-content exemption. |
| `policy-or-config-changed` | The prior review's policy or config digest differs. The config digest covers the persona roster and prompts. |
| `prior-too-old` | The prior record is older than the configured age, measured from this run's admission time. |
| `not-ancestor` | The previous head is not an ancestor of the new head (force-push or rebase). |
| `base-rewritten`, `base-moved-reviewed-files` | The merge base moved backwards or sideways, or moved and touched a current or previously reviewed file. |
| `comparison-incomplete` | A comparison lists 300 files, GitHub's cap, so it may be cut. |
| `nothing-carried-forward`, `no-new-reviewable-change` | Nothing to carry, or nothing new to review. |
| `error` | Any read or planning failure, or a 15-second planning deadline. |

## One decision

`decideIncrementalReview` is the only function that decides what may be carried forward. The engines apply the scope through `resolveScopedReviewApplicability`, strictly after the shared `resolveReviewApplicability` decision and after diff shrinking. It replaces only patch text, so the lanes, exemptions and unmatched-path failures stay exactly those the trusted completion side derives. Gitlinks, symlinks and mode changes are never carried forward.

## SHIP gate and trusted verification

Carried-forward results count toward the SHIP gate. The completion carries an additive `result.incremental` claim: the prior run, attempt, head, base and completion digest, and the carried paths.

On the authoritative path the service verifies the claim before any carried verdict counts:

1. Inside the completion transaction, it selects the prior record itself (`selectPriorReviewRecord`), recomputes its content digest and checks its run binding.
2. The claim must name exactly that record.
3. The trusted completion context re-runs the same decision against its own GitHub reads at the exact head and base.
4. Every carried path must be one that decision permits. Carrying less is allowed; carrying more is not.

`deriveCanonicalWorkerReviewEvidence` refuses a completion that carries anything forward without that verification, or names a file outside the trusted changed set. The gate then fails with `invalid-evidence`. Any retry attempt of the run is a full review. A GitHub read failure during verification is transient (HTTP 503 to the worker), never verified.

On the legacy check-only path the worker publishes its own check. The claim is stored with the evidence record, and no service verification runs.

## Disclosure

When the flag is on, the check summary gets an **Incremental re-review** block. It lists the previously reviewed head and run, the estimated diff tokens before and after, every carried-forward file, every file re-reviewed because of an open finding, and every file reviewed in full. When the review stayed full, the block gives the reason. Lists are capped at 15 entries plus a "+N more" count. The worker logs `Incremental re-review planned` and `Incremental re-review carried files forward` with counts only.

## Follow-ups

- Finding-hunk granularity. An open-finding file is re-reviewed whole, not only the hunk that carries the finding. That is a superset of the plan's rule and costs more tokens.
- Classifier input. On the non-deterministic roster, the pre-flight classifier sees the carry-forward notes, so a small delta on top of a SHIP-complete review can fast-ship. The authoritative roster never classifies.
- `review_runs` has no `(repository_id, pr_number)` index. The selection query filters on it. Add one if the table grows large.

See also `docs/features/verdict_cache.md` (REL-1085): a content-keyed, lane-by-lane cache that also applies after a force-push or rebase. It runs after this step and never serves a file this step carried forward.
