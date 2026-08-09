# Architecture

Review Yeti is a GitHub Action. There is no Review Yeti server, database, or webhook
endpoint. Everything runs inside the workflow job on the runner, using the
caller's `GITHUB_TOKEN` and their own model API key. Optional Honcho memory is an
external, caller-operated service and is disabled by default.

## The run

```text
pull_request event
  -> read policy from the PR *base* ref (never the PR's own checkout)
  -> fetch the exact-head diff over the API
  -> classify files (generated / vendored / binary are excluded)
  -> read authenticated same-PR ledger and optional local session recap
  -> one provider-neutral memory query (MCP-compatible Honcho when enabled)
  -> plan diff passes within the token budget
  -> run the applicable enabled persona lanes concurrently
  -> require every lane marked `required`
  -> moderator reconciliation pass (dedupes across personas)
  -> separate binding arbiter pass (SHIP / FIX_FIRST / BLOCK)
  -> one compact COMMENT review + resolvable P0/P1 line conversations
  -> atomically persist normalized memory outbox
  -> publish to provider after GitHub publication (fail-open)
```

## Why config comes from the base ref

Reviewer charters are prompts executed with the caller's API key. Reading them
from the pull request's own checkout would let a pull request rewrite the
instructions reviewing it — and declare as many reviewers as it likes. They are
fetched from the base ref instead, over the API, into a directory the pull
request cannot write to. This also means the caller does not need
`actions/checkout` at all.

## Model transport

OpenRouter is the only model transport. A lane that cannot reach its configured
model fails closed rather than silently substituting another model — the model
actually served is recorded and reported in the review.

## Optional Honcho advisory memory

When `memory.honcho.context` is enabled, the provider-neutral router resolves one bounded
representation for the repository and pull request before persona fan-out and places it in every
user message as untrusted advisory data. `memory.honcho.transport: mcp` selects the MCP-compatible
Honcho provider; `rest` is an explicit compatibility/rollback mode, not an automatic fallback.
When `memory.honcho.write` is enabled, normalized events are first written to a hashed atomic
outbox and then delivered after GitHub publication. Raw GitHub comment prose, author names,
commands, and credentials never enter Honcho. The same-PR GitHub decision ledger remains the source
of truth for carried, ignored, resolved, corrected, and obsolete findings.

The YAML recall matrix controls bounded decision feedback, PR session recaps, code signals, and
trusted-base rule signals. Session recaps contain turn/head/verdict/coverage and claim-state
summaries, not transcripts. Code and rule memory is advisory and cannot change arbitration or
execute instructions. Provider capabilities are intersected with the YAML matrix and omitted
domains are reported rather than silently claimed.

Honcho writes are at-least-once. Review Yeti computes canonical deterministic event IDs for
tracing, but the Honcho message endpoint is not treated as an idempotency API. Large batches are
chunked, and an uploaded outbox plus the replay command recover events after cancellation. Disable
`honcho-write` without affecting GitHub publication.

For a DigitalOcean self-host, use HTTPS at the public reverse proxy, enable JWT authentication with
the workspace-scoped token supplied to Doppler, and keep PostgreSQL/pgvector, Redis, the configured
LLM provider, and the deriver healthy. `/health` is only a process check; a successful
representation requires the deriver and its dependencies.

## Publication

Writes are bound to the exact reviewed head SHA. Every comment carries a stable
marker so a rerun updates in place instead of duplicating. See
[Publication Policy](PUBLICATION_POLICY.md).

## Layout

| Path | What it is |
|------|------------|
| `action.yml` | The composite action: input handling, dependency install, trusted config fetch |
| `.github/workflows/pipelines/review-pipeline.js` | The pipeline — diff planning, persona execution, arbitration, publication |
| `.github/workflows/pipelines/openRouterPolicy.js` | Resolves OpenRouter model/routing policy from inputs + YAML |
| `src/review/reviewCore.js` | Canonical verdict, finding, coverage, and digest logic |
| `src/review/findingPublication.js` | Pure planner deciding which findings become line vs. file comments |
| `src/review/claimSimilarity.js` | Cross-persona duplicate detection |
| `src/review/reviewIgnorePolicy.js` | File classification (generated, vendored, binary, oversized) |
| `src/mcp/memoryProviderRouter.js` | Plain-Node provider-neutral memory router used by the Action |
| `src/mcp/memoryMcpJsonRpc.js` | MCP JSON-RPC boundary and local MCP-compatible dispatcher |
| `src/mcp/honchoMemoryMcpAdapter.js` | First Honcho provider with bounded query and normalized writes |
| `src/mcp/dopplerSecretManagerRuntime.js` | Dependency-free Action runtime Doppler REST resolver |
| `src/memory/sessionLedger.ts` | Exact-head PR session recap and turn history |
| `src/memory/memoryOutbox.js` | Atomic normalized event outbox and replay envelope |
| `src/memory/honchoMemory.js` | Optional native-fetch Honcho adapter with bounded context and normalized write-behind events |
