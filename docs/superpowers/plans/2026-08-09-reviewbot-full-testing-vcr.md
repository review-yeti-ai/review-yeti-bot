# Review Yeti Full Workflow Testing and VCR Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the complete Review Yeti pull-request workflow—from trusted configuration and GitHub state recall through reviewer fan-out, arbitration, publication, memory persistence, artifact replay, and failure handling—with deterministic cassette replay in the PR gate and isolated live canaries for provider operations.

**Architecture:** Add a deterministic workflow harness around an injectable `runReviewPipeline` boundary while preserving the existing plain-Node Action entry point. Extend the existing strict cassette harness to cover GitHub, OpenRouter, and every memory provider; every cassette is sanitized, origin-scoped, and required to be fully consumed. Use fixture-driven scenario tests for the required PR gate, and keep real Doppler/provider traffic in a separate manual or scheduled canary that never publishes a review comment by default.

## Implementation status (2026-08-09)

The deterministic foundation is implemented on `codex/full-reviewbot-testing`: all twelve sanitized
scenario fixtures, versioned cassette replay, native-provider query/write/error cassettes, GitHub and
model boundary cassettes, an injectable plain-Node pipeline boundary, workflow/outbox/security/runtime
integration suites, and a credential-gated single-provider canary. `npm run test:all` is the local gate.
Live provider evidence remains intentionally pending because no Mem0, Hindsight, Supermemory, or
RetainDB credentials are available; the canary reports `not_configured` without making a network
request. The real pipeline boundary now executes for all twelve fixture IDs; `fresh-clean` and
`provider-unavailable` additionally assert publication, memory, and outbox semantics. The remaining
work before final promotion is scenario-specific adversarial assertions for every fixture plus hosted
Node 20/24 and credentialed-provider evidence.

**Tech Stack:** Node 20 and 24, Vitest, TypeScript test support, the existing `tests/support/cassetteFetch.ts` harness, GitHub CLI command-runner seams, Node built-in `fetch`, GitHub Actions, JSON fixtures, and sanitized VCR cassettes.

## Global Constraints

- PR-required tests are network-free; CI must fail if cassette recording is attempted.
- A cassette must match canonical method, URL, headers, and body, and every recorded interaction must be consumed.
- Cassettes contain no credentials, raw maintainer comments, author names, model prompts, source secrets, or provider tokens.
- Review memory remains advisory; the authenticated GitHub decision ledger remains authoritative for arbitration and publication.
- Exactly one memory provider is selected per scenario and per production run; tests must reject fan-out.
- Every provider request and normalized event is bound to `{repository, prNumber, headSha}` and stale-head data must be rejected.
- Tests must exercise the plain Node Action runtime without requiring `ts-node`, a TypeScript build, or provider-specific packages.
- Live canaries use synthetic identities, explicit trusted credentials, bounded writes, and no GitHub publication by default.
- Existing unit, cassette replay, packaging, lint, and build checks remain green after each task.

---

## Test Pyramid and Required Evidence

The finished suite has five layers:

1. **Pure contracts:** configuration, identity, event normalization, redaction, ledger transitions, arbitration, and outbox invariants.
2. **Provider replay:** strict VCR interactions for Honcho, Mem0, Hindsight, Supermemory, and RetainDB, including health, query, append, errors, and readiness.
3. **Workflow harness:** one deterministic test runs the actual pipeline boundary with GitHub, model, and memory cassettes, then asserts reviewer context, arbitration, publication, receipt, and outbox state.
4. **Action/runtime packaging:** the same harness runs with the dependency surface available to `action.yml` on Node 20 and Node 24; a clean runtime must not load TypeScript-only modules.
5. **Live canaries:** manual or scheduled synthetic checks against Doppler and one selected provider; canary results are receipts, not PR gates.

The required scenario matrix is:

