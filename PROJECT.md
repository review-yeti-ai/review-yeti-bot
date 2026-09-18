# Project: Review Yeti — Token Optimization & Lifecycle Hardening

## Architecture

Review Yeti (`review-yeti-bot`) v1.76.2 provides agentic code review via Kubernetes-orchestrated worker pods and an OpenRouter/vLLM LLM inference gateway.
This project implements comprehensive token optimization and lifecycle hardening per `docs/superpowers/specs/2026-09-18-review-lifecycle-and-token-design.md`:

1. **R1: Hybrid Trigger Model & Commit Debouncing**: Trailing quiet window (60s with 5m burst cap) in PostgreSQL outbox for `synchronize`, instant dispatch for non-draft `opened`/`ready_for_review`, cancellation on `converted_to_draft`/`closed`, opt-out labels (`review-yeti:skip`, `wip`), on-demand trigger (`/review`, opt-in label), and repository `auto_review.triggers` schema & runtime wiring.
2. **R2: Two-Tier In-Flight Review Cancellation**:
   - **Push Path**: Postgres cancellation tracking (`cancel_requested_at`, `cancel_reason`, `cancel_propagated_at`), dispatcher outbox event handling & CR patching (`spec.cancelRequested: true`), and Go operator `PhaseCancelled` with foreground Job deletion preventing `WorkerJobMissing` false-failures and publishing neutral checks.
   - **Pull Path**: Worker runtime root `AbortController` hooked to SIGTERM terminating upstream vLLM inference streams immediately, and authenticated status polling (`GET /api/dispatch/runs/:runId/attempts/:attempt/status`) wired to `isCurrentHead` abort callback.
3. **R3: Pre-Fetched Bounded Diff Injection & Turn Reduction**: Pre-formatting and inlining scoped diff hunks (under 14k-16k tokens) into Turn 1 ordered by persona domain affinity, updating persona instructions to emit findings immediately without calling `get_diff`, retaining `get_diff` as fallback for oversized files, and restructuring prompt layout for cross-persona vLLM KV prefix caching.
4. **R4: Domain-Based Persona Gating & Budgeting**: Wiring `classifierEngine` to gate `sec-lane` and `perf-lane`, recording explicit `not_applicable` status for docs/asset/config PRs without failing quorum, capping weak matches to 2 turns / low effort, and fixing unreachable `medium` tier in `tokenBudgetManager`.
5. **R5: Gateway Circuit Breaking & Outage Requeuing**: Failing closed with `provider_5xx` on large prompts (>15k tokens) to suppress secondary pool fan-out storms, releasing outbox rows with exponential backoff delay while keeping GitHub checks pending, and adding cluster 5xx dispatch circuit breaker.

