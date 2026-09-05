# 🧠 Review Yeti — Persistent Team Memory & Nit Suppression Guide

A common frustration with automated AI code reviews is **review fatigue**: seeing the same stylistic nit, intentional pattern, or known false positive repeatedly flagged across every pull request. Review Yeti solves this with **Persistent Team Memory** and the **Nit Suppression Engine**, backed by a high-performance SQLite WAL database at `.ct-memory/team_memory.db`.

In addition, Review Yeti supports a **Community Persona Store** that enables sharing specialized reviewer charters across repositories using the `uses:` syntax.

---

## 📋 Table of Contents

1. [Architectural Overview](#architectural-overview)
2. [Community Persona Store & Charter Loader](#community-persona-store--charter-loader)
   - [`uses:` Reference Syntax](#uses-reference-syntax)
   - [3-Tier Resolution Precedence](#3-tier-resolution-precedence)
   - [YAML Frontmatter Schema](#yaml-frontmatter-schema)
   - [Charter Caching in `.ct-memory/cache/`](#charter-caching-in-ct-memorycache)
3. [Persistent Team Memory (`.ct-memory/team_memory.db`)](#persistent-team-memory-ct-memoryteam_memorydb)
   - [WAL Mode Storage & Node 24 Native SQLite](#wal-mode-storage--node-24-native-sqlite)
   - [Database Schema & Entity Models](#database-schema--entity-models)
4. [CI/CD Persistence: Where is Memory Stored in CI/CD?](#-cicd-persistence-where-is-memory-stored-in-cicd)
   - [Architecture Matrix: Storage by Execution Mode](#architecture-matrix-storage-by-execution-mode)
   - [Strategy 1: GitHub Actions Cache (Zero Infrastructure)](#strategy-1-github-actions-cache-actionscachev4--zero-infrastructure)
   - [Strategy 2: Self-Hosted Kubernetes / Cluster Mode (Persistent Volume)](#strategy-2-self-hosted-kubernetes--cluster-mode-persistent-volume)
   - [Strategy 4: Central PostgreSQL Database (`DATABASE_URL`)](#strategy-3-central-postgresql-database-database_url)
   - [Strategy 5: Central Cloud Cognitive Memory via Honcho (`HONCHO_API_KEY`)](#strategy-5-central-cloud-cognitive-memory-via-honcho-honcho_api_key)
   - [Strategy 6: Local Pre-Commit CLI (`git yeti`)](#strategy-6-local-pre-commit-cli-git-yeti)
5. [Nit Suppression Engine (`NitSuppressionEngine`)](#nit-suppression-engine-nitsuppressionengine)
   - [Multi-Strategy Matching Pipeline](#multi-strategy-matching-pipeline)
   - [Path Glob Matching](#path-glob-matching)
   - [Rule ID & Regex Pattern Matching](#rule-id--regex-pattern-matching)
6. [The Non-Bypassable Security Safety Policy](#the-non-bypassable-security-safety-policy)
7. [Team Memory Workflows](#team-memory-workflows)
8. [Troubleshooting & Maintenance](#troubleshooting--maintenance)

---

## 🏛️ Architectural Overview

Review Yeti's memory and reflection architecture bridges past human decisions with future automated reviews:

```mermaid
flowchart TD
    subgraph Capture Phase
        Dev[Developer in PR Thread] -->|@review-yeti ignore| Chat[Chat Command Dispatcher]
        Chat --> Record[PRMemoryStore.recordResolvedNit]
    end

    subgraph Storage: SQLite WAL Engine
        Record --> DB[(.ct-memory/team_memory.db)]
        DB --> Table1[resolved_nits]
        DB --> Table2[learnings]
        DB --> Table3[adr_constraints]
    end

    subgraph Evaluation Phase
        PR[New PR Opened / Updated] --> Engine[Review Yeti Evaluation Pipeline]
        Engine --> Raw[Raw Persona Findings]
        Raw --> Suppr[NitSuppressionEngine.suppressNits]
        DB -.->|Query Learned Nits| Suppr
        Suppr --> Gate{Security Safety Check}
        Gate -->|P0 or P1 finding| Active[Active Findings: NEVER SUPPRESSED]
        Gate -->|P2 matches suppressed nit| Silenced[Silenced Findings: Filtered Out]
        Active --> Publish[Post Consolidated PR Review]
    end
```

---

## 👥 Community Persona Store & Charter Loader

Review Yeti enables sharing and composing reviewer charters across repositories using external references.

### `uses:` Reference Syntax

In your `.ct-review.yaml`, reference external or community charters under the `personas` block:

```yaml
# .ct-review.yaml
version: 3

personas:
  - id: security
    enabled: true

  # 1. Bundled community persona
  - name: "🏢 Multi-Tenant Isolation"
    uses: tenancy

  # 2. Local relative file
  - name: "🗄️ Custom SQL Linter"
    uses: ./charters/sql-safety.md

  # 3. Remote GitHub repository reference
  - name: "🔒 Django Security Specialist"
    uses: review-yeti/personas/django-security@v1
```

### 3-Tier Resolution Precedence

When `CommunityPersonaLoader` resolves a persona charter, it searches sources in the following strict order:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Bundled Personas (domains/personas/ or examples/personas)│
└──────────────────────────────┬──────────────────────────────┘
                               │ (if not matched)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Local Files (starting with ./ or ../ or absolute paths)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if not matched)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Remote GitHub Repositories (owner/repo/path@ref)         │
└─────────────────────────────────────────────────────────────┘
```

1. **Bundled Community Personas**: Review Yeti bundles pre-validated charters in `domains/personas/` and `examples/personas/` (e.g. `tenancy`, `database-migrations`, `performance`, `compliance`). If the candidate matches a bundled charter name, it loads instantly with zero network requests.
2. **Local Files**: Any reference starting with `./` or `../` is resolved relative to the repository root on disk.
3. **Remote GitHub Repositories**: References matching `owner/repo/path@ref` (e.g. `acme-corp/charters/security@v1.2.0`) are fetched over HTTPS, validated, and cached locally.

### YAML Frontmatter Schema

Persona charters are standard Markdown documents with YAML frontmatter bounded by `---` delimiters:

```markdown
---
name: "🏢 Multi-Tenant Isolation Guardian"
id: tenancy
model: openrouter/deepseek/deepseek-v4-flash-0731
enabled: true
reasoning_effort: high
paths:
  - "src/api/**"
  - "src/db/**"
providers:
  - openrouter
description: Enforces strict tenant scoping across all customer-facing database queries.
---

## Mission
Guard multi-tenant data isolation at all costs. Flag any un-scoped tenant query.

## What to Flag (P1):
- Database queries accepting an ID without an `orgId` or `tenantId` bound.
- REST endpoints accessing customer entities without tenant context validation.
- In-memory cache keys that omit tenant ID prefixes.

## What to Ignore:
- System migration scripts in `migrations/`.
- Admin-only routes under `src/admin/**`.
```

#### Required Frontmatter Fields
- `name` *(string)*: Display name for the reviewer persona.
- Charter body *(Markdown)*: Minimum 10 characters detailing what to flag and what to ignore.

#### Optional Frontmatter Fields
- `model` *(string)*: Model override (e.g. `openrouter/deepseek/deepseek-v4-flash-0731`).
- `reasoning_effort` / `effort` *(enum)*: `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`.
- `paths` *(string[])*: File glob patterns to scope this persona's evaluation.
- `maxTurns` *(number)*: Maximum conversation turns for reasoning.

### Charter Caching in `.ct-memory/cache/`

Remote charters are automatically cached in `.ct-memory/cache/personas/`. The cache key is constructed by sanitizing the repository and ref:

```
.ct-memory/cache/personas/review-yeti__personas__v1__django-security.md
```

- **Speed**: Subsequent runs load the cached file immediately without network latency.
- **Air-Gapped Operation**: In offline or containerized CI environments, pre-populated caches enable full review execution without public internet access.

---

## 🗄️ Persistent Team Memory (`.ct-memory/team_memory.db`)

Review Yeti stores persistent repository knowledge in a dedicated SQLite database located at:
```
.ct-memory/team_memory.db
```
*(Configurable via the `CT_TEAM_MEMORY_DB` environment variable).*

### WAL Mode Storage & Node 24 Native SQLite

Review Yeti leverages Node 24's native `node:sqlite` (`DatabaseSync`) module for ultra-fast, zero-dependency storage. The database is initialized with production WAL (Write-Ahead Logging) pragmas:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

- **High Concurrency**: WAL mode permits simultaneous read access while a write transaction is committing.
- **Resilience**: Eliminates database lock contention (`SQLITE_BUSY`) during parallel CI jobs.

### Database Schema & Entity Models

#### 1. `resolved_nits` (Suppressed Findings)
Stores findings that developers have dismissed using `@review-yeti ignore` or `@review-yeti mute`:

| Column | Type | Description |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | Unique identifier (`nit_...`). |
| `repo` | `TEXT` | Full repository name (`owner/repo`). |
| `pr_number` | `INTEGER` | PR number where the finding was dismissed. |
| `pattern` | `TEXT` | Title, text substring, or regex to match. |
| `file_path` | `TEXT` | File path or glob pattern (e.g. `src/config/**`). |
| `reason` | `TEXT` | Developer-provided justification for dismissal. |
| `rule_id` | `TEXT` | Optional specific linter or persona rule ID. |
| `head_sha` | `TEXT` | Git commit SHA at the time of resolution. |
| `resolved_at` | `TEXT` | ISO-8601 timestamp. |
| `suppression_count`| `INTEGER` | Counter incremented each time this rule silences a finding. |

#### 2. `learnings` (Team Architectural Conventions)
Stores architectural conventions, design decisions, and team guidelines:
- `category`: `'convention'`, `'architecture'`, `'security'`, `'performance'`, `'style'`, `'adr'`.
- `title`, `description`, `file_path`, `confidence`.

#### 3. `adr_constraints` (Architecture Decision Records)
Synchronizes codified constraints from repository ADRs:
- `adr_number`, `title`, `status` (`'draft'`, `'accepted'`, `'deprecated'`), `rule`, `target_paths`.

---

## 🔄 CI/CD Persistence: Where is Memory Stored in CI/CD?

A common question when running Review Yeti in CI/CD is: **"If GitHub Actions runners are ephemeral, where is team memory stored?"**

Because standard GitHub Actions runners (`ubuntu-latest`) destroy their filesystem after every workflow job finishes, an un-cached `.ct-memory/team_memory.db` file would be lost across subsequent pull requests. Review Yeti provides **four distinct persistence strategies** depending on how your team runs Review Yeti:

### Architecture Matrix: Storage by Execution Mode

| Execution Mode | Where Memory Lives | Persistence Mechanism | Best For |
|---|---|---|---|
| **1. Standalone GitHub Action** | `.ct-memory/team_memory.db` (SQLite WAL) | **GitHub Actions Cache** (`actions/cache@v4`) | Zero-infrastructure single-repo workflows |
| **2. Self-Hosted Kubernetes / Cluster** | Persistent Volume (`/app/.ct-memory`) | **Kubernetes PersistentVolumeClaim (PVC)** | Helm / Operator cluster deployments |
| **3. Interactive Webhook Server** | Container volume or host mount | **Docker Volume / Host Path** (`CT_TEAM_MEMORY_DB`) | Dedicated GitHub App webhook nodes |
| **4. Central Enterprise Database** | PostgreSQL instance | **`DATABASE_URL` Dual-Write Connection** | Multi-repo teams sharing org-wide relational memory |
| **5. Central Cloud Cognitive Memory** | Honcho Workspace (`/v3/workspaces/{ws}`) | **Honcho Memory Adapter / Composite Sync** | Semantic team memory, cross-PR cognitive recall, zero DB maintenance |
| **6. Git Repository / Metadata Branch** | Git commit in `.ct-memory/` | **Git Commit & Push** | Pure open-source repos with auditable history |

---

### Strategy 1: GitHub Actions Cache (`actions/cache@v4`) — Zero Infrastructure

For teams running Review Yeti purely inside GitHub Actions without an external database, the easiest approach is GitHub Actions Cache. Caching `.ct-memory/` preserves `team_memory.db` and cached community persona charters between pull requests:

```yaml
# .github/workflows/review-yeti.yml
name: Review Yeti PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      # 🧠 Restore Team Memory & Persona Cache across runs
      - name: Restore Review Yeti Team Memory Cache
        uses: actions/cache@v4
        with:
          path: .ct-memory/
          key: review-yeti-memory-${{ github.repository }}-${{ github.run_id }}
          restore-keys: |
            review-yeti-memory-${{ github.repository }}-
            review-yeti-memory-

      - name: Run Review Yeti
        uses: review-yeti-ai/review-yeti-bot@v1
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

- When the PR is reviewed, Review Yeti loads existing dismissed nits and team conventions from `.ct-memory/team_memory.db`.
- At the end of the job, `actions/cache` automatically saves the updated `.ct-memory/` directory back to GitHub's cache storage.

---

### Strategy 2: Self-Hosted Kubernetes / Cluster Mode (Persistent Volume)

When running Review Yeti in cluster mode (via Helm or the Kubernetes Operator):
- The `review-yeti-dispatcher` and workers mount a standard Kubernetes **PersistentVolumeClaim (PVC)** to `/app/.ct-memory` (or a designated mount path).
- The Helm chart `charts/review-yeti/values.yaml` provisions a PVC for persistent storage:
  ```yaml
  persistence:
    enabled: true
    storageClass: "do-block-storage" # or gp3, standard
    size: 10Gi
    mountPath: /app/.ct-memory
  ```
- When developers reply `@review-yeti ignore` or `@review-yeti mute` on a PR, the GitHub App webhook receives the event immediately, writes the nit to the persistent volume, and it is instantly available for all future PR reviews.

---

### Strategy 3: Central PostgreSQL Database (`DATABASE_URL`)

For enterprise environments or multi-repo teams that want a single shared brain across dozens of repositories:
- Set the `DATABASE_URL` environment variable (e.g. `postgresql://user:pass@postgres.internal:5432/review_yeti`).
- `PRMemoryStore` automatically detects PostgreSQL and enables **dual-write synchronization**:
  - Writes to both local SQLite and central PostgreSQL.
  - Queries check central PostgreSQL to resolve cross-repository team conventions, ADRs, and shared nit suppressions.

---

### Strategy 5: Central Cloud Cognitive Memory via Honcho (`HONCHO_API_KEY`)

For teams wanting AI-native cognitive memory that learns semantic rules, suppresses nits, and shares architectural constraints across PRs without maintaining a dedicated database:

Review Yeti features a pluggable **Memory Adapter Pattern** (`src/memory/adapters/`) with native support for **Honcho** (`https://honcho.dev` or self-hosted Honcho).

#### Supported Memory Providers
- `sqlite`: Local zero-dependency Node 24 native SQLite WAL database (`.ct-memory/team_memory.db`).
- `honcho`: Direct cloud cognitive memory store interfacing with Honcho v3 REST API.
- `composite`: Two-tier memory combining local ultra-fast SQLite cache with asynchronous cloud synchronization to Honcho. Automatically activated when `HONCHO_API_KEY` is present.
- `postgres`: Enterprise relational storage via `DATABASE_URL`.

#### Honcho Configuration Environment Variables
| Variable | Default | Description |
|---|---|---|
| `MEMORY_PROVIDER` | `auto` / `composite` | Memory provider selection: `sqlite`, `honcho`, `composite`, `postgres`, `auto`. |
| `HONCHO_API_KEY` | *(None)* | Bearer authentication key for the Honcho API. |
| `HONCHO_BASE_URL` | `http://localhost:8000` | Base URL of the Honcho instance (e.g. `https://honcho.example.com`). |
| `HONCHO_WORKSPACE` | `default` | Target Honcho workspace isolating memory across organizational units. |
| `HONCHO_PEER` | `review-yeti` | Writer peer identity representing the Review Yeti agent. |
| `HONCHO_OBSERVED` | `developer` | Observed peer identity representing team contributors. |

#### GitHub Actions Workflow Example with Honcho
```yaml
# .github/workflows/review-yeti.yml
- name: Run Review Yeti with Honcho Cloud Memory
  uses: review-yeti-ai/review-yeti-bot@v1
  env:
    HONCHO_BASE_URL: ${{ secrets.HONCHO_BASE_URL || 'https://honcho.example.com' }}
    HONCHO_API_KEY: ${{ secrets.HONCHO_API_KEY }}
    HONCHO_WORKSPACE: 'core-platform'
    MEMORY_PROVIDER: 'composite'
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

#### How Honcho Synchronization Works
1. **Learnings & Conventions**: Saved as typed conclusions (`schema: "ct-honcho-conclusion.v1"`, `kind: "decision_context"`) scoped to the repository and domain.
2. **Nit Suppressions**: Captured as corrections (`kind: "correction"`) with pattern and file path metadata.
3. **ADR Constraints**: Preserved as architectural invariants (`kind: "invariant"`).
4. **Resilience**: If the Honcho endpoint experiences a network timeout or outage, the `CompositeMemoryAdapter` seamlessly serves queries from the local SQLite cache without interrupting review workflows.

---

### Strategy 6: Local Pre-Commit CLI (`git yeti`)

When developers run `git yeti pre-commit` locally:
- Team memory is stored at `.ct-memory/team_memory.db` on their local machine.
- Developers can optionally share rules across the team by checking in `.ct-review.yaml` or syncing via central PostgreSQL or Honcho.

---

## 🎯 Nit Suppression Engine (`NitSuppressionEngine`)

The `NitSuppressionEngine` runs as a post-processing filter after all personas complete their diff analysis and before arbitration produces the final review comment.

### Multi-Strategy Matching Pipeline

For each finding produced by a persona, the engine checks against active `resolved_nits`:

1. **Path Glob Match**: Verifies that the finding's file path satisfies the nit's `file_path` glob pattern.
2. **Rule ID Match**: If a `rule_id` was specified (e.g. via `@review-yeti mute rule:sql-param`), it checks for exact or substring match with the finding's rule identifier.
3. **Substring Pattern Match**: Checks if the suppressed phrase appears in the finding's title, body, or persona comment.
4. **Regular Expression Match**: Evaluates the pattern as an active regex against finding text.
5. **Token Set Match**: Tests whether all significant words in the suppressed pattern exist in the finding description.

If any strategy matches, the finding is marked as **Suppressed** and filtered from the PR comment.

### Path Glob Matching

Path patterns support standard glob conventions:
- `src/config/**` matches any file inside `src/config/` and all nested subdirectories.
- `*.test.ts` matches test files at root level.
- `**/*.spec.ts` matches spec files anywhere in the repository.
- `**` matches all files across the repository.

---

## 🛡️ The Non-Bypassable Security Safety Policy

> ⛔ **CORE INTEGRITY INVARIANT**:
> **Security and release-critical findings CANNOT be suppressed.**

The engine enforces an absolute safety gate:

```typescript
const isBlocking =
  severity === 'P0' ||
  severity === 'P1' ||
  severity === 'CRITICAL' ||
  severity === 'BLOCKER' ||
  severity === 'HIGH';

if (isBlocking) {
  // MANDATORY SAFETY: Under no circumstances can P0 or P1 findings be suppressed!
  activeFindings.push(finding);
  continue;
}
```

- If a developer enters `@review-yeti ignore Leaked AWS Key`, the command records the note, but **subsequent P0 credential leaks will still block commits and fail pull request gates**.
- This invariant guarantees that team memory acts as a tool for **reducing cosmetic noise**, never a loophole for bypassing security controls.

---

## 💡 Team Memory Workflows

### 1. Dismissing an Inline Nit via PR Chat
In a pull request review thread:
```markdown
@review-yeti ignore Prefer single quotes - Double quotes permitted in configuration files
```
*Review Yeti records the pattern and suppresses future occurrences in `src/config/`.*

### 2. Muting a Rule Across a File Subsystem
```markdown
@review-yeti mute rule:explicit-function-return-type - Return types inferred in tests
```
*Silences return type warnings across all files matching the thread's path pattern.*

### 3. Inspecting Active Team Memory
You can query the SQLite database directly using SQLite CLI or Node.js scripts:
```bash
sqlite3 .ct-memory/team_memory.db "SELECT pattern, file_path, reason, suppression_count FROM resolved_nits;"
```

---

## 🛠️ Troubleshooting & Maintenance

| Problem | Cause | Solution |
|---|---|---|
| **Nit still appearing after `@review-yeti ignore`** | Finding severity is P0 or P1 | Review Yeti never suppresses P0 or P1 security/correctness findings. Fix the underlying issue. |
| **Nit still appearing on a different file** | Path glob was too specific | Update the pattern in `.ct-memory/team_memory.db` to use a broader wildcard (e.g. `src/components/**`). |
| **Remote persona fails to load** | Invalid GitHub reference or ref does not exist | Verify the reference matches `owner/repo/path@ref` and that the targeted branch/tag exists. |
| **Database locked (`SQLITE_BUSY`)** | Multiple parallel jobs without WAL mode | Verify that `.ct-memory/team_memory.db` has WAL mode enabled (`PRAGMA journal_mode = WAL;`). |
| **Corrupted local cache** | Interrupted network download | Delete `.ct-memory/cache/personas/` to trigger a clean re-fetch. |

---

👉 **Next Steps**:
- See [Interactive PR Chat Guide](INTERACTIVE_CHAT.md) for available `@review-yeti` commands.
- See [CLI Reference](CLI_REFERENCE.md) for local pre-commit checks.
- See [Configuration Reference](CONFIGURATION_REFERENCE.md) for `.ct-review.yaml` settings.
