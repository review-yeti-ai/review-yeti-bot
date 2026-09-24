# Review Yeti: shrinking review content, Jev triage, and large-diff handling

Date: 2026-09-23
Status: plan, accepted by the operator for implementation behind flags.
Builds on: `docs/superpowers/specs/2026-09-18-review-lifecycle-and-token-design.md` (token telemetry) and `docs/features/context_management.md` (context-window and compaction design).
Execution substrate: plain Kubernetes Jobs on DOKS (ct-meta ADR 0668). Nothing here changes that.

## 1. Why

A review round is the slowest of three parallel checks. The Review Yeti app review is the slowest *review* part: 66 recent `PRReviewJob`s on 2026-09-23 show a worker time of p50 100 s, p90 560 s, max 1678 s. Every persona lane receives the whole filtered diff, so cost and latency grow with diff size, not with risk.

Known waste, from the 2026-09-18 telemetry window:

- sec-lane plus perf-lane used over 43 percent of worker tokens, and over 90 percent of their runs were empty approvals.
- Superseded runs used about 24 percent of all tokens (partly addressed by REL-1057, which now ends stale-head runs as superseded).
- Average prompt size was 23k to 26k tokens, with a 77 percent prompt-cache hit rate.

Size limits and failures today (verified against `origin/main` at `be7a097a`, 1.84.8):