| Scenario | GitHub state | Model state | Memory state | Required result |
| --- | --- | --- | --- | --- |
| `fresh-clean` | exact open PR, no prior findings | all lanes approve | empty context | `SHIP`, one review publication, no feedback suppression |
| `open-finding-carried` | authenticated open finding | one lane repeats it | same-head open feedback recalled | finding remains actionable |
| `resolved-and-reopened` | resolved then recurrent thread | lane sees prior state | feedback transition history recalled | reopened finding is actionable |
| `ignored-authorized` | maintainer ignore command | lane repeats finding | authenticated ignored state recalled | finding is suppressed only when exact ledger state matches |
| `ignored-unauthorized` | contributor-like command | lane repeats finding | unauthorized command excluded | finding remains actionable |
| `stale-head` | prior memory/ledger has old head | current PR head differs | provider returns stale records | stale records omitted and receipt says exact-head filtered |
| `provider-unavailable` | GitHub ledger available | model lanes succeed | provider timeout/5xx | GitHub-ledger-only result with unavailable receipt |
| `provider-malformed` | exact PR state | model lane succeeds | malformed/oversized provider response | fail open, bounded empty context, no publication corruption |
| `partial-review` | exact PR state | one lane errors | provider available | `INCOMPLETE_REVIEW`/blocked gate, no false `SHIP` |
| `publication-race` | head changes before publication | lanes complete | write pending | stale publication rejected; outbox remains replayable |
| `runner-cancelled` | publication succeeds | lanes complete | append is interrupted | atomic outbox artifact exists and replay claims the lease |
| `replay-dead-letter` | stored identity is exact | no model call | provider repeatedly fails | bounded retries then dead-letter receipt |

## Task 1: Define fixture contracts and scenario corpus

**Files:**
- Create: `tests/support/reviewWorkflowFixtures.ts`
- Create: `tests/fixtures/review-workflows/*.json`
- Create: `tests/fixtures/review-workflows/README.md`
- Test: `tests/unit/reviewWorkflowFixtures.test.ts`

**Interfaces:**
- `loadReviewWorkflowFixture(filePath: string): ReviewWorkflowFixture`
- `ReviewWorkflowFixture = { id, event, config, github, model, memory, expected }`
- `expected` must include `verdict`, `coverageStatus`, `mergeEligible`, `publishedReviewCount`, `publishedThreadCount`, `memoryQueryStatus`, `memoryWriteStatus`, `outboxState`, and `forbiddenStrings`.

- [ ] **Step 1: Write the fixture schema test.** Assert required fields, exact `repository`, numeric `prNumber`, 40-character `headSha`, and that every fixture has a unique `id`.
- [ ] **Step 2: Add the twelve scenario fixtures from the matrix above.** Store GitHub responses, model responses, provider responses, and expected receipts in separate top-level keys so a test cannot silently use a live default.
- [ ] **Step 3: Reject unsafe fixture content.** `loadReviewWorkflowFixture` must fail if any JSON value contains `api_key`, `authorization`, `private_key`, raw command reasons, or a body longer than the fixture bound.
- [ ] **Step 4: Run the focused fixture test.**

```bash
npx vitest run tests/unit/reviewWorkflowFixtures.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add tests/support/reviewWorkflowFixtures.ts tests/fixtures/review-workflows tests/unit/reviewWorkflowFixtures.test.ts
git commit -m "test: define review workflow fixture contracts"
```

## Task 2: Harden the VCR harness for provider and workflow replay

**Files:**
- Modify: `tests/support/cassetteFetch.ts`
- Modify: `tests/unit/cassetteReplay.test.ts`
- Create: `tests/support/cassetteManifest.ts`
- Create: `tests/unit/cassetteManifest.test.ts`

**Interfaces:**
- `createCassetteFetch({ cassettePath, mode, allowedRecordOrigins, fixtureId }): CassetteFetch`
- `CassetteManifest = { version: 2, fixtureId, provider, allowedOrigins, interactions }`
- `assertCassetteSafe(manifest): void`

