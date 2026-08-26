# Review Comment Metadata Table Implementation Plan

> [!WARNING]
> **Historical plan; non-authoritative.** This records a point-in-time proposal, not current runtime,
> provider, release, or fleet policy. See
> [Documentation authority](../../DOCUMENTATION_AUTHORITY.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PR review comment’s persona table show provider, resolved model, P0/P1/P2-or-Nits counts, and three-decimal costs with deterministic fallbacks.

**Architecture:** Preserve the existing P0/P1/P2 review contract and derive display metadata from each OpenRouter response. The formatter will aggregate findings by supported severity, use emoji severity markers that render consistently in GitHub Markdown, and keep missing cost metadata explicitly unknown.

**Tech Stack:** Node.js, Vitest, JavaScript workflow pipeline, GitHub-flavored Markdown.

## Global Constraints

- Do not add a P3 severity because the review pipeline supports only P0, P1, and P2.
- Display the supported lower-priority bucket as `P2 / Nits`; do not create a separate Nits count that could double-count findings.
- Prefer response-reported model/provider/cost metadata; fall back to the configured model, `openrouter`, and `—` respectively.
- Never calculate cost from token counts or expose credentials/endpoints in the comment.
- Keep existing formatter callers compatible when result metadata is absent.

---

### Task 1: Specify response metadata and comment-table behavior with failing tests

**Files:**
- Modify: `tests/unit/reviewPipelineModel.test.ts`
- Modify: `tests/unit/reviewPipeline.test.ts`

**Interfaces:**
- The model boundary returns `model`, `provider`, and numeric `cost` when the response supplies them.
- `formatPRComment` renders columns `Reviewer Persona | Provider | Model | Decision | P0 | P1 | P2 / Nits | Cost` and a total row.

- [x] **Step 1: Add a model metadata test**

Add a Vitest case whose synthetic provider response includes `model`, `provider`, and `usage.cost`, then assert those values are returned by `reviewWithModel`.

- [x] **Step 2: Add table aggregation assertions**

Format two persona results with P0/P1/P2 findings and costs such as `0.0074` and `0.006307`. Assert the table has the supported columns, colored severity markers, `$0.007`/`$0.006` formatting, an aggregated total, and no `P3` column.

- [x] **Step 3: Add missing-metadata assertions**

Format a result without provider or cost metadata and assert it renders `openrouter` and `—`, without `NaN`.

- [x] **Step 4: Run the new tests and verify they fail for the missing behavior**

Run:

```bash
npx vitest run tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipeline.test.ts
```

Expected: the new assertions fail because model responses and the formatter do not yet expose/render the requested metadata.

### Task 2: Implement response metadata extraction and the supported-severity table

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`

**Interfaces:**
- Add small internal helpers for provider normalization, cost extraction, severity counting, and cost/table-cell formatting.
- Extend `reviewWithModel` success results with response model/provider/cost while preserving its existing error shape and configured-model fallback.
- Keep `SEVERITIES` as `['P0', 'P1', 'P2']`; only change presentation text to `P2 / Nits`.

- [x] **Step 1: Extract safe response metadata**

Read `payload.model`/`payload.model_id`, string or object provider names, and numeric `payload.usage.cost`/equivalent cost fields. Return `null` for unknown cost and use `openrouter` when the provider is absent.

- [x] **Step 2: Add deterministic severity/cost formatters**

Count only P0/P1/P2 findings, render `🔴`, `🟠`, and `🟡` cells, escape table cell pipes, format finite costs with `toFixed(3)`, and render unknown values as `—`.

- [x] **Step 3: Replace the persona breakdown table**

Render provider and resolved model columns, per-persona severity counts, per-persona cost, and a totals row. Keep findings details and existing arbitration/verdict content intact.

- [x] **Step 4: Run the focused tests and confirm green**

Run:

```bash
npx vitest run tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipeline.test.ts
```

Expected: all focused tests pass, including legacy callers that omit the new metadata.

### Task 3: Verify compatibility and prepare the branch

**Files:**
- Inspect: `.github/workflows/pipelines/review-pipeline.js`
- Inspect: `tests/unit/reviewPipelineModel.test.ts`
- Inspect: `tests/unit/reviewPipeline.test.ts`
- Inspect: `docs/superpowers/plans/2026-08-03-review-comment-metadata-table.md`

- [x] **Step 1: Run the broader relevant suite**

Run:

```bash
npx vitest run tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipeline.test.ts tests/unit/reviewFindingLayout.test.ts tests/integration/reviewReplay.test.ts
npm run lint
git diff --check
```

- [x] **Step 2: Review the generated Markdown and diff**

Confirm P3 is absent, P2/Nits is one bucket, unknown costs remain `—`, and no secrets or live-provider data were added.

- [ ] **Step 3: Commit the completed change**

```bash
git add .github/workflows/pipelines/review-pipeline.js tests/unit/reviewPipelineModel.test.ts tests/unit/reviewPipeline.test.ts docs/superpowers/plans/2026-08-03-review-comment-metadata-table.md
git commit -m "feat: improve review comment persona table"
```

### Task 4: Harden cost totals and Markdown metadata cells

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Modify: `tests/unit/reviewPipeline.test.ts`

- [x] **Step 1: Add failing regression tests**

Cover mixed known/unknown totals, negative or exponent-form costs, and provider/model values containing Markdown delimiters.

- [x] **Step 2: Implement safe cost and Markdown handling**

Treat a total as known only when every persona has a valid non-negative cost, reject values that cannot render as fixed three-decimal text, and replace backticks while escaping table pipes.

- [x] **Step 3: Run focused verification**

```bash
npx vitest run tests/unit/reviewPipeline.test.ts
```

Expected: 28 tests pass.

- [x] **Step 4: Commit the corrective PR**

```bash
git add .github/workflows/pipelines/review-pipeline.js tests/unit/reviewPipeline.test.ts docs/superpowers/plans/2026-08-03-review-comment-metadata-table.md
git commit -m "fix: harden review comment cost formatting"
```
