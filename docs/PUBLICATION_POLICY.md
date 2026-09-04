# Panel publication policy

> [!IMPORTANT]
> **Optional service document.** This record describes a service/App publication design and is not
> the public Action or CallTelemetry fleet publication contract. Verify it against current service
> source before operational use. See [Documentation authority](DOCUMENTATION_AUTHORITY.md).

Last updated: 2026-08-03

## Problem this solves

Publishing **one `COMMENT` review per persona with inline findings** created:

1. Dozens of **resolve-required review threads** under `required_conversation_resolution`
2. Merge stuck at `mergeStateStatus: BLOCKED` while required checks were green
3. Status-check rollup flapping (`PENDING` ↔ `SUCCESS`) as each review write re-fired webhooks

## Policy

| Phase | GitHub surface | Purpose |
|-------|----------------|---------|
| Persona lanes | **Issue comments** only (`POST .../issues/{n}/comments`) | Advisory progress + finding summaries. Marker: `<!-- ct-review-persona ... -->` |
| Arbiter (final) | **One** Pull Request Review (`APPROVE` / `REQUEST_CHANGES`) | Binding verdict + exact-head ledger. Marker: `<!-- ct-review-final ... -->` |
| Arbiter (final) | **Inline review comments** (optional, capped) | Only **P0/P1**, cross-persona **deduped**, max **10** threads |

Personas must **never** call `POST .../pulls/{n}/reviews` with inline comments.

## Implementation

- Helpers: `src/github/panelPublication.ts`
- Pipeline: `src/app.ts` publish stage
- Tests: `tests/unit/panelPublication.test.ts`, `tests/integration/personaAppPipelineV3.test.ts`

## Deploy note

Ship this revision to the live App (production review-yeti deployment) before expecting production PRs to stop accumulating persona review threads.
