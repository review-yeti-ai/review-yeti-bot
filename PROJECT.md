# Project: Review Yeti Evaluation Benchmark Suite Expansion & Release Automation

## Architecture
Review Yeti (`ct-review-bot`) utilizes an evaluation engine and automated regression quality gates:
1. **Scenario Registry & Fixture System (`src/evaluation/scenarios.ts`, `tests/fixtures/scenarios/`)**:
   - Strongly-typed scenario definitions with PR context, diff files, expected findings (with diff hunk line mapping invariants), expected arbitration verdicts (`BLOCK`, `FIX_FIRST`, `SHIP`), session context, evidence requirements, and category tags.
   - Unified diff fixtures in `tests/fixtures/scenarios/${scenarioId}.diff` synchronized with scenario definitions.
2. **Benchmark Evaluation Engine (`src/evaluation/evaluationRunner.ts`, `scripts/evaluate-release-benchmark.mjs`)**:
   - Executes scenarios across the approved 4-model roster (`deepseek/deepseek-v4-flash-0731:high`, `openrouter/5.6-luna-high`, `qwen/qwen-3.8-27b:high`, `google/gemini-3.7-flash:high`).
   - Supports deterministic offline simulation (FNV-1a hashed pseudo-random profiles) and strict cassette replay.
   - Evaluates 6 core dimensions: SNR (linear & dB), TTFT (ms), Tokens (prompt/completion), Precision/Recall/F1/Accuracy, Turn Depth, and Cost Efficiency ($TP/USD).
3. **Regression Quality Gate Engine (`scripts/compare-release-baselines.mjs`)**:
   - Enforces 8 mathematical quality gates (Zero-tolerance Recall/Accuracy drop, SNR degradation <= 1.50 dB, F1 drop <= 0.02, TTFT surge <= 50ms & 25%, Cost surge <= 20%, 0 new FN, 0 new FP) comparing candidate matrix against baseline in `eval-baselines/`.
4. **Automated Release Publishing Workflow (`.github/workflows/release-semver.yaml` / `release.yml`)**:
   - Triggers on release tags (`v*`) and `workflow_dispatch`.
   - Executes evaluation benchmark runner to generate versioned baseline artifacts (`eval-baselines/model-benchmark-matrix-${VERSION}.json` and `.md`).
   - Validates regression quality gates before deployment.
   - Attaches `.json` and `.md` benchmark reports as downloadable assets using `gh release upload`.
   - Extracts executive summary table and embeds it directly into GitHub release notes using `gh release edit --notes` with direct download links.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| 1 | Distributed Concurrency Scenarios | 8 new scenarios: Lock TTL race, Go ticker leak, ETS table race, slice aliasing corruption, EventEmitter leak, Redis fencing token, Task.async_stream surge, clean lease ship | M1 | Survey |
