# Review Yeti: trigger, lifecycle, and token design

Date: 2026-09-18
Status: proposal. Grounded in the two-hour telemetry window of 2026-09-18 and the code at v1.76.2.
Author: drafted by Claude for Jason Barbee.

## Telemetry that motivates this

| Measure | Value |
| --- | --- |
| Tokens in two hours | 17.4M total, 17.14M input, 267k output |
| Prompt cache hit rate | 77.1 percent, 13.2M cache-read tokens |
| Average prompt size | 23k to 26k tokens |
| Runs dispatched | 79 across 36 PRs |
| Succeeded | 57 |
| Superseded | 19, about 4.18M tokens, about 24 percent of all tokens |
| Failed | 3 |
| sec-lane plus perf-lane share | 5.14M tokens, over 43 percent of worker tokens, over 90 percent empty approvals |
| Gateway failures | 60 requests during transient vLLM 502/503, fallback fanned 25k prompts into secondary pools |

## 0. What the code does today

Every statement below was verified against the source, not inferred.

- Webhook admission accepts `opened`, `synchronize`, `reopened`, `ready_for_review`, requires `state: open` and `draft: false`, and routes `closed` to terminalization. There is no debounce. Each `synchronize` calls `admit` immediately. `src/review/githubWebhookAdmission.ts:24`
- `converted_to_draft` and `labeled` are not accepted on the authoritative path. Label triggers and `@review-yeti` comment commands exist only in the legacy in-process handler. `src/github/eventHandler.ts:183`
- On a new head, older queued or running runs for the same PR are updated to `superseded` and their lease is cleared. A `review.lifecycle.superseded` outbox event is appended. This is a database-only transition. `src/persistence/reviewRunRepository.ts:428`
- The dispatch engine only claims outbox rows and projects `PRReviewJob` custom resources. It never deletes or patches a CR. `src/k8s/reviewJobDispatchEngine.ts:71`
- The operator phases are Queued, Running, Succeeded, Failed, Expired. There is no Cancelled phase. Worker Jobs are deleted only on deadline expiry, contract mismatch, or failure publication. A Job that disappears while a review is Running triggers failure publication with reason `WorkerJobMissing`. `k8s-operator/api/v1alpha2/prreviewjob_types.go:31`, `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go:454`
- A CR waiting in Queued at the operator's capacity limit will start a pod later even if Postgres already marked its run superseded, because the operator reconciles from the CR, not the database. `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go:240`
- The worker `runLiveReview.js` has no SIGTERM handler, no run status polling, and no database access. It talks back only through `POST /api/dispatch/completion` with a bearer token bound to the run and attempt. `src/api/actionDispatchApi.ts:235`
- The worker learns it was superseded only when the gate policy rejects its completion as `candidate-superseded`. `src/review/reviewGatePolicy.ts:72`
- The panel engine already has cancellation machinery: an optional `isCurrentHead` callback checked before fast-ship, before pre-checks, before each persona starts, and after the persona semaphore is acquired; plus an `AbortSignal` raced against every model call and tool call, and honored by the gateway client between retries. `src/panel/panelEngine.ts:2718`, `src/panel/panelEngine.ts:2932`, `src/panel/panelEngine.ts:377`
- `isCurrentHead` is wired only in the in-process app using a file-backed store. The Kubernetes worker never passes it, so it defaults to true. `src/app.ts:471`
- Persona prompts contain a file index with zero diff hunks and instruct the model to call `get_diff` one path per turn. `get_diff` serves from the in-memory `changedFiles` array, so every such turn is a pure LLM round trip that re-sends the whole conversation. `src/panel/panelEngine.ts:1371`, `src/panel/panelEngine.ts:1783`
- Tool calls use a JSON envelope in generic JSON mode, not native function calling. Each tool turn is a full completion plus a reserved final turn. `src/panel/panelEngine.ts:1541`
- Per-persona budget: 15 investigation turns, 180 seconds idle per turn, four concurrent personas. `src/panel/panelEngine.ts:82`, `src/panel/panelEngine.ts:1991`
- Persona applicability is by `paths` globs. The sample roster gives `sec-lane` `paths: ["**"]`. Domain-lane classification with affinity per persona already exists, including a docs-only classifier with anti-evasion rules, but it is used for prompt emphasis, not for skipping lanes. `src/panel/classifierEngine.ts:26`, `src/panel/panelEngine.ts:2767`
- The effort tier function can only return `low` or `high`. The `medium` branch is unreachable. `src/pipeline/tokenBudgetManager.ts:38`
- `auto_review.triggers` is parsed with a default of `pr_opened`, `pr_synchronize`, `@ct-review` and is not read by any code path. `src/config/schema.ts:265`
- The gateway client's retry count defaults to zero. All retry and fallback behavior lives in Bifrost. `src/gateway/openRouterClient.ts:1741`
- The dispatch outbox has `available_at`, and `claimNext` filters and orders on it. `releaseForRetry` already accepts a future `availableAt`. `src/persistence/reviewDispatchRepository.ts:415`, `src/persistence/reviewDispatchRepository.ts:324`
- The operator's `MaxConcurrentJobs` defaults to 1. Worker `activeDeadlineSeconds` is the remainder of a 30 minute terminal window. `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go:48`, `src/config/terminalDeadline.ts`

