# Semantic review canary (operator passthrough ON) — engineering report

This document describes wiring verification, code changes in `review-yeti-ai/review-yeti-bot`, and what must be validated after merge/deploy. It was produced in an agent environment without GitHub credentials to the `review-yeti-ai` org; **live PR runs and spend numbers are deferred to post-merge verification** (see “Sample run”).

## A. Separate passthrough settings (verify)

### 1. review-yeti-ai GitHub Actions → Cloudflare Workers deploy

- **Source:** `.github/workflows/cf-orchestrator-ci.yaml`
- On deploy, `OPERATOR_GLOBAL_PASSTHROUGH` is set from the org/repo variable **`vars.REVIEW_YETI_PASSTHROUGH`**, defaulting to **`'true'`** if unset:

  ```yaml
  OPERATOR_GLOBAL_PASSTHROUGH: ${{ vars.REVIEW_YETI_PASSTHROUGH || 'true' }}
  ```

- **Wrangler vars** also pass **`OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES`** (from `vars.OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES`) and **`REVIEW_RUN_USD_CAP`** (from `vars.REVIEW_RUN_USD_CAP || '0.50'`).

- **`cf-orchestrator/wrangler.toml`** keeps **`OPERATOR_GLOBAL_PASSTHROUGH = "true"`** as repository default; production values continue to come from the deploy workflow / Cloudflare dashboard.

### 2. In-worker vs Actions naming

- **`OPERATOR_GLOBAL_PASSTHROUGH`**: primary ingress flag used by Action dispatch, webhook fast-path debounce, operator pause binding checks in `operatorPassthroughPublisher.ts`, MCP tools (`triggerReview`, `attestPrGate`), and merge-group attestation when deciding whether the `:review-mode=passthrough:op2` check suffix is allowed.
- **`REVIEW_YETI_PASSTHROUGH` / `PASSTHROUGH_MODE`**: read by **`isPassthroughMode()`** in `cf-orchestrator/src/auth/passthrough.ts` (documented as global). **`ReviewJobWorkflow`** uses `OPERATOR_GLOBAL_PASSTHROUGH` if set, otherwise falls back to `isPassthroughMode(env)` for the pause step — unchanged except that exempt repos now force the semantic path (see below).

### 3. Other operator GitOps repos (out of scope here)

- **Not modified in this PR** (per scope). Any **queue mode** or **Proxmox/Kubernetes dispatch** configuration in external operator repositories is a **separate control plane** from the **review-yeti-ai** `REVIEW_YETI_PASSTHROUGH` variable and **Wrangler** `OPERATOR_GLOBAL_PASSTHROUGH`. This codebase only reflects the **Cloudflare orchestrator + Cloudflare Containers** path documented in `cf-orchestrator`.

## B. Canary repo and scoping

- **Chosen canary:** `review-yeti-ai/review-yeti-qualification` (“Request Routing Workbench”) — **no new dummy repo** was required.
- **Scoping:** comma-separated env **`OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES`**. Only listed `owner/repo` values skip the Action-dispatch and webhook passthrough short-circuits while **`OPERATOR_GLOBAL_PASSTHROUGH === 'true'`**.
- **Fail-closed:** if the exempt list is **empty or unset**, **no** repository is exempt (everyone stays on passthrough when global pause is on).

## C. Pilot admission vs paused-publication enrollment

- **`PILOT_REPOSITORIES`**: gates **which repos** may trigger edge dispatch / webhooks at all (comma list or `all`). **Not** the same as semantic-review admission for paused mode.
- **`OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES`**: enrollment for **paused-publication** identity binding (`operatorPassthroughPublisher.ts`); **not** a semantic-review allowlist.

Operators must ensure **`PILOT_REPOSITORIES`** includes the qualification repo (often already `all` in `wrangler.toml`).

## D. $0.50 USD per-run enforcement

