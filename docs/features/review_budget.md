# Risk-ordered review budget per lane

Flag: `REVIEW_YETI_BUDGET` on the publishing worker, default off.
Plan: `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`, section 4 W5 (REL-1082).
Measurements: `docs/superpowers/specs/2026-09-23-review-content-measurements.md` (W1).
Code: `src/review/reviewBudget.ts`, `src/types/reviewBudget.ts`. There are thin hooks in `src/panel/panelEngine.ts`, `src/panel/composedEngine.ts` and `src/cli/publishingReview.ts`.

## Enabling

| Value | Effect |
| --- | --- |
| unset, empty, `0`, `false`, `off` | Off. Every lane gets today's content, including the 20k per-file cut. |
| `1`, `true`, `on`, `all` | On for every repository. |
| `owner/repo,owner/other` (comma or space separated) | On only for the listed repositories (case-insensitive). |

The worker reads the variable from its own environment. In Kubernetes, set `REVIEW_YETI_BUDGET` on the operator Deployment (Helm: `publishing.reviewBudget`, empty by default). The operator forwards a non-empty value verbatim to app-gate worker Jobs only. Receipt-only Jobs never get it. A value containing a line break refuses app-gate Jobs. To revert, remove the variable or set it to empty and let the operator roll.

## What each lane is sent

The budget runs after the shared applicability decision and after diff shrinking. The persona panel gets one pack per applicable lane, built from the files that lane is scoped to. The composed engine gets one pack for its single context.

1. **Security-sensitive and CI/IaC files, at full depth, first.** A path is security-sensitive when `isSecuritySensitivePath` matches it (auth, crypto, secrets, CI, containers, IaC, dependency manifests, scripts, migrations and similar). CI/IaC means the W1 CI and IaC path rules. These files are never summarized. They can go past the soft budget, up to the hard cap. If a whole patch does not fit, the file keeps today's 20k-cut patch. Only a file that doesn't fit even then is listed.
2. **Source, then tests, config and docs.** Every such file starts as a signature summary. In category order, then path order, a file is upgraded to its whole patch while the lane's soft budget lasts.
3. **Signatures.** The summary holds the hunk headers, which carry git's enclosing-function context, and the changed lines that declare or import something, each with its line number. It is extracted in code and never written by a model. It is capped at 40 lines.
4. **Not deeply reviewed.** If even the signatures do not fit the hard cap, the lowest-priority files become a one-line note.

Before anything is placed, a minimal note is reserved for every file in the lane, full-depth files included. A file gets more than its note only if every file not yet placed keeps its reserve. The packed diff therefore never passes the hard cap, however many files the lane has. If the minimal notes alone would not fit (roughly 1,000 or more files in one lane), the lane is **not budgeted**. It gets today's content, and the summary says "budget not applied" for that lane.

No file is removed. Every file stays in the lane's file list and its patch stays readable with `get_diff`. Only the inline depth changes.

A file sent at full depth is sent whole, so the 20,000-character per-file cut in `src/pipeline/hunkFilter.ts` does not apply to it. For such a file, the lane's tools and findings validation also read the whole patch, so a finding past the old cut can be anchored. Every other file keeps today's patch for its tools. That keeps `get_diff` output bounded.

## Sizes

| Constant | Value | Why |
| --- | --- | --- |
| `PERSONA_BUDGET_CHARS` | 56,000 characters | The inline-diff knee W1 measured (`MAX_INLINE_DIFF_CHARS_CEILING`). Past it, turns go from 5 to 19 and median worker time from 201 s to 470 s. |
| `MAX_PACKED_DIFF_CHARS` | 160,000 characters | Hard cap on one lane's packed inline diff. It holds for any lane the budget packs, because a minimal note is reserved for every file before any content is placed. |
| `BIFROST_PROXY_BODY_LIMIT_BYTES` | 1 MiB | Workers reach Bifrost through the `gateway-internal-https` nginx front (ct-infrastructure `clusters/doks-nyc1/apps/llm-gateway/deploy-gateway-internal-https.yaml`). It sets no `client_max_body_size`, so nginx's 1 MiB default applies. Bifrost's own limit is 10 MB. An oversized sec-lane request hit HTTP 413 there. |
| `MAX_BUDGETED_REQUEST_BYTES` | 640 KiB | Whole-request cap for a budgeted lane. Each tool result is clipped so that the serialized conversation plus the result stays under it, with a note telling the lane what happened. |

## Safety (plan section 3)

- **Deterministic only.** Category comes from the path. File content never changes a file's priority, so an injected "low risk" comment does nothing.
- **One decision.** `resolveBudgetedReviewApplicability` returns the lanes, exemption, unmatched paths, routed files, omitted patches and effective files of `resolveReviewApplicability` (the function the trusted completion side calls) unchanged. It only adds the packs. Coverage and lane rosters therefore cannot differ between the worker and the service.
- **Fail open.** With the flag off, a zero-lane decision, or a file missing from a pack, the lane gets today's content. The request cap is part of the budget, so with the flag off requests are exactly as large as today.
- **Disclosure.** For every lane that ran, the check summary lists how many files it got in full (and how many were past the per-file cut), which files it got as signatures only, which were not deeply reviewed, and which security-sensitive files kept the per-file cut. The REL-1092 "Truncated patches" list drops a file once every lane that ran got it whole or at a disclosed depth. A fast-ship result runs no lane and is left unchanged.
- **Jev.** Not used. `budgetCategoryRank` is the only ordering input. Once W4 shadow data calibrates Jev risk, a calibrated score may reorder files within the summarizable ranks only. It can never move a security-sensitive or CI/IaC file (plan section 5, item 6).

## Known limits

- A lane with about 1,000 or more files cannot list every file within the hard cap. It falls back to today's content, and the summary discloses it. Reviewing such a lane in chunks is W6 (map-reduce, REL-1083).
- Signature extraction is line-based. It is not an AST, so a declaration split across lines keeps only its first line.
