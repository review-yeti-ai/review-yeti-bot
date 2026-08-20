# E2E Test Infrastructure: Review Yeti 3x Scenario Expansion & Release Benchmark Regression Gate

## 1. Test Philosophy

The `ct-review-bot` evaluation framework and per-release regression gate testing infrastructure adheres to three core architectural principles:

1. **Opaque-Box & Requirement-Driven Verification**:
   - All evaluation harnesses, benchmark suites, and regression gates are tested as black boxes through their public interfaces: Node.js CLI script invocations (`scripts/evaluate-release-benchmark.mjs`, `scripts/compare-release-baselines.mjs`), process command-line arguments, standard streams (stdout/stderr), process exit codes (`0` for pass, `1` for regression failure, `2` for parameter/file error), persisted JSON/Markdown artifacts, and exported TypeScript engine contracts (`EvaluationRunner`, `calculateMetrics`, `estimateCost`, `formatMarkdownReport`, `formatJSONReport`, scenario helpers).
   - Tests do not couple to internal implementation details or private variables; they assert observable outputs against ground-truth specifications from `ORIGINAL_REQUEST.md` and `PROJECT.md`.

2. **Deterministic Offline-First Architecture**:
   - Automated CI test suites execute 100% offline using unified diff fixtures (`tests/fixtures/scenarios/*.diff`), deterministic offline simulation profiles (`getSimulatedProfile`), and synthetic mock adapters.
   - External network calls to LLM endpoints (such as OpenRouter) are isolated behind optional `--live` flags and cassette replay adapters (`tests/support/cassetteFetch.ts`), eliminating flakiness, rate limits, and non-deterministic pricing shifts during test execution.

3. **Exact Mathematical & Invariant Verification**:
   - Evaluates exact bipartite matching algorithms for code findings (`calculateMetrics`), line proximity tolerance boundaries, severity matching, and logarithmic signal-to-noise calculations:
     $$\text{SNR}_{\text{dB}} = 10 \cdot \log_{10}\left(\frac{\text{TP}}{\max(\text{FP}, 0.1)}\right)$$
   - Enforces ground-truth line containment invariants where every `ExpectedFinding.line` must map to an added line (`+`) in the corresponding unified diff (`changedLineNumbers`).
   - Enforces mathematical quality gate rules with exact boundary thresholds ($\Delta \text{Recall} \ge 0$, $\Delta \text{Accuracy} \ge 0$, $\Delta \text{SNR}_{\text{dB}} \le 1.5\text{ dB}$, $\Delta \text{F1} \ge -0.02$, $\Delta \text{TTFT} \le 50\text{ms} / 25\%$, $\Delta \text{Cost} \le 20\%$, and $0$ new $FN$).

---

## 2. 4-Tier Test Case Design Methodology

```
+-------------------------------------------------------------------------------+
|                        TIER 4: REAL-WORLD WORKLOADS                           |
|  Full Release Candidate Lifecycle, Defect Gate Blocker, Audit Mode, Baseline |
+-------------------------------------------------------------------------------+
                                       ▲
+-------------------------------------------------------------------------------+
|                    TIER 3: PAIRWISE FEATURE INTERACTIONS                      |
|   Benchmark Gen -> Regression Compare, Multi-Turn x Tool Evidence x Arbitration|
+-------------------------------------------------------------------------------+
                                       ▲
+-------------------------------------------------------------------------------+
|                    TIER 2: BOUNDARY VALUE ANALYSIS & CORNER                   |
| 0 Findings, 500+ FP Floods, Exact Gate Boundary Edges (-1.50 vs -1.51 dB)     |
+-------------------------------------------------------------------------------+
                                       ▲
+-------------------------------------------------------------------------------+
|                       TIER 1: FEATURE COVERAGE (>=5/Area)                     |
| 62 Scenarios, 4-Model Roster, 6 Dimensions, CLI Flags, Dual Format Reports   |
+-------------------------------------------------------------------------------+
```

### Tier 1: Category-Partition Feature Coverage ($\ge 5$ per feature cluster)
- **Objective**: Systematic coverage of every individual feature, scenario category, model roster target, CLI argument, and metric computation across valid input partitions.
- **Coverage Areas**:
  - Catalog integrity: Unique IDs, metadata validation, multi-language coverage (Elixir, Go, TypeScript, SQL), and diff line anchoring.
  - Benchmark execution: 4-model roster (`deepseek/deepseek-v4-flash-0731:high`, `openrouter/5.6-luna-high`, `qwen/qwen-3.8-27b:high`, `google/gemini-3.7-flash:high`).
  - 6 comparative dimensions: SNR (linear & dB), TTFT (ms), Tokens In/Out, Findings Accuracy/Precision/Recall/F1, Turn Depth, and Cost Efficiency.
  - CLI flag operations: `--offline`, `--models`, `--category`, `--scenarios`, `--output`, `--save-baseline`, `--compare-baseline`.
  - Artifact formatting: Markdown comparative matrix tables and structured JSON reports.

