# Provider-Neutral Honcho MCP Memory Implementation Plan

> **Implementation record:** Tasks are checked off as implemented and verified in the current worktree; live provider readiness is recorded separately where it remains external.

**Goal:** Make Honcho the first provider behind a provider-neutral MCP memory contract for durable review processing, code knowledge, repository rules, and maintainer feedback, then inject one bounded context result into every reviewer lane.

**Execution status (2026-08-09):** The implementation items in Tasks 1–7 are complete in this worktree and covered by the verification commands recorded below. The live DigitalOcean receipt proves authenticated health and event acceptance, but Honcho representation remains empty after bounded polling (`derived_pending`/provider readiness), so live context availability is intentionally not marked green.

**Architecture:** The Action pipeline calls exactly one `MemoryProviderRouter` interface and never contains Honcho- or REST-specific fallback logic. The first provider exposes read-only review context and write-behind event capabilities through a CommonJS MCP-compatible runtime boundary that works in the plain Node 20 Action environment. A real JSON-RPC MCP client/tool boundary is required before the implementation is labeled protocol-level MCP; until then receipts and docs must say `MCP-compatible runtime tool`. Direct REST is retained only as an explicit provider-level diagnostic/rollback mode, never as an automatic second pipeline read. Future providers register capabilities and schemas without changing reviewer orchestration.

**Tech Stack:** Node 20 built-in `fetch`, CommonJS Action runtime, TypeScript server-side adapters, provider registry, Honcho v3 API, Doppler runtime resolver, Vitest, GitHub composite Action.

## Global Constraints

- GitHub's authenticated same-PR decision ledger remains authoritative for open, resolved, ignored, obsolete, carried, and maintainer-command states.
- The pipeline makes one logical provider query before fan-out. Processing intent is recorded in a local outbox before review work begins; network delivery of normalized events occurs after successful GitHub publication. No provider-specific fallback is implemented in the pipeline.
- Honcho MCP is optional and fail-open: missing secrets, timeout, malformed tool output, non-2xx response, unavailable deriver, or unavailable provider produces GitHub-ledger-only review behavior.
- Query identity is exact `{repository, pull request, head SHA}` and output is bounded, byte-identical, explicitly untrusted context for every reviewer lane and pass.
- Never send raw comment bodies, author names, maintainer reasons, secrets, arbitrary PR prose, or model instructions to a provider; use normalized fields and deterministic hashes.
- `MCP_CONFIG_JSON` and PR-head YAML cannot enable, replace, or retarget the built-in memory provider. Endpoint and workspace scope come from trusted base configuration and Doppler-resolved secrets.
- Normalized writes are at-least-once. Event IDs are deterministic trace keys unless the provider explicitly advertises `supportsIdempotency`; receipts must expose `deliverySemantics`, accepted, pending, derived, and representation-ready status.
- Memory domains are explicit: durable processing events, code facts, repository/rule facts, and maintainer feedback facts. A provider may support a subset and must declare capabilities.
- Direct REST is an explicit `transport: rest` diagnostic/rollback option. It is never an automatic MCP fallback in the review workflow. Existing Honcho configurations without a transport setting remain on REST until `transport: mcp` is explicitly enabled.
- `/health` is process reachability only; live evidence must distinguish API health, write acceptance, representation readiness, and deriver/LLM readiness.
- Outbox filenames are SHA-256 identity digests, written atomically under a fixed `sessions/` directory; raw repository or dispatch values never become filesystem paths. Third-party Action consumers must upload the outbox artifact or accept best-effort local retention.

---

## Current-state answer (updated after implementation)

- **Honcho support:** Yes. `src/memory/honchoMemory.js` already provides optional bounded reads and normalized post-publication writes.
- **MCP memory support:** Wired through the plain-Node `MemoryProviderRouter` and fixed Honcho MCP-compatible tool registry. The Action does not depend on the TypeScript fleet manager; the review path calls one provider query before fan-out and one filtered append after publication.
- **REST decision:** Remove pipeline-level REST fallback. Keep REST only behind the provider adapter for explicit diagnostics/rollback, so MCP remains the review contract and future providers remain pluggable.
- **Live limitation:** Current DigitalOcean smoke reaches Honcho and accepts writes, but representation is empty. MCP wiring will not repair the deriver/LLM/Redis/Postgres/pgvector readiness chain.
- **Recall/save behavior now:** GitHub comments and authenticated resolutions remain authoritative through the same-PR decision ledger. The Action advances and recalls local session turns, emits a normalized `session_recap`, filters persistence by the trusted YAML matrix, writes an atomic hashed outbox before provider delivery, and supports leased replay with bounded retry/dead-letter handling. Live Honcho writes are accepted, but representation derivation is still unavailable in the current DigitalOcean instance.

