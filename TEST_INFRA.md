# E2E Test Infrastructure Architecture & Methodology

## 1. Executive Summary & Test Philosophy

The `ct-review-bot` End-to-End (E2E) Test Suite provides requirement-driven, opaque-box validation of the automated AI code review service. The core testing philosophy mandates that tests evaluate system behavior as an external user or integration client would experience it—without reaching into internal module state or relying on unit mocks.

### Principles of the E2E Test Infrastructure:
1. **Opaque-Box Verification**: Tests interact strictly via public interfaces—HTTP webhook endpoints (`/api/webhook/github`), mock external APIs (GitHub REST API, OmniRoute LLM gateway, Linear/Jira ticket trackers), and physical filesystem state (`.ct-review.yaml`, `constitution.md`, SQLite persistence store).
2. **Hermetic & Isolated Execution**: Every test suite execution manages its own ephemeral HTTP servers, temporary state databases, and mock upstream APIs. Tests run without external network dependencies and clean up all resources upon completion.
3. **Multi-Tiered Coverage Strategy**: Testing is structured into progressive tiers:
   - **Harness & Smoke**: Core mock server and lifecycle bootstrapping verification.
   - **Tier 1 (Feature Coverage)**: Happy-path requirements verification across all core features (F1–F7).
   - **Tier 2 (Boundary & Corner Cases)**: Malformed inputs, missing fields, schema violations, LLM rate limits/outages, and state race conditions.
   - **Tier 3 (Cross-Feature & Stress)**: Integrated multi-component flows, high-frequency webhook bursts, diff state resets, and LLM failover load.
   - **Tier 4 (Real-World Scenarios)**: Full PR lifecycle end-to-end simulations (initial PR creation, inline review posting, fix commit updates, nit suppression, approval posting).

---

## 2. Feature Inventory (F1 – F7)

The system functionality under test is mapped to seven key feature domains:

| Feature ID | Feature Name | Description | Source Component | E2E Test Files |
|------------|--------------|-------------|------------------|----------------|
| **F1** | Quorum Review Engine | Multi-persona fan-out/fan-in review panel, persona prompt building, consensus aggregation, and agreement thresholding. | `src/quorum/` | `tier1/quorum.test.ts`, `tier2/quorumBoundaries.test.ts` |
| **F2** | YAML Config Parser | Parsing `.ct-review.yaml` & `.coderabbit.yaml`, merging organizational defaults, fallback configs, and strict schema validation. | `src/config/` | `tier1/config.test.ts`, `tier2/configBoundaries.test.ts` |
| **F3** | Ticket Validator | PR title and description issue key extraction, format enforcement, and integration check against Linear, Jira, and GitHub Issues. | `src/ticket/` | `tier1/ticket.test.ts`, `tier2/ticketBoundaries.test.ts` |
| **F4** | Constitution Engine | Operational guideline enforcement (`constitution.md`), rule extraction, policy compliance checking, and violation tagging. | `src/constitution/` | `tier1/constitution.test.ts`, `tier2/constitutionBoundaries.test.ts` |
| **F5** | Incremental Diff State Manager | SHA-256 hunk hashing, persistent state across commits, nit/PX finding tracking, and duplicate finding suppression on re-runs. | `src/persistence/` | `tier1/diffState.test.ts`, `tier2/diffStateBoundaries.test.ts` |
| **F6** | OmniRoute Router | Multi-LLM provider routing (Anthropic, OpenAI, DeepSeek), token refresh, effort level scaling, rate-limit (429)/error (503) failover pool. | `src/router/` | `tier1/omniRoute.test.ts`, `tier2/omniRouteBoundaries.test.ts` |
| **F7** | GitHub Webhook Listener & Publisher | Express receiver, HMAC signature authentication, event loop processing, inline diff commenting, and summary review publishing. | `src/github/` | `tier1/webhook.test.ts`, `tier2/webhookBoundaries.test.ts` |

---

