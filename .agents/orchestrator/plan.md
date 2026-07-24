# Orchestrator Execution Plan: ct-review-bot

## Objective
Lead the end-to-end architecture, implementation, testing, containerization, and DOKS Kubernetes deployment for `ct-review-bot`, satisfying all requirements (R1–R5) and acceptance criteria.

## Strategy & Topology
We execute using the **Project Pattern** with Dual Tracks:
- **E2E Testing Track**: Autonomous test suite design (Tiers 1-4) published via `TEST_READY.md`.
- **Implementation Track**: Modular sub-orchestrated implementation of Milestones M1 through M6.

Each sub-orchestrated milestone follows the strict quality loop:
1. **Explorer**: Technical design and approach formulation.
2. **Worker**: Genuine implementation, unit tests, and build/test execution.
3. **Reviewer**: Code review, robustness check, requirement validation.
4. **Challenger**: Empirical correctness verification and stress testing.
5. **Forensic Auditor**: Binary integrity audit (zero tolerance for cheating/hardcoding).

## Milestone Roadmap

### Track 1: E2E Testing Track (`.agents/sub_orch_e2e`)
- Design requirement-driven opaque-box test framework.
- Tier 1: Feature Coverage (≥5 tests per feature).
- Tier 2: Boundary & Corner Cases (≥5 tests per feature).
- Tier 3: Cross-Feature Combinations (Pairwise coverage).
- Tier 4: Real-World Application Scenarios (≥5 full workflows).
- Publish `TEST_READY.md` once test harness and test cases are ready.

### Track 2: Implementation Track
- **M1: Core Foundations, Config & State Persistence (`.agents/sub_orch_m1`)**
  - Node.js + TypeScript scaffold with `tsconfig.json`, `package.json`, build scripts.
  - Hierarchical YAML configuration loader (`.ct-review.yaml` + org master defaults).
  - Ticket linkage parser & validator (Linear `PROJ-123`, Jira `KEY-456`, GitHub `#789`).
  - Constitution guidelines engine (`constitution.md`).
  - Diff state persistence manager (SHA-256 diff delta tracking to avoid re-flagging resolved nits across SHAs).

- **M2: OmniRoute Multi-LLM Router & Token Management (`.agents/sub_orch_m2`)**
  - OmniRoute adapter supporting multi-provider API keys and usage tiers.
  - Automatic token refresh & secret storage integration.
  - Model effort management (low/medium/high/reasoning).
  - Provider failover pool & dynamic routing fallback.

- **M3: Quorum Review Panel & Persona Engine (`.agents/sub_orch_m3`)**
  - Fan-out / fan-in multi-agent review orchestration.
  - Persona reviewers (Security, Architecture, Performance, Code Quality/Nits).
  - Consensus aggregation engine & decision calculator (APPROVE, REQUEST_CHANGES, COMMENT).
  - Incremental diff filtering integration (evaluates only new/modified code deltas).

- **M4: GitHub App & Webhook Receiver Event Loop (`.agents/sub_orch_m4`)**
  - Express webhook server with `X-Hub-Signature-256` HMAC validation.
  - Handles PR webhook events (`opened`, `synchronize`, `reopened`, `@ct-review review` commands).
  - Octokit client for publishing inline diff comments on unresolved threads and formatted top-level summary review comments.

- **M5: Containerization & DigitalOcean K8s Deployment (`.agents/sub_orch_m5`)**
  - Production multi-stage Dockerfile & `.dockerignore`.
  - Kubernetes manifests (`k8s/deployment.yaml`, `k8s/service.yaml`, `k8s/configmap.yaml`, `k8s/secret.yaml`, `k8s/ingress.yaml`).
  - DOKS cluster deployment script and live health check verification.

- **M6: Final Integration, Tier 5 Hardening & Docs (`.agents/sub_orch_m6`)**
  - E2E Test Execution against implementation (100% pass requirement).
  - Tier 5 White-Box Adversarial Coverage Hardening (Challenger-driven gap analysis).
  - Complete documentation in `docs/` (`PRD.md`, `VISION.md`, `ROADMAP.md`, `OPERATOR_GUIDE.md`, `ARCHITECTURE.md`).

## Verification Strategy
- Every worker must execute build & test commands and include verbatim output in their handoff report.
- Reviewer + Challenger empirical verification.
- Mandatory Forensic Auditor check with clean verdict.
- 100% pass on E2E test suite prior to completion claim.
