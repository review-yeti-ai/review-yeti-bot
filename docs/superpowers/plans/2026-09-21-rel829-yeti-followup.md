# REL-829 Review Yeti Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the still-current Review Yeti PR #788 follow-up debt on fresh official/main by proving producer-owned roster metadata, covering causal `MAX_PERSONAS` overflow failure, and making `PanelResult.applicablePersonaIds` a required runtime/type contract without weakening fail-closed publication.

**Architecture:** Keep the existing panel engine as the source of applicable-lane truth and keep the publisher as the fail-closed validator. Add real `executePersonaPanel` assertions for the two short-circuit producers, preserve the existing gate metadata behavior after verifying its current explicit-failure test, and require every `PanelResult` producer/fixture to carry a roster array. Oversized roster coverage will exercise the publishing worker boundary with more than the completion contract's `MAX_PERSONAS` rather than only testing a helper in isolation.

**Tech Stack:** TypeScript, Vitest, npm, Zod-backed worker completion contracts, Git linked worktrees.

**Spec:** `/Users/jasonbarbee/.codex/worktrees/uat1693-live-ct-meta/.superpowers/sdd/2026-08-29-audit-logging-reliability-and-uat-contract/rel829-current-pr-reconciliation.md` and `/Users/jasonbarbee/.codex/worktrees/uat1693-live-ct-meta/.superpowers/sdd/2026-08-29-audit-logging-reliability-and-uat-contract/review-yeti-rel829-independent-review.md`

## Global Constraints

- Base exactly `official/main` at `6a11efa4e0b25f2d4bb7c29dcb1f106437c30ee6` after the refresh performed before branching.
- Work only in `/Users/jasonbarbee/.codex/worktrees/rel829-yeti-followup-current` on `codex/REL-829-yeti-followup`; preserve the dirty canonical checkout.
- Preserve fail-closed behavior: invalid, missing, duplicate, foreign, or oversized rosters must not become successful evidence.
- Do not duplicate the existing explicit terminal-failure caller metadata test in `tests/unit/reviewGateClient.test.ts`; record the verification and map both related P2s to the existing proof.
- Do not push, create/update a PR, merge, deploy, comment, or invoke a provider/live service.
- Use TDD for new regression coverage and run `git diff --check` before committing.

---

### Task 1: Establish the producer metadata regression tests

**Files:**
- Modify: `tests/unit/panelEngineExpansion.test.ts`
- Test: `tests/unit/panelEngineExpansion.test.ts`

**Interfaces:**
- Consumes: real `executePersonaPanel`, `buildMinimalConfig`, and the existing classifier/client seam.
- Produces: executable proof that the zero-lane and classifier-approved fast-ship `PanelResult` objects own `applicablePersonaIds`.

- [ ] **Step 1: Add the failing producer assertions/tests first.**

Port the exact local `84614f40d2540eaa071563707b69f10390552680` test delta:

```ts
expect(Object.prototype.hasOwnProperty.call(result, 'applicablePersonaIds')).toBe(true);
expect(result.applicablePersonaIds).toEqual([]);
```

to the existing zero-lane test, and add a real fast-ship test that configures one applicable `docs-lane`, returns the classifier JSON `{ fastShip: true, selectedPersonas: [], effortTier: 'low', rationale: 'Documentation-only change.' }`, calls `executePersonaPanel`, and asserts:

```ts
expect((result as any).isFastShip).toBe(true);
expect(Object.prototype.hasOwnProperty.call(result, 'applicablePersonaIds')).toBe(true);
expect(result.applicablePersonaIds).toEqual(['docs-lane']);
expect(result.applicablePersonaIds).not.toEqual(['fast-ship']);
```

The test must not mock `publishingReview` or handcraft the returned panel object.

- [ ] **Step 2: Run the producer suite and perform the red counterfactual.**

Run:

```bash
npx vitest run tests/unit/panelEngineExpansion.test.ts
```

