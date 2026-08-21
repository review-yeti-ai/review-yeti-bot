# Generational Review Engine Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `ct-review-bot` from a reliable multi-persona panel into a durable, evidence-backed, repository-aware GitHub review engine that can credibly compete with CodeRabbit and Greptile.

**Architecture:** One canonical `ReviewRun` contract will be shared by the GitHub Action and App. A durable Pi worker will execute immutable, resumable stages over a frozen PR snapshot and repository index. Deterministic tooling supplies evidence before model lanes; OpenRouter is the only model transport; publication is exact-head-bound and idempotent. Interactive fixes run in isolated branches and must pass validation before re-review.

**Tech Stack:** Node 20, TypeScript 5, CommonJS GitHub Action, Vitest, Zod, PostgreSQL, GitHub App REST API, OpenRouter, existing AST/symbol graph indexer, GitHub Actions.

## Global Constraints

- OpenRouter is the only model transport in the review path; remove or quarantine OmniRoute execution, metadata, credentials, and claims.
- No `SHIP` verdict is valid when required lanes, deterministic evidence, repository context, snapshot identity, or publication verification is incomplete.
- All reviews are bound to immutable `{owner, repo, prNumber, headSha, baseSha}` plus config, prompt, and index digests.
- Review replay remains credential-free, deterministic, and forbidden from making real network calls.
- Every external boundary is injectable in tests; production defaults may remain unchanged.
- Review-time MCP is read-only, allowlisted, and never selected from untrusted PR payloads.
- Submodule and monorepo traversal is explicit, bounded, and fail-closed when content cannot be trusted or fetched.
- Existing v3 configuration and Action exports remain compatible; normalized v4 policy is the internal contract.
- No production fix is accepted without a failing test first, a focused green test, and a second clean repeat.
- Do not import PostgreSQL, NATS, Kubernetes, or fixer architecture from `ct-pr-operator`; adopt only its tested boundary and durability patterns.

## Deliverables and file ownership

| Task | Primary ownership | Main deliverable |
|---|---|---|
| 1 | Provider and supply chain | OpenRouter-only runtime truth and locked review execution boundary |
| 2 | Pi runtime | Durable queue/worker, leases, resume, cancellation, stale-run supersession |
| 3 | Repository intelligence | Immutable index epochs, retrieval citations, monorepo/submodule context |
| 4 | Evidence and evaluation | Deterministic tool receipts, evidence-gated verdicts, quality benchmark |
| 5 | GitHub boundary | Shared Action/App publication, idempotent writes, exact-head verification |
| 6 | Developer workflow | PR conversation, validated fix branch/stacked PR, incremental review UX |
| 7 | Enterprise operations | Policy precedence, budgets, tenant isolation, SLOs, audit and retention |
| 8 | Landing gate | Full integration, hosted CI, exact-head review, PR and merge verification |

---

### Task 1: Establish OpenRouter-only provenance and secure the execution boundary

**Files:**
- Modify: `src/reflection/llmCommentLearner.ts`, `src/chat/commandDispatcher.ts`, `src/personas/docsPersona.ts`, `src/personas/marketingPersona.ts`, `src/github/prCloseDispatcher.ts`, `src/config/configLoader.ts`, `src/config/schema.ts`, `src/types/live.ts`, `src/types/providers.generated.ts`, `src/persistence/dashboardStore.ts`
- Modify: `.github/workflows/ci-cd.yaml`, `.github/workflows/review-bot.yaml`, `action.yml`
- Modify: `src/mcp/mcpFleetManager.ts`
- Modify: `docs/ARCHITECTURE.md`, `docs/PRD.md`, `docs/ADVERSARIAL_REVIEW_PATTERNS.md`, `docs/CONFIGURATION_REFERENCE.md`, `docs/GITHUB_APP_SETUP.md`, `docs/ROADMAP.md`, `docs/COMPETITIVE_LANDSCAPE.md`, `docs/USER_GUIDE.md`
- Create: `tests/unit/openRouterOnlyContract.test.ts`, `tests/unit/reviewBoundarySecurity.test.ts`

**Interfaces:**
- Produce `assertOpenRouterOnlyReviewRuntime()` and a provider provenance type that records requested model, returned model, provider, endpoint class, and response usage.
- Produce `McpReviewPolicy` with `allowedServerIds`, `allowedHosts`, `allowNetworkTools`, and `allowMutations`, defaulting to no custom servers and no mutations.