## 3. Test Design & Generation Methodology

The E2E test suite applies four formal software testing methodologies to achieve complete coverage and stress resilience:

### A. Category Partitioning Methodology
Input domains are divided into distinct equivalence partitions and boundary conditions to ensure all system branches are systematically exercised:
- **Webhook Authenticity**: Valid HMAC signature, invalid HMAC signature, missing `x-hub-signature-256` header.
- **Configuration Parsing**: Complete valid `.ct-review.yaml`, missing optional keys, invalid YAML syntax, root fallback configuration.
- **Ticket Parsing**: Valid ticket prefix (`PROJECT-123`, `ENG-456`), unrecognized prefix, missing ticket ID in title & body, bypass flags.
- **LLM Gateway Status**: HTTP 200 (Success), HTTP 429 (Rate Limit Exceeded), HTTP 503 (Service Unavailable), HTTP 500 (Internal Server Error).

### B. Boundary Value Analysis (BVA)
Tests explicitly target boundary conditions where systems frequently fail:
- **Diff Sizes**: 0-line empty diffs, single line additions, multi-file diffs exceeding token boundaries, diffs with long binary/hunk headers.
- **Threshold Boundaries**: Quorum agreement thresholds set to 0.0, 0.5, 0.99, and 1.0; consensus voting ties.
- **Token Limits**: Prompt inputs exactly matching, slightly below, and exceeding token limits triggering tier degradation.
- **Rate Limits**: Requests at `N-1`, `N`, and `N+1` capacity of OmniRoute rate-limit windows.

### C. Pairwise / Combinatorial Testing
To prevent combinatorial explosion while retaining high fault-detection coverage, key parameters are combined pairwise across integration tests:
- **Configuration Profile × Persona Preset**: Default config vs Custom YAML config paired with Security-only, Performance-only, or Full Quorum panel.
- **Provider Health × PR Event Type**: Primary provider active vs Primary provider in failover paired with `pull_request.opened` vs `pull_request.synchronize`.

### D. Workload & Stress Simulation Methodology
Empirical stress tests in Tier 3 validate system stability under heavy operational load:
- **Concurrent Payload Ingestion**: Bursting 10+ concurrent webhook POST requests to test Express queue handling and DB lock contention.
- **Provider Outage & Recovery**: Injecting simulated 503/429 errors from primary LLM endpoints under load to verify instant, transparent failover to secondary providers without dropping review jobs.
- **High-Frequency Commit Updates**: Sequential commit pushes (`sha-v1` → `sha-v2` → `sha-v3`) verifying incremental diff hashing, stale finding resolution, and nit suppression integrity.

---

## 4. Directory Layout & Test Suite Structure

The E2E test codebase is organized under `tests/e2e/` (plus harness smoke tests in `tests/unit/`):

