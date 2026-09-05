# Documentation Authority

This repository contains the public open-source **Review Yeti** GitHub Action and Kubernetes review execution runtime, along with historical design records.

## Runtime Authority

When documentation and executable behavior disagree, use this order of precedence:

1. [`action.yml`](../action.yml) and the checked-in Action pipeline (`.github/workflows/pipelines/`) define the public GitHub Action interface.
2. [`README.md`](../README.md), the configuration reference, the onboarding guide, and the execution mode guides explain current runtime behavior and release processes.
3. Centralized organization wrapper workflows (e.g. `my-org/review-actions`) may enforce fleet-wide provider order, credentials, and caller permissions independently.
4. The optional self-hosted dashboard service has separate deployment and authentication surfaces.

## Document Classes

### Current Action, Setup, and Operator Guides

- [`README.md`](../README.md) — Main entry point and quickstart.
- [`ONBOARDING_GUIDE.md`](ONBOARDING_GUIDE.md) — Step-by-step consumer onboarding and deployment patterns.
- [`INTERACTIVE_CHAT.md`](INTERACTIVE_CHAT.md) — Interactive PR chat commands, webhook routing, and mentoring workflows.
- [`CLI_REFERENCE.md`](CLI_REFERENCE.md) — Local pre-commit CLI, 30-second setup wizard, and git hook setup.
- [`TEAM_MEMORY.md`](TEAM_MEMORY.md) — Persistent SQLite WAL reflection, community personas, and nit suppression.
- [`HELM_GUIDE.md`](HELM_GUIDE.md) — Production Helm chart installation, upgrades, and cloud values.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — Production triage, permission errors, rate limits, and incident playbooks.
- [`GITHUB_APP_SETUP.md`](GITHUB_APP_SETUP.md) — GitHub App registration, permissions matrix, and RS256 token exchange.
- [`KUBERNETES_MODE.md`](KUBERNETES_MODE.md) — Kubernetes and DOKS async execution mode, worker pods, and zero-waste dispatch handshake.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Core pipeline design, arbitration consensus, and trust boundaries.
- [`CONFIGURATION_REFERENCE.md`](CONFIGURATION_REFERENCE.md) — Full `.ct-review.yaml` schema and persona configurations.
- [`RUNNING_LOCALLY.md`](RUNNING_LOCALLY.md) — Terminal CLI usage and local diff review instructions.
- [`RELEASING.md`](RELEASING.md) — Release Please tagging and SemVer release rules.
- [`CHANGELOG.md`](../CHANGELOG.md) — Generated release history.

### Optional Self-Hosted Dashboard Service Surfaces

- [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md)
- [`USER_GUIDE.md`](USER_GUIDE.md)
- [`PUBLICATION_POLICY.md`](PUBLICATION_POLICY.md)
- [`PRD.md`](PRD.md)

These files describe the optional long-running web dashboard/service lineage (`npm start`). They are independent of the core GitHub Action and Kubernetes worker modes.

### Historical Design Records

- [`PROJECT.md`](../PROJECT.md), [`ORIGINAL_REQUEST.md`](../ORIGINAL_REQUEST.md)
- [`OPENROUTER_TERRAFORM.md`](OPENROUTER_TERRAFORM.md) — Retained infrastructure reference
- [`ADVERSARIAL_REVIEW_PATTERNS.md`](ADVERSARIAL_REVIEW_PATTERNS.md)
- [`ROADMAP.md`](ROADMAP.md) and [`VISION.md`](VISION.md)
- `docs/superpowers/` — Retained development execution evidence and planning specs.

These preserve point-in-time development records and should not be interpreted as authoritative runtime configurations.