### Tier 2: Boundary Value Analysis & Corner Cases ($\ge 5$ per feature cluster)
- **Objective**: Stress test edge conditions, zero-states, extreme inputs, corrupted files, and exact mathematical boundary thresholds.
- **Coverage Areas**:
  - Zero expected findings on clean PRs: $TP=0, FP=0, FN=0 \implies \text{Precision}=1.0, \text{Recall}=1.0, \text{F1}=1.0, \text{SNR}_{\text{dB}}=20.0\text{ dB}$.
  - Zero true positives with false positive surge ($TP=0, FP=500 \implies \text{SNR}_{\text{dB}}=-26.99\text{ dB}$).
  - Line tolerance boundary conditions: $\Delta \text{line} = 5$ (match) vs $\Delta \text{line} = 6$ (reject).
  - Strict vs loose severity matching: `P0` vs `P2` mismatches under `strictSeverity: true`.
  - Division-by-zero protection: Zero scenarios suite, zero-cost USD division guards.
  - Unknown model pricing heuristics: Graceful fallback to default rates.
  - File system error handling: Missing files and malformed JSON exiting with code `2`.
  - Exact mathematical gate thresholds:
    - $\Delta \text{Recall} = 0.000$ (Pass) vs $-0.001$ (Fail).
    - $\Delta \text{Accuracy} = 0.0\%$ (Pass) vs $-0.1\%$ (Fail).
    - $\Delta \text{SNR}_{\text{dB}} = -1.500\text{ dB}$ (Pass) vs $-1.501\text{ dB}$ (Fail).
    - $\Delta \text{F1} = -0.020$ (Pass) vs $-0.021$ (Fail).
    - $\Delta \text{Cost} = +20.0\%$ (Pass) vs $+20.1\%$ (Fail when recall neutral).

### Tier 3: Pairwise Combinatorial & Cross-Feature Interactions
- **Objective**: Verify composite workflows where multiple features interact in complex pipelines.
- **Coverage Areas**:
  - Benchmark generation $\to$ Baseline matrix export $\to$ Quality gate comparison pipeline.
  - Multi-Turn scenario context $\times$ Tool evidence requirements $\times$ Multi-persona arbitration.
  - Combined CLI filtering: `--models` $\times$ `--category` $\times$ `--save-baseline` $\times$ `--json`.
  - Offline simulation vs custom mock adapters streaming structured tokens through `EvaluationRunner`.
  - Inline regression comparison (`--compare-baseline`) composing with `--fail-on-regression`.

### Tier 4: Real-World Application Workloads & Release Lifecycles
- **Objective**: End-to-end evaluation of full production CI/CD release qualification lifecycles.
- **Coverage Areas**:
  - **Standard Release Candidate Promotion**: Full candidate baseline generation, comparison against baseline v1, validation that all 4 models pass all 7 quality gates, outputting clean Markdown diff table and returning exit code `0`.
  - **Degraded Build Regression Blocker**: Simulation of candidate build missing a critical P0 defect (e.g. `sec-multi-tenant-isolation`) or suffering SNR degradation, verifying immediate blocking with exit code `1` and detailed failure reasons.
  - **Non-Strict Telemetry / Audit Mode**: Comparison with `--no-strict` logging regression warnings for telemetry while allowing pipeline continuation with exit code `0`.
  - **Canonical Baseline Archival & Replay Idempotency**: Verification that baseline v2 JSON/Markdown artifacts are structurally valid and that repeat offline executions yield 100% identical metrics.

---

## 3. Feature Inventory & Test Tier Mapping

| # | Feature Area | Description | Primary Milestone | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|--------------|-------------|:-----------------:|:------:|:------:|:------:|:------:|
| 1 | **Scenario Catalog Registry** | 62 canonical scenarios across 9 categories and 4 languages | M1 | 5 | 5 | ✓ | ✓ |
| 2 | **Elixir/Phoenix Scenarios** | Ecto unscoped query, GenServer blocking, OTP crashes, ETS leaks, N+1 | M1 | 5 | 5 | ✓ | ✓ |
| 3 | **Go Concurrency Scenarios** | Goroutine leaks, Mutex copy by value, SQL row leaks, context cancellation | M1 | 5 | 5 | ✓ | ✓ |
| 4 | **TypeScript/Node Scenarios** | SSRF webhooks, prototype pollution, JWT none alg, async token race, ReDoS | M1 | 5 | 5 | ✓ | ✓ |
| 5 | **PostgreSQL Schema Scenarios** | NOT NULL without default, unindexed FKs, long tx locks, expand-contract | M1 | 5 | 5 | ✓ | ✓ |
| 6 | **Adversarial & Supply Chain** | Prompt injection, tool recursion traps, forged test receipts, Unicode bidi | M1 | 5 | 5 | ✓ | ✓ |
| 7 | **Diff Line Invariant Engine** | `changedLineNumbers` anchoring and `sanitizeFindings` filtering | M1 | 5 | 5 | ✓ | ✓ |
| 8 | **4-Model Benchmark Engine** | `scripts/evaluate-release-benchmark.mjs` execution harness | M2 | 5 | 5 | ✓ | ✓ |
| 9 | **6-Dimension Metrics Calculator** | SNR (dB), TTFT, Tokens, Acc/Rec/F1, Turns, Cost calculation engine | M2 | 5 | 5 | ✓ | ✓ |
| 10 | **Deterministic Offline Replay** | Simulation profiles and cassette replay adapters for CI isolation | M2 | 5 | 5 | ✓ | ✓ |
| 11 | **Release Regression Gate CLI** | `scripts/compare-release-baselines.mjs` version comparison engine | M3 | 5 | 5 | ✓ | ✓ |
| 12 | **Quality Gate Enforcement Rules** | Zero-tolerance Recall/Acc, SNR $\le 1.5$ dB, F1, TTFT, Cost, FN=0 | M3 | 5 | 5 | ✓ | ✓ |

