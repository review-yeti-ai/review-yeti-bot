# Manual Evaluation CLI and TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Review Yeti's existing evaluation scripts into a manual, opt-in evaluation toolkit exposed through a stable CLI and a terminal TUI, without adding automatic CI evaluation triggers.

**Architecture:** Extract evaluation contracts, runners, receipt persistence, and comparison logic into reusable Node 20 modules. Keep the current offline fixture/cassette evaluator as the default safe mode and make live provider evaluation an explicit command requiring confirmation. The CLI owns scripting and exit codes; the TUI is a thin interactive client over the same runner and receipt APIs, so both surfaces produce identical artifacts.

**Tech Stack:** Node.js 20 ESM/CommonJS adapters, existing Review Yeti runtime/evaluator modules, JSON/Markdown receipts, Node `readline` and ANSI terminal primitives, Vitest.

## Global Constraints

- No new GitHub Actions workflow or automatic CI trigger is added by this feature.
- Offline evaluation must remain credential-free, deterministic, and safe to run on every checkout.
- Live provider calls require an explicit `--mode live`/TUI confirmation and must never print credentials.
- Every run is bound to an immutable repository, fixture/cassette digest, evaluator version, and source commit SHA.
- A provider timeout, missing credential, malformed response, or incomplete scenario is `INCONCLUSIVE`/`BLOCKED`, never a passing result.
- CLI and TUI share one runner and one receipt schema; they must not fork evaluation behavior.
- TUI support is dependency-free in the first slice; do not add Ink, Blessed, or another UI framework.

---

## Task 1: Define the evaluation toolkit contracts

**Files:**
- Create: `src/evaluation/evaluationContracts.js`
- Create: `src/evaluation/evaluationContracts.d.ts`
- Test: `tests/unit/evaluationContracts.test.ts`

**Interfaces:**
- `createEvaluationRequest(input) -> EvaluationRequest`
- `createEvaluationReceipt(input) -> EvaluationReceipt`
- `normalizeEvaluationStatus(value) -> 'PASS'|'FAIL'|'INCONCLUSIVE'|'BLOCKED'`
- `EVALUATION_SCHEMA_VERSION = 'review-yeti-evaluation-v1'`

- [ ] **Step 1: Write failing contract tests** for offline/live mode normalization, required identity fields, bounded repetitions/concurrency, redacted provider metadata, and stable schema version.
- [ ] **Step 2: Run** `npm test -- --run tests/unit/evaluationContracts.test.ts` and confirm the new exports are missing.
- [ ] **Step 3: Implement** strict request/receipt constructors. Reject missing `sourceSha`, fixture identity, or evaluator version; clamp repetitions to `1..10` and concurrency to `1..8`.
- [ ] **Step 4: Add TypeScript declarations** for request, scenario result, usage, comparison, and receipt shapes.
- [ ] **Step 5: Run the focused test and commit** with `feat: define evaluation toolkit contracts`.

## Task 2: Extract shared offline and live runners

**Files:**
- Create: `src/evaluation/evaluationRunner.js`
- Create: `src/evaluation/evaluationRunner.d.ts`
- Read through: `scripts/evaluate-review-intelligence.mjs`
- Read through: `scripts/run-review-intelligence-promotion.mjs`
- Test: `tests/unit/evaluationRunner.test.ts`
- Test: `tests/integration/evaluationRunner.integration.test.ts`

**Interfaces:**
- `runEvaluation(request, dependencies?) -> Promise<EvaluationReceipt>`
- `runOfflineEvaluation(request, dependencies?) -> Promise<EvaluationReceipt>`
- `runLiveEvaluation(request, dependencies?) -> Promise<EvaluationReceipt>`
- `compareEvaluationReceipts(baseline, candidate) -> EvaluationComparison`

