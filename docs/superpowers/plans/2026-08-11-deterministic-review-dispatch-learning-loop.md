# Deterministic Review Dispatch and Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Alibaba/OpenCodeReview-inspired deterministic routing, bounded per-unit investigation, independent finding reflection, and an auditable learning loop around Review Yeti without reducing the existing review roster or merge safety during rollout.

**Architecture:** The trusted-base pipeline will compile an immutable dispatch plan before the existing persona fan-out. The plan assigns every changed file to a baseline review unit, applies first-match-wins path/rule criteria, and optionally bundles explicitly related files. Existing `reviewUnitManifest.js`, `reviewInvestigation.js`, `reviewNavigationTools.js`, `coveragePolicy.js`, and `findingVerifier.js` remain the execution and safety authorities. The first release is shadow-only: it records routed units and reflection/learning recommendations while the current roster and gate remain authoritative.

**Tech Stack:** Node.js 20, CommonJS runtime modules, TypeScript declaration files, Vitest 4, immutable GitHub REST blob snapshots, OpenRouter JSON turns, existing Review Yeti receipt/telemetry contracts, and GitHub Action artifacts.

## Global Constraints

- Shadow mode must never remove a current persona, suppress a mandatory security lane, waive an uncovered file, or change a `SHIP`/`BLOCK` decision.
- All executable policy comes from the pull-request base SHA and is bound to repository, PR number, base SHA, head SHA, config digest, and policy digest.
- Hosted Action inputs may reduce trusted budgets but may not enable routing, change rules, add tools, or weaken the merge gate.
- Rules are deterministic and first-match-wins within each precedence layer; model output may not select files, rules, personas, bundles, or waivers.
- Every changed file receives a baseline unit. Exclusions and oversized files remain explicit manifest states and remain blocking when the current coverage policy requires them.
- Investigation tools remain restricted to `file_read`, `file_find`, `code_search`, and `file_read_diff`; no shell, write, credential, arbitrary URL, or GitHub mutation tool is added.
- Investigation limits remain bounded: 12 calls, 400 read lines, 50 search matches, 8,000 result bytes, two repeated calls, five candidate findings, three verifier calls per finding, and four model turns by default.
- Reflection filters candidate findings only. It may keep, downgrade, or reject a candidate; it may not invent findings or override deterministic anchor/evidence verification.
- Learning observations produce versioned proposals only. No historical outcome, memory provider, or model inference may silently alter future routing.
- Do not add a second paid reviewer or a second publication authority. Review Yeti remains the single hosted reviewer and `findingVerifier.js` remains the publication safety boundary.
- Every task follows TDD: write the focused failing test, run it, implement the smallest passing change, run focused and relevant regression tests, then commit.

---

## File Map

**Create**

- `src/review/reviewDispatchPolicy.js` — normalize layered first-match-wins rules and safe shadow/enforce modes.
- `src/review/reviewDispatchPolicy.d.ts` — public dispatch policy and rule types.
- `src/review/reviewDispatchPlan.js` — compile immutable file assignments, explicit bundles, baseline lanes, and specialist lanes.
- `src/review/reviewDispatchPlan.d.ts` — dispatch plan and unit types.
- `src/review/reviewReflection.js` — run the bounded independent candidate filter without exposing investigator tool traces.
- `src/review/reviewReflection.d.ts` — reflection input/output types.
- `src/review/reviewLearning.js` — normalize observations and create thresholded, approval-required learning proposals.
- `src/review/reviewLearning.d.ts` — learning observation/proposal types.
- `scripts/evaluate-dispatch-shadow.mjs` — replay labeled fixtures and report coverage, duplicate, precision, recall, token, and latency metrics.
- `tests/fixtures/dispatch-shadow/evaluation-matrix.json` — deterministic labeled PR/unit cases for replay.
- `tests/fixtures/dispatch-shadow/learning-observations.json` — accepted, dismissed, duplicate, and escaped-defect observations.
- `tests/unit/reviewDispatchPolicy.test.ts`
- `tests/unit/reviewDispatchPlan.test.ts`
- `tests/unit/reviewReflection.test.ts`
- `tests/unit/reviewLearning.test.ts`
- `tests/unit/dispatchShadowEvaluation.test.ts`

**Modify**