## Provider contract and learning model

Create a runtime-safe, versioned contract with these operations:

```js
{
  id: 'honcho',
  contractVersion: 'memory-provider-v1',
  capabilities: {
    queryContext: true,
    appendEvents: true,
    ingestFacts: false, // v1 uses appendEvents for all normalized domains
    health: true,
    readiness: true,
    supportsIdempotency: false,
    deliverySemantics: 'at_least_once',
    scopes: ['repository', 'pull_request'],
    domains: {
      recall: ['decision_feedback', 'session_recap', 'code_signals', 'rule_signals'],
      persist: ['processing', 'decision_feedback', 'session_recap', 'code_signals', 'rule_signals']
    }
  },
  queryContext({ identity, purpose: 'review-history-v1', maxChars, deadlineMs }),
  appendEvents({ identity, events, deliveryKey }),
  healthCheck(),
  readiness()
}
```

The versioned request/result contracts are `MemoryIdentity={repository,prNumber,headSha,baseSha?,policyDigest?}`, `MemoryQueryRequest={identity,purpose:'review-history-v1',maxContextChars,deadlineMs}`, and `MemoryQueryResult={status:'available'|'empty'|'unavailable',source:'mcp'|'rest'|'github'|'none',provider,text,latencyMs,stale?,omittedDomains?,reason?}`. The normalized event envelope must include `schemaVersion`, `domain` (`processing`, `code`, `rule`, or `feedback`), `eventType`, deterministic `eventId = sha256(canonicalJson({schemaVersion,domain,eventType,repository,normalizedPrNumber,headSha,claimId,anchor,domainPolicyDigest}))`, `claimId` where applicable, exact `headSha`, repository, PR number, state, and bounded metadata. `domainPolicyDigest` is required for rule events, optional for other domains, and omitted fields are represented canonically rather than by ambiguous string concatenation. Do not store model prose as a learning fact. Processing events track run/pass/publication/delivery state; code facts require claim fingerprint, path, language, diff side/file-level anchor, and policy digest; rule facts require rule id/category/effect/scope/origin plus trusted base SHA/policy digest and are never executable from memory; feedback facts require ledger state, authenticated permission class, command kind, transition id, thread/claim id, bounded reason taxonomy tags, and reason hash.

## YAML-controlled recall and persistence

The trusted base-ref `.review-yeti.yaml` controls which memory classes are recalled and persisted. Action inputs may explicitly override the master switch, transport, timeout, and size limits, but cannot widen the recall classes or change the provider endpoint.

```yaml
memory:
  same_pr_decisions: true       # GitHub ledger remains enforced even when prompt recall is off
  session_recap: true           # prior PR turns: head, verdict, coverage, claim/state summary
  honcho:
    enabled: true
    transport: mcp               # mcp | rest; rest is explicit compatibility/rollback
    context: true
    write: true
    recall:
      decision_feedback: true    # authenticated open/resolved/ignored/obsolete/correction state
      session_recap: true        # derived recap, never a raw transcript
      code_signals: true         # claim fingerprints and locations, no source/prose
      rule_signals: true         # trusted-base policy signals, never executable instructions
      max_entries: 40
      max_context_chars: 4000
    persist:
      processing: true           # run/pass/publication/delivery lifecycle
      code_signals: true
      rule_signals: true
      decision_feedback: true
      session_recap: true
```

Effective configuration is the intersection of the top-level and provider-level switches: `memory.session_recap: false` suppresses recap everywhere; `memory.same_pr_decisions: false` suppresses prompt rendering but never GitHub enforcement; nested `honcho.recall.*` and `honcho.persist.*` can further disable a class but cannot enable one suppressed at the top level. Legacy `honcho-context: true` or `memory.honcho.context: true` without a `recall` block maps to `decision_feedback: true` and `session_recap: true` only; it does not silently enable code or rule learning. Add conflict tests for every override combination.

