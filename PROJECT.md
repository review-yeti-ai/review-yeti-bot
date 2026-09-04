# Project: Review Yeti Production Gallery, Helm 3 Chart, Docs & Git Landing

## Architecture
Review Yeti is an AI-powered code review platform supporting both GitHub Action execution and self-hosted Kubernetes cluster deployment.
- **Action Mode**: Runs as a GitHub Action (`action.yml`), invoking either local review pipelines (`review-pipeline.js`) or an asynchronous Kubernetes dispatch shim (`dispatch-doks-action.mjs`).
- **Cluster Mode**:
  - **Dispatcher (`action-dispatch`)**: Node.js microservice (`src/dispatchIndex.ts`) receiving admission webhooks on port 3000, validating OIDC tokens/signatures, and creating `PRReviewJob` custom resources.
  - **Operator (`k8s-operator`)**: Go controller (`Dockerfile.operator`) reconciling `PRReviewJob` (`review-yeti.ai/v1alpha2`) into ephemeral Kubernetes `batch/v1` Jobs.
  - **Worker (`review-yeti-worker`)**: Node.js container (`Dockerfile.worker`) running `node /app/dist/cli/runLiveReview.js` to perform multi-persona review, update GitHub Check Runs, and post PR comments.
- **Configuration & Personas**:
  - `.ct-review.yaml` (V3/V4 schema) with profile, quorum, personas, reviewer providers, and dials.
  - Drop-in `.coderabbit.yaml` compatibility translated natively via `translateCodeRabbitToV3()`.
  - Custom persona charters loaded from `.ct-review/personas/*.md` with YAML frontmatter.

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---------|-------------|-----------|--------|--------|
| 1 | `standalone-action.yml` | Single-repo standalone GitHub Action setup using OpenRouter/DeepSeek | M1 | Survey / R1 | DONE |
| 2 | `github-app-action.yml` | Action authenticated via GitHub App token for native Check Runs | M1 | Survey / R1 | DONE |
| 3 | `kubernetes-dispatch.yml` | Asynchronous dispatch shim (< 10s runner time) offloading to K8s | M1 | Survey / R1 | DONE |
| 4 | `reusable-hub.yml` | Central reusable workflow (`workflow_call` + `workflow_dispatch`) | M1 | Survey / R1 | DONE |
| 5 | `consumer-caller.yml` | Minimal 5-line caller workflow for consumer repositories | M1 | Survey / R1 | DONE |
| 6 | `incremental-review.yml` | Incremental review evaluating only repair deltas with artifact cache | M1 | Survey / R1 | DONE |
| 7 | `default.ct-review.yaml` | Standard balanced 5-persona setup conforming to Zod schema | M1 | Survey / R1 | DONE |
| 8 | `strict-security.ct-review.yaml` | Strict security policy blocking merges on any P1/P0 finding | M1 | Survey / R1 | DONE |
| 9 | `monorepo.ct-review.yaml` | Monorepo configuration with path-based diff filtering and persona scoping | M1 | Survey / R1 | DONE |
| 10 | `coderabbit-compat.yaml` | 1:1 drop-in CodeRabbit replacement schema | M1 | Survey / R1 | DONE |
| 11 | `tenancy.md` | Multi-tenant isolation guardian custom persona charter with frontmatter | M1 | Survey / R1 | DONE |
| 12 | `database-migrations.md` | SQL lock hazard and schema safety custom persona charter | M1 | Survey / R1 | DONE |
| 13 | `performance.md` | N+1 query and thread-blocking detection custom persona charter | M1 | Survey / R1 | DONE |
| 14 | `compliance.md` | PII, secrets, and audit trail enforcement custom persona charter | M1 | Survey / R1 | DONE |
| 15 | `examples/README.md` | Complete catalog index and usage guide for all examples | M1 | Survey / R1 | DONE |
| 16 | `Chart.yaml` | Helm 3 chart metadata (name: review-yeti, version: 1.0.0, appVersion: 1.28.0) | M2 | Survey / R2 | DONE |
| 17 | `values.yaml` | Richly commented production configuration (dispatcher, operator, worker, ingress, secrets) | M2 | Survey / R2 | DONE |
| 18 | `templates/` suite | Full Helm manifest templates: dispatcher, operator, service, ingress, rbac, worker-rbac, secrets, configmap, crd, helpers | M2 | Survey / R2 | DONE |
| 19 | `values-doks.yaml` | Cloud values pre-configured for DigitalOcean Kubernetes with DO LoadBalancer | M2 | Survey / R2 | DONE |
| 20 | `values-eks.yaml` | Cloud values pre-configured for AWS EKS with AWS ALB Controller | M2 | Survey / R2 | DONE |
| 21 | `values-local.yaml` | Local values pre-configured for Minikube / Kind / K3s with local Ollama | M2 | Survey / R2 | DONE |
| 22 | `docs/HELM_GUIDE.md` | Complete step-by-step install, upgrade, rollback, and config guide | M3 | Survey / R3 | DONE |
| 23 | `docs/TROUBLESHOOTING.md` | Production troubleshooting guide (HTTP 403, 401, 429, worker timeouts) | M3 | Survey / R3 | DONE |
| 24 | `README.md` updates | Root README updated to showcase Helm chart and examples gallery | M3 | Survey / R3 | DONE |
| 25 | Public Anonymity Audit | 0 'calltelemetry' occurrences across examples/, charts/, docs/ | M4 | Survey / R4 | DONE |
| 26 | Git Branch & Commit | Clean commits on feature branch with all verified deliverables | M4 | Survey / R4 | DONE |
| 27 | Git Push & PR Creation | Push to origin, open Pull Request on review-yeti-ai/review-yeti-bot | M4 | Survey / R4 | DONE |
| 28 | PR Merge to main | Merge Pull Request into main cleanly | M4 | Survey / R4 | DONE |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Examples Gallery | Features 1–15 (`examples/workflows/`, `examples/configs/`, `examples/personas/`, `examples/README.md`) | none | DONE |
| M2 | Helm 3 Chart & Cloud Values | Features 16–21 (`charts/review-yeti/`, `examples/k8s/`) | none | DONE |
| M3 | Operational Documentation | Features 22–24 (`docs/HELM_GUIDE.md`, `docs/TROUBLESHOOTING.md`, `README.md`) | M1, M2 | DONE |
| M4 | Anonymity Audit, Verification & Git Landing | Features 25–28 (Sanitization, full verification, git branch, commit, push, PR, merge) | M1, M2, M3 | DONE |