- `src/review/reviewPolicyResolver.js` / `.d.ts` — resolve `review_intelligence.dispatch` from the immutable base and keep v1 compatibility inert.
- `src/review/reviewUnitManifest.js` / `.d.ts` — expose stable unit lookup and covered/uncovered paths to the dispatch compiler.
- `src/review/reviewInvestigation.js` — accept a dispatch unit and use its criteria, allowed tools, and lower limits without changing global hard ceilings.
- `src/review/reviewInvestigationPrompt.js` — render deterministic unit criteria and require unit IDs in risk plans/findings.
- `src/runtime/reviewPipelineRuntime.js` — carry the plan digest and unit scope through model-turn and receipt boundaries if the runtime adapter owns the seam.
- `.github/workflows/pipelines/review-pipeline.js` — compile the plan before fan-out, run shadow assignments alongside the existing roster, invoke reflection in shadow mode, and publish plan telemetry.
- `src/review/findingVerifier.js` — preserve exact anchor checks and add a receipt-safe reflection status without accepting reflection output as evidence.
- `src/telemetry/reviewTelemetry.js` — record plan/rule/unit/reflection/learning metrics without raw prompts, code, or credentials.
- `action.yml` — expose report-only outputs and reductions only; do not add a hosted input that can enable enforcement.
- `README.md`, `docs/CONFIGURATION_REFERENCE.md`, `docs/ARCHITECTURE.md`, `docs/PUBLICATION_POLICY.md` — document the schema, precedence, shadow mode, evidence boundaries, and promotion process.

---

### Task 1: Trusted dispatch policy contract

**Files:**
- Create: `src/review/reviewDispatchPolicy.js`
- Create: `src/review/reviewDispatchPolicy.d.ts`
- Modify: `src/review/reviewPolicyResolver.js`
- Modify: `src/review/reviewPolicyResolver.d.ts`
- Test: `tests/unit/reviewDispatchPolicy.test.ts`
- Test: `tests/unit/reviewPolicyResolver.compatibility.test.ts`

**Interfaces:**
- Consumes: trusted base YAML, immutable base/head refs, built-in system rules, and optional local-only CLI restrictions.
- Produces: `resolveDispatchPolicy(input)`, `matchDispatchRule(path, rules)`, `normalizeDispatchMode(value)`, and a frozen policy containing `schemaVersion`, `mode`, `precedence`, `rules`, `baselinePersonaIds`, and `policyDigest`.

- [ ] **Step 1: Write failing tests for precedence and fail-closed policy.**

```ts
it('uses first matching rule within precedence order and keeps a baseline lane', () => {
  const policy = resolveDispatchPolicy({
    trustedConfig: { review_intelligence: { version: 2, enabled: true, dispatch: {
      mode: 'shadow',
      rules: [
        { id: 'workflow', paths: ['.github/workflows/**'], personas: ['security'], criteria: ['permissions'] },
        { id: 'default', paths: ['**/*'], personas: ['architecture'], criteria: ['correctness'] },
      ],
    } } },
    builtInRules: [{ id: 'builtin-baseline', paths: ['**/*'], personas: ['security'], criteria: ['baseline'] }],
    baselinePersonaIds: ['security'],
    hosted: true,
  });
  expect(matchDispatchRule('.github/workflows/review.yml', policy.rules).id).toBe('workflow');
  expect(policy.baselinePersonaIds).toEqual(['security']);
  expect(policy.mode).toBe('shadow');
});

it('rejects malformed, unbounded, or action-enabled dispatch policy', () => {
  expect(() => resolveDispatchPolicy({
    trustedConfig: { review_intelligence: { version: 2, enabled: true, dispatch: { mode: 'enforce', rules: [{ id: 'x', paths: ['**/*'], tools: ['shell'] }] } } },
    actionInputs: { dispatchEnabled: 'true' },
    hosted: true,
  })).toThrow(/may not enable|tool|mode/i);
});
```

- [ ] **Step 2: Run the focused tests and verify the resolver exports are missing.**

Run: `npx vitest run tests/unit/reviewDispatchPolicy.test.ts tests/unit/reviewPolicyResolver.compatibility.test.ts`

Expected: FAIL because the dispatch resolver and v2 contract do not exist.

- [ ] **Step 3: Implement the minimal policy resolver.**

Use these exact contract rules:

