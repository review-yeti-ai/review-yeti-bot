# Original User Request

## Initial Request — 2026-09-14T15:08:44Z

Retire and delete the `miller` AST tool from Review Yeti, replacing its scoping responsibilities with a Zoekt-powered symbol/context pre-check and CodeRabbit-style deterministic static analyzers in the review sandbox. Ensure all pre-checks are configurable via `.ct-review.yaml` (optional, defaulting to enabled).

Working directory: `/Users/jasonbarbee/work/review-yeti-bot`
Integrity mode: development

## Requirements

### R1. Retire and Remove the Miller Tool
- Completely delete `src/services/millerTool.ts` and its associated unit test `tests/unit/millerTool.test.ts`.
- Remove all invocations, tool declarations, imports, and references to `miller` from `src/panel/panelEngine.ts`, `tests/unit/r2EmpiricalChallenger.test.ts`, and evaluation baselines/ablation scripts.
- Ensure the agentic persona tool registry no longer advertises or executes `miller`.

### R2. Zoekt-Driven Symbol & Context Pre-Check
- Leverage the existing `zoektSearchTool` / `zoektIndexBuilder` to perform deterministic pre-check symbol discovery on modified diff hunks.
- For changed files and symbols in a PR diff, query the Zoekt index for symbol definitions, call sites, and surrounding context.
- Provide this discovered symbol context as structured pre-check evidence to the reviewer personas prior to their evaluation turns, eliminating blind diff gaps without custom AST slicing.

### R3. Deterministic Sandbox Static Analyzers (CodeRabbit Pattern)
- Implement a pre-check analysis runner in the review sandbox (`src/pi/piWorkspacePlugin.ts` or dedicated pre-check module).
- Execute standard static analyzers on modified PR files based on ecosystem:
  - **TypeScript/JavaScript**: `eslint`, `semgrep`
  - **Elixir**: `credo --strict`, `sobelow --dry-run`
  - **Go**: `govet`
  - **Secrets/Credentials**: `gitleaks detect --no-git`
- Format analyzer hits into structured **candidate hypotheses** (with path, line range, analyzer rule, and message) passed into the persona context so agentic reviewers can verify or refute them, preventing raw SAST false positives from being published directly.

### R4. Configuration Schema & Default-On Wiring
- Extend the Zod configuration schema in `src/config/schema.ts` and `.ct-review.yaml` loader to support pre-checks:
  ```yaml
  pre_checks:
    enabled: true        # default: true
    zoekt:
      enabled: true      # default: true
      max_symbols: 25
    analyzers:
      enabled: true      # default: true
      linters: true
      security: true
      secrets: true
  ```
- All pre-checks must be strictly optional from the repository config, but enabled (`true`) by default when omitted.
- Gracefully fail-soft if any analyzer binary or Zoekt index is unavailable (record receipt status without failing the overall review).

## Verification Resources & Test Harness
- `npm test tests/unit/panelEngine.test.ts`
- `npm test tests/unit/evidenceRegistryComposer.test.ts`
- `npm test tests/unit/r2EmpiricalChallenger.test.ts`
- `npm test tests/unit/schema.test.ts`
- `npm run build`
- Dedicated unit tests validating:
  1. Complete absence of `miller` tool in panel engine.
  2. Zoekt symbol pre-check ingestion.
  3. Sandbox analyzer hypothesis formatting and fail-soft behavior.
  4. Config schema validation for default-on and explicit override settings.

## Acceptance Criteria

### Miller Retirement
- [ ] `src/services/millerTool.ts` and `tests/unit/millerTool.test.ts` are completely deleted.
- [ ] No remaining references to `executeMillerTool` or the `miller` tool name exist in `src/panel/panelEngine.ts`.
- [ ] All existing test suites pass cleanly without `miller`.

