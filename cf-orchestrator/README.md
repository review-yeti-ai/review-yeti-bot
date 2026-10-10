# Review Yeti: Cloudflare-Native Orchestration Engine

A serverless, Kubernetes-free orchestration engine for **Review Yeti**, built on **Cloudflare Workers**, **SQLite Durable Objects**, **Cloudflare Workflows**, **Cloudflare Queues**, and **Cloudflare Containers / Firecracker MicroVMs**.

> **Current Production Status**: **Live in Production Shadow Mode**  
> **Live Edge Endpoint**: [`https://review-yeti-cf-orchestrator.example.workers.dev`](https://review-yeti-cf-orchestrator.example.workers.dev)  
> **Production Parity Mode**: Active (`PARALLEL_MODE = "true"`). Legacy DOKS operator remains 100% active and authoritative (posting `"Review Yeti"`). Cloudflare operates concurrently in shadow validation mode (posting `"Review Yeti (Cloudflare Canary)"` and PR reviews with 1-click inline suggestions).

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph GH_IN["GitHub Ingress"]
        PR_EVENT["PR Events<br/>(opened, synchronize, closed)"]
        CHATOPS_EVENT["Issue Comment ChatOps<br/>(@review-yeti re-review | deep-scan | explain)"]
    end

    subgraph PROXY["Cloudflare Edge Ingress & Dual-Dispatch"]
        WORKER["Ingress Worker (src/worker.ts)<br/>HMAC SHA-256 Verification"]
        DOKS_DISPATCH["Async Fanout to DOKS<br/>review-bot.example.com"]
        DEBOUNCE_QUEUE["Cloudflare Queue<br/>10s Debounce Window"]
    end

    subgraph DOKS_PROD["Legacy DOKS Production Operator (Active)"]
        DOKS_CTRL["Go Operator Controller & Outbox"]
        DOKS_JOB["batchv1.Job Worker Pod & PVC"]
        DOKS_CHECK["Authoritative GitHub Check:<br/>'Review Yeti'"]
    end

    subgraph CF_CONTROL["Cloudflare Edge Control Plane"]
        REPO_GATE["RepoGateDO (SQLite Durable Object)<br/>FIFO Concurrency Semaphore (Cap: 5)"]
        REVIEW_RUN["ReviewRunDO (SQLite Durable Object)<br/>Fencing Epochs & 2-Tier Cancellation"]
        WORKFLOW["ReviewJobWorkflow (WorkflowEntrypoint)<br/>Multi-Step Saga Coordinator"]
        HYPERDRIVE["Hyperdrive Pooler -> PostgreSQL<br/>Audit & Parity Ledger"]
    end

    subgraph DIFF_HARNESS["DeepSeek-Style Diff Task Harness"]
        TRIAGE["Pre-Flight Triage (src/diffHarness/)<br/>Tiers: low | medium | high | max"]
        ACTIVE_LEDGER["Active Changes Knowledge Ledger<br/>Sliding Compactor (< 300 tokens)"]
        GROUNDING["On-Demand Tools<br/>(zoektLookup, grepFile)"]
    end

    subgraph RUNNERS["Execution Plane (Dual-Runner Abstraction)"]
        DO_RUNNER["DigitalOcean MARS Runner<br/>(Firecracker MicroVMs, Agent-Aware Billing)"]
        CF_RUNNER["Cloudflare Container Runner<br/>(Edge-Colocated OCI Sandboxes)"]
        R2_CACHE[("Cloudflare R2 Workspace Cache<br/>(.tar.zst with 1-Hour Lifecycle Rule)")]
    end

    subgraph PUBLISHING["GitHub Publishing Plane (Phase 2)"]
        CANARY_CHECK["GitHub Checks API<br/>'Review Yeti (Cloudflare Canary)'"]
        INLINE_REVIEWS["GitHub PR Reviews API<br/>1-Click Inline ```suggestion``` Blocks<br/>(APPROVE | REQUEST_CHANGES | COMMENT)"]
    end

    %% Ingress Flow
    PR_EVENT --> WORKER
    CHATOPS_EVENT --> WORKER
    WORKER -.->|Async Fallback Fanout| DOKS_DISPATCH
    DOKS_DISPATCH --> DOKS_CTRL --> DOKS_JOB --> DOKS_CHECK

    %% Cloudflare Pipeline Flow
    WORKER -->|Synchronize Push| DEBOUNCE_QUEUE
    WORKER -->|Immediate / ChatOps| REPO_GATE
    DEBOUNCE_QUEUE --> REPO_GATE
    REPO_GATE -->|Acquire Slot| REVIEW_RUN
    REVIEW_RUN -->|Spawn| WORKFLOW

    WORKFLOW -->|Step 1: Mint Scoped Token| CF_CONTROL
    WORKFLOW -->|Step 2: Partition Diffs & Triage| DIFF_HARNESS
    DIFF_HARNESS --> TRIAGE
    TRIAGE --> ACTIVE_LEDGER
    ACTIVE_LEDGER --> GROUNDING

    WORKFLOW -->|Step 3: Dispatch Worker| DO_RUNNER
    WORKFLOW -.->|Alternative Runner| CF_RUNNER
    DO_RUNNER <-->|Sub-300ms Unpack / Pack| R2_CACHE
    DO_RUNNER --> GROUNDING

    %% Two-Tier Cancellation Flow
    REVIEW_RUN -.->|Push Abort Signal| DO_RUNNER
    DO_RUNNER -.->|Pull Polling /api/dispatch/runs/:id/status| REVIEW_RUN

    %% Output Flow
    DO_RUNNER -->|Step 4: Post Canary Check| CANARY_CHECK
    DO_RUNNER -->|Step 5: Publish Inline Reviews| INLINE_REVIEWS
    DO_RUNNER -->|Step 6: Terminal Receipt| WORKFLOW
    WORKFLOW -->|Step 7: Record Audit Receipt| HYPERDRIVE
    WORKFLOW -->|Step 8: Saga Release Slot| REPO_GATE
```

---

## Why Migrate from DOKS to Cloudflare?

| Metric | DOKS Kubernetes Service | Cloudflare Edge + Containers | Advantage |
|---|---|---|---|
| **Base Idle Cost** | **$130 – $210 / month** (3–5 idle nodes, block storage PVCs, load balancers) | **$5 – $20 / month** (Workers Paid + active-CPU container billing) | **~85–90% cost reduction** (Zero idle cost) |
| **Operational Maintenance** | High: Node pool scaling, Kubernetes upgrades, CNI/Cilium updates, Helm/Flux drift, CRD migrations | Minimal: Managed serverless edge; no nodes, clusters, or volume mounts | **Cloudflare** |
| **Startup Latency** | Warm pod: ~1s; Cold node scale: 45s – 90s | Container start: ~2s – 4s; Edge webhook response: <50ms | **Cloudflare** |
| **Storage Reliability** | PVCs prone to stuck multi-zone volume attachments and orphan disk leaks | Cloudflare R2 streaming zstd cache (~500ms hydration) with auto-TTL | **Cloudflare** |

---

## Phase 2 Delivery: PR Review Experience & ChatOps

Phase 2 elevates Review Yeti from an advisory check-run into an interactive, 1-click GitHub Pull Request reviewer.

### 1. 1-Click Inline GitHub Suggestions (`reviewPublisher.ts`)
Findings with actionable code remedies are published directly into the PR diff using GitHub's native ````suggestion``` markdown block:

```markdown
🚨 **[P0]** **Missing Fencing Lease Epoch Check**

Worker does not validate `epoch === state.fencingEpoch`, allowing stale workers to overwrite active leases.

*Rule: `concurrency.fencing.lease_epoch_validation`*

```suggestion
if (epoch !== this.runState.fencingEpoch) {
  return { ok: false, reason: 'fencing_epoch_mismatch' };
}
```
```

#### Review Verdicts & State Transitions
- **`APPROVE`**: Diff is clean with zero P0/P1 issues and passes all policy invariants.
- **`REQUEST_CHANGES`**: One or more P0 (critical security/data integrity) or P1 (correctness bug) findings detected.
- **`COMMENT`**: Informational, architectural, or P2/P3 quality suggestions without blocking PR mergeability.

### 2. PR ChatOps Ingress Engine (`worker.ts`)
Developers can trigger, steer, and interrogate Review Yeti directly from GitHub PR comments:

| Command | Action | Thinking Effort |
|---|---|---|
| `@review-yeti re-review`<br/>*(or `/review-yeti review`)* | Triggers immediate review re-run without pushing new commits. Evicts any stale queued jobs. | Dynamic / Standard |
| `@review-yeti deep-scan`<br/>*(or `/review-yeti deep-scan`)* | Executes exhaustive architectural, security, and invariant review. | **`max`** (Upstream model thought budget) |
| `@review-yeti explain <file:line>`<br/>*e.g. `@review-yeti explain src/auth/token.ts:50`* | Delivers targeted architectural explanation and call-site breakdown for a specific line. | Dynamic |

---

## Adaptive Thinking Effort & Model-Delegated Reasoning Budgets

Rather than enforcing rigid artificial token budgets or client-side clamps, Review Yeti classifies changes during pre-flight triage (`src/diffHarness/diffTriage.ts`) and delegates the thought budget directly to the upstream model:

```
                      Pre-Flight AST & Risk Triage
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       ▼                           ▼                           ▼
Simple / Batch             Module Clusters             Security / Critical
(`low`)                    (`medium` / `high`)         (`max`)
Doc fixes, typos,          Feature logic, paired       Auth, crypto, fencing,
lockfiles, trivial one-    unit tests, refactors       concurrency, secret handling
liners
       │                           │                           │
       ▼                           ▼                           ▼
Shallow CoT / Fast         Balanced CoT                Deep Exhaustive Reasoning
(Low inference latency)    (Standard depth)            (Full invariant proof)
```

- **`low`**: Prevents wasting 30 seconds of chain-of-thought spinning on trivial typo fixes or package bumps.
- **`medium` / `high`**: Standard balanced reasoning for features and refactors.
- **`max`**: In-depth invariant analysis for security, authorization, and concurrency primitives.
- Mapped natively to upstream engine parameters: `reasoning_effort` (OpenAI), thinking budgets (Anthropic), or provider flags (LiteLLM/Bifrost).

---

## Ephemeral R2 Workspace Cache Lifecycle (1-Hour Aggressive Expiry)

PR review iterations are bursty and transient: active review cycles happen within minutes of a developer pushing code. Storing full Git checkouts and Zoekt symbol indices for weeks causes massive R2 storage accumulation across abandoned branches.

Review Yeti employs a two-tier lifecycle model on `review-yeti-workspace-cache`:
- **`*/pr-*`**: **1-hour expiration rule**. Automatically purges transient PR caches after review completion.
- **`*/base-*` / `*/main`**: **24-hour retention**. Preserves warm base repositories for instant shallow delta clones.
- **Sub-300ms Hydration**: Streaming decompression (`tar -I "zstd -T0"`) provides instantaneous workspace setup when warm, with zero-risk fallback to shallow git clone when cold.

---

## Core Control Plane Primitives

### 1. `RepoGateDO` (SQLite Durable Object)
Manages per-repository concurrency limits (`MAX_CONCURRENT_JOBS = 5`):
- Single-threaded actor isolation backed by Cloudflare SQLite Durable Object storage.
- In-memory FIFO queue with persistence guarantees: when an active review completes or cancels, the next waiting run is automatically granted the concurrency slot.
- Exposes endpoints for active run lookup, queue eviction, and tombstone tracking.

### 2. `ReviewRunDO` (SQLite Durable Object)
The single-run coordinator replacing `PRReviewJob` CRDs and Kubernetes `coordinationv1.Lease`:
- **Atomic Fencing Epochs**: Epoch increments prevent stale workers or split-brain runners from submitting findings or holding locks.
- **Two-Tier In-Flight Cancellation**:
  - *Push Path*: When a PR is closed, converted to draft, or a newer commit arrives, `ReviewRunDO.requestCancellation()` transitions phase to `Cancelled` and signals container termination.
  - *Pull Path*: Exposes `/api/dispatch/runs/:runId/status`. Workers periodically poll `isCurrentHead === true`; if false, the worker's root `AbortController` fires, terminating upstream LLM inference streams instantly to save token costs.

### 3. `ReviewJobWorkflow` (Cloudflare Workflow)
A durable, multi-step execution pipeline extending `WorkflowEntrypoint`:
- **Step 1 (`mint-scoped-token`)**: Mints an ephemeral GitHub App token scoped exclusively to `checks:write` and `pull_requests:write`.
- **Step 2 (`acquire-fencing-lease`)**: Acquires the concurrency slot and registers fencing lease in `ReviewRunDO`.
- **Step 3 (`dispatch-container`)**: Dispatches the worker container via `ContainerRunner` interface.
- **Step 4 (`verify-and-record-receipt`)**: Validates terminal outcome receipt and writes audit record to PostgreSQL via Hyperdrive.
- **Step 5 (`cleanup-and-release`)**: Saga compensating step that guarantees token revocation and concurrency slot release.

### 4. Dynamic Settings & Onboarding Engine (`settingsRoutes.ts`, `d1Client.ts`)
- **Cloudflare D1 Relational Storage (`0003_settings_and_onboarding.sql`)**: Schemas for `organizations` and `repositories` storing numeric repository IDs, installation IDs, custom strictness profiles (`chill`, `balanced`, `assertive`), and operator passthrough flags.
- **Dynamic Passthrough Enrollment**: `resolveRepositoryIdentities()` queries D1 storage at runtime to enroll private enterprise repositories on demand without hardcoding private customer names or repo IDs into public git files (`wrangler.toml`).
- **Webhook Zero-Touch Auto-Enrollment**: Listens to GitHub's `installation` and `installation_repositories` events to automatically provision new organizations and repositories with passthrough enabled.
- **REST Endpoints (`/api/settings/*`)**:
  - `GET /api/settings/status`: Reports health, active storage engine, and repository count.
  - `GET /api/settings/github/install-url`: Generates dynamic 1-click GitHub App install URL.
  - `POST /api/settings/github/installations/:id/sync`: Synchronizes and enrolls authorized repositories.
  - `GET /api/settings/github/installations/:id`: Retrieves installation metadata.
  - Organization CRUD (`/api/settings/orgs`).
  - Repository CRUD (`/api/settings/repos`).
  - Bulk onboarding (`/api/settings/repos/bulk`).

### 5. Edge Model Context Protocol (MCP) Server (18 Tools Total)
Implements JSON-RPC 2.0 and Streamable SSE transport (`/api/mcp` and `/api/mcp/sse`) enabling AI coding agents to control and observe Review Yeti:
- **Inspection & Reporting**:
  - `review_yeti_query_active_jobs`: Active reviews in progress.
  - `review_yeti_query_findings`: Query findings by severity and path.
  - `review_yeti_get_cloudflare_status`: Edge Durable Object and R2 cache health.
  - `review_yeti_get_billable_runtime_report`: Billable compute runtimes and savings.
  - `review_yeti_get_runtime_metrics`: Turnaround latencies (p50, p75, p90, p95, p99).
  - `review_yeti_get_analytics_dashboard`: Executive review KPIs and hotspot files.
- **Lifecycle & Governance (Mutating)**:
  - `review_yeti_trigger_review`: Manually trigger or re-run reviews.
  - `review_yeti_cancel_review`: Evict and cancel in-flight jobs.
  - `review_yeti_purge_cache`: Evict expired workspace caches.
  - `review_yeti_attest_pr_gate`: Validate gate status and generate attestation tokens.
  - `review_yeti_dispute_finding`: File developer disputes against false positive findings.
  - `review_yeti_reply_review_thread`: Post replies to review threads.
- **Settings & Onboarding**:
  - `review_yeti_sync_github_installation` *(Mutating)*: Auto-discover and sync GitHub installations into D1.
  - `review_yeti_get_onboarding_status`: Total organizations, active repositories, and passthrough counts.
  - `review_yeti_list_repositories`: Filter enrolled repositories by owner, passthrough, and automation.
  - `review_yeti_onboard_organization` *(Mutating)*: Register organizations and defaults.
  - `review_yeti_onboard_repository` *(Mutating)*: Register repositories and configure passthrough.
  - `review_yeti_update_repository_settings` *(Mutating)*: Adjust profiles, automation, or passthrough.

---

## Directory Structure

```
packages/cf-orchestrator/
├── src/
│   ├── worker.ts                  # Webhook ingress, HMAC verification, 10s debounce, ChatOps & dual-dispatch
│   ├── repoGateDO.ts              # SQLite Durable Object: Concurrency semaphore (Cap: 5) & FIFO queue
│   ├── reviewRunDO.ts             # SQLite Durable Object: Fencing lease, heartbeats & 2-tier cancellation
│   ├── reviewJobWorkflow.ts       # Cloudflare Workflow: Multi-step durable coordinator extending WorkflowEntrypoint
│   ├── reviewPublisher.ts         # Phase 2: 1-click inline ```suggestion``` reviews (APPROVE/REQUEST_CHANGES/COMMENT)
│   ├── compareOrchestratorRuns.ts # Parity assertion logic, SHA-256 fingerprinting & CI ledger
│   ├── types.ts                   # Types and Cloudflare environment bindings
│   ├── api/
│   │   ├── settingsRoutes.ts      # REST API for organizations, repositories, and GitHub App sync
│   │   ├── dashboardRoutes.ts     # Dashboard backend & live feeds
│   │   └── actionDispatchRoute.ts # GitHub Actions central ingress
│   ├── mcp/                       # Model Context Protocol JSON-RPC router & 18 edge tools
│   │   ├── mcpRouter.ts           # Protocol handler, CORS, and auth gates
│   │   └── tools/                 # Tool implementations (sync, onboard, dispute, gate, etc.)
│   ├── storage/
│   │   └── d1Client.ts            # Cloudflare D1 relational client & in-memory test store
│   ├── diffHarness/               # DeepSeek-style diff task harness & context compactor
│   │   ├── diffTriage.ts          # Tiered triage (high-risk singular, medium cluster, lumped simple batch)
│   │   ├── activeChangesLedger.ts # Sliding context compactor (< 300 token knowledge ledger)
│   │   ├── diffTaskHarness.ts     # Concurrent task runner with on-demand Zoekt tools
│   │   └── index.ts               # Public exports
│   ├── tunnel/
│   │   ├── toolTunnelDefinition.ts # Declarative YAML parser with ${VAR_NAME} env interpolation
│   │   └── tunnelConfig.ts        # Multi-transport resolver (Direct, Cloudflare Tunnel, Tailscale)
│   └── runners/
│       ├── containerRunner.ts     # Container runner abstraction & Cloudflare Containers runner
│       ├── digitalOceanAgentRunner.ts # DO Managed Agents runner (Firecracker microVMs)
│       └── r2WorkspaceCache.ts    # Programmatic R2 .tar.zst cache hydration & verification
├── migrations/                    # Cloudflare D1 SQL schema migrations (0001, 0002, 0003)
├── scripts/
│   ├── restore-r2-cache.sh        # Sub-300ms R2 cache unpack replacing K8s PVCs
│   └── stage-r2-cache.sh          # Stage .git & .zoekt index shards back to Cloudflare R2
├── test/                          # Comprehensive test suite: 1,180 tests across 262 suites (100% pass)
│   ├── e2e/                       # 74 Opaque-box E2E integration tests (Tiers 1–4)
│   ├── mcp/                       # MCP JSON-RPC, SSE, mutating auth, and tool unit tests
│   ├── settingsApi.test.ts        # Settings REST API, CRUD, bulk onboarding, and webhook tests
│   ├── phase2_review_chatops.test.ts # Phase 2: 10 tests for suggestions, verdicts & ChatOps parsing
│   ├── diffTaskHarness.test.ts    # DeepSeek task harness, triage, and context compactor tests
│   ├── adversarial_control_plane.test.ts  # Tier 5: 40 Edge control plane stress tests
│   ├── adversarial_runners_parity.test.ts # Tier 5: 53 Runner & parity stress tests
│   └── adversarial_hardening.test.ts      # Tier 5: 22 Final hardening tests
└── wrangler.toml                  # Cloudflare DO, Workflow, Queue, R2, D1, and Concurrency config
```

---

## Continuous Integration & Parity Testing

The orchestrator is fully integrated into GitHub Actions via `.github/workflows/review-yeti-cf-orchestrator-ci.yaml`:

- **Automatic Triggering**: Runs on every pull request and push touching `packages/cf-orchestrator/**` or `scripts/ci/**`.
- **Complete Verification Pipeline**:
  - Compiles TypeScript (`npm run build`).
  - Executes all 1,180 unit, contract, API, and MCP tests (`npm test`).
  - Total: **1,180 tests across 262 suites (100% pass rate)**.
  - Verifies the CI parity CLI tool (`scripts/ci/compare-orchestrator-runs.js`).

---

## Operational Status: Non-Destructive Parallel Parity

> [!IMPORTANT]
> **DOKS Invariant**: The legacy Kubernetes operator deployment (`ct-review-yeti-operator`) is running and active in production. It continues to post the primary authoritative `"Review Yeti"` checks on GitHub pull requests. **Do not scale down DOKS, terminate node pools, or delete PVCs** during the ongoing shadow validation phase.

### Live Configuration Reference
```toml
# wrangler.toml
[vars]
ENVIRONMENT = "production"
PARALLEL_MODE = "true"
PARALLEL_CHECK_NAME = "Review Yeti (Cloudflare Canary)"
DOKS_FALLBACK_URL = "https://review-bot.example.com/api/webhooks/github"
MAX_CONCURRENT_JOBS = "5"
DEBOUNCE_WINDOW_SECONDS = "10"
PILOT_REPOSITORIES = "exampleorg/example-workspace,all"
```

### Future Production Cutover Runbook (Post-Parity Validation)
Once shadow parity is verified across 100+ consecutive real-world PR reviews:
1. Promote Check Name in `wrangler.toml`:
   ```toml
   PARALLEL_CHECK_NAME = "Review Yeti"
   DOKS_FALLBACK_URL = "" # Cease fanout
   ```
2. Redeploy Worker: `npm run deploy`
3. Scale Down DOKS:
   ```bash
   kubectl scale deployment ct-review-yeti-operator -n review-yeti --replicas=0
   kubectl delete pvc -l app=ct-review-yeti -n review-yeti
   ```
4. Reclaim dedicated DOKS node pool.

---

## Quick Commands

```bash
# Run unit & contract tests (819 tests across 197 suites)
npm test

# Run End-to-End integration suite (74 tests across 14 suites)
npm run test:e2e

# Build TypeScript
npm run build

# Deploy to Cloudflare Edge
npm run deploy

# Stream live edge logs
npx wrangler tail --format pretty
```