```js
const DISPATCH_SCHEMA_VERSION = 'review-dispatch-policy-v1';
const DISPATCH_MODES = new Set(['shadow', 'enforce']);
const ALLOWED_TOOLS = new Set(['file_read', 'file_find', 'code_search', 'file_read_diff']);

function resolveDispatchPolicy({ trustedConfig, builtInRules = [], baselinePersonaIds = ['security'], actionInputs = {}, hosted = true } = {}) {
  // Read only trustedConfig from the already-validated base SHA.
  // In hosted mode, actionInputs can disable or reduce the plan but cannot enable it,
  // change rules, add tools, or select enforce mode.
  // Sort layers as action restriction, repository rules, built-ins; within a layer,
  // preserve declared order and take the first matching rule.
}
```

Validate non-empty rule IDs, canonical relative globs, allowed persona IDs, allowed criteria IDs, allowed tools, positive bounded limits, explicit `mode`, and a baseline rule. Invalid or missing v2 configuration returns `{ status: 'disabled', mode: 'shadow', reason: 'invalid_dispatch_policy' }` with no executable rules. Keep v1 `review_intelligence` behavior unchanged.

- [ ] **Step 4: Run focused and compatibility tests.**

Run: `npx vitest run tests/unit/reviewDispatchPolicy.test.ts tests/unit/reviewPolicyResolver.compatibility.test.ts`

Expected: PASS, including v1 disabled/inert behavior and hosted input restrictions.

- [ ] **Step 5: Commit.**

```bash
git add src/review/reviewDispatchPolicy.js src/review/reviewDispatchPolicy.d.ts src/review/reviewPolicyResolver.js src/review/reviewPolicyResolver.d.ts tests/unit/reviewDispatchPolicy.test.ts tests/unit/reviewPolicyResolver.compatibility.test.ts
git commit -m "feat(review): add trusted deterministic dispatch policy"
```

### Task 2: Immutable dispatch plan and related-file bundles

**Files:**
- Create: `src/review/reviewDispatchPlan.js`
- Create: `src/review/reviewDispatchPlan.d.ts`
- Modify: `src/review/reviewUnitManifest.js`
- Modify: `src/review/reviewUnitManifest.d.ts`
- Test: `tests/unit/reviewDispatchPlan.test.ts`
- Test: `tests/unit/reviewUnitManifest.test.ts`

**Interfaces:**
- Consumes: `createReviewUnitManifest`, the resolved dispatch policy, changed files, expected persona IDs, and immutable review identity.
- Produces: `createReviewDispatchPlan(input)`, `bundleReviewUnits(input)`, and a frozen `review-dispatch-plan-v1` with `units`, `baselineCoverage`, `summary`, and `planDigest`.

- [ ] **Step 1: Write failing tests for coverage, first-match routing, and safe bundling.**

