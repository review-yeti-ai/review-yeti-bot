# Generational Review Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one deterministic review contract shared by the GitHub Action and App, bind every run to an immutable pull-request snapshot, add an explicit v4 policy surface for budgets and submodules, and persist resumable Pi-style run state without introducing OmniRoute or an external workflow dependency.

**Architecture:** A dependency-free CommonJS `reviewCore` is the canonical verdict/normalization boundary. TypeScript adapters use it from the App while the plain Node Action requires it directly. `PRSnapshot` and v4 policy normalization produce stable SHA-256 identities. `ReviewRunRepository` stores leaseable stage state in memory for tests and PostgreSQL when configured. Submodule policy is explicit and fail-closed for unsupported recursive inspection. Existing v3 policy remains accepted and is normalized into v4 defaults.

**Tech Stack:** Node 20 CommonJS, TypeScript 5, Vitest, Zod, PostgreSQL, GitHub Action JavaScript.

## Global Constraints

- OpenRouter remains the only model transport in the new path; do not add OmniRoute execution.
- Do not claim a successful verdict when required lanes, coverage, snapshot identity, or publication evidence is incomplete.
- Preserve the existing v3 configuration and Action exports; v4 is additive and backwards-compatible.
- Keep tests credential-free, deterministic, and independent of network access.
- Use `apply_patch` for source changes and run each focused test immediately after adding its failing assertion.

## Task 1: Add the canonical review contract and cross-engine differential tests

- [ ] Add a pure `src/review/reviewCore.js` with canonical JSON, stable SHA-256 identity, finding sanitization against changed paths/lines, coverage status, and fail-closed verdict finalization.
- [ ] Add `src/review/reviewCore.d.ts` so TypeScript consumers receive typed contracts while the Action can `require()` the same implementation.
- [ ] Add Action and App adapters that map their native lane/result shapes into the shared core and expose identical verdict output.
- [ ] Add `tests/unit/reviewCoreDifferential.test.ts` covering SHIP, FIX_FIRST, BLOCK, incomplete coverage, provider failure, out-of-diff findings, and stable repeated output.
- [ ] Run the new test red before implementing the production modules, then run it green.

## Task 2: Bind reviews to immutable snapshots, v4 policy, and submodule decisions

- [ ] Add `src/review/prSnapshot.ts` with immutable PR identity fields, canonical digesting, and current-head/base assertions.
- [ ] Extend GitHub changed-file metadata with status/mode and old/new object IDs; add `src/review/submodulePolicy.ts` for ignore, metadata-only, recursive-requested, pinned-commit, allowlist, and fail-closed decisions.
- [ ] Add v4 Zod policy schemas and normalization helpers for submodule policy, execution budgets, and authenticated overrides while preserving v3 parsing.
- [ ] Make `ConfigResolver` return normalized v4-compatible policy plus source/ref/digest provenance for base-SHA resolution.
- [ ] Add tests proving exact base/head binding, deterministic policy digests, override precedence, gitlink handling, and recursive mode never silently degrades to SHIP.

## Task 3: Add durable Pi run state and stage transitions

- [ ] Add `src/review/piWorkflow.ts` with the admission → snapshot → config → submodules → review → arbiter → publish → complete stage graph and fail-closed transition rules.
- [ ] Add `src/persistence/reviewRunRepository.ts` with a typed repository contract, in-memory implementation, lease/heartbeat/transition semantics, idempotent run identity, and result digest storage.
- [ ] Add the PostgreSQL `review_runs` table to the existing initialization transaction and a PostgreSQL repository implementation using parameterized queries.
- [ ] Create the durable run record before asynchronous webhook execution and preserve the existing disabled Kubernetes dispatch guard until worker result handoff exists.
- [ ] Add tests for duplicate identity, competing lease claims, expired lease recovery, invalid transitions, and persisted failure states.

## Task 4: Integrate the shared contract and document the operator rules

- [ ] Route Action arbitration through the canonical core while preserving its current comment/output shape.
- [ ] Apply the canonical fail-closed gate to App panel results before publication, retaining model arbiter rationale only as a candidate decision.
- [ ] Pass snapshot/config digests through run identity and publication guards; ensure changed gitlinks produce explicit review evidence.
- [ ] Update `TEST_INFRA.md` and configuration reference documentation with replay/differential rules, v4 fields, provenance, and Pi run-state semantics.
- [ ] Add an npm test script for the new differential/snapshot/run-state suite without weakening existing tests.

## Task 5: Verify, review, and land

- [ ] Run focused tests, `npm run test:replay`, backend build, and lint; distinguish pre-existing dashboard failures from regressions.
- [ ] Inspect the diff, run a second clean repeat of deterministic tests, and verify no OmniRoute execution or secrets were introduced.
- [ ] Commit the implementation, push the branch, open a PR against current `main`, wait for hosted checks, address actionable feedback, and merge only the exact reviewed head SHA.
- [ ] Verify the merge SHA and report remaining generational gaps that are intentionally outside this slice.
