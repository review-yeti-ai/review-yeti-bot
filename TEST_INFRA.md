# E2E Test Infra: Review Yeti Production Gallery, Helm 3 Chart & Operational Docs

## Test Philosophy
- Opaque-box, specification-driven E2E verification of the Review Yeti production gallery (`examples/`), official Helm 3 chart (`charts/review-yeti/`), operational documentation guides (`docs/`), and public repository anonymity.
- Dual-Track Testing Methodology:
  - **Tier 1: Feature Coverage & Structural Integrity** (Validating file existence, YAML syntax, required triggers, permissions, step structures, chart templates, and documentation sections).
  - **Tier 2: Boundary & Corner Cases** (Strict Zod schema validation, negative/adversarial schema tests, persona frontmatter validation, malformed YAML handling, and `helm lint` with 0 errors/0 warnings).
  - **Tier 3: Cross-Feature Combinations & Multi-Cloud Matrix** (Validating `helm template` manifest generation across base `values.yaml`, `values-doks.yaml`, `values-eks.yaml`, and `values-local.yaml`, checking `runAsNonRoot: true`, namespace-scoped RBAC omitting secrets/nodes, Ingress rules, and secret references).
  - **Tier 4: Real-World Scenarios, Catalog Integrity & Anonymity** (Complete `examples/README.md` catalog cross-reference integrity, code block syntax validation in operational guides, and strict public anonymity audit: `grep -rn "calltelemetry" examples/ charts/ docs/` == 0 matches).

---

## Feature Inventory & Coverage Mapping