```ts
it('assigns every selected file to a baseline and specialist route', () => {
  const plan = createReviewDispatchPlan({ identity, manifest, policy, expectedPersonaIds: ['security', 'testing'] });
  expect(plan.units.flatMap((unit) => unit.reviewUnitIds)).toEqual(manifest.units.filter((u) => u.status === 'selected').map((u) => u.id));
  expect(plan.units.every((unit) => unit.baselinePersonaIds.includes('security'))).toBe(true);
  expect(plan.units.find((unit) => unit.paths.includes('src/a.js')).ruleId).toBe('javascript');
});

it('bundles only explicit related files and never creates an uncovered path', () => {
  const plan = createReviewDispatchPlan({ identity, manifest, policy: { ...policy, bundleRules: [{ id: 'module-test', paths: ['src/a.js', 'test/a.test.js'] }] } });
  expect(plan.units.filter((unit) => unit.bundleKey === 'module-test')).toHaveLength(1);
  expect(plan.coverage.complete).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and verify the planner is missing.**

Run: `npx vitest run tests/unit/reviewDispatchPlan.test.ts tests/unit/reviewUnitManifest.test.ts`

Expected: FAIL because `reviewDispatchPlan.js` and its exports do not exist.

- [ ] **Step 3: Implement deterministic plan compilation.**

Use one file-level unit by default. Permit bundling only when a trusted rule supplies an exact `bundleKey` or a finite list of matching globs. Never infer a bundle from model output or historical safety. Preserve manifest states `excluded`, `oversized`, `unreviewable`, and `failed`; report them in `coverage` rather than hiding them.

The output unit shape is:

```js
{
  id: 'du_<sha256>',
  reviewUnitIds: ['ru_<sha256>'],
  paths: ['src/a.js'],
  ruleId: 'javascript',
  criteriaIds: ['correctness', 'tests'],
  baselinePersonaIds: ['security'],
  specialistPersonaIds: ['architecture', 'testing'],
  allowedTools: ['file_read', 'file_find', 'code_search', 'file_read_diff'],
  limits: { maxCalls: 8, maxReadLines: 400, maxSearchMatches: 50, maxResultBytes: 8000 },
  bundleKey: null,
}
```

Hash the canonical identity, policy digest, manifest digest, ordered unit IDs, and ordered assignments into `planDigest`. A repeated compile of the same input must produce byte-identical JSON.

- [ ] **Step 4: Run focused tests.**

Run: `npx vitest run tests/unit/reviewDispatchPlan.test.ts tests/unit/reviewUnitManifest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/review/reviewDispatchPlan.js src/review/reviewDispatchPlan.d.ts src/review/reviewUnitManifest.js src/review/reviewUnitManifest.d.ts tests/unit/reviewDispatchPlan.test.ts tests/unit/reviewUnitManifest.test.ts
git commit -m "feat(review): compile immutable dispatch units"
```

### Task 3: Feed routed criteria into bounded investigation

**Files:**
- Modify: `src/review/reviewInvestigation.js`
- Modify: `src/review/reviewInvestigationPrompt.js`
- Modify: `src/review/reviewInvestigation.d.ts`
- Modify: `tests/unit/reviewInvestigation.test.ts`
- Modify: `tests/unit/reviewInvestigationPrompt.test.ts`
- Test: `tests/unit/reviewDispatchPlan.test.ts`

**Interfaces:**
- Consumes: a dispatch unit from Task 2 and the existing evidence registry.
- Produces: unit-scoped risk plans whose `unit_ids` are members of the immutable plan and whose tool/limit requests cannot exceed the unit policy.

- [ ] **Step 1: Add failing tests for unit scope and bounded criteria.**

```ts
it('rejects a risk plan that escapes its assigned unit', async () => {
  await expect(runPersonaInvestigation({
    identity, persona, dispatchUnit: unitWithIds(['ru_allowed']),
    modelTurn: async () => completeResponse({ riskPlan: [{ id: 'risk-1', unitIds: ['ru_other'] }] }),
  })).resolves.toMatchObject({ personaResult: { decision: 'ERROR' } });
});

