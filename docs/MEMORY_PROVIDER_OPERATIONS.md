# Memory Provider Operations

Review Yeti's memory integration is API-first. The Action selects one remote provider API per run;
it does not connect directly to SQLite, Postgres, pgvector, or another provider database. The local
outbox under `sessions/` is only a retry/replay artifact.

## YAML contract

The trusted-base configuration selects exactly one provider and independently controls recall and
persistence domains. `enabled`/`context` control reads; `write`/`persist` control normalized writes.
Provider profiles contain endpoint and credential references, never secret values.

```yaml
memory:
  enabled: true
  provider: honcho
  mode: single
  transport: mcp
  fallback: github_ledger_only
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
```

For a read-only rollout, set `write: false` or make every `persist` domain false. For a
feedback-only rollout, enable only `decision_feedback` and `session_recap` under `recall` and
`persist`. Top-level `same_pr_decisions: false` suppresses decision-feedback recall/persistence;
`session_recap: false` suppresses recaps everywhere. Provider capabilities are intersected with
the requested matrix and omitted domains appear in receipts.

The PR gate is deterministic and network-free. It uses sanitized VCR cassettes and workflow fixtures;
it never needs Mem0, Hindsight, Supermemory, or RetainDB credentials. Cassette replay proves request
shape, bounds, redaction, exact-head filters, and normalized event handling—not live provider
availability.

Live provider evidence is collected separately with `Memory Provider Canary` (`workflow_dispatch`). The canary selects exactly one provider, generates a synthetic repository/PR/head identity, performs health/query/append/exact-head reread/readiness checks, and uploads only a sanitized receipt. Missing credentials produce `not_configured`; they do not claim provider readiness. Honcho is the production-default option; its boundary is reported as `mcp-compatible-local` unless a real JSON-RPC MCP server is used.

Provider promotion requires:

- green provider cassette and contract tests;
- exact-head and repository isolation evidence;
- live health, accepted write, and eventual-readiness evidence;
- documented retention/deletion and idempotency semantics;
- no redaction, prompt-injection, or cross-tenant failures;
- Review Yeti workflow corpus passing with the provider selected alone.

Supermemory and RetainDB remain experimental until those gates are recorded. Provider failure degrades to GitHub-ledger-only review behavior; memory never controls arbitration or publication.

## What gets written

After GitHub publication, the Action converts the authenticated ledger and review result into
bounded `memory-event-v1` records. They include exact repository/PR/base/head identity, event type,
claim/anchor IDs, state, policy digest where relevant, and delivery metadata. Feedback events
represent authorized ignore/unignore commands, resolved/reopened/obsolete transitions, and bounded
reason taxonomy/hash values. Session recaps represent turn/head/verdict/coverage summaries. Raw
comment prose, author names, model transcripts, credentials, and executable instructions are not
memory facts.

The outbox is created before provider network delivery and can be uploaded as a workflow artifact.
Provider delivery is at-least-once; replay uses the original exact identity and a lease. GitHub's
ledger remains authoritative if provider state disagrees.

## Provider boundary matrix

| Provider | Action boundary | Default status | Required configuration |
| --- | --- | --- | --- |
| Honcho | REST API behind the MCP-compatible local runtime tool; explicit REST rollback is supported | Production default | `HONCHO_URL`, workspace-scoped credential/JWT, workspace ID, optional Doppler REST resolution |
| Mem0 | Mem0 REST API | Opt-in | `MEM0_URL`, `MEM0_API_KEY`, optional namespace |
| Hindsight | Hindsight REST API | Opt-in | `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, workspace/bank scope |
| Supermemory | Supermemory REST API | Experimental | `SUPERMEMORY_URL`, `SUPERMEMORY_API_KEY`, live ingestion/readiness evidence |
| RetainDB | RetainDB REST API | Experimental | `RETAINDB_URL`, `RETAINDB_API_KEY`, project/session scope, live ingestion/readiness evidence |

“MCP” in the Honcho row means the shipped local MCP-compatible runtime boundary. It should not be
described as a remote JSON-RPC MCP server until that protocol boundary is deployed and proven.
