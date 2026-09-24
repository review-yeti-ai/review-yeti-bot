# Review Yeti: review content measurement baseline (W1)

Date: 2026-09-23
Status: measurement, read-only. No code or configuration was changed to produce it.
Work item: W1 of `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md` (REL-1078).
Window: 2026-09-17T00:00Z to 2026-09-24T00:00Z (7 days). VictoriaLogs holds nothing older than 2026-09-17 for `ct-review-system`, so the 14-day option was not available.

## 0. Summary

| Question | Answer |
| --- | --- |
| How do worker time and tokens scale with diff size? | Tokens grow roughly linearly with the filtered diff: about 25k fixed plus about 700 tokens per KB on the current model. Worker time has a floor of about 100 s even for tiny diffs. |
| Where is the knee? | At about **56 KB of filtered diff**, which is the inline diff budget (`DEFAULT_INLINE_DIFF_TOKEN_BUDGET` = 14,000 tokens × 4 chars). Past it, files are indexed instead of inlined. Turns go from 5 to 8, then 13, then 19, and median worker time from 201 s to 295 s, then 470 s. |
| Which lanes find what, per file category? | **Per-lane attribution is not available** from any source I could reach (section 3). Per file category: source, CI, and IaC files draw 25 to 36 findings per 100 files. Tests, docs, and config draw 8 to 10. Lockfile and generated files draw almost none. |
| How often do reviews hit size limits? | Compare 300-file cap: 0 runs. GitHub diff HTTP 406: **29 runs on 24 cisco-cdr PRs**, every one a hard failure. Per-file patch over 512 KB: 5 runs. The **20,000-character per-file truncation in `hunkFilter.ts` hit 174 runs (698 file instances)**, and no check summary disclosed it. |
| What of `context_management.md` is real? | Only lockfile/generated stripping runs in production. The ±3 context and cluster splitting you get today come from GitHub's own unified diff, not from the compactor. Model context discovery, safe-capacity math, SHA partitioning, and `TurnHistoryManager` are wired only into the evaluation harness. The production turn-window compaction exists but is off. |
| Tokens spent re-reviewing unchanged files on `synchronize` | 527 re-review heads used 40.6M tokens. 76 percent of their filtered diff bytes were unchanged since the previous reviewed head. Estimated waste is **about 9M tokens** (marginal model), with an upper bound of 26M (proportional model). That is 10 to 29 percent of all review tokens in the window. |

## 1. Sources and what each could provide

| Source | Access used | Provides | Gaps |
| --- | --- | --- | --- |
| VictoriaLogs (`observability/victoria-logs-server:9428`) | Local port-forward, LogsQL, read-only | One row per worker pod: run id, repo, PR, head SHA, verdict, blocking count, first and last log time. Failure error text. Per-lane failure and gating lines. | No diff size, no per-lane tokens, no per-finding lane. |
| GitHub check runs (`Review Yeti`, apps `review-yeti` and `ct-review-bot`) | `gh api graphql`, read-only | Per head: verdict, finding count, blocking count, and the text list of findings with severity and path. Telemetry line with turns, tool calls, total tokens, and lane count. Coverage line. Resolved model. | Only the latest check run per head. No per-lane tokens. Findings are not attributed to a lane. |
| Git (bare, blobless clones of all 18 repos with `refs/pull/*/head`) | `git diff` locally | Files, lines, bytes, and per-file patch size per reviewed head, computed from the merge base of the base branch tip at run time. | Approximates GitHub's diff. Checked against the `PRReviewJob` `spec.baseSha` on the 25 overlapping runs, and 25 of 25 merge bases matched. |
| `PRReviewJob` status timing | `kubectl get prreviewjobs -o json` | receivedAt, processStartedAt, completedAt for the 101 CRs still in the cluster (2026-09-23T08:21Z onward). | TTL removes older CRs, so it cannot cover 7 days. |
| VictoriaMetrics (`victoria-metrics-server:8428`) | PromQL, read-only | Bifrost counters per virtual key `review-yeti`: tokens, cache reads, cost, requests, errors. Operator job-duration histograms. | `review_yeti_tokens_total` and `review_yeti_lane_outcome_total` carry no lane or run labels, and their 7-day increase is 0, because worker pods are not scraped. |
| Postgres (`review_runs`, `review_worker_completions`) | **Not reached** | Per the schema, `review_worker_completions.payload.result.personas[]` holds per-lane `telemetry.totalTokens` and per-lane `findings[]` with `severity` and `path`. That is exactly what the lane questions need. | The only connection path is the `DATABASE_URL` secret on the dispatcher. Work-item scope forbids reading secrets, so no query was run. Section 3.3 gives the read-only SQL for an operator. |

## 2. Worker duration, tokens, and cost versus diff size