- GitHub's diff media type returns HTTP 406 (`too_large`) above roughly 20,000 lines or 300 files. Both diff readers already fall back instead of failing:
  - Worker side, `src/github/qualificationReader.ts` (`readQualificationDiff`, #891): on 406 the diff is assembled from the paginated pull-files API (100 files per page, at most 100 pages), bounded by `MAX_QUALIFICATION_DIFF_BYTES` = 8,000,000 bytes (about 80k changed lines). A diff above 8 MB, or more than 100 pages, is still a hard failure. Files the pull-files API returns without a `patch` (binary files, or patches GitHub omits as too large) are rendered as an empty string and are silently absent from the review diff, with no disclosure line. That violates the disclosure invariant in section 3 and is in scope for W3.
  - Trusted completion side, `src/github/authoritativeReviewReader.ts` (`exactCurrentDiff`): on 406, or a whole diff over `MAX_AUTHORITATIVE_DIFF_BYTES` = 2,000,000 bytes, it reads compare evidence instead. That path fails closed when the PR has more than `MAX_COMPARISON_FILES` = 300 changed files (`src/github/comparisonFiles.ts`). A patch that GitHub truncated or omitted, or one that fails the closed-hunk check, is rebuilt from pinned blobs, for up to 64 files (`MAX_RECONSTRUCTED_FILES`) and 4 MB of content. The compare schema also rejects the whole comparison if any single patch is longer than `MAX_COMPARISON_FILE_PATCH_BYTES` = 512,000 characters. It does not drop just that file.
- `src/cli/publishingReview.ts` (`isGithubDiffNotRenderableError`, `classifyFailure`) still classifies any 406 that escapes as a permanent `contract` failure, with the "split the pull request" guidance from `src/review/workerCompletion.ts`. After #891, the size failures that remain in practice are: more than 300 files on the completion side, more than 8 MB of worker diff, and missing patches that are not disclosed.

## 2. Goals and non-goals

Goals:

1. Each persona sees the smallest diff that still lets it do its job, ordered by risk.
2. Large PRs are reviewable instead of failing or overflowing context.
3. Re-reviews after a fix push cost proportionally to the fix, not the whole PR.
4. Every file that is not deeply reviewed is disclosed in the check summary. Nothing is dropped silently.
5. Jev (TypeSafe AI System One, `src/gateway/jevClient.ts`, landed in #860 and not yet wired) is used for typed triage decisions, measured in shadow mode before it affects any outcome.

Non-goals:

- Changing the execution substrate, the worker pod model, or the persona roster.
- Letting any model remove a source file from review on its own.
- Replacing the panel's reviewing models with Jev. Jev returns typed decisions only; it cannot write findings.

## 3. Safety invariants (apply to every work item)

These are the rules the implementation and its tests must pin.

1. **Deterministic exclusion only.** A file is excluded from review only by a deterministic rule (lockfile check from #993, generated/vendored markers, docs classification from #987, `path_filters`). Jev may add reviewers, reorder content, and allocate budget. Jev may never be the sole reason a source file is not reviewed.
2. **Prompt-injection resistance.** File content is untrusted input to the classifier. An attacker can write a file designed to be classified low-risk. Therefore a low Jev risk score may only reduce *depth* (full hunk vs summary) within disclosed limits, never remove a file, and a security-sensitive path list (auth, crypto, secrets, CI workflows, Dockerfiles, IaC, dependency manifests) always gets full depth regardless of score.
3. **Fail open to today's behaviour.** Jev unavailable, timeout, malformed answer, low confidence, or missing `TYPESAFE_*` config means the current pipeline runs unchanged (`jevTransport` already returns `null` when unconfigured, and `JevClient.ask()` returns a discriminated `unavailable` outcome instead of throwing).
4. **One decision, every path.** Any change to what is reviewed goes through `resolveReviewApplicability` (#987) or a sibling shared function, so the worker, both engines, and the trusted completion side cannot disagree. Disagreement is what broke completion acknowledgements (REL-1056).
5. **Disclosure.** The check summary lists: files reviewed in full, files reviewed as summaries or signatures, files excluded and by which rule, and any budget truncation.
6. **Flags, default off.** Every outcome-affecting behaviour is behind its own flag, default off, enabled per repository first.
7. **Negative proof (ADR 0641).** Each guard is shown failing against a planted violation.

## 4. Work items

### W1. Measurement baseline (read-only, first)

Build the numbers every later decision depends on. Sources: VictoriaLogs (worker and dispatch logs), Postgres review-run records, `PRReviewJob` status timing, gateway token metrics.

For the last 7 to 14 days, per review run: repository, files changed, lines added and removed, bytes of filtered diff, tokens in and out per persona lane, worker duration, cost, verdict, and the number and severity of findings per file category (source, test, config, docs, generated, lockfile, CI, IaC).

Answer:

- How does worker duration and cost scale with diff size? Where is the knee?
- Which persona lanes produce findings on which file categories? Which lanes are nearly always empty for which categories?
- How often do reviews hit the compare 300-file limit, patch truncation, or diff 406?
- Which parts of `docs/features/context_management.md` (±3 context lines, cluster splitting, model context discovery) are implemented in code today, and which are only designed?
- How many tokens go to re-reviewing unchanged files on `synchronize`?

Deliverable: `docs/superpowers/specs/2026-09-23-review-content-measurements.md` with tables and the queries used. No code changes.

### W2. Deterministic diff shrinking (flag `REVIEW_YETI_DIFF_SHRINK`)

Before any model sees the diff:

- Whitespace-only hunks are collapsed to a one-line note (`git diff -w` comparison per file; a file whose only change is whitespace is listed, not sent).
- Pure renames and moves are detected with `git diff -M -C` and shown as `old -> new (similarity N%)`; only the changed hunks of a modified rename are sent.
- `.gitattributes` `linguist-generated` and `linguist-vendored` are honoured as deterministic exclusions, alongside the existing generated and `dist/` rules.
- Formatter-only changes: if the repository declares a formatter check, a file that becomes identical after formatting both sides is listed as formatting-only.

Acceptance: the same review verdict and findings on a replay corpus of recent PRs with fewer tokens; disclosure lines present; tests with negative proof per rule.

### W3. Git-based diff source for large PRs (on by default for the 406 path)

The worker already materializes a worktree. The 406 path already has an API fallback on both sides (see section 1). Use the local clone (`git diff base...head`) for the cases that still fail or lose content: more than 300 files on the trusted-completion compare path, a worker diff over 8 MB, and files whose patch GitHub omits. Do not let those cases fail the review or drop files without disclosure. This removes the remaining size-based hard failures. It is a pure fallback path, so it can be on by default; the existing trusted-completion checks must accept a git-derived diff with the same identity guarantees (exact base and head SHAs, closed hunks).

Acceptance: a synthetic PR over 300 files and over 20k lines is reviewed end to end in a test; identity checks still reject a mismatched head.

### W4. Jev triage in shadow mode (flag `REVIEW_YETI_JEV_SHADOW`)

Wire `JevClient` into a triage step that runs before the panel, logs its decisions, and changes nothing.

Per changed file, ask three closed questions (Jev never generates text):

| Question | Type | Options |
| --- | --- | --- |
| Category | `choice` | `mechanical_rename`, `formatting`, `generated`, `test`, `config`, `docs`, `source_low_risk`, `source`, `security_sensitive` |
| Risk | `score` | 1 to 5, with written criteria per level |
| Lanes | `choice`, asked once per enabled persona as `noul` | "should persona P review this file" |

Inputs: path, extension, the file's hunks (bounded; oversize content is truncated by the triage step and the truncation is itself a signal), and deterministic facts computed in code (line counts, whether it is a test, whether it matches the security-sensitive list). Jev cannot count, so counts are passed as facts, never asked.

Record per file: answers, probabilities, confidence, latency, token cost (`JEV_INPUT_TOKEN_USD_PER_MILLION`), and the model pin (`TYPESAFE_MODEL_PIN`). After the panel finishes, join with the actual findings on that file.

Calibration questions for the shadow period (target: 7 days of traffic):

- Of files Jev scored risk 1 or 2, how many received P0 or P1 findings? This bounds how much depth reduction is safe.
- For each persona, of files Jev said "no", how many got findings from that persona? This bounds lane skipping.
- Confidence vs correctness curve, to set thresholds.

Operator action required: `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL_PIN` must be provisioned to the worker through the existing secret path. Until then, shadow mode is a no-op (fail open by design).

### W5. Risk-ordered token budget per persona (flag `REVIEW_YETI_BUDGET`, after W4 data)

Each persona gets a token budget sized to its model's safe diff capacity (context_management.md section 3). Content is packed in risk order: security-sensitive and high-risk files in full; then source; lower-risk files as function signatures and changed-symbol summaries (deterministic, from the AST compaction design, not model-written); files that do not fit are listed as "not deeply reviewed". Ordering may use Jev risk once calibrated; before that, deterministic category order.

### W6. Map-reduce review for huge diffs (flag `REVIEW_YETI_MAP_REDUCE`)

When the packed diff exceeds one persona budget, partition by module or directory into chunks, review chunks in parallel as separate lane calls within the same worker (bounded concurrency so the Bifrost 429 rate stays near zero), then run a reduce pass that deduplicates findings and checks cross-chunk consistency (an API changed in one chunk and used in another). The reduce pass sees only findings and the changed public signatures, not the full diff.

### W7. Incremental re-review on synchronize (flag `REVIEW_YETI_INCREMENTAL`)

On a new head for a PR that already has a completed review at an ancestor head: review only `previous_head...new_head` plus the hunks that carry open findings, and carry forward verdicts for unchanged files. Fall back to a full review when the previous head is not an ancestor (force-push), when the base moved in a way that changes the merge result of reviewed files, when policy or persona config digests changed, or when the previous review is older than a set age. The check summary states which files were carried forward.

### W8. Per-file verdict cache (flag `REVIEW_YETI_VERDICT_CACHE`, after W7)

Cache per-file lane results keyed by blob SHA, persona, persona prompt digest, policy digest, and model. A file whose key matches is not re-sent. Invalidate on any key change. Cross-file findings are not cached.

## 5. Rollout order and gates

1. W1 measurement, W3 git-based large-diff path, W4 shadow mode. Land now.
2. W2 deterministic shrinking. Enable on review-yeti-bot and ct-meta first; compare verdicts and tokens for a week.
3. W7 incremental re-review. Enable after W2 is stable.
4. W5 budget and W6 map-reduce, using W1 and W4 data to set budgets and thresholds.
5. W8 cache last.
6. Jev-driven lane skipping or depth reduction only if the W4 shadow data shows the miss rate below an agreed threshold, and never for security-sensitive files. That decision gets its own ADR in ct-meta.

Each enable is a per-repository flag change with a revert path, recorded in the PR.

## 6. Metrics to watch

- Worker duration p50 and p90, tokens per run per lane, cost per run.
- Findings per run by severity (must not drop for the same PR replay corpus).
- Disclosure counts: files summarized, excluded, carried forward.
- Jev: availability, latency, confidence distribution, shadow miss rates.
- Bifrost 429 rate (map-reduce adds parallel calls).

## 7. Open questions

- Is the TypeSafe AI account and model pin available for production traffic, and what is its data-handling policy for private source code?
- Which formatter checks can the worker run safely without executing repository code?
- Should carried-forward verdicts (W7) be allowed to satisfy a SHIP gate, or only reduce work while the gate still requires a fresh pass on changed files? Proposed: carried-forward results count, but any file with an open finding is always re-reviewed.

## 8. Tracking

Linear, team REL. The parent is related to REL-1033 (Review Yeti get-well).

| Item | Linear |
| --- | --- |
| Parent | REL-1077 |
| W1. Measurement baseline | REL-1078 |
| W2. Deterministic diff shrinking | REL-1079 |
| W3. Git-based diff source for large PRs | REL-1080 |
| W4. Jev triage in shadow mode | REL-1081 |
| W5. Risk-ordered token budget per persona | REL-1082 |
| W6. Map-reduce review for huge diffs | REL-1083 |
| W7. Incremental re-review on synchronize | REL-1084 |
| W8. Per-file verdict cache | REL-1085 |
