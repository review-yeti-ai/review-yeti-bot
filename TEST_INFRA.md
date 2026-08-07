# Test Infrastructure

## Running the suite

```bash
npm test              # full suite (Vitest)
npm run test:unit     # tests/unit
npm run test:integration
npm run test:replay   # cassette replay — no credentials, no network
npm run lint          # tsc --noEmit
```

## Boundary Replay and Cassette Rules

Every external boundary is injectable and deterministic:

- HTTP clients and model calls accept injectable fetch implementations. Retry clocks, sleeps, and jitter are injectable as well.
- The live review engine uses OpenRouter as its sole model transport.
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

## Review contract asserted on both execution surfaces

- `src/review/reviewCore.js` is the canonical verdict, finding, coverage, and digest boundary; the
  plain Node Action and typed App adapters must produce the same result for the same snapshot.
- `PRSnapshot` binds owner, repository, PR number, exact head SHA, exact base SHA, changed-file
  metadata, base-policy reference/digest, and engine version. A changed head or base fails closed.
- V4 execution policy is additive to V3 and carries bounded budgets plus explicit submodule policy.
  Gitlink metadata is preserved; recursive inspection is `INCOMPLETE_REVIEW` until nested content
  is actually resolved.
- Durable runs use the `review_runs` identity, lease, heartbeat, stage, result digest, and
  failure fields. The PostgreSQL repository is used when configured; the in-memory repository is
  test-only and never evidence of multi-pod durability.
- A provider or publication failure is persisted as failure, never as a successful verdict. No
  `SHIP` is valid with missing lanes, incomplete coverage, an unbound snapshot, or missing evidence.

Governance and operational tests also assert that effective policy carries source provenance and a
digest, platform caps cannot be widened by repository/workflow overrides, tenant boundaries cover
runs/indexes/artifacts/logs, and SLO receipts expose queue latency, first-comment latency,
completion latency, provider availability, index freshness, cost, and false-positive feedback.

## Recording cassettes

Recording is an explicit maintenance operation. It requires both `REVIEW_YETI_VCR=record` and an
endpoint origin in the harness allowlist; it is never enabled implicitly by a missing cassette or an
environment credential. Review generated cassettes for secrets and customer data before committing
them.
