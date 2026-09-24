# Map-reduce review for huge diffs

Flag: `REVIEW_YETI_MAP_REDUCE` on the publishing worker, default off.
Plan: `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`, section 4 W6 (REL-1083).
Measurements: `docs/superpowers/specs/2026-09-23-review-content-measurements.md` (W1).
Builds on: `docs/features/review_budget.md` (W5, REL-1082).
Code: `src/review/mapReduceReview.ts`, `src/types/mapReduceReview.ts`. There are thin hooks in `src/panel/panelEngine.ts`, `src/panel/composedEngine.ts`, `src/cli/publishingReview.ts`, and the W5 seams in `src/review/reviewBudget.ts`.

## Enabling

| Value | Effect |
| --- | --- |
| unset, empty, `0`, `false`, `off` | Off. Every lane is one call, as today. |
| `1`, `true`, `on`, `all` | On for every repository. |
| `owner/repo,owner/other` (comma or space separated) | On only for the listed repositories (case-insensitive). |

The worker reads the variable from its own environment. In Kubernetes, set `REVIEW_YETI_MAP_REDUCE` on the operator Deployment (Helm: `publishing.mapReduce`, empty by default). The operator forwards a non-empty value verbatim to app-gate worker Jobs only, together with `REVIEW_TERMINAL_DEADLINE`, the review's terminal deadline in RFC 3339. Receipt-only Jobs get neither. A value containing a line break refuses app-gate Jobs. To revert, remove the variable or set it to empty and let the operator roll.

The trigger is `REVIEW_YETI_MAP_REDUCE_MIN_CHARS` (Helm: `publishing.mapReduceMinChars`, empty by default). The operator forwards a non-empty value verbatim to app-gate workers, only when `REVIEW_YETI_MAP_REDUCE` is also set. The worker reads a positive integer number of characters (underscores allowed). A value below one lane budget is raised to 56,000. Anything else uses the default, 160,000.

The flag is independent of `REVIEW_YETI_BUDGET`. With both on, a lane over the trigger is chunked, and every other lane keeps its W5 pack.

## When a lane is chunked

A lane is chunked only when its files together cost more than the trigger (`DEFAULT_MAP_REDUCE_MIN_CHARS`, 160,000 characters by default), counted the way the W5 budget counts them. Chunks are still sized at one lane budget (`PERSONA_BUDGET_CHARS`, 56,000 characters, the W1 inline knee). A lane between the budget and the trigger is one call. With `REVIEW_YETI_BUDGET` on, W5 packs it (security and CI files in full, then signatures, with the reductions disclosed). A lane made of one file that cannot be split, or one that would not make two chunks, is also one call.

Why the default is the W5 hard cap (`MAX_PACKED_DIFF_CHARS`, 160,000 characters) and not the budget:

- 160,000 characters is the most one budgeted call carries inline. Below it, one W5 pass holds the whole lane at some depth. Past it, even full-depth security and CI files start to be listed instead of sent.
- W1 (`2026-09-23-review-content-measurements.md`, section 2.3): one pass past the 56 KB knee costs a median 8 turns and 295 s at 56 to 128 KB, and 13 turns and 470 s at 128 to 256 KB. Every chunk is a full lane call (about 240 s in W1 terms), and the reduce pass is another call on top.
- REL-1077 pilot: review-yeti-bot#1033, just over the budget at about 13.8k estimated tokens, split 4 lanes into 8 chunks and 4 reduce passes. It took 471 s and 36 turns. The previous head, about the same size, took 285 s and 8 turns in one pass. On the same pilot, W5 alone packed ct-meta#3414 (about 66k characters per lane) in one pass and found a real P1.

**Chunk bounds.** A lane over the trigger always makes at least two chunks. A planned chunk under a quarter of a budget (`MIN_CHUNK_CHARS`, 14,000) is merged into its smaller neighbour, as long as the merged chunk stays within 70,000 characters (`MAX_MERGED_CHUNK_CHARS`, one budget plus the floor). The two parts of a split file are never merged. So a lane just past a boundary is not reviewed as a full chunk plus a sliver that costs a whole lane call. If merging leaves one chunk, the lane is one call.

Only the persona panel chunks. Production app-gate reviews always run the panel (`authoritative` forces it). The composed engine plans one context, so it does not chunk. It makes the same shared decision and, when its context is over the trigger, the check summary says it was not chunked.

## Map