- [ ] **Step 1: Add a versioned manifest wrapper.** Version 2 must record fixture id, provider id, allowed origins, and interactions; reject version 1 in new provider cassettes with a migration error that names the file.
- [ ] **Step 2: Canonicalize volatile fields.** Freeze time in workflow tests; canonicalize query ordering, JSON object key order, and header case. Do not wildcard head SHA, event IDs, claim IDs, or provider scopes.
- [ ] **Step 3: Strengthen redaction.** Redact authorization, API-key, token, secret, password, private-key, workspace JWT, and Doppler values in headers and nested JSON. Assert redaction is applied before cassette writes.
- [ ] **Step 4: Enforce origin and provider scope in replay and record modes.** Replay must reject a cassette interaction whose origin is not listed in its manifest. Record mode must require `REVIEW_YETI_VCR=record`, `REVIEW_YETI_RECORD_APPROVED=true`, `CI` unset/false, and an explicit origin allowlist.
- [ ] **Step 5: Add cassette safety tests.** Cover unmatched requests, duplicate matching interactions, unconsumed interactions, forbidden origins, secret leakage, malformed manifests, and record refusal in CI.
- [ ] **Step 6: Run replay tests.**

```bash
npx vitest run tests/unit/cassetteReplay.test.ts tests/unit/cassetteManifest.test.ts
```

- [ ] **Step 7: Commit.**

```bash
git add tests/support/cassetteFetch.ts tests/support/cassetteManifest.ts tests/unit/cassetteReplay.test.ts tests/unit/cassetteManifest.test.ts
git commit -m "test: harden deterministic cassette replay"
```

## Task 3: Add provider-specific VCR cassettes and contract tests

**Files:**
- Create: `tests/fixtures/cassettes/memory/honcho.json`
- Create: `tests/fixtures/cassettes/memory/mem0.json`
- Create: `tests/fixtures/cassettes/memory/hindsight.json`
- Create: `tests/fixtures/cassettes/memory/supermemory.json`
- Create: `tests/fixtures/cassettes/memory/retaindb.json`
- Create: `tests/fixtures/cassettes/memory/provider-errors.json`
- Modify: `tests/unit/memoryProviderAdapters.test.ts`
- Modify: `tests/unit/memoryProviderRegistry.test.ts`
- Create: `tests/unit/memoryProviderCassette.test.ts`

**Interfaces:**
- `providerCassetteCase(providerId, operation, cassettePath): Promise<MemoryProviderResult>`
- Every provider must expose `queryContext`, `appendEvents`, `healthCheck`, `readiness`, `contractVersion`, `adapterVersion`, `capabilities`, `deliverySemantics`, and `supportsIdempotency`.

- [ ] **Step 1: Capture sanitized provider interactions outside CI.** Record one exact-head query, one append, health, readiness, an empty result, a 429/5xx response, and a malformed response for every provider. Use synthetic `acme/app#42` identity and non-secret fixture credentials.
- [ ] **Step 2: Replace inline provider response stubs with cassette fetches.** Each test must call `assertComplete()` and must assert the canonical URL, HTTP method, auth scheme, namespace/workspace scope, exact-head filter, bounded result count, and normalized event body.
- [ ] **Step 3: Add cross-provider contract tests.** Iterate the allowlisted registry and assert no adapter can send raw `body`, title, comment text, author, reason, transcript, or arbitrary model prose.
- [ ] **Step 4: Add failure/consistency tests.** Verify provider timeout, 429, 500, malformed JSON, stale-head results, >100 normalized events, and unsupported domain omission produce explicit receipts rather than silent acceptance.
- [ ] **Step 5: Mark unproven providers experimental.** Supermemory and RetainDB remain `experimental: true` until their live canary evidence is recorded; the replay tests must not promote them implicitly.
- [ ] **Step 6: Run provider replay tests.**

```bash
npx vitest run tests/unit/memoryProviderCassette.test.ts tests/unit/memoryProviderAdapters.test.ts tests/unit/memoryProviderRegistry.test.ts
```

- [ ] **Step 7: Commit.**

```bash
git add tests/fixtures/cassettes/memory tests/unit/memoryProviderCassette.test.ts tests/unit/memoryProviderAdapters.test.ts tests/unit/memoryProviderRegistry.test.ts
git commit -m "test: add cassette contracts for memory providers"
```

