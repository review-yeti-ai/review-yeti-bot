# Complete Technical Architecture: `ct-review-bot`

**System Version**: 1.0.0 (Production Standard)  
**Architectural Paradigm**: Event-Driven Microservice / Quorum Synthesis Pipeline  
**Runtime**: Node.js 20+ (TypeScript / Express / Vitest)  

---

## 1. High-Level Architecture Overview

```
                                  ┌──────────────────────────────────────────────┐
                                  │           GitHub Webhook Ingress             │
                                  └──────────────────────┬───────────────────────┘
                                                         │ (HTTP POST /webhook)
                                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       `ct-review-bot` Core Service                                      │
│                                                                                                         │
│  ┌───────────────────────┐      ┌───────────────────────┐      ┌─────────────────────────────────────┐  │
│  │ 1. Webhook Server     │ ───► │ 2. Ticket Validator   │ ───► │ 3. Constitution Engine              │  │
│  │ (HMAC Signature Auth) │      │ (Linear/Jira/GitHub)  │      │ (Markdown Rules & PR Directives)    │  │
│  └───────────────────────┘      └───────────────────────┘      └──────────────────┬──────────────────┘  │
│                                                                                   │                     │
│  ┌───────────────────────┐      ┌───────────────────────┐                         │                     │
│  │ 6. GitHub Publisher   │ ◄─── │ 5. Quorum Panel       │ ◄───────────────────────┘                     │
│  │ (Comments & Verdicts) │      │ (Sec/Arch/Perf/Qual)  │ (Valid Tickets & Constitution)                  │
│  └───────────────────────┘      └───────────▲───────────┘                                               │
│                                             │                                                           │
│                                             ▼                                                           │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 4. Persistence & Router Core                                                                      │  │
│  │  - DiffStateManager (Hunk Fingerprinting & Line Shift Tracking)                                   │  │
│  │  - IDiffStateStorage (SQLite database + JSON File storage fallback)                               │  │
│  │  - ProviderPool (Circuit Breakers & Multi-Provider Failover)                                      │  │
│  │  - TokenManager (AES-256-GCM Secret Store & Single-Flight Token Refresh Mutex)                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼ (OmniRoute LLM Protocol)
                               ┌─────────────────────────────┐
                               │   OmniRoute Gateway / LLMs  │
                               │  OpenAI / Claude / Gemini   │
                               └─────────────────────────────┘
```

---

## 2. Sequence Diagram: Full Webhook Review Pipeline

```
GitHub API            WebhookServer       TicketValidator     ConstitutionEngine     DiffStateManager      QuorumPanel        CommentPublisher
    │                       │                    │                    │                     │                   │                     │
    │── HTTP POST /webhook ─►                    │                    │                     │                   │                     │
    │                       │── Verify HMAC ────►│                    │                     │                   │                     │
    │                       │   Signature (401)  │                    │                     │                   │                     │
    │                       │                    │                    │                     │                   │                     │
    │                       │── Validate Ticket ─►                    │                     │                   │                     │
    │                       │   Linkage (F2)     │                    │                     │                   │                     │
    │                       │                    │                    │                     │                   │                     │
    │                       │─────── (If invalid strict) Short-Circuit to REQUEST_CHANGES ───────────────────►│                     │
    │                       │                    │                    │                     │                   │── Publish Review ──►│
    │                       │                    │                    │                     │                   │   (REQUEST_CHANGES) │
    │                       │                    │                    │                     │                   │                     │
    │                       │── Evaluate Constitution Rules (F3) ────►│                     │                   │                     │
    │                       │                    │                    │                     │                   │                     │
    │                       │─────── (If non-compliant) Short-Circuit to REQUEST_CHANGES ────────────────────►│                     │
    │                       │                    │                    │                     │                   │── Publish Review ──►│
    │                       │                    │                    │                     │                   │   (REQUEST_CHANGES) │
    │                       │                    │                    │                     │                   │                     │
    │                       │── Compute Hunk Delta (F4) ───────────────────────────────────►│                   │                     │
    │                       │   & Line Shift Offsets                                        │                   │                     │
    │                       │                                                               │                   │                     │
    │                       │── Execute Parallel Quorum Panel (F6) ────────────────────────────────────────────►│                     │
    │                       │   (Security, Architecture, Performance, Quality via OmniRoute)                │                     │
    │                       │                                                                               │                     │
    │                       │── Aggregate & Deduplicate Findings ───────────────────────────────────────────►│                     │
    │                       │                                                                               │                     │
    │                       │── Update Tracked Findings & States ──────────────────────────►│                   │                     │
    │                       │                                                               │                   │                     │
    │                       │── Publish Review Comments & Verdict (F7) ──────────────────────────────────────────────────────────────►│
    │                       │                                                                                                             │
```

