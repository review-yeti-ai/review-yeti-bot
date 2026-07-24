# Product Requirement Document (PRD): `ct-review-bot`

**Product Name**: `ct-review-bot`  
**Version**: 1.0.0  
**Status**: Production Standard / Hardened  
**Target Environment**: Kubernetes (DigitalOcean Kubernetes / DOKS, EKS, GKE) / Docker  

---

## 1. Executive Summary & Objective

`ct-review-bot` is an enterprise-grade, quorum-based automated GitHub Code Review Bot service. Designed to replace single-model automated review tools, `ct-review-bot` synthesizes multi-persona expert panel analysis (Security, Architecture, Performance, Quality) with deterministic organizational governance (Ticket Enforcement, Operational Constitutions, and Incremental Diff Tracking).

By combining multi-provider failover routing (OmniRoute), encrypted credential storage, and line-shift-aware state persistence, `ct-review-bot` delivers high-precision, low-noise code reviews directly within GitHub Pull Request workflows.

---

## 2. System Architecture & Core Data Flow

```
                               ┌────────────────────────────────────────┐
                               │       GitHub Webhook Event Payload     │
                               └───────────────────┬────────────────────┘
                                                   │
                                                   ▼
                               ┌────────────────────────────────────────┐
                               │ 0. HMAC Signature Verification (401)  │
                               └───────────────────┬────────────────────┘
                                                   │ (Valid HMAC)
                                                   ▼
                               ┌────────────────────────────────────────┐
                               │ 1. Dual Format Config Engine (F1)     │
                               └───────────────────┬────────────────────┘
                                                   │
                                                   ▼
                               ┌────────────────────────────────────────┐
                               │ 2. Ticket Linkage Validator (F2)      │
                               └─────────┬──────────────────┬───────────┘
                                         │ (Invalid Strict) │ (Valid / Advisory)
                                         ▼                  ▼
                              [REQUEST_CHANGES]  ┌───────────────────────┐
                              (Short-Circuit)    │ 3. Constitution (F3)  │
                                                 └───────┬───────────┬───┘
                                       (Non-Compliant)   │           │ (Compliant)
                                               ▼         │           ▼
                                    [REQUEST_CHANGES] ───┘   ┌─────────────────────────┐
                                    (Short-Circuit)          │ 4. Diff Delta Index (F4)│
                                                             └───────────┬─────────────┘
                                                                         │ (Modified Hunks)
                                                                         ▼
                                                             ┌─────────────────────────┐
                                                             │ 5. OmniRoute Router (F5)│
                                                             └───────────┬─────────────┘
                                                                         │
                                                                         ▼
                                                             ┌─────────────────────────┐
                                                             │ 6. Quorum Panel (F6)    │
                                                             │ [Sec, Arch, Perf, Qual] │
                                                             └───────────┬─────────────┘
                                                                         │ (Deduplicated Findings)
                                                                         ▼
                                                             ┌─────────────────────────┐
                                                             │ 7. GitHub Publisher (F7)│
                                                             │ [Inline Comments & PR]  │
                                                             └─────────────────────────┘
```

---

## 3. Feature Requirements (F1 - F7)

### F1: Dual Format Config Engine
- **Requirement**: Support repository-level configuration in primary `.ct-review.yaml` format and legacy `.coderabbit.yaml` format.
- **Specification**:
  - Automatically detect `.ct-review.yaml`; if absent, translate `.coderabbit.yaml` profiles (`chill` -> `low` effort, `assertive` -> `high` effort) to `CtReviewConfig`.
  - Perform recursive deep merging with `DEFAULT_ORG_CONFIG`.
  - Validate merged configuration using Zod schema (`ctReviewConfigSchema`).
  - Reject top-level YAML arrays by throwing `ConfigValidationError`.
  - Enforce non-empty provider arrays (`ticketEnforcement.providers.min(1)`).

### F2: Multi-Provider Ticket Linkage Validator
- **Requirement**: Validate that incoming PRs link to valid issue tickets before proceeding with deep code analysis.
- **Specification**:
  - Support ticket providers: Linear (`queryLinearTicket`), Jira (`queryJiraTicket`), and GitHub Issues (`queryGithubIssue`).
  - Use parameterized GraphQL queries for Linear (`query($id: String!)`) to prevent GraphQL injection attacks.
  - Apply `encodeURIComponent` on all REST URI path segments (`key`, `owner`, `repo`, `issueNum`).
  - Ignore non-ticket technical tokens matching prefixes (`UTF-8`, `SHA-256`, `ISO-8601`, `COVID-19`, `LOG-1`, `HTTP-2`, etc.).
  - Operate in `strict` mode (short-circuits PR to `REQUEST_CHANGES` on missing tickets) or `advisory` mode.