Recall and persistence have different authority levels:

| Memory class | Recalled before fan-out | Persisted after publication | Authority |
|---|---:|---:|---|
| GitHub decision ledger/comments | Yes, bounded | Normalized state/fingerprint only | Authoritative for finding state and commands |
| PR session recap | Yes, when enabled | Derived turn summary and exact head | Advisory; never changes arbitration |
| Code signals | Yes, bounded relevant claims | Claim fingerprint/path/language/policy digest | Advisory pattern history |
| Rule signals | Yes, bounded trusted-base policy facts | Base SHA/policy digest/rule state | Informational; memory cannot execute or alter rules |
| Feedback/corrections | Yes, authenticated state transitions | Permission class, thread/claim id, reason hash | GitHub ledger remains authoritative |
| Raw comments, bodies, authors, model transcripts | No | No | Deliberately excluded |

Corrections are append-only state transitions (`open → resolved`, `finding_ignored`, `finding_unignored`, `finding_reopened`, `obsolete`, or reopened), not overwrites. Persist the authenticated command timeline with command kind, comment/thread id, transition id, permission class, bounded reason taxonomy tags, and reason hash; a final ledger state alone is insufficient to distinguish an initial ignore from a later correction. A PR recap must be a concrete `session_recap` event containing prior/current head SHA, turn number, verdict, coverage, claim/state summary, and deterministic recap ID, rather than a raw transcript. If the runner is cancelled after publication, the versioned outbox remains the recovery record for provider ingestion.

## Files and boundaries

- Create: `src/mcp/memoryProviderRouter.js` — plain-Node runtime registry, capability dispatch, and explicit `mcp|rest|auto` provider transport selection used by the Action.
- Create: `src/mcp/memoryProviderRouter.d.ts` — shared provider/capability declarations.
- Create: `src/mcp/honchoMemoryMcpAdapter.js` — built-in Honcho provider implementing the contract and calling the existing low-level adapter only behind the MCP-compatible boundary.
- Create: `src/mcp/memoryMcpJsonRpc.js` — minimal `tools/list`/`tools/call` JSON-RPC client and local dispatcher; receipts identify whether a real JSON-RPC endpoint or local MCP-compatible adapter was used.
- Create: `src/memory/memoryOutbox.js` — versioned normalized event outbox persisted before network delivery.
- Create: `scripts/replay-memory-outbox.mjs` — explicit operator/workflow replay with trusted endpoint resolution, leases, retry/backoff, and dead-letter output.
- Modify: `src/mcp/mcpFleetManager.ts` — server-side registry compatibility and capability metadata; it must not be the only Action runtime path.
- Modify: `.github/workflows/pipelines/review-pipeline.js` — call the router once before fan-out and once after publication; remove direct Honcho calls and pipeline REST fallback.
- Modify: `src/memory/honchoMemory.js` — expose transport selection and normalized domain events without changing Honcho authentication semantics.
- Modify: `src/memory/sessionLedger.ts` — derive the next turn from metadata, persist exact-head recap data, and recall only matching repository/PR history.
- Modify: `action.yml` — add `honcho-mcp-enabled`, `honcho-mcp-transport`, and bounded timeout/context inputs while preserving legacy input precedence.
- Modify: `docs/CONFIGURATION_REFERENCE.md`, `docs/ARCHITECTURE.md`, and `README.md` — provider contract, learning domains, trust boundary, rollout, and rollback.
- Modify: `scripts/honcho-smoke.mjs` — test the MCP boundary and explicit REST diagnostic mode, including eventual representation polling.
- Modify: `tests/unit/mcpFleetManager.test.ts` — server-side capability registration.
- Create: `tests/unit/memoryProviderRouter.test.ts` — plain-Node router loading, capability dispatch, provider isolation, and transport selection.
- Create: `tests/unit/memoryOutbox.test.ts` — cancellation-safe persistence, deterministic IDs, receipts, and replay behavior.
- Create: `tests/unit/honchoMemoryMcpAdapter.test.ts` — Honcho tool contract, bounds, identity, redaction, and fail-open behavior.
- Modify: `tests/unit/honchoMemory.test.ts`, `tests/unit/actionPolicyContract.test.ts`, `tests/unit/reviewPipelineDispatch.test.ts`, and `tests/unit/reviewPipelineModel.test.ts` — transport policy and orchestration invariants.
- Modify: `tests/unit/decisionLedger.test.ts` — append-only correction/command timeline fields.

