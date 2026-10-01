# Getting Started with the Review Yeti Cloudflare Orchestrator

This guide walks you through setting up, deploying, and operating the Cloudflare-native orchestration engine for Review Yeti—running in parallel with the production DOKS (Kubernetes) operator for zero-risk shadow validation.

> [!IMPORTANT]
> **Active Production State: Parallel Shadow Canary Mode**  
> - **Live Edge Endpoint**: [`https://review-yeti-cf-orchestrator.call-telemetry.workers.dev`](https://review-yeti-cf-orchestrator.call-telemetry.workers.dev)  
> - **Operational Invariant**: The DOKS Kubernetes operator (`ct-review-yeti-operator`) is running and authoritative in production, posting the primary `"Review Yeti"` checks.  
> - **Cloudflare Canary**: Cloudflare evaluates incoming PRs concurrently, publishing non-blocking `"Review Yeti (Cloudflare Canary)"` checks and PR reviews with 1-click inline suggestions.  
> - **Do NOT shut down DOKS, delete PVCs, or terminate node pools** until shadow parity is verified across 100+ consecutive real-world PR runs.

---

## 1. Prerequisites

Before getting started, make sure you have:

- **Node.js**: v24.x or later (`node -v`)
- **Cloudflare Account**: Workers Paid plan (supports SQLite Durable Objects, Workflows, Queues, and R2)
- **Wrangler CLI**: v3.80.0 or later (`wrangler -v`)
- **GitHub App Credentials**:
  - GitHub App ID
  - GitHub App Private Key (`.pem`)
  - Webhook Secret
- **DigitalOcean MARS API Token** (for Firecracker microVM execution) or Cloudflare Containers access
- **PostgreSQL Database** (connected via Cloudflare Hyperdrive)

---

## 2. Installation & Local Verification

Clone the repository and install the orchestrator dependencies:

```bash
cd packages/cf-orchestrator
npm install
```

Run the automated test suite:

```bash
# Run unit, contract, and adversarial test suites
npm test

# Run End-to-End integration test suite (Tiers 1-4)
npm run test:e2e
```

All **893 tests** pass cleanly across 211 suites (819 unit & contract across 197 suites + 74 E2E across 14 suites):

```
✔ Webhook Ingress Worker & ChatOps Ingress (src/worker.ts)
✔ RepoGateDO SQLite Concurrency Gate & FIFO Queue (src/repoGateDO.ts)
✔ ReviewRunDO SQLite Coordinator & Fencing Epochs (src/reviewRunDO.ts)
✔ ReviewJobWorkflow Durable Execution (src/reviewJobWorkflow.ts)
✔ Phase 2: Review Publisher & 1-Click Inline Suggestions (src/reviewPublisher.ts)
✔ Tool & MCP Tunnel YAML Definition (src/tunnel/toolTunnelDefinition.ts)
✔ Tunnel Auto-Detection & Resolution (src/tunnel/tunnelConfig.ts)
✔ DeepSeek-Style Diff Task Harness & Context Compactor (src/diffHarness/)
✔ Container & DO Agent Runners (src/runners/)
✔ R2 Workspace Cache Hydration (src/runners/r2WorkspaceCache.ts)
✔ compareRuns Parity Assertion (src/compareOrchestratorRuns.ts)
✔ Tier 5 Adversarial Control Plane & Runner Stress Suites
✔ Tiers 1-4 End-to-End Scenarios & Shadow Parity Verification
ℹ tests 893 | suites 211 | pass 893 | fail 0
```

---

## 3. Cloudflare Infrastructure Provisioning

Run the following Wrangler commands to provision Cloudflare resources:

### 3.1 Create R2 Workspace Cache Bucket
```bash
npx wrangler r2 bucket create review-yeti-workspace-cache
```

### 3.2 Configure 1-Hour R2 Cache Lifecycle Rule
PR reviews are bursty; caching workspace diffs beyond active PR iterations accumulates dead storage.

In the Cloudflare Dashboard (**R2 > review-yeti-workspace-cache > Settings > Lifecycle Rules**) or via S3 API, configure:
1. **Rule 1 (PR Workspaces)**:
   - **Prefix**: `*/pr-*`
   - **Action**: Delete after **1 hour**
2. **Rule 2 (Base Repositories)**:
   - **Prefix**: `*/base-*` or `*/main`
   - **Action**: Delete after **24 hours**

### 3.3 Create Debounce Queue
```bash
npx wrangler queues create review-yeti-debounce
```

### 3.4 Create Hyperdrive Link to PostgreSQL
```bash
npx wrangler hyperdrive create hyperdrive-postgres-reviewyeti \
  --connection-string="postgres://user:password@db.example.com:5432/reviewyeti?sslmode=require"
```
*(Copy the returned Hyperdrive ID into `wrangler.toml` under `[[hyperdrive]] id = "..."`)*

---

## 4. Phase 2: PR Review Experience & ChatOps

Phase 2 introduces two major interaction features directly inside GitHub Pull Requests.

### 4.1 1-Click Inline Suggestions
When Review Yeti identifies a code improvement or bug fix, it posts an inline review comment using GitHub's ````suggestion``` block directly on the diff:

- **Review Verdicts**:
  - `APPROVE`: Zero blocking issues; all policy checks pass.
  - `REQUEST_CHANGES`: Triggered when **P0** (critical vulnerability/crash) or **P1** (functional defect) issues are detected.
  - `COMMENT`: Advisory suggestions, style recommendations, or P2/P3 improvements.
- **1-Click Application**: Developers click **"Apply suggestion"** directly in GitHub's "Files Changed" tab to commit the fix instantly.

### 4.2 PR ChatOps Commands
Developers can interact with Review Yeti by posting comments on any PR:

```
@review-yeti re-review
```
> Triggers an immediate re-review on the PR's current head commit without requiring a git push. Evicts any stale queued runs.

```
@review-yeti deep-scan
```
> Dispatches an intensive review with **`thinkingEffort: "max"`**. Upstream reasoning models allocate maximum thought budgets to audit complex concurrency, security invariants, or multi-module refactors.

```
@review-yeti explain src/auth/token.ts:50
```
> Dispatches a targeted analysis explaining the security or architectural context of the specified file and line number.

---

## 5. Adaptive Thinking Effort & Model Reasoning Budgets

The engine categorizes diffs during pre-flight triage into 4 reasoning tiers:

| Tier | PR Characteristics | Upstream Model Thought Budget |
|---|---|---|
| **`low`** | Doc typos, version bumps, `echo true`, lockfile updates | Minimal / shallow reasoning (fast, low cost) |
| **`medium`** | Standard feature logic, module clusters with unit tests | Standard balanced reasoning |
| **`high`** | Complex multi-file refactors, high churn logic | Deep reasoning |
| **`max`** | Security-critical paths, crypto, fencing, auth, or `@review-yeti deep-scan` | Maximum reasoning effort |

These tiers are mapped directly to upstream model parameters (e.g. OpenAI `reasoning_effort: "low" | "medium" | "high"`, Anthropic thinking budget tokens, or LiteLLM/Bifrost flags). **No artificial client-side token clamps are applied.**

---

## 6. Setting Up Non-Destructive Parallel Parity with DOKS

To validate the Cloudflare engine alongside the existing DOKS production deployment with **zero risk**:

### 6.1 `wrangler.toml` Ingress Configuration
```toml
# wrangler.toml
[vars]
ENVIRONMENT = "production"
PARALLEL_MODE = "true"
PARALLEL_CHECK_NAME = "Review Yeti (Cloudflare Canary)"
PILOT_REPOSITORIES = "calltelemetry/ai-workspace,all"
DOKS_FALLBACK_URL = "https://review-bot.calltelemetry.com/api/webhooks/github"
MAX_CONCURRENT_JOBS = "5"
DEBOUNCE_WINDOW_SECONDS = "10"
RUNNER_TYPE = "digitalocean"
```

### 6.2 Populate Production Secrets
Store secrets in Cloudflare's encrypted key-value store:
```bash
# GitHub App Authentication
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY

# DigitalOcean MARS Token (Firecracker microVM provisioning)
npx wrangler secret put DO_API_TOKEN

# Cloudflare Zero Trust (for private LLM/Honcho tunnels)
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

### 6.3 Deploy to Cloudflare Edge
```bash
npm run deploy
```

### 6.4 Point GitHub Webhook to Cloudflare
In your GitHub App settings, set the Webhook URL to:  
`https://review-yeti-cf-orchestrator.call-telemetry.workers.dev/api/webhooks/github`

### 6.5 Operational Execution Flow
1. **DOKS Remains 100% Primary**: Cloudflare immediately forwards every incoming webhook asynchronously to `DOKS_FALLBACK_URL`. DOKS processes production reviews and posts the authoritative `"Review Yeti"` check.
2. **Cloudflare Canary Shadow**: Cloudflare concurrently processes the review, applies 10s queue debouncing, acquires `RepoGateDO` concurrency slots, coordinates execution via `ReviewJobWorkflow`, and publishes `"Review Yeti (Cloudflare Canary)"` checks alongside Phase 2 inline suggestions.

---

## 7. Benchmarking & Shadow Parity Evaluation

Compare DOKS and Cloudflare run receipts side-by-side using the parity CLI tool:

```bash
node scripts/ci/compare-orchestrator-runs.js \
  --doks-receipt path/to/doks-receipt.json \
  --cf-receipt path/to/cf-receipt.json
```

Sample output:
```
============================================================
 ORCHESTRATOR PARITY REPORT: calltelemetry/ai-workspace @ a1b2c3d
 Status: ✅ MATCH
============================================================
• Verdict Agreement:         YES
• Finding Fingerprint Match: YES (diff: 0)
• Latency Delta:             -7000ms (0.84x faster on Cloudflare)
• Token Usage Delta:         -20
============================================================
```

### Promotion Gate Criteria
Before scheduling full DOKS cutover:
1. **100 Consecutive Matches**: Zero unexplained discrepancies in review verdicts or finding fingerprints.
2. **Cancellation Latency**: Pushing a new commit while a review is in flight cancels the old run within 3 seconds.
3. **Cache Hydration**: Workspace cache restoration from R2 takes < 1.5 seconds.

---

## 8. Future Production Cutover Runbook (Post-Parity Validation)

Once shadow parity criteria are satisfied across real production workloads:

1. **Promote Check Name & Terminate Dual-Dispatch**:
   In `wrangler.toml`:
   ```toml
   PARALLEL_CHECK_NAME = "Review Yeti"
   DOKS_FALLBACK_URL = "" # Cease legacy fanout
   ```
   Deploy:
   ```bash
   npm run deploy
   ```
2. **Decommission DOKS Operator**:
   ```bash
   kubectl scale deployment ct-review-yeti-operator -n review-yeti --replicas=0
   kubectl scale deployment ct-review-job-dispatcher -n review-yeti --replicas=0
   ```
3. **Reclaim PVCs & Worker Node Pools**:
   ```bash
   kubectl delete pvc -l app=ct-review-yeti -n review-yeti
   ```
   Downscale or terminate the dedicated DOKS Kubernetes node pool.

---

## 9. Live Observability & Useful Commands

```bash
# Stream live Cloudflare edge logs
npx wrangler tail --format pretty

# Inspect status of a specific review run DO
curl -s "https://review-yeti-cf-orchestrator.call-telemetry.workers.dev/api/dispatch/runs/<runId>/status" | jq .

# Verify health endpoint
curl -s "https://review-yeti-cf-orchestrator.call-telemetry.workers.dev/health" | jq .
```