---

## 3. Quorum Fan-Out / Fan-In Engine Architecture

The Quorum Engine (`src/quorum/`) executes parallel expert panel evaluations:

```
                               ┌────────────────────────────────────────┐
                               │           PR Hunks to Review           │
                               └───────────────────┬────────────────────┘
                                                   │
                                                   ▼
                               ┌────────────────────────────────────────┐
                               │           Quorum Fan-Out Router        │
                               └──────┬─────────┬─────────┬──────────┬──┘
                                      │         │         │          │
                 ┌────────────────────┘         │         │          └────────────────────┐
                 ▼                              ▼         ▼                               ▼
    ┌────────────────────────┐      ┌──────────────┐   ┌──────────────┐      ┌────────────────────────┐
    │ 🛡️ Security Persona    │      │ 🏗️ Arch      │   │ ⚡ Perf      │      │ 🎨 Quality Persona     │
    │ (Vulnerabilities, OWASP│      │ (Design,     │   │ (Latency,    │      │ (Maintainability,      │
    │  Secrets, Injection)   │      │  Patterns)   │   │  Complexity) │      │  Style, Testing)       │
    └────────────┬───────────┘      └───────┬──────┘   └──────┬───────┘      └───────────┬────────────┘
                 │                          │             │                          │
                 └────────────────────┐     │             │     ┌────────────────────┘
                                      ▼     ▼             ▼     ▼
                               ┌────────────────────────────────────────┐
                               │          Quorum Fan-In Engine          │
                               │   - Cross-Persona Deduplication        │
                               │   - Severity / Persona Precedence      │
                               │   - Co-Sponsoring Persona Tracking     │
                               └───────────────────┬────────────────────┘
                                                   │
                                                   ▼
                               ┌────────────────────────────────────────┐
                               │       Final PR Review Verdict          │
                               │  [APPROVE / REQUEST_CHANGES / COMMENT] │
                               └────────────────────────────────────────┘
```

### Precedence Matrices

1. **Severity Precedence (`SEVERITY_PRECEDENCE`)**:
   - `critical` (Score: 4) > `major` (Score: 3) > `minor` (Score: 2) > `nit` (Score: 1)
2. **Persona Precedence (`PERSONA_PRECEDENCE`)**:
   - `security` (Score: 4) > `architecture` (Score: 3) > `performance` (Score: 2) > `quality` (Score: 1)

---

## 4. Diff State Indexing & Hunk Fingerprinting

`DiffStateManager` calculates cryptographic hashes to track line shifts and prevent re-evaluating unmodified hunks:

- **Hunk Hash Calculation (`computeHunkHash`)**:
  ```ts
  hunkHash = sha256(`${filePath}:${oldStart}:${oldLines}:${newStart}:${newLines}:${hunkContent}`)
  ```
- **Finding Fingerprint Hash (`computeFindingHash`)**:
  ```ts
  fingerprintHash = sha256(`${filePath}:${persona}:${severity}:${ruleId}:${codeSnippet}:${startLine}:${endLine}`)
  ```
