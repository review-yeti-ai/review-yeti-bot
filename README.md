# exampleorg Review Actions

This private repository owns the organization-wide Review Yeti workflow contract.
Consumer repositories contain only a small, identical `pull_request_target` shim. The
review policy, provider routing, exact-head validation, verdict gate, and recovery contract
live here. Central development runs on `main`; consumer repositories use the promoted `v1`
release channel.

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

`v1` is a privileged central release branch, advanced only by the promotion workflow after the
development line passes validation and the originating central PR has a successful Review Yeti
check. Consumer repositories never update a SHA, branch, tag, or claim when policy or budgets
change. Promotion is fast-forward-only, so the previous `v1` tip remains in branch history as
the rollback record; revert the corresponding change on `main` to roll back automatically.

## No consumer-owned Review Yeti configuration

The policy is `policy/review-yeti.json` in this repository. Consumer repositories must not
contain `.review-yeti*`, `.ct-review*`, or persona override files. The reusable workflow rejects
those paths before any model request. A `.coderabbit.*` file, when present, belongs to the
independent CodeRabbit service; Review Yeti does not read it and it cannot change the central
review roster, provider route, budget, or gate semantics.

## Bootstrap and recovery

The central repository reviews its own pull requests through `self-review.yml` using the trusted
development `main` contract. Consumer repositories use `v1`; they do not need synchronized
per-repository edits when policy or budgets change.

The initial repository creation is the one-time bootstrap exception: create `main`, let the first
validated promotion create the `v1` branch, remove any historical `v1` tag, then protect `main`
and require the workflow validation checks for all later changes. After bootstrap, the promotion
workflow is the only writer to `v1`; operators roll back by reverting `main` and allowing the
same fast-forward promotion path to record that rollback in branch history.
The migration is complete once `refs/heads/v1` exists; the legacy tag must not be recreated.

## Release procedure

1. Merge a change through the central repository's self-review on `main`.
2. The promotion workflow verifies the central validation workflow and originating Review Yeti check.
3. The promotion workflow fast-forwards the `v1` branch to the merged `main` commit.
4. New consumer PRs automatically use the new policy; no consumer PR or body stamp is required.

The central policy is intentionally boring: changes are reviewed by the trusted development line,
then promoted only after validation. The model may identify recurring failures and propose a PR,
but it never writes directly to `main` or `v1`, changes release policy, or self-approves a
promotion.

## Fireworks timeout debug

The hosted panel uses `openrouter-ttft-ms` even on the Fireworks transport. Both
configured transports set `stream: true` and `openrouter_stream=true`, so that
the 30-second TTFT deadline measures the first SSE token, not a fully buffered
JSON body; observed first-byte latency is typically ~1s. OpenRouter fallback is
restricted to the Fireworks provider, does not rotate through arbitrary gateway
providers, and accepts only pure `bf16`/`fp16` quants.
Transport smoke stays `stream: false` so `response.json()` health checks remain
valid.

Smoke logs `elapsed_ms` and `http` per transport. For a panel-sized probe:

```bash
doppler run --project example-workspace --config prd -- \
  node scripts/review-yeti-fireworks-debug.mjs
```

The script never prints the API key. Compare `ttfbMs` for `stream=true` vs
`stream=false`. Streaming first-byte is typically under 1s; non-stream first-byte
is the full JSON.

## Provider order

The current standard transport plan is deliberately limited and ordered:

1. Fireworks (`FIREWORKS_PR_REVIEW_API_KEY`)
2. OpenRouter (`OPENROUTER_PR_REVIEW_API_KEY`) as the final fallback, restricted
   to the Fireworks provider

The action starts each model turn at Fireworks and advances to the restricted gateway only when
the current transport fails. The OpenRouter entry disables provider rotation, permits only the
Fireworks provider, and denies provider data collection. This prevents a slow or malformed
third-party gateway from consuming the lane budget. Each caller must expose the two named
environment variables through its inherited GitHub Actions secrets.

The central budget is also fixed here: three investigation turns, one 24-request per-lane call
budget, a four-minute lane deadline, and a 30-second time-to-first-token budget. A provider that
does not answer within that envelope fails over or fails closed; it cannot stretch a hosted job or
silently consume an unbounded retry budget.

Before the model action starts, the reusable workflow runs `scripts/review-yeti-smoke.mjs` against
each configured transport using a bounded, review-shaped JSON request. The smoke test records only
transport names and status, never credentials or response bodies, and fails closed when no
transport can complete the request. Its contract tests run in the central validation workflow so
provider order, OpenRouter routing, response validation, fallback behavior, and policy-drift
rejection are checked before a release can advance.

## Distribution

The Review Yeti bot is selected by the platform release channel (`action_channel: v1` in `policy/review-yeti.json`), validated at run time by the release-provenance gate (release-tagged + reachable from bot main). Emergency freezes use `action_sha_override` (main-reachability still enforced). See review-yeti-ai/review-yeti-bot `docs/RELEASING.md`.
