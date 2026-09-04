# Review Yeti Examples Gallery

Welcome to the official Review Yeti examples catalog. This directory provides production-ready, copy-pasteable GitHub Actions workflows, configuration policies, and specialized reviewer persona charters for teams adopting Review Yeti.

---

## Directory Structure

```
examples/
├── workflows/                         # GitHub Actions workflow templates
│   ├── standalone-action.yml          # Single-repo standalone action using OpenRouter/DeepSeek
│   ├── github-app-action.yml          # Authenticated via GitHub App token for native Check Runs
│   ├── kubernetes-dispatch.yml        # Asynchronous dispatch shim (< 10s runner time) offloading to K8s
│   ├── reusable-hub.yml               # Central reusable workflow (workflow_call + workflow_dispatch)
│   ├── consumer-caller.yml            # Minimal 5-line caller workflow for consumer repositories
│   └── incremental-review.yml         # Incremental review evaluating only repair deltas
├── configs/                           # Repository configuration files (.ct-review.yaml)
│   ├── default.ct-review.yaml         # Balanced 5-persona baseline configuration
│   ├── strict-security.ct-review.yaml # Assertive policy blocking merges on any P1/P0 finding
│   ├── monorepo.ct-review.yaml        # Path-filtered configuration with scoped persona lanes
│   └── coderabbit-compat.yaml         # 1:1 drop-in CodeRabbit replacement schema
├── personas/                          # Custom domain reviewer charters (.ct-review/personas/*.md)
│   ├── tenancy.md                     # Multi-tenant isolation guardian charter
│   ├── database-migrations.md         # SQL lock hazard and schema safety charter
│   ├── performance.md                 # N+1 query and thread-blocking detection charter
│   └── compliance.md                  # PII, secrets, and audit trail enforcement charter
└── README.md                          # This catalog and usage guide
```

---

## ⚡ 60-Second Quick Start

Get automated AI code reviews running on your pull requests in 3 simple steps:

### 1. Configure Secrets
Add your OpenRouter API key as a repository secret:
- Go to your repository **Settings** → **Secrets and variables** → **Actions**.
- Create a new repository secret named `OPENROUTER_API_KEY` with your API token.

### 2. Add the Workflow
Create `.github/workflows/review-yeti.yml` in your default branch:

```yaml
name: Review Yeti
on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: review-yeti-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    name: AI Panel Code Review
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Run Review Yeti
        uses: review-yeti-ai/review-yeti-bot@v1
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          model: 'deepseek/deepseek-v4-flash-0731'
```

### 3. Open a Pull Request
Open or update any pull request in your repository. The Review Yeti panel will automatically analyze the diff and publish a structured review comment with findings and verdict!

---

## Workflows Catalog (`examples/workflows/`)

| Workflow | Use Case | Triggers | Runner Time | Required Permissions & Secrets |
| :--- | :--- | :--- | :--- | :--- |
| [`standalone-action.yml`](workflows/standalone-action.yml) | Standard single-repository setup executing reviews directly on GitHub runners. | `pull_request: [opened, synchronize, reopened]` | ~1–3 min | `contents: read`, `pull-requests: write`<br>`OPENROUTER_API_KEY` |
| [`github-app-action.yml`](workflows/github-app-action.yml) | Enterprise repositories requiring native Check Runs and distinct bot branding. | `pull_request: [opened, synchronize, reopened]` | ~1–3 min | `contents: read`, `pull-requests: write`, `checks: write`, `statuses: write`<br>`REVIEW_YETI_APP_ID`, `REVIEW_YETI_APP_PRIVATE_KEY`, `OPENROUTER_API_KEY` |
| [`kubernetes-dispatch.yml`](workflows/kubernetes-dispatch.yml) | High-volume enterprises offloading LLM execution to self-hosted Kubernetes clusters. | `pull_request: [opened, synchronize, reopened]` | **< 10 sec** | `id-token: write` (OIDC), `contents: read`, `pull-requests: read`<br>`REVIEW_YETI_DISPATCH_URL` variable |
| [`reusable-hub.yml`](workflows/reusable-hub.yml) | Centralized workflow for organizations to manage AI review policies and models centrally. | `workflow_call`, `workflow_dispatch` | ~1–3 min | Inherited or caller-defined permissions<br>`OPENROUTER_API_KEY`, optional `REVIEW_BOT_GITHUB_TOKEN` |
| [`consumer-caller.yml`](workflows/consumer-caller.yml) | Minimal 5-line caller workflow that connects repositories to an organization's central hub. | `pull_request` | N/A (calls hub) | `secrets: inherit` |
| [`incremental-review.yml`](workflows/incremental-review.yml) | Fast, cost-efficient reviews on PR updates by evaluating only repair deltas since the prior push. | `pull_request: [opened, synchronize]` | ~30–60 sec | `contents: read`, `pull-requests: write`, `actions: read`<br>`OPENROUTER_API_KEY` |

---

## Configuration Policies Catalog (`examples/configs/`)

