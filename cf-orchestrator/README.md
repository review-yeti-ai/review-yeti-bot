# Review Yeti: Cloudflare-Native Orchestration Engine

A serverless, Kubernetes-free orchestration engine for **Review Yeti**, built on **Cloudflare Workers**, **SQLite Durable Objects**, **Cloudflare Workflows**, **Cloudflare Queues**, and **Cloudflare Containers / Firecracker MicroVMs**.

> **Live Edge Endpoint**: [`https://review-yeti-cf-orchestrator.example.workers.dev`](https://review-yeti-cf-orchestrator.example.workers.dev)  
> The Worker is the authoritative Review Yeti orchestrator: it posts the `"Review Yeti"` check and PR reviews with 1-click inline suggestions.

For the Doppler-to-Worker MCP credential projection and authenticated operator connection check,
see [Cloudflare MCP operator connection](../docs/CLOUDFLARE_MCP_OPERATOR_CONNECTION.md).

## Paused publication enrollment configuration

Paused publication reads the existing Worker bindings below. They hold the exact repository enrollment and
protected policy-source manifests; the values are deployment-owned and intentionally omitted from tracked
Wrangler source:

- `OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES`
- `OPERATOR_PASSTHROUGH_POLICY_SOURCE`

For an existing Worker, both bindings must remain provisioned for paused publication to work. Keep `keep_vars = true`
enabled when deploying this source so remotely managed variables omitted from the tracked `[vars]` block are retained.
The tracked configuration does not declare these bindings as Wrangler-required secrets. Runtime fails closed if
either binding is absent or invalid. This source change does not verify live binding readback or manifest contents.

For a fresh Worker or environment without these bindings, provision both names on the intended Worker before
enabling paused publication. Use the approved deployment source and protected operator input through the Cloudflare
dashboard or `wrangler secret bulk`; verify the binding setup through the deployment process before use. `keep_vars`
does not provision values for a new Worker.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph GH_IN["GitHub Ingress"]
        PR_EVENT["PR Events<br/>(opened, synchronize, closed)"]
        CHATOPS_EVENT["Issue Comment ChatOps<br/>(@review-yeti re-review | deep-scan | explain)"]
    end

    subgraph PROXY["Cloudflare Edge Ingress"]
        WORKER["Ingress Worker (src/worker.ts)<br/>HMAC SHA-256 Verification"]
        DEBOUNCE_QUEUE["Cloudflare Queue<br/>10s Debounce Window"]
    end

    subgraph CF_CONTROL["Cloudflare Edge Control Plane"]
        REPO_GATE["RepoGateDO (SQLite Durable Object)<br/>FIFO Concurrency Semaphore (Cap: 5)"]
        REVIEW_RUN["ReviewRunDO (SQLite Durable Object)<br/>Fencing Epochs & 2-Tier Cancellation"]
        WORKFLOW["ReviewJobWorkflow (WorkflowEntrypoint)<br/>Multi-Step Saga Coordinator"]
        HYPERDRIVE["Hyperdrive Pooler -> PostgreSQL<br/>Audit Ledger"]
    end

    subgraph DIFF_HARNESS["DeepSeek-Style Diff Task Harness"]
        TRIAGE["Pre-Flight Triage (src/diffHarness/)<br/>Tiers: low | medium | high | max"]
        ACTIVE_LEDGER["Active Changes Knowledge Ledger<br/>Sliding Compactor (< 300 tokens)"]
        GROUNDING["On-Demand Tools<br/>(zoektLookup, grepFile)"]
    end

    subgraph RUNNERS["Execution Plane"]
        CF_RUNNER["Cloudflare Container Runner<br/>(Edge-Colocated OCI Sandboxes)"]
        R2_CACHE[("Cloudflare R2 Workspace Cache<br/>(.tar.zst with 1-Hour Lifecycle Rule)")]
    end

    subgraph PUBLISHING["GitHub Publishing Plane (Phase 2)"]
        REVIEW_CHECK["GitHub Checks API<br/>'Review Yeti'"]
        INLINE_REVIEWS["GitHub PR Reviews API<br/>1-Click Inline ```suggestion``` Blocks<br/>(APPROVE | REQUEST_CHANGES | COMMENT)"]
    end

    %% Ingress Flow
    PR_EVENT --> WORKER
    CHATOPS_EVENT --> WORKER
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

    WORKFLOW -->|Step 3: Dispatch Worker| CF_RUNNER
    CF_RUNNER <-->|Sub-300ms Unpack / Pack| R2_CACHE
    CF_RUNNER --> GROUNDING

    %% Two-Tier Cancellation Flow
    REVIEW_RUN -.->|Push Abort Signal| CF_RUNNER
    CF_RUNNER -.->|Pull Polling /api/dispatch/runs/:id/status| REVIEW_RUN

    %% Output Flow
    CF_RUNNER -->|Step 4: Post Review Check| REVIEW_CHECK
    CF_RUNNER -->|Step 5: Publish Inline Reviews| INLINE_REVIEWS
    CF_RUNNER -->|Step 6: Terminal Receipt| WORKFLOW
    WORKFLOW -->|Step 7: Record Audit Receipt| HYPERDRIVE
    WORKFLOW -->|Step 8: Saga Release Slot| REPO_GATE
```

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
The single-run coordinator:
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

---

## Directory Structure

```
packages/cf-orchestrator/
├── src/
│   ├── worker.ts                  # Webhook ingress, HMAC verification, 10s debounce & ChatOps
│   ├── repoGateDO.ts              # SQLite Durable Object: Concurrency semaphore (Cap: 5) & FIFO queue
│   ├── reviewRunDO.ts             # SQLite Durable Object: Fencing lease, heartbeats & 2-tier cancellation
│   ├── reviewJobWorkflow.ts       # Cloudflare Workflow: Multi-step durable coordinator extending WorkflowEntrypoint
│   ├── reviewPublisher.ts         # Phase 2: 1-click inline ```suggestion``` reviews (APPROVE/REQUEST_CHANGES/COMMENT)
│   ├── types.ts                   # Types and Cloudflare environment bindings
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
│       └── r2WorkspaceCache.ts    # Programmatic R2 .tar.zst cache hydration & verification
├── scripts/
│   ├── restore-r2-cache.sh        # Sub-300ms R2 cache unpack
│   └── stage-r2-cache.sh          # Stage .git & .zoekt index shards back to Cloudflare R2
├── test/                          # Unit, contract, adversarial and end-to-end test suites
│   ├── e2e/                       # Opaque-box E2E integration tests (Tiers 1–4)
│   ├── phase2_review_chatops.test.ts # Phase 2: suggestions, verdicts & ChatOps parsing
│   ├── diffTaskHarness.test.ts    # DeepSeek task harness, triage, and context compactor tests
│   ├── adversarial_control_plane.test.ts  # Tier 5: Edge control plane stress tests
│   ├── adversarial_runners.test.ts        # Tier 5: Runner & R2 cache stress tests
│   └── adversarial_hardening.test.ts      # Tier 5: Final hardening tests
└── wrangler.toml                  # Cloudflare DO, Workflow, Queue, R2, Hyperdrive, and Concurrency config
```

---

## Continuous Integration

The orchestrator is integrated into GitHub Actions via `.github/workflows/cf-orchestrator-ci.yaml`:

- **Automatic Triggering**: Runs on every pull request and push touching `cf-orchestrator/**` or `src/**`.
- **Complete Verification Pipeline**:
  - Compiles TypeScript (`npm run build`).
  - Executes the unit, contract, and adversarial tests (`npm test`).
  - Executes the E2E integration suite (`npm run test:e2e`).
- **Deploy**: A push to `main` deploys the Worker to the Cloudflare edge.

---

## Configuration Reference

```toml
# wrangler.toml
[vars]
ENVIRONMENT = "production"
PARALLEL_CHECK_NAME = "Review Yeti"
MAX_CONCURRENT_JOBS = "5"
DEBOUNCE_WINDOW_SECONDS = "60"
PILOT_REPOSITORIES = "all"
RUNNER_TYPE = "cloudflare"
```

---

## Quick Commands

```bash
# Run unit & contract tests
npm test

# Run End-to-End integration suite
npm run test:e2e

# Build TypeScript
npm run build

# Deploy to Cloudflare Edge
npm run deploy

# Stream live edge logs
npx wrangler tail --format pretty
```
