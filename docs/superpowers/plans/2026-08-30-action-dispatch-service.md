# Admission-Only DOKS Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `superpowers:test-driven-development`. This service may admit nonpublishing qualification work only. Do not mount a webhook, provider runtime, dashboard, Kubernetes worker, required check, or scheduled canary.

**Goal:** Run the merged opt-in Action admission endpoint on DOKS without deploying the legacy full bot service or exposing any route that can execute or publish a review.

**Architecture:** A dedicated Node entrypoint initializes PostgreSQL with verified TLS, mounts only health/readiness and the existing OIDC Action router, and runs without provider credentials. A separate digest-pinned Deployment and exact-path Ingress expose only `/api/dispatch/action`. One manual central workflow may prove OIDC-to-outbox admission with `publish-mode: disabled`; no dispatcher consumes the row yet.

## Task 1: Dedicated process and verified database TLS

- Add failing tests for a minimal Express app with no webhook/dashboard/provider routes.
- Add failing tests that `DATABASE_CA_CERT` produces `rejectUnauthorized: true` TLS configuration.
- Initialize the schema before listening and make readiness query PostgreSQL.
- Run focused tests and TypeScript validation.

## Task 2: Isolated Kubernetes deployment

- Add a separate Deployment, Service, exact-path Ingress, default-deny-compatible NetworkPolicy, and digest-only deploy script.
- Do not apply `k8s/config.yaml`, the legacy shared RWM PVC, full bot Deployment, OmniRoute, or worker RBAC.
- Mount only App ID/private key, database URL/CA, and OIDC allowlists. Do not mount webhook or provider secrets.
- Require `ACTION_DISPATCH_ALLOW_APP_GATE=false`.

## Task 3: Manual nonpublishing caller

- Add a `ct-review-actions` manual workflow with `id-token: write`, exact target PR SHA inputs, exact bot commit checkout, `execution-backend: doks`, and `doks-publish-mode: disabled`.
- Assert Action outputs are exactly `DISPATCHED`, `PENDING`, and `false`.
- Keep the workflow timeout at 15 minutes and omit all provider secrets.

## Task 4: Qualification and rollback

- Deploy from reviewed exact heads with digest-pinned image and allowlisted repository/owner/workflow SHA.
- Require HTTPS verification, sub-15-second Action acknowledgement, and exactly one delivery/run/outbox row after a retry.
- Require zero comments, reviews, checks, provider calls, Jobs, and PVCs.
- Roll back by deleting the isolated Deployment/Service/Ingress/NetworkPolicy or setting `ACTION_DISPATCH_ENABLED=false`; PostgreSQL evidence may remain for audit.