### 2.1 Population

| Measure | Value |
| --- | --- |
| Review runs (distinct run ids) | 2,024 (2,114 worker pods; 62 runs had more than one pod) |
| Repositories / PRs | 18 / 1,133 |
| Runs with a head SHA in logs | 1,658 |
| Distinct reviewed heads with check telemetry | 1,492 |
| Verdicts (worker log) | SHIP 1,446 · BLOCK 110 · FIX_FIRST 92 · none 376 |
| Tokens reported by checks, 1,492 heads | 88.7M total; p50 45.7k, p90 116.8k, max 244.8k per run |
| Lanes per run (check telemetry) | 1: 110 · 2: 625 · 3: 163 · 4: 464 · 5: 129 · 6: 1 |
| Resolved model | deepseek-v4.1-flash-flex 864 · glm-5.3-flash 496 · deepseek-v4.1-flash 73 · other or unreported 59 |

The window spans a regime change. Until 2026-09-18 runs used glm-5.3-flash with four lanes. From 2026-09-19 onward runs use deepseek-v4.1-flash-flex, and the calltelemetry repos use the composed engine with `arch-lane`, `sec-lane`, and `documentation` (read from `spec.preparedReview` on the live CRs). Mixing the two regimes hides the size relationship. Across all runs, the Spearman correlation between tokens and worker time is -0.02. Within a single model it is 0.52 (deepseek) and 0.46 (glm). Tokens against filtered KB within a model is 0.83. Section 2.2 therefore reports each model separately.

"Filtered diff" means the production rule set in `src/pipeline/hunkFilter.ts`: lockfiles and generated paths removed, and each remaining patch capped at 20,000 characters. It does not apply repository `path_filters`, but every live prepared config has `path_filters: []`.

### 2.2 Scaling tables

Current regime: deepseek-v4.1-flash-flex, 864 reviewed heads.

| Filtered diff KB | Heads | Median changed lines | Tokens p50 | Tokens p90 | Tokens per lane p50 | Lanes p50 | Turns p50 | Tool calls p50 | Worker s p50 | Worker s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 to 2 | 166 | 6 | 12,608 | 25,836 | 8,872 | 2 | 2 | 0 | 105 | 195 |
| 2 to 8 | 205 | 45 | 22,909 | 35,769 | 9,868 | 2 | 4 | 1 | 139 | 372 |
| 8 to 16 | 177 | 127 | 30,796 | 46,604 | 13,641 | 2 | 3 | 1 | 135 | 381 |
| 16 to 32 | 125 | 361 | 47,546 | 87,696 | 17,872 | 3 | 5 | 2 | 184 | 525 |
| 32 to 56 | 77 | 724 | 61,234 | 113,990 | 23,560 | 3 | 5 | 2 | 201 | 479 |
| 56 to 128 | 75 | 1,630 | 80,573 | 145,389 | 29,011 | 3 | 8 | 5 | 295 | 517 |
| 128 to 256 | 8 | 2,317 | 85,380 | 101,707 | 26,654 | 3 | 13 | 10 | 470 | 785 |
| over 256 | 31 | 15,204 | 106,514 | 131,504 | 33,098 | 3 | 19 | 16 | 430 | 874 |

Earlier regime: glm-5.3-flash, 2026-09-17 to 09-18, 496 reviewed heads.

| Filtered diff KB | Heads | Median changed lines | Tokens p50 | Tokens p90 | Tokens per lane p50 | Lanes p50 | Turns p50 | Tool calls p50 | Worker s p50 | Worker s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 to 2 | 108 | 6 | 45,788 | 83,210 | 22,647 | 2 | 6 | 4 | 49 | 76 |
| 2 to 8 | 162 | 41 | 91,382 | 99,773 | 23,323 | 4 | 13 | 9 | 50 | 82 |
| 8 to 16 | 72 | 130 | 103,766 | 121,223 | 25,434 | 4 | 17 | 13 | 59 | 128 |
| 16 to 32 | 78 | 326 | 111,344 | 123,081 | 26,277 | 4 | 20 | 16 | 62 | 131 |
| 32 to 56 | 45 | 776 | 126,199 | 136,235 | 27,244 | 4 | 23 | 19 | 93 | 159 |
| 56 to 128 | 14 | 1,432 | 141,896 | 173,982 | 35,474 | 4 | 30 | 26 | 76 | 176 |
| 128 to 256 | 10 | 7,466 | 176,855 | 206,190 | 35,371 | 5 | 29 | 24 | 145 | 197 |
| over 256 | 7 | 13,860 | 200,010 | 233,669 | 40,002 | 5 | 29 | 24 | 122 | 164 |

Linear fits on heads at or below 256 KB (tokens against filtered KB):