## Task 4: Build GitHub API and model cassettes for PR state

**Files:**
- Create: `tests/fixtures/cassettes/github/fresh-pr.json`
- Create: `tests/fixtures/cassettes/github/feedback-transitions.json`
- Create: `tests/fixtures/cassettes/github/stale-head.json`
- Create: `tests/fixtures/cassettes/github/publication-race.json`
- Create: `tests/fixtures/cassettes/github/publication-failure.json`
- Create: `tests/fixtures/cassettes/openrouter/reviewer-panel.json`
- Create: `tests/fixtures/cassettes/openrouter/provider-timeout.json`
- Create: `tests/fixtures/cassettes/openrouter/malformed-response.json`
- Modify: `tests/fixtures/cassettes/decision-ledger.json`
- Modify: `tests/support/cassetteFetch.ts`
- Create: `tests/unit/githubWorkflowCassettes.test.ts`

**Interfaces:**
- `createCommandRunner({ githubCassette, expectedCalls }): CommandRunner`
- `createModelClient({ openRouterCassette, clock }): ModelClient`
- Command runner results must match `spawnSync` shape: `{ status: number, stdout: string, stderr: string }`.

- [ ] **Step 1: Record GitHub command interactions used by the pipeline.** Cover `gh api` REST reviews, GraphQL review threads/comments pagination, PR head verification, changed-file comparison, review publication, thread publication, and comment/review verification.
- [ ] **Step 2: Record model panel interactions.** Include one response per persona lane, one retryable timeout, one malformed JSON response, and one partial-lane response. Freeze timestamps and usage values.
- [ ] **Step 3: Redact and assert GitHub data boundaries.** Keep marker metadata, states, IDs, paths, lines, and commit SHAs; remove human comment prose, usernames, command reasons, and auth headers from fixtures.
- [ ] **Step 4: Test pagination and exact-head behavior.** Ensure the command runner consumes all pages, detects malformed pagination, rejects stale publication, and never treats an empty API response as proof that no findings exist.
- [ ] **Step 5: Run the focused cassette tests.**

```bash
npx vitest run tests/unit/githubWorkflowCassettes.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add tests/fixtures/cassettes/github tests/fixtures/cassettes/openrouter tests/fixtures/cassettes/decision-ledger.json tests/unit/githubWorkflowCassettes.test.ts
git commit -m "test: add replay fixtures for GitHub and model workflow state"
```

## Task 5: Extract an injectable pipeline boundary

**Files:**
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Modify: `action.yml`
- Create: `src/runtime/reviewPipelineRuntime.js`
- Modify: `tests/unit/reviewPipelineDispatch.test.ts`
- Create: `tests/unit/reviewPipelineRuntime.test.ts`

**Interfaces:**
- `runReviewPipeline({ env, cwd, commandRunner, fetchImplementation, modelClient, clock, logger }): Promise<ReviewRunReceipt>`
- `ReviewRunReceipt` must include `verdict`, `coverage`, `publication`, `memory`, `outbox`, `provider`, `headSha`, `startedAt`, and `finishedAt`.
- The CLI entry point remains `main()` and calls `runReviewPipeline` with real `spawnSync`, global `fetch`, model client, process environment, and current working directory.

- [ ] **Step 1: Write the failing runtime test.** Run the pipeline boundary with fake command runner, cassette fetch, fixture model client, frozen clock, and temporary `sessions/`; assert the receipt has no network calls outside the three supplied cassette scopes.
- [ ] **Step 2: Move dependency creation to the boundary.** Replace direct `spawnSync`, global `fetch`, `Date.now`, and implicit process environment reads in the orchestration path with injected dependencies; preserve the existing CLI behavior.
- [ ] **Step 3: Keep publication and memory provider seams explicit.** The runner must call exactly one provider query before reviewer fan-out and one normalized append after successful publication; provider failure must not become a model or GitHub fallback branch.
- [ ] **Step 4: Return a structured receipt.** Write the same sanitized receipt to `GITHUB_OUTPUT` in the Action entry point and return it to tests; never include API keys, raw prompts, comments, or source bodies.
- [ ] **Step 5: Run runtime tests under both Node floors.**