```
ct-review-bot/
├── vitest.config.e2e.ts                  # Dedicated Vitest runner configuration
├── TEST_INFRA.md                         # E2E Infrastructure Architecture & Methodology (this file)
├── TEST_READY.md                         # E2E Test Suite Status & Readiness Report
└── tests/
    ├── unit/
    │   └── harnessSmoke.test.ts          # E2E Harness & Mock Infrastructure Smoke Verification (16 tests)
    └── e2e/
        ├── harness/                      # Opaque-box Test Harness & Mock Server Infrastructure
        │   ├── appProcessLauncher.ts     # Express server process launcher & dynamic port binding
        │   ├── assertions.ts             # Custom domain assertions for PR reviews, findings, tickets & LLM routes
        │   ├── e2eTestRunner.ts          # Suite lifecycle coordinator (bootstrapping, setup, teardown)
        │   ├── fixtureGenerator.ts       # Dynamic diff, YAML, constitution, and GitHub event payload builder
        │   ├── globalSetup.ts            # Global setup/teardown hooks for Vitest runner
        │   ├── mockGithubServer.ts       # Mock GitHub REST API & HMAC webhook signer
        │   ├── mockOmniRouteServer.ts    # Mock OmniRoute gateway (failover pool, 429/503 simulation, token endpoints)
        │   ├── mockTicketServer.ts       # Mock issue tracker API (Linear, Jira, GitHub Issues validation)
        │   └── stateManager.ts           # Disk-backed persistence manager for SQLite/JSON test isolation
        ├── tier1/                        # Tier 1 Feature Coverage Tests (44 tests)
        │   ├── config.test.ts            # F2 Happy-path config parsing & schema defaults
        │   ├── constitution.test.ts      # F4 Constitution compliance & guideline verification
        │   ├── diffState.test.ts         # F5 SHA-256 hunk hashing & persistent state
        │   ├── omniRoute.test.ts         # F6 Multi-LLM provider gateway routing
        │   ├── quorum.test.ts            # F1 Multi-persona review fan-out & quorum consensus
        │   ├── ticket.test.ts            # F3 Ticket key extraction & validation
        │   └── webhook.test.ts           # F7 Webhook ingestion, HMAC & PR review posting
        ├── tier2/                        # Tier 2 Boundary & Corner Case Tests (37 tests)
        │   ├── configBoundaries.test.ts  # F2 Invalid YAML, schema violations, malformed config
        │   ├── constitutionBoundaries.test.ts # F4 Empty guidelines, huge constitution, non-markdown
        │   ├── diffStateBoundaries.test.ts    # F5 Diff collisions, re-naming files, state resets
        │   ├── omniRouteBoundaries.test.ts   # F6 Rate limits (429), server errors (503), outage failover
        │   ├── quorumBoundaries.test.ts       # F7 Consensus ties, zero active personas, threshold edge cases
        │   ├── ticketBoundaries.test.ts       # F3 Missing tickets, invalid prefixes, ticket bypass flags
        │   └── webhookBoundaries.test.ts      # F7 Signature mismatches, empty payloads, malformed headers
        ├── tier3/                        # Tier 3 Cross-Feature Interactions & Stress Tests (11 tests)
        │   ├── crossFeatureInteractions.test.ts # Multi-component pipeline integration scenarios
        │   └── stressNativeWebhook.test.ts      # High-concurrency bursts, load failover, rapid sync updates
        └── tier4/                        # Tier 4 Real-World Application PR Workflow Scenarios (5 tests)
            └── realWorldScenarios.test.ts       # Complete lifecycle PR workflows from creation to merged review
```

---

## 5. Test Runner Invocation Instructions

### Environment Prerequisites
- **Node.js**: v18.0.0 or higher (v26+ recommended).
- **Environment PATH**: Ensure Node.js binaries are accessible on system `PATH` (`/opt/homebrew/bin` or standard PATH).
- **Network Permissions**: Standard local loopback binding (`127.0.0.1`). If running within a restricted sandbox, enable sandbox bypass / port binding permissions (`BypassSandbox: true`).

### Execution Commands

1. **Run the Complete E2E Test Suite (All 113 Tests across Tiers 1–4 + Harness)**:
   ```bash
   ./node_modules/.bin/vitest run --config vitest.config.e2e.ts
   ```

2. **Run with Verbose Output**:
   ```bash
   ./node_modules/.bin/vitest run --config vitest.config.e2e.ts --reporter=verbose
   ```

3. **Run a Specific Tier (e.g., Tier 1 Feature Coverage)**:
   ```bash
   ./node_modules/.bin/vitest run tests/e2e/tier1 --config vitest.config.e2e.ts
   ```

4. **Run a Specific Test File (e.g., Real-World Scenarios)**:
   ```bash
   ./node_modules/.bin/vitest run tests/e2e/tier4/realWorldScenarios.test.ts --config vitest.config.e2e.ts
   ```

5. **Run Harness Smoke Verification**:
   ```bash
   ./node_modules/.bin/vitest run tests/unit/harnessSmoke.test.ts --config vitest.config.e2e.ts
   ```