| # | Feature | Source (Requirement) | Tier 1 (Coverage) | Tier 2 (Boundary/Edge) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|----------------------|:-----------------:|:----------------------:|:----------------------:|:-------------------:|
| 1 | `standalone-action.yml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Missing inputs handling | Action trigger matrix | Catalog cross-ref |
| 2 | `github-app-action.yml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Token creation params | App permissions check | Catalog cross-ref |
| 3 | `kubernetes-dispatch.yml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | OIDC id-token perm | Backend shim contract | Catalog cross-ref |
| 4 | `reusable-hub.yml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | `workflow_call` inputs | Org caller compatibility | Catalog cross-ref |
| 5 | `consumer-caller.yml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | 5-line minimalism | Caller -> Hub linkage | Catalog cross-ref |
| 6 | `incremental-review.yml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Cache & delta limits | Full diff fallback | Catalog cross-ref |
| 7 | `default.ct-review.yaml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Zod V3 schema parse | Quorum & provider match | Catalog cross-ref |
| 8 | `strict-security.ct-review.yaml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Assertive profile & P1 | Quorum & rules check | Catalog cross-ref |
| 9 | `monorepo.ct-review.yaml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Path filters & scopes | Persona lane filtering | Catalog cross-ref |
| 10 | `coderabbit-compat.yaml` | ORIGINAL_REQUEST §R1 | Structure & Syntax | CodeRabbit Zod parse | Native V3 translation | Catalog cross-ref |
| 11 | `tenancy.md` (Persona) | ORIGINAL_REQUEST §R1 | Structure & Syntax | Frontmatter YAML parse | Roster ID uniqueness | Charter body integrity |
| 12 | `database-migrations.md` | ORIGINAL_REQUEST §R1 | Structure & Syntax | Frontmatter YAML parse | Roster ID uniqueness | Charter body integrity |
| 13 | `performance.md` (Persona) | ORIGINAL_REQUEST §R1 | Structure & Syntax | Frontmatter YAML parse | Roster ID uniqueness | Charter body integrity |
| 14 | `compliance.md` (Persona) | ORIGINAL_REQUEST §R1 | Structure & Syntax | Frontmatter YAML parse | Roster ID uniqueness | Charter body integrity |
| 15 | `examples/README.md` | ORIGINAL_REQUEST §R1 | Catalog existence | Section headers completeness | Markdown link validation | 100% gallery index match |
| 16 | `Chart.yaml` | ORIGINAL_REQUEST §R2 | Helm v2 apiVersion | Semantic version checks | AppVersion alignment | Linting & packaging |
| 17 | `values.yaml` | ORIGINAL_REQUEST §R2 | Structure & Comments | Resource limits & probes | SecurityContext defaults | Production baseline |
| 18 | `templates/` Manifest Suite | ORIGINAL_REQUEST §R2 | All 9 templates + helper | Template syntax & indentation | Manifest generation | Multi-replica & probes |
| 19 | `values-doks.yaml` | ORIGINAL_REQUEST §R2 | Structure & Syntax | DO Block Storage CSI | Ingress + LoadBalancer | Cloud template render |
| 20 | `values-eks.yaml` | ORIGINAL_REQUEST §R2 | Structure & Syntax | AWS EBS gp3 & IRSA | ALB Controller Ingress | Cloud template render |
| 21 | `values-local.yaml` | ORIGINAL_REQUEST §R2 | Structure & Syntax | Ollama local endpoint | NodePort & min-resource | Cloud template render |
| 22 | `docs/HELM_GUIDE.md` | ORIGINAL_REQUEST §R3 | Structure & Sections | Install/upgrade/rollback | Code snippet validation | Production runbook |
| 23 | `docs/TROUBLESHOOTING.md` | ORIGINAL_REQUEST §R3 | Structure & Error codes | HTTP 403, 401, 429, timeouts | Remediation accuracy | Production runbook |
| 24 | Root `README.md` Updates | ORIGINAL_REQUEST §R3 | Chart & Examples links | Badge and quickstart | Architecture flow | Discovery verification |
| 25 | Public Anonymity Audit | ORIGINAL_REQUEST §R4 | Grep audit execution | Zero internal identifiers | Multi-directory boundary | 0 'calltelemetry' matches |
| 26 | Git Branch & Commit | ORIGINAL_REQUEST §R4 | Branch naming | Commit message format | Clean tree verification | Git status inspection |
| 27 | Git Push & PR Creation | ORIGINAL_REQUEST §R4 | Remote origin tracking | PR title and description | Reviewer assignment | GitHub CLI verification |
| 28 | PR Merge to main | ORIGINAL_REQUEST §R4 | Merge strategy | Squash/rebase check | Main branch verification | Git log inspection |

---

## Test Architecture

### 1. Test Execution Suites
- **Vitest Suite**: `tests/e2e/reviewYetiE2E.test.ts`
  - Integrated into project `npm run test:e2e` (`vitest run tests/e2e`).
  - Implements all 4 tiers with describe blocks:
    - `Tier 1: Feature Coverage & Structural Integrity`
    - `Tier 2: Boundary & Corner Cases (Zod Schemas, Adversarial Inputs & Helm Lint)`
    - `Tier 3: Cross-Feature Combinations & Multi-Cloud Helm Matrix`
    - `Tier 4: Real-World Scenarios, Gallery Catalog Integrity & Anonymity Audit`
- **Standalone E2E Runner**: `tests/e2e/run-e2e.mjs`
  - Executable runner (`node tests/e2e/run-e2e.mjs`).
  - Zero-overhead direct node execution with styled ANSI terminal output, detailed failure diagnosis, and comprehensive pass/fail matrix.

### 2. Validation Engines
- **YAML Engine**: `js-yaml` (`load`, `loadAll`) for AST verification of GitHub Actions workflows, configuration files, and rendered Kubernetes manifests.
- **Schema Engine**: `zod` importing `ctReviewConfigV3Schema`, `ctReviewConfigV4Schema`, and `codeRabbitRawSchema` directly from `src/config/`.
- **Helm Engine**: Native `helm lint` and `helm template` invocations with `--values` parameter matrix.
- **Anonymity Engine**: Recursive regex inspection auditing every text token against prohibited proprietary words (`calltelemetry`).

---

## Coverage Thresholds
- **Tier 1 (Feature Coverage)**: 100% of all required files (6 workflows, 4 configs, 4 personas, 1 examples README, 1 Chart.yaml, 1 values.yaml, 3 cloud values, 9 Helm templates, 2 operational docs) exist, parse cleanly as YAML/Markdown, and contain required top-level attributes.
- **Tier 2 (Boundary & Corner Cases)**: 100% schema conformance under strict Zod validation; rejection of invalid/adversarial configurations; `helm lint charts/review-yeti` passes with 0 errors and 0 warnings.
- **Tier 3 (Cross-Feature Combinations)**: 100% valid YAML manifests rendered by `helm template` across base `values.yaml`, `values-doks.yaml`, `values-eks.yaml`, and `values-local.yaml`; strict enforcement of `runAsNonRoot: true`, namespace-scoped RBAC omitting secrets/nodes, Ingress TLS rules, and secret override handling.
- **Tier 4 (Real-World Scenarios)**: 100% of links in `examples/README.md` point to real files; 100% of code snippets in operational docs are syntactically valid; exact 0 matches for `calltelemetry` across `examples/`, `charts/`, and `docs/`.
