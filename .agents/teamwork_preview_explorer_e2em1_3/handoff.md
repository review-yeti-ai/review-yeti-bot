# Handoff Report: E2E Test Runner & Harness Design (Milestone E2E-M1)

**Agent**: `teamwork_preview_explorer_e2em1_3`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_3`  
**Target Architecture Specification**: `analysis_runner_harness.md`  
**Date**: 2026-07-24  

---

## 1. Observation

- **Architecture Contracts**:
  - Examined `PROJECT.md` at `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/orchestrator/PROJECT.md` specifying Node.js v20+ / TypeScript, Express, Vitest, `@octokit/*`, `js-yaml`, `zod`, and `better-sqlite3` / JSON persistence.
  - Examined `SCOPE.md` at `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/sub_orch_e2e/SCOPE.md` defining requirement-driven opaque-box E2E test runner design, fixture generator requirements, state isolation, and harness layout under `tests/e2e/`.
- **Target Component Contracts**:
  - Config module (`src/config/`): handles `.ct-review.yaml` & `.coderabbit.yaml` parsing, Zod validation (`CtReviewConfig`), deep merging with `defaultOrgConfig.ts`.
  - Constitution module (`src/constitution/`): parses `constitution.md` operational guidelines and checks diffs for rule compliance returning `{ compliant: boolean; violations: string[] }`.
  - Persistence module (`src/persistence/`, `src/utils/diffHash.ts`): tracks diff delta fingerprints via SHA-256, stores findings status (`identified` vs `resolved`) across PR commits in SQLite (`better-sqlite3`) or atomic JSON storage.
- **Peer Agent Specs**:
  - Explorer 1 (`teamwork_preview_explorer_e2em1_1`): `mockGithubServer.ts` (HMAC signatures, webhook event generator, REST comment recorder).
  - Explorer 2 (`teamwork_preview_explorer_e2em1_2`): `mockOmniRouteServer.ts` (LLM multi-provider routing, token refresh, failover) & `mockTicketServer.ts` (Linear/Jira/GitHub ticket mocks).

---

## 2. Logic Chain

1. **Test Suite Requirements**: The E2E test suite must validate `ct-review-bot` end-to-end as an opaque-box system, processing GitHub webhooks, generating multi-persona LLM reviews, enforcing ticket linkages and constitution rules, and tracking incremental diff states across commits.
2. **Fixture Generation Necessity**: E2E test cases across Tiers 1-4 require deterministic, programmatic generation of PR diffs (single-file, multi-file, security vulnerabilities, incremental commit deltas), configuration YAML files (`.ct-review.yaml`, `.coderabbit.yaml`, invalid schemas, syntax errors), and constitution documents (`constitution.md`).
3. **State Isolation Requirement**: To prevent cross-test state leakage during parallel or sequential test runs, SQLite database instances (`better-sqlite3`) and state storage directories must be sandboxed per test run inside temporary directories (`/tmp/ct-e2e-<test_id>/`) with dynamic environment variable bindings (`CT_REVIEW_DB_PATH`, `CT_REVIEW_CONFIG_PATH`).
4. **Runner Framework Choice**: Vitest is recommended due to native TypeScript support, rapid parallel thread execution, built-in assertion matchers, and seamless integration with Express app processes (Supertest or dynamic PORT HTTP launching).
5. **Harness Architecture & Layout**: Organizing `tests/e2e/` into `harness/` (containing `fixtureGenerator.ts`, `stateManager.ts`, `e2eTestRunner.ts`, `assertions.ts`, and peer mocks) and `tier1/` through `tier4/` directories ensures clean separation of infrastructure from test cases.

---

## 3. Caveats

- **Child Process vs In-Process Express App**: The harness supports both in-process Express app wrapping (via Supertest) and child-process spawning (`child_process.fork`/`spawn`). In-process wrapping is faster for unit/integration execution, but child-process spawning offers complete process isolation.
- **SQLite Native Binding in Containers/CI**: `better-sqlite3` requires native C++ compilation. In environments where native compilation is restricted, the JSON atomic storage fallback path must be utilized.
- **Dynamic Port Allocation**: Mock servers (`MockGithubServer`, `MockOmniRouteServer`, `MockTicketServer`) and the Express app must use dynamic free port binding (`port: 0` or port pool) to avoid collisions during parallel worker thread execution.

---

## 4. Conclusion

1. **Completed Specification**: Complete design and implementation specification produced in `analysis_runner_harness.md`.
2. **Fixture Generators (`fixtureGenerator.ts`)**: Fluent builder classes specified for Git unified diffs (including incremental commit deltas for finding resolution tracking), YAML configurations, and constitution Markdown documents.
3. **Isolated State Harness (`stateManager.ts`)**: Sandbox context builder designed with temporary directory creation, DDL schema initialization, state inspection methods, and cleanup hooks.
4. **E2E Runner & Layout (`tests/e2e/`)**: Vitest configuration (`vitest.config.e2e.ts`), npm scripts, custom assertions (`assertions.ts`), and modular harness layout fully defined for E2E milestone execution.

---

## 5. Verification Method

To verify the harness design and specifications:
1. Inspect the generated analysis report at `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_3/analysis_runner_harness.md`.
2. Verify that all TypeScript interfaces (`DiffHunk`, `FileDiff`, `CtReviewConfigFixtureOptions`, `ConstitutionRule`, `TestEnvironmentContext`) match `PROJECT.md` and `SCOPE.md` contracts.
3. Run `vitest run --config vitest.config.e2e.ts` once implementation is complete to verify end-to-end execution of Tier 1 tests.
