# Generational Review Engine Task List

> [!WARNING]
> **Historical task record; non-authoritative.** Completion marks and branch references are retained
> for provenance and do not state current runtime, release, or fleet behavior. See
> [Documentation authority](DOCUMENTATION_AUTHORITY.md).

Plan: [`docs/superpowers/plans/2026-08-01-generational-review-engine-hardening.md`](superpowers/plans/2026-08-01-generational-review-engine-hardening.md)

## Current OpenRouter reliability follow-up

The production transport order is unchanged: Ollama remains primary, Fireworks remains the
second transport, and OpenRouter remains the fallback. This follow-up hardens the protocol and
qualification evidence before any routing decision; it does not authorize a canary, scheduled
probe, automatic flip, or publication change. See the staged plan:
[`docs/superpowers/plans/2026-08-28-openrouter-sse-reliability.md`](superpowers/plans/2026-08-28-openrouter-sse-reliability.md).

- [x] Consume provider `text/event-stream` responses incrementally with a real SSE reader in the
  action and the smoke probe; preserve chunk boundaries, keepalives, `[DONE]`, and metadata.
- [x] Separate connection, time-to-first-data, inactivity, and total request deadlines, with
  bounded reader cancellation and a 15-minute qualification job ceiling.
- [x] Parse OpenRouter `reasoning_details` and retain sanitized router metadata for diagnosis
  without storing URLs, prompts, secrets, or raw provider payloads.
- [x] Carry the TTFT contract through the policy handoff and qualification receipt.
- [x] Use the pinned official `@openrouter/sdk` chat client and HTTP client for OpenRouter
  completions, while keeping SDK retries disabled so the existing bounded retry/deadline policy
  remains authoritative; preserve the current production transport order.
- [ ] Run the serial, manual-only OpenRouter qualification matrix (one fixture, then three) and
  require 100% terminal completion before comparing review quality.
- [ ] Compare direct fixed-model and Auto Router/provider-routing behavior in separate evidence
  runs; do not mix route choice with production activation.
- [ ] Make an explicit, human-reviewed activation decision with a tested rollback; no canary,
  schedule, or automatic provider-order mutation is permitted.

Integration branch: `codex/review-bot-generational-hardening`

## Execution order

- [ ] Task 1 — OpenRouter-only provenance, MCP review boundary, and reproducible Action supply chain
- [ ] Task 2 — Durable Pi queue, worker leases, artifacts, recovery, and cancellation
- [ ] Task 3 — Immutable repository index epochs, retrieval citations, monorepo, and submodules
- [ ] Task 4 — Deterministic evidence receipts, evidence-gated verdicts, budgets, and quality benchmark
- [ ] Task 5 — Unified App/Action GitHub publication, exact-head checks, and idempotency
- [ ] Task 6 — Cited PR conversation and sandboxed validated fix workflow
- [ ] Task 7 — Effective policy, tenant boundaries, quotas, retention, audit, and SLOs
- [ ] Task 8 — Full replay/integration verification, exact-head review, hosted CI, PR, and merge

## Coordination rules

- Each implementation worker must work from the current integration branch in an isolated worktree, use TDD, commit only its task scope, and write a report under `.superpowers/sdd/2026-08-01-generational-review-engine-hardening/`.
- Task 5 is the only owner of shared runtime integration in `src/app.ts`, `src/panel/panelEngine.ts`, and `.github/workflows/pipelines/review-pipeline.js`.
- Task 6 follows Task 5 and may then extend the shared App/panel surfaces.
- Task 7 follows Tasks 2, 5, and 6 and owns final policy/config/App integration.
- Every accepted task receives a focused spec/quality review before the next task starts.
- A task is not complete on a green unit test alone: build, replay, exact-head, security, and compatibility evidence must be recorded.

## Status ledger

| Task | Worker | Commit | Review | Status |
|---|---|---|---|---|
| 1 | upstream OpenRouter/VCR hardening | 3dfe2e8, 8e584fa, 9ec9bc8, ce4a041 | focused replay/build evidence | complete in branch ancestry; broader provenance/MCP review remains a residual risk |
| 2 | Beauvoir/Pasteur/Planck/Rawls + direct recovery pass | 0cef8b6, ddd728f, c8268cb | focused recovery suite, build, pointer/fence audit | complete |
| 3 | direct repository-context pass | 7abc980 | repository context/index epoch suite, build, lint | complete |
| 4 | direct evidence/quality pass | 906fb8c | evidence/quality suite, build, lint | complete |
| 5 | direct publication pass | e07e498 | publication replay and legacy boundary suite, build, lint | complete |
| 6 | direct conversation/fix pass | 35c0ab6 | conversation/fix integration suite, build, lint | complete |
| 7 | direct governance/SLO pass | 8a571b2 | policy/tenant/SLO suite, build, lint | complete |
| 8 | integration/landing gate | — | replay twice and focused suites pass; full unit/integration gates expose legacy failures; hosted CI/PR not started | blocked pending repository-wide baseline fixes and hosted verification |