Confirm the two new assertions pass against current main, then temporarily remove only the existing `applicablePersonaIds: []` zero-lane assignment and the fast-ship `applicablePersonaIds: applicable.map(...)` assignment, rerun the same command, and record that exactly those two tests fail for missing producer metadata while the existing tests remain green. Restore both assignments immediately and rerun the suite.

- [ ] **Step 3: Keep the restored focused suite green.**

Run the same Vitest command and require the full file to pass before moving to the next task.

### Task 2: Add causal oversized-roster publication coverage

**Files:**
- Modify: `tests/unit/publishingReview.test.ts`
- Read: `src/review/workerReviewCompletion.ts` for `MAX_PERSONAS`
- Read: `src/cli/publishingReview.ts` for `rawPublicationRoster` and canonical arbitration

**Interfaces:**
- Consumes: `runPublishingReviewWorker`, the test `deps`/`env` helpers, `MAX_PERSONAS`, and the existing panel result shape.
- Produces: a worker-boundary regression test proving an over-cap applicable roster is invalid, bounded for arbitration, and published as a failure.

- [ ] **Step 1: Add the failing oversized-roster test.**

Import `MAX_PERSONAS` and construct `MAX_PERSONAS + 1` valid lowercase roster IDs, e.g. `lane-0` through `lane-64`. Return those IDs as both `applicablePersonaIds` and completed `personas`, with no optional failures, satisfied quorum, and a `SHIP` arbiter. Run the real publishing worker and assert:

```ts
expect(receipt.verdict).toBe('BLOCK');
expect(receipt.conclusion).toBe('failure');
expect(receipt.coverage).toMatchObject({
  expectedLaneCount: null,
  completedLaneCount: MAX_PERSONAS,
  failedLaneCount: 0,
  rosterValid: false,
  quorumSatisfied: false,
  fullPanelComplete: false,
});
expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
  expect.objectContaining({ conclusion: 'failure', title: 'Review Yeti: BLOCK' }),
);
```

The assertions must show causality: the configured roster is invalid because it exceeds the contract cap, the lane projection is bounded, and fail-closed arbitration prevents a green check.

- [ ] **Step 2: Run the focused publisher suite and verify the intended red/green behavior.**

Run:

```bash
npx vitest run tests/unit/publishingReview.test.ts
```

If the test passes before any production change, confirm it would fail if the `validConfiguredRoster` cap or the `allLanes.length <= MAX_PERSONAS` validity guard were removed by applying a temporary test-only counterfactual, then restore the source unchanged. Do not weaken or alter the cap implementation merely to create a failure.

- [ ] **Step 3: Preserve the existing gate metadata decision.**

Before adding any gate test, rerun the existing explicit terminal-failure case in `tests/unit/reviewGateClient.test.ts` and inspect its request body. The current test named `never applies successful Gate presentation to a terminal failure` supplies explicit caller `title` and `summary`, asserts the same terminal failure conclusion, and asserts those values are preserved without the success text. Record that this is sufficient coverage for discussions `4006804967` and `4007021514`; add no duplicate test.

### Task 3: Make the panel roster contract required and update producers/fixtures

**Files:**
- Modify: `src/panel/types.ts`
- Modify: `src/panel/fastShipResult.ts`
- Modify: any source/test files reported by the focused TypeScript compile as constructing a typed `PanelResult` without `applicablePersonaIds`

**Interfaces:**
- Consumes: the producer assertions and publisher overflow test from Tasks 1–2.
- Produces: a compile-time and runtime-required `PanelResult.applicablePersonaIds: string[]` field on all real producers and typed fixtures.

- [ ] **Step 1: Change the interface contract after behavioral tests exist.**

In `src/panel/types.ts`, replace the optional declaration with:

```ts
/** Final path/config/classifier-selected roster used by the panel execution. */
applicablePersonaIds: string[];
```

Do not make any other `PanelResult` field required or change publisher validation semantics.