### Zoekt Pre-Checks
- [ ] Zoekt symbol search executes as an automated pre-check against PR diff hunks.
- [ ] Discovered symbol definitions and callers are injected as structured pre-check evidence for reviewer personas.
- [ ] Fails soft to standard file search if Zoekt is disabled or unindexed.

### Sandbox Analyzers
- [ ] Static analyzer pre-check runner executes applicable linters/scanners for changed files in the sandbox.
- [ ] Analyzer outputs are formatted as candidate hypotheses for persona verification rather than direct comments.
- [ ] Analyzer execution handles missing binaries gracefully without crashing the review run.

### Configuration & GitOps
- [ ] Zod schema in `src/config/schema.ts` validates `pre_checks` configuration.
- [ ] Default configuration enables Zoekt and analyzer pre-checks when unconfigured in `.ct-review.yaml`.
- [ ] Explicitly setting `pre_checks.enabled: false` or individual flags bypasses the respective pre-checks cleanly.
- [ ] TypeScript builds with zero type errors (`npm run build`).

## Follow-up — 2026-09-18T14:26:10Z

Implement comprehensive token optimization and lifecycle hardening for Review Yeti (`review-yeti-bot`), adopting the **Hybrid Trigger Model** (debounced automatic reviews with tagging/draft escape hatches), **two-tier in-flight cancellation** across dispatcher and worker pods, **pre-fetched bounded diff injection**, **path-based persona gating**, and **gateway circuit breaking**.

Working directory: `/Users/jasonbarbee/work/review-yeti-bot`
Integrity mode: development
Architecture Reference: `docs/superpowers/specs/2026-09-18-review-lifecycle-and-token-design.md`

Requested team: Full multi-agent team (parallel work streams across dispatcher, panel engine, sandbox, and gateway)

## Requirements

### R1. Hybrid Trigger Model & Commit Debouncing
- **Hybrid Trigger Routing**:
  - `opened` (non-draft) and `ready_for_review`: Admit and dispatch immediately (explicit review request).
  - `synchronize`: Admit immediately to establish the pending GitHub check on the new head, but set outbox `available_at = received_at + 60s` (trailing quiet window with 5m burst cap). Rapid successive pushes supersede the queued outbox row before any worker pod is scheduled, costing zero tokens.
  - `converted_to_draft` and `closed`: Automatically cancel in-flight reviews.
  - Opt-out label (e.g. `review-yeti:skip`, `wip`): Suppress automatic review runs and cancel in-flight runs. Removing the label admits the head.
  - On-demand command / tag (e.g. `/review` comment or `review-yeti` label): Bypass debounce and dispatch immediately on the current head.
  - Wire repository configuration `auto_review.triggers` (currently dead in `src/config/schema.ts`) so individual repositories can opt into ready-for-review-only or tag-only mode.

### R2. Two-Tier In-Flight Review Cancellation Architecture
- **Push Path (Dispatcher → Operator → Pod)**:
  - Add `cancel_requested_at`, `cancel_reason`, and `cancel_propagated_at` to PostgreSQL review run tables, fenced by `run_id` and `execution_attempt`.
  - Dispatcher consumes `review.lifecycle.superseded` outbox events and patches the projected `PRReviewJob` CR with `spec.cancelRequested: true`.
  - In `k8s-operator`: Add `PhaseCancelled`. On `spec.cancelRequested`, transition phase to `Cancelled` *before* deleting the Job with foreground propagation, avoiding the `WorkerJobMissing` failure-publication path that incorrectly marks checks red.
- **Pull Path & Worker Self-Termination (Direct Pod GPU Saver)**:
  - In `src/runLiveReview.ts` and worker runtime, install SIGTERM handling that triggers an `AbortController` passed into streaming gateway calls, terminating upstream vLLM inference immediately upon pod termination.
  - Worker polls authenticated `/api/dispatch/status` periodically (every 20–30s) using its existing bearer token, wiring the result into the already-existing `isCurrentHead` callback in `src/panel/panelEngine.ts:2932` to abort if superseded even if push propagation is delayed.