| Model | Tokens per run | Tokens per lane |
| --- | --- | --- |
| deepseek-v4.1-flash-flex | 24,590 + 715 × KB | 10,719 + 210 × KB |
| glm-5.3-flash | 76,357 + 701 × KB | 23,388 + 87 × KB |
| All | 44,915 + 680 × KB | 15,848 + 146 × KB |

### 2.3 Where the knee is

- Below about 8 KB, fixed cost dominates. That is a worker floor of about 100 s (clone, Zoekt build, provider latency) and 12k to 23k tokens, whatever the diff size.
- From 8 KB to 56 KB, tokens per lane grow linearly and turns stay flat at 3 to 5. The diff is inlined as tier A.
- **Above 56 KB the loop changes.** 56,000 characters is `MAX_INLINE_DIFF_CHARS_CEILING` (`src/panel/panelEngine.ts`, 14,000 tokens × 4). Past that ceiling, files move from inline to the on-demand `get_diff` index, as tier B. Turns climb from 5 to 8, 13, and 19. Tool calls climb from 2 to 5, 10, and 16. Median worker time goes from 201 s to 295 s, then 470 s. Tokens per run grow more slowly, but time grows faster, because every `get_diff` turn is a full round trip.
- W5 budgets should be sized around this 56 KB inline ceiling, not around the model's context window.

### 2.4 Worker time from `PRReviewJob` status and the operator histogram

| Measure | n | p50 | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| CR queue, receivedAt → processStartedAt (101 CRs, from 2026-09-23T08:21Z) | 98 | 12 s | 201 s | 476 s |
| CR worker, processStartedAt → completedAt | 96 | 96.5 s | 281.5 s | 1,678 s |
| CR end to end, receivedAt → completedAt | 96 | 137 s | 381 s | 1,740 s |
| Worker log span, all 2,024 runs, 7 days | 2,024 | 101 s | 356 s | 1,148 s |
| Operator `review_yeti_operator_job_duration_seconds`, 7 days (bucket-interpolated) | 2,923 observations | ~99 s | ~401 s | p99 ~1,401 s |
| Operator `…webhook_to_completion_duration_seconds`, 7 days | | ~131 s | ~536 s | p99 ~1,429 s |

The log span, meaning the first to last worker log line, tracks CR worker time to within a few seconds on the overlapping runs. It is used as "worker s" above. The operator histogram count is larger than the pod count, so it probably double counts across scrape targets. Use it for shape only.

CR phases at collection time: Succeeded 50, Failed 41, Running 7, Queued 3 (2 `CapacityExceeded`, 1 `WorkspaceBusy`).

### 2.5 Cost

| Measure (Bifrost, `virtual_key_name="review-yeti"`, 7 days) | Value |
| --- | --- |
| Input tokens | 316.7M, of which 211.4M were cache reads (66.7 percent) |
| Output tokens | 18.6M |
| Metered cost (`bifrost_cost_total`) | USD 16.08: ollama 12.81, neuralwatt 3.23, gemini 0.05, vllm 0 |
| Blended metered rate | USD 0.048 per 1M tokens |
| Successful / error requests | 19,015 / 897 (HTTP 429: 184) |

Per-run metered cost is negligible at this rate: p50 about USD 0.001 to 0.005. The real cost is pool capacity and GPU time on providers that report no cost (vllm) or a flat rate, and the metrics do not measure that. **Per-run cost in dollars is therefore not a useful signal today. Tokens and worker seconds are the cost measures to optimise.**

The gateway counted 335M tokens, but the check telemetry counted only 88.7M. The rest is split across failed runs (376 with no verdict), superseded or retried runs, runs whose check was overwritten by a later run on the same head, composed-engine planning calls, and any other caller of the same virtual key. The available data cannot split it further. The per-run `review_worker_completions` rows in section 3.3 would close most of that gap.

### 2.6 Runs that produced no verdict

| Cause (from worker failure log) | Runs |
| --- | ---: |
| Worker completion callback HTTP error | 47 |
| GitHub projected PR identity mismatch | 46 |
| Provider quota or usage limit | 43 |
| Gateway routing: no keys for provider/model | 40 |
| GitHub diff HTTP 406 (diff too large) | 29 |
| Composed review plan rejected | 27 |
| Other required-lane provider failure | 24 |
| Completion not acknowledged | 23 |
| Worker contract invalid | 21 |
| No persona applies to changed paths | 20 |
| Provider connection failure | 15 |
| No failure line (superseded, cancelled, or running at window end) | 11 |
| HTTP 503 (GitHub or provider) | 9 |
| Other | 9 |
| Quorum failure | 4 |
| Prepared review identity mismatch | 4 |
| Panel cancelled | 4 |

