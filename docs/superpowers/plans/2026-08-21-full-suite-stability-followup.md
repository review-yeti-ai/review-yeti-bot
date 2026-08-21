# Full Suite Stability Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository-wide Node/Vitest suite deterministic and green after the Pi runtime merge while preserving the exact Review Yeti and hosted-test contracts.

**Architecture:** First establish a baseline matrix on current `main` and the follow-up head so only reproducible defects are changed. Then repair the model/provider contracts, regenerate cassette fixtures from the canonical pipeline prompt, and harden the synthetic HTTP request fixtures against the supported Node runtime. The final gate runs focused suites, the full suite, hosted `test`, and exact-head Review Yeti before merge.

**Tech Stack:** TypeScript, Node.js, Vitest, JSON cassettes, Express-style request fixtures, GitHub Actions, Review Yeti.

**Spec:** `docs/superpowers/specs/2026-08-20-pi-dynamic-review-workflow-design.md` and merged PR #172 runtime contract.

## Global Constraints

- Preserve the legacy review engine as the default; no provider or runtime behavior may silently change outside the failing contracts.
- Keep all cassette requests offline and deterministic; never record or print credentials.
- Keep exact dependency and package metadata synchronized (`package.json``, root `package-lock.json`, and `pi-runtime/package-lock.json`).
- Use current `main` as the PR base and require exact-head hosted `test` plus Review Yeti `SHIP` before merge.
- Do not convert baseline failures into skips or weaken assertions; update stale fixtures/tests only when the canonical source contract proves they are obsolete.
- Preserve the bounded installer behavior already covered by `tests/unit/reviewActionPackaging.test.ts`.

---

### Task 1: Establish the reproducibility matrix

**Files:**
- Create: `docs/superpowers/evidence/2026-08-21-full-suite-stability.md`
- Test: existing failing suites listed below; no production edits in this task

**Interfaces:**
- Produces a failure matrix with exact command, Node version, git SHA, test file, failure count, and classification (`regression`, `stale fixture`, `environment-only`, or `baseline`).

- [ ] **Step 1: Record the exact inputs**

```bash
git fetch official main
node --version
git rev-parse HEAD official/main
git diff --name-only official/main...HEAD
```

- [ ] **Step 2: Reproduce model/provider failures in isolation**

```bash
npx vitest run \
  tests/integration/challenger2EmpiricalM1AliasAndCache.test.ts \
  tests/integration/m2EmpiricalStressChallenger.test.ts \
  tests/integration/milestone2EmpiricalChallenger.test.ts \
  tests/integration/m43m44EmpiricalChallenger.test.ts \
  tests/unit/lib/modelFiltering.test.ts
```

Expected current failures are the duplicate fallback count, `agy/...` provider mapping, synthetic model filtering, stale OpenRouter model option, and hard-coded package version.

- [ ] **Step 3: Reproduce cassette and HTTP fixture failures separately**

```bash
npx vitest run tests/integration/reviewReplay.test.ts tests/integration/openRouterFleetReplay.test.ts
npx vitest run tests/integration/routerApiIntegration.test.ts tests/integration/providerRouterApi.test.ts
```

Capture assertion failures and uncaught error counts; do not change code until each is reproducible in isolation.

- [ ] **Step 4: Commit the evidence record**

```bash
git add docs/superpowers/evidence/2026-08-21-full-suite-stability.md
git commit -m "docs: record full suite stability baseline"
```

### Task 2: Restore canonical model/provider identity

**Files:**
- Modify: `src/lib/model-filtering.ts:30-75`
- Modify: `src/services/openRouterModelService.ts:70-360`
- Modify: `tests/unit/lib/modelFiltering.test.ts`
- Modify: `tests/integration/m2EmpiricalStressChallenger.test.ts`
- Modify: `tests/integration/challenger2EmpiricalM1AliasAndCache.test.ts`
- Test: `tests/integration/milestone2EmpiricalChallenger.test.ts`

**Interfaces:**
- `getProviderIdForModel(modelId, modelRegistry)` must resolve explicit namespaces before generated metadata: `agy/` → `agy`, `synthetic/` and `opencode-go/` → `glm`, `codex/` → `codex`, and `openrouter/` → `openrouter`.
- `FALLBACK_OPENROUTER_MODELS` must contain one entry per ID; `populateFallbacks` and `getFallbackModels` must return the same number of unique IDs.

- [ ] **Step 1: Add RED assertions**

```ts
expect(getProviderIdForModel('agy/claude-opus-4-6-thinking')).toBe('agy');
expect(getProviderIdForModel('synthetic/hf:moonshotai/Kimi-K3')).toBe('glm');
expect(new Set(FALLBACK_OPENROUTER_MODELS.map((model) => model.id)).size)
  .toBe(FALLBACK_OPENROUTER_MODELS.length);
```

- [ ] **Step 2: Implement explicit namespace precedence and remove duplicate fallback IDs**

Place namespace checks before the generated-provider loop. Keep the first canonical definitions for duplicate OpenRouter/Luna IDs and delete the later duplicate objects rather than returning two cache entries for one ID.

- [ ] **Step 3: Update stale model-option assertions to current canonical options**

Use `claude-5-haiku:high` (present in `AVAILABLE_MODEL_OPTIONS`) as the always-enabled Anthropic assertion instead of the removed `openrouter/anthropic/claude-3.5-sonnet` option.

- [ ] **Step 4: Replace the hard-coded release version assertion**

Read `package-lock.json` beside `package.json` and assert the two package versions are equal and valid semver; retain the package name assertion.

- [ ] **Step 5: Run the focused model suites**

```bash
npx vitest run \
  tests/unit/lib/modelFiltering.test.ts \
  tests/integration/challenger2EmpiricalM1AliasAndCache.test.ts \
  tests/integration/m2EmpiricalStressChallenger.test.ts \
  tests/integration/milestone2EmpiricalChallenger.test.ts \
  tests/integration/m43m44EmpiricalChallenger.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-filtering.ts src/services/openRouterModelService.ts tests/unit/lib/modelFiltering.test.ts tests/integration/challenger2EmpiricalM1AliasAndCache.test.ts tests/integration/m2EmpiricalStressChallenger.test.ts tests/integration/milestone2EmpiricalChallenger.test.ts tests/integration/m43m44EmpiricalChallenger.test.ts
git commit -m "fix(models): restore provider and fallback identity contracts"
```

### Task 3: Regenerate cassette fixtures from the canonical prompt

**Files:**
- Modify: `tests/support/openRouterReplayScenario.ts`
- Modify: `tests/fixtures/cassettes/openrouter/*.json`
- Modify: `tests/fixtures/cassettes/model-panel.json`
- Test: `tests/integration/reviewReplay.test.ts`
- Test: `tests/integration/openRouterFleetReplay.test.ts`

**Interfaces:**
- Every replay fixture’s request system message must equal the current `reviewWithModel` prompt, including hunk-line guidance and optional Tool Guidance.
- Fixture generation remains offline-only and must preserve response bodies, redaction, and interaction counts.

- [ ] **Step 1: Make the support prompt builder match the pipeline exactly**

Add these exact lines to `expectedSystemPrompt` in the existing order:

```ts
'- Use the exact file path from the diff headers and calculate the line number from the hunk headers (@@ -oldStart,oldCount +newStart,newCount @@).',
'',
'Tool Guidance (Optional on-demand):',
'- Workspace file reading (read_file, code_search, symbol_lookup) is available when you need to inspect un-modified callers or callee definitions.',
'- Context7 documentation search (context7_search, fetch_docs) is available when you need official external library/framework API specs.',
'- If the diff is clear and self-contained, render your findings immediately without unnecessary tool calls.',
```

Use the exact pipeline punctuation (`+newStart,newCount`) when implementing.

- [ ] **Step 2: Regenerate fixture request messages without recording network traffic**

Run a one-off Node/Vitest fixture migration that parses each JSON file, replaces only request message content and user prompt text from the canonical support constants/persona charters, and writes stable two-space JSON. Assert that response bodies and interaction counts are unchanged.

- [ ] **Step 3: Run replay suites**

```bash
npx vitest run tests/integration/reviewReplay.test.ts tests/integration/openRouterFleetReplay.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add tests/support/openRouterReplayScenario.ts tests/fixtures/cassettes/openrouter tests/fixtures/cassettes/model-panel.json tests/integration/reviewReplay.test.ts tests/integration/openRouterFleetReplay.test.ts
git commit -m "test(replay): regenerate cassettes from canonical prompts"
```

### Task 4: Make synthetic HTTP request fixtures Node-version safe

**Files:**
- Modify: `tests/integration/routerApiIntegration.test.ts:1-65`
- Modify: `tests/integration/providerRouterApi.test.ts:1-62`
- Test: same two files

**Interfaces:**
- `dispatchPost` must provide a request socket with `on`, `removeListener`, and `destroy` semantics expected by Node’s HTTP abort cleanup while retaining the current in-memory app invocation.

- [ ] **Step 1: Add a deterministic socket fixture**

```ts
import { EventEmitter } from 'node:events';

const socket = new EventEmitter();
req.socket = socket;
req.connection = socket;
```

Set this before invoking `app(req, res)` in both helpers; do not suppress uncaught errors globally.

- [ ] **Step 2: Run the HTTP suites**

```bash
npx vitest run tests/integration/routerApiIntegration.test.ts tests/integration/providerRouterApi.test.ts
```

Expected: all assertions pass and Vitest reports zero unhandled errors.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/routerApiIntegration.test.ts tests/integration/providerRouterApi.test.ts
git commit -m "test(http): provide socket lifecycle in router fixtures"
```

### Task 5: Full verification and landing

**Files:**
- Modify: `docs/superpowers/evidence/2026-08-21-full-suite-stability.md`

- [ ] **Step 1: Run all focused suites**

```bash
npx vitest run tests/unit/reviewActionPackaging.test.ts tests/unit/reviewWorkflowAssignments.test.ts tests/unit/buildProvenance.test.ts tests/unit/dynamicReviewWorkflow.test.ts
```

- [ ] **Step 2: Run the repository suite**

```bash
npm test
```

Expected: zero failed tests and zero uncaught errors. If a failure remains, return to Task 1 and classify it before changing code.

- [ ] **Step 3: Validate package/build contracts**

```bash
node --check scripts/install-action-runtime.mjs
node --check scripts/boundedDirectoryGuard.js
npm run lint
npm run build
git diff --check
```

- [ ] **Step 4: Push and rebase before hosted gates**

```bash
git fetch official main
git rebase official/main
git push --force-with-lease official HEAD
```

- [ ] **Step 5: Require exact-head hosted receipts**

Wait for hosted `test` and Review Yeti to complete on the pushed SHA. Review Yeti must report `SHIP`, 5/5 personas, quorum satisfied, and zero P0/P1/P2 findings.

- [ ] **Step 6: Merge only after all gates are green**

```bash
gh pr checks <number> --repo review-yeti-ai/review-yeti-bot
gh pr merge <number> --repo review-yeti-ai/review-yeti-bot --squash --delete-branch
gh api repos/review-yeti-ai/review-yeti-bot/branches/main --jq .commit.sha
```

Record the merged SHA, hosted test run, Review Yeti run, and local suite summary in the evidence file.
