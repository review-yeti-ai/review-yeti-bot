# exampleorg Review Actions

This private repository owns the organization-wide Review Yeti workflow contract.
Consumer repositories contain only a small, identical `pull_request_target` shim. The
review policy, provider routing, exact-head validation, verdict gate, and recovery contract
live here and are released through the platform-owned `v1` contract.

## Consumer contract

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
    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1
    secrets: inherit
```

The reusable workflow derives the repository, PR number, base SHA, and head SHA from the trusted
GitHub event, re-reads the PR through the caller's `GITHUB_TOKEN`, and fails closed if any
coordinate changes. Consumers do not carry a second `central-sha` input, PR-body evidence block,
or rotating claim. The workflow never checks out or executes the pull-request head.

`v1` is a privileged central release ref, intentionally advanced only after a reviewed merge in
this repository. That central release operation is the single integrity boundary; consumer
repositories never update a SHA, tag, or claim when policy or budgets change. Keep the ref
protected in repository administration and retain the previous central commit as the rollback
record.

## No consumer-owned Review Yeti configuration

The policy is `policy/review-yeti.json` in this repository. Consumer repositories must not
contain `.review-yeti*`, `.ct-review*`, or persona override files. The reusable workflow rejects
those paths before any model request. A `.coderabbit.*` file, when present, belongs to the
independent CodeRabbit service; Review Yeti does not read it and it cannot change the central
review roster, provider route, budget, or gate semantics.

## Bootstrap and recovery

The central repository reviews its own pull requests through `self-review.yml` using the same
platform-owned `v1` contract. The tag is advanced only by the central repository's protected
release process; consumers do not need synchronized per-repository edits when budgets or policy
change.

The initial repository creation is the one-time bootstrap exception: create `main`, publish the
first release tag, pin `self-review.yml` to the bootstrap commit, then protect `main` and require
the workflow validation checks for all later changes.

## Release procedure

1. Merge a change through the central repository's self-review.
2. Verify the central validation workflow and a canary PR in a consumer repository.
3. Advance the protected `v1` release ref to the merged central commit.
4. Verify the consumer Review Yeti check; no consumer PR or body stamp is required for policy-only changes.

The central policy is intentionally boring: changes are reviewed at the previous release, then
promoted as a new immutable release after validation. This line is the bootstrap canary: the
central PR must be reviewed by the pinned previous release, not by the proposed workflow.

## Provider order

The current standard transport plan is deliberately limited and ordered:

1. Fireworks (`FIREWORKS_PR_REVIEW_API_KEY`)
2. Ollama (`OLLAMA_PR_REVIEW_API_KEY`)
3. OpenRouter (`OPENROUTER_PR_REVIEW_API_KEY`) as the final fallback

The action starts each model turn at Fireworks and advances through the plan only when the
current transport fails. The OpenRouter entry explicitly permits gateway fallbacks while denying
provider data collection; no other gateway is part of the central plan. Each caller must expose
the three named environment variables through its inherited GitHub Actions secrets.