```bash
npx vitest run tests/unit/reviewPipelineRuntime.test.ts tests/unit/reviewPipelineDispatch.test.ts
npx tsc --noEmit -p tsconfig.server.json
```

- [ ] **Step 6: Commit.**

```bash
git add .github/workflows/pipelines/review-pipeline.js action.yml src/runtime/reviewPipelineRuntime.js tests/unit/reviewPipelineRuntime.test.ts tests/unit/reviewPipelineDispatch.test.ts
git commit -m "test: expose an injectable review pipeline runtime"
```

## Task 6: Implement the full cassette-backed PR workflow harness

**Files:**
- Create: `tests/support/reviewWorkflowHarness.ts`
- Create: `tests/integration/reviewWorkflow.integration.test.ts`
- Modify: `tests/fixtures/review-workflows/*.json`
- Modify: `package.json`

**Interfaces:**
- `runReviewWorkflowFixture(fixtureId: string): Promise<ReviewRunReceipt>`
- `runReviewWorkflowFixture` must install the fixture’s GitHub command runner, OpenRouter cassette, selected memory provider cassette, frozen clock, trusted config directory, and temporary outbox directory before calling `runReviewPipeline`.

- [ ] **Step 1: Add one green `fresh-clean` test.** Assert exact reviewer count, one bounded memory query before fan-out, identical context across lanes, arbitration `SHIP`, one compact review publication, zero line findings, and one post-publication outbox append.
- [ ] **Step 2: Add feedback/correction tests.** Run `resolved-and-reopened`, `ignored-authorized`, and `ignored-unauthorized`; assert the ledger—not provider prose—controls suppression and all correction transitions are represented in normalized events.
- [ ] **Step 3: Add reliability tests.** Run `provider-unavailable`, `provider-malformed`, `partial-review`, `publication-race`, and `runner-cancelled`; assert blocked/partial verdicts, exact-head rejection, retries, atomic outbox state, and no false `SHIP`.
- [ ] **Step 4: Add provider matrix execution.** Run the same scenario corpus once for each selected provider profile; do not fan out within a scenario. Record `provider`, `protocol`, `adapterVersion`, omitted domains, latency, and delivery semantics in the receipt.
- [ ] **Step 5: Add deterministic repeatability.** Execute every fixture twice and compare canonical receipts, published Markdown, event IDs, and outbox payloads byte-for-byte.
- [ ] **Step 6: Add a test script.**

```json
"test:workflow": "vitest run tests/integration/reviewWorkflow.integration.test.ts"
```

- [ ] **Step 7: Run the full harness.**

```bash
npm run test:workflow
```

- [ ] **Step 8: Commit.**

```bash
git add tests/support/reviewWorkflowHarness.ts tests/integration/reviewWorkflow.integration.test.ts tests/fixtures/review-workflows package.json
git commit -m "test: exercise complete review workflow with cassettes"
```

## Task 7: Verify Action packaging and plain-runtime compatibility

**Files:**
- Modify: `tests/unit/reviewActionPackaging.test.ts`
- Create: `tests/integration/actionRuntime.integration.test.ts`
- Create: `scripts/check-action-runtime.mjs`
- Modify: `.github/workflows/ci-cd.yaml`
- Modify: `action.yml`

**Interfaces:**
- `checkActionRuntime({ nodeVersion, actionPath, fixtureId }): Promise<RuntimeCheckReceipt>`
- `RuntimeCheckReceipt` must report Node version, installed dependency names, loaded pipeline modules, provider registry IDs, and whether TypeScript runtime loading was attempted.