```
                  ┌──────────────────────────────────────────────┐
                  │           GitHub Webhook Ingestion           │
                  │  - opened, ready_for_review -> instant       │
                  │  - synchronize -> debounce window (60s/5m)   │
                  │  - converted_to_draft, closed -> cancel      │
                  │  - opt-out labels (skip, wip) -> suppress    │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │       PostgreSQL Outbox & Review Runs        │
                  │  - outbox.available_at = received_at + 60s   │
                  │  - rapid push supersedes queued outbox row   │
                  │  - cancel_requested_at, cancel_reason        │
                  │  - cluster 5xx circuit breaker pause         │
                  └───────────────┬──────────────┬───────────────┘
                                  │              │
                   (push cancel)  │              │ (claimNext)
                                  ▼              ▼
                  ┌──────────────────┐    ┌──────────────────────┐
                  │    Dispatcher    │    │ K8s Operator         │
                  │  - Patch CR with │    │  - PhaseCancelled    │
                  │    cancelRequested    │  - Foreground Delete │
                  └──────┬───────────┘    │  - No JobMissing err │
                         │                └──────────┬───────────┘
                         ▼                           │
                  ┌──────────────────────────────────┴───────────┐
                  │                 Worker Pod                   │
                  │  - SIGTERM -> root AbortController -> vLLM   │
                  │  - Polls /api/dispatch/status -> isCurrentHead│
                  │  - Turn 1 Inlined Diffs (<16k tokens)        │
                  │  - Gated sec-lane / perf-lane (not_applicable)│
                  │  - 502/503 -> provider_5xx & outbox backoff  │
                  └──────────────────────────────────────────────┘
```

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Webhook Hybrid Event Routing | Route non-draft `opened` and `ready_for_review` to instant dispatch; route `synchronize` to debounced admission; route `converted_to_draft` and `closed` to cancellation. | M1 | ORIGINAL_REQUEST R1 & Spec §1 |
| 2 | Outbox Debounce Window & Burst Cap | Set `outbox.available_at = received_at + 60s` on `synchronize` capped at `burst_started_at + 300s`. Supersede older queued runs before pod creation. | M1 | ORIGINAL_REQUEST R1 & Spec §2 |
| 3 | Opt-Out Labels Handling | Suppress automatic dispatch and cancel in-flight reviews on opt-out labels (`review-yeti:skip`, `wip`). Re-admit on label removal. | M1 | ORIGINAL_REQUEST R1 & Spec §1 |
| 4 | On-Demand Trigger Handling | Bypass debounce and dispatch immediately on `/review` comment commands or `review-yeti` opt-in label. | M1 | ORIGINAL_REQUEST R1 & Spec §1 |
| 5 | Repository Config Triggers Schema | Extend and wire `auto_review.triggers` in `src/config/schema.ts`, `configLoader.ts`, and admission runtime to support `pr_ready` only and tag-only modes. | M1 | ORIGINAL_REQUEST R1 & Spec §1 |
| 6 | Debounce Queue Fencing & Tests | Ensure queued outbox rows superseded during debounce window transition to `terminal` with 0 pods scheduled. Dedicated unit tests. | M1 | ORIGINAL_REQUEST Verification |
| 7 | Postgres Cancellation Columns | Add `cancel_requested_at`, `cancel_reason`, and `cancel_propagated_at` to `review_runs` and `review_dispatch_outbox` with attempt fencing. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 8 | Dispatcher CR Cancel Patcher | Dispatcher consumes `review.lifecycle.superseded` outbox events and patches `PRReviewJob` CR with `spec.cancelRequested: true` and `spec.cancelReason`. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 9 | Dispatcher Cancellation Sweep Fallback | Periodic sweep over unpropagated cancellations (`cancel_requested_at IS NOT NULL AND cancel_propagated_at IS NULL`) to ensure delivery on restart. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 10 | Operator PhaseCancelled State | Add `PhaseCancelled` to `prreviewjob_types.go` and update CR state machine. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 11 | Operator Foreground Job Termination | Transition CR to `Cancelled` *before* deleting worker Job with foreground propagation, preventing `WorkerJobMissing` false-failure publication. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 12 | Neutral Superseded GitHub Check | Conclude superseded runs with neutral check status and superseded summary rather than red failure. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 13 | Worker SIGTERM Root AbortController | Install SIGTERM handler in `src/cli/runLiveReview.ts` with root `AbortController` passed into streaming gateway calls to terminate upstream vLLM inference. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 14 | Authenticated Status Polling API & Wiring | Implement `GET /api/dispatch/runs/:runId/attempts/:attempt/status` and wire worker polling (every 20-30s) into `isCurrentHead` callback in `panelEngine.ts`. | M2 | ORIGINAL_REQUEST R2 & Spec §2 |
| 15 | Bounded Diff Turn 1 Inlining | In `src/panel/panelEngine.ts`, pre-format and inline scoped diff hunks (for files under ~14k-16k tokens) in Turn 1 user prompt inside `<untrusted_diff_data>`. | M3 | ORIGINAL_REQUEST R3 & Spec §3 |
| 16 | Persona Lane Affinity Ordering | Order inlined diff hunks by domain affinity to the executing persona (`PERSONA_DOMAIN_AFFINITY`), placing high-priority diffs first. | M3 | ORIGINAL_REQUEST R3 & Spec §3 |
| 17 | Prompt Instruction Direct Findings | Update persona prompt instructions to render findings immediately on Turn 1 when inlined diffs suffice, without redundant `get_diff` calls. | M3 | ORIGINAL_REQUEST R3 & Spec §3 |
| 18 | On-Demand `get_diff` Fallback | Retain `get_diff` tool exclusively for oversized files or Tier B files exceeding inlining budget. | M3 | ORIGINAL_REQUEST R3 & Spec §3 |
| 19 | Prefix-Cache Aligned Prompt Layout | Restructure prompt messages: generic shared system preamble -> shared diff/rules/pre-checks prefix -> dynamic persona charter suffix for vLLM KV cache reuse. | M3 | ORIGINAL_REQUEST R3 & Spec §3 |
| 20 | Classifier Domain Gating for sec-lane | Run `sec-lane` only when files classify into `security_auth`, match sensitive patterns, modify secrets/manifests, or trigger security static analyzer hits. | M4 | ORIGINAL_REQUEST R4 & Spec §3 |
| 21 | Classifier Domain Gating for perf-lane | Run `perf-lane` only when files classify into `data_persistence`/`system_runtime` (with line additions >25) or trigger query/loop analyzer hits. | M4 | ORIGINAL_REQUEST R4 & Spec §3 |
| 22 | Docs/Asset PR Persona Skipping | Skip `sec-lane` and `perf-lane` on pure docs, asset, test-only, and UI-only PRs, recording explicit `not_applicable` status with 0 findings. | M4 | ORIGINAL_REQUEST R4 & Spec §3 |
| 23 | Dynamic Quorum Recalculation | Recalculate quorum over active applicable lanes so required lanes marked `not_applicable` do not fail the panel or check. | M4 | ORIGINAL_REQUEST R4 & Spec §3 |
| 24 | Weak Match 2-Turn Low-Effort Budget | Gated personas with weak domain matches receive `effort: 'low'` and `maxTurns: 2`, capping spend to ~8k tokens instead of 50k. | M4 | ORIGINAL_REQUEST R4 & Spec §3 |
| 25 | Medium Tier Token Budget Fix | Fix bug in `src/pipeline/tokenBudgetManager.ts:38-46` where middle tier (50-500 lines) fell through to low effort, making medium tier reachable. | M4 | ORIGINAL_REQUEST R4 & Spec §3 |
| 26 | Large Prompt 5xx Anti-Fanout Guard | Fail closed with `provider_5xx` on prompts >15k tokens encountering 502/503, suppressing secondary pool retry storms. | M5 | ORIGINAL_REQUEST R5 & Spec §4 |
| 27 | Outbox Requeue with Exponential Backoff | Release outbox row with exponential backoff delay (`available_at = now + backoffMs`) on `provider_5xx` failures via `releaseForRetry`. | M5 | ORIGINAL_REQUEST R5 & Spec §4 |
| 28 | In-Progress Check Preservation on 5xx | Keep GitHub check in `in_progress` with delay notice when outbox row is requeued for transient 5xx, rather than marking check failed. | M5 | ORIGINAL_REQUEST R5 & Spec §4 |
| 29 | Cluster 5xx Dispatch Circuit Breaker | Pause `claimNext` in `reviewJobDispatchEngine` when cluster-wide 5xx rate crosses error threshold over a 5-minute rolling window. | M5 | ORIGINAL_REQUEST R5 & Spec §4 |
| 30 | Concurrency Sizing & Transport Retries | Bound same-pool retries to 2-3 attempts with jittered backoff and enforce concurrency caps at gateway. | M5 | ORIGINAL_REQUEST R5 & Spec §4 |
| 31 | Full Test Suite Execution | Execute all authoritative unit and integration test suites with 100% pass rate. | M6 | ORIGINAL_REQUEST Acceptance |
| 32 | Webhook & Debounce Dedicated Tests | Validate debounce window, burst cap, queue superseding without pod creation, opt-out labels, and `/review` bypass. | M6 | ORIGINAL_REQUEST Acceptance |
| 33 | Cancellation Propagation Dedicated Tests | Validate two-tier cancellation: DB -> Dispatcher -> Operator -> SIGTERM, and worker status polling -> `isCurrentHead` abort. | M6 | ORIGINAL_REQUEST Acceptance |
| 34 | Turn Reduction & Gating Dedicated Tests | Validate Turn 1 diff inlining (turns drop to 1-2), docs-only skip to `not_applicable`, and sensitive code gating. | M6 | ORIGINAL_REQUEST Acceptance |
| 35 | Production Build Verification | TypeScript compilation (`tsc`) and Next.js production build (`npm run build`) pass with 0 errors. | M6 | ORIGINAL_REQUEST Acceptance |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | R1: Hybrid Trigger Model & Commit Debouncing | Webhook admission routing (`opened`, `ready_for_review`, `synchronize`, `converted_to_draft`, `closed`, labels, comments), outbox debounce window (60s trailing, 5m cap), queue supersede without pod creation, `auto_review.triggers` schema & runtime wiring. | none | DONE |
| M2 | R2: Two-Tier In-Flight Review Cancellation Architecture | Postgres schema & repo cancellation columns (`cancel_requested_at`, `cancel_reason`, `cancel_propagated_at`), dispatcher CR patcher & sweep, Go operator `PhaseCancelled` & foreground delete (fix `WorkerJobMissing`), neutral check on old head, worker SIGTERM `AbortController` stream abort, and authenticated `/api/dispatch/status` polling into `isCurrentHead`. | M1 | DONE |
| M3 | R3: Pre-Fetched Bounded Diff Injection & Turn Reduction | Scoped diff hunk formatting in Turn 1 (<14k-16k tokens), persona lane affinity ordering, prompt instruction updates for immediate findings without `get_diff`, on-demand `get_diff` fallback, and prefix-cache aligned prompt layout. | none | PLANNED |
| M4 | R4: Domain-Based Persona Gating & Budgeting | ClassifierEngine domain gating for `sec-lane` & `perf-lane`, safe PR skipping with explicit `not_applicable` status, dynamic quorum recalculation over active applicable lanes, 2-turn / low-effort budget for weak matches, and `tokenBudgetManager` medium tier bug fix. | M3 | PLANNED |
| M5 | R5: Gateway Circuit Breaking & Outage Requeuing | Large prompt (>15k tokens) 502/503 anti-fanout guard (`provider_5xx`), outbox release with exponential backoff delay, preserving `in_progress` check state, and cluster 5xx dispatch circuit breaker. | M1 | PLANNED |
| M6 | Final Verification & Adversarial Coverage Hardening | Execute all existing + dedicated test suites across M1-M5, adversarial challenge tests, and production build (`npm run build`). | M1, M2, M3, M4, M5 | PLANNED |