## Task 1: Define the provider-neutral runtime contract — COMPLETE

- [x] Add tests for router loading under plain Node 20, provider registration by capability, unknown-provider isolation, exact-head identity validation, bounded output, and capability-aware dispatch.
- [x] Implement `memoryProviderRouter.js` with `register(provider)`, `get(id)`, `queryContext(request)`, `appendEvents(request)`, `health()`, and explicit `transport: 'mcp' | 'rest' | 'auto'` selection; no provider-specific `if/else` branches in the router.
- [x] Intersect requested YAML recall/persist domains with `provider.capabilities.domains`, return omitted/unsupported domains in the result and receipt, and never claim unsupported memory was recalled or persisted.
- [x] Implement `memoryMcpJsonRpc.js` for MCP `tools/list` and `tools/call` envelopes, plus a local dispatcher for the built-in Action provider. Receipts distinguish `protocol: 'jsonrpc-mcp'` from `protocol: 'mcp-compatible-local'`.
- [x] Canonicalize repository, PR number, head SHA, anchors, and optional domain policy digests before hashing event IDs; test equivalent identities produce the same ID and different diff sides/file-level anchors do not collide.
- [x] Make unavailable providers return structured `{ status: 'unavailable', source, reason, latencyMs }` rather than throw into the review.
- [x] Run the router and full verification tests in the implementation worktree.

## Task 2: Make Honcho the first MCP provider — COMPLETE

- [x] Add adapter tests for the `honcho` provider, including normalized processing/code/rule/feedback envelopes, no raw prose, deterministic IDs, and at-least-once delivery receipts.
- [x] Implement `honchoMemoryMcpAdapter.js` as a read/write-capable provider whose review-time interface is MCP-shaped; reuse `createHonchoMemoryProvider` only as its internal Honcho transport.
- [x] Expand `normalizeReviewEvent` to preserve the versioned identity, domain, policy, feedback, rule, anchor, delivery, and protocol fields while excluding unknown prose.
- [x] Register `honcho_memory_query`, `honcho_memory_append_events`, and `honcho_memory_health` as fixed built-in control-plane tools. Only the bounded query is used by review orchestration.
- [x] Keep arbitrary `MCP_CONFIG_JSON` tools outside the built-in memory provider; trusted transport selection cannot be replaced by PR-head input.
- [x] Keep direct REST available only when trusted `honcho.transport: rest` is explicitly selected; `auto` remains provider-owned diagnostics.
- [x] Chunk event batches at the Honcho limit instead of truncating and track every event ID across accepted/pending/replay states, including batches larger than 100 events.
- [x] Run adapter tests and lint in the implementation worktree.

## Task 3: Make the Action runtime actually load MCP — COMPLETE

- [x] Add and run the plain Node Action-path load regression; no `ts-node`, TypeScript build, or server-only dependency is required.
- [x] Wire `review-pipeline.js` to `memoryProviderRouter.js`; retain `mcpFleetManager.ts` for server-side consumers and parity tests without relying on its optional import for Action behavior.
- [x] Resolve Honcho secrets through `DopplerSecretManagerRuntime`; no Doppler CLI assumption enters the Action runtime.
- [x] Refactor the server-side singleton into `McpFleetManager.create({ secretManager, adapters })` with dependency injection; the Action uses the CommonJS runtime provider.
- [x] Fix `SessionLedger` turn sequencing/recall, exact repository/PR history, and concrete `session_recap` event emission.
- [x] Run the Action-path load test and full verification in the implementation worktree.

## Task 4: Add trusted policy and shared learning schemas — COMPLETE