## Interface Contracts
### GitHub Actions ↔ Review Yeti Configuration
- Workflows must reference valid action inputs (`openrouter-api-key`, `model`, `execution-backend`, `github-token`, etc.).
- Configurations in `examples/configs/` must strictly validate against `ctReviewConfigV3Schema` or `codeRabbitRawSchema`.
- Personas in `examples/personas/` must have valid YAML frontmatter and non-empty markdown charter bodies.

### Helm Chart ↔ Cluster Runtime
- Dispatcher runs non-root (`runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`).
- Operator RBAC must be namespace-scoped (`Role` / `RoleBinding`), explicitly omitting `secrets` and `nodes`.
- CRD version is `v1alpha2` for `prreviewjobs.review-yeti.ai`.

## Code Layout
- `examples/workflows/`: Standalone, GitHub App, K8s dispatch, Reusable Hub, Consumer Caller, Incremental Review workflows.
- `examples/configs/`: Default, Strict Security, Monorepo, and CodeRabbit compatibility configs.
- `examples/personas/`: Tenancy, Database Migrations, Performance, and Compliance custom charters.
- `examples/k8s/`: Values for DOKS, EKS, and local Minikube/Kind.
- `examples/README.md`: Complete gallery documentation.
- `charts/review-yeti/`: Chart.yaml, values.yaml, templates/ suite.
- `docs/HELM_GUIDE.md`: Comprehensive operational guide.
- `docs/TROUBLESHOOTING.md`: Production troubleshooting and debugging guide.
- `README.md`: Root project README.
