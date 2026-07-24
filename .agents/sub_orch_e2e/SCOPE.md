# Scope: E2E Testing Track

## Architecture & Principles
The E2E Test Suite for `ct-review-bot` is requirement-driven and opaque-box. It exercises the product as an end user and external integrations (GitHub, OmniRoute, issue trackers) would, without relying on internal implementation details.

### Test Runner & Harness Design (`tests/e2e/`)
- Framework: Vitest / Jest compatible runner with TypeScript support (`ts-node`/`tsx` or `vitest`).
- Harness components:
  - Mock GitHub Webhook Event Generator & HMAC Signer
  - Mock OmniRoute Provider Server / Gateway Mock
  - Mock Issue Tracker API (Linear/Jira/GitHub Issues)
  - Mock Octokit / GitHub App REST API server
  - Temporary File System & DB Environment (Isolated SQLite/JSON state)
  - Test Fixture Generator (PR diffs, `.ct-review.yaml`, `constitution.md`)

## Features Inventory
| # | Feature Name | Description | Target Component |
|---|--------------|-------------|------------------|
| F1 | Quorum Review Engine | Multi-persona fan-out/fan-in review panel & consensus aggregation | `src/quorum/` |
| F2 | YAML Config Parser | `.ct-review.yaml` & `.coderabbit.yaml` parsing, org defaults merging, schema validation | `src/config/` |
| F3 | Ticket Validator | PR title/body issue key extraction & enforcement (Linear, Jira, GitHub) | `src/ticket/` |
| F4 | Constitution Engine | Operational `constitution.md` guidelines verification | `src/constitution/` |
| F5 | Incremental Diff State Manager | SHA-256 diff hashing, persistent state across commits, nit/PX suppression | `src/persistence/` |
| F6 | OmniRoute Router | Multi-LLM provider routing, token refresh, effort levels, failover pool | `src/router/` |
| F7 | GitHub Webhook Listener & Publisher | Express receiver, HMAC signature authentication, event loop, inline & summary commenting | `src/github/` |

## E2E Sub-Milestones Plan

| # | Milestone Name | Scope | Dependencies | Status |
|---|----------------|-------|--------------|--------|
| E2E-M1 | Harness & Mocks Setup | Create test runner, mock servers (GitHub, OmniRoute, Ticket), fixtures under `tests/e2e/harness/` | None | DONE |
| E2E-M2 | Tier 1 Feature Coverage Tests | Implement 44 happy-path tests (≥5 per feature across F1-F7) under `tests/e2e/tier1/` | E2E-M1 | DONE |
| E2E-M3 | Tier 2 Boundary & Corner Cases | Implement 37 edge case tests (≥5 per feature: malformed YAML, invalid HMAC, missing tickets, LLM timeout/failover, diff collisions) under `tests/e2e/tier2/` | E2E-M1 | DONE |
| E2E-M4 | Tier 3 Cross-Feature Interactions | Implement 7+ multi-component interaction tests under `tests/e2e/tier3/` | E2E-M1, M2 | DONE |
| E2E-M5 | Tier 4 Real-World Scenarios | Implement 5+ full end-to-end PR workflow simulation scenarios under `tests/e2e/tier4/` | E2E-M1-M4 | DONE |
| E2E-M6 | Infra Documentation & Verification | Generate `TEST_INFRA.md` & `TEST_READY.md`, verify 100% pass rate, issue completion handoff | E2E-M1-M5 | DONE |

## Interface Contracts & Test Layout
```
tests/e2e/
├── harness/
│   ├── mockGithubServer.ts      # Octokit & Webhook HMAC signer
│   ├── mockOmniRouteServer.ts   # OmniRoute LLM failover & token endpoint mock
│   ├── mockTicketServer.ts      # Linear / Jira API mock
│   ├── fixtureGenerator.ts      # Diffs, YAML configs, constitution.md builders
│   └── e2eTestRunner.ts         # Suite runner & reporter
├── tier1/                       # Tier 1 Feature Coverage Tests (35+ cases)
│   ├── quorum.test.ts
│   ├── config.test.ts
│   ├── ticket.test.ts
│   ├── constitution.test.ts
│   ├── diffState.test.ts
│   ├── omniRoute.test.ts
│   └── webhook.test.ts
├── tier2/                       # Tier 2 Boundary & Corner Case Tests (35+ cases)
│   ├── quorumBoundaries.test.ts
│   ├── configBoundaries.test.ts
│   ├── ticketBoundaries.test.ts
│   ├── constitutionBoundaries.test.ts
│   ├── diffStateBoundaries.test.ts
│   ├── omniRouteBoundaries.test.ts
│   └── webhookBoundaries.test.ts
├── tier3/                       # Tier 3 Cross-Feature Interaction Tests (7+ cases)
│   └── crossFeatureInteractions.test.ts
└── tier4/                       # Tier 4 Real-World PR Workflow Simulations (5+ cases)
    └── realWorldScenarios.test.ts
```