---

## Interface Contracts

### 1. Webhook Admission & Trigger Contract (`src/review/githubWebhookAdmission.ts`)
```typescript
export interface WebhookAdmissionOptions {
  event: string;
  action?: string;
  payload: any;
  receivedAt?: Date;
  burstStartedAt?: Date;
}

export interface WebhookAdmissionResult {
  admitted: boolean;
  reason?: string;
  debounceSeconds?: number;
  availableAt?: Date;
  cancelPreviousRuns?: boolean;
  isImmediate?: boolean;
  isDraft?: boolean;
  isOptedOut?: boolean;
}
```

### 2. Cancellation & Status Polling Contract (`src/api/actionDispatchApi.ts`, `src/persistence/reviewRunRepository.ts`)
```typescript
export interface ReviewRunCancellationRecord {
  runId: string;
  executionAttempt: number;
  cancelRequestedAt: Date;
  cancelReason: string;
  cancelPropagatedAt?: Date;
}

export interface ReviewRunStatusResponse {
  runId: string;
  executionAttempt: number;
  currentHeadSha: string;
  isCurrentHead: boolean;
  status: 'pending' | 'running' | 'completed' | 'superseded' | 'cancelled' | 'failed';
  cancelRequested: boolean;
  cancelReason?: string;
}
```