it('renders criteria and allowed tools without exposing unrestricted capabilities', () => {
  const messages = buildInvestigationMessages({ dispatchUnit: unitWithCriteria });
  expect(JSON.stringify(messages)).toContain('permissions');
  expect(JSON.stringify(messages)).toContain('file_read');
  expect(JSON.stringify(messages)).not.toMatch(/shell|write_file|arbitrary URL/i);
});
```

- [ ] **Step 2: Run focused tests and verify the scope checks fail.**

Run: `npx vitest run tests/unit/reviewInvestigation.test.ts tests/unit/reviewInvestigationPrompt.test.ts`

Expected: FAIL because the investigation parser does not receive a dispatch-unit boundary.

- [ ] **Step 3: Thread unit scope through the existing state machine.**

Add `dispatchUnit` to `runPersonaInvestigation` input. Intersect unit limits with global limits. Require every risk plan `unit_id` to exist in `dispatchUnit.reviewUnitIds`; require every requested tool to be in both the unit allowlist and `EVIDENCE_TOOLS`; and retain the existing evidence-receipt requirement. Include criteria as data in the prompt, not as executable instructions.

- [ ] **Step 4: Run focused regression tests.**

Run: `npx vitest run tests/unit/reviewInvestigation.test.ts tests/unit/reviewInvestigationPrompt.test.ts tests/unit/evidenceRuntime.test.ts`

Expected: PASS with existing provider-failure, repeated-call, malformed-response, and unavailable-tool behavior unchanged.

- [ ] **Step 5: Commit.**

```bash
git add src/review/reviewInvestigation.js src/review/reviewInvestigation.d.ts src/review/reviewInvestigationPrompt.js tests/unit/reviewInvestigation.test.ts tests/unit/reviewInvestigationPrompt.test.ts
git commit -m "feat(review): scope investigation to routed units"
```

### Task 4: Shadow plan telemetry and replay evaluation

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Modify: `src/telemetry/reviewTelemetry.js`
- Modify: `action.yml`
- Create: `scripts/evaluate-dispatch-shadow.mjs`
- Create: `tests/fixtures/dispatch-shadow/evaluation-matrix.json`
- Create: `tests/unit/dispatchShadowEvaluation.test.ts`
- Test: `tests/unit/reviewPipelineDispatch.test.ts`
- Test: `tests/unit/reviewTelemetry.test.ts`

**Interfaces:**
- Consumes: immutable manifest, resolved policy, dispatch plan, existing persona roster, findings, and usage receipts.
- Produces: plan telemetry and Action outputs `dispatch-mode`, `dispatch-plan-digest`, `dispatch-units-planned`, `dispatch-units-covered`, `dispatch-rules-applied`, and `dispatch-shadow-status`.

- [ ] **Step 1: Write failing integration tests for shadow non-interference.**

```ts
it('records the routed plan while preserving the existing roster and gate inputs', async () => {
  const result = await runReview({ trustedConfig: shadowConfig, files: changedFiles, model: scriptedModel });
  expect(result.personaIds).toEqual(existingRosterIds);
  expect(result.investigation.dispatch.mode).toBe('shadow');
  expect(result.investigation.dispatch.unitsPlanned).toBeGreaterThan(0);
  expect(result.arbitrationInput).not.toHaveProperty('routedFindingsOnly');
});
```

- [ ] **Step 2: Run focused tests and verify telemetry/output fields are missing.**

Run: `npx vitest run tests/unit/reviewPipelineDispatch.test.ts tests/unit/reviewTelemetry.test.ts`

Expected: FAIL because the pipeline does not compile or publish dispatch telemetry.

- [ ] **Step 3: Compile the plan before persona fan-out.**

Create the provisional manifest, resolve the trusted dispatch policy, compile the plan, and pass each unit to the existing bounded investigation. In shadow mode, keep the current `enabledPersonas` and current arbitration input unchanged. Add only receipt-safe plan fields to the investigation summary and GitHub outputs.

- [ ] **Step 4: Add the replay evaluator and fixture matrix.**

The matrix must contain at least these labeled cases: workflow permission change, API handler plus test, dependency manifest change, generated-file-only change, rename-only change, security-sensitive config change, and unrelated documentation change. The evaluator reports:

```text
files_assigned / files_changed
baseline_coverage_gaps
specialist_assignment_precision
duplicate_unit_rate
finding_precision
finding_recall_when_reference_labels_exist
prompt_tokens
completion_tokens
wall_time_ms
```

It must refuse to calculate recall when a case lacks a reference label instead of treating “no finding” as a true negative.

- [ ] **Step 5: Run focused and replay tests.**

Run: `npx vitest run tests/unit/reviewPipelineDispatch.test.ts tests/unit/reviewTelemetry.test.ts tests/unit/dispatchShadowEvaluation.test.ts`

Expected: PASS; shadow routing cannot change the existing verdict.

- [ ] **Step 6: Commit.**

```bash
git add .github/workflows/pipelines/review-pipeline.js src/telemetry/reviewTelemetry.js action.yml scripts/evaluate-dispatch-shadow.mjs tests/fixtures/dispatch-shadow tests/unit/reviewPipelineDispatch.test.ts tests/unit/reviewTelemetry.test.ts tests/unit/dispatchShadowEvaluation.test.ts
git commit -m "feat(review): measure deterministic dispatch in shadow mode"
```

### Task 5: Independent reflection filter

**Files:**
- Create: `src/review/reviewReflection.js`
- Create: `src/review/reviewReflection.d.ts`
- Modify: `src/review/findingVerifier.js`
- Modify: `src/review/findingVerifier.d.ts`
- Test: `tests/unit/reviewReflection.test.ts`
- Test: `tests/unit/findingVerifier.test.ts`
- Test: `tests/unit/findingVerifierPipeline.test.ts`

**Interfaces:**
- Consumes: candidate findings, exact diff text, immutable identity, and a provider-neutral `modelTurn` function.
- Produces: `runFindingReflection(input)` with `KEEP`, `DOWNGRADE`, `DROP`, or `NEEDS_REVIEW` decisions plus redacted reflection receipts.

- [ ] **Step 1: Write failing tests for the asymmetric boundary.**

```ts
it('passes the diff and candidate claim but not investigator evidence/tool trace', async () => {
  const calls = [];
  const result = await runFindingReflection({
    identity,
    findings: [candidateFinding],
    diffText: '+ if (!authorized) return 403;',
    investigatorTrace: { secret: 'must-not-leak', toolResults: ['hidden'] },
    modelTurn: async (input) => { calls.push(input); return keepResponse(); },
    mode: 'shadow',
  });
  expect(JSON.stringify(calls[0])).toContain('403');
  expect(JSON.stringify(calls[0])).not.toContain('must-not-leak');
  expect(JSON.stringify(calls[0])).not.toContain('hidden');
  expect(result.receipts[0].decision).toBe('KEEP');
});