### R3. Pre-Fetched Bounded Diff Injection & Turn Reduction
- In `src/panel/panelEngine.ts`, pre-format and inline scoped diff hunks (for files under ~12k-16k tokens) directly into the first user turn, ordered by persona lane affinity.
- Update persona prompt instructions so the model renders findings immediately if inlined diffs suffice, rather than forcing sequential `get_diff` turns for each file.
- Retain `get_diff` as an on-demand fallback only for files whose diffs exceed inlining thresholds.
- Structure prompt segments to maximize vLLM prefix-cache sharing across personas (shared preamble + shared diff + persona charter/task).

### R4. Domain-Based Persona Gating & Budgeting
- Wire the existing domain classifier (`src/panel/classifierEngine.ts`) to conditionally gate personas instead of running all lanes blindly:
  - `sec-lane`: Run only when touched files match `security_auth` domains, sensitive paths/extensions, secret manifests, or when static analyzers detect security-relevant patterns.
  - `perf-lane`: Run only when persistence/runtime files change or analyzers flag queries/loops.
  - Pure documentation/asset/config PRs: Skip `sec-lane` and `perf-lane`, recording an explicit `not_applicable` status rather than failing the panel quorum.
  - Allocate a 2-turn / low-effort budget for gated lanes that match weakly, preventing empty approvals from consuming 50k tokens.

### R5. Gateway Circuit Breaking & Outage Requeuing
- In `src/panel/panelEngine.ts` and `src/gateway/`:
  - When the primary provider returns 502/503 on large prompts (>15k tokens), avoid fan-out retry storms across secondary providers.
  - Fail closed with `provider_5xx`, release the outbox row with exponential backoff delay (`available_at`), and keep the check pending rather than marking the PR failed.
  - Add dispatch circuit breaker that pauses claiming new outbox rows when cluster 5xx rates cross error thresholds.

## Verification Resources & Test Harness
- `npm test tests/unit/panelEngine.test.ts`
- `npm test tests/unit/reviewDispatchRepository.test.ts`
- `npm test tests/unit/configLoader.test.ts`
- `npm test tests/unit/publishingReview.test.ts`
- `npm run build`
- Dedicated test suites verifying:
  1. Webhook debounce and queue-supersede without pod creation.
  2. Cancellation propagation from DB to operator to worker SIGTERM.
  3. Worker status polling tripping `isCurrentHead` abort.
  4. Pre-fetched diff injection resulting in single/two-turn completions.
  5. Persona gating decisions across docs-only, security, and performance PRs.
  6. Gateway 5xx backoff and circuit breaker behavior.

## Acceptance Criteria

### Hybrid Triggers & Debounce
- [ ] Non-draft `opened` and `ready_for_review` events trigger immediate admission and dispatch.
- [ ] `synchronize` sets outbox `available_at` 60s in the future; successive pushes within the window supersede the row before a pod is created.
- [ ] Draft PRs and PRs with opt-out labels do not schedule review pods.
- [ ] `/review` comments and opt-in labels trigger immediate review runs bypassing debounce.
- [ ] Repositories can set `auto_review.triggers: [pr_ready]` in `.ct-review.yaml`.

### In-Flight Cancellation
- [ ] Superseded runs issue `spec.cancelRequested` to the Kubernetes CR within 5 seconds.
- [ ] Operator transitions CR to `Cancelled` and cleanly terminates the worker Job without triggering `WorkerJobMissing`.
- [ ] Worker pod intercepts SIGTERM or status poll rejection, immediately aborting active HTTP/LLM streams.
- [ ] Superseded runs update their GitHub checks with a neutral superseded notice.

### Pre-Fetched Diffs & Persona Gating
- [ ] Scoped diff hunks are pre-injected into turn 1, cutting average persona turns from 6–14 down to 2–4.
- [ ] Pure docs and asset PRs skip `sec-lane` and `perf-lane` with `not_applicable` status.
- [ ] Sensitive code changes reliably trigger `sec-lane` and `perf-lane`.