## 3. Persona lanes versus file categories

### 3.1 What could be measured: findings per file category (all lanes combined)

Files were categorised with the deterministic rules in section 6.3. Findings come from the `Review Yeti` check text, which lists each post-arbitration finding with its severity and path. 2,319 of 2,322 findings parsed.

| File category | Files in reviewed diffs | Findings | P0 | P1 | P2 | Findings per 100 files | P0+P1 per 100 files |
|---|---:|---:|---:|---:|---:|---:|---:|
| source | 3,725 | 1,346 | 0 | 72 | 1,274 | 36.13 | 1.93 |
| test | 3,026 | 237 | 0 | 1 | 236 | 7.83 | 0.03 |
| config | 675 | 64 | 0 | 0 | 64 | 9.48 | 0.00 |
| docs | 1,294 | 100 | 0 | 6 | 94 | 7.73 | 0.46 |
| ci | 366 | 98 | 0 | 7 | 91 | 26.78 | 1.91 |
| iac | 1,869 | 471 | 1 | 26 | 444 | 25.20 | 1.44 |
| generated | 94 | 2 | 0 | 0 | 2 | 2.13 | 0.00 |
| lockfile | 183 | 1 | 0 | 0 | 1 | 0.55 | 0.00 |

By PR composition:

| PR composition | Heads | Heads with any finding | Heads with P0/P1 | Tokens p50 |
|---|---:|---:|---:|---:|
| mixed, contains source | 608 | 426 | 66 | 72,362 |
| mixed, no source | 303 | 142 | 11 | 37,244 |
| iac only | 249 | 125 | 14 | 44,900 |
| lockfile only | 115 | 1 | 0 | 9,963 |
| source only | 83 | 43 | 2 | 49,793 |
| ci only | 50 | 17 | 1 | 41,670 |
| docs only | 49 | 6 | 1 | 11,507 |
| test only | 20 | 9 | 0 | 35,444 |
| config only | 13 | 2 | 0 | 17,289 |

What this shows:

- Tests yield 1 blocking finding in 3,026 files. Config yields none in 675. Both are candidates for summary depth under W5, but only after W4's per-lane shadow data. Tests remain in the security-sensitive list when they touch auth or CI.
- CI and IaC files yield blocking findings at about the same rate as source, 1.4 to 1.9 per 100 files. This supports the plan's rule that they always get full depth.
- The 115 lockfile-only heads, about 10k tokens each, predate #993, which merged 2026-09-23 and now exempts them. Expect that line to go to zero.

### 3.2 What could not be measured: findings and tokens per lane

**Not available.** The data gap:

- The check text does not say which lane raised a finding.
- The worker logs a finding's severity but not its lane. The `category` field on "Learned new global platform pattern" is a severity mapping (`P0→security`, `P1→architecture`, `P2→quality`, `src/memory/graphLearningEngine.ts`), not the lane.
- The check telemetry gives total tokens and lane count only. `renderFailedLanesSummary` prints per-lane usage only for lanes that failed.
- Worker pods are not scraped, so `review_yeti_lane_outcome_total` has no labels and no increase.

Partial lane signals from worker logs (7 days):

| Lane | Pods mentioning the lane | "Normalized APPROVE with validated findings to FINDINGS" | "Lane failed closed" | `PanelConfigurationError` persona failures | Gated skip |
|---|---:|---:|---:|---:|---:|
| sec-lane | 151 | 24 | 11 | 140 | 18 |
| arch-lane | 146 | 10 | 14 | 138 | 0 |
| qual-lane | 100 | 11 | 7 | 96 | 0 |
| perf-lane | 81 | 3 | 1 | 88 | 1 |
| policy-lane | 35 | 3 | 0 | 33 | 0 |
| dep-lane | 10 | 1 | 1 | 8 | 0 |

A proxy with lane attribution: the separate GitHub Actions review pipeline ("Execute AI Review Pipeline") posts inline threads that end with `**Reported by:** <persona>`. It ran on 12 review-yeti-bot PRs in the window and produced 144 threads. Its roster differs from the DOKS app lanes, so treat this table as an indication, not a baseline.

| Persona (Actions pipeline) | Findings | source | test | other categories | P0 | P1 | P2 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Testing & Quality Assurance | 76 | 52 | 24 | 0 | 0 | 5 | 71 |
| System Architecture & Design | 43 | 41 | 2 | 0 | 0 | 2 | 41 |
| Security & Tenancy Guardian | 17 | 17 | 0 | 0 | 1 | 4 | 12 |
| Performance & Scalability Specialist | 4 | 4 | 0 | 0 | 0 | 1 | 3 |
| Dependency Safety & Supply Chain | 4 | 4 | 0 | 0 | 2 | 2 | 0 |