## 1. Trigger strategy

### Options

| Model | Coverage and gate integrity | DevEx | Load and cost | Cascade risk |
| --- | --- | --- | --- | --- |
| Automatic on synchronize, no debounce, no cancellation. Today. | Every head reviewed. Gate is real. | Zero friction. | Highest. Pays for every push. | High. Push bursts multiply runs. Outages amplify through fallback. |
| Automatic on synchronize with debounce and preemption | Every settled head reviewed. Gate is real. | Zero friction. Review lags the last push by the quiet window. | Pays roughly once per push burst. | Low, if preemption reaches the pod. |
| Label or comment opt-in only | Only tagged heads. Reviews go stale on later pushes unless re-tagged. Gate becomes optional. | Friction. People forget. Stale reviews erode trust. | Lowest volume, uneven. | Low for bursts, but does nothing about in-flight waste or outage amplification. |
| State-gated: review on ready_for_review and opened, plus manual re-run | Draft churn free. Later pushes on ready PRs go unreviewed unless re-run. | Good for teams who use drafts. Bad for fix-up loops after review. | Low. | Low, same caveat as opt-in. |
| Hybrid: state-gated automatic with debounce and preemption, opt-out label, on-demand command | Every settled non-draft head reviewed. Gate is real. Authors can pause. | Low friction. Escape hatches both ways. | Near the opt-in floor without losing coverage. | Lowest, because the cascade levers below are independent of the trigger. |

### Recommendation

Adopt the hybrid. Do not move to label-only triggering. Tagging removes some volume but keeps every structural flaw: an in-flight run still burns to completion when the developer pushes, and a provider outage still fans out through fallback. Tagging also undermines the exact-head authority model the whole service is built around, because a gate that exists only when someone remembers to label is not a gate.

Concretely:

- `opened` on a non-draft PR and `ready_for_review`: admit and dispatch immediately. No debounce. These are explicit "I want a review" signals.
- `synchronize`: admit immediately so the check on the new head exists and blocks merge, but set the outbox `available_at` to the end of a trailing quiet window. A later push supersedes the queued row before any pod is created. Superseded-in-queue costs zero tokens.
- `converted_to_draft` and `closed`: cancel in flight, with propagation to the pod.
- Opt-out label such as `review-yeti:skip` or a configurable list: suppress automatic dispatch and cancel in flight. Removing the label re-admits the current head.
- On-demand `/review` comment or opt-in label: bypass debounce, dispatch now on the current head, still subject to the global cap.
- Wire `auto_review.triggers` so a repository can choose `pr_ready` only mode. Today the field is dead.

