# Generational Review Engine Readiness

## Current branch

Branch: `codex/review-bot-generational-hardening`

This branch layers durable Pi execution and the generational review contracts on the current review-bot base. All review artifacts remain bound to exact pull-request head/base references; OpenRouter remains the only model transport in the existing runtime path.

## Landed implementation slices

- OpenRouter-only execution and deterministic cassette replay are inherited from the reviewed base commits.
- Pi runs persist stage artifacts, leases, retry state, cancellation/supersession state, and fenced publication claims.
- Repository context is immutable by commit/index epoch and emits exact citation ranges; unresolved recursive submodules are incomplete rather than green.
- Evidence receipts and quality metrics are deterministic and prevent unsupported high-severity findings from producing a green evidence gate.
- GitHub publication has exact-head revalidation, marker-based idempotency, line-resolution fallback, and ambiguous-write replay coverage.
- Review conversations are cited and exact-head bound; fixes require approval, sandboxed validation, and re-review.
- Effective policy, tenant boundary, and SLO contracts carry provenance and bounded safety caps.

## Verification receipt

At the current SHA, `npm run test:replay` passes twice (3 files, 11 tests each), the focused Task 2–7 suites pass, `npm run build:backend` passes, and `npm run lint` passes.

The repository-wide gates are not green: `npm run test:unit` reports 13 failed suites / 21 failed tests plus one missing `tools/mcp-session-analytics` module; `npm run test:integration` reports 6 failed suites / 7 failed tests. The failures are concentrated in legacy event-handler fixtures, OmniRoute compatibility expectations, dashboard/provider fixture state, package-version expectations, and one App publication model expectation. They must be classified and fixed before merge.

## Residual risks before merge

- Hosted GitHub checks and provider-side publication need exact-SHA verification on the ready PR.
- Full unit/integration suites currently contain unrelated legacy/UI coverage failures; they are recorded above rather than hidden.
- The newly added repository/evidence/fix contracts are not yet wired into every App/Action execution path; the existing shared runtime remains the compatibility surface.
- No auto-merge or autonomous production fix path is enabled.