- [ ] Write failing tests proving no review import or execution path reaches OmniRoute, custom MCP registration is rejected without an explicit allowlist, mutable runtime npm installation is absent, and action dependencies are reproducible.
- [ ] Run `npm test -- tests/unit/openRouterOnlyContract.test.ts tests/unit/reviewBoundarySecurity.test.ts` and confirm the failures are caused by the current split-brain behavior.
- [ ] Replace legacy review-path provider calls with the injectable OpenRouter client or an explicit unsupported error; retain compatibility aliases only at configuration input boundaries.
- [ ] Enforce MCP allowlists before discovery and execution; reject HTTP hosts, stdio commands, mutation-capable tools, and client-payload server definitions unless policy explicitly permits them.
- [ ] Bundle or lock action dependencies and pin all workflow actions to immutable commit SHAs; remove runtime `npm install` from review execution.
- [ ] Rewrite stale OmniRoute documentation and generated metadata to describe OpenRouter and actual current behavior; remove unsupported competitor pricing and precision claims.
- [ ] Run the focused tests, `npm run build:backend`, and `npm run lint`; commit as `security: make review execution OpenRouter-only and reproducible`.

### Task 2: Implement durable Pi execution with resumable artifacts

**Files:**
- Modify: `src/review/piWorkflow.ts`, `src/persistence/reviewRunRepository.ts`, `src/persistence/postgresStore.ts`
- Create: `src/review/reviewRun.ts`, `src/persistence/reviewArtifactStore.ts`, `src/persistence/reviewWorker.ts`, `tests/unit/piWorker.test.ts`, `tests/integration/reviewRunRecovery.test.ts`

**Dependency:** Task 5 owns the later App/webhook integration; this task must leave `src/app.ts` and `src/panel/panelEngine.ts` untouched.

**Interfaces:**
- `ReviewRun` must contain immutable identity, effective policy/config digests, index epoch, stage status, attempt, lease, artifacts, result digest, and terminal error.
- `ReviewWorker.claimAndRun(runId, workerId)` must claim one lease, heartbeat during work, resume from the persisted stage, and atomically record success/failure.
- `ReviewArtifactStore.put(runId, stage, payload)` returns a content digest; `get(runId, stage)` returns the verified payload or fails closed.

- [ ] Write failing tests for duplicate admission, competing claims, heartbeat extension, expired lease recovery, crash-after-stage persistence, cancellation, stale-head supersession, and result digest mismatch.
- [ ] Run the focused tests and verify the current stage enum/repository cannot satisfy recovery semantics.
- [ ] Extend the stage graph with typed stage input/output contracts and explicit retryability; persist every stage result before advancing.
- [ ] Implement the artifact store with memory and PostgreSQL-backed adapters, content-addressed JSON, size limits, and redacted metadata.
- [ ] Replace webhook `setImmediate` execution with durable enqueue plus worker claim; retain the Kubernetes guard until the worker handoff is complete and tested.
- [ ] Add heartbeat timers around long-running model/tool stages and a reaper for expired leases and cancelled superseded runs.
- [ ] Run focused tests, replay tests, backend build, and a process-restart recovery test; commit as `feat: add resumable Pi review workers`.

### Task 3: Make repository intelligence mandatory and snapshot-aware

**Files:**
- Modify: `src/indexer/astParser.ts`, `src/indexer/symbolGraphStore.ts`, `src/services/millerTool.ts`, `src/review/prSnapshot.ts`, `src/review/submodulePolicy.ts`
- Create: `src/indexer/repositoryIndex.ts`, `src/indexer/contextRetriever.ts`, `src/review/repositoryContext.ts`, `tests/unit/repositoryContext.test.ts`, `tests/integration/indexEpochReplay.test.ts`

**Dependency:** Task 5 owns prompt and runtime integration; this task must leave `src/app.ts`, `src/panel/panelEngine.ts`, and `.github/workflows/pipelines/review-pipeline.js` untouched.

**Interfaces:**
- `RepositoryIndex.build(snapshot)` returns `{ epoch, commitSha, digest, stats }` and never mutates an index for another commit.
- `ContextRetriever.retrieve(query)` returns ranked `ContextCitation[]` containing repository path, symbol, line range, commit SHA, index epoch, and reason.
- `RepositoryContext.resolve(snapshot, changedFiles, policy)` returns changed symbols, callers/callees, ownership, related tests, relevant policy files, and explicit incomplete reasons.

- [ ] Write failing tests for unchanged-file caller impact, stale index rejection, exact citation ranges, monorepo package ownership, submodule metadata-only mode, blocked recursive mode, and oversized repository limits.
- [ ] Run focused tests and confirm the current indexer is not a mandatory, immutable context source for Action reviews.
- [ ] Add content-addressed index epochs keyed by exact commit and repository identity; invalidate retrieval when the PR head changes.
- [ ] Integrate retrieval into both Action and App prompts through one bounded context envelope; include citations in findings and replay fingerprints.
- [ ] Add workspace/package detection, CODEOWNERS ownership, per-directory policy lookup, and changed-package dependency closure.
- [ ] Enforce submodule URL/host allowlists, pinned object identity, maximum depth/files/bytes, and fail-closed incomplete status.
- [ ] Run index, replay, backend build, and exact-head differential tests; commit as `feat: add immutable repository context retrieval`.