### Eliminating cascade risk

The cascade has four independent levers. None of them depends on the trigger model.

1. Quiet window at admission, described above.
2. One running run per PR with preemption that reaches the pod within seconds. Section 2.
3. A global admission and dispatch cap sized to the vLLM pool's healthy batch capacity. The operator cap exists. Add a dispatch pause switch that mirrors the existing admission pause so an outage stops new pods rather than queueing them into a wall.
4. Outage policy that converts provider failure into delay, not fan-out. Section 4.

## 2. Lifecycle: cancellation and debounce

### Principle

Cancellation is a first-class transition that propagates outward in three hops, database to CR to pod, and the pod also checks for itself. Both paths are needed. The push path is fast when every component is healthy. The pull path works when the operator is down, a CR patch is lost, or the dispatcher is restarting.

### Postgres

- Keep `superseded` and `cancelled` as terminal statuses. Add `cancel_requested_at` and `cancel_reason` so the dispatcher can distinguish "needs propagation" from "already propagated". Add `cancel_propagated_at`.
- Debounce lives in the outbox. On `synchronize`, insert the run as today and set `available_at = received_at + window`. On `opened`, `ready_for_review`, and explicit commands set `available_at = received_at`.
- Trailing window with a cap: each new push on the same PR supersedes the previous queued row and the new row's `available_at` is `now + window`, but never later than `first_push_in_burst + max_wait`. Store `burst_started_at` on the run or derive it from the superseded chain.
- Every cancellation is fenced by `run_id` plus `execution_attempt`, so a stale cancel cannot kill a refreshed attempt.

### Dispatcher

- Consume the existing `review.lifecycle.superseded` outbox event, plus new `cancelled` events, and patch the projected CR. Keep a periodic sweep over rows with `cancel_requested_at IS NOT NULL AND cancel_propagated_at IS NULL AND projection_name IS NOT NULL` as the fallback, on the same cadence as the delegated-failure poll.
- Patch `spec.cancelRequested: true` with `spec.cancelReason`. Prefer a spec field over deleting the CR so the operator can do a graceful stop and set a truthful check outcome. Delete only if the patch is rejected.
- Never claim a superseded row. `claimNext` already filters on run status. Verify the join with a test.

### Operator

- Add `PhaseCancelled` as a terminal phase. On `spec.cancelRequested`, set the phase first, then delete the Job with foreground propagation. Setting the phase first is essential: today a vanished Job while Running triggers `WorkerJobMissing` failure publication, which would turn an intentional cancel into a red check.
- Set `terminationGracePeriodSeconds` explicitly, around 30 seconds, so the worker gets SIGTERM and time to abort cleanly.
- Publish the old head's check as `neutral` with a "superseded by a newer head" summary, or leave it in progress to be replaced by the new head's check. Neutral is more honest and cheaper to reason about.
- A CR in Queued with `cancelRequested` must be deleted without ever creating a pod. This closes the capacity-queue gap described in section 0.
- Record `cancelRequestedAt` and `cancelObservedAt` in status so cancellation latency is measurable.

### Worker

This is the hop that actually saves GPU time. Two mechanisms:

1. SIGTERM handler. Create a root `AbortController` at process start. On SIGTERM, abort with a `PanelCancellationError` carrying the reason, and pass `signal` into `executePersonaPanel`. The engine already races model and tool calls against it. Pass the same signal into the streaming fetch so the HTTP connection to the gateway is closed. vLLM stops generating on client disconnect. Confirm that Bifrost propagates client disconnect upstream. If it does not, the cancel saves worker time but not GPU time, and that needs a gateway fix.
2. Self-check. Add an authenticated `GET /api/dispatch/runs/:runId/attempts/:attempt/status` that accepts the same bearer token the worker already uses for completion and returns `{ current, status, cancelReason }`. The worker polls it every 20 to 30 seconds and wires the result into `isCurrentHead` and into the root controller. This bounds the worst-case waste to about one model turn even when the whole push chain is down. It also doubles as a lease heartbeat, letting the reaper detect dead pods far sooner than the 30 minute terminal deadline.