- **New Worker var:** **`REVIEW_RUN_USD_CAP`** (default **`0.50`** in `wrangler.toml`; overridable via `vars.REVIEW_RUN_USD_CAP` in CI).
- **Forwarded** into the container env from **`reviewJobWorkflow.ts`** as **`REVIEW_RUN_USD_CAP`**.
- **Enforced in the publishing worker** (`src/cli/publishingReview.ts`): after each OpenRouter response, the **token ledger’s cumulative `costUSD`** is compared to the cap. The next provider round-trip is rejected with **`UpstreamCapacityRejectionError`** if spend would exceed the cap.
- **Scope:** OpenRouter-reported **`costUSD` only** (same basis as `TokenLedger`). It does **not** include Cloudflare Container **compute** (`runnerCost` in `cf-orchestrator/src/runners/runnerCost.ts`) or other fees.
- **`REVIEW_YETI_BUDGET`** (see `docs/features/review_budget.md`) remains a **content/packing** flag for lane context — **not** a dollar cap.

## E. Proxmox / Kubernetes / CT-agent vs Cloudflare

| Path | Verdict in this repo |
|------|----------------------|
| **Cloudflare orchestrator** (`cf-orchestrator`) + **Workflow** + **Containers** (`RUNNER_TYPE=cloudflare`, `reviewJobWorkflow.getRunner`) | **Live / supported** — only runner type accepted; anything else **fails closed**. |
| **K8s “publishing” lane** in `src/cli/publishingReview.ts` comments | **Legacy narrative** about an old operator path; current edge dispatch uses **Cloudflare Containers** + worker image entrypoint `runLiveReview.js`. |
| **Proxmox lab / external queue (operator-run infra)** | **Not present** in this repository; treat as **out-of-repo** unless wired via env/bindings. |

`src/telemetry/metrics.ts` mentions `REVIEW_YETI_WORKER_METRICS_ENDPOINT` (k8s-operator) as an **optional** metrics hook — not evidence of an active K8s review path here.

## F. Sample run (tokens, context, cost) — post-merge checklist

The agent could not open a GitHub PR or read live check-run output in this environment. After merge and deploy:

1. Set org/repo GitHub **variables** (if not using `wrangler.toml` defaults only):  
   - `OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES` = `review-yeti-ai/review-yeti-qualification`  
   - `REVIEW_RUN_USD_CAP` = `0.50`  
   - Keep **`REVIEW_YETI_PASSTHROUGH`** = `true`.
2. Open or update a **small PR** in `review-yeti-ai/review-yeti-qualification`.
3. Confirm the **Review Yeti** check is **not** the passthrough-only receipt (summary should **not** claim “zero lanes” / `review-mode=passthrough` for a full semantic run).
4. In worker logs, find **`Review token accounting`** (`tokenAccounting` / `total.costUSD`) and confirm:
   - **Spend stays ≤ $0.50** from OpenRouter, or the run **fails** with a cap message after crossing the threshold.

## G. Optimization notes

- The cap is evaluated **per provider response**; the **last** response can bring cumulative spend up to just under the following rejection — acceptable for a canary.
- If **`costUSD`** is missing from a response, ledger cost may under-report; enforcement still follows whatever OpenRouter returns.

## H. Risks / gaps

- **Merge queue:** exempt repos no longer treat `:review-mode=passthrough:op2` as a valid substitute for a semantic check (see `mergeGroupOperatorPassthroughMode`). MQ workflows for the canary repo must pass **real** Review Yeti success checks.
- **Compute cost** is **outside** `REVIEW_RUN_USD_CAP`; track **runner cost** separately if needed.
- **Live E2E** in CI may fail without **`zstd`** / archive tooling (`cf-orchestrator` adversarial benchmarks); targeted unit tests for this change were run successfully.

## I. Readiness

- **Global passthrough:** remains **ON** (`OPERATOR_GLOBAL_PASSTHROUGH` / `REVIEW_YETI_PASSTHROUGH` still default true; exempt list adds a **narrow** semantic path).
- **Canary:** ready after **`OPERATOR_PASSTHROUGH_EXEMPT_REPOSITORIES`** is set in GitHub Actions variables for deploy and **`PILOT_REPOSITORIES`** covers the repo.
- **$0.50 enforcement:** **implemented** for OpenRouter token spend in the publishing worker when `REVIEW_RUN_USD_CAP` is set; **not** verified end-to-end in this run (see section F).