- [ ] **Step 1: Add a clean-install packaging test.** Copy only the Action package into a temporary directory, install the declared `js-yaml` dependency exactly as `action.yml` does, and execute `node scripts/check-action-runtime.mjs` with `NODE_PATH` set to the action dependency directory.
- [ ] **Step 2: Assert the provider registry loads in plain Node.** The check must load Honcho plus all four native adapters and fail if a `.ts` module, `ts-node`, or undeclared package is required.
- [ ] **Step 3: Run the workflow harness on Node 20 and Node 24.** The PR gate must use a matrix so the Action’s documented floor and the repository workflow version are both proven.
- [ ] **Step 4: Verify `action.yml` outputs.** Assert `verdict`, counts, provider receipt, memory source/status, and `memory-outbox-path` are populated from the structured runtime receipt.
- [ ] **Step 5: Add a CI job named `action-runtime`.** It runs the clean-install check and `npm run test:workflow` on both Node versions.
- [ ] **Step 6: Commit.**

```bash
git add tests/unit/reviewActionPackaging.test.ts tests/integration/actionRuntime.integration.test.ts scripts/check-action-runtime.mjs .github/workflows/ci-cd.yaml action.yml
git commit -m "test: verify Action packaging on supported Node runtimes"
```

## Task 8: Integrate outbox replay, cancellation, and artifact behavior

**Files:**
- Modify: `src/memory/memoryOutbox.js`
- Modify: `scripts/replay-memory-outbox.mjs`
- Create: `tests/integration/memoryOutboxReplay.integration.test.ts`
- Modify: `tests/unit/memoryOutbox.test.ts`
- Modify: `.github/workflows/review-bot.yaml`

**Interfaces:**
- `replayMemoryOutbox({ filePath, providerId, leaseOwner, authorize, commandRunner, fetchImplementation, clock }): Promise<ReplayReceipt>`
- `ReplayReceipt` must distinguish `accepted`, `pending`, `representation_ready`, `unavailable`, and `dead_letter`.

- [ ] **Step 1: Export replay logic from the CLI.** Keep the CLI argument parser thin; tests call the replay function with cassette dependencies and temporary directories.
- [ ] **Step 2: Test atomic intent and ready records.** Simulate cancellation between publication and provider delivery; assert the hashed file is present, contains original exact identity/policy/provider, and never uses repository text as a path.
- [ ] **Step 3: Test lease/retry/dead-letter behavior.** Replay a pending outbox three times with provider 503 responses; assert backoff, lease ownership, attempt count, and dead-letter reason.
- [ ] **Step 4: Test authorization and retarget rejection.** Reject missing `--authorize yes`, provider mismatch, repository mismatch, PR mismatch, head mismatch, policy digest mismatch, and dead-letter replay.
- [ ] **Step 5: Test artifact wiring.** Parse `.github/workflows/review-bot.yaml` and assert the `sessions/` directory and `memory-outbox-path` are uploaded with bounded retention.
- [ ] **Step 6: Run integration tests.**

```bash
npx vitest run tests/integration/memoryOutboxReplay.integration.test.ts tests/unit/memoryOutbox.test.ts
```

- [ ] **Step 7: Commit.**

```bash
git add src/memory/memoryOutbox.js scripts/replay-memory-outbox.mjs tests/integration/memoryOutboxReplay.integration.test.ts tests/unit/memoryOutbox.test.ts .github/workflows/review-bot.yaml
git commit -m "test: verify durable memory outbox replay"
```

## Task 9: Add security, chaos, and performance coverage

**Files:**
- Create: `tests/security/memoryBoundary.security.test.ts`
- Create: `tests/integration/reviewWorkflowChaos.integration.test.ts`
- Create: `tests/fixtures/review-workflows/large-batch.json`
- Create: `tests/fixtures/review-workflows/prompt-injection.json`
- Modify: `package.json`