Review Yeti supports both native `.ct-review.yaml` schemas (V3 and V4) and drop-in `.coderabbit.yaml` configurations. Configuration files must be committed to your repository's base branch (e.g. `main`).

| Configuration File | Schema Version | Profile / Stance | Active Personas | Target Environment & Use Case |
| :--- | :--- | :--- | :--- | :--- |
| [`default.ct-review.yaml`](configs/default.ct-review.yaml) | V3 | `balanced` | 5 Built-in (`security`, `performance`, `architecture`, `testing`, `dependencies`) | General web and cloud applications seeking comprehensive, balanced code quality reviews with a single OpenRouter provider. |
| [`strict-security.ct-review.yaml`](configs/strict-security.ct-review.yaml) | V3 | `assertive` | 3 Personas (`security`, `compliance`, `devops`) | Security-critical and regulated applications. Blocks merges on any P1 or P0 finding, requires 2-provider consensus quorum (Claude + DeepSeek), and fails closed. |
| [`monorepo.ct-review.yaml`](configs/monorepo.ct-review.yaml) | V4 | `balanced` | 4 Personas (`security`, `database`, `devops`, `performance`) | Large multi-service monorepos. Scopes personas and path instructions to designated directories (`apps/web/**`, `services/api/**`, `packages/database/**`). |
| [`coderabbit-compat.yaml`](configs/coderabbit-compat.yaml) | CodeRabbit Drop-in | `balanced` | Mapped dynamically via `translateCodeRabbitToV3` | Teams migrating from CodeRabbit. Copy directly as `.coderabbit.yaml` or `.ct-review.yaml` with zero syntax modifications. |

---

## Custom Personas Catalog (`examples/personas/`)

Custom personas allow you to define organization-specific review charters using standard Markdown files with YAML frontmatter. To activate them:
1. Copy the persona file into `.ct-review/personas/<id>.md` in your default branch.
2. Review Yeti automatically discovers all `.md` files in `.ct-review/personas/` and adds them to the review panel!

| Persona File | Persona Name | Key Review Areas | Severity Highlights |
| :--- | :--- | :--- | :--- |
| [`tenancy.md`](personas/tenancy.md) | 🏢 Multi-Tenant Isolation Guardian | Missing tenant/org filters in SQL/ORM queries, IDOR vulnerabilities in endpoints, unpartitioned cache keys (Redis/Memcached), and missing tenant context in asynchronous background jobs. | **P0**: Cross-tenant data leakage or unscoped mutations.<br>**P1**: Cache key collisions or context loss in workers. |
| [`database-migrations.md`](personas/database-migrations.md) | 🗄️ Database Migrations & Lock Hazard Guardian | Production table lock hazards (`ACCESS EXCLUSIVE`), non-concurrent index creation on existing tables, immediate column drops breaking running pods, and unbatched mass updates. | **P0**: Table locks on active production tables or breaking column drops.<br>**P1**: Non-concurrent indexes or unbatched updates. |
| [`performance.md`](personas/performance.md) | ⚡ Performance & Scalability Specialist | N+1 database queries in loops, blocking synchronous I/O (`fs.readFileSync`) on event loops, unbounded in-memory caches, unpaginated table hydration, and $O(N^2)$ algorithms. | **P0**: Event loop lockups, deadlocks, or guaranteed OOM leaks.<br>**P1**: N+1 queries or unbounded memory growth. |
| [`compliance.md`](personas/compliance.md) | 📋 PII, Secrets & Audit Trail Guardian | Plaintext PII in logs and telemetry, hardcoded credentials or API keys in source, missing audit records on administrative state mutations, and GDPR erasure bypasses. | **P0**: Committed secrets or unmasked PII (credit cards, SSNs).<br>**P1**: Missing administrative audit trail logs. |

---

## Security & Governance Model

Review Yeti enforces several core security invariants to ensure safe AI execution in production:

### 1. Trusted Base-Ref Configuration Loading
To prevent malicious pull requests from tampering with review instructions or disabling security personas, Review Yeti **never loads configuration from the PR's head branch**. All configuration files (`.ct-review.yaml`, `.coderabbit.yaml`) and custom persona charters (`.ct-review/personas/*.md`) are fetched strictly from the target base commit (`${{ github.event.pull_request.base.sha }}`).

### 2. GitHub App vs. Default Repository Token
- **Default `GITHUB_TOKEN`**: Sufficient for standalone reviews. Comments are published under the `github-actions[bot]` identity.
- **GitHub App Token**: Recommended for enterprise teams. Enables native Check Runs, distinct bot avatar branding, organization-wide secret management, and avoids triggering secondary workflow loops.

### 3. Asynchronous Kubernetes Dispatch Shim
For organizations concerned about GitHub Actions runner billing or runner concurrency limits:
- The `kubernetes-dispatch.yml` workflow exchanges a short-lived GitHub Actions OIDC token with the Review Yeti Kubernetes Dispatcher.
- The dispatch shim exits in **under 10 seconds**, setting the GitHub PR check run to `PENDING`.
- Self-hosted ephemeral Kubernetes worker pods execute the LLM panel asynchronously and publish results directly back to GitHub via GitHub App credentials.