it('never creates a finding and fails closed on malformed reflection', async () => {
  const result = await runFindingReflection({ ...input, modelTurn: async () => ({ ok: true, content: '{}' }) });
  expect(result.createdFindings).toEqual([]);
  expect(result.receipts[0].decision).toBe('NEEDS_REVIEW');
});
```

- [ ] **Step 2: Run focused tests and verify the reflection module is missing.**

Run: `npx vitest run tests/unit/reviewReflection.test.ts tests/unit/findingVerifier.test.ts`

Expected: FAIL because the independent reflection module does not exist.

- [ ] **Step 3: Implement a filter-only, bounded reflection turn.**

The reflection prompt receives the exact diff, candidate path/line/title/body, and deterministic anchor status. It does not receive investigation requests, evidence result text, model chain state, or hidden tool traces. Its JSON schema is:

```json
{"decision":"KEEP|DOWNGRADE|DROP|NEEDS_REVIEW","severity":"P0|P1|P2|null","reason_code":"specific_diff_support|unsupported_claim|wrong_anchor|duplicate|malformed"}
```

Run at most one reflection turn per candidate, cap candidates at five, store only the allowlisted receipt, and leave `findingVerifier` as the authority for exact snapshot/evidence acceptance. Shadow mode must not change published findings; enforce mode may be added only after Task 8 promotion criteria pass.

- [ ] **Step 4: Run focused tests.**

Run: `npx vitest run tests/unit/reviewReflection.test.ts tests/unit/findingVerifier.test.ts tests/unit/findingVerifierPipeline.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/review/reviewReflection.js src/review/reviewReflection.d.ts src/review/findingVerifier.js src/review/findingVerifier.d.ts tests/unit/reviewReflection.test.ts tests/unit/findingVerifier.test.ts tests/unit/findingVerifierPipeline.test.ts
git commit -m "feat(review): add independent finding reflection"
```

### Task 6: Auditable learning proposals

**Files:**
- Create: `src/review/reviewLearning.js`
- Create: `src/review/reviewLearning.d.ts`
- Modify: `src/telemetry/reviewTelemetry.js`
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Test: `tests/unit/reviewLearning.test.ts`
- Create: `tests/fixtures/dispatch-shadow/learning-observations.json`

**Interfaces:**
- Consumes: receipt-safe review outcomes, path/rule assignments, human resolution labels, and labeled historical replay results.
- Produces: `recordLearningObservation(input)`, `aggregateLearningProposals(input)`, and signed/versioned `review-learning-proposal-v1` artifacts that require an administrator commit before activation.

- [ ] **Step 1: Write failing tests for proposal safety.**

```ts
it('creates a proposal without changing the active policy', () => {
  const proposal = aggregateLearningProposals({
    observations: acceptedAndDismissedForSamePattern,
    activePolicyDigest: 'a'.repeat(64),
    identity,
  });
  expect(proposal.status).toBe('candidate');
  expect(proposal.requiresAdminApproval).toBe(true);
  expect(proposal.activePolicyDigest).toBe('a'.repeat(64));
});

