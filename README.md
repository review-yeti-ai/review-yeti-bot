# Review Yeti

> **Automated, multi-persona AI code reviews with centralized governance, credential isolation, and Kubernetes offload.**

Review Yeti is an enterprise-grade AI review engine designed for GitHub organizations. It evaluates pull requests across specialized personas (Security, Architecture, Performance, Testing, Dependencies, and Licensing), enforces fail-closed cryptographic coordinate verification, and reports verdicts directly to GitHub Check Runs.

---

## Highlights

* 🛡️ **Zero Credential Exposure**: Consumer repositories never store LLM provider API keys or tokens; all credentials remain strictly within the central review repository or private Kubernetes cluster.
* ⚡ **Zero-Waste Asynchrony**: Consumer PR trigger shims complete in **< 5–15 seconds**, eliminating the wasteful 15-minute runner polling anti-pattern.
* ☸️ **Flexible Execution Modes**: Run reviews directly on **GitHub Actions** or offload heavy multi-persona workloads to an autoscaling **Kubernetes cluster** (DOKS, EKS, GKE).
* 🤖 **Dedicated GitHub App Identity**: Uses short-lived installation tokens and separate per-installation rate-limit pools; creates direct check runs via `POST /repos/:owner/:repo/check-runs`.
* 🔄 **Multi-Provider Resilience**: Built-in weighted striping, circuit breakers, and automatic failover across model providers (Bifrost, Ollama, OpenRouter, and Gemini).
* 🚦 **Merge Queue Native**: First-class support for GitHub Merge Queues with instant synthetic-commit validation to avoid duplicate reviews.

---

## Architecture at a Glance

Review Yeti operates on a centralized **Hub-and-Spoke** architecture:

```
┌─────────────────────────────────┐
│     Consumer Repository (PR)    │
│  - Lightweight trigger shim     │
│  - Runs < 5s; releases runner   │
└────────────────┬────────────────┘
                 │ (workflow_dispatch / repository_dispatch)
                 ▼
┌─────────────────────────────────┐
│   Central Review Hub Repository │
│  - Holds provider credentials   │
│  - Enforces review policies     │
└───────────────┬─────────────────┘
                │
        ┌───────┴────────────────────────┐
        ▼ (Mode 1: Hosted)               ▼ (Mode 2: Kubernetes)
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ GitHub Actions Runner VM      │ │ Kubernetes Worker Pod         │
│ - Runs review personas in GHA │ │ - Runs in private K8s cluster │
└───────────────┬───────────────┘ └───────────────┬───────────────┘
                │                                 │
                └────────────────┬────────────────┘
                                 │ (POST /repos/:repo/check-runs)
                                 ▼
                 ┌───────────────────────────────┐
                 │ Pull Request Check Run Gate   │
                 │ `Review Yeti: SHIP`           │
                 └───────────────────────────────┘
```

For complete architectural details, see [Architecture & Design Principles](docs/architecture.md).

---

## Quickstart: Onboarding a Repository in 5 Minutes

### Step 1: Install the GitHub App
For same-owner exampleorg consumers, install the internal **Review Yeti App** on
the admitted target repositories and `exampleorg/example-review-actions`. The exact
public self-review route uses separate App boundaries described below; never
install the internal App in the public `review-yeti-ai` organization.

See the [GitHub App Setup & Permissions Guide](docs/github-app-setup.md) for full instructions.

The governed receiver preserves its existing `exampleorg/*` admission at
`.github/workflows/ct-review-bot.yml` and additionally admits exactly
`review-yeti-ai/review-yeti-bot` at `.github/workflows/ct-review-bot.yml`. For
that cross-owner route, trusted central workflows mint one installation token
for `review-yeti-ai/review-yeti-bot` target reads, check publication, and the
post-SHIP `validate.yml` dispatch; and a separate
`exampleorg/example-review-actions` token for central reads. GitHub App
installation tokens are owner-bound; no token, PAT, wildcard owner/repository,
or ambient `github.token` fallback crosses this boundary.

Activating the external route requires three exact installations/secrets:

* central stores `REVIEW_YETI_PUBLIC_TARGET_APP_ID` /
  `REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY` for the Review Yeti App installed
  across the reviewer organization's repositories; central still narrows every
  external-route token to `review-yeti-ai/review-yeti-bot`;
* the public caller stores `REVIEW_YETI_DISPATCH_APP_ID` /
  `REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY` for an ingress App installed only on
  `exampleorg/example-review-actions` with Contents: write;
* central retains `CT_REVIEW_BOT_APP_ID` /
  `CT_REVIEW_BOT_APP_PRIVATE_KEY` for private central tooling only.

