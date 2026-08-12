# Architecture

Review Yeti is a GitHub Action. There is no Review Yeti-managed server, database, or webhook
endpoint. Everything runs inside the workflow job on the runner, using the caller's `GITHUB_TOKEN`
and their own model API key. Optional memory is API-backed infrastructure selected and operated by
the caller; it is disabled by default and is never replaced by a local database in the Action.

The Action, CLI/runtime contracts, and Pi/MCP adapter ship from this same repository. The Pi
adapter is an execution surface, not a second memory authority: it can read bounded exact-head
context, while the review pipeline owns normalized memory writes and outbox delivery. See the
[canonical YAML examples](YAML_CONFIGURATION_EXAMPLES.md) for the settings used by each surface.
The `reviewyeti` CLI passes immutable refs, a bounded diff file, or a read-only pull request through
the same `src/runtime/reviewPipelineRuntime.js` boundary with publication disabled.

## The run

```text
pull_request event
  -> read policy from the PR *base* ref (never the PR's own checkout)
  -> fetch the exact-head diff over the API
  -> classify files (generated / vendored / binary are excluded)
  -> read authenticated same-PR ledger and optional local session recap
  -> one provider-neutral memory query (MCP-compatible Honcho when enabled)
  -> plan diff passes within the token budget
  -> create an immutable base/head navigation snapshot
  -> run bounded persona investigations (risk plan -> read-only evidence -> verification)
  -> derive the terminal outcome from lane, unit, verifier, and exact-head receipts
  -> require every lane marked `required`
  -> moderator reconciliation pass (dedupes across personas)
  -> separate binding arbiter pass (SHIP / FIX_FIRST / BLOCK)
  -> one compact COMMENT review + resolvable P0/P1 line conversations
  -> atomically persist normalized memory outbox after publication planning
  -> publish normalized events to the selected provider after GitHub publication (fail-open)
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

## Provider-neutral advisory memory

Review-time memory uses exactly one selected API provider per run. Trusted base-ref YAML chooses the
provider, transport, bounds, and recall/persist domains; the pipeline calls one bounded
`MemoryProviderRouter.queryContext` before fan-out and one normalized `appendEvents` after
publication. Honcho is the default, with mem0, Hindsight, Supermemory, and RetainDB behind the
same contract. These adapters call provider APIs; they do not connect the Action directly to a
database. Provider failure is auditable GitHub-ledger-only degradation. Offline outbox replay is
the migration/comparison mechanism; production never fans out or merges provider reads.

## Honcho advisory memory

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

The write path is intentionally not exposed as an arbitrary Pi/model tool. GitHub comments and
permissions are first converted into authenticated ledger transitions; only that normalized batch
can be persisted. This prevents prompt-injected or PR-controlled agents from inventing feedback,
retargeting a workspace, or changing review authority. A future Pi write command must submit the
same versioned event envelope through this pipeline/outbox boundary.

The trust boundary is intentionally split: GitHub APIs provide authoritative comments, review
threads, permissions, and exact-head state; the selected memory API provides advisory recall and
normalized persistence; the runner filesystem provides only temporary/replayable outbox storage.

## Bounded investigation

The production review path is full mode: there is no shadow, dormant, or prompt-only fallback.
Each persona receives a fixed trust-zoned JSON contract. It may request only `file_read`,
`file_find`, `code_search`, or `file_read_diff` against an immutable base/head snapshot. Defaults
are 12 evidence calls, 400 read lines, 50 search matches, 8,000 result bytes, two identical calls,
five candidate findings, three verifier calls per finding, and four model turns; hard ceilings are
enforced by the runtime. Receipts retain digests, counts, status, and termination reasons—not raw
prompts, source text, credentials, or model prose. Any incomplete lane, unresolved evidence,
unknown receipt, invalid anchor, verifier gap, or stale head blocks merge and publication.

Dependency analysis is only a planner hint for changed manifests, lockfiles, or import contracts;
the generic evidence runtime establishes the actual claim. See the production [bounded engine
design](superpowers/specs/2026-08-11-bounded-evidence-review-engine-design.md) for the schema and
termination matrix.

For a DigitalOcean self-host, use HTTPS at the public reverse proxy, enable JWT authentication with
the workspace-scoped token supplied to Doppler, and keep PostgreSQL/pgvector, Redis, the configured
LLM provider, and the deriver healthy. `/health` is only a process check; a successful
representation requires the deriver and its dependencies.

## Publication

Writes are bound to the exact reviewed head SHA. The sticky summary issue comment carries a stable
per-PR marker and is updated in place; each exact-head review receipt remains immutable, and prior
summary rounds are retained under collapsed bounded history. See
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
| `src/memory/providers/` | Built-in mem0, Hindsight, Supermemory, and RetainDB adapters plus allowlisted registry |
| `src/mcp/dopplerSecretManagerRuntime.js` | Dependency-free Action runtime Doppler REST resolver |
| `src/memory/sessionLedger.ts` | Exact-head PR session recap and turn history |
| `src/memory/memoryOutbox.js` | Atomic normalized event outbox and replay envelope |
| `src/memory/honchoMemory.js` | Optional native-fetch Honcho adapter with bounded context and normalized write-behind events |
| `src/pi/` | In-repository Pi/MCP execution adapter with trusted config and read-only tool boundary |
