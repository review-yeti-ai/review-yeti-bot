# Consumer Repository Onboarding Guide

This guide walks you through integrating **Review Yeti** into a new or existing repository in your organization.

---

## Prerequisites

Before onboarding a repository, ensure:
1. The **Review Yeti GitHub App** is installed on your repository (see [GitHub App Setup Guide](github-app-setup.md)).
2. The central review repository (e.g., `my-org/review-actions`) is provisioned with model provider API keys.

---

## Choosing an Integration Pattern

Review Yeti supports two consumer workflow patterns depending on your organization's runner budget and concurrency requirements:

| Pattern | Best For | Runner Cost | Setup Complexity |
| :--- | :--- | :--- | :--- |
| **Option A: Reusable Workflow** | Small repos, low PR volume | Holds 1 runner for the review duration | Minimal (5-line workflow) |
| **Option B: Async Dispatch Shim** | High PR volume, large teams, or billable runners | < 5s runner execution (Zero idle waste) | Recommended for production fleets |

> The examples below are illustrative generic onboarding patterns, not
> qualification-ready exampleorg templates. For governed CT adoption, start
> from the reviewed base-owned caller at
> `.github/workflows/ct-review-bot.yml` (the `CALLER_WORKFLOW_PATH` contract)
> and the read-only collector at `.github/workflows/review-readiness.yml`.
> Keep that caller dispatch-only: it must not wait for, adopt, or publish a
> review check. Placeholder `my-org`, `@v1`, secret names, and the generic
> `review-yeti.yml` filename below are not qualification evidence.

---

## Option A: Direct Reusable Workflow

For simple setups, call the promoted `@v1` central workflow directly:

Create `.github/workflows/review-yeti.yml` in your repository:

```yaml
name: Review Yeti

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  review:
    name: Review Yeti
    if: github.event.pull_request.draft == false
    uses: my-org/review-actions/.github/workflows/review-yeti.yml@v1
    secrets: inherit
```

---

## Option B: Async Fire-and-Forget Dispatch Shim (Recommended)

To avoid burning runner minutes while AI personas review code, use the async dispatch shim. This runs for ~5 seconds, dispatches to the central repository, and exits immediately. The central system reports the result back via the GitHub Checks API.

Create `.github/workflows/review-yeti.yml` in your repository:

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
          repositories: "${{ env.CENTRAL_REPOSITORY }},${{ env.TARGET_REPOSITORY }}"

      - name: Validate PR coordinates
        env:
          GH_TOKEN: ${{ steps.ry_token.outputs.token }}
        shell: bash
        run: |
          set -euo pipefail
          live="$(gh api "repos/${TARGET_REPOSITORY}/pulls/${PR_NUMBER}" --jq '[.state, .base.sha, .head.sha] | @tsv')"
          IFS=$'\t' read -r state base_sha head_sha <<< "$live"
          if [[ "$state" != "open" || "$base_sha" != "$EXPECTED_BASE_SHA" || "$head_sha" != "$EXPECTED_HEAD_SHA" ]]; then
            echo "::error::Pull request coordinates changed before dispatch."
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
          echo "Central Review Yeti executes asynchronously and reports via GitHub Checks API."

```

### Dedicated Merge-Group Qualifier

Add `.github/workflows/ct-review-merge-group.yml` as a separate workflow. It
is merge-group-only and uses the official App to publish the native required
context on the synthetic head:

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

---

## Configuring Branch Protection / Rulesets

To require Review Yeti before a pull request can merge:

1. In your repository on GitHub, navigate to **Settings > Rules > Rulesets** (or **Branches** for classic protection).
2. Edit or create a ruleset targeting your default branch (`main` or `release/*`).
3. For governed CT merge queues, require **`Review Yeti`** from the official
   `ct-review-bot` App (integration `4385771`). The central review publishes it
   on constituent heads; the dedicated merge-group workflow uses the same App
   identity to publish it on the synthetic combined head after qualification.
4. Save changes.

---

## Merge Queue Compatibility

Review Yeti natively supports GitHub Merge Queues:
* The dedicated `.github/workflows/ct-review-merge-group.yml` workflow runs the centrally owned exact-head verifier at a full commit SHA, satisfying the merge-group context without an inline shell approximation.
* For ordinary pull requests, `ct-review-bot` App `4385771` owns the required `Review Yeti` context on each constituent head.
* The verifier checks every constituent's latest exact-head native verdict, then publishes the same App-owned `Review Yeti` context on the synthetic combined head.
* This prevents redundant and expensive re-reviews of code that was already thoroughly audited prior to queue admission.