In this proxy, performance and dependency personas produced 8 of 144 findings. That is consistent with the 2026-09-18 observation that perf-lane is mostly empty. The proxy has no denominator, so it cannot show how often each persona ran empty.

### 3.3 Read-only SQL to close the gap (operator to run; not executed here)

Run against the Review Yeti database with a read-only role. `review_worker_completions.payload` is a `WorkerReviewCompletion.v1` or `WorkerReviewEvidence.v1` document whose `result.personas[]` carries `id`, `decision`, `findings[]` with `severity` and `path`, and optional `telemetry` with `totalTokens`, `promptTokens`, `completionTokens`, `cachedTokens`, `turnsCount`, and `durationMs` (`src/review/workerReviewCompletion.ts`).

```sql
-- Per-lane tokens, turns, duration and empty rate, last 7 days.
SELECT p->>'id'                                   AS lane,
       count(*)                                    AS lane_runs,
       count(*) FILTER (WHERE jsonb_array_length(p->'findings') = 0) AS empty_runs,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (p->'telemetry'->>'totalTokens')::bigint) AS tokens_p50,
       sum((p->'telemetry'->>'totalTokens')::bigint) AS tokens_total,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (p->'telemetry'->>'durationMs')::bigint)  AS duration_ms_p50
FROM review_worker_completions c
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.payload->'result', c.payload)->'personas') p
WHERE c.created_at >= now() - interval '7 days'
GROUP BY 1 ORDER BY tokens_total DESC NULLS LAST;

-- Per-lane findings by path (join paths to the category rules in section 6.3 offline).
SELECT r.owner || '/' || r.repo AS repo, r.pr_number, r.head_sha,
       p->>'id' AS lane, f->>'severity' AS severity, f->>'path' AS path
FROM review_worker_completions c
JOIN review_runs r USING (run_id)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.payload->'result', c.payload)->'personas') p
CROSS JOIN LATERAL jsonb_array_elements(p->'findings') f
WHERE c.created_at >= now() - interval '7 days';
```

This SQL was written against the schema in the source tree. It has not been run against production, and a JSON path may need adjusting if the stored envelope differs.

## 4. Size limits: compare 300 files, patch truncation, diff 406

| Limit | Runs (PRs) affected, 7 days | Effect today |
| --- | --- | --- |
| GitHub diff API HTTP 406 | **29 runs on 24 PRs, all `calltelemetry/cisco-cdr`** (worker log `GitHub qualification read failed HTTP 406`) | Hard failure, with no review. The PRs were release-branch syncs against `0.8.6-stable`: 54 to 280 files and about 13k to 19k changed lines, plus one of 4,517 files. Most were **below** 300 files and 20,000 lines, so the folklore threshold in the plan understates when 406 happens. #5090 (6 files, 159 lines) also got a 406 and deserves a separate look. |
| Compare API 300-file cap (`MAX_COMPARISON_FILES`) | 0 reviewed heads over 300 files | None observed. The one 4,517-file PR failed at 406 first. |
| Diff over 20,000 changed lines, from local git | 10 runs (4 PRs: cisco-cdr 5, ct-meta 4, ai-workspace 1) | These still reviewed. Size alone does not predict 406. |
| Compare per-file patch over 512 KB (`MAX_COMPARISON_FILE_PATCH_BYTES`) | 5 runs (2 PRs, cisco-cdr) | `parseComparisonFiles` drops that file's patch. |
| **`hunkFilter.ts` 20,000-character per-file truncation** | **174 runs (82 PRs); 698 file instances.** ct-release 43, ct-meta 38, ai-workspace 29, cisco-cdr 20 | The patch is cut to 20k characters with an in-prompt marker. In the panel engine, personas see only the start of that file's diff, and `get_diff` (`src/panel/toolRuntime.ts`) serves the same truncated effective file. `read_file` can still open the whole file from the worktree. **No check summary disclosed it:** none of the 173 affected heads' checks has a truncation disclosure line (30 contain the word only inside finding text). This breaks the plan's disclosure invariant (section 3.5) today. |
| Lockfile/generated exclusion (production rules) | 148 file instances | Excluded, as designed. |

Queries used: section 6.1 Q3 (406 and truncation strings in logs) and the local git computation in section 6.2.

## 5. `docs/features/context_management.md`: implemented versus designed

The document's own banner already says it is non-authoritative. Each claim below was checked against the source on `main` and the live worker pod environment. The live pod sets no compaction or budget environment variables, and live prepared configs have no `turn_window_compaction`.

