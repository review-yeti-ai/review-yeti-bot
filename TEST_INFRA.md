# E2E Test Infra: Review Yeti — Miller Retirement & Pre-Check System

## Test Philosophy
- Opaque-box, requirement-driven. Derived from `ORIGINAL_REQUEST.md`.
- No reliance on internal implementation details or private AST functions.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinatorial Testing + Real-World Workload Testing.

## Feature Inventory
| # | Feature | Source (Requirement) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|---------------------|:------:|:------:|:------:|:------:|
| 1 | Miller Absence | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 2 | Zoekt Symbol Pre-Check | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 3 | Sandbox Analyzers | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |
| 4 | Config Schema & Defaults | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test Runner: Vitest (`npx vitest run tests/e2e/preChecksE2E.test.ts`)
- Test Location: `tests/e2e/preChecksE2E.test.ts`
- Pass/Fail Semantics: Clean exit code 0, all assertions pass.

## Coverage Goals by Tier
- **Tier 1: Feature Coverage (>=5 per feature = 20 tests)**:
  - F1 (Miller Absence): Tool rejection in panel, absence of `miller` in tool list, prompt omission, absence from allowed list, rejection message.
  - F2 (Zoekt Pre-Check): Symbol discovery on changed lines, external caller resolution, definition lookup, prompt injection, budget capping.
  - F3 (Sandbox Analyzers): Linter invocation, hypothesis structure, severity mapping, persona prompt injection, multi-ecosystem support.
  - F4 (Config Schema): Default-on resolution, yaml loading, explicit bypass (`enabled: false`), individual toggle overrides, invalid config rejection.
- **Tier 2: Boundary & Corner Cases (>=5 per feature = 20 tests)**:
  - F1: Empty tool arguments, case sensitivity, injection attempts.
  - F2: Empty patch/no diff, unindexed repo fail-soft, missing zoekt binary fail-soft, timeout fail-soft, symbol limit overflow.
  - F3: Missing analyzer binary fail-soft, exit code 1 (clean lint output) vs fatal crash, buffer limit overflow, malformed JSON stdout, non-matching file extensions.
  - F4: Empty `pre_checks: {}`, null values, negative `max_symbols`, partial analyzer overrides, conflicting flags.
- **Tier 3: Cross-Feature Combinations (>=4 tests)**:
  - Zoekt pre-check + Sandbox analyzers together in persona context.
  - Zoekt enabled + Analyzers disabled.
  - Zoekt disabled + Analyzers enabled.
  - All pre-checks disabled (`pre_checks.enabled: false`).
- **Tier 4: Real-World Application Scenarios (>=5 tests)**:
  - Scenario 1: Full PR diff with TypeScript changes (Zoekt caller discovery + ESLint hypothesis generation).
  - Scenario 2: Polyglot PR (TypeScript + Go + Elixir) triggering multi-ecosystem analyzers.
  - Scenario 3: Secret detection PR (Gitleaks flags dummy credential as candidate hypothesis for persona review).
  - Scenario 4: Degraded runner environment (Zoekt and Linters missing binaries, verifying review completes cleanly).
  - Scenario 5: Full Review Pipeline E2E with custom `.ct-review.yaml` overrides.

## Total Minimum Tests Target: ~49 tests