---

## 4. Real-World Application Scenarios (Tier 4)

| # | Scenario ID | Description | Primary Features | Gating Target | Expected Exit Code |
|---|-------------|-------------|------------------|:-------------:|:------------------:|
| 1 | `WORKFLOW_4.1_CANDIDATE_PASS` | Release Candidate v2 Evaluation & Baseline Promotion | F1, F8, F9, F11, F12 | All Gates Pass | `0` |
| 2 | `WORKFLOW_4.2_RECALL_REGRESSION` | Candidate Drops Recall on Security P0 Defect | F2, F8, F11, F12 | Gate Fail (Recall Drop) | `1` |
| 3 | `WORKFLOW_4.3_SNR_DEGRADATION` | Candidate Experiences 2.5 dB SNR Noise Surge | F6, F9, F11, F12 | Gate Fail (SNR > 1.5 dB) | `1` |
| 4 | `WORKFLOW_4.4_TTFT_LATENCY_SURGE` | Candidate TTFT Latency Spikes by 80 ms (+70%) | F8, F9, F11, F12 | Gate Fail (TTFT > 50ms & >25%) | `1` |
| 5 | `WORKFLOW_4.5_UNJUSTIFIED_COST_SURGE` | Candidate Cost Spikes 40% with Neutral Recall | F8, F9, F11, F12 | Gate Fail (Cost > 20% & Recall <= 0) | `1` |
| 6 | `WORKFLOW_4.6_NON_STRICT_AUDIT` | Non-Strict Telemetry Mode with Degraded Metrics | F8, F11, F12 | Warning Logged, No Block | `0` |
| 7 | `WORKFLOW_4.7_REPLAY_IDEMPOTENCY` | Deterministic Offline Replay Exact Metric Idempotency | F1, F8, F9, F10 | Exact Metric Match | `0` |

---

## 5. Test Architecture & Execution Commands

### Test File Layout
- `tests/e2e/releaseBenchmark.test.ts`: Comprehensive 4-tier E2E test suite covering feature coverage, boundaries, pairwise combinations, and real-world release lifecycles.
- `tests/unit/evaluationRunner.test.ts`: Unit tests for metrics calculation, cost estimation, single-scenario execution, and report formatters.
- `tests/unit/evaluationScenarios.test.ts`: Unit tests for scenario catalog validation, diff line containment, and arbitration consistency.
- `eval-baselines/`: Historical and canonical benchmark baseline matrix artifacts (`.json` and `.md`).

### Test Execution Commands

```bash
# 1. Run full E2E Release Benchmark Test Suite
npx vitest run tests/e2e/releaseBenchmark.test.ts

# 2. Run all evaluation unit and integration suites
npx vitest run tests/unit/evaluationRunner.test.ts tests/unit/evaluationScenarios.test.ts

# 3. Run complete test suite across entire repository
npx vitest run

# 4. Execute release benchmark harness directly (offline mode)
node scripts/evaluate-release-benchmark.mjs --offline --json

# 5. Execute regression gate comparator CLI directly
node scripts/compare-release-baselines.mjs --baseline=eval-baselines/model-benchmark-matrix-v1.json --candidate=eval-baselines/model-benchmark-matrix-v2.json --strict
```

### Coverage Thresholds & Pass Criteria
- **Tier 1**: $\ge 5$ tests per feature cluster ($100\%$ pass).
- **Tier 2**: $\ge 5$ boundary/corner tests per feature cluster ($100\%$ pass).
- **Tier 3**: Full pairwise interaction coverage ($100\%$ pass).
- **Tier 4**: $\ge 7$ real-world release lifecycles ($100\%$ pass).
- **Zero Flakiness**: All offline suites execute deterministically without unhandled promise rejections or timeout cascades.
