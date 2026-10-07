# E2E Test Infra: Review Yeti Swarm Context Isolation & Compaction

## Test Philosophy
- Opaque-box, requirement-driven testing derived from `ORIGINAL_REQUEST.md` (R1–R4).
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Acceptance thresholds:
  - Subagents receive only path-relevant AST outlines and diff hunks rather than full repo unified diffs.
  - Measurable token reduction (>50%) compared to monolithic prefill.
  - Legacy `staticPrefixText` completely replaced.
  - On-demand `get_hunk` retrieval and raw hunk eviction into synopses.
  - `ReviewTaskContract` v2 lean 5-tuple digest emitted and properly hydrated for Check Runs without losing line anchoring.
  - Quorum satisfied by 100% file coverage by applicable domains even if non-critical tasks time out or are pruned.
  - Immediate early-exit on verified P0/Blocker findings.
  - Zero mock facades, zero disabled tests, zero regressions across `npm test`.

## Feature Inventory & Test Coverage Goals

| # | Feature | Source | Tier 1 (Feature) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|--------|:----------------:|:-----------------:|:----------------------:|:-------------------:|
| F1 | AST Diff Parser & Outline Generator | R1 | 5 | 5 | ✓ | ✓ |
| F2 | Domain Path Boundary Partitioning | R1 | 5 | 5 | ✓ | ✓ |
| F3 | Elimination of Monolithic `staticPrefixText` Prefill | R1 | 5 | 5 | ✓ | ✓ |
| F4 | On-Demand `get_hunk` Retrieval Tool | R2 | 5 | 5 | ✓ | ✓ |
| F5 | Ephemeral Diff Lifecycle & Synopsis Compaction | R2 | 5 | 5 | ✓ | ✓ |
| F6 | `ReviewTaskContract` v2 Lean Finding Digest | R3 | 5 | 5 | ✓ | ✓ |
| F7 | Decoupled Remediation Subagent | R3 | 5 | 5 | ✓ | ✓ |
| F8 | Downstream Check-Run Line Anchoring Hydration | R3 | 5 | 5 | ✓ | ✓ |
| F9 | 100% File Coverage Quorum Validator | R4 | 5 | 5 | ✓ | ✓ |
| F10 | Blocker Fast-Path Quorum & Early-Exit | R4 | 5 | 5 | ✓ | ✓ |
| F11 | Configuration Schema Extensions | R1–R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test runner: Vitest / npm test (`npx vitest run tests/e2e/swarmArchitecture.test.ts`)
- Target location: `tests/e2e/swarmArchitecture.test.ts`
- Pass/Fail semantics: Exit code 0, 100% assertions pass, zero unhandled rejections.

## Coverage Thresholds
- Tier 1: ≥5 per feature (55 test cases minimum)
- Tier 2: ≥5 per feature (55 test cases minimum)
- Tier 3: Pairwise coverage of major feature interactions (15 test cases minimum)
- Tier 4: Realistic end-to-end pull request workloads (6 scenarios minimum)
- Total minimum: ≥131 test cases