- [ ] **Step 2: Update the fast-ship result factory without inventing a successful roster.**

In `src/panel/fastShipResult.ts`, include `applicablePersonaIds: []` in the factory’s returned object so its standalone typed result is structurally complete. Keep `executePersonaPanel`’s existing real producer assignment of `applicable.map((persona) => persona.id)` as the authoritative configured roster; do not replace it with the synthetic `fast-ship` lane.

- [ ] **Step 3: Run TypeScript to enumerate and fix typed fixtures.**

Run:

```bash
npm run lint:src
```

Add `applicablePersonaIds` to every actual `PanelResult` literal reported by the compiler, including direct e2e/unit fixtures and helper return values. Use the fixture’s existing persona IDs for non-empty results and `[]` for zero-lane results. Do not cast away the required field, use `as any`, or remove existing fail-closed fields.

- [ ] **Step 4: Rerun focused behavior and contract tests.**

Run:

```bash
npx vitest run tests/unit/panelEngineExpansion.test.ts tests/unit/publishingReview.test.ts tests/unit/reviewGateClient.test.ts tests/unit/fastShipResult.test.ts
npm run lint:src
```

Require all focused tests and source typechecking to pass.

### Task 4: Final repository verification and evidence report

**Files:**
- Create outside the implementation repo: `/Users/jasonbarbee/.codex/worktrees/uat1693-live-ct-meta/.superpowers/sdd/2026-08-29-audit-logging-reliability-and-uat-contract/review-yeti-rel829-followup-implementation.md`
- Review: `git diff --check`, `git status`, exact base/head, and final diff

**Interfaces:**
- Consumes: all changed source/tests, exact base `6a11efa4e0b25f2d4bb7c29dcb1f106437c30ee6`, the final commit SHA, and fresh test output.
- Produces: a clean implementation commit and an append-only central implementation report mapping every unresolved P2 to evidence or an explicit no-op decision.

- [ ] **Step 1: Run the requested final checks.**

Run the focused Vitest command from Task 3, then:

```bash
npm run lint
npx vitest run tests/unit/panelEngineExpansion.test.ts tests/unit/publishingReview.test.ts tests/unit/reviewGateClient.test.ts tests/unit/fastShipResult.test.ts
git diff --check
git status --short
```

Run the repository’s all-test parse/import check through `npm run lint` and, if the focused suites or fixture edits touch generated pipeline artifacts, rerun the normal `npm run test:artifacts` pretest path. Inspect the final diff for unrelated changes and confirm no push/PR/merge/deploy/comment command was run.

- [ ] **Step 2: Write the central report before commit.**

The report must include:

1. exact worktree and branch;
2. exact base SHA `6a11efa4e0b25f2d4bb7c29dcb1f106437c30ee6`;
3. exact implementation head SHA after commit;
4. files changed and concise behavior summary;
5. focused Vitest counts, `npm run lint` source/type/all-test parse evidence, and `git diff --check` result;
6. a six-row P2 mapping: producer roster assertions fixed by real `executePersonaPanel` tests; both MAX_PERSONAS threads fixed by causal overflow coverage; `PanelResult` optional-runtime contract fixed by required typing and producer/fixture updates; both terminal explicit-metadata threads verified by the existing `reviewGateClient` test with no duplicate change;
7. explicit evidence boundary: local commit only, no push/PR/merge/deploy/hosted Review Yeti or live acceptance.

- [ ] **Step 3: Commit the implementation cleanly.**

After fresh verification, stage only the implementation plan, source/tests, and any intended repository-local evidence artifact, then commit with:

```bash
git add docs/superpowers/plans/2026-09-21-rel829-yeti-followup.md src tests
git diff --cached --check
git commit -m "test: close REL-829 Review Yeti follow-up debt"
```

Do not push or create/update a pull request. Recheck `git status --short --branch` and report the exact commit SHA plus the central report path.