Provider credentials remain in the private central repository and never cross
into the public consumer.

The public Review Yeti repository cannot resolve a reusable workflow from the
private `exampleorg/example-review-actions` repository. Its base-owned
`.github/workflows/ct-review-bot.yml` therefore uses the same validated,
coordinate-only `repository_dispatch` boundary as other production consumers.
The caller mints a repository-scoped App token, submits immutable PR
coordinates, and exits; it never checks out PR code or receives provider
credentials. The central receiver validates the exact caller run and the
default-branch caller bytes before admitting work. It also requires the
two-step SHA-pinned ingress-App shape, one coordinate-only POST, and no extra
API writes, checkout, PAT, or ambient `github.token` fallback.

The runtime target App used by the central review workflow requests only
`Actions: read` for evidence inspection. A Review Yeti verdict is terminal:
`SHIP` publishes review evidence and does not dispatch target workflows or
trigger CI, merge, deployment, or release activity.

The public external dispatch caller requires only the ingress App identity pair:

- `REVIEW_YETI_DISPATCH_APP_ID`
- `REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY`

At runtime, accessible same-owner reusable callers capture GitHub's immutable
`job.workflow_sha` before any central checkout and checks out that exact commit.
The existing same-repository `example-review-actions` PR-head policy remains the sole
exception. The public external route does not call the reusable workflow at all.

### Step 2: Add the Trigger Workflow
Add `.github/workflows/review-yeti.yml` to your repository:

> The workflow below is an illustrative, generic async onboarding example,
> not a qualification-ready exampleorg template. For governed CT adoption,
> start from the reviewed base-owned caller at
> `.github/workflows/ct-review-bot.yml` (the `CALLER_WORKFLOW_PATH` contract)
> and the read-only collector at `.github/workflows/review-readiness.yml`.
> Keep this caller dispatch-only: it must not wait for, adopt, or publish a
> review check. Do not treat the placeholder `my-org`, `@v1`, secret names, or
> `review-yeti.yml` filename below as qualification evidence.

The example below is same-owner only: `my-org/review-actions` and the target
repository must belong to the same installation owner. Cross-owner consumers
must mint one owner-scoped token per installation as described above.

The central `example-review-actions` repository follows the same rule for its own
pull requests: its base-owned `.github/workflows/ct-review-bot.yml` dispatches
to the promoted `v1` receiver, and branch protection trusts only the exact-head
`Review Yeti` check published by the `ct-review-bot` App. The distinct
`Review Yeti Gate` name is not part of the deployed DOKS contract; it remains
reserved there for the future service-owned gate. Central self-review must not
call the development-line reusable workflow directly.

```yaml
name: Review Yeti

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: review-yeti-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name != 'merge_group' }}

permissions:
  actions: read
  contents: read

jobs:
  dispatch:
    name: Dispatch native Review Yeti
    if: github.event_name == 'pull_request_target' && github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      CENTRAL_REPOSITORY: my-org/review-actions
      CENTRAL_EVENT_TYPE: review-yeti-request
      TARGET_REPOSITORY: ${{ github.repository }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      EXPECTED_BASE_SHA: ${{ github.event.pull_request.base.sha }}
      EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
      REQUEST_ID: ${{ github.event.repository.name }}:${{ github.event.pull_request.number }}:${{ github.event.pull_request.head.sha }}:${{ github.run_id }}:${{ github.run_attempt }}
    steps:
      - name: Mint Review Yeti Token
        id: ry_token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.REVIEW_BOT_APP_ID }}
          private-key: ${{ secrets.REVIEW_BOT_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: "${{ github.event.repository.name }},review-actions"

      - name: Validate PR Coordinates
        env:
          GH_TOKEN: ${{ steps.ry_token.outputs.token }}
        shell: bash
        run: |
          set -euo pipefail
          live="$(gh api "repos/${TARGET_REPOSITORY}/pulls/${PR_NUMBER}" --jq '[.state, .base.sha, .head.sha] | @tsv')"
          IFS=$'\t' read -r state base_sha head_sha <<< "$live"
          if [[ "$state" != "open" || "$base_sha" != "$EXPECTED_BASE_SHA" || "$head_sha" != "$EXPECTED_HEAD_SHA" ]]; then
            echo "::error::PR coordinates changed before dispatch."
            exit 1
          fi

      - name: Dispatch Central Review
        env:
          GH_TOKEN: ${{ steps.ry_token.outputs.token }}
        shell: bash
        run: |
          set -euo pipefail
          jq -nc \
            --arg event_type "${CENTRAL_EVENT_TYPE}" \
            --arg request_id "${REQUEST_ID}" \
            --arg repository "${TARGET_REPOSITORY}" \
            --argjson pr_number "${PR_NUMBER}" \
            --arg base_sha "${EXPECTED_BASE_SHA}" \
            --arg head_sha "${EXPECTED_HEAD_SHA}" \
            '{event_type: $event_type, client_payload: {request_id: $request_id, repository: $repository, pr_number: $pr_number, base_sha: $base_sha, head_sha: $head_sha}}' | \
            gh api --method POST "repos/${CENTRAL_REPOSITORY}/dispatches" --input - --silent

      - name: Confirm Central Dispatch
        run: |
          echo "Dispatched central Review Yeti for ${TARGET_REPOSITORY}#${PR_NUMBER}."
          echo "Review executes asynchronously and publishes directly to GitHub Check Runs."

```

