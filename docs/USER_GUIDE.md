# 📖 ct-review-bot — User Guide

> [!IMPORTANT]
> **Optional service document.** Dashboard, App, chat, memory, and repository-management behavior
> here is separate from the public GitHub Action and the CallTelemetry production fleet. Verify
> current service behavior before use. See [Documentation authority](DOCUMENTATION_AUTHORITY.md).

Welcome to the **ct-review-bot** User Guide. This comprehensive guide covers operational workflows, authentication, repository management, dashboard analytics, interactive PR chat commands, and rich automated code review features for developers and operations teams.

---

## 📋 Table of Contents

1. [Overview & Getting Started](#overview--getting-started)
2. [Linear Dark Mode Web Dashboard](#linear-dark-mode-web-dashboard)
3. [Authentication & API Key Management](#authentication--api-key-management)
   - [Logging In & Managing Session Tokens](#logging-in--managing-session-tokens)
   - [SHA-256 Hashed API Keys](#sha-256-hashed-api-keys)
4. [Repository Settings & Review Automation](#repository-settings--review-automation)
   - [Managing Repository Toggles](#managing-repository-toggles)
   - [Platform Settings & Cost Caps](#platform-settings--cost-caps)
5. [Overview Metrics & Activity Logs](#overview-metrics--activity-logs)
6. [`@ct-review` Chat Command Suite](#ct-review-chat-command-suite)
7. [Rich Review Artifacts](#rich-review-artifacts)
   - [Automated Mermaid Diagrams](#automated-mermaid-diagrams)
   - [Confidence Scores (0-100%)](#confidence-scores-0-100)
   - [Ranked Fix Options (Option 1 vs Option 2)](#ranked-fix-options-option-1-vs-option-2)

---

## 🌟 Overview & Getting Started

`ct-review-bot` is an enterprise-grade GitHub AI review bot and codebase telemetry engine. It combines multi-LLM persona panels (Security, Architecture, Performance, Quality), an in-house $0-cost AST symbol graph indexer, persistent PR memory nit suppression (`.ct-memory/`), Context7 MCP integration with Doppler secret routing, and a Linear-style dark mode Web Dashboard.

### Platform Architecture Overview

```mermaid
flowchart TD
    A[Developer Git Push / PR Event] --> B[GitHub App Webhook]
    B --> C{ct-review-bot Express Gateway}
    C --> D[Auth Portal & API Router]
    C --> E[In-House AST Symbol Graph & Vector Embedder]
    C --> F[Persistent PR Memory Store .ct-memory]
    C --> G[4-Persona AI Quorum Panel]
    G --> H[Binding Arbiter Verdict & Mermaid Engine]
    H --> I[GitHub Pull Request Review & Status Checks]
    D --> J[Linear Dark Mode Web Dashboard]
```

### Accessing the Platform
- **Web Dashboard & Portal**: `http://localhost:3000` (or your deployed ingress URL).
- **REST APIs**: `http://localhost:3000/api`
- **Health Checks**: `http://localhost:3000/health` and `/ready`

---

## 🎨 Linear Dark Mode Web Dashboard

`ct-review-bot` features a single-page Web Dashboard styled after Linear's dark mode UI, featuring dark obsidian palettes (`#0B0F19`), subtle violet accents, responsive data tables, real-time status badges, modal controls, and tabbed navigation.

The dashboard consists of four primary views:
1. **Overview**: Real-time KPI metrics, total token spend, cost caps, provider health, memory engine counters, and recent review activity logs.
2. **Repositories**: Organization repositories with automated review toggles, profile assignments (`chill`, `balanced`, `assertive`), and model overrides.
3. **API Keys**: SHA-256 hashed API key generator and access control table.
4. **Settings**: Global model overrides, persistent memory engine suppression thresholds, and financial budget caps.

---

## 🔐 Authentication & API Key Management

The platform implements a multi-tier authentication system supporting session tokens for human users in the Web Dashboard and SHA-256 hashed API keys for automated pipelines and local CLI tools.

### Logging In & Managing Session Tokens

#### 1. Authentication Login (`POST /api/auth/login`)
Users log in to the Web Dashboard using the administrative credentials configured via the `ADMIN_PASSWORD` environment variable (defaults to `admin123`).

**Request**:
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your_secure_admin_password"
  }'
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "user": {
    "id": "usr_admin_01",
    "username": "admin",
    "role": "admin",
    "email": "admin@company.com"
  },
  "token": "sess_8f3a92b1c4e7...",
  "expiresAt": "2026-07-25T23:54:15.000Z"
}
```

#### 2. Validating Session (`GET /api/auth/session`)
The dashboard sends the session token in the `Authorization: Bearer <token>` header to verify active session status.

**Request**:
```bash
curl -X GET http://localhost:3000/api/auth/session \
  -H "Authorization: Bearer sess_8f3a92b1c4e7..."
```

#### 3. Invalidate Session (`DELETE /api/auth/session`)
Destroys the active session token upon logout.

```bash
curl -X DELETE http://localhost:3000/api/auth/session \
  -H "Authorization: Bearer sess_8f3a92b1c4e7..."
```

---

### SHA-256 Hashed API Keys

For programmatic REST API access (e.g. `/api/dashboard/*`, `/api/memory/*`, `/api/code/*`), API keys are passed in the `x-api-key` header. 

Security design:
- When created, a raw secret key (`ct_live_<16-byte-hex>`) is displayed **once** to the user.
- The raw key is hashed using **SHA-256** before being saved to persistent storage (`dashboard.json`). The raw key is **never** stored in plain text.
- Validations check the SHA-256 digest of incoming keys against stored key hashes.

#### 1. Generate API Key (`POST /api/auth/apikeys`)
Requires an active Bearer session token or existing API key.

**Request**:
```bash
curl -X POST http://localhost:3000/api/auth/apikeys \
  -H "Authorization: Bearer sess_8f3a92b1c4e7..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "CI/CD Deployment Pipeline" }'
```

**Response (`201 Created`)**:
```json
{
  "success": true,
  "apiKey": {
    "id": "key_7a9f",
    "name": "CI/CD Deployment Pipeline",
    "rawKey": "ct_live_a1b2c3d4e5f678901234567890abcdef",
    "maskedKey": "ct_live_...cdef",
    "createdAt": "2026-07-24T23:54:15.000Z"
  }
}
```
*Note: Store `rawKey` securely immediately. It cannot be recovered later.*

#### 2. List API Keys (`GET /api/auth/apikeys`)
Returns masked keys for active credentials.

```bash
curl -X GET http://localhost:3000/api/auth/apikeys \
  -H "Authorization: Bearer sess_8f3a92b1c4e7..."
```

#### 3. Revoke API Key (`DELETE /api/auth/apikeys/:id`)
Immediately invalidates the specified key hash.

```bash
curl -X DELETE http://localhost:3000/api/auth/apikeys/key_7a9f \
  -H "Authorization: Bearer sess_8f3a92b1c4e7..."
```

---

## ⚙️ Repository Settings & Review Automation

Operations teams can configure repository-level automation toggles, profiles, and model assignments directly from the Web Dashboard or via REST endpoints.

### Managing Repository Toggles

#### List Registered Repositories (`GET /api/dashboard/repositories`)
```bash
curl -X GET http://localhost:3000/api/dashboard/repositories \
  -H "x-api-key: ct_live_a1b2c3d4e5f678901234567890abcdef"
```

#### Update Repository Automation & Profile (`PATCH /api/dashboard/repositories/:owner/:repo`)
Toggle automated PR reviews on/off or change the review stance (`chill`, `balanced`, `assertive`).

**Request**:
```bash
curl -X PATCH http://localhost:3000/api/dashboard/repositories/calltelemetry/cisco-cdr \
  -H "x-api-key: ct_live_a1b2c3d4e5f678901234567890abcdef" \
  -H "Content-Type: application/json" \
  -d '{
    "automationEnabled": true,
    "customProfile": "assertive",
    "modelOverrides": {
      "security": "claude-5-sonnet",
      "architecture": "gpt-5.6-sol"
    }
  }'
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "repository": {
    "owner": "calltelemetry",
    "repo": "cisco-cdr",
    "automationEnabled": true,
    "customProfile": "assertive",
    "modelOverrides": {
      "security": "claude-5-sonnet",
      "architecture": "gpt-5.6-sol"
    },
    "updatedAt": "2026-07-24T23:54:15.000Z"
  }
}
```

---

### Platform Settings & Cost Caps

Global settings govern default model mappings, persistent memory thresholds, and financial spending guardrails.

#### Get Settings (`GET /api/dashboard/settings`)
```bash
curl -X GET http://localhost:3000/api/dashboard/settings \
  -H "x-api-key: ct_live_a1b2c3d4e5f678901234567890abcdef"
```

#### Update Settings (`PUT /api/dashboard/settings`)
```bash
curl -X PUT http://localhost:3000/api/dashboard/settings \
  -H "x-api-key: ct_live_a1b2c3d4e5f678901234567890abcdef" \
  -H "Content-Type: application/json" \
  -d '{
    "memoryEngineSettings": {
      "autoSuppressNits": true,
      "learningConfidenceThreshold": 85,
      "maxLearningsPerRepo": 1000
    },
    "providerCostCaps": {
      "monthlyBudgetUSD": 250.00,
      "dailyBudgetUSD": 25.00,
      "alertThresholdPercent": 80,
      "actionOnCapBreach": "fail_closed"
    }
  }'
```

---

## 📊 Overview Metrics & Activity Logs

The Web Dashboard overview endpoint (`GET /api/dashboard/overview`) aggregates telemetry across repositories, LLM gateways, and the in-house memory engine.

### Response Data Structure (`GET /api/dashboard/overview`)
```json
{
  "success": true,
  "overview": {
    "totalRepositories": 2,
    "activeAutomations": 2,
    "totalReviewsExecuted": 348,
    "totalCostUSD": 14.8251,
    "monthlyCostCapUSD": 100,
    "costCapBreached": false,
    "totalTokens": {
      "prompt": 4500000,
      "completion": 1200000,
      "total": 5700000
    },
    "providerHealth": [
      { "id": "codex", "status": "healthy", "model": "codex/gpt-5.6-sol-high" },
      { "id": "claude", "status": "healthy", "model": "claude/claude-opus-4-8" },
      { "id": "grok", "status": "healthy", "model": "grok-cli/grok-4.5" },
      { "id": "agy-opus", "status": "healthy", "model": "agy/claude-opus-4-6-thinking" }
    ],
    "memoryGraph": {
      "learningsCount": 42,
      "suppressedNitsCount": 128,
      "adrConstraintsCount": 15,
      "symbolNodesCount": 8450,
      "symbolEdgesCount": 19200
    }
  }
}
```

### Review Activity Logs (`GET /api/dashboard/logs`)
Returns a rolling audit log of recent PR review panel runs:
```json
{
  "success": true,
  "logs": [
    {
      "id": "log_1721865255_a1b2",
      "prRun": "cisco-cdr #142",
      "headSha": "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e",
      "personas": "sec-lane, arch-lane, perf-lane, qual-lane",
      "quorum": "4/4 Distinct",
      "arbiterVerdict": "SHIP",
      "timestamp": "2026-07-24T23:50:00.000Z"
    }
  ]
}
```

---

## 💬 `@ct-review` Chat Command Suite

Developers can interact directly with `ct-review-bot` by posting comments on Pull Requests or replying to inline review threads. Commands start with `@ct-review` (or `@ct-review-bot`).

| Command | Usage Example | Description |
| :--- | :--- | :--- |
| **`@ct-review review`** | `@ct-review review` | Triggers an immediate, full multi-persona quorum review panel. |
| **`@ct-review ask <question>`** | `@ct-review ask How does this handle database deadlocks?` | Answers specific questions about the PR diff or codebase architecture using context-aware LLMs. |
| **`@ct-review refactor`** | `@ct-review refactor simplify this switch statement` | Generates clean code refactoring recommendations with 1-click GitHub apply blocks (````suggestion ... ````). |
| **`@ct-review explain`** | `@ct-review explain` | Provides step-by-step explanations of complex diff hunks or inline comment thread discussions. |
| **`@ct-review summarize`** | `@ct-review summarize` | Re-generates and posts a fresh executive overview, bulleted walkthrough, and module changeset breakdown. |

---

## 🎨 Rich Review Artifacts

### Automated Mermaid Diagrams

When complex changes span multiple files or contain interaction/branching logic, `ct-review-bot` automatically generates Markdown-fenced `mermaid` architecture diagrams inside the PR summary.

#### Interaction Flow Diagram (`sequenceDiagram`)
Generated when multi-component calls, webhooks, or asynchronous handlers are detected:
```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant ReviewBot
    participant GitHubAPI
    Client->>ReviewBot: Trigger Event / PR Change
    ReviewBot->>GitHubAPI: Process & Dispatch API Call
    GitHubAPI-->>ReviewBot: Return Response Payload
    ReviewBot-->>Client: Post Review & Status Check
```

#### Structural Logic Diagram (`flowchart TD`)
Generated for structural branches and decision trees:
```mermaid
flowchart TD
    A[PR Diff Received] --> B{Complexity Evaluation}
    B -->|Passed| C[Publish Review]
    B -->|Failed| D[Fail Closed]
```

---

### Confidence Scores (0-100%)

Every inline finding generated by the persona panel includes a quantitative confidence rating (`0%` to `100%`). 

```markdown
### [sec-lane] Unsafe SQL Query Formatting — Severity: CRITICAL

**Confidence**: 95%
**Finding**: Direct string concatenation detected in SQL query formulation.
[RECOMMENDATION] Use parameterized SQL queries to prevent SQL injection vulnerabilities.
```

Findings with confidence scores below the repository's configured `confidence_threshold` (e.g. `70%`) are automatically filtered out before publishing, ensuring high signal-to-noise ratio.

---

### Ranked Fix Options (Option 1 vs Option 2)

When a critical or major code finding is identified, `ct-review-bot` provides up to **2 ranked fix options** to give developers choice between optimal solutions and alternative trade-offs:

```markdown
### [arch-lane] High Memory Allocations in Event Loop — Severity: MAJOR

**Confidence**: 88%
**Finding**: Instantiating large object buffers inside the loop causes excessive GC pressure.
[RECOMMENDATION] Refactor memory buffer allocation outside loop scope or use static buffer pooling.

#### Option 1: Recommended Fix (Rank #1)
Pre-allocate buffer pool prior to entering process loop.
```suggestion
const bufferPool = new BufferPool(1024);
for (const item of items) {
  bufferPool.process(item);
}
```

#### Option 2: Alternative Approach (Rank #2)
Stream items using AsyncIterable generators to minimize peak memory footprint.
```suggestion
for await (const chunk of streamItems(items)) {
  processChunk(chunk);
}
```
```

---

## 📄 Support & Reference

For additional details on schema definitions and configuration options, see:
- [Configuration Reference](CONFIGURATION_REFERENCE.md)
- [Marketing & Feature Overview](MARKETING_OVERVIEW.md)
- [Architecture Blueprint](ARCHITECTURE.md)
