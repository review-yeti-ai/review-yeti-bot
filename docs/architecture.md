# Review Yeti Architecture & Design Principles

This document details the architectural design, security model, and communication patterns of the Review Yeti centralized review ecosystem.

---

## 1. The Centralized Hub-and-Spoke Model

Review Yeti uses a **centralized review architecture** to provide consistent AI-assisted code review across multiple repositories without distributing sensitive credentials or duplicating complex configuration files.

```
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│  Consumer Repo A (PR)  │      │  Consumer Repo B (PR)  │      │  Consumer Repo C (PR)  │
│  - No provider secrets │      │  - No provider secrets │      │  - No provider secrets │
│  - Fast trigger shim   │      │  - Fast trigger shim   │      │  - Fast trigger shim   │
└───────────┬────────────┘      └───────────┬────────────┘      └───────────┬────────────┘
            │                               │                               │
            └───────────────────────┬───────┴───────────────────────────────┘
                                    │ (workflow_dispatch / repository_dispatch)
                                    ▼
                 ┌──────────────────────────────────────┐
                 │    Central Review Hub Repository     │
                 │    - Holds provider secrets          │
                 │    - Owns review persona policies    │
                 │    - Strict cryptographic validation │
                 │    - Bounded concurrency & failover  │
                 └──────────────────┬───────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            │ (Option A: Hosted GHA)                        │ (Option B: K8s Worker)
            ▼                                               ▼
┌───────────────────────────────┐               ┌───────────────────────────────┐
│ GitHub Actions Runner VM      │               │ Kubernetes Worker Cluster     │
│ - Ephemeral runner execution  │               │ - Autoscaling worker pods     │
│ - Streams LLM persona analysis│               │ - Isolated container sandboxes│
└───────────────┬───────────────┘               └───────────────┬───────────────┘
                │                                               │
                └───────────────────────┬───────────────────────┘
                                        │ (POST /repos/:repo/check-runs via GitHub App)
                                        ▼
                         ┌─────────────────────────────┐
                         │ Pull Request Check Run Gate │
                         │ `Review Yeti: SHIP`         │
                         └─────────────────────────────┘
```

### Core Benefits
* **Complete Secret Isolation**: Consumer repositories never carry LLM provider credentials (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`). Secrets live exclusively in the central review repository or Kubernetes cluster.
* **Uniform Governance**: Changes to review personas, model families, prompt templates, or budget caps are made once in the central repository and immediately apply org-wide.
* **No Configuration Drift**: Eliminates divergent `.review-yeti.yml` files scattered across multiple projects.

---

## 2. Evolution of the Dispatch Pattern

### The Legacy Anti-Pattern: Blocking Polling Shim
In early implementations of centralized dispatch, consumer workflows used a "waiter shim":
1. Consumer PR fired a `repository_dispatch` to the central repository.
2. The consumer runner entered a **15–20 minute bash `while` loop** sleeping for 10 seconds and querying `gh api` for the central workflow run status.
3. **The Problem**: This wasted immense amounts of billable runner compute. A 10-persona review on 5 PRs would burn hours of expensive VM minutes doing nothing but executing `sleep 10`.

### The Modern Pattern: Fire-and-Forget + Direct Check Runs
The modern architecture solves this completely:
1. **Fire-and-Forget Dispatch**: The consumer runner validates PR coordinates, sends the dispatch event (`workflow_dispatch` or `repository_dispatch`), logs an audit receipt, and **exits in < 5 seconds**.
2. **Direct Check Run Reporting**: Upon review completion, the central system (either the central GHA runner or the Kubernetes worker pod) uses the **`ct-review-bot` GitHub App token** to call the GitHub Checks API directly:
   ```http
   POST /repos/{target_owner}/{target_repo}/check-runs
   ```
3. **Native Gate Satisfaction**: GitHub Branch Protection and Merge Queues listen directly to the `Review Yeti` Check Run on the commit. No consumer runner needs to stay alive.

---

## 3. Security & Validation Boundary

To prevent unauthorized review requests or replay attacks, the central repository enforces a strict, fail-closed validation contract:

### A. Coordinate-Only Payloads
The dispatch payload accepts only immutable coordinates:
```json
{
  "repository": "example-org/my-project",
  "pr_number": 123,
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "head_sha": "fedcba9876543210fedcba9876543210fedcba98",
  "request_id": "my-project:123:fedcba9...:1001:1"
}
```
No inline prompts, custom model parameters, or configuration overrides are permitted in the payload.

### B. Fail-Closed Target Verification
Before executing any review step, the central dispatch validator (`scripts/validate-central-dispatch.mjs`):
1. Verifies that the requested repository belongs to the authorized organization.
2. Calls the GitHub API using the GitHub App token to ensure the PR is currently open.
3. Asserts that the live base SHA and head SHA match the dispatch payload byte-for-byte. If a contributor pushes a new commit while a dispatch is queued, the stale run immediately halts.

### C. Atomic Generation Reservation

The central `repository-dispatch.yml` workflow serializes the full admission run
by exact repository, pull request, and head SHA with `cancel-in-progress: false`.
New heads use different groups and can proceed independently. While holding the
exact-head lease, central validation reads every page of the raw `Review Yeti`
check ledger from App ID `4385771`, validates every row before classification,
and admits only an initial `a1` with no worker ledger or bounded recovery
generations `a2` and `a3`. Every lower generation must appear exactly once as a
completed App-owned `failure` carrying an approved infrastructure/no-verdict
title, and all prior worker rows must share one identical DOKS `run_<id>`.
Missing, duplicate, mixed-identity, active, successful, or verdict-bearing
generations, attempts `a4` or later, and inventories at the 1,000-run endpoint
cap fail closed. `BLOCK` and `FIX_FIRST` remain terminal review verdicts and can
never justify another generation on the same head.

Workflow concurrency closes the check-before-dispatch race inside GitHub, but it
is not durable generation storage. Every validated central request is forced to
the DOKS App-gate backend. The service-owned repository/PR/head identity and
database compare-and-swap own worker-attempt allocation. Central validation
exports its admitted generation through both workflows as the action's explicit
`expected-generation`, which the allocator compares to its next attempt. That
DOKS CAS plus the central serial revalidation and exact-generation handoff is
the atomic reservation boundary; repository variables and local execution
cannot weaken it.

An explicit `review-yeti/refresh` label is only a signed request to inspect that
ledger. Its newly created caller workflow may start at `github.run_attempt == 1`,
so central derives `a2` or `a3` from the contiguous worker identities instead of
trusting the label run's attempt number. Rerunning the original caller remains
supported; neither route can replace active or terminal results or exceed `a3`.

The receiver's validation token is restricted to the target repository plus
`example-review-actions`, deduplicated for central self-review. That is the minimum
repository scope needed to read both the target's exact-head ledger and the
central workflow runs used for capacity admission.

### D. Self-Cancellation of Superseded Runs
If multiple commits are pushed in rapid succession, earlier in-flight central runs detect that `head_sha` has moved and self-cancel, avoiding wasted model tokens on outdated code.