### Task 4: Add deterministic evidence and measurable review quality

**Files:**
- Modify: `src/review/reviewCore.js`, `src/review/reviewCore.d.ts`, `src/pipeline/tokenBudgetManager.ts`
- Create: `src/review/evidence.ts`, `src/review/evidenceRunner.ts`, `src/review/qualityMetrics.ts`, `tests/unit/evidenceGate.test.ts`, `tests/integration/reviewQualityBenchmark.test.ts`, `tests/fixtures/review-benchmark/README.md`

**Dependency:** Task 5 owns panel and Action integration; this task must leave `src/app.ts`, `src/panel/panelEngine.ts`, and `.github/workflows/pipelines/review-pipeline.js` untouched.

**Interfaces:**
- `EvidenceReceipt` records tool name/version, command or API operation, snapshot SHA, exit status, duration, redacted output digest, and interpretation.
- `EvidenceGate.evaluate(input)` returns `PASS`, `FAIL`, or `INCOMPLETE` with reasons; `INCOMPLETE` cannot produce `SHIP`.
- `QualityMetrics` records finding precision, recall, duplicate rate, stale-context rate, time-to-first-comment, end-to-end latency, tokens, cost, and provider failures.

- [ ] Write failing tests for missing test evidence, failed static analysis, malformed provider output, unresolved high-severity finding, duplicate finding clustering, and a clean PR with zero findings.
- [ ] Add deterministic tool adapters for configured typecheck/lint/test/security commands with sandboxed execution, timeouts, output caps, and injectable command runners.
- [ ] Require every P0/P1 finding to carry a code citation, evidence references, confidence, and a validation status; downgrade or reject unsupported findings.
- [ ] Add benchmark fixtures for known bugs, clean changes, prompt injection, out-of-diff findings, and provider failures; report precision/recall without claiming perfect accuracy.
- [ ] Enforce atomic budget reservation and actual token/cost receipts across concurrent lanes; fail closed on budget exhaustion.
- [ ] Run replay twice and assert identical verdict, findings, evidence digests, request fingerprints, and comment output; commit as `feat: gate verdicts on deterministic evidence`.

### Task 5: Unify GitHub publication and make writes idempotent

**Files:**
- Modify: `src/github/commentPublisher.ts`, `src/github/githubClient.ts`, `src/github/installationClient.ts`, `src/app.ts`, `src/panel/panelEngine.ts`, `.github/workflows/pipelines/review-pipeline.js`, `action.yml`
- Create: `src/github/publicationReceipt.ts`, `tests/unit/publicationIdempotency.test.ts`, `tests/integration/githubPublicationReplay.test.ts`

**Dependencies:** Tasks 1–4 provide the security, Pi, repository-context, and evidence contracts. Task 5 is the single owner of their App/Action runtime integration.

**Interfaces:**
- `PublicationReceipt` records exact head SHA, event, idempotency key, request digest, GitHub response IDs, comments created, fallback path, and verification status.
- `publishReview()` must be safe to retry after an ambiguous network failure and must never duplicate inline findings for the same run identity.

- [ ] Write failing tests for 422 line fallback, own-PR approval fallback, 429 retry, network failure, ambiguous POST response, changed head before publication, and repeated publication.
- [ ] Route Action shell behavior through the same typed publication contract or a tested adapter; retain `gh pr comment --repo ... --body-file ...` coverage at the command boundary.
- [ ] Persist/find idempotency markers before and after every publication attempt and distinguish review, issue-comment, and check-run receipts.
- [ ] Revalidate head SHA immediately before each GitHub write and publish `NO_VERDICT` on mismatch.
- [ ] Verify publication by reading the resulting GitHub object and reconcile partial inline/body fallback outcomes.
- [ ] Run replay and publication integration tests twice; commit as `feat: make GitHub review publication idempotent`.

### Task 6: Add interactive PR conversation and validated fixes

**Files:**
- Modify: `src/chat/commandDispatcher.ts`, `src/app.ts`, `src/panel/panelEngine.ts`, `src/github/prCloseDispatcher.ts`, `src/review/reviewRun.ts`
- Create: `src/fix/fixWorkflow.ts`, `src/fix/sandboxRunner.ts`, `src/chat/reviewConversation.ts`, `tests/integration/reviewConversation.test.ts`, `tests/integration/validatedFixWorkflow.test.ts`

**Dependency:** Task 5 must land first; this task may modify the shared App/panel files only after publication integration is complete.

**Interfaces:**
- `ReviewConversation.answer(comment, reviewRun)` returns a cited explanation or a new review request without changing the verdict implicitly.
- `FixWorkflow.start(findingIds, snapshot)` creates an isolated branch/PR proposal, runs configured validation, and requests re-review against the new exact head.

