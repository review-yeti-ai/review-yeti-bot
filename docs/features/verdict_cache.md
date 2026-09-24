# Per-file verdict cache

Flag: `REVIEW_YETI_VERDICT_CACHE` on the publishing worker, default off.
Plan: `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`, section 4 W8 (REL-1085). Builds on W7, `docs/features/incremental_review.md`.
Code: `src/review/verdictCache.ts` (keys, the decision, the engine step, the stored record, verification), `src/review/verdictCacheClaim.ts` (the completion field), `src/persistence/verdictCacheSource.ts` (the source record), `src/review/verdictCacheBaseHttp.ts` and `src/api/verdictCacheBaseRoute.ts` (the worker's planning read), `src/review/authoritativeCompletionContext.ts` (trusted verification).

W1 measured that 76 percent of the diff bytes on re-review heads had not changed since the previous reviewed head. W7 stops re-sending those files when the new head descends from the reviewed one. The verdict cache is keyed by content instead, so it also applies after a force-push, a rebase or a moved base, and it is checked lane by lane.

## Enabling

| Setting | Where | Effect |
| --- | --- | --- |
| `REVIEW_YETI_VERDICT_CACHE` unset, empty, `0`, `false`, `off` | worker | Off. Nothing is served from or written to the cache. |
| `REVIEW_YETI_VERDICT_CACHE` `1`, `true`, `on`, `all` | worker | On for every repository. |
| `REVIEW_YETI_VERDICT_CACHE` `owner/repo,owner/other` | worker | On only for the listed repositories (case-insensitive). |
| `REVIEW_YETI_VERDICT_CACHE_MAX_AGE_HOURS` | dispatch service | The oldest source record a cache hit may rest on, from 1 to 720 hours. Default 72. This setting is separate from W7's age limit. |

In Kubernetes, set `REVIEW_YETI_VERDICT_CACHE` on the operator Deployment. In Helm the value is `publishing.verdictCache`, which is empty by default. The operator passes a non-empty value unchanged to app-gate worker Jobs only. If the value contains a line break, the operator refuses to create app-gate Jobs. To turn the cache off, set the value back to empty and let the operator restart.

The flag is independent of `REVIEW_YETI_INCREMENTAL`, and the two can run together. W7 runs first. The cache never serves a file W7 already carried forward.

## Where the cache lives

The cache has no table of its own and needs no new infrastructure. Each completion carries an optional `result.verdictCache` field, which is stored in the existing `review_worker_completions` row and covered by that row's content digest. The field has two parts:

- `entries`: the files this run's lanes reviewed with no finding at all. Each entry records the file's content key and view digest, and which lanes reviewed it.
- `hits`: the files this run did not send because a named earlier record already covered them.

A run reads the cache from exactly one record: its pull request's latest completion that was stored before the run was admitted. This is the same record W7 uses, chosen by the same query (`selectPriorReviewRows`). The query is filtered by repository id and pull request number, so a cache entry can never cross repositories. The worker never chooses the record.

## Keys

A file is served from the cache only when every one of these keys matches:

| Key | What it covers |
| --- | --- |
| Content key | The repository id, path, previous path, status, head blob SHA and the SHA-256 of the complete merge-base patch. All of these come from GitHub's compare API at exact SHAs. The head blob and the complete patch together fix both the head content and the merge-base content, so any change to the file's content changes the key. A file without a complete patch (binary, or omitted or truncated by GitHub) gets no key and is never cached. |
| View digest | The SHA-256 of the patch text the lanes actually received, after diff shrinking (W2). If shrinking produces a different result, the view is different. |
| Lane key, one per persona | The persona id, a prompt digest (the effective charter plus any dashboard override), the configured provider models, the policy digest, the config digest, the review engine, the worker version and the view flags (diff shrink, incremental, the review budget, and the future map-reduce flag). |
| Routing | Every lane that the shared applicability decision routes the file to in this run must have reviewed the file in the source, and each of those lanes must have the same lane key. |

A different value for any key is a cache miss.

## What is recorded

A file is recorded only when all of these are true:

- No lane reported a finding on the file, of any severity.
- Every lane routed to the file completed. A lane skipped by gating or a lane that failed does not count.
- No routed lane reported a cross-file finding. That means an architectural finding, or a finding on a path outside the diff.
- The file was sent whole, as a regular file: not truncated, not a gitlink, not a symlink.
- No lane received the file at reduced depth under the review budget (W5, `REVIEW_YETI_BUDGET`): as signatures only, truncated, or listed as not deeply reviewed.

Findings themselves are never cached. A file served from the cache is recorded again under the lanes routed to it in the current run, so a later run can reuse it. Each reuse must still pass every check, including the age limit.

## Full-review fallbacks

In every case below, the review runs as it does today. No file is served from the cache. The run still records entries whenever its own comparison was readable.

| Reason | Condition |
| --- | --- |
| `no-prior-review` | The pull request has no earlier stored completion. |
| `retry-attempt` | This is any execution attempt after the first. Retrying is also how the service recovers from any problem with the cache. |
| `same-head` | The source record reviewed this same head. |
| `prior-not-ship-complete` | The source run did not succeed, or it was not a complete SHIP. |
| `policy-or-config-changed` | The policy digest or the config digest changed. |
| `prior-too-old` | The source record is older than the configured age. |
| `no-cache-entries` | The source record has no entries. |
| `comparison-incomplete` | A comparison lists 300 files, which is GitHub's cap, so the list may be cut. |
| `nothing-cached` | No entry matched on content, finding state and lanes. |
| `error` | A read or planning step failed, or planning passed its 15-second deadline. |

The engine also sends every file in full when serving the cache would leave nothing to review.

## One decision

`decideVerdictCache` is the only function that decides which stored entries may be served. The engines apply that decision through `resolveCachedReviewApplicability`. This step runs after the shared `resolveReviewApplicability` decision, after diff shrinking and after W7's incremental scope, and before W5's review budget, so the budget packs a file served from the cache as its one-line note. It replaces only patch text, so the lanes, the exemptions and the unmatched-path failures stay exactly what the trusted completion side derives. The engines and the trusted side both run the same routing check, `verdictCacheLanesPermit`.

## SHIP gate and trusted verification

Verdicts served from the cache count toward the SHIP gate. On the authoritative path, the service checks `result.verdictCache.hits` before any served verdict counts:

1. Inside the completion transaction, the service selects the source record itself (`selectVerdictCacheSource`). It recomputes the record's content digest and checks that the record is bound to the right run.
2. The hits must name exactly that record: the same run id, execution attempt and completion digest.
3. The service runs `decideVerdictCache` again against its own GitHub comparisons of this run and of the source run, both at exact SHAs. That is how it confirms each stored content key, instead of trusting the stored value.
4. Every served file must be an entry the decision permits. The lanes the service's own applicability decision routes that file to must all be covered, with unchanged lane keys. Serving fewer files than permitted is allowed. Serving more is not.

`deriveCanonicalWorkerReviewEvidence` refuses a completion that served any file without this verification, or that names a file outside the trusted changed set. The gate then fails with `invalid-evidence`, and the retry is a full review. A GitHub read failure during verification is treated as transient (HTTP 503 to the worker) and is never treated as verified. A completion that only records entries needs no verification, because entries are checked when a later run uses them.

On the legacy check-only path, the worker publishes its own check. The record is stored with the evidence, and no service verification runs.

## Disclosure

When the flag is on, the check summary gets a **Verdict cache** block. It names the source run and head, the estimated diff tokens before and after, every file served from the cache and every file reviewed in full. It also gives the number of files recorded for later reuse. When no file was served, the block says why. Each list shows at most 15 entries, followed by a "+N more" count. The worker writes two log lines, `Verdict cache planned` and `Verdict cache applied`, and both contain counts only.

## Costs

When the flag is on, every run makes one extra GitHub compare read to key its own files. A run that serves files makes one more read for the source's comparison. The trusted side makes the same two reads when it verifies served files. A completion's record is bounded to 300 entries, and paths longer than 1,024 characters are never cached.

## Follow-ups

- Granularity. The cache serves a file only when every lane routed to it hits. A lane-by-lane partial hit, where one lane re-reads the file and another does not, would need a separate diff for each lane in the engines.
- Worker version in the lane key. Every release invalidates the whole cache. That is a safe stand-in for "the prompt templates may have changed", but it lowers the hit rate right after a deploy.
- Files carried forward by W7 are not recorded as cache entries in that run, because the lanes did not see them.
- The source is one record per run. Reusing entries from older records, or from other pull requests in the same repository, would need a bounded multi-record selection and one extra comparison read per record.
