# exampleorg Review Actions

This private repository owns the organization-wide Review Yeti workflow contract.
Consumer repositories contain only a small, identical `pull_request_target` shim. The
review policy, provider routing, exact-head validation, verdict gate, and recovery contract
live here and are released by immutable commit SHA.

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
    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@<immutable-release-sha>
    with:
      repository: ${{ github.repository }}
      pr-number: ${{ github.event.pull_request.number }}
      base-sha: ${{ github.event.pull_request.base.sha }}
      head-sha: ${{ github.event.pull_request.head.sha }}
    secrets: inherit
```

The caller supplies the repository, PR number, base SHA, and head SHA. The reusable workflow
re-reads the PR through the caller's `GITHUB_TOKEN` and fails closed if any coordinate changes.
It never checks out or executes the pull-request head.

## No consumer-owned review configuration

The policy is `policy/review-yeti.json` in this repository. Consumer repositories must not
contain `.review-yeti*`, `.ct-review*`, `.coderabbit*`, or persona override files. The reusable
workflow rejects those paths before any model request. This prevents a target repository or its
PR from changing the review roster, provider route, budget, or gate semantics.

## Bootstrap and recovery

The central repository reviews its own pull requests through `self-review.yml`, which calls the
last released immutable SHA rather than the proposed workflow. A broken release therefore does
not become the only reviewer capable of approving its repair. Consumers also remain pinned to
their last known-good release until a new release is deliberately promoted.

The initial repository creation is the one-time bootstrap exception: create `main`, publish the
first release tag, pin `self-review.yml` to the bootstrap commit, then protect `main` and require
the workflow validation checks for all later changes.

## Release procedure

1. Merge a change through the central repository's self-review using the previous release.
2. Verify the central validation workflow and a canary PR in a consumer repository.
3. Create an immutable release tag, for example `v1` or `v1.1.0`.
4. Update consumers in separate PRs to the new release SHA.
5. Keep the previous SHA documented as the rollback pin until the canary and consumer checks pass.

The central policy is intentionally boring: changes are reviewed at the previous release, then
promoted as a new immutable release after validation. This line is the bootstrap canary: the
central PR must be reviewed by the pinned previous release, not by the proposed workflow.