### Latency budget

| Hop | Expected time |
| --- | --- |
| Webhook to Postgres supersede | under 1 second, exists today |
| Outbox event to dispatcher CR patch | 1 to 2 seconds |
| Operator reconcile, Job delete, SIGTERM | 1 to 3 seconds |
| Worker abort and connection close | immediate |
| Push path total | about 5 seconds |
| Pull path fallback | at most one poll interval, 20 to 30 seconds |
| Today | up to the remaining terminal window, 30 minutes |

### Debounce window

Start at 60 seconds trailing, with a 5 minute cap per burst. Reasoning:

- Fix-up loops after CI feedback typically land pushes one to three minutes apart. A 60 second window absorbs the double-push and the "forgot to run the formatter" push without making the developer wait noticeably, since a review itself takes several minutes.
- With fast preemption in place, debounce is only the cheap first-order filter, so err short. If preemption were slow, the window would need to be long. The two trade off directly.
- Measure rather than guess. `received_at` on superseded runs gives the inter-push distribution per PR. Pick the window at the knee of the distribution of pushes that superseded a running run, then tune with a `debounce_absorbed_total` counter.
- 45 seconds is reasonable if the team pushes often and preemption is proven fast. 120 seconds is only worth it if preemption cannot be made fast.

## 3. Prompt and context

### Per-run arithmetic

| Quantity | Approximate value |
| --- | --- |
| Tokens per run | 17.4M over 79 runs, about 220k |
| Tokens per persona | about 50k |
| Messages per persona | 6 to 14 |
| Prompt per message | 23k to 26k |

Each persona re-sends a growing 23k conversation for every `get_diff` turn, to fetch content the worker already holds in memory. The 77 percent cache hit rate means the prefix is not re-prefilled, but every decode step still attends over the full context, and the cache-read tokens still count as gateway volume.

### Pre-injected diff

Yes, inject it, with size tiers.

- Tier A: if the persona-scoped, hunk-filtered diff is at or below a budget of roughly 12k to 16k tokens, inline it in the first user message as per-file `<untrusted_diff_data>` blocks ordered by lane affinity. Keep `get_diff` for skipped oversized files and `read_file` for unchanged context. Instruct the model to render findings immediately if the inlined diff is sufficient. Expected turns per persona fall from 6 to 14 messages to 2 to 4.
- Tier B: if larger, inline the top affinity files up to the budget and list the rest in the index for on-demand pulls.
- Tier C: oversized files stay skipped exactly as today.

### Prompt layout for prefix caching

All personas in a run share the same diff. Lay the prompt out as shared system preamble, shared diff, then persona charter and task. With that order the diff is a cached prefix across all four or five personas, so vLLM prefills it once per run instead of once per persona per turn. The cost is that the role comes after the material. Test both orders with the existing release benchmark before committing. `eval-baselines` and `npm run benchmark:release` exist for exactly this.

### Lane gating for sec-lane and perf-lane

Gate by the domain-lane classification that already exists, and make gated lanes not-applicable rather than incomplete, so quorum is computed over applicable lanes and a required lane that is skipped by rule does not fail the panel.

- Run `sec-lane` when any changed file classifies as `security_auth`, matches the sensitive-pattern list, is a dependency manifest, workflow, Dockerfile, or environment or secret file, or when a cheap risk-signal pre-check finds new network, exec, eval, deserialization, or SQL string building in added lines. The zero-compilation analyzers are the right place for that pre-check.
- Run `perf-lane` when `data_persistence` or `system_runtime` files change and the added lines exceed a small threshold, or when the analyzers flag loops over collections, new queries, or new timers and schedulers.
- Skip both on docs, assets, tests only, UI only, and configuration only diffs, and write the skip reason into the check output.
- Shadow mode first. For two weeks, run the gated lanes anyway on a 10 percent sample of PRs where the rule would have skipped them, and record the finding rate. That is the evidence for tightening or loosening the rules.
- Where a gated lane does run, give it the low effort tier and `maxTurns: 2` with the pre-injected diff. An empty approval then costs one turn, roughly 8k to 10k tokens, instead of 50k.