### 3. Kubernetes Operator PRReviewJob Spec Contract (`k8s-operator/api/v1alpha2/prreviewjob_types.go`)
```go
type PRReviewJobSpec struct {
    // ... existing fields ...
    CancelRequested bool   `json:"cancelRequested,omitempty"`
    CancelReason    string `json:"cancelReason,omitempty"`
}

const (
    PhaseQueued    = "Queued"
    PhaseRunning   = "Running"
    PhaseSucceeded = "Succeeded"
    PhaseFailed    = "Failed"
    PhaseExpired   = "Expired"
    PhaseCancelled = "Cancelled"
)
```

### 4. Scoped Diff Inlining & Prefix Cache Contract (`src/panel/panelEngine.ts`)
```typescript
export interface ScopedDiffSectionResult {
  diffText: string;
  inlinedPaths: string[];
  indexedPaths: string[];
  skippedPaths: string[];
  totalInlinedChars: number;
  estimatedTokens: number;
}

export interface SharedPromptPrefix {
  systemPrompt: string; // 100% identical across all personas on same PR
  staticUserPrefix: string; // metadata, rules, shared inlined diffs, pre-checks
  dynamicPersonaPayload: (persona: PersonaConfig) => string; // charter, output schema
}
```

### 5. Domain Gating & Persona Receipt Contract (`src/panel/classifierEngine.ts`, `src/panel/panelEngine.ts`)
```typescript
export interface PersonaGatingDecision {
  personaId: string;
  shouldRun: boolean;
  status: 'active' | 'not_applicable';
  reason: string;
  effortTier: 'low' | 'medium' | 'high';
  maxTurns: number; // 2 for weak matches, 15 for normal
}
```

