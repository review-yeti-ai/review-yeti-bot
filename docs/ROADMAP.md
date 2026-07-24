# Product Roadmap: `ct-review-bot`

**Current Release**: v1.0.0 (Production / Hardened Standard)  
**Time Horizon**: 2026 - 2027  

---

## 1. Roadmap Overview Matrix

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  v1.0.0 (Current Standard)                                                             │
│  - Dual Format Config Engine & Zod Validation                                           │
│  - Multi-Provider Ticket Linkage (Linear, Jira, GitHub)                                │
│  - Operational Constitution Engine & Conventional Commits                              │
│  - Incremental Diff Delta Indexing (SQLite + JSON storage)                             │
│  - Multi-Provider OmniRoute Router (Circuit Breakers & Token Management)               │
│  - 4-Persona Quorum Panel (Security, Architecture, Performance, Quality)               │
│  - Native GitHub Webhook Server & Comment Publisher                                    │
│  - DOKS / Kubernetes Helm Deployment & Monitoring                                      │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  v1.5.0 (Near-Term Platform Enhancements — Q4 2026)                                    │
│  - Custom Persona Prompt Builder & Dynamic Role Injection                               │
│  - Multi-Repository Constitution Inheritance (Org-wide Governance)                    │
│  - Real-Time WebSocket Telemetry Dashboard                                             │
│  - Distributed Redis Diff State Caching                                                │
│  - GitLab & Bitbucket Server Webhook Adapters                                          │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  v2.0.0 (Long-Term Enterprise AI Engine — Q2 2027)                                     │
│  - AST-Aware Cross-File Dependency Graph Analysis                                      │
│  - Local On-Premises Model Serving (vLLM / Ollama Gateway)                             │
│  - Auto-Fix PR Branch Generation (`git push` Automated Fix Patches)                    │
│  - ML-Based Historical False Positive Suppression Filter                               │
│  - Enterprise SAML / OIDC Role-Based Access Control (RBAC) Admin UI                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Release Detail Specifications

### Release v1.0.0 (Current Production Standard)
- **Status**: Completed & Verified
- **Key Milestones**:
  - **Phase 1 (Foundations & Core Engines)**: Config Engine, Ticket Validator, Constitution Engine, Diff State Persistence.
  - **Phase 2 (Router & Quorum Engines)**: OmniRoute Router, Token Manager, Quorum Panel, Persona Deduplication.
  - **Phase 3 (Webhook Server & Integration)**: GitHub Webhook Server, Signature Authentication, Comment Publisher.
  - **Phase 4 (Deployment & Hardening)**: DOKS Kubernetes Helm Manifests, Prometheus Metrics, Tier 1-5 Adversarial Test Suites.

### Release v1.5.0 (Near-Term Platform Enhancements)
- **Target Target**: Q4 2026
- **Focus Areas**: Extensibility, Performance at Scale, Multi-Platform Support
- **Features**:
  1. **Custom Persona Builder**: Allow organizations to define custom personas (e.g. `compliance`, `accessibility`, `localization`) via YAML configuration.
  2. **Org-Wide Constitution Inheritance**: Inherit global organizational constitutions from `.github-private/constitution.md` with repository-level overrides.
  3. **Distributed Redis Storage**: Add Redis adapter for `IDiffStateStorage` to support multi-pod horizontal autoscaling in Kubernetes clusters.
  4. **Multi-Git Provider Support**: Support GitLab Merge Requests and Bitbucket Pull Requests alongside GitHub Webhooks.
  5. **Telemetry Dashboard**: Web-based operator UI displaying real-time router pool health, token consumption metrics, and PR review throughput.

### Release v2.0.0 (Long-Term Enterprise AI Engine)
- **Target Target**: Q2 2027
- **Focus Areas**: Deep AST Code Understanding, Self-Healing Code, Local Model Support
- **Features**:
  1. **Cross-File AST Dependency Graphing**: Parse TypeScript/Python/Go ASTs across the repository to detect breaking API contract changes in un-edited files.
  2. **Auto-Fix Branch Generation**: Automatically create fix branches (`ct-review/autofix-pr-123`) containing suggestions applied as commit patches.
  3. **Local vLLM / Ollama Gateway Integration**: Native support for air-gapped local LLM inference models (DeepSeek-Coder, CodeLlama) via local GPU clusters.
  4. **Adaptive Noise Filtering**: Machine learning filter trained on developer feedback (accepted vs dismissed comments) to auto-suppress low-value nit warnings.

---

## 3. Maintenance & Technical Debt Objectives

| Quarter | Objective | Description | Target Metric |
|---|---|---|---|
| Q3 2026 | Native SQLite Binary Compilation | Update `better-sqlite3` rebuild scripts for Node 22+ ABI compatibility | 0 fallback warnings in logs |
| Q4 2026 | OpenTelemetry Integration | Instrument pipeline stages with OpenTelemetry distributed tracing | 100% trace coverage |
| Q1 2027 | Memory Optimization | Stream large diff hunks using Node.js Transform streams | < 256MB pod memory footprint |
