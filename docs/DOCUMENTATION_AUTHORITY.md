# Documentation authority

This repository contains two different products and several retained design records. A document's
presence in the repository does not make it an operator runbook.

## Runtime authority

Use this order when documentation and executable behavior disagree:

1. [`action.yml`](../action.yml) and the checked-in Action pipeline define the public GitHub Action.
2. [`README.md`](../README.md), the configuration reference, the local-running guide, and the
   release guide explain that Action and its release process.
3. The CallTelemetry fleet is a separate control plane. Its provider order, credentials, caller
   permissions, release channel, rollback, and review gate are owned by
   [`calltelemetry/ct-review-actions`](https://github.com/calltelemetry/ct-review-actions), not by
   standalone examples in this repository.
4. The optional long-running App/dashboard service has separate deployment and authentication
   surfaces. Its documents do not configure the public Action or the CallTelemetry fleet.

Provider examples in this repository demonstrate direct Action configuration. They do not state
which provider the CallTelemetry fleet currently uses. A provider change for that fleet requires a
reviewed central policy change; editing these documents or this repository's disconnected profile
fixtures cannot activate one.

## Document classes

### Current Action and operator surfaces

- [`README.md`](../README.md)
- [`CHANGELOG.md`](../CHANGELOG.md) — generated release history
- [`CONFIGURATION_REFERENCE.md`](CONFIGURATION_REFERENCE.md)
- [`RUNNING_LOCALLY.md`](RUNNING_LOCALLY.md)
- [`RELEASING.md`](RELEASING.md)

Executable source remains authoritative for exact inputs and behavior. Sections explicitly marked
as optional service content are outside the public Action contract.

### Optional long-running service surfaces

- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md)
- [`GITHUB_APP_SETUP.md`](GITHUB_APP_SETUP.md)
- [`USER_GUIDE.md`](USER_GUIDE.md)
- [`ONBOARDING_GUIDE.md`](ONBOARDING_GUIDE.md)
- [`PUBLICATION_POLICY.md`](PUBLICATION_POLICY.md)
- [`PRD.md`](PRD.md)

These files describe the App/dashboard/service lineage. They are retained for that product only and
must not be used to install, operate, or choose providers for the public Action or CallTelemetry
fleet. Deployment, authentication, publication, and provider claims require verification against
the current service source before operational use.

### Historical or aspirational design records

- [`PROJECT.md`](../PROJECT.md), [`ORIGINAL_REQUEST.md`](../ORIGINAL_REQUEST.md),
  [`TEST_INFRA.md`](../TEST_INFRA.md), and [`TEST_READY.md`](../TEST_READY.md)
- [`review-comment.md`](../review-comment.md) — a retained sample artifact, not a live receipt
- [`OPENROUTER_TERRAFORM.md`](OPENROUTER_TERRAFORM.md) — retained CallTelemetry infrastructure and
  mutation guidance; non-operational until separately revalidated
- [`ADVERSARIAL_REVIEW_PATTERNS.md`](ADVERSARIAL_REVIEW_PATTERNS.md)
- [`GENERATIONAL_REVIEW_ENGINE_READINESS.md`](GENERATIONAL_REVIEW_ENGINE_READINESS.md)
- [`GENERATIONAL_REVIEW_ENGINE_TASKS.md`](GENERATIONAL_REVIEW_ENGINE_TASKS.md)
- [`ROADMAP.md`](ROADMAP.md) and [`VISION.md`](VISION.md)
- [`features/context_management.md`](features/context_management.md)
- `docs/superpowers/plans/`, `docs/superpowers/specs/`, and `docs/superpowers/evidence/`

These preserve the claims, branches, and acceptance evidence of a particular proposal or point in
time. They are non-authoritative and must not be read as current runtime, provider, release, or
deployment truth.

Versioned Markdown under `eval-baselines/` is generated or retained evaluation evidence. Interpret
it only with its exact source/tag, fixture, model, and run contract; it is not an operator runbook or
current provider policy.

Markdown under `tests/fixtures/` is test input, not product or operator documentation. In
particular, `tests/fixtures/workspaces/telecom-call-engine/README.md` exists to exercise repository
context behavior and carries no runtime, provider, release, or deployment authority.

### Unverified marketing drafts

- [`COMPETITIVE_LANDSCAPE.md`](COMPETITIVE_LANDSCAPE.md)
- [`MARKETING_OVERVIEW.md`](MARKETING_OVERVIEW.md)

Their competitor pricing, accuracy, performance, deployment, and zero-noise claims have not been
revalidated for current publication. Do not publish or reuse those comparisons until a separate
audit attaches current primary sources and reproducible measurements.

## Change rule

A change that alters Action inputs, review requests, provider routing, prompts, publication,
permissions, workflows, or release refs is not a documentation change. It requires its own focused
implementation PR and runtime evidence. Documentation classification never authorizes a canary,
scheduled model call, shadow review, automatic provider mutation, or production activation.