### Gateway Outage Handling & Build
- [ ] Upstream 502/503 errors delay and requeue outbox rows instead of cascading 25k+ token prompts across secondary pools.
- [ ] TypeScript builds with zero errors (`npm run build`).
- [ ] All unit and integration test suites pass (`npm test`).


## 2026-09-27T21:52:53Z

Implement the new agentic harness improvements from recent `ct-meta` commits (API-3330 and API-3333) into the DOKS runner lifecycle across both the TypeScript dispatcher and Go Kubernetes operator.

Working directory: /Users/jasonbarbee/work/review-yeti-bot
Integrity mode: development

Reference material:
- Architecture specification: `docs/plans/adaptive-agent-factory/2026-09-27-generalize-review-yeti-agent-harness.md` in `ct-meta`
- Schema contracts: `knowledge/contracts/agent-harness.v1.schema.json` in `ct-meta`
- Contract validator: `tools/agent_harness_contract.py` in `ct-meta`
- Operator controllers: `k8s-operator/controllers/` in `review-yeti-bot`
- Runner infrastructure: `src/infrastructure/k8sJobRunner.ts` in `review-yeti-bot`

## Requirements

### R1. TypeScript Runner Contract & Fencing Lifecycle
Extend `K8sJobRunner` and the DOKS job dispatch pipeline in `review-yeti-bot` to construct and emit valid `ct-agent-work-request.v1` envelopes for runner Jobs. The job manifest generator must inject `logical_child_id`, `fencing_epoch`, and child execution identities into the runner container environment and volume mounts. Upon pod completion, the runner must validate and produce conforming `ct-agent-execution-receipt.v1` structures.

### R2. Go Operator Fencing & Terminal Outcome Reconciliation
Update the Go `PRReviewJob` v1alpha2 controller (`k8s-operator/controllers/prreviewjob_v1alpha2_controller.go` and `worker_termination.go`) to reconcile child execution state against the authoritative fencing epoch:
- Distinguish between mission fencing epoch, child attempt number, and worker lease token.
- Handle pod failures, preemption, and eviction by recording terminal status without overwriting or promoting `UNKNOWN` external effect states to success.
- Ensure terminal deletion and secret cleanup preserve receipt auditability.

### R3. Task Observer & Lifecycle Evidence Emission
Incorporate API-3333 task-observer lifecycle hooks into the runner wrapper. Ensure execution receipts reference generated evidence artifacts, structured diagnostics, and phase transitions, mapping workflow phases (`INTENT` -> `INTENDED`, `EXECUTING` -> `IN_FLIGHT`, `UNKNOWN`/`RECONCILING`/`MANUAL` -> `UNKNOWN`) consistently with `ct-effect-intent.v1`.

### R4. Controlled Execution Environment
All Kubernetes manifests generated or reconciled must target the namespaced boundary (`ct-review-system`). Do not modify cluster-wide RBAC, storage classes, or production secrets directly.

## Acceptance Criteria

### Schema & Contract Conformance
- [ ] Runner WorkRequest payloads validate cleanly against `ct-agent-work-request.v1` schema from `ct-meta`
- [ ] Execution receipt payloads validate cleanly against `ct-agent-execution-receipt.v1` schema from `ct-meta`
- [ ] Fencing epoch mismatches or stale worker lease tokens trigger fail-closed reconciliation in the Go controller

### Controller & Dispatcher Tests
- [ ] Go controller unit and reconciliation tests pass (`go test ./controllers/...` in `k8s-operator`) with zero regressions
- [ ] TypeScript runner unit tests pass (`npm test tests/unit/...`) with zero regressions
- [ ] Offline contract qualification in `ct-meta` (`python3 test/agent_harness_contract_test.py`) passes without errors

## 2026-10-01T14:02:49Z