it('does not promote a rule from one accepted review or a missing-label sample', () => {
  const proposal = aggregateLearningProposals({ observations: [oneAccepted], identity });
  expect(proposal.status).toBe('insufficient_evidence');
});
```

- [ ] **Step 2: Run focused tests and verify the learning module is missing.**

Run: `npx vitest run tests/unit/reviewLearning.test.ts`

Expected: FAIL because the proposal functions do not exist.

- [ ] **Step 3: Implement observation and proposal contracts.**

Persist only: repository, PR number, base/head identity digest, unit/rule IDs, path glob, outcome category (`accepted`, `dismissed`, `duplicate`, `fixed`, `reopened`, `escaped_defect`), and receipt-safe metrics. Do not persist prompts, raw source, evidence text, credentials, or hidden reasoning.

Require three independently reviewed examples and an explicit labeled outcome for every example before producing a candidate. A candidate is never active; its artifact contains `requiresAdminApproval: true`, the active policy digest, proposed rule, supporting observation IDs, and replay metrics. Memory providers may supply advisory context but cannot write or activate a dispatch rule.

- [ ] **Step 4: Run focused tests.**

Run: `npx vitest run tests/unit/reviewLearning.test.ts tests/unit/reviewTelemetry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/review/reviewLearning.js src/review/reviewLearning.d.ts src/telemetry/reviewTelemetry.js .github/workflows/pipelines/review-pipeline.js tests/unit/reviewLearning.test.ts tests/fixtures/dispatch-shadow/learning-observations.json
git commit -m "feat(review): emit approval-required learning proposals"
```

### Task 7: Configuration, receipts, and operator documentation

**Files:**
- Modify: `action.yml`
- Modify: `README.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PUBLICATION_POLICY.md`
- Modify: `tests/unit/reviewActionPackaging.test.ts`
- Modify: `tests/unit/reviewPipeline.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 output fields and trusted configuration schema.
- Produces: documented `review_intelligence.dispatch` configuration and report-only Action outputs.

- [ ] **Step 1: Add failing schema/documentation tests.**

```ts
it('documents shadow mode and exposes only receipt-safe dispatch outputs', () => {
  expect(read('README.md')).toContain('review_intelligence.dispatch');
  expect(read('docs/ARCHITECTURE.md')).toContain('first-match-wins');
  expect(read('action.yml')).toContain('dispatch-plan-digest');
  expect(read('action.yml')).not.toMatch(/dispatch-enabled:\s*true/i);
});
```

- [ ] **Step 2: Run focused tests and verify documentation/output fields are absent.**

Run: `npx vitest run tests/unit/reviewActionPackaging.test.ts tests/unit/reviewPipeline.test.ts`

Expected: FAIL because the new output contract is not documented or packaged.

- [ ] **Step 3: Document the trusted configuration and precedence.**

Add this example to the configuration reference:

```yaml
review_intelligence:
  version: 2
  enabled: true
  dispatch:
    mode: shadow
    rules:
      - id: workflow-security
        paths: [.github/workflows/**, action.yml]
        criteria: [permissions, secret-flow, action-pinning]
        personas: [security, architecture]
        tools: [file_read, file_find, code_search, file_read_diff]
        first_match_wins: true
      - id: code-tests
        paths: [src/**, lib/**, test/**, tests/**]
        criteria: [correctness, tests, API-compatibility]
        personas: [architecture, testing]
        tools: [file_read, file_find, code_search, file_read_diff]
```

Document precedence as: local CLI restriction for preview only, trusted repository base rules, immutable Review Yeti built-ins, then system baseline. Hosted action inputs can only narrow the result. Document that `review_intelligence` fields are inert unless the action emits a matching plan digest and dispatch receipt.

- [ ] **Step 4: Add receipt-safe outputs and documentation.**

Add outputs for mode, plan digest, planned/covered units, applied rule IDs, reflection status, and learning proposal ID. Never publish raw prompts, code blobs, tool output, or model chain state through outputs.

- [ ] **Step 5: Run focused tests and documentation checks.**

Run: `npx vitest run tests/unit/reviewActionPackaging.test.ts tests/unit/reviewPipeline.test.ts && npm run lint --if-present`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add action.yml README.md docs/CONFIGURATION_REFERENCE.md docs/ARCHITECTURE.md docs/PUBLICATION_POLICY.md tests/unit/reviewActionPackaging.test.ts tests/unit/reviewPipeline.test.ts
git commit -m "docs(review): publish deterministic dispatch contracts"
```

### Task 8: Shadow rollout and enforce-mode promotion gate

**Files:**
- Modify: `.github/workflows/review-bot.yaml`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/EVALUATION_CLI.md`
- Test: `tests/integration/reviewWorkflow.integration.test.ts`
- Test: `tests/integration/reviewWorkflowChaos.integration.test.ts`

