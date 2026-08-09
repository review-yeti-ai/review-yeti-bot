# Multi-provider review memory implementation plan

**Goal:** Add a competitive, provider-neutral memory selection layer to Review Yeti with exactly one active provider per review run. Keep Honcho as the default and make mem0, Hindsight, Supermemory, and RetainDB opt-in adapters behind the same normalized review-memory contract.

**Architecture:** Trusted-base YAML selects one provider and a recall/persist capability matrix. The Action validates effective configuration, calls one `MemoryProviderRouter.queryContext` before reviewer fan-out, and appends normalized events through one provider after publication. An unavailable provider fails open to GitHub-ledger-only behavior. Outbox replay is used for cross-provider evaluation; production never fans out writes or merges reads.

**Tech stack:** CommonJS Action runtime, Node 20 `fetch`, existing TypeScript server-side MCP code, provider adapters, YAML policy validation, Vitest, GitHub Actions artifacts, and Doppler-resolved runtime secrets.

**Global constraints:** GitHub ledger remains authoritative; no raw comments/authors/reasons/transcripts/model instructions; exact repository/PR/head identity; trusted-base endpoints and credentials only; bounded untrusted context; explicit capability omissions; at-least-once delivery unless provider idempotency is proven; no hidden provider fallback; no production fan-out.

## Task 1: Generalize trusted YAML configuration and precedence

**Files:** `.github/workflows/pipelines/review-pipeline.js` (`resolveActionReviewPolicy`, `createReviewMemoryRouter`, and identity/config resolution), `action.yml`, `tests/unit/actionPolicyContract.test.ts`, `tests/unit/reviewPipelineDispatch.test.ts`, `docs/CONFIGURATION_REFERENCE.md`, and `docs/ARCHITECTURE.md`.

- Add `memory.provider`, `mode: single`, `fallback: github_ledger_only`, generic `providers`, query bounds, and recall/persist domains.
- Validate provider/profile/transport/secret references and capability intersection.
- Preserve legacy Honcho configuration with explicit precedence and migration tests.
- Reject PR-head attempts to change provider, endpoint, namespace, credentials, or domain policy.
- Emit an effective configuration receipt without secrets.

## Task 2: Strengthen the provider contract and registry

**Files:** `src/mcp/memoryProviderRouter.js`, `src/mcp/memoryProviderRouter.d.ts`, new contract fixtures/tests.

- Add adapter and contract versions, protocol/transport, supported domains, retention/deletion, tenant scope, idempotency, and delivery semantics.
- Ensure normalization retains schema version, domain, repository, PR/head/base identity, policy digest, permission class, reason tags/hash, thread/claim/transition IDs, and delivery metadata.
- Enforce one selected provider and return structured omitted-domain reasons.
- Preserve explicit Honcho `mcp`/`rest` behavior and `MCP-compatible-local` labeling.

## Task 3: Add provider adapters

**Files:** `src/memory/providers/mem0MemoryProvider.js`, `hindsightMemoryProvider.js`, `supermemoryMemoryProvider.js`, `retaindbMemoryProvider.js`, adapter tests.

- Implement `queryContext`, `appendEvents`, health/readiness, and bounded native request translation.
- Keep provider-specific configuration in trusted profiles and Doppler environment references.
- Mark Supermemory and RetainDB experimental until live ingestion/readiness evidence passes.
- Validate current API/auth, namespace isolation, exact-head filtering, retention/deletion, rate-limit behavior, consistency, and idempotency for each provider.
- Do not claim MCP support unless a real MCP boundary exists; report REST/SDK/local protocol accurately.

## Task 4: Complete competitive feedback and recap semantics

**Files:** `.github/workflows/pipelines/review-pipeline.js` event construction and session orchestration, `src/review/decisionLedger.js`, `src/memory/sessionLedger.ts`, `src/memory/honchoMemory.js`, `tests/unit/decisionLedger.test.ts`, `tests/unit/sessionLedger.test.ts`, and `tests/unit/honchoMemory.test.ts`.

- Emit append-only transition events for resolved, ignored, unignored, reopened, obsolete, addressed-by-commit, and authenticated corrections.
- Include bounded reason taxonomy tags alongside reason hashes.
- Emit deterministic `session_recap` events with prior/current head, turn, verdict, coverage, and claim/state summary.
- Include code claim anchors (path, language, diff side/file-level location) and trusted-base rule identity/policy digest.
- Keep provider context advisory and outside arbitration, reconciliation, publication planning, and command parsing.

## Task 5: Harden durable outbox and replay for provider comparison

**Files:** `src/memory/memoryOutbox.js`, `scripts/replay-memory-outbox.mjs`, workflow artifact upload, outbox tests.

- Atomically write hashed exact-identity outboxes before network delivery.
- Track every event ID across batches; never truncate at provider batch limits.
- Add leased replay, bounded retry/backoff, dead-letter state, scope validation, and provider selection recorded in the original envelope.
- Ensure third-party Action consumers upload the outbox artifact or explicitly document best-effort persistence.
- Use replayed outboxes for isolated provider comparisons; never write to multiple providers in one production run.

## Task 6: Build the Review Yeti evaluation corpus and gates

**Files:** new fixtures under `tests/fixtures/memory/`, new `scripts/evaluate-memory-providers.mjs`, `tests/unit/memoryProviderContract.test.ts`, and a new focused GitHub Actions workflow under `.github/workflows/memory-provider-evaluation.yml`.

- Create scenarios for repeated PR comments, resolutions, ignores, unignores, reopenings, corrections, code recurrences, rule changes, session recaps, stale heads, and conflicting signals.
- Score recall precision/coverage, correction adherence, false suppression, isolation, latency/context size, cost/token workload, outage recovery, idempotency, and redaction.
- Require contract tests plus provider-specific live smoke before enabling a provider.
- Store sanitized receipts and publish unsupported-domain/readiness status.

## Task 7: Documentation and staged rollout

**Files:** `README.md`, `docs/CONFIGURATION_REFERENCE.md`, `docs/ARCHITECTURE.md`, rollout/runbook docs.

- Document the single-provider model, YAML examples, legacy precedence, capability matrix, security boundary, receipts, rollback, and GitHub-only degradation.
- Describe the benchmark as directional evidence, not certification; record its known Supermemory/RetainDB/Hindsight risks.
- Roll out Honcho default, then opt-in mem0, Hindsight, Supermemory, and RetainDB experimental canaries.
- Promote only after green contract/live/evaluation evidence and explicit operator approval.

## Verification commands

- `npm test -- --runInBand` (or the repository's focused Vitest command) for router, policy, adapters, event normalization, and outbox tests.
- Plain Node Action-path load test proving no TypeScript runtime dependency.
- Fixture evaluator across all five provider profiles with unsupported-domain assertions.
- Provider-specific smoke scripts using Doppler-resolved secrets, sanitized receipts, and eventual-readiness polling.
- YAML precedence, exact-head, redaction, single-provider, no-fan-out, and GitHub-only degradation tests.