Build a modern, competitive AI PR review product and interactive management and analytics dashboard for Review Yeti (benchmarked against CodeRabbit and Greptile), giving engineering teams live-streaming inspection, human-in-the-loop controls, and executive spend intelligence.

Working directory: /Users/jasonbarbee/Documents/ct-master/review-yeti-bot-jasonbarbee
Integrity mode: development

## Requirements

### R1. Live Review Inspector & Streaming Reasoning Feed
Deliver a real-time web application where developers can observe pull request reviews as they execute, streaming subagent persona reasoning traces, tool executions, and interactive finding diff cards with line-anchored annotations.

### R2. Human-in-the-Loop Controls & Feedback
Enable reviewers to interact with review outputs directly in the interface: one-click false-positive dismissals, inline prompt corrections/guidance for subsequent review turns, and authoritative manual verdict overrides (SHIP vs. BLOCK).

### R3. Executive & Engineering Analytics Dashboard
Expose actionable engineering and management analytics including p95 review turnaround durations, model cost per repository/PR, token burn curves, finding severity ratios, and developer velocity impact.

### R4. GitHub OAuth & Organization Repository Management
Provide secure authentication via GitHub OAuth / GitHub App integration, allowing users to log in directly, view accessible organizations and repositories, inspect active pull requests, and manage review rules without friction.

## Acceptance Criteria

### Live Review & Streaming Experience
- [ ] Accessible web UI displaying active and historical PR reviews with zero dead endpoints or challenge lockouts.
- [ ] Real-time event stream (SSE or WebSocket) rendering live reasoning tokens, persona lane status, and tool calls as reviews progress.
- [ ] Interactive diff viewer displaying inline review findings anchored to specific file paths and line numbers.

### Human-in-the-Loop & Overrides
- [ ] Reviewers can dismiss individual findings or adjust severity directly from the UI with audit persistence.
- [ ] Reviewers can submit prompt steering feedback or manual verdict overrides that are recorded and respected by downstream check publishing.

### Analytics & Operational Visibility
- [ ] Analytics dashboard graphing p95 review latencies, review request volume, and model token/cost burn across selectable time windows (24h, 7d, 30d).
- [ ] Finding quality metrics showing acceptance rates vs. dismissals and severity distributions.

### Authentication & Integration
- [ ] Seamless GitHub OAuth login flow that authenticates users and lists authorized repositories and pull requests.
- [ ] End-to-end automated test suite verifying dashboard API endpoints, streaming feeds, and override handlers.

## Follow-up — 2026-10-01T21:51:36Z

Resume execution of the Teamwork workflow for Review Yeti dashboard & management.
Working directory: /Users/jasonbarbee/Documents/ct-master/review-yeti-bot-jasonbarbee
Integrity mode: development

Status:
- M1 (R4 GitHub OAuth, Org/Repo Management & Review Rules): PASSED (Gate Result: PASS).
- M2 (R1 Live Review Inspector, Streaming Reasoning & Diff Viewer): PASSED (Gate Result: PASS, 234/234 tests pass).
- CURRENT GOAL: Execute Milestone 3 (R2: Human-in-the-Loop Controls, Verdict Overrides & Audit Persistence) through worker, reviewer, challenger, and auditor gates, then Milestone 4 (R3: Executive Analytics Dashboard), and final verification.
Read:
- /Users/jasonbarbee/Documents/ct-master/review-yeti-bot-jasonbarbee/PROJECT.md
- /Users/jasonbarbee/Documents/ct-master/review-yeti-bot-jasonbarbee/.agents/orchestrator_1/GATE_STATUS.md
- /Users/jasonbarbee/Documents/ct-master/review-yeti-bot-jasonbarbee/.agents/orchestrator_1/progress.md
- /Users/jasonbarbee/Documents/ct-master/review-yeti-bot-jasonbarbee/.agents/orchestrator_1/DISPATCH.md

Do NOT mix clean. Do NOT pkill. No AI attribution in git commits or PRs.
Resume and drive to completion.

