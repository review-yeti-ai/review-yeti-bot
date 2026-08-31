# Fail-Closed DOKS Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion`. Do not activate fleet traffic, enable App publication, deploy legacy worker code, or add a scheduled canary.

**Goal:** Safely advance the admitted DOKS review path from a durable outbox row to an immutable Kubernetes execution projection while preserving non-publishing qualification as a fail-closed policy.

**Architecture:** PostgreSQL remains lifecycle authority. Admission persists the requested publication mode on the review run, and the dispatcher may initially claim only rows whose immutable mode is `disabled`. A pure projection builder validates exact identity, digests, image pin, and deadline before a separate dispatcher process can create a `PRReviewJob`. No worker, provider credential, GitHub App private key, or publishing permission is introduced in the first protected slice.

## Safety invariants

- The accepted admission deadline remains exactly 15 minutes; no component may extend it.
- No scheduled, periodic, traffic-split, or four-hour canary is added.
- Existing and migrated rows default to `disabled`, never `app-gate`.
- A duplicate delivery with a different publication mode is an identity conflict.
- The initial dispatcher rejects every publication mode except `disabled`.
- A projected resource contains no secret values and requires a digest-pinned worker image.
- The central GitHub Action path remains the production path until separate manual qualification and activation approval.

## Change A: Persist immutable publication policy

1. Add failing API and repository tests proving `publishMode` reaches admission and survives claim.
2. Add a constrained `publication_mode` column to `review_runs`, with a fail-closed `disabled` migration default.
3. Persist the mode transactionally with the run and include it in duplicate-delivery consistency checks.
4. Return the mode in review-run and dispatch-claim types.
5. Run focused tests, typecheck, and the full Node suite before protected review and merge.

## Change B: Build a deterministic non-secret projection

1. Add failing tests for exact manifest identity, immutable digests, remaining deadline, and image digest validation.
2. Add a pure `PRReviewJob` projection builder whose initial policy accepts only `disabled` publication mode.
3. Prove serialized projections contain no App private key, provider key, installation token, or callback bearer token.
4. Run focused tests, typecheck, and full verification before protected review and merge.

## Change C: Add the isolated dispatcher process

1. Add failing tests for one durable claim, idempotent projection, projected acknowledgement, bounded retry, and expired-run terminalization.
2. Add a separate dispatcher entrypoint and least-privilege ServiceAccount/RBAC for only the versioned `PRReviewJob` resource in the qualification namespace.
3. Keep the Deployment scaled to zero until the hardened CRD/operator and receipt-only qualification worker are reviewed and installed.
4. Do not mount GitHub App or provider credentials into this dispatcher slice.

## Change D: Harden operator and qualify execution

1. Replace the legacy CRD/controller with the reviewed contract: maximum four active Jobs, `backoffLimit: 0`, computed deadline, hardened Pod security, no service-account token, and digest-only image.
2. Implement PR-scoped RWO PVC plus Lease isolation and the exact 30-minute idle reclamation rule.
3. First run a manual receipt-only worker with publication disabled and no provider call.
4. Then run one manual exact-head, non-publishing provider review and verify the authenticated receipt, terminal state, cleanup, and zero GitHub writes.
5. Activation remains a separate protected fleet-policy change with explicit approval and immediate rollback to the central Action.

## Acceptance and rollback

- Each change lands independently through exact-head protected review and terminal CI.
- No qualification may exceed 15 minutes, and no background schedule is created.
- Before activation, all production review calls continue through the current central Action.
- Rollback is scale-to-zero/delete of the isolated dispatcher/operator resources; durable rows remain audit evidence and retain their immutable `disabled` mode.
