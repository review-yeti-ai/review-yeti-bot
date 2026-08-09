# Multi-provider review memory design

**Status:** Design approved for planning; implementation not started.

## Goal

Make the Review Yeti memory feature competitive with review systems that learn from review comments, replies, corrections, reactions, commits, repository rules, and prior review sessions, while keeping GitHub's authenticated decision ledger authoritative. Honcho remains the default first provider. The architecture must make mem0, Hindsight, Supermemory, and RetainDB selectable without changing reviewer orchestration.

The Hermes benchmark is useful capability evidence, not production certification. It tested automatic ingestion and context injection, not security, durability, tenant isolation, or provider operations. Therefore every adapter must pass Review Yeti's own contract, privacy, reliability, and live-readiness gates before it can be recommended.

## Decisions

1. Exactly one memory provider is selected for each review run. Production never fans out writes or merges reads across providers. This keeps context deterministic, avoids duplicate/conflicting truth, and makes receipts auditable.
2. Honcho is the default provider until another provider has green contract and live evidence. Other providers are opt-in profiles and may be marked experimental.
3. The pipeline calls one provider-neutral `queryContext` before reviewer fan-out and one provider-neutral `appendEvents` after successful publication. Provider-specific fallback is not embedded in the pipeline; an unavailable provider degrades to GitHub-ledger-only behavior.
4. GitHub comments, authenticated commands, review threads, and commit evidence remain the authority for finding state and publication. Memory can advise reviewers but cannot change arbitration, suppress a finding, execute a rule, or publish a command.
5. The trusted base `.review-yeti.yaml` selects the provider and controls recall/persist domains. PR-head configuration cannot retarget endpoints, credentials, namespaces, or provider selection.
6. The existing normalized, exact-head, redacted event envelope and outbox/replay mechanism are provider-neutral. Provider adapters translate that envelope to their native API and report supported domains, readiness, transport, delivery semantics, and omitted classes.
7. Honcho's current Action integration remains labelled `MCP-compatible-local` until a real external JSON-RPC MCP client boundary is proven. Other adapters may use REST, SDK, or local transports according to their capability declarations.

## Competitive feature alignment

Review Yeti should match the useful outcomes associated with CodeRabbit and Greptile-style learning without copying their trust assumptions:

- Feedback loop: persist append-only transitions for open, resolved, ignored, unignored, reopened, obsolete, addressed-by-commit, and authenticated maintainer corrections. Include permission class, bounded reason tags, thread/claim identifiers, and reason hash; never persist raw comment prose.
- Repository/path scope: retain repository, path, language, diff-side/file anchor, base/head SHA, policy digest, and claim fingerprint so a memory cannot bleed across repositories or unrelated files.
- Session continuity: emit a concrete `session_recap` event for each published run with prior/current head, turn, verdict, coverage, and bounded claim/state summary. Recaps are not raw transcripts.
- Rule and code learning: persist normalized code signals and trusted-base rule facts. Rules are advisory facts only and never executable from provider context.
- Safety and auditability: expose query source, provider, adapter/contract versions, latency, omitted domains, acceptance/derivation/readiness, and outbox delivery state in receipts.
- Offline comparison: use replayable outboxes and a Review Yeti corpus to compare providers without runtime multi-provider fan-out.

## Configuration

The canonical trusted-base shape is:

```yaml
memory:
  enabled: true
  provider: honcho             # honcho | mem0 | hindsight | supermemory | retaindb
  mode: single                 # only supported production mode
  transport: mcp               # provider-supported; REST is explicit compatibility mode
  fallback: github_ledger_only # no provider-to-provider fallback
  contract: memory-provider-v1

  query:
    timeout_ms: 1500
    max_context_chars: 4000
    max_entries: 40

  recall:
    decision_feedback: true
    session_recap: true
    code_signals: true
    rule_signals: true

  persist:
    processing: true
    decision_feedback: true
    session_recap: true
    code_signals: true
    rule_signals: true

  providers:
    honcho:
      enabled: true
      transport: mcp
      endpoint_env: HONCHO_URL
      credential_env: HONCHO_API_KEY
      workspace_env: HONCHO_WORKSPACE_ID
    mem0:
      enabled: false
      transport: rest
      endpoint_env: MEM0_URL
      credential_env: MEM0_API_KEY
      namespace_env: MEM0_NAMESPACE
    hindsight:
      enabled: false
      transport: rest
      endpoint_env: HINDSIGHT_URL
      credential_env: HINDSIGHT_API_KEY
    supermemory:
      enabled: false
      transport: rest
      endpoint_env: SUPERMEMORY_URL
      credential_env: SUPERMEMORY_API_KEY
    retaindb:
      enabled: false
      transport: rest
      endpoint_env: RETAINDB_URL
      credential_env: RETAINDB_API_KEY
```

Validation must reject an unknown provider, a disabled selected profile, missing secret references, unsupported transport, duplicate provider selection, or a provider that cannot satisfy the requested recall/persist classes. Unsupported classes are reported as omitted; they are never silently treated as available.

Existing `memory.honcho` and `honcho-*` Action inputs remain compatible. When `memory.provider` is absent, legacy configuration selects Honcho. Action inputs may override the master enable switch, transport, timeout, and context bounds, but cannot widen domains or retarget the selected provider. The effective provider/configuration is recorded in the receipt.

## Provider contract

Every adapter implements the existing `MemoryProvider` contract:

- `queryContext({ identity, purpose, recallDomains, maxContextChars, maxEntries, deadlineMs })`
- `appendEvents({ identity, events, persistDomains, deliveryKey })`
- `healthCheck()` and `readiness()`
- capability metadata: contract version, adapter version, supported domains, transports, protocol, idempotency, delivery semantics, retention/deletion behavior, and tenant scope

All adapters receive the same `MemoryIdentity` and normalized event envelope. The router intersects requested domains with provider capabilities and returns `omittedDomains` and reasons. Reads are bounded, explicitly untrusted, and byte-identical across reviewer lanes.

## Provider rollout

- Honcho: production default and current integration.
- mem0: first new adapter; evaluate condition-bound feedback and stale-fact reconciliation.
- Hindsight: next; evaluate evolving-fact recall, wide-result bounding, and ranking latency.
- Supermemory: experimental until a current release passes ingestion, dispatcher liveness, and empty-recall checks.
- RetainDB: experimental; benchmark-required patches and maintenance risk must be documented before enablement.

Each adapter must prove current API/auth behavior, tenant/namespace isolation, exact-head filtering, write/read consistency, deletion/retention behavior, rate limits, idempotency semantics, and maintained client support. Benchmark scores alone cannot promote a provider.

## Evaluation and acceptance

Use a replayable corpus containing repeated PRs, comments, replies, resolved/ignored/reopened findings, maintainer corrections, rule changes, code-pattern recurrences, session recaps, stale heads, and conflicting signals. Score:

- relevant recall precision and coverage;
- correction, ignore, unignore, and reopen adherence;
- false-suppression safety;
- exact-head and repository isolation;
- latency, context size, token/cost workload, and outage recovery;
- delivery/idempotency behavior and outbox replay;
- redaction and retention compliance.

Promotion requires green contract tests, provider-specific smoke evidence, no privacy failures, and explicit documentation of unsupported domains. Cross-provider comparison uses offline outbox replay or isolated canaries, never production fan-out.

## Trust and operations

Provider endpoints and credentials resolve only from trusted base configuration and Doppler. Raw comments, author names, maintainer prose, secrets, transcripts, and model instructions never enter provider payloads. A provider outage, timeout, deriver delay, or unsupported capability records a reason and continues with GitHub-ledger-only review behavior.

Outbox files remain exact-head scoped, atomically written, hashed for safe paths, replayable with leases and dead-letter state, and uploaded by the consuming workflow. Receipts distinguish accepted, pending/derived, representation-ready, and unavailable states.