| 2 | Subtle Security & Logic Bypasses | 8 new scenarios: Second-order JSONB SQLi, Unicode tenant bypass, TOCTOU permission race, ReDoS route filter, JWT alg confusion, SSRF DNS rebinding, prototype pollution, clean tenant guard ship | M1 | Survey |
| 3 | Multi-Turn Evidence Chaining Scenarios | 8 new scenarios: Gateway contract break, circular event loop, DB pool starvation, OpenTelemetry trace leak, mutable context bleed, cache invalidation desync, multi-turn arbitration, clean hexagonal pipeline ship | M1 | Survey |
| 4 | Adversarial Injections & Stealth Cloaking | 8 new scenarios: Zero-width prompt hijack, Cyrillic homoglyph spoofing, markdown table padding cloak, roleplay jailbreak, forged audit signature, AST evasion dynamic eval, XML entity bomb, clean defense pipeline ship | M1 | Survey |
| 5 | Diff Fixtures Generation | 32 matching `.diff` fixture files in `tests/fixtures/scenarios/` with strict added-line line-number anchoring | M1 | Survey |
| 6 | Scenario Count & Metadata Tests | Update `tests/unit/evaluationScenarios.test.ts` to assert 94 total scenarios (>= 93) and category distributions | M1 | Survey |
| 7 | Automated Release Benchmark Execution | Update `.github/workflows/release-semver.yaml` (and `release.yml`) to run `evaluate-release-benchmark.mjs` during release pipeline | M2 | Survey |
| 8 | Versioned Baseline Artifact Generation | Script and workflow generation of `eval-baselines/model-benchmark-matrix-${VERSION}.json` and `.md` | M2 | Survey |
| 9 | GitHub Release Asset Upload | Automatic attachment of `.json` and `.md` reports via `gh release upload` | M2 | Survey |
| 10 | Release Notes Embedded Table | Extraction and injection of executive summary markdown table into release notes via `gh release edit --notes` with asset download links | M2 | Survey |
| 11 | Package Scripts Enhancement | Add `benchmark:release` and `benchmark:compare` scripts to `package.json` | M2 | Survey |
| 12 | Canonical Baseline v3 Generation | Generate and commit `eval-baselines/model-benchmark-matrix-v3.json` and `.md` for the complete 94-scenario suite | M3 | Survey |
| 13 | Regression Comparator Calibration | Verify `scripts/compare-release-baselines.mjs` evaluates 94-scenario candidate against v2 with zero regressions | M3 | Survey |
| 14 | Harness & Gate Unit/E2E Test Updates | Update `tests/unit/releaseBenchmarkHarness.test.ts`, `tests/unit/releaseBenchmarkGate.test.ts`, `tests/e2e/releaseBenchmark.test.ts` | M3 | Survey |
| 15 | 100% Test Suite Verification | Full verification across unit, integration, e2e, replay, and lint suites | M4 | Survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| M1 | Scenario Suite Expansion (62 → 94) | Author 32 new scenarios in `src/evaluation/scenarios.ts`, generate 32 `.diff` fixtures in `tests/fixtures/scenarios/`, and update scenario unit tests | none | DONE |
| M2 | Release Automation & Digest Publishing | Update `.github/workflows/release-semver.yaml`, `.github/workflows/release.yml`, package scripts, and release digest injection logic | M1 | DONE |
| M3 | Baseline Generation & Quality Gate Validation | Generate `eval-baselines/model-benchmark-matrix-v3.*`, validate regression gates across 4 models, and update harness/gate test suites | M1, M2 | DONE |
| M4 | Full Quality Gate, Challenger Verification & Audit | 100% passing test suites, multi-agent review, challenger validation, forensic integrity audit | M1, M2, M3 | DONE |

## Interface Contracts
### `src/evaluation/scenarios.ts` ↔ `src/evaluation/evaluationRunner.ts`
- `EVALUATION_SCENARIOS: EvaluationScenario[]` contains 94 scenario records.
- Every `scenario.id` has a matching fixture `tests/fixtures/scenarios/${scenario.id}.diff`.
- `ExpectedFinding.line` maps directly to added line numbers in the diff hunks, satisfying `changedLineNumbers`.
- `expectedVerdict` strictly matches arbitration quorum rules (`computeArbitration`).

### `scripts/evaluate-release-benchmark.mjs` ↔ GitHub Release Actions
- Invocation: `node scripts/evaluate-release-benchmark.mjs --offline --save-baseline=${VERSION} --compare-baseline=eval-baselines/model-benchmark-matrix-v2.json --fail-on-regression`
- Produces: `eval-baselines/model-benchmark-matrix-${VERSION}.json` and `eval-baselines/model-benchmark-matrix-${VERSION}.md`.
- Exit code: `0` on gate pass, `1` on regression.

## Code Layout
- `src/evaluation/scenarios.ts`: Scenario definitions and registry.
- `tests/fixtures/scenarios/*.diff`: Scenario unified diff fixtures.
- `tests/unit/evaluationScenarios.test.ts`: Scenario unit tests.
- `scripts/evaluate-release-benchmark.mjs`: Release benchmark evaluation runner.
- `scripts/compare-release-baselines.mjs`: Baseline regression comparator.
- `.github/workflows/release-semver.yaml`: Automated release and deployment workflow.
- `.github/workflows/release.yml`: Release workflow definition.
- `eval-baselines/`: Versioned baseline matrix records (`v1`, `v2`, `v3`).
- `tests/unit/releaseBenchmarkHarness.test.ts`: Benchmark harness unit tests.
- `tests/unit/releaseBenchmarkGate.test.ts`: Baseline gate unit tests.
- `tests/e2e/releaseBenchmark.test.ts`: Release benchmark E2E tests.
