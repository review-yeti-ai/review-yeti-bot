# Architecture

Review Yeti is a GitHub Action. There is no server, no database, and no webhook
endpoint. Everything runs inside the workflow job on the runner, using the
caller's `GITHUB_TOKEN` and their own model API key.

## The run

```text
pull_request event
  -> read policy from the PR *base* ref (never the PR's own checkout)
  -> fetch the exact-head diff over the API
  -> classify files (generated / vendored / binary are excluded)
  -> plan diff passes within the token budget
  -> run the applicable enabled persona lanes concurrently
  -> require every lane marked `required`
  -> moderator reconciliation pass (dedupes across personas)
  -> separate binding arbiter pass (SHIP / FIX_FIRST / BLOCK)
  -> one compact COMMENT review + resolvable P0/P1 line conversations
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

When `memory.honcho.context` is enabled, the pipeline resolves a bounded representation for the
repository and pull request before persona fan-out and places it in the user message as untrusted
advisory data. When `memory.honcho.write` is enabled, publication is followed by a fail-open write
of normalized event metadata (claim ids, severities, paths, states, and verdicts) to the configured
Honcho workspace/session. Raw GitHub comment prose, author names, commands, and credentials never
enter Honcho. The same-PR GitHub decision ledger remains the source of truth for carried, ignored,
resolved, and obsolete findings.

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
| `src/mcp/` | Optional MCP adapters (Context7 docs, Linear) |
| `src/memory/sessionLedger.ts` | Per-PR turn history so reruns do not repeat prior findings |
| `src/memory/honchoMemory.js` | Optional native-fetch Honcho adapter with bounded context and normalized write-behind events |