- [ ] **Step 1: Add failing tests** proving offline mode delegates to the existing fixture/cassette evaluator, live mode is never selected implicitly, and the same request produces the same receipt shape in both modes.
- [ ] **Step 2: Run** `npm test -- --run tests/unit/evaluationRunner.test.ts tests/integration/evaluationRunner.integration.test.ts` and verify failure.
- [ ] **Step 3: Implement** the runner as an adapter over `evaluateOfflinePromotionMatrix`, the existing live evaluator, and the existing review runtime. Preserve scenario-level failures, usage, latency, and provider error classes.
- [ ] **Step 4: Implement comparison gates** for unsafe ships, accuracy/recall regressions, p95 latency, total cost, and incomplete evidence. A missing live receipt must result in `INCONCLUSIVE`, not an invented comparison.
- [ ] **Step 5: Keep existing scripts as compatibility adapters** over their established evaluator exports; the new runner calls those exports so their current command-line output and exit behavior remain unchanged.
- [ ] **Step 6: Run focused unit/integration tests and commit** with `refactor: share evaluation runners across scripts and cli`.

## Task 3: Add immutable receipt and report storage

**Files:**
- Create: `src/evaluation/evaluationArtifacts.js`
- Create: `src/evaluation/evaluationArtifacts.d.ts`
- Test: `tests/unit/evaluationArtifacts.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- `writeEvaluationReceipt(receipt, { directory }) -> { jsonPath, markdownPath }`
- `readEvaluationReceipt(filePath) -> EvaluationReceipt`
- `listEvaluationReceipts(directory) -> EvaluationReceiptSummary[]`
- `renderEvaluationReport(receipt|comparison) -> string`

- [ ] **Step 1: Write failing tests** for atomic writes, deterministic filenames, JSON round-trip, Markdown rendering, corrupt-receipt rejection, and secret redaction.
- [ ] **Step 2: Implement** default storage under `.review-yeti/evaluations/` with an explicit `--output-dir` override; write a temporary file then rename it.
- [ ] **Step 3: Include** source SHA, fixture/cassette digest, model/provider metadata, scenario matrix, token/cost/latency totals, and final status in every receipt.
- [ ] **Step 4: Add `.review-yeti/evaluations/` to `.gitignore`** and document how to copy a receipt into an artifact store when desired.
- [ ] **Step 5: Run focused tests and commit** with `feat: persist evaluation receipts and reports`.

## Task 4: Create the manual CLI surface

**Files:**
- Create: `bin/review-yeti.mjs`
- Create: `src/cli/evaluationCli.mjs`
- Create: `src/cli/evaluationCli.d.ts`
- Modify: `package.json`
- Test: `tests/unit/evaluationCli.test.ts`
- Test: `tests/integration/evaluationCli.integration.test.ts`

**Interfaces:**
- `review-yeti eval list [--directory <path>]`
- `review-yeti eval run --fixture <path> [--mode offline|live] [--baseline <receipt>] [--repetitions <n>] [--concurrency <n>] [--output-dir <path>] [--yes]`
- `review-yeti eval compare --baseline <receipt> --candidate <receipt>`
- `review-yeti eval report --receipt <path> [--format json|markdown|table]`
- `review-yeti eval tui [--directory <path>]`

- [ ] **Step 1: Write failing CLI tests** for help text, unknown commands, offline run exit codes, live-mode confirmation, `--yes`, receipt output, and compare/report formatting.
- [ ] **Step 2: Implement** a small argument parser with no runtime dependency. `eval run` defaults to offline mode; live mode exits with code `2` unless `--yes` is supplied in non-interactive shells.
- [ ] **Step 3: Register** the package `bin` entry as `review-yeti: ./bin/review-yeti.mjs` and make the bin file invoke the CLI without importing GitHub Action-only modules.
- [ ] **Step 4: Define exit codes:** `0` pass, `1` fail/block, `2` usage or explicit confirmation required, `3` inconclusive/provider unavailable.
- [ ] **Step 5: Add human-readable progress** to stderr and machine-readable JSON only with `--format json`; never mix progress lines into JSON stdout.
- [ ] **Step 6: Run focused tests plus `npm run lint` and commit** with `feat: add manual evaluation cli`.

## Task 5: Add the terminal TUI over the CLI runner

**Files:**
- Create: `src/tui/evaluationTui.mjs`
- Create: `src/tui/evaluationTui.d.ts`
- Test: `tests/unit/evaluationTui.test.ts`
- Test: `tests/integration/evaluationTui.integration.test.ts`

**Interfaces:**
- `runEvaluationTui({ input, output, runner, artifacts }) -> Promise<number>`

- [ ] **Step 1: Write failing tests** using fake input/output streams for menu navigation, offline default, explicit live confirmation, cancellation, receipt selection, and non-TTY fallback.
- [ ] **Step 2: Implement** a dependency-free screen model with these views: `Runs`, `Run configuration`, `Progress`, `Comparison`, and `Receipt details`.
- [ ] **Step 3: Add line-oriented controls** that work in ordinary terminals: `r [fixture]` reruns offline, `l [fixture] --yes` requests live confirmation, `c <baseline> <candidate>` compares, and `q` quits.
- [ ] **Step 4: Render** persona/scenario progress, pass/fail/inconclusive status, token/cost totals, p50/p95 latency, and unsafe-ship findings from the shared receipt.
- [ ] **Step 5: Ensure** the TUI calls the same CLI runner functions and supports `--no-color` and redirected-output fallback to a table report.
- [ ] **Step 6: Run focused tests and commit** with `feat: add manual evaluation terminal ui`.

## Task 6: Document the manual workflow and release-level usage

**Files:**
- Create: `docs/EVALUATION_CLI.md`
- Modify: `README.md`
- Modify: `TEST_INFRA.md`
- Test: `tests/unit/documentationExamples.test.ts`

- [ ] **Step 1: Document** the command lifecycle with concrete examples:

```bash
npx review-yeti eval run \
  --fixture tests/fixtures/review-intelligence/offline-promotion-matrix.json \
  --mode offline