### Small bug worth fixing on the way

`evaluateEffortAndBudget` can never return `medium`. Either wire the middle band or delete the branch.

## 4. Gateway and fallback policy

- Do not fan a 25k prompt into a different model pool on a transient 5xx. It doubles load during the exact moment capacity is scarce, and it changes which model produced the verdict mid-panel.
- Configure Bifrost for same-pool retry with jittered backoff and a small budget, two or three attempts. Reserve cross-pool fallback for the reserved final turn only, or disable it for review traffic entirely.
- On pool outage, fail the run with `provider_5xx`, release the outbox row with `available_at = now + backoff`, and keep the check in progress. This converts an outage into a delay instead of an amplification. `releaseForRetry` already supports the future `availableAt`.
- Add a dispatch circuit breaker: if `provider_5xx` rate over five minutes crosses a threshold, pause `claimNext`. The admission pause switch already exists as `authoritative_admission_paused`. Mirror it for dispatch.
- Size concurrency at the gateway per pool to vLLM's healthy batch. Concurrent 25k-token requests equal `MAX_CONCURRENT_PERSONAS` times `MaxConcurrentJobs`. Some of the observed 503s are likely self-inflicted.

## 5. Phased blueprint

| Phase | Scope | Effect |
| --- | --- | --- |
| 0, days, no schema change | Worker SIGTERM handler and root AbortController with signal passed to fetch. Worker status poll wired into `isCurrentHead`. Explicit `terminationGracePeriodSeconds`. Metrics: `superseded_tokens_total`, `cancel_latency_seconds`, per-lane finding rate. | Pull-path cancellation live. Waste per superseded run bounded to one turn. |
| 1, about a week | Outbox `available_at` debounce with trailing window and cap. Dispatcher cancel reconciler on outbox events plus sweep. Operator `PhaseCancelled`, `spec.cancelRequested`, fix the `WorkerJobMissing` false failure, neutral check on superseded head, delete Queued CRs on cancel. `converted_to_draft` handling. Opt-out label and `/review` command on the authoritative path. Wire `auto_review.triggers`. | Push-path cancellation in about five seconds. Superseded-in-queue costs zero. Cascade levers 1 and 2 closed. |
| 2, one to two weeks | Pre-injected diff with size tiers. Prompt layout for cross-persona prefix caching, validated by the release benchmark. Lane gating with shadow-mode sampling. Low effort and two-turn budget for gated lanes. | Turns per persona roughly halved. sec and perf share drops from 43 percent to a fraction. |
| 3 | Bifrost same-pool retry, no mid-panel cross-pool fallback, requeue on outage, dispatch circuit breaker, per-pool concurrency caps. Optional native tool calling. | Cascade levers 3 and 4 closed. |

### Expected impact, rough

| Component | Today | After phases 0 to 2 |
| --- | --- | --- |
| Superseded waste | about 4.2M of 17.4M | under 0.5M |
| sec plus perf share of worker tokens | about 43 percent | about 10 to 15 percent |
| Turns per persona | 6 to 14 messages | 2 to 4 |
| Total for the same two hours | 17.4M | roughly 5M to 6M |

These are estimates. The metrics added in phase 0 are what will confirm them.

## 6. Assumptions and open questions

- Bifrost propagates client disconnect to vLLM. If not, SIGTERM saves worker time but not GPU time. Verify with a cancelled stream and vLLM request logs.
- The consumer roster keeps `sec-lane` and `perf-lane` as `required: true`. Gating must therefore produce not-applicable, never incomplete.
- The debounce window is a starting point. The inter-push distribution from `received_at` decides the final value.
- Prompt layout change for prefix caching is a quality risk until the benchmark says otherwise.
