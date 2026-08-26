# E2E Test Infra: Dynamic Context Management & Compaction

> [!WARNING]
> **Historical test-plan record; non-authoritative.** Counts and coverage claims apply to the named
> change set and require fresh execution before reuse as current evidence. See
> [Documentation authority](docs/DOCUMENTATION_AUTHORITY.md).

## Test Philosophy
- Opaque-box, requirement-driven verification of context window discovery, diff compaction, multi-turn sliding history, and zero-loss commit SHA partitioning.
- Methodology: Category-Partition + BVA + Pairwise Combinatorial + Workload Testing.

## Feature Inventory & Coverage Mapping
| # | Feature | Source (Requirement) | Tier 1 (Coverage) | Tier 2 (Boundary/Edge) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|----------------------|:-----------------:|:----------------------:|:----------------------:|:-------------------:|
| 1 | Dynamic Model Context Window Discovery | ORIGINAL_REQUEST §R1 | 5 cases | 5 cases | ✓ | ✓ |
| 2 | Safe Diff Capacity Calculator ($C_{safe}$) | ORIGINAL_REQUEST §R1 | 5 cases | 5 cases | ✓ | ✓ |
| 3 | Config Schema Boundary Expansion | ORIGINAL_REQUEST §R1 | 5 cases | 5 cases | ✓ | ✓ |
| 4 | Removal of Static Truncation Caps | ORIGINAL_REQUEST §R1 | 5 cases | 5 cases | ✓ | ✓ |
| 5 | Unified Diff Context Compactor ($\pm 3$) | ORIGINAL_REQUEST §R2 | 5 cases | 5 cases | ✓ | ✓ |
| 6 | Line Number Invariance (`changedLineNumbers`) | ORIGINAL_REQUEST §R2 | 5 cases | 5 cases | ✓ | ✓ |
| 7 | Minified / Bloat & Whitespace Compactor | ORIGINAL_REQUEST §R2 | 5 cases | 5 cases | ✓ | ✓ |
| 8 | Sliding Multi-Turn History Compactor | ORIGINAL_REQUEST §R2 | 5 cases | 5 cases | ✓ | ✓ |
| 9 | Commit SHA Range Header Injection | ORIGINAL_REQUEST §R3 | 5 cases | 5 cases | ✓ | ✓ |
| 10 | Zero-Loss File Partitioning Engine | ORIGINAL_REQUEST §R3 | 5 cases | 5 cases | ✓ | ✓ |
| 11 | Parallel Partition Execution & Aggregation | ORIGINAL_REQUEST §R3 | 5 cases | 5 cases | ✓ | ✓ |
| 12 | PR Comment Coverage Telemetry Badge | ORIGINAL_REQUEST §R3 | 5 cases | 5 cases | ✓ | ✓ |
| 13 | Evaluation Harness Augmentation | ORIGINAL_REQUEST §R4 | 5 cases | 5 cases | ✓ | ✓ |
| 14 | Baseline Quality Gate Coverage Enforcement | ORIGINAL_REQUEST §R4 | 5 cases | 5 cases | ✓ | ✓ |
| 15 | Context Management Feature Docs | ORIGINAL_REQUEST §R4 | 5 cases | 5 cases | ✓ | ✓ |
| 16 | E2E Dual-Track Verification & Audit | Acceptance Criteria | 5 cases | 5 cases | ✓ | ✓ |

## Test Architecture
- Unit Tests: `tests/unit/openRouterClient.test.ts`, `tests/unit/config.test.ts`, `tests/unit/diffCompactor.test.ts`, `tests/unit/turnHistoryManager.test.ts`, `tests/unit/shaPartitionManager.test.ts`, `tests/unit/contextManagementDocs.test.ts`.
- Integration & E2E Tests: `tests/e2e/contextManagementE2E.test.ts`, `tests/e2e/sandboxedPipelineHarness.test.ts`.
- Quality Gate Verification: `scripts/compare-release-baselines.mjs`, `scripts/evaluate-release-benchmark.mjs`.

## Coverage Thresholds
- Tier 1: ≥5 per feature (80+ test cases)
- Tier 2: ≥5 per feature across boundaries (80+ test cases)
- Tier 3: Pairwise combinations of compaction + partitioning + multi-turn + large repos
- Tier 4: Realistic monolithic repo workloads (50+ files, 1500+ lines, 5 persona multi-turn turns)
