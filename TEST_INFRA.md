# E2E Test Infra: CodeRabbit-Style GitHub Organization Registration & AI Model Onboarding Wizard

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA + Pairwise + Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|---------------------|:------:|:------:|:------:|:------:|
| 1 | GitHub Organization Connection & App Registration | R1 Step 1, R2 | 5 | 5 | ✓ | ✓ |
| 2 | Monitored Repositories Picker & Strictness Profiles | R1 Step 2 | 5 | 5 | ✓ | ✓ |
| 3 | AI Providers, Keys & Subscription Tiers | R1 Step 3, R2 | 5 | 5 | ✓ | ✓ |
| 4 | Reviewer Persona Model Ensemble Assignment | R1 Step 4 | 5 | 5 | ✓ | ✓ |
| 5 | Verification & Diagnostic Test Scan | R1 Step 5 | 5 | 5 | ✓ | ✓ |
| 6 | How-To Guides, Tooltips & Manifest JSON Drawers | R2 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test runner: `npm test` (Vitest)
- Test environment: JSDOM for UI components, Node for API endpoints
- Dynamic test runner script: `npm test`

## Boundary Replay and Cassette Rules

Review-bot external boundaries follow the deterministic operator patterns used by `ct-pr-operator`:

- HTTP clients and model calls accept injectable fetch implementations. Retry clocks, sleeps, and jitter are injectable as well.
- The live review engine uses OpenRouter as its sole model transport. Legacy OmniRoute variables are not a provider fallback.
- Application AI defaults, the local CLI/provider roster in `.ct-review.yaml`, and the GitHub Action fleet policy are separate contracts.
- `reviewers.providers` in repository config describes the local CLI/app fleet. The GitHub Action does not derive its reviewer roster from those provider ids.
- The GitHub Action keeps its explicit persona roster and OpenRouter request policy even when a repository carries local CLI provider names with no `personas` block.
- Fixtures are synthetic, deterministic, credential-free, and bind review assertions to the exact PR head and base references.
- Every action/app run re-checks the authoritative PR head before model execution and before each publication side effect.
- Replay is the default and is fail-closed: an unmatched request throws immediately and `assertComplete()` rejects unconsumed interactions.
- Replay tests do not permit real GitHub, model-provider, or other network traffic. The cassettes under `tests/fixtures/cassettes/` are the complete boundary.
- Provider failures, malformed provider JSON, and incomplete persona quorum must never become a successful `SHIP` verdict.
- Optional persona/provider failures are treated as infrastructure failure by the production webhook path; they cannot be recorded as a green lane.
- Reviewer tool execution is read-only and limited to changed-file context plus approved documentation search. Arbitrary local paths, shell, Linear, Productlane, GitHub, and custom MCP writes are rejected.
- GitHub publication bodies carry a stable exact-head idempotency marker so reruns do not duplicate inline findings or fallback comments.
- GitHub publication and shell side effects require explicit command-boundary tests. The `gh pr comment` invocation is tested with an injected command runner and filesystem adapter.
- A failed `gh api` marker lookup or `gh pr comment` publication is a failed review, never a successful local-file fallback.
- `/ready` returns HTTP 503 until GitHub App, webhook, and OpenRouter configuration is present.
- `KUBERNETES_WORKER_DISPATCH=true` fails closed until the worker has a durable, exact-head result handoff; the service never runs a worker review and then repeats it locally.

The generational engine adds one review contract for both execution surfaces:

Governance and operational tests also assert that effective policy carries source provenance and a digest, platform caps cannot be widened by repository/workflow overrides, tenant boundaries cover runs/indexes/artifacts/logs, and SLO receipts expose queue latency, first-comment latency, completion latency, provider availability, index freshness, cost, and false-positive feedback.

- `src/review/reviewCore.js` is the canonical verdict, finding, coverage, and digest boundary; the
  plain Node Action and typed App adapters must produce the same result for the same snapshot.
- `PRSnapshot` binds owner, repository, PR number, exact head SHA, exact base SHA, changed-file
  metadata, base-policy reference/digest, and engine version. A changed head or base fails closed.
- V4 execution policy is additive to V3 and carries bounded budgets plus explicit submodule policy.
  Gitlink metadata is preserved; recursive inspection is `INCOMPLETE_REVIEW` until nested content
  is actually resolved.
- Pi-style runs use the durable `review_runs` identity, lease, heartbeat, stage, result digest, and
  failure fields. The PostgreSQL repository is used when configured; the in-memory repository is
  test-only and never evidence of multi-pod durability.
- A provider or publication failure is persisted as failure, never as a successful verdict. No
  `SHIP` is valid with missing lanes, incomplete coverage, an unbound snapshot, or missing evidence.

Run the replay suite without credentials or network access:

```bash
env -u OPENROUTER_API_KEY -u GITHUB_TOKEN -u GH_TOKEN -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_ID npm run test:replay
```

OpenRouter policy fixtures live under `tests/fixtures/cassettes/openrouter/` and are synthetic only: no customer diffs, no real provider output, no GitHub tokens, and no copied live response payloads. The checked-in OpenRouter replay cassettes assert the exact `openrouter/auto` request body, five-model auto-router fleet, `cost_quality_tradeoff: 7`, `provider.data_collection: "deny"`, response headers, response body, fingerprint matching, and complete cassette consumption.

Recording is an explicit maintenance operation. It requires both `CT_REVIEW_VCR=record` and an endpoint origin in the harness allowlist; it is never enabled implicitly by a missing cassette or an environment credential. A recording command must name the allowlisted origin in the test harness, for example:

```bash
CT_REVIEW_VCR=record npm run test:replay
```

Do not run recording in CI, and review generated cassettes for secrets, authorization headers, API keys, customer data, and non-synthetic provider content before committing them.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Complete Onboarding Workflow from Step 1 to Step 5 | F1, F2, F3, F4, F5 | High |
| 2 | Add Custom OpenAI-compatible Provider with Enterprise Subscription Tier | F3, F4, F5 | Medium |
| 3 | Monitored Repo Strictness Profile Change (Chill -> Assertive) & Automation Toggle | F2, F5 | Medium |
| 4 | GitHub App Manifest JSON Copy and Webhook Secret Re-verification | F1, F6 | Medium |
| 5 | Diagnostic Scan Execution with Provider Latency Ping & 11-Persona Arbitration | F4, F5 | High |

## Coverage Thresholds
- Tier 1: ≥5 per feature (Total 30)
- Tier 2: ≥5 per feature boundary (Total 30)
- Tier 3: Pairwise combinations (Total 10)
- Tier 4: Real-world application scenarios (Total 5)
- Total minimum test cases: 75
