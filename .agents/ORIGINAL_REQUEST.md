# Original User Request

## Initial Request — 2026-07-24T08:46:49Z

Build a powerhouse, quorum-based GitHub Review Bot service (`ct-review-bot`) competing with CodeRabbit/Greptile, deployed to DigitalOcean Kubernetes (DOKS). It orchestrates multi-LLM reviews utilizing local OmniRoute token routing, repo-level `.coderabbit.yaml` / `.ct-review.yaml` configs, operational `constitution.md`, issue tracking enforcement (Linear/Jira/GitHub), diff-focused persistent state, and GitHub App webhooks.

Working directory: /Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot
Integrity mode: development

## Requirements

### R1. Quorum Review Panel & Persona Orchestration Engine
- Multi-agent panel review engine supporting parallel fan-out / fan-in quorum consensus across persona reviewers (Security, Architecture, Performance, Code Quality/Nits).
- Repo-level YAML configuration (`.ct-review.yaml` / `.coderabbit.yaml`) with overrides and inheritance from organization master defaults.
- Enforce operational `constitution.md` guidelines and PR ticket linkages (Linear, Jira, GitHub Issues).
- Incremental diff-only review state persistence across commits/reviews to reduce token load and avoid re-flagging existing resolved nits/PXs.

### R2. OmniRoute Multi-LLM Router & Token Management
- Integrated OmniRoute adapter supporting API keys, usage-based subscriptions, and extra-usage tier subscriptions.
- Automatic token refresh, secret storage, model effort management, and provider failover.

### R3. GitHub App & Webhook Receiver Event Loop
- GitHub App webhook listener handling PR events (`opened`, `synchronize`, `reopened`, `@bot review` on-demand triggers, labels/tags).
- Post granular code inline comments on diffs (unresolved threads) and top-level PR summary reviews.

### R4. Containerized Microservice & DOKS K8s Deployment
- Package orchestrator and review runtime into Docker container images.
- Deploy to DigitalOcean Kubernetes (DOKS) cluster using `doctl`, Helm/kubectl manifests, and verify live cluster deployment.

### R5. Complete Automated Test Suite & Documentation
- End-to-end integration and unit test suite verifying webhook handling, OmniRoute routing, quorum consensus, diff delta tracking, and GitHub API interactions.
- Comprehensive PRD, Vision, Roadmap, and operator documentation in repository `docs/`.

## Acceptance Criteria

### Quorum & Review Engine
- [ ] Parse repo-level `.ct-review.yaml` and merged org defaults for panel configurations.
- [ ] Fan-out to reviewer persona agents concurrently and execute fan-in quorum aggregation.
- [ ] Enforce ticket linkage rules (Linear, Jira, GitHub issue keys in PR title/body) and `constitution.md` checks.
- [ ] State persistence tracks previously identified nits/PXs across PR pushes, evaluating only new diffs to optimize token usage.

### OmniRoute & LLM Orchestration
- [ ] OmniRoute routes review prompts across active provider subscriptions with token refresh logic.
- [ ] Supports adjustable reviewer model effort levels per panel/persona.

### Webhook & GitHub App Integration
- [ ] Webhook service authenticates GitHub signature and dispatches review jobs on-demand or on PR state changes.
- [ ] Inline review comments posted directly on affected diff lines.

### Infrastructure & Deployment
- [ ] Docker container build succeeds cleanly.
- [ ] Successfully deployed to DOKS cluster via `doctl` / `kubectl`.
- [ ] Deployment health check passes in live k8s environment.