### Step 2b: Add the Dedicated Merge-Group Qualifier

Add `.github/workflows/ct-review-merge-group.yml` separately. This workflow is
only for merge-group checks and publishes the official App-owned context on the
synthetic head after qualifying every constituent:

```yaml
# .github/workflows/ct-review-merge-group.yml
name: Review Yeti merge group

on:
  merge_group:
    types: [checks_requested]

permissions:
  checks: read
  contents: read
  pull-requests: read

jobs:
  review:
    name: Publish native Review Yeti merge-group gate
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Mint Review Yeti App token
        id: ry_token
        uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349
        with:
          app-id: ${{ secrets.CT_REVIEW_BOT_APP_ID }}
          private-key: ${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}
          owner: exampleorg
          repositories: dashboard

      - name: Verify constituents and publish native gate
        uses: exampleorg/example-review-actions/.github/actions/verify-merge-group@<full-40-hex-central-release-sha>
        with:
          review-yeti-token: ${{ steps.ry_token.outputs.token }}
          repository: ${{ github.repository }}
          branch: ${{ github.event.merge_group.base_ref }}
```

### Step 3: Require the Check in GitHub Rulesets
For governed CT merge queues, require **`Review Yeti`** from the official
`ct-review-bot` App (integration `4385771`). The central review publishes it on
each constituent head. The dedicated merge-group workflow uses the same App
identity to publish it on the synthetic combined head only after every queued
constituent has a successful exact-head native verdict. The dispatch caller
does not produce a required context.
The generic non-queue examples above are not this governed queue setup.
See [GitHub's merge-queue check requirements](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#status-checks-with-github-actions-and-a-merge-queue).

For more details, see the [Consumer Repository Onboarding Guide](docs/onboarding-guide.md).

---

## Execution Modes

Review Yeti supports two execution backends. Governed `repository_dispatch`
admissions always use DOKS App-gate mode; repository variables cannot select the
local backend or disable App-gate publication for that path. Local mode remains
available to non-central/manual workflows.

### 1. Hosted GitHub Actions Mode (`execution_backend: local`)
* The review runs inside standard GitHub Actions runners (`ubuntu-latest` or self-hosted/Blacksmith).
* LLM streaming calls are orchestrated directly by workflow steps.
* Best for: standard setups, minimal infrastructure footprint.

### 2. Kubernetes Worker Mode (`execution_backend: doks`)
* Central Action dispatches requests to an internal Kubernetes gateway (`/api/dispatch/action`) and exits immediately (`DISPATCHED/PENDING`).
* An autoscaling Kubernetes cluster schedules an ephemeral worker pod (`review-yeti-worker`) with an isolated sandbox.
* The worker evaluates the diff and reports the final verdict directly back to GitHub Check Runs via the GitHub App token.
* Best for: enterprise environments, private model inference (Ollama/vLLM on private GPUs), high PR volume, and eliminating long-running GHA runner bills.

### Check Publication Contract

The deployed DOKS central action writes zero checks. For a reviewed DOKS run,
the worker publishes only the raw `Review Yeti` check. Governed branch
protection and promotion therefore bind `Review Yeti` to the official
`ct-review-bot` App (integration `4385771`). DOKS passthrough does not dispatch
a worker or synthesize an approval; it leaves the protected raw check
unsatisfied.

### Atomic Worker-Generation Reservation

The central receiver serializes the complete validation and dispatch run by the
immutable tuple `repository + pull request + head SHA`, with cancellation
disabled. While it holds that lease, the validator reads the complete App-owned
`Review Yeti` check ledger for the exact head and admits only generation `a1`,
or bounded replacements `a2` and `a3`. Every prior generation must exist
exactly once and be App-owned and completed with `failure` or `action_required`.
An infrastructure/no-verdict title qualifies. A raw `BLOCK` qualifies only when
its exact-head summary reports zero findings and an incomplete panel, and the
newest App-owned failed `Review Yeti Gate` confirms the matching infrastructure
failure or missing-roster lane counts. A findings `BLOCK`,
`FIX_FIRST`, active checks, missing or duplicate generations, and attempts
`a4` or later never authorize replacement.
All prior worker rows must also carry the same DOKS `run_<id>` identity; rows
from different worker identities cannot be combined into an apparent contiguous
generation history.
The incomplete-roster check accepts only the published `panel` lane summary or
`composed` task summary; composed planned and expected counts must agree.
Every row and pagination boundary is validated fail closed before that
decision; an inventory at the 1,000-run endpoint cap is ambiguous and is
rejected.

GitHub workflow concurrency is necessary but is not the durable allocator. The
validated request is forced through the DOKS App-gate backend, where the
service-owned request identity and database compare-and-swap allocate the worker
attempt. The central validator exports its admitted generation and the receiver
forwards it as the action's explicit `expected-generation`; the DOKS allocator
must match that value when it performs the compare-and-swap. Together, serial
revalidation, exact-generation forwarding, and the DOKS identity/CAS form the
reservation boundary: after a recovery dispatch reserves its next generation,
a queued duplicate revalidates against that new generation and is rejected.
Consumer or central repository variables cannot downgrade this path to local
execution.

To recover a same-head provider outage, apply the `review-yeti/refresh` label to
the pull request. The base-owned caller sends a signed Boolean refresh request;
central validation ignores that new label workflow's `github.run_attempt` and
derives the next generation from the complete exact-head worker ledger. If the
label is already present after a failed `a2`, remove and re-apply it to request
the bounded `a3`.

Rerunning the original consumer caller run remains an equivalent operator path:

```bash
gh run rerun <caller-run-id> --repo exampleorg/<repository>
```

GitHub preserves the original pull-request head and increments
`github.run_attempt`; the caller re-reads the live PR coordinates before
dispatch. Both paths admit only the next contiguous recovery generation under
the rules above. A label event or newly created caller run cannot reset or
bypass the ledger, and an empty commit creates a different head rather than a
same-head recovery. Operators must stop after `a3`; later attempts fail closed
and require a code or policy change with normal review.

For a repository that has retired its caller workflow, use this repository's
`repository-dispatch.yml` `workflow_dispatch` with the current exact
`repository`, `pr_number`, `base_sha`, and `head_sha`, and set
`refresh_requested=true`. The central run binds the request to its own run
identity, re-reads the open PR and complete App-owned check ledger, and uses
the same bounded generation reservation. Recheck those coordinates immediately
before dispatch; a stale base or head fails validation.

The legacy hosted/local compatibility path also publishes `Review Yeti Gate`
alongside the raw check, including an honestly `skipped` pair during local
passthrough. That alias preserves existing non-DOKS consumers only. It must not
be required for governed DOKS repositories and does not represent the future
service-owned gate.

For deep-dive setup and deployment instructions, see [Kubernetes & DOKS Execution Mode](docs/kubernetes-mode.md).

---

## Multi-Persona AI Review System

Review Yeti reviews code through independent, specialized persona lenses:

| Persona | Focus Areas |
| :--- | :--- |
| **🛡️ Security** | Injection vulnerabilities, secret exposure, authorization bypasses, cryptographic hygiene. |
| **🏗️ Architecture** | Structural patterns, domain boundary leaks, layer violations, maintainability. |
| **⚡ Performance** | N+1 queries, algorithmic bottlenecks, lock contention, memory leaks, I/O efficiency. |
| **🧪 Testing** | Edge cases, coverage regressions, test isolation, assertion validity. |
| **📦 Dependencies** | Supply-chain risks, license compliance, version pins, package vulnerabilities. |
| **⚖️ Licensing** | SPDX identifiers, copyleft conflicts, dual-licensing requirements. |

Findings are classified into:
* **P0 / Blocker**: Critical defect or security vulnerability; blocks merge (`Verdict: FIX_FIRST`).
* **P1 / Important**: High-severity defect; requires revision or explicit approval.
* **P2 / Advisory**: Clean constructive suggestion; non-blocking informational finding.

---

## Local Reviews via CLI

Developers can execute identical review sweeps on their local machines before pushing code:

```bash
# Verify policy configuration without credentials or network calls
./scripts/review-yeti-local check --json

# Run health check on local Review Yeti binary
./scripts/review-yeti-local doctor --json

# Review uncommitted changes against base branch
./scripts/review-yeti-local review --base origin/main --head HEAD --json

# Review a specific diff file or GitHub PR
./scripts/review-yeti-local review --diff-file ./feature.diff --json
./scripts/review-yeti-local review --pr example-org/my-project#42 --json
```

## Readiness Qualification

The central repository includes a manual, read-only readiness workflow at
`.github/workflows/review-readiness.yml`. It admits only `exampleorg/*`
repositories, resolves the selected consumer branch to an immutable commit,
and checks the caller/merge-group workflows, exact required publisher, live
PR head, dispatch correlation, rulesets, and merge-queue state. Runtime mode
also requires the correlated central dispatch run to be terminal and
successful.

The result includes a dependency/authority matrix whose rows bind the central
owner, immutable source ref, artifact, runtime schema, operator, service, and
consumer process identities. The readiness collector is owned by
`exampleorg/example-review-actions`; the runtime artifact is owned by
`review-yeti-ai/review-yeti-bot`, its k8s-operator owns the runtime schema and
lifecycle, and `exampleorg/example-infra` owns the deployed gateway
service. Missing, stale, or untrusted observations are recorded as
`unknown`. Configuration and runtime qualification preserve their existing
source/GitHub exact-head status semantics and include a digest-bound
`observed_at`/`content_digest` result. Consumers that need runtime authority
must gate dependent work on both a compatible matrix and the explicit
`evidence.runtime_qualification` object with `ready: true` and
`status: "ready"`, rather than on top-level readiness status alone.

The merge-group consumer shim must pin
`exampleorg/example-review-actions/.github/actions/verify-merge-group` to the
exact full commit SHA returned by the fresh read-only `v1` release observation.
The readiness collector records the expected and actual action pins and rejects
syntactically valid but arbitrary, missing, mismatched, stale, or unknown
central release references. Do not substitute a tag, branch, or guessed SHA.

Merge-queue entry-shape validation remains readiness-specific because queue
entries carry position and pull-request identity in caller-specific shapes.
The shared `review-check-contract` exports the qualifying state policy and
named check-run publisher identity; it does not merge the two queue schemas.

The official `ct-review-bot` App `4385771` owns the required `Review Yeti`
context on both constituent and combined heads. The verifier reads each
constituent's latest successful worker verdict, identified by its immutable
`run_<id>:a<attempt>` external ID, and publishes the combined-head result
without re-reviewing the synthetic group. Passthrough/skipped checks and prior
`merge-group:<sha>` attestations never qualify as worker review evidence. These
instructions do not change repository settings.

No owner-produced deployment readback is wired into this read-only collector
yet. It therefore emits `runtime_qualification.ready: false` and
`runtime_qualification.status: "unknown"`, and artifact, schema, operator, and
service rows stay `unknown`. A caller field such as
`deployed_schema_compatibility: compatible` is never accepted as deployment
proof; the legacy `deployed_schema_compatibility` field remains `not_checked`
because this workflow does not certify images or production receivers. The
matrix's `authority_delta.technically_compatible` entries are technical
qualification only, not approval grants; `authority_delta.authorization` stays
`unknown` with the full required scope preserved until a separate authorized
approval evidence boundary exists.

---

## Documentation Suite

* 📘 [Consumer Repository Onboarding Guide](docs/onboarding-guide.md): Step-by-step repository setup, workflow options, and ruleset protection.
* 🔑 [GitHub App Setup & Permissions Guide](docs/github-app-setup.md): Manifest flow, permissions matrix, and org secret management.
* ☸️ [Kubernetes & DOKS Execution Mode](docs/kubernetes-mode.md): Cluster architecture, worker pod specifications, and async dispatch flow.
* 🏛️ [Architecture & Design Principles](docs/architecture.md): Centralized governance, coordinate validation, and check run reporting.

---

## Central Governance & Release Promotion

Changes to Review Yeti are developed on `main` and promoted to the immutable `@v1` channel via the atomic release promotion workflow:

1. Changes pass rigorous test suites on `main` (`scripts/validate-central-dispatch.mjs`, transport telemetry, and schema validation).
2. Promotion requires the exact PR head's App-owned `Review Yeti` check. The App ID binding distinguishes it from similarly named Actions jobs; the legacy hosted/local `Review Yeti Gate` alias is not part of DOKS promotion and remains reserved there for the future service-owned gate.
3. The `promote-v1.yml` workflow performs an atomic fast-forward push to the `v1` branch and generates an immutable SHA receipt.
4. All consumer repositories referencing `@v1` immediately receive updated policies and features without repository-side commits.
