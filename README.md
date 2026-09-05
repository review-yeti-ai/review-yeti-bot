# 🏔️ Review Yeti

[![Review Bot](https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/review-bot.yaml/badge.svg)](https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/review-bot.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Action](https://img.shields.io/badge/GitHub%20Action-v1-green.svg)](https://github.com/marketplace/actions/review-yeti-ai)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-Ready-326ce5.svg)](docs/KUBERNETES_MODE.md)
[![Helm Chart](https://img.shields.io/badge/Helm%20Chart-1.0.0-informational.svg)](charts/review-yeti)
[![Examples Gallery](https://img.shields.io/badge/Examples-Gallery-purple.svg)](examples)

**Autonomous Multi-Persona AI Code Review Panel for GitHub Pull Requests.**

Review Yeti convenes a panel of specialized AI reviewers—each with a dedicated charter (Security, Performance, Architecture, Quality, Dependencies)—evaluating pull request diffs in parallel, reconciling findings through automated arbitration, and posting **one consolidated, actionable review comment** and native **GitHub Check Run**.

> [!TIP]
> 🚀 **Explore Pre-Built Resources**:
> - **[Official Helm 3 Chart](charts/review-yeti/)** & **[Helm Operations Guide](docs/HELM_GUIDE.md)** for production Kubernetes clusters.
> - **[Examples Gallery](examples/)** featuring 6 production workflows, 4 configuration profiles, and custom persona charters.
> - **[Production Troubleshooting Guide](docs/TROUBLESHOOTING.md)** for triage and incident resolution.

---

## ✨ Features at a Glance

- 👥 **Multi-Persona Review Panel**: Dedicated reviewers for Security & Tenancy, System Architecture, Performance, QA & Testing, and Dependency Safety.
- ⚡ **Native 1-Click Commit Suggestions**: Formats actionable fixes directly into native GitHub ````suggestion ` diff blocks for 1-click merging.
- 💬 **Interactive PR Chat Mentoring**: Mention `@review-yeti explain`, `@review-yeti fix`, `@review-yeti ignore`, or `@review-yeti mute` in review threads ([Guide](docs/INTERACTIVE_CHAT.md)).
- 💻 **Local Pre-Commit CLI & Git Hook**: Evaluate staged changes in < 5s with sub-10ms credential detection and blocking P0 checks via `git yeti pre-commit` ([Guide](docs/CLI_REFERENCE.md)).
- 🧙 **30-Second GitHub App Setup Wizard**: Automated onboarding via GitHub App Manifest Flow (`npx review-yeti init`) with least-privilege security and `.env` generation ([Guide](docs/CLI_REFERENCE.md#review-yeti-init-30-second-setup-wizard)).
- 👥 **Community Persona Store**: Reference and compose external persona charters across repositories using `uses: ...` ([Guide](docs/TEAM_MEMORY.md#community-persona-store--charter-loader)).
- 🧠 **Persistent Team Memory**: SQLite WAL database (`.ct-memory/team_memory.db`) that suppresses repetitive false-positive nits while enforcing non-bypassable P0/P1 security gates ([Guide](docs/TEAM_MEMORY.md)).
- ⚖️ **Binding Arbitration Engine**: Automated moderator and arbiter that deduplicate findings and deliver clear verdicts: `SHIP`, `FIX_FIRST`, or `BLOCK`.
- ⚡ **Dual Execution Engines**:
  - **Ephemeral Action Mode**: Zero infrastructure, 60-second setup directly in GitHub Actions.
  - **Kubernetes Worker Mode**: Dispatches reviews to K8s pods in **< 10 seconds**, eliminating 95%+ of billable runner minute waste.
- 🔐 **Base-Ref Trust Boundary**: Charters and policies are loaded strictly from the target base branch (`main`), preventing PRs from tampering with their own review rules.
- 🎯 **Zero Diff Hallucinations**: Automated filter discards any finding referencing code outside the PR's modified hunks.
- 🌐 **Model & Provider Agnostic**: Works with OpenRouter, Anthropic, OpenAI, DeepSeek, or self-hosted Ollama/vLLM endpoints.

---

## 🏗️ Architecture Overview

```mermaid
graph TD
    PR[Developer Opens / Updates PR] --> Choice{Execution Mode}

    subgraph Mode 1: Ephemeral Action
        Choice -->|Zero Infra| GHA[GitHub Actions Runner]
        GHA --> Panel1[Parallel AI Personas Panel]
    end

    subgraph Mode 2: Kubernetes Worker
        Choice -->|Zero Runner Waste| Shim[GHA Dispatch Shim < 10s]
        Shim -->|review-status: DISPATCHED| CheckRun1[GitHub Check Run: PENDING]
        Shim -->|Async Admission| K8S[Kubernetes Review Cluster]
        K8S -->|Ephemeral Worker Pod| Panel2[Parallel AI Personas Panel]
    end

    subgraph The Review Yeti Core
        Panel1 --> Arb[Arbitration & Consensus Engine]
        Panel2 --> Arb
        Arb --> Verdict{Verdict}
        Verdict -->|0 Critical Issues| Ship[🟢 SHIP]
        Verdict -->|Non-blocking nits| Fix[🟡 FIX_FIRST]
        Verdict -->|P0 or Quorum P1s| Block[🔴 BLOCK]
    end

    Ship --> Output[Post Consolidated PR Comment & Update Check Run]
    Fix --> Output
    Block --> Output
```

---

## ⚡ Quickstart: 5-Minute GitHub Action

Add a single workflow file to any repository:

```yaml
# .github/workflows/review-yeti.yml
name: Review Yeti
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Run Review Yeti
        uses: review-yeti-ai/review-yeti-bot@v1
        with:
          llm-base-url: https://openrouter.ai/api/v1
          model: deepseek/deepseek-v4-flash-0731
          llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

> [!TIP]
> **No `actions/checkout` required!** Review Yeti fetches the PR diff and base branch charters directly over the GitHub API, saving checkout time and bandwidth.

---

## ☸️ Scale-Out: Kubernetes & DOKS Execution Mode

For teams with high PR volume, running 5+ personas inside GitHub Actions runners can accumulate costly billable runner minutes. 

Review Yeti's **Kubernetes Mode** uses an asynchronous dispatch handshake:
1. The GitHub Action acts as a lightweight shim, calls your Kubernetes cluster, and exits in **< 10 seconds**.
2. The Action registers an initial check run: `review-status: DISPATCHED`, `gate-decision: PENDING`.
3. An ephemeral worker pod in your Kubernetes cluster processes the review, posts the PR review comment, and updates the GitHub Check Run to `success` or `failure` directly using its GitHub App token.

```yaml
# .github/workflows/review-yeti-k8s.yml
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      checks: write
    steps:
      - name: Dispatch to Kubernetes Review Cluster
        uses: review-yeti-ai/review-yeti-bot@v1
        with:
          execution-backend: doks  # or generic kubernetes
          dispatch-url: https://review-bot.example.com/api/admission/dispatch
          dispatch-token: ${{ secrets.REVIEW_DISPATCH_SECRET }}
```

### 🚀 Self-Hosting with Official Helm 3 Chart

Review Yeti provides a production-grade Helm 3 chart in [`charts/review-yeti/`](charts/review-yeti/):

```bash
# 1. Add and install Review Yeti using production values
helm install review-yeti charts/review-yeti \
  --namespace review-yeti-system \
  --create-namespace \
  -f examples/k8s/values-doks.yaml
```

Pre-configured cloud values files are available in [`examples/k8s/`](examples/k8s/):
- **DigitalOcean (DOKS)**: [`examples/k8s/values-doks.yaml`](examples/k8s/values-doks.yaml) (DO LoadBalancer + Block Storage)
- **AWS EKS**: [`examples/k8s/values-eks.yaml`](examples/k8s/values-eks.yaml) (AWS Load Balancer Controller ALB + gp3)
- **Local Dev**: [`examples/k8s/values-local.yaml`](examples/k8s/values-local.yaml) (Minikube / Kind / K3s with local Ollama)

👉 **Read the comprehensive [Helm 3 Operations Guide](docs/HELM_GUIDE.md)**, **[Kubernetes Architecture Specification](docs/KUBERNETES_MODE.md)**, and **[Troubleshooting Guide](docs/TROUBLESHOOTING.md)**.

---

## 📊 What You Get: Consolidated PR Review Comment

Review Yeti posts a single, clean markdown review comment summarizing all personas:

> ## 🟡 **Verdict: FIX_FIRST**
>
> ### 📊 AI Review Panel Summary
> - **Repository**: `my-org/checkout-service`
> - **Commit SHA**: `a1b2c3d`
> - **Review Mode**: Model-backed (`deepseek/deepseek-v4-flash-0731`)
> - **Parallel Personas Evaluated**: `5/5`
> - **Quorum Status**: `SATISFIED`
> - **Total Findings**: P0: `0` | P1: `1` | P2: `2`
> - **Rationale**: Changes requested for 1 P1 finding(s) and 2 P2 nit(s).
>
> ### 📋 Persona Evaluation Roster
> | Reviewer Persona | Model | Decision | Findings |
> |---|---|---|---|
> | 🛡️ Security & Tenancy Guardian | `deepseek/deepseek-v4-flash-0731` | ⚠️ FINDINGS | 1 |
> | ⚡ Performance & Scalability Specialist | `deepseek/deepseek-v4-flash-0731` | ✅ APPROVE | 0 |
> | 🏛️ System Architecture & Design | `deepseek/deepseek-v4-flash-0731` | ⚠️ FINDINGS | 2 |
> | 🧪 Testing & Quality Assurance | `deepseek/deepseek-v4-flash-0731` | ✅ APPROVE | 0 |
> | 📦 Dependency Safety & Supply Chain | `deepseek/deepseek-v4-flash-0731` | ✅ APPROVE | 0 |
>
> **🛡️ Security & Tenancy Guardian (1 finding)**
>
> | Severity | Path | Line | Title | Suggestion |
> |---|---|---|---|---|
> | 🟠 P1 | `src/api/orders.ts` | 42 | **Order lookup not scoped to tenant** | Add `orgId` to the where clause. |

---

## 👥 The Reviewer Persona Roster

### Built-in Personas (On by Default)
- 🛡️ **`security`**: SQL injection, authorization bypass, secret leakage, OWASP top 10, multi-tenant isolation.
- ⚡ **`performance`**: N+1 queries, unindexed filters, thread blocking, memory leaks, high complexity loops.
- 🏛️ **`architecture`**: Layering violations, interface segregation, tight coupling, anti-patterns.
- 🧪 **`testing`**: Edge cases, missing assertions, negative testing, test coverage for modified code.
- 📦 **`dependencies`**: Vulnerable packages, supply-chain safety, deprecation risks.

### Optional Specialists (Opt-in via `.ct-review.yaml`)
- 🗄️ **`database`**: Schema migrations, lock hazards, transaction isolation.
- 🌐 **`accessibility`**: WCAG compliance, screen reader support, semantic markup.
- 🎨 **`style`**: Idiomatic conventions, readability, clarity.
- 📄 **`documentation`**: Public API documentation, docstrings, change notes.
- 🚀 **`devops`**: Dockerfile best practices, Kubernetes configs, CI/CD scripts.
- 🌍 **`i18n`**: Hardcoded UI strings, localization safety.
- ⚖️ **`licensing`**: Open-source license compatibility.

```yaml
# Select specific personas in action inputs:
with:
  personas: security,performance,database
```

---

## ⚖️ How Verdicts & Merge Gates Work

| Verdict | Condition | GitHub Check Run Status | Description |
| :--- | :--- | :--- | :--- |
| **`SHIP`** 🟢 | 0 P0s, 0 P1s, minimal P2s | `success` | Approved. Safe to merge! |
| **`FIX_FIRST`** 🟡 | 0 P0s, 1+ P1s (or high P2 volume) | `neutral` / `failure` | Non-blocking recommendations to resolve before release. |
| **`BLOCK`** 🔴 | 1+ P0s, or P1 quorum reached | `failure` | Merge blocked until critical issues are fixed. |

---

## 🛠️ Customizing Reviewers for Your Codebase

### 1. Repository Configuration (`.ct-review.yaml`)

Define enabled personas, diff limits, and path filters at your repository root:

```yaml
# .ct-review.yaml
version: 3

personas:
  - id: security
  - id: database
    enabled: true
  - id: style
    enabled: false
  - id: tenancy
    name: "🏢 Multi-Tenant Isolation"
    charter: |
      Every query touching tenant data must include orgId. Flag any query missing this scope.

path_filters:
  - "dist/**"
  - "node_modules/**"
  - "package-lock.json"
```

### 2. Standalone Markdown Charters (`.ct-review/personas/*.md`)

Create longer, detailed persona charters in Markdown files under `.ct-review/personas/`:

```markdown
<!-- .ct-review/personas/tenancy.md -->
---
name: "🏢 Multi-Tenant Isolation Guardian"
---

Every database query that touches customer data must be scoped by `orgId`.

## What to flag:
- Repository methods accepting a raw `id` without a tenant bound.
- Raw SQL queries missing a `WHERE org_id = $n` clause.
- Cache keys omitting tenant prefixes.

## What to ignore:
- Admin routes under `src/admin/**`.
- Database migrations.
```

> [!IMPORTANT]
> **Base-Branch Authority**: Review Yeti loads configuration and charters from the pull request's **base branch** (e.g. `main`). Changes made to reviewer configurations within a PR take effect only **after** that PR is merged, ensuring review integrity.

---

## 🔐 GitHub App Setup (Recommended)

While basic reviews work with the built-in `GITHUB_TOKEN`, setting up a **GitHub App** is strongly recommended for:
- 🚀 **15,000 req/hr** independent rate limit.
- 🏷️ **Native GitHub Check Runs** API access (`checks:write`).
- 🔒 **Short-lived RS256 JWT `ghs_` tokens** (no long-lived personal access tokens).

👉 **Follow the step-by-step [GitHub App Setup Guide](docs/GITHUB_APP_SETUP.md)**.

---

## 💻 Running Locally via CLI & Git Hooks

Review Yeti includes a fast local CLI to catch vulnerabilities and lint issues before you commit:

```bash
# 1. 30-Second GitHub App onboarding wizard
npx review-yeti init

# 2. Evaluate staged changes locally in < 5 seconds
npx review-yeti pre-commit

# 3. Install as an automatic pre-commit git hook
npx review-yeti install-hook
```

👉 **Read the comprehensive [CLI Reference & Git Hook Guide](docs/CLI_REFERENCE.md)**.

---

## 📚 Documentation Index

- 🚀 **[Onboarding Guide](docs/ONBOARDING_GUIDE.md)** — 30-second setup, deployment patterns, and branch protection.
- 💬 **[Interactive PR Chat Guide](docs/INTERACTIVE_CHAT.md)** — Mentoring commands (`@review-yeti explain`, `fix`, `ignore`), webhook routing, and ephemeral tokens.
- 💻 **[CLI Reference & Git Hooks](docs/CLI_REFERENCE.md)** — Local pre-commit checks, 30-second GitHub App wizard, and hook installers.
- 🧠 **[Team Memory & Nit Suppression](docs/TEAM_MEMORY.md)** — SQLite WAL reflection, community personas (`uses:`), and non-bypassable security gates.
- ☸️ **[Helm 3 Operations Guide](docs/HELM_GUIDE.md)** — Comprehensive step-by-step Helm chart installation, values tuning, cloud guides (DOKS/EKS), upgrades, and rollbacks.
- 🛠️ **[Production Troubleshooting Guide](docs/TROUBLESHOOTING.md)** — Diagnosing HTTP 403/401/429 errors, worker timeouts, lease locks, and OOM issues.
- 📦 **[Examples Gallery](examples/README.md)** — Copy-pasteable GitHub Actions workflows, configuration profiles, and custom persona charters.
- 🔐 **[GitHub App Setup](docs/GITHUB_APP_SETUP.md)** — Step-by-step GitHub App registration and permissions matrix.
- ☸️ **[Kubernetes & DOKS Mode](docs/KUBERNETES_MODE.md)** — Offloading reviews to Kubernetes worker pods.
- 🏛️ **[Architecture Specification](docs/ARCHITECTURE.md)** — Pipeline design, arbitration engine, and trust boundaries.
- ⚙️ **[Configuration Reference](docs/CONFIGURATION_REFERENCE.md)** — Complete schema for `.ct-review.yaml`.
- 💻 **[Running Locally via CLI](docs/RUNNING_LOCALLY.md)** — Testing reviews and benchmarks in your terminal.
- 📦 **[Releasing Guide](docs/RELEASING.md)** — SemVer releases and Release Please workflows.

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