- [ ] **Step 1: Test prompt and data boundaries.** Attempt to inject instructions through provider context, comments, titles, reason fields, model output, YAML, and provider metadata; assert reviewer prompts label memory untrusted and no raw prose reaches provider writes.
- [ ] **Step 2: Test SSRF and retargeting defenses.** Reject arbitrary endpoint/profile IDs, PR-head provider changes, invalid env references, path traversal, cross-repository identities, and untrusted `MCP_CONFIG_JSON` write tools.
- [ ] **Step 3: Test bounded payloads.** Use a 101-event batch, oversized context, malformed JSON, deep nesting, long paths, and duplicate event IDs; assert truncation/chunking/rejection is explicit and no events silently disappear.
- [ ] **Step 4: Test concurrency and cancellation.** Run two same-head pipeline attempts and two replay workers; assert lock/lease behavior, no outbox corruption, deterministic event IDs, and one provider selection.
- [ ] **Step 5: Test timeout/retry budgets.** Simulate slow GitHub, model, and memory responses; assert deadlines are respected and the runner exits with a bounded receipt.
- [ ] **Step 6: Add scripts.**

```json
"test:security": "vitest run tests/security/memoryBoundary.security.test.ts",
"test:chaos": "vitest run tests/integration/reviewWorkflowChaos.integration.test.ts"
```

- [ ] **Step 7: Commit.**

```bash
git add tests/security tests/integration/reviewWorkflowChaos.integration.test.ts tests/fixtures/review-workflows/large-batch.json tests/fixtures/review-workflows/prompt-injection.json package.json
git commit -m "test: cover review memory security and failure modes"
```

## Task 10: Add live provider canaries and readiness evidence

**Files:**
- Create: `scripts/memory-canary.mjs`
- Create: `.github/workflows/memory-canary.yaml`
- Create: `tests/unit/memoryCanary.test.ts`
- Create: `docs/MEMORY_PROVIDER_OPERATIONS.md`

**Interfaces:**
- `runMemoryCanary({ providerId, transport, env, secretManager, fetchImplementation, clock }): Promise<CanaryReceipt>`
- `CanaryReceipt` must include provider, adapter/contract versions, protocol, synthetic identity digest, health status, query status, append status, readiness status, eventual-consistency result, latency, and redacted failure reason.

- [ ] **Step 1: Write the canary contract test with a fixture fetch.** It must perform health, exact-head query, one normalized event append, exact-head reread, and readiness polling without requiring real credentials.
- [ ] **Step 2: Add workflow dispatch inputs.** Require `provider` from the allowlist, use the provider-specific Doppler secret references from trusted workflow configuration, cap the run at 10 minutes, and default to no GitHub publication.
- [ ] **Step 3: Use synthetic identities.** Generate a random `headSha` and PR number in the canary; never write to a real PR session or reuse `review-yeti-smoke` identity.
- [ ] **Step 4: Separate process health from representation readiness.** `/health` success alone is insufficient; the receipt must distinguish accepted write, derived/representation-ready, empty-first-run, and unavailable.
- [ ] **Step 5: Upload only sanitized receipts.** Retain receipts for 14 days; never upload environment dumps, raw provider responses, comments, or source.
- [ ] **Step 6: Document promotion gates.** Honcho is production default; Mem0, Hindsight, Supermemory, and RetainDB require green contract replay, live canary evidence, exact-head isolation, deletion/retention evidence, and an explicit capability matrix entry.
- [ ] **Step 7: Commit.**

```bash
git add scripts/memory-canary.mjs .github/workflows/memory-canary.yaml tests/unit/memoryCanary.test.ts docs/MEMORY_PROVIDER_OPERATIONS.md
git commit -m "test: add isolated live memory provider canaries"
```

## Task 11: Wire CI gates, reports, and coverage thresholds

**Files:**
- Modify: `.github/workflows/ci-cd.yaml`
- Modify: `package.json`
- Create: `scripts/assert-test-receipts.mjs`
- Modify: `README.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`

- [ ] **Step 1: Split the PR gate into explicit jobs.** Add `unit-contract`, `cassette-replay`, `workflow-harness`, `action-runtime`, `security-chaos`, and `build` jobs; all required jobs must run network-free.
- [ ] **Step 2: Add scripts.**