- **Line Shift Offset Calculation**:
  When hunks insert or delete lines upstream of an untouched finding:
  ```ts
  lineShift = sum(newLines - oldLines) for all hunks where oldStart <= finding.startLine
  adjustedStartLine = finding.startLine + lineShift
  ```
  This ensures that untouched findings downstream move with line shifts instead of triggering false `RESOLVED` status transitions.

---

## 5. OmniRoute Router & Token Management Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  `TokenManager` Layer                                                                  │
│  - `SecureSecretStore`: AES-256-GCM authenticated encryption                           │
│  - `TokenRefreshManager`: Preemptive token refresh & single-flight mutex lock           │
│  - `TokenMetricsTracker`: Per-persona & per-provider token budget tracking             │
│  - `EffortScaler`: Effort mapping (low, medium, high, reasoning)                        │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  `ProviderPool` Layer                                                                  │
│  - Load Balancing Strategies: `priority_fallback`, `round_robin`, `least_loaded`       │
│  - Circuit Breaker States: `CLOSED` (Healthy), `OPEN` (Cooling Down), `HALF_OPEN`      │
│  - Failure Trip Triggers: HTTP 429 (Rate Limit), HTTP 401/403 (Auth), 3x HTTP 5xx      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Directory Layout & Module Structure

```
src/
├── app.ts                        # Main Express App creation & 6-stage review pipeline runner
├── index.ts                      # Service entry point & process shutdown handlers
├── config/                       # Configuration Engine (F1)
│   ├── configLoader.ts           # YAML parser, deep merge, & CodeRabbit translator
│   ├── defaultOrgConfig.ts       # System organization configuration defaults
│   └── schema.ts                 # Zod schema definitions for CtReviewConfig & CodeRabbit
├── ticket/                       # Ticket Linkage Validator (F2)
│   ├── ticketProviderClient.ts   # Parameterized GraphQL & REST API clients for Linear/Jira/GitHub
│   └── ticketValidator.ts        # Ticket extraction & false-positive prefix filter
├── constitution/                 # Operational Constitution Engine (F3)
│   └── constitutionEngine.ts     # Markdown parser, rule evaluator, & conventional commits
├── persistence/                  # Incremental Diff Delta Indexing (F4)
│   ├── db.ts                     # SQLite storage engine + JsonFileDiffStateStorage failover
│   └── diffStateManager.ts       # Commit state updater & line shift tracker
├── router/                       # Multi-Provider Router & Token Management (F5)
│   ├── providerPool.ts           # Circuit breaker, status snapshot, & strategy balancer
│   ├── tokenManager.ts           # AES-256-GCM secret store, single-flight mutex, effort scaler
│   └── omniRouteAdapter.ts       # Adapter translating provider configs to OmniRoute Gateway
├── quorum/                       # Multi-Persona Quorum Panel Engine (F6)
│   ├── consensus.ts              # Quorum aggregation, deduplication, & Markdown renderer
│   ├── mefEngine.ts              # Multi-persona Execution Framework panel runner
│   ├── quorumEngine.ts           # Voting decision evaluator (APPROVE/REQUEST_CHANGES/COMMENT)
│   └── personas/                 # Persona prompt definitions & response parsers
│       ├── archPersona.ts
│       ├── basePersona.ts
│       ├── perfPersona.ts
│       ├── qualityPersona.ts
│       ├── securityPersona.ts
│       └── parseHelper.ts
├── github/                       # Webhook Server & GitHub Integration (F7)
│   ├── webhookServer.ts          # Express webhook router & signature error handler
│   ├── signature.ts              # Timing-safe HMAC X-Hub-Signature-256 verification
│   ├── eventHandler.ts           # Webhook payload parser & event trigger evaluator
│   └── commentPublisher.ts       # GitHub REST API publisher for comments & review verdicts
├── gateway/                      # LLM Gateway Client
│   └── omniRouteClient.ts        # Client interface for external OmniRoute service
└── utils/                        # System Utilities
    ├── diffHash.ts               # Hunk & finding cryptographic fingerprinting
    └── logger.ts                 # Structured JSON application logger
```