- [ ] Write failing tests for explain/challenge/fix commands, unresolved finding selection, permission denial, merge conflict, validation failure, successful stacked PR, and exact-head re-review.
- [ ] Implement read-only conversation commands first with bounded context and citations; record feedback explicitly rather than silently changing policy.
- [ ] Implement isolated fix execution with no production credential access, command/time/byte limits, diff allowlists, and human approval before writes.
- [ ] Require validation receipts and a clean re-review before marking a fix resolved; never auto-merge.
- [ ] Run integration tests and commit as `feat: add cited PR conversation and validated fixes`.

### Task 7: Add enterprise policy, tenancy, budgets, and operational readiness

**Files:**
- Modify: `src/config/schema.ts`, `src/config/configLoader.ts`, `src/config/configResolver.ts`, `src/persistence/postgresStore.ts`, `src/metrics/metrics.ts`, `src/app.ts`, `docs/TEST_INFRA.md`, `docs/CONFIGURATION_REFERENCE.md`, `docs/GITHUB_APP_SETUP.md`
- Create: `src/policy/effectivePolicy.ts`, `src/policy/tenantBoundary.ts`, `src/ops/reviewSlo.ts`, `tests/unit/effectivePolicy.test.ts`, `tests/integration/tenantIsolation.test.ts`, `tests/integration/reviewSloMetrics.test.ts`

**Dependency:** Tasks 2, 5, and 6 must land first; this task owns the final policy/config/App integration.

**Interfaces:**
- `resolveEffectivePolicy({ platform, organization, repository, workflow, operator })` returns bounded policy plus source provenance and digest.
- `TenantBoundary.assertAccess(actor, repository, artifact)` rejects cross-tenant repository, index, run, log, and secret access.
- `ReviewSloSnapshot` exposes queue latency, first-comment latency, completion latency, provider availability, index freshness, cost, and false-positive feedback.

- [ ] Write failing tests for precedence, immutable platform caps, budget quotas, data retention, cross-tenant access, redaction, and SLO measurements.
- [ ] Add explicit organization/repository policy overrides with immutable safety caps and a stored effective-policy digest.
- [ ] Add per-repository/global concurrency and cost quotas with backpressure, cancellation, and durable audit events.
- [ ] Add retention/deletion controls for code snapshots, indexes, prompts, artifacts, logs, and provider payloads; default to credential-free redacted storage.
- [ ] Add dashboards/metrics for quality, latency, cost, provider routing, replay drift, and index freshness.
- [ ] Update `TEST_INFRA.md` with the adopted cassette, evidence, exact-head, MCP, and shell-boundary rules; commit as `feat: add review governance and SLO controls`.

### Task 8: Integrate, verify, review, and land

**Files:**
- Modify: `package.json`, `README.md`, `TEST_INFRA.md`, `.github/workflows/ci-cd.yaml`, `.github/workflows/review-bot.yaml`
- Create: `tests/e2e/generativeReviewEngine.test.ts`, `docs/GENERATIONAL_REVIEW_ENGINE_READINESS.md`

- [ ] Run focused tests for every task, `npm run test:replay`, `npm run test:unit`, `npm run test:integration`, `npm run build:backend`, and `npm run lint`; classify and fix regressions rather than hiding failures.
- [ ] Run the complete replay suite twice in isolated no-network mode and compare all verdicts, artifacts, request fingerprints, and generated comments.
- [ ] Run a deliberate unmatched-cassette request and verify immediate failure; run a provider failure and verify no `SHIP`.
- [ ] Run exact-head publication tests and verify retry does not duplicate inline comments.
- [ ] Review all changed code at the exact branch head with the review bot and an independent reviewer; re-run review after every SHA change.
- [ ] Open a ready PR against current review-bot `main`, wait for hosted checks, address actionable feedback, and merge only the exact reviewed head.
- [ ] Record merge SHA, residual risks, benchmark metrics, and explicitly unsupported features in `docs/GENERATIONAL_REVIEW_ENGINE_READINESS.md`.

## Completion Criteria

- `npm run test:replay` passes with no credentials and no network access.
- Full unit/integration/build/lint checks pass or every pre-existing failure is fixed and covered.
- No review path executes OmniRoute or accepts arbitrary MCP endpoints.
- Every `SHIP` verdict has complete required-lane, deterministic-evidence, repository-context, exact-head, and publication receipts.
- A crashed worker resumes from persisted Pi state without duplicate publication.
- Repeated replay runs are byte-stable and all cassette interactions are consumed.
- Submodule and monorepo reviews are bounded and fail closed when incomplete.
- Fix workflows produce isolated, validated PRs and never silently mutate the target branch.
- Hosted checks, final review, PR URL, reviewed head SHA, and merge SHA are recorded.