- [x] Extend `actionPolicy.memory.honcho` with `mcpEnabled`, `transport: 'mcp' | 'rest'`, bounded timeout, and context limits while preserving legacy REST behavior.
- [x] Add Action inputs `honcho-mcp-enabled` and `honcho-mcp-transport` with explicit precedence over trusted transport and legacy defaults.
- [x] Add schema validation tests for PR-head isolation, explicit Action false, legacy REST compatibility, and bounded values.
- [x] Parse and enforce the YAML recall/persist matrix while keeping GitHub same-PR enforcement active.
- [x] Implement legacy migration and top-level/nested intersection rules.
- [x] Document four learning domains, PR session recap semantics, capability negotiation, artifact retention, and rollback.
- [x] Run the policy, Honcho, and lint verification in the implementation worktree.

## Task 5: Query once before reviewer fan-out — COMPLETE

- [x] Add coverage for provider query source/protocol receipts, disabled behavior, bounded output, unsupported domains, and fail-open GitHub-only behavior; the plain Node load test proves the Action path.
- [x] Query only after the authenticated GitHub decision ledger snapshot and before reviewer scheduling, with a fixed bounded purpose and no reviewer-generated query text.
- [x] Render one fixed untrusted-data header and cap the complete block before prompt injection.
- [x] Keep provider context out of reconciliation, arbitration, publication planning, and maintainer-command parsing.
- [x] Run focused pipeline tests and full verification in the implementation worktree.

## Task 6: Persist durable processing and learning facts after publication — COMPLETE

- [x] Add tests for processing, pass, publication, session recap, code, rule, feedback, correction, and transition event domains.
- [x] Emit only normalized/hash-based code, rule, and feedback facts; titles, bodies, authors, and command reasons cannot enter provider payloads.
- [x] Create the processing/outbox intent before review work begins, then atomically write the filtered post-publication batch to a hashed `sessions/<identity-sha256>.memory-outbox.json` before provider network delivery, with exact identity, policy, events, and `GITHUB_OUTPUT` path.
- [x] Call the internal-only `router.appendEvents(...)` only after GitHub publication succeeds; record event IDs, delivery semantics, source, protocol, latency, attempts, and delivery key in sanitized receipts.
- [x] Add bounded retry/backoff in the same run plus pending/dead-letter outbox states, leased replay, trusted current endpoint resolution, exact-identity validation, and explicit replay authorization. Event IDs remain trace keys unless a provider advertises idempotency.
- [x] Keep accepted, derived-pending, and representation-ready as distinct provider/readiness concepts; preserve GitHub ledger and uploaded outbox recovery sources.
- [x] Document artifact retention/privacy and Honcho retention/deletion expectations.
- [x] Run event, outbox, >100-event chunking, retry, replay-contract, and publication-order verification in the implementation worktree.

## Task 7: Smoke, operations, and rollout — COMPLETE WITH LIVE READINESS LIMITATION

- [x] Add `--transport mcp|rest` to `scripts/honcho-smoke.mjs`; MCP is selected explicitly and REST is an explicit diagnostic path.
- [x] Make smoke receipts identify transport, protocol, provider source, omitted domains, host/workspace/status/HTTP/latency without secrets or context text.
- [x] Poll eventual representation readiness and distinguish health, write acceptance, derived-pending, and representation readiness; an empty first read is not success.
- [x] Run fixture smoke in MCP and REST modes and live Doppler smoke with project `hermes-memory`, config `prd`.
- [x] Document DigitalOcean HTTPS/auth/JWT scope, deriver, LLM provider, Redis, Postgres/pgvector, and readiness beyond `/health`.
- [x] Document rollback with `honcho-mcp-enabled: 'false'` or trusted `honcho.transport: rest`; no automatic pipeline fallback exists.
- [x] Run the full test/build/lint suite, syntax checks, fixture smoke, and live MCP receipt. Live representation remains an external readiness limitation.

## Acceptance criteria

- The Action loads and invokes the memory router under plain Node 20 without a TypeScript runtime.
- Honcho is one provider, not a special-case pipeline branch; a second provider can register the same capabilities without modifying reviewer orchestration.
- Every reviewer receives one bounded, byte-identical, explicitly untrusted context block from one provider query, with source/transport/protocol recorded.
- Processing, code, rule, and feedback facts are normalized, exact-head scoped, written to a durable outbox before delivery, and delivered at-least-once after publication.
- MCP failure produces GitHub-ledger-only behavior; no hidden REST retry occurs.
- REST remains an explicit adapter-level diagnostic/rollback mode only.
- No PR-controlled input can retarget memory, widen the query, alter arbitration, or publish provider-derived commands.