```json
"test:contracts": "vitest run tests/unit",
"test:cassettes": "vitest run tests/unit/cassetteReplay.test.ts tests/unit/memoryProviderCassette.test.ts tests/unit/githubWorkflowCassettes.test.ts",
"test:workflow": "vitest run tests/integration/reviewWorkflow.integration.test.ts",
"test:outbox": "vitest run tests/integration/memoryOutboxReplay.integration.test.ts",
"test:all": "npm run test:contracts && npm run test:cassettes && npm run test:workflow && npm run test:outbox && npm run test:security && npm run lint && npm run build"
```

- [ ] **Step 3: Upload sanitized artifacts.** Publish Vitest JUnit/coverage, workflow receipts, cassette manifest validation, and failed scenario IDs. Do not upload full prompts or provider payloads.
- [ ] **Step 4: Add receipt assertions.** `assert-test-receipts.mjs` must require every scenario id, provider capability result, exact-head status, publication status, and outbox state; missing receipts fail CI.
- [ ] **Step 5: Add coverage thresholds.** Require 100% branch coverage for policy validation, identity validation, redaction, outbox authorization, and provider selection; keep broader pipeline coverage visible without weakening existing gates.
- [ ] **Step 6: Document the testing contract.** State that cassette replay is PR-required, recording is an operator-only action, canaries are separate, and live provider readiness is not implied by unit tests.
- [ ] **Step 7: Commit.**

```bash
git add .github/workflows/ci-cd.yaml package.json scripts/assert-test-receipts.mjs README.md docs/CONFIGURATION_REFERENCE.md
git commit -m "ci: gate Review Yeti on full replayable workflow tests"
```

## Task 12: Final acceptance and provider promotion audit

**Files:**
- Modify: `docs/MEMORY_PROVIDER_OPERATIONS.md`
- Modify: `docs/superpowers/plans/2026-08-09-reviewbot-full-testing-vcr.md`

- [ ] **Step 1: Run the complete local gate.**

```bash
npm ci --prefer-offline --no-audit --no-fund
npm run test:all
npm run test:workflow
npm run test:outbox
git diff --check
```

- [ ] **Step 2: Run the Node compatibility gate.** Execute `action-runtime` on Node 20 and Node 24 and confirm the provider registry loads without TypeScript runtime dependencies.
- [ ] **Step 3: Run the PR workflow fixture gate.** Confirm all twelve scenario fixtures pass twice with byte-identical receipts and all cassette interactions consumed.
- [ ] **Step 4: Verify the merged Action workflow.** Run the central `Review Yeti` workflow on a dedicated test PR or repository dispatch using a test token and memory provider fixture/canary configuration; capture the workflow URL, exact head, publication result, memory receipt, and uploaded outbox artifact.
- [ ] **Step 5: Run live canaries one provider at a time.** Record health, write acceptance, eventual representation readiness, exact-head reread, latency, and deletion/retention outcome. Do not promote a provider from benchmark ranking alone.
- [ ] **Step 6: Mark provider status explicitly.** Keep providers `experimental` or `production-default` in the capability matrix; omitted domains and unavailable readiness must be visible in receipts.
- [ ] **Step 7: Require final evidence before claiming full workflow coverage.** The evidence bundle must contain local test output, CI run URLs, cassette manifest validation, workflow fixture receipts, Node 20/24 runtime receipts, outbox replay receipts, and live-canary receipts where applicable.

## Definition of Done

- Every scenario in the required matrix has a deterministic fixture and a passing workflow-harness test.
- Every provider has sanitized query/write/health/error cassettes and contract assertions.
- GitHub, OpenRouter, and memory interactions are replayed without network access in the PR gate.
- The real pipeline boundary is exercised once per fixture; source-string assertions alone are not accepted as workflow proof.
- The Action loads and runs under Node 20 and Node 24 with only its declared runtime dependencies.
- Cancellation, stale-head, unauthorized feedback, provider outage, malformed response, retry, dead-letter, and artifact replay paths are verified.
- Live canary traffic is isolated from PR gates and never publishes a review comment by default.
- CI publishes sanitized receipts and fails on missing, unconsumed, stale, or unsafe evidence.