### F3: Operational Constitution Engine
- **Requirement**: Enforce repository markdown constitution rules (`.github/constitution.md`).
- **Specification**:
  - Parse markdown headings at single (`#`), double (`##`), or triple (`###`) hash levels into rule categories (`forbidden_pattern`, `directive`, `mandatory_guideline`).
  - Evaluate PR title directives including conventional commits format with breaking change syntax (`feat(scope)!: ...`).
  - Evaluate non-regex forbidden rules on a line-by-line basis to prevent multi-word keyword false positives across distant lines.
  - Support regex pattern extraction from markdown backticks (e.g. `` `/eval\s*\(/g` ``).

### F4: Incremental Diff Delta Indexing
- **Requirement**: Maintain PR commit state to skip redundant LLM analysis on unchanged code hunks and prevent duplicate findings.
- **Specification**:
  - Primary storage: SQLite (`better-sqlite3`) with schema enforcing `UNIQUE(pr_state_id, fingerprint_hash)`.
  - Automatic fallback to atomic JSON file storage (`JsonFileDiffStateStorage`) when native SQLite binary is unavailable.
  - Calculate SHA-256 hunk fingerprint hashes (`computeHunkHash`).
  - Track line shifts (`startLine` / `endLine` offsets) when lines are inserted or deleted above untouched findings, preventing false `RESOLVED` status transitions.

### F5: Multi-Provider OmniRoute Router & Token Management
- **Requirement**: Manage multi-provider LLM API calls with zero-downtime failover, circuit breaking, and encrypted credential storage.
- **Specification**:
  - Support providers: OpenAI, Anthropic Claude, Google Gemini, DeepSeek.
  - Support load balancing strategies: `priority_fallback`, `round_robin`, `least_loaded`.
  - Circuit Breaker: Trip on HTTP 429 (Rate Limit), HTTP 401/403 (Auth Error), and consecutive HTTP 5xx errors.
  - Token Management: AES-256-GCM authenticated secret encryption using PBKDF2/SHA-256 master key derivation.
  - OAuth Token Refresh: Preemptive refresh window with single-flight mutex coalescing concurrent refresh calls.
  - Token Usage Tracking: Track prompt, completion, and reasoning tokens per persona and provider.

### F6: Multi-Persona Quorum Panel
- **Requirement**: Conduct multi-perspective code reviews using specialized expert personas.
- **Specification**:
  - Four Core Personas: Security (`🛡️`), Architecture (`🏗️`), Performance (`⚡`), Quality (`🎨`).
  - Effort Scaling: Map `low`, `medium`, `high`, `reasoning` effort levels to token budgets, temperature, and provider reasoning parameters (OpenAI `reasoning_effort`, Anthropic `thinking`).
  - Deduplication & Tie-Breaking: Deduplicate overlapping findings across personas using `SEVERITY_PRECEDENCE` (`critical` > `major` > `minor` > `nit`) and `PERSONA_PRECEDENCE` (`security` > `architecture` > `performance` > `quality`).
  - Co-Sponsoring Personas: Preserve secondary persona endorsements when deduplicating.

### F7: Native Webhook Server & GitHub Integration
- **Requirement**: Ingest GitHub webhooks, verify signatures, and publish review comments to GitHub API.
- **Specification**:
  - Verify HMAC `X-Hub-Signature-256` headers using timing-safe comparison on raw request body buffer.
  - Handle ping, `pull_request` (`opened`, `synchronize`, `reopened`), and `issue_comment` (`@ct-review review`) events.
  - Publish inline code review comments (`/comments`) and top-level PR review verdicts (`/reviews`) (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`).

---

## 4. Non-Functional Requirements (NFRs)

| ID | Category | Requirement Description | Target Metric |
|---|---|---|---|
| NFR-1 | **Security** | Secret storage encryption & signature auth | AES-256-GCM, 100% HMAC verified webhooks |
| NFR-2 | **Performance** | Webhook processing latency | < 3s for ticket/constitution gating; < 15s full review |
| NFR-3 | **Reliability** | Provider failover recovery | < 500ms failover switch to secondary LLM provider |
| NFR-4 | **Availability** | Service uptime | 99.9% service availability |
| NFR-5 | **Scalability** | Event queue capacity | Support > 500 queued webhook jobs with FIFO eviction |

---

## 5. Acceptance Matrix

| Requirement | Test Suite Verification Path | Status |
|---|---|---|
| F1: Config Engine | `tests/unit/config.test.ts`, `tests/e2e/tier1/config.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
| F2: Ticket Validator | `tests/unit/ticket.test.ts`, `tests/e2e/tier1/ticket.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
| F3: Constitution Engine | `tests/unit/constitution.test.ts`, `tests/e2e/tier1/constitution.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
| F4: Diff State Indexing | `tests/unit/diffState.test.ts`, `tests/e2e/tier1/diffState.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
| F5: OmniRoute Router | `tests/unit/m2_router.test.ts`, `tests/e2e/tier1/omniRoute.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
| F6: Quorum Panel | `tests/unit/consensus.test.ts`, `tests/e2e/tier1/quorum.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
| F7: Webhook Server | `tests/unit/app.test.ts`, `tests/e2e/tier1/webhook.test.ts`, `tests/e2e/tier5/adversarialHardening.test.ts` | **PASS** |