1. **Partition by directory.** The lane's files are sorted by path and grouped by directory. A directory is split into its subdirectories only while it is larger than the budget. Neighbouring groups are then packed next-fit into chunks of at most one budget. The partition depends only on paths and patch sizes, never on content.
2. **Split oversized files at hunk boundaries.** A file larger than the budget is split between hunks (`splitOversizedFileHunks`, from `shaPartitionManager`). Each part keeps its hunk headers, so line numbers are exact. A single hunk larger than the budget stays whole in its own chunk, sent in full up to the 160,000-character hard cap and packed by the W5 budget past it.
3. **One lane call per chunk.** Each chunk is an ordinary lane call inside the same worker. It inlines only its own files, in full. A file past the 20k per-file cut is sent whole. Every other file of the lane stays in the call's file list, readable with `get_diff`, so a chunk can check the callers of an API it changed. A scope note tells the call which chunk it is, which files it holds, and which parts of split files.
4. **Bounded concurrency.** At most 3 chunk calls are in flight across the whole panel run (`DEFAULT_MAP_REDUCE_CONCURRENCY`, also the ceiling). Chunk calls share one limiter, so two chunked lanes still make at most 3 chunk calls at once. A chunked lane holds its panel slot while its chunks run, so a run has at most 3 chunk calls plus one call per unchunked lane in flight: at most 6, against 4 today, and only when a lane is over budget. W1 counted 184 HTTP 429 responses in 19,015 Bifrost requests with the panel's 4 concurrent lanes. A chunk that fails with a rate-limit or transport class is retried once after 10 s, when time allows.
5. **At most 12 chunks per lane** (`MAX_CHUNKS_PER_LANE`). The files of later chunks are collapsed into the last chunk, which is packed by the W5 budget: files that do not fit are sent as signatures or listed, never dropped.

## Reduce

After the chunks finish, the lane's findings are merged:

1. **Exact duplicates** (same path, line and title) are merged in code. The kept finding takes the highest severity.
2. **The reduce pass** is one JSON-mode call on the lane's own model. It sees only:
   - the findings, each with an id (bodies clipped);
   - the changed public signatures of every chunk (exported TypeScript and JavaScript declarations, capitalized Go names, `pub` Rust items, public Python, Elixir, Java, Kotlin and C# declarations), each with its side and line;
   - the added lines in other chunks that name those symbols.

   It never sees the full diff. Its request is capped at 240,000 characters.
3. **Its answer is validated in code.** A merge must name two known findings on the same path within 10 lines. A new finding must name a provided new-side anchor. Code sets its path and line from the anchor, so a model cannot invent a location. The answer must echo the request nonce. Everything else is rejected and counted in the summary.
4. **The lane result** keeps the lane's own id. Findings are capped at 400, the completion side's per-lane limit, lowest severity first. Usage, turns and tool calls are summed over the chunks and the reduce call.

## Deadline

The worker knows its terminal deadline when the operator forwards `REVIEW_TERMINAL_DEADLINE`. The Job is killed 60 s before it. Map-reduce keeps another 60 s for publishing, so it plans to finish 120 s before the terminal deadline, or at the panel's own deadline if that is earlier.

- **Before starting**, a lane gets at most `floor((time left - 120 s) / 240 s) x 3 / chunked lanes` chunk calls. The 240 s estimate per call is the W1 median worker time for a diff of one chunk's size. Chunks past that are collapsed into one packed chunk.
- **While running**, when the next chunk would start with less than 240 s plus the 120 s reduce reserve left, every chunk still queued is collapsed into one packed chunk.
- **The reduce pass** is skipped when less than 30 s is left. Its call times out after at most 120 s.

## Safety (plan section 3)

- **Deterministic only.** Chunks come from paths and sizes. File content selects signature lines for the reduce pass, but it never changes a file's chunk, order or depth.
- **Nothing removed.** Every file of a chunked lane is in some chunk's inline diff, and every chunk can read every file of the lane. A collapsed chunk summarizes or lists, and it discloses that.
- **One decision.** `resolveMapReduceReviewApplicability` wraps `resolveBudgetedReviewApplicability` and returns its lanes, exemption, unmatched paths, routed files, omitted patches and effective files unchanged. A chunked lane returns one result under its own id, so the roster and coverage are what the trusted completion side already expects. A chunked lane's W5 pack is replaced by its chunk packs. Other lanes keep theirs.
- **Fail open.** Flag off, a lane at or below the trigger, or the composed engine: one call, as today. A reduce pass that fails, times out or answers badly keeps every chunk finding. Only exact duplicates are merged, and the summary says so. A chunk that fails, after at most one retry, fails the lane closed, exactly like today's single call failing.
- **Disclosure.** The check summary lists, for every chunked lane that ran: its chunks and their directories, files split by hunk, collapsed chunks and why, files a collapsed chunk only summarized or listed, the finding counts (from chunks, exact duplicates, merged by the reduce pass, cross-chunk, rejected, capped), and what the reduce pass did. It also lists a composed context that was not chunked. The REL-1092 "Truncated patches" list drops a file only when every lane that ran and is scoped to it got it whole or at a disclosed depth.
- **Jev.** Not used.

## Known limits

- The composed engine does not chunk (follow-up). Production app-gate reviews run the panel.
- Signature extraction is line-based. A declaration split across lines keeps only its first line, and a call site is matched by name only.
- Two chunked lanes share the 3-call limiter, so a PR with several huge lanes takes more waves. The deadline cap accounts for that.