### 6. Gateway Outage & Circuit Breaker Contract (`src/gateway/openRouterClient.ts`, `src/k8s/reviewJobDispatchEngine.ts`)
```typescript
export interface OutageRequeuePolicy {
  failureClass: 'provider_5xx' | 'transport_error' | 'rate_limit';
  promptTokens: number;
  shouldRequeue: boolean;
  backoffMs: number;
}

export interface DispatchCircuitBreakerState {
  isOpen: boolean;
  recent5xxCount: number;
  windowDurationMs: number;
  trippedAt?: Date;
  resumesAt?: Date;
}
```

---

## Code Layout

- `src/review/githubWebhookAdmission.ts`: Hybrid trigger routing, draft & opt-out label checks, debounce calculation
- `src/github/eventHandler.ts`: Comment command (`/review`) and label event routing
- `src/persistence/reviewDispatchRepository.ts`: Outbox `available_at` debounce logic, burst cap calculation, outbox release backoff, and 5xx tracking
- `src/persistence/reviewRunRepository.ts`: Cancellation columns, attempt-fenced status transitions, and status lookup
- `src/persistence/migrations/`: SQL migration adding cancellation columns and indices
- `src/config/schema.ts` & `src/config/configLoader.ts`: `auto_review.triggers` schema and runtime wiring
- `src/k8s/reviewJobDispatchEngine.ts`: Dispatcher `PRReviewJob` cancel patching, sweep fallback, and 5xx dispatch circuit breaker
- `k8s-operator/api/v1alpha2/prreviewjob_types.go`: CR `PhaseCancelled` and `spec.cancelRequested`
- `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go`: Foreground Job deletion on cancel, avoiding `WorkerJobMissing`, neutral check publication
- `src/cli/runLiveReview.ts`: Worker root `AbortController`, SIGTERM handler, and polling loop
- `src/api/actionDispatchApi.ts`: Authenticated run status polling endpoint (`/api/dispatch/runs/:runId/attempts/:attempt/status`)
- `src/panel/panelEngine.ts`: Scoped diff inlining, prompt layout prefix cache restructuring, persona prompt instructions, `isCurrentHead` polling wiring, and 5xx fail-closed guard
- `src/panel/classifierEngine.ts`: `sec-lane` and `perf-lane` gating, docs/asset detection, and `not_applicable` receipts
- `src/pipeline/tokenBudgetManager.ts`: Medium effort tier fix and weak match 2-turn budgeting
- `src/gateway/openRouterClient.ts`: 502/503 large prompt anti-fanout handling
- `src/cli/publishingReview.ts`: Pending check preservation on 5xx outbox requeue, neutral check on superseded runs
- `tests/unit/`: Dedicated test suites for triggers, debounce, cancellation, diff inlining, gating, and gateway backoff