npx review-yeti eval run \
  --fixture tests/fixtures/dependency-evaluation.json \
  --mode live --repetitions 3 --concurrency 4 --yes

npx review-yeti eval compare \
  --baseline .review-yeti/evaluations/<baseline>.json \
  --candidate .review-yeti/evaluations/<candidate>.json

npx review-yeti eval tui
```

- [ ] **Step 2: Explain** that offline evaluation is the normal developer check, while live evaluation is a manual release/candidate measurement and is not invoked by CI automatically.
- [ ] **Step 3: Document** provider setup, cost/latency evidence requirements, receipt handling, redaction, retry behavior, and `INCONCLUSIVE` semantics.
- [ ] **Step 4: Add README navigation** for the CLI/TUI and state that GitHub Action review behavior is unchanged.
- [ ] **Step 5: Add documentation tests** that execute the documented offline command against the checked-in fixture.
- [ ] **Step 6: Run documentation tests and commit** with `docs: document manual evaluation cli and tui`.

## Task 7: Verify the complete toolkit without adding automation

**Files:**
- Modify: `package.json` only if a dedicated `test:evaluation-toolkit` script is needed
- Test: existing focused suites plus the complete package checks

- [ ] **Step 1: Run** `npm test -- --run tests/unit/evaluationContracts.test.ts tests/unit/evaluationRunner.test.ts tests/unit/evaluationArtifacts.test.ts tests/unit/evaluationCli.test.ts tests/unit/evaluationTui.test.ts`.
- [ ] **Step 2: Run** the offline command through both CLI and TUI fallback using the checked-in fixture; confirm identical receipt schema and status.
- [ ] **Step 3: Run** `npm run lint` and `npm run build`.
- [ ] **Step 4: Run** `npm run test:all` and record the exact result in the implementation PR.
- [ ] **Step 5: Verify** `git diff -- .github/workflows` is empty for this feature; no automatic workflow was introduced.
- [ ] **Step 6: Commit** with `test: verify manual evaluation toolkit` and request a current-head Review Yeti panel.

## Deliberate non-goals for this slice

- No scheduled/nightly GitHub Actions workflow.
- No automatic live provider evaluation on pull requests.
- No automatic release promotion or deployment based solely on an evaluation receipt.
- No new hosted database, dashboard, or remote evaluation service.
- No LLM-generated TUI content outside the receipts returned by the shared evaluator.

## Self-review checklist

- The existing offline evaluator remains the default and is reused rather than duplicated.
- Live evaluation is explicit, bounded, confirmed, and receipt-backed.
- CLI and TUI share runner, comparison, and artifact code.
- Every result is reproducible from source SHA plus fixture/cassette digest.
- CI automation is intentionally unchanged.
- Provider failure cannot silently become a passing release signal.
