# E2E Test Infra: Review Yeti Benchmark Suite Expansion

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation internals.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Strict IP verification and zero proprietary leaking.

## Feature Inventory & Test Coverage
| # | Feature | Source (Requirement) | Tier 1 (Feature) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Workload) |
|---|---------|----------------------|:----------------:|:-----------------:|:---------------------:|:-----------------:|
| 1 | Telecom Workspace Architecture (SIP, RTP, CDR, PBX) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 2 | Scenario Catalog Expansion (≥188 Scenarios) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 3 | Needle-in-a-Haystack Refactor Diffs (300–1500 lines) | ORIGINAL_REQUEST §R2.1 | 5 | 5 | ✓ | ✓ |
| 4 | Cross-Module Architectural Breakages | ORIGINAL_REQUEST §R2.2 | 5 | 5 | ✓ | ✓ |
| 5 | Distributed Concurrency Race Scenarios | ORIGINAL_REQUEST §R2.3 | 5 | 5 | ✓ | ✓ |
| 6 | False Positive / Hallucination Trap PRs | ORIGINAL_REQUEST §R2.4 | 5 | 5 | ✓ | ✓ |
| 7 | Workspace Tool Calling (`file_read`, `code_search`, `symbol_lookup`) | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |
| 8 | Multi-Turn Runner Modes (Live + Replay) | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |
| 9 | Release Baseline v4 Matrix Generation | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ | ✓ |
| 10 | Regression Quality Gate Verification | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test runners: `npx vitest run tests/e2e/releaseBenchmark.test.ts`, `node scripts/compare-release-baselines.mjs`, `node scripts/evaluate-release-benchmark.mjs --offline`
- Scenario fixture format: Standard unified diff `.diff` files in `tests/fixtures/scenarios/`
- Workspace root: `tests/fixtures/workspaces/telecom-call-engine/`

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full-Cycle Telecom Call Flow with Multi-Turn Review | F1, F3, F4, F7, F8 | High |
| 2 | High-Concurrency Attended Transfer under Load | F1, F5, F7, F8 | High |
| 3 | Large-Scale CDR Billing Engine Refactor Needle Hunt | F1, F3, F7, F8 | High |
| 4 | Clean Idempotent PBX Trunk Lease Rebalancing Trap | F1, F4, F6, F7, F8 | High |
| 5 | End-to-End Baseline v4 Release Lifecycle & Gate Validation | F2, F9, F10 | Extreme |

## Coverage Thresholds
- Tier 1: ≥5 test cases per feature (50 total)
- Tier 2: ≥5 boundary test cases per feature (50 total)
- Tier 3: Pairwise coverage of major feature interactions (10+ tests)
- Tier 4: ≥5 realistic end-to-end workload application scenarios
- Tier 5: Adversarial coverage hardening and gap elimination