| Design item (section of the document) | In code? | Reached by the DOKS worker? | Evidence |
| --- | --- | --- | --- |
| 2. Dynamic model context discovery (`resolveModelMetadata`, OpenRouter `/models`, 1 h cache) | Yes, `src/gateway/openRouterClient.ts` | **No.** No caller outside its own module. | `grep resolveModelMetadata src` |
| 2. Static model context matrix (`getStaticModelMetadata`) | Yes | Only for cost estimates (`estimateTokenCost`) | same file |
| 3. Safe diff capacity math (`calculateSafeDiffCapacity`) | Yes | **No.** Used only by `src/sandbox/piWorkspacePlugin.ts`, which only the evaluation harness imports. | `grep calculateSafeDiffCapacity src` |
| Production diff budget | Different design | Yes. Fixed 14,000-token (56,000-char) inline budget, tiers A, B, and C, and per-file oversize at 512 KiB (`REPO_READ_FILE_MAX_CHARS`). | `src/panel/panelEngine.ts` `buildScopedDiffSection` |
| 4.1 ±3 context lines | Yes, `src/pipeline/diffCompactor.ts` | **No compactor call.** The worker gets GitHub's unified patches, which already carry 3 lines of context. | `diffCompactor` imported only by `piWorkspacePlugin` and the harness |
| 4.2 Cluster splitting on gaps over 6 lines | Yes, same module | **No.** GitHub's unified diff already splits hunks at gaps over 6 lines. | same |
| 4.4 Lockfile, minified, and generated stripping | Yes | **Yes**, via `hunkFilter.ts` `classifyLockfileOrGeneratedPath`, through `buildEffectiveReviewFiles`. The minified-line heuristic (500 characters with no whitespace) exists only in `diffCompactor` and is **not** reached. | `src/pipeline/hunkFilter.ts`, `src/review/personaApplicability.ts` |
| Undocumented: 20k per-file patch truncation | Yes | **Yes**, and undisclosed (section 4) | `hunkFilter.ts` step 3 |
| 4.5 Whitespace and CRLF normalisation | Yes, in `diffCompactor` | **No** | |
| 5. `TurnHistoryManager` (2-turn window, receipts, ledger, <2,000 tokens) | Yes, `src/pipeline/turnHistoryManager.ts` | **No.** Harness only. Production has a separate `src/panel/messageWindow.ts` `compactMessageWindow`, default **off** (`turn_window_compaction` / `ENABLE_TURN_WINDOW_COMPACTION`), and it is not enabled in the worker. | `src/config/schema.ts`, worker pod env |
| 6. SHA partitioning, bin packing, `splitOversizedFileHunks` | Yes, `src/pipeline/shaPartitionManager.ts` | **No.** Harness only. | `grep shaPartitionManager src` |
| 6.6 Coverage badge ("48/48 files, 0 omitted") | No | No. The check prints lane coverage (`expected lanes`, `completed lanes`), not file coverage. | check summaries |
| 7. Config keys `ENABLE_DIFF_COMPACTION`, `STRIP_LOCKFILES`, `MAX_OMITTED_FILES`, `MIN_COVERAGE_PCT` | No reader | No | `grep` finds no reader. `MAX_DIFF_CHARS` exists only in `action.yml` and as a local constant in `classifierEngine.ts`. |

In short: of the design, only lockfile and generated stripping is live. The ±3 context and cluster splitting come free from GitHub's diff. Everything that would help large PRs (capacity math, partitioning, hunk-level splitting, turn-history bounding) is harness-only. W3, W5, and W6 should reuse `shaPartitionManager` and `diffCompactor` where their tests hold, rather than start from scratch, but must add the disclosure the harness never had.

## 6. Re-review tokens on `synchronize`

Method: take each reviewed head of a PR that follows an earlier head of the same PR with a verdict. A file counts as unchanged if it is in the new head's filtered diff, was also in the previous head's diff, and does not appear in `git diff --name-only <prev_head> <new_head>`.

| Measure | Value |
| --- | --- |
| Re-review heads (an earlier head of the PR had a verdict) | 563 (527 with token telemetry) |
| Fast-forward from the previous reviewed head / rewritten (force-push or rebase) | 464 / 99 |
| Tokens spent on those 527 heads | 40.6M (46 percent of all check-reported tokens) |
| Filtered diff bytes on those heads | 25.6 MB, of which 19.4 MB (75.9 percent) were unchanged since the previous reviewed head |
| Files on those heads | 5,035, of which 3,931 were unchanged |
| Per-run unchanged share | p50 0.73, p90 1.00 |
| Estimated tokens re-spent on unchanged files, marginal model (per-model slope × unchanged KB) | **about 9.1M** (22 percent of re-review tokens, 10 percent of all review tokens) |
| Upper bound, proportional model (tokens × unchanged byte share) | about 26.0M (29 percent of all review tokens) |

