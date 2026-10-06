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
| `REVIEW_YETI_INCREMENTAL_DELTA` unset, empty, `0`, `false`, `off` | worker | Off. Touched files are re-reviewed whole (the behaviour above). |
| `REVIEW_YETI_INCREMENTAL_DELTA` `1`, `true`, `on`, `all`, or `owner/repo,...` | worker | Delta scope on. Same grammar as `REVIEW_YETI_INCREMENTAL`; has no effect unless that flag is also on for the repository. See [Delta scope](#delta-scope). |
| `REVIEW_YETI_INCREMENTAL_MAX_CHAIN` | dispatch service | Most consecutive delta re-reviews before a full one is forced, 1 to 20. Default 4. Applies only when the delta scope is on. |
| `REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS` | dispatch service | Oldest prior review a carry-forward may rest on, 1 to 720 hours. Default 72. |

In Kubernetes, set `REVIEW_YETI_INCREMENTAL` on the operator Deployment (Helm: `publishing.incremental`, empty by default). The operator forwards a non-empty value verbatim to app-gate worker Jobs only. A value with a line break refuses app-gate Jobs. To revert, set it back to empty and let the operator roll. The age limit is read by the dispatch service; both the worker's planning read and the trusted verification use that one value.

The delta flag is forwarded the same way (Helm: `publishing.incrementalDelta`, empty by default). The chain cap is dispatch-service config and is not forwarded to workers.

## What happens

On a new head for a pull request, the worker asks the dispatch service for the prior review record (`POST /api/dispatch/incremental-base`, authenticated with the run's own bearer). The service selects the latest stored completion of another run of the same pull request that was stored before this run was admitted. The latest record is never skipped: if its run did not succeed, the review is full.

The worker then reads three GitHub comparisons, pinned to exact SHAs: previous head to new head, previous base to previous head, and new base to new head. A fourth read happens only when the merge base moved.

A changed file is carried forward only when all of these hold:

- It was in the prior review's diff.
- It is not touched, as old or new path, between the previous head and the new head.
- No lane of the prior review reported a finding on it, of any severity.

Carried-forward files stay listed to every lane with a one-line note in place of their patch. Every other file is sent in full. A file with an open finding is always re-reviewed in full, not just the hunk that carries the finding.

## Delta scope

Whole-file carry saves little when every push touches the files the previous review already read. A real 5-head pull request (the replay fixture, `tests/fixtures/incremental/`) re-sent 95 to 129 KB of patch text per head while each push changed 3 to 30 KB. With `REVIEW_YETI_INCREMENTAL_DELTA` on, a file that was in the prior diff, was touched since the previous head, has no open finding, and was not renamed is **delta-scoped**: its lane patch is the pull request's own file header, a note, and only the hunks of the change since the previous head. Files with an open finding, renamed paths, gitlinks, symlinks and files new to the pull request are never narrowed.

- **Verification.** The claim carries `deltaPaths`. The service re-derives them from its own prior record and its own detailed compare (status `modified`, complete patch). Delta paths may not overlap carried paths; a claim must carry or delta at least one file. `delta-patch-unavailable` is the refusal when a patch is missing.
- **Bounded calls.** The planner is capped at `min(maxTasks, previous task count, 3)` tasks. The review makes one plan call plus one call per planned task, however many hunks changed: hunks are grouped into those tasks, never reviewed one call per hunk (pinned by `incrementalDeltaEngine.test.ts` at 1, 10, 100 and 300 hunks).
- **Ledger.** Every open prior finding and every delta hunk gets a stable id and is routed to exactly one task. Each task returns an outcome for every id it was assigned (`resolved`, `still-open` or `unclear` for a prior finding; `clean` or `finding` for a hunk), validated by the engine; a missing, duplicate or unknown id is a contract failure. `unclear` counts as open. The check summary lists the totals and any prior finding left unresolved.
- **Convergence.** A P2 on a delta-scoped file that is outside the delta lines (plus 20 lines of context) is classified `outside-diff` advisory, as ADR 0002 does for lines outside the diff. P0 and P1 are never narrowed, and severity is unchanged.
- **Chain cap.** Every delta re-review records its depth. When the prior depth reaches `REVIEW_YETI_INCREMENTAL_MAX_CHAIN`, the review is full (`chain-cap-reached`), so a carry never rests on an unbounded chain of narrowed reviews.
- **Composed engine limit.** In the composed engine, the delta narrows the plan turn's view, the tool file list, the domain lanes and the precheck evidence. The task work turns still deliver every original patch character of their assigned paths, because the trusted task ledger requires a source-delivery receipt against the original patch digests. So today the delta bounds the number of calls and the verdict scope, and saves plan-turn tokens; it does not yet shrink work-turn source. That needs a trusted-ledger amendment and is tracked separately.

## Full-review fallbacks

Each of these is the review that runs today:

| Reason | Condition |
| --- | --- |
| `no-prior-review` | No earlier stored completion for the pull request. |
| `retry-attempt` | Any execution attempt after the first. This is also the recovery path for any incremental problem. |
| `same-head` | The prior review was of this head. |
| `prior-not-ship-complete` | The prior run did not succeed, or it was not a complete SHIP: the gate's own record of that exact completion is not a `clean-review` success (SHIP, every required lane completed, coverage and quorum met, no P0/P1), the verdict re-derived from its stored lanes with the gate's required lane count is not SHIP, a lane has a P0/P1 finding at its published severity (after calibration; a raw P1 re-filed as P2 does not disqualify, and its file is always re-reviewed as an open finding) or an error, or it is an audited no-reviewable-content exemption. The verdict is always derived, never read from the worker's optional `result.verdict`. On an authoritative-gate run, only a gated completion qualifies. On a non-authoritative run (the worker publishes its own check, as on the pilot repos), a non-authoritative `WorkerReviewEvidence` prior qualifies from the stored evidence alone: its published check conclusion was `success`, its run succeeded, it records the lane roster its verdict required (`result.roster`) and every roster lane is present once with no extra lane, and the verdict re-derived from its lanes with that roster size is SHIP with no P0/P1 at published severity; otherwise `evidence-conclusion-not-success`, `evidence-roster-unknown`, `evidence-roster-mismatch`, `lane-missing`, `lane-failed`, `blocking-finding` and so on. An authoritative run never rests on one (`no-gate-evidence-record`). The check summary and the `Incremental re-review planned` / `Verdict cache planned` logs name the refusing check as `priorRefusal` (for example `gate-not-clean`, `blocking-finding`, `lane-missing`); the service logs it too as `Incremental base prior not SHIP-complete`. |
| `policy-or-config-changed` | The prior review's policy or config digest differs. The config digest covers the persona roster and prompts. |
| `prior-too-old` | The prior record is older than the configured age, measured from this run's admission time. |
| `not-ancestor` | The previous head is not an ancestor of the new head (force-push or rebase). |
| `base-rewritten`, `base-moved-reviewed-files` | The merge base moved backwards or sideways, or moved and touched a current or previously reviewed file. |
| `chain-cap-reached` | Delta scope on, and the prior review was already the configured number of consecutive delta re-reviews deep. |
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

- Finding-hunk granularity. An open-finding file is re-reviewed whole, not only the hunk that carries the finding. That is a superset of the plan's rule and costs more tokens. The delta scope does not change this.
- Work-turn source delivery under the delta scope (see [Delta scope](#delta-scope), composed engine limit). Needs the trusted task ledger to accept the scoped patch digest.
- The checkpoint/resume path does not retain ledger entries, so a resumed task shows as unrecorded in the ledger summary. That fails closed (disclosed, never resolved).
- Classifier input. On the non-deterministic roster, the pre-flight classifier sees the carry-forward notes, so a small delta on top of a SHIP-complete review can fast-ship. The authoritative roster never classifies.
- `review_runs` has no `(repository_id, pr_number)` index. The selection query filters on it. Add one if the table grows large.

See also `docs/features/verdict_cache.md` (REL-1085): a content-keyed, lane-by-lane cache that also applies after a force-push or rebase. It runs after this step and never serves a file this step carried forward.
