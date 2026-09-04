# Kubernetes & DOKS Execution Mode

Review Yeti supports offloading compute-intensive review workloads from GitHub Actions runners into a **Kubernetes cluster** (such as DigitalOcean Kubernetes Service - DOKS, EKS, GKE, or on-prem k8s).

This document explains the architecture, dispatch flow, worker container specification, and operational benefits of running Review Yeti in Kubernetes mode.

---

## Why Kubernetes Worker Mode?

While hosted GitHub Actions runners are convenient, complex multi-persona AI reviews on large pull requests present operational challenges:
1. **Billable Runner Costs**: Running multi-turn LLM persona evaluations can take 2 to 10 minutes per PR head. Holding billable GHA or cloud runners idle while waiting for network stream completions burns runner minutes.
2. **Private Infrastructure & Self-Hosted Models**: Organizations often want to run reviews against self-hosted models (via Ollama, vLLM, or private GPU clusters) accessible only within a private VPC or Kubernetes service mesh.
3. **True Elastic Scalability**: A busy development team with dozens of concurrent PR pushes can overwhelm hosted runner concurrency quotas. A Kubernetes cluster autoscales worker pods on demand.

---

## Architecture Overview

```
 ┌────────────────────────────────────────────────────────┐
 │ 1. Consumer Pull Request                               │
 │    - PR created or updated with new commit SHA         │
 └──────────────────────────┬─────────────────────────────┘
                            │
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │ 2. Lightweight GitHub Actions Dispatch (< 10 seconds)   │
 │    - Validates immutable PR coordinates                │
 │    - Sends review request to Central Action            │
 │    - Calls K8s Gateway: POST /api/dispatch/action      │
 │    - Receives: `review-status: DISPATCHED`             │
 │    - Exits cleanly (zero idle runner billing!)         │
 └──────────────────────────┬─────────────────────────────┘
                            │
                            ▼ (HTTP Dispatch)
 ┌────────────────────────────────────────────────────────┐
 │ 3. Kubernetes Review Ingress & Dispatcher              │
 │    - Enqueues review job                               │
 │    - Spawns isolated Worker Pod (`PRReviewJob`)        │
 └──────────────────────────┬─────────────────────────────┘
                            │
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │ 4. Review Yeti Worker Pod (Kubernetes)                 │
 │    - Container: `review-yeti-worker@sha256:...`        │
 │    - Mounts ephemeral read-only workspace              │
 │    - Fetches pull request diff from GitHub API         │
 │    - Executes multi-persona analysis (Security,        │
 │      Architecture, Testing, Performance, etc.)         │
 │    - Communicates with model provider (Ollama, vLLM,   │
 │      OpenRouter, etc.)                                 │
 └──────────────────────────┬─────────────────────────────┘
                            │
                            ▼ (POST /repos/:repo/check-runs)
 ┌────────────────────────────────────────────────────────┐
 │ 5. Direct GitHub Checks Reporting                      │
 │    - Authenticates using GitHub App private key        │
 │    - Posts Check Run directly to the PR commit:        │
 │        `Review Yeti: SHIP` (or actionable findings)    │
 │    - Unblocks PR merge queue / branch protection       │
 └────────────────────────────────────────────────────────┘
```

---

## The Handshake & Dispatch Flow

### Step 1: Action Dispatches to Kubernetes
Inside the centralized review workflow, the action checks `execution-backend`:

```yaml
- name: Dispatch Review
  uses: review-yeti-ai/review-yeti-bot@v1
  with:
    github-token: ${{ steps.app_token.outputs.token }}
    repo: ${{ inputs.repository }}
    pr-number: ${{ inputs.pr_number }}
    execution-backend: doks
    doks-dispatch-url: https://review-bot.example.com/api/dispatch/action
```

### Step 2: Instant Asynchronous Acknowledgement
The Kubernetes dispatcher receives the payload, validates request authentication, and enqueues the job. The calling GitHub Action step immediately returns:
* `review-status: DISPATCHED`
* `gate-decision: PENDING`

The workflow gate (`check-review-verdict.sh`) recognizes this asynchronous handoff and exits cleanly:
```bash
if [[ "$REVIEW_STATUS" == "DISPATCHED" && "$GATE_DECISION" == "PENDING" ]]; then
  echo "::notice::Review Yeti dispatched asynchronously to Kubernetes queue. Verdict enforcement will be reported via Review Yeti GitHub App gate."
  exit 0
fi
```
**The GitHub Actions runner shuts down immediately**, saving 100% of the runner idle compute cost.

### Step 3: Pod Execution & Direct Reporting
The Kubernetes worker pod starts:
1. Spawns as an isolated container: `review-yeti-worker`.
2. Mints a short-lived GitHub App token using its mounted secret.
3. Pulls the exact base and head git diff.
4. Dispatches prompts to the configured LLM endpoints.
5. Once all personas report, aggregates findings and computes the final verdict (`SHIP` vs `NEEDS_REVISION`).
6. Directly calls the GitHub REST API:
   ```http
   POST /repos/{owner}/{repo}/check-runs
   Authorization: Bearer <app-installation-token>
   Content-Type: application/json

   {
     "name": "Review Yeti",
     "head_sha": "a1b2c3d4...",
     "status": "completed",
     "conclusion": "success",
     "output": {
       "title": "Review Yeti: SHIP",
       "summary": "All 6 review personas evaluated cleanly."
     }
   }
   ```

---

## Worker Pod Security & Sandboxing

Kubernetes worker pods run with strict security boundaries:
* **Read-Only Root Filesystem**: The container root filesystem is mounted read-only (`readOnlyRootFilesystem: true`).
* **Ephemeral Workspace**: Workspaces use memory-backed `tmpfs` mounts that are discarded as soon as the pod exits.
* **Network Isolation**: Pods can be placed in network policies allowing outbound egress only to GitHub API and the designated internal LLM inference service.
* **No Secret Bleed**: Provider credentials and GitHub App private keys are injected via Kubernetes Secrets / Vault, never stored in repository code or commit history.

---

## Configuring the Execution Backend

In your central `policy/review-yeti.json` or repository settings:

```json
{
  "review_yeti": {
    "execution_backend": "doks",
    "doks_dispatch_url": "https://review-bot.example.com/api/dispatch/action"
  }
}
```

Or set the workflow environment variable in GitHub Actions:
```bash
gh variable set REVIEW_YETI_EXECUTION_BACKEND --body "doks"
```

To switch back to hosted GitHub Actions runners at any time, simply set:
```bash
gh variable set REVIEW_YETI_EXECUTION_BACKEND --body "local"
```
No changes to consumer repository pull request workflows are ever required.