The true figure lies between the two estimates. The marginal model assumes the fixed per-run cost (about 25k tokens) would be paid anyway. The proportional model assumes none of it would be. W7 (incremental re-review) targets the marginal share directly. Only W8 (verdict cache) or skipping unchanged heads entirely would recover the fixed share.

Side measurements for W2, from the same diffs: whitespace-only files were negligible (98 file instances in 6 runs, 0.1 MB). Pure renames were negligible too (2 runs). W2's whitespace and rename rules will save little on this traffic. Lockfile and generated exclusion already runs, and the 20k truncation is the larger lever.

## 7. Queries used

### 7.1 VictoriaLogs (LogsQL, `http://<port-forward>:9428/select/logsql/query`)

Q1, the per-run table (one row per worker pod):

```text
kubernetes.pod_namespace:"ct-review-system" kubernetes.container_name:"reviewer-worker"
  _time:[2026-09-17T00:00:00Z, 2026-09-24T00:00:00Z)
| stats by (kubernetes.pod_labels.review-yeti.ai/run-id, kubernetes.pod_name,
            kubernetes.pod_labels.review-yeti.ai/repository-id, kubernetes.pod_labels.review-yeti.ai/pr-number)
    min(_time) first_log, max(_time) last_log, max(headSha) head_sha, max(repository) repository,
    max(repo) repo, max(verdict) verdict, max(conclusion) conclusion,
    max(blockingFindingCount) blocking, count() lines
```

Q2, failures:

```text
<same namespace/container/time filter> _msg:"Failed live ct-review-bot review dispatch"
| fields kubernetes.pod_name, errorType, failureClass, error, _time
```

Q3, size-limit strings. Only the 406 text appeared, inside the `error` field of Q2 (`GitHub qualification read failed HTTP 406`):

```text
kubernetes.pod_namespace:"ct-review-system" _time:[2026-09-17T00:00:00Z, 2026-09-24T00:00:00Z) "406"
| stats by (kubernetes.container_name) count()
```

The same query with "Not Acceptable", "too large", "truncat", "300 files", and "not renderable" returned nothing.

Q4, lane signals:

```text
<filter> _msg:"Normalized APPROVE with validated findings to FINDINGS" | extract "[Persona: <lane>]" from _msg | stats by (lane) count(), count_uniq(kubernetes.pod_name)
<filter> _msg:"Lane failed closed" | extract "[Persona: <lane>]" from _msg | stats by (lane) count()
<filter> _msg:"Persona execution failed" | stats by (persona, errorType) count()
<filter> _msg:"Skipping persona" | stats by (_msg) count()
<filter> _msg:"[Persona: " | extract "[Persona: <lane>]" from _msg | stats by (lane) count_uniq(kubernetes.pod_name)
```

Q5, field and retention discovery:

```text
kubernetes.pod_namespace:"ct-review-system" _time:30d | stats by (kubernetes.container_name) count(), min(_time), max(_time)
```

### 7.2 VictoriaMetrics (PromQL, evaluated at `time=2026-09-24T00:00:00Z`)

```text
sum(increase(bifrost_input_tokens_total{virtual_key_name="review-yeti"}[7d]))
sum(increase(bifrost_output_tokens_total{virtual_key_name="review-yeti"}[7d]))
sum(increase(bifrost_cache_read_input_tokens_total{virtual_key_name="review-yeti"}[7d]))
sum by (provider) (increase(bifrost_cost_total{virtual_key_name="review-yeti"}[7d]))
sum by (provider) (increase(bifrost_success_requests_total{virtual_key_name="review-yeti"}[7d]))
sum by (model, error_type, status_code) (increase(bifrost_error_requests_total{virtual_key_name="review-yeti"}[7d]))
sum by (method, model) (increase(bifrost_input_tokens_total{virtual_key_name="review-yeti"}[7d]))
histogram_quantile(0.5|0.9|0.99, sum by (le) (increase(review_yeti_operator_job_duration_seconds_bucket[7d])))
histogram_quantile(0.5|0.9|0.99, sum by (le) (increase(review_yeti_operator_webhook_to_completion_duration_seconds_bucket[7d])))
sum(increase(review_yeti_tokens_total[7d]))            # 0: worker metrics are not scraped
```

### 7.3 GitHub (read-only)

Check runs, batched 25 heads per request:

```graphql
query {
  h0: repository(owner: "<owner>", name: "<repo>") {
    object(oid: "<head sha>") { ... on Commit {
      checkSuites(first: 30) { nodes { app { slug }
        checkRuns(first: 20, filterBy: { checkName: "Review Yeti" }) {
          nodes { databaseId title summary text startedAt completedAt conclusion } } } } } }
  }
  # h1 … h24
}
```

