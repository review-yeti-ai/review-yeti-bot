# Optional DOKS Action Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `superpowers:test-driven-development`. Keep local execution as the default. Do not activate a required check, production publication, traffic split, or scheduled canary in this plan.

**Goal:** Let an explicit Review Yeti Action invocation admit a review to the durable DOKS queue in seconds, without transferring provider credentials or keeping a paid GitHub runner open for the review duration.

**Architecture:** The composite Action resolves immutable pull-request metadata, requests a short-lived GitHub Actions OIDC token with the fixed `review-yeti-doks-dispatch` audience, and sends a versioned request to one allowlisted HTTPS endpoint. The service verifies GitHub's JWT and immutable claim allowlists, cross-checks request identity against the token, and atomically writes delivery, run, and outbox rows. A `202` response means only `DISPATCHED/PENDING`; the Review Yeti App's later exact-head Check Run owns the terminal merge result.

**Activation boundary:** This plan delivers an opt-in, nonpublishing admission path. It does not claim that a DOKS worker or required App check is production-ready. Production activation remains gated by the main dispatch plan and the required-gate companion plan.

## Invariants

- `execution-backend` defaults to `local`; existing callers and outputs keep their current behavior.
- DOKS mode is explicit, fail-closed, and never falls back to local or another endpoint.
- The caller workflow must grant `permissions: id-token: write`; a missing OIDC capability is a terminal Action error.
- The audience is fixed to `review-yeti-doks-dispatch` and is not caller-configurable.
- The endpoint must be HTTPS, contain no credentials/query/fragment, and match the configured host plus exact `/api/dispatch/action` path.
- No provider key, GitHub token, diff, prompt, model response, or repository credential is sent in the request.
- The server treats verified JWT claims as authoritative and rejects mismatched repository, run, workflow, or event data.
- `publish-mode` defaults to `disabled`; only a trusted reusable workflow may request `app-gate` after the separate activation gate.
- A successful dispatch returns `review-status=DISPATCHED`, `gate-decision=PENDING`, and `merge-eligible=false`. It is not a green review.
- There is no scheduled canary. Qualification is manual, isolated, nonpublishing, and bounded to 15 minutes end to end.

## Task 1: Freeze and test the Action dispatch contract

**Files:**

- Modify: `action.yml`
- Create: `scripts/dispatch-doks-action.mjs`
- Create: `tests/unit/actionDoksDispatch.test.ts`
- Modify: `tests/unit/reviewActionPackaging.test.ts`

1. Add failing tests for the local default, DOKS-only branch, fixed OIDC audience, URL constraints, credential-minimal body, immutable SHA validation, and `DISPATCHED/PENDING/false` outputs.
2. Run `npm test -- tests/unit/actionDoksDispatch.test.ts tests/unit/reviewActionPackaging.test.ts` and confirm the new assertions fail.
3. Implement the smallest dispatch client and composite-action conditions that satisfy the contract.
4. Re-run the focused tests and `npm run lint`.

## Task 2: Add authenticated, durable Action admission

**Files:**

- Modify: `src/review/reviewRun.ts`
- Modify: `src/persistence/postgresStore.ts`
- Create: `src/persistence/reviewDispatchRepository.ts`
- Create: `src/auth/githubActionsOidc.ts`
- Create: `src/review/actionDispatch.ts`
- Create: `src/api/actionDispatchApi.ts`
- Modify: `src/app.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/unit/reviewDispatchRepository.test.ts`
- Create: `tests/unit/githubActionsOidc.test.ts`
- Create: `tests/integration/actionDispatchApi.test.ts`

1. Write failing tests for atomic admission, duplicate identity, superseded heads, OIDC issuer/audience/expiry/signature checks, claim allowlists, body/claim mismatch, disabled publication, and `202` only after admission succeeds.
2. Pin a CommonJS-compatible JOSE runtime and implement remote-JWK verification with a test-injected key set.
3. Add migration-safe delivery/outbox tables and a single-transaction admission repository.
4. Mount the public endpoint before dashboard authentication, guarded by `ACTION_DISPATCH_ENABLED=true` and explicit repository/owner/workflow allowlists. Refuse startup/requests when the durable store is unavailable.
5. Return only a versioned acceptance receipt and nonterminal run ID; do not call Kubernetes or a model from the request handler.
6. Run the focused tests, recovery tests, and `npm run lint`.

## Task 3: Manual nonpublishing qualification

1. Deploy the service endpoint with Action dispatch disabled, migration applied, and allowlists loaded.
2. Enable admission for one explicitly allowlisted repository and immutable trusted workflow SHA.
3. Run one `workflow_dispatch` invocation with `execution-backend: doks`, `publish-mode: disabled`, and `permissions: id-token: write`.
4. Require: Action acknowledgement under 15 seconds; one delivery, one run, and one outbox row; duplicate invocation does not create a second run; zero provider calls; zero GitHub comments/reviews/check conclusions.
5. Disable the flag if any invariant fails. Do not schedule repetition.

## Task 4: Later production activation gate

Only after the operator, receipt finalizer, exact-head App check, PVC reuse/expiry, and fast worker image pass their companion plans:

1. Run one manually approved parallel review with DOKS `publish-mode: disabled` and current production publishing unchanged.
2. Compare terminal completion, findings, false positives, latency, and cost on the exact same PR head.
3. Require explicit approval before setting `publish-mode: app-gate` or changing a required ruleset check.
4. Roll back by setting `execution-backend: local`; do not add periodic traffic or a timer-based canary.
