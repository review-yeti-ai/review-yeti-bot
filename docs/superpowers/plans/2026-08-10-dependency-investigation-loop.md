# Review Yeti Dependency Investigation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Review Yeti personas a bounded, observable evidence follow-up so dependency reviews can inspect relevant manifest/lock/provenance evidence instead of approving after one shallow pass.

**Architecture:** Keep persona lanes parallel, but allow each lane to request a bounded evidence follow-up. A deterministic evidence adapter will expose only changed dependency-related files and bounded provenance signals; it will never grant arbitrary shell, network, or write access. A lane that still needs unavailable evidence after its turn budget is marked incomplete, which makes arbitration non-mergeable.

**Tech Stack:** Node.js 20, CommonJS pipeline runtime, Vitest, YAML Action inputs, Markdown configuration documentation.

## Global Constraints

- Review Yeti remains generic; no ct-meta-specific paths, roles, providers, or secrets.
- Evidence is limited to changed pull-request files and bounded diff excerpts; no arbitrary repository or registry access is added.
- `max-investigation-turns` is trusted-base controlled, defaults to `2`, and is clamped to `1..3`.
- Existing model responses containing only `findings` remain valid.
- Missing required evidence must produce `INCOMPLETE_REVIEW`/`BLOCK`, never `SHIP`.
- All new behavior has unit or integration coverage and preserves exact-head publication behavior.

---

### Task 1: Add deterministic dependency evidence extraction

**Files:**
- Create: `src/review/dependencyEvidence.js`
- Test: `tests/unit/dependencyEvidence.test.ts`

**Interfaces:**
- Consumes: parsed diff file objects, optional evidence requests, and policy-excluded/oversized path metadata.
- Produces: `buildDependencyEvidence(diffFiles, requests, options)` returning bounded evidence entries, provenance signals, and unresolved requests.

- [x] **Step 1: Write failing tests** for manifest/lock classification, provenance signal extraction, path allowlisting, bounded excerpts, and unavailable evidence.
- [x] **Step 2: Run `npm test -- tests/unit/dependencyEvidence.test.ts`** and confirm the new module is missing.
- [x] **Step 3: Implement the pure adapter** with explicit package-manager filename sets, changed-file-only allowlisting, line/excerpt bounds, and no filesystem/network calls.
- [x] **Step 4: Run the focused test file** and confirm all evidence cases pass.

### Task 2: Add structured investigation responses and follow-up prompting

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Test: `tests/unit/reviewPipelineModel.test.ts`

**Interfaces:**
- Consumes: model JSON with optional `review_status` and `evidence_requests`.
- Produces: normalized lane results with `reviewStatus`, `evidenceRequests`, `turn`, and `incomplete` metadata; prompts that distinguish initial review from evidence follow-up.

- [x] **Step 1: Add failing parser/prompt tests** for `NEEDS_EVIDENCE`, bounded request normalization, follow-up context, and legacy findings-only responses.
- [x] **Step 2: Run the focused model tests** and confirm the new assertions fail.
- [x] **Step 3: Implement response parsing and prompt construction** without changing legacy finding sanitization or publication anchors.
- [x] **Step 4: Run the focused model tests** and confirm they pass.

### Task 3: Wire bounded follow-up turns into persona lanes

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Modify: `action.yml`
- Modify: `.review-yeti.yaml`
- Test: `tests/unit/reviewPipelineDispatch.test.ts`
- Test: `tests/unit/reviewActionPackaging.test.ts`

**Interfaces:**
- Consumes: `max-investigation-turns`, persona requests, and the Task 1 evidence adapter.
- Produces: parallel persona execution with sequential per-persona evidence follow-ups, explicit turn telemetry, and incomplete-lane coverage.

- [x] **Step 1: Add failing dispatch tests** proving a dependency persona receives a second request after `NEEDS_EVIDENCE`, stops at the configured cap, and blocks when evidence remains unresolved.
- [x] **Step 2: Run the focused dispatch/action-contract tests** and confirm failure.
- [x] **Step 3: Add the trusted action input/env/config resolution** with a default of `2` and a hard `1..3` bound.
- [x] **Step 4: Implement per-persona follow-up orchestration** while preserving parallel lane fanout, usage aggregation, provider retries, and legacy lanes.
- [x] **Step 5: Make unresolved investigation evidence part of coverage completeness** so canonical arbitration returns `INCOMPLETE_REVIEW` and `mergeEligible: false`.
- [x] **Step 6: Run focused dispatch and packaging tests** and confirm they pass.

### Task 4: Strengthen the dependency persona contract and documentation

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Modify: `docs/YAML_CONFIGURATION_EXAMPLES.md`
- Modify: `README.md`
- Test: `tests/unit/reviewActionPackaging.test.ts`

**Interfaces:**
- Consumes: the existing built-in dependency persona and trusted configuration docs.
- Produces: explicit dependency evidence checklist and public documentation for turn budgets, evidence states, and fail-closed behavior.

- [x] **Step 1: Add failing documentation-contract assertions** for the dependency investigation protocol and `max-investigation-turns`.
- [x] **Step 2: Implement the charter and docs** with generic package-manager language and no repository-specific assumptions.
- [x] **Step 3: Run the documentation-contract tests** and confirm they pass.

### Task 5: Verify, review, publish, and land

**Files:**
- Modify: only files from Tasks 1–4.

- [x] **Step 1: Run the complete relevant Vitest suite, lint, and build.**
- [x] **Step 2: Inspect the exact diff and verify the plan checklist.**
- [x] **Step 3: Commit the implementation with focused messages.**
- [x] **Step 4: Push the branch to the fork and open an upstream Review Yeti PR.** PR [#22](https://github.com/review-yeti-ai/review-yeti-bot/pull/22); exact-head verification is recorded by the PR checks for each pushed revision.
- [x] **Step 5: Run the hosted Review Yeti panel against the exact head, inspect persona turns/evidence/usage, and address findings.** Upstream's self-review job is skipped for fork PRs because its `OPENROUTER_API_KEY` secret is unavailable; the same pipeline was run credentialed locally with the review-fleet secret and publication disabled: 5 parallel personas, 1 turn each, 99,683 tokens, $0.0259, SHIP, no findings.
- [ ] **Step 6: Re-run exact-head tests and hosted review, then merge only after required checks and review evidence are green.** Exact-head CI is green; merge remains pending because the upstream repository denies this account `MergePullRequest` permission and the hosted self-review secret is intentionally unavailable to fork PRs.

### Task 6: Evaluate efficacy before default-on promotion

- [x] **Step 1: Fix rejected evidence requests so they remain unresolved and restrict provenance to dependency-classified changed files.**
- [x] **Step 2: Add regression tests for rejected paths, arbitrary source provenance, and incomplete arbitration.**
- [x] **Step 3: Add the deterministic 16-fixture, three-repetition baseline/candidate evaluator.** See `docs/DEPENDENCY_REVIEW_EVALUATION.md`.
- [ ] **Step 4: Run the provider-backed paired evaluation and collect token, cost, and latency receipts.**
- [ ] **Step 5: Promote default-on only if the documented recall, safety, false-positive, cost, and latency thresholds pass.**