Keep suites whose `app.slug` is `review-yeti` or `ct-review-bot`. Parse `Telemetry: (\d+) turns, (\d+) tool calls, (\d+) tokens across (\d+) lanes`, `Findings: (\d+) \(blocking P0/P1: (\d+)`, `resolved \`(…)\``, and each finding line `^- \*\*(P\d)\*\* \`(path)(:line)?\``.

PR base branches: `repository { pullRequest(number: N) { baseRefName state additions deletions changedFiles } }`. Actions-pipeline threads: `pullRequest { reviewThreads(first: 100) { nodes { path comments(first: 1) { nodes { author { login } body } } } } }`.

### 7.4 Git (per reviewed head)

```sh
git clone --bare --filter=blob:none https://github.com/<repo>.git
git fetch origin '+refs/pull/*/head:refs/pr/*'
base_tip=$(git rev-list --first-parent -1 --before=<run first_log> refs/heads/<baseRefName>)
mb=$(git merge-base "$base_tip" <head>)
git diff -M "$mb" <head>            # split per "diff --git"; bytes, +/- lines per file
git diff -M -w --numstat "$mb" <head>  # whitespace-only detection
git diff --name-only --no-renames <prev_head> <head>   # synchronize analysis
```

Checked against `PRReviewJob.spec.baseSha`: 25 of 25 merge bases matched. An empty diff for heads whose trees differ was treated as a lazy-fetch failure and retried. Three heads have a genuinely empty diff.

### 7.5 Kubernetes (read-only)

```sh
kubectl get prreviewjobs -A -o json      # status.timing, status.phase, spec.preparedReview config
kubectl -n ct-review-system get pod <worker> -o json   # env names only; no secret values read
```

### 7.6 File category rules (applied in order; first match wins)

| Category | Rule (path regex) |
| --- | --- |
| lockfile | `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock(b)`, `*.lock`, `go.sum`, `.terraform.lock.hcl`, `Package.resolved`, `gradle.lockfile`, `packages.lock.json`, `poetry.lock`, `uv.lock` |
| generated | `(dist\|build\|vendor\|node_modules\|__snapshots__\|generated\|gen)/`, `.min.js/.css`, `.snap`, `.pb.go`, `_pb2.py`, `.gen.*`, `.generated.*` |
| ci | `.github/workflows/`, `.github/actions/`, `.gitlab-ci*`, `Jenkinsfile`, `.circleci/`, `.buildkite/` |
| test | `(tests?\|__tests__\|spec\|e2e\|testdata\|fixtures)/`, `_test.*`, `.test.*`, `.spec.*`, `_spec.*`, `*Test(s).*`, `test_*.py` |
| iac | `.tf`, `.tfvars`, `.hcl`, `(helm\|charts\|k8s\|kustomize\|clusters\|manifests\|deploy\|infra\|terraform)/`, `Chart.yaml`, `kustomization.yaml`, `Dockerfile*`, `docker-compose*.yml` |
| docs | `.md`, `.mdx`, `.mdoc`, `.rst`, `.adoc`, `.txt`, images, `.pdf`, `docs?/`, `LICENSE*`, `CHANGELOG*`, `README*` |
| config | `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.properties`, `.xml`, `.env`, dotfiles |
| source | everything else |

These are measurement categories only. They are not the production classifier. The "filtered diff" figure uses the production lockfile and generated lists from `hunkFilter.ts` verbatim.

## 8. Unavailable data, stated plainly

- **Per-lane tokens in and out**: unavailable. Totals per run exist; per-lane exists only in Postgres (section 3.3), which was not reachable within scope.
- **Findings per lane per file category** for the DOKS app: unavailable for the same reason. Section 3.2 shows only a proxy from the Actions pipeline.
- **Per-run dollar cost**: only the blended gateway rate is available, and it excludes unmetered GPU pools.
- **14-day window**: VictoriaLogs retention for this namespace starts 2026-09-17.
- **PRReviewJob timing for 7 days**: CRs are garbage-collected, so only the last ~17 hours are present. The worker log span and the operator histogram substitute.
- **The exact bytes of the filtered diff sent to each persona**: reconstructed from git plus the production filter rules, not logged by the worker. No worker log records the tier (A, B, or C) or the inlined and indexed counts per run.

## 9. Instrumentation that would make the next measurement cheap

These are observations for later work items, not changes made here.

1. Log one structured line per lane at lane completion with `runId`, `lane`, `decision`, finding counts by severity, and `telemetry.totalTokens`. The data already exists in `buildPersonaTelemetryPayload`.
2. Log the diff sizing decision per run: tier, inlined, indexed, and skipped path counts, total inlined characters, and the number of files truncated at 20k.
3. Disclose `hunkFilter` truncation in the check summary. Section 3.5 of the plan requires it, and today it is silent.