**Interfaces:**
- Consumes: replay evaluator, live shadow receipts, existing current-head checks, and administrator-approved policy commits.
- Produces: a documented promotion decision and a separate, explicit follow-up change for enforce mode.

- [ ] **Step 1: Write failing rollout assertions.**

```ts
it('keeps the existing roster and merge gate authoritative in shadow mode', async () => {
  const run = await replayScenario('workflow-permission-change');
  expect(run.dispatch.mode).toBe('shadow');
  expect(run.currentRosterGate).toBe(run.baselineRosterGate);
  expect(run.dispatch.baselineCoverageGaps).toBe(0);
});

it('blocks promotion when plan, reflection, or evidence receipts are incomplete', () => {
  expect(canPromote({ planComplete: false, reflectionComplete: true, labeledMetrics: completeMetrics })).toBe(false);
  expect(canPromote({ planComplete: true, reflectionComplete: false, labeledMetrics: completeMetrics })).toBe(false);
});
```

- [ ] **Step 2: Run the integration tests and verify the promotion helper is missing.**

Run: `npx vitest run tests/integration/reviewWorkflow.integration.test.ts tests/integration/reviewWorkflowChaos.integration.test.ts`

Expected: FAIL because the rollout assertions and promotion helper do not exist.

- [ ] **Step 3: Run shadow evaluation against historical and live fixtures.**

Use at least 30 labeled historical PR cases across workflow, security, dependency, API, test, documentation, generated, and rename changes. Record baseline versus routed assignment, duplicate rate, accepted-finding precision, labeled recall, token cost, latency, incomplete lanes, and coverage gaps. Cases without reference labels report `not_evaluable` for recall.

- [ ] **Step 4: Define the enforce-mode promotion conditions.**

Require all of the following before a separate enforce-mode PR:

```text
100% of changed files receive a baseline unit in the replay corpus.
0 shadow-run coverage gaps caused by dispatch.
0 reflection-created findings.
0 evidence or identity receipt regressions.
No increase in incomplete Review Yeti lanes attributable to routing.
All proposed learning rules have administrator approval and replay evidence.
```

Enforce mode must be a separate reviewed configuration/code change. Until then, `findingVerifier`, current roster, and existing `SHIP/PASS/zero-omitted` gate remain authoritative.

- [ ] **Step 5: Run the complete verification set.**

Run: `npx vitest run tests/unit tests/security tests/integration && npm test --if-present && git diff --check`

Expected: PASS with no new second reviewer workflow and no secrets in artifacts.

- [ ] **Step 6: Commit the rollout documentation only after shadow evidence is complete.**

```bash
git add .github/workflows/review-bot.yaml docs/OPERATIONS.md docs/EVALUATION_CLI.md tests/integration/reviewWorkflow.integration.test.ts tests/integration/reviewWorkflowChaos.integration.test.ts
git commit -m "docs(review): define dispatch shadow promotion gate"
```

---

## Self-review against the requested design

- Deterministic file filtering: Task 2.
- Layered first-match-wins path/rule resolution: Task 1.
- Related-file bundling without broad repository context: Task 2.
- Mandatory baseline plus specialist routing: Tasks 1 and 2.
- Bounded evidence investigation: Task 3, reusing the existing four read-only tools and receipt limits.
- Independent reflection/filtering: Task 5.
- Precise comment positioning: preserved in `findingVerifier.js`; Task 5 adds only a filter status.
- Shadow mode and measurement before behavior change: Task 4 and Task 8.
- Historical learning without silent waivers: Task 6.
- Top-reviewer patterns from PR-Agent and CodeRabbit: Task 7’s repository instructions, path rules, incremental receipts, and approval-required learning model.
- Existing Review Yeti safety boundary: all tasks retain immutable identity, exact-head receipts, current roster, mandatory security, quorum, and fail-closed publication.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-11-deterministic-review-dispatch-learning-loop.md`. Two execution options:

1. **Subagent-driven** — dispatch a fresh implementation agent per task with review checkpoints.
2. **Inline execution** — execute the plan in this session with checkpointed batches.
