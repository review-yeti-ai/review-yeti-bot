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

The central policy selects the Review Yeti action by the single `v1` release channel. The reusable
workflow resolves that channel to the exact commit for each run, checks out that commit (never the
mutable ref), and verifies that it is reachable from the bot repository's `main` and targeted by
the exact `v1` release tag before executing it. This keeps the action self-updating at the release
channel without per-repository SHA edits or mutable, unverified code execution.

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

The hosted panel uses `openrouter-ttft-ms` across the model transports. All
three transports set `stream: true` and `openrouter_stream=true`, so that
the 30-second TTFT deadline measures the first SSE token, not a fully buffered
JSON body; observed first-byte latency is typically ~1s. OpenRouter requires
full-precision `bf16`/`fp16` quants, sorts by throughput (p90 ≥ 40 tok/s, p99
≤ 3s), and allows cheap hosts to fall. Smoke sends `stream: true` (SSE).

Smoke logs `elapsed_ms` and `http` per transport. For a panel-sized probe:

```bash
doppler run --project example-workspace --config prd -- \
  node scripts/review-yeti-fireworks-debug.mjs
```

The script never prints the API key. Both probes are `stream: true`. Streaming
first-byte is typically under 1s.

## Provider order

The current standard transport plan is deliberately limited and ordered:

1. Fireworks (`FIREWORKS_PR_REVIEW_API_KEY`)
2. Ollama (`OLLAMA_PR_REVIEW_API_KEY`)
3. OpenRouter (`OPENROUTER_PR_REVIEW_API_KEY`) as the final fallback

The action starts each model turn at Fireworks and advances through the declared order when a
transport fails. Each transport gets one retry. Fireworks stays on the default serverless tier,
reports server-side TTFT, and uses maximum reasoning; OpenRouter also uses maximum reasoning,
while Ollama uses `high`, its documented maximum. OpenRouter owns endpoint selection after a
timeout without Review Yeti dynamically banning the resolved endpoint.

The OpenRouter entry requires `bf16`/`fp16`, sorts by throughput, allows
remaining hosts to fail over (`allow_fallbacks: true`), and denies provider data
collection. Each caller must expose the named environment variables through its
inherited GitHub Actions secrets.

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

The Review Yeti bot is selected by the platform release channel (`action_channel: v1` in `policy/review-yeti.json`). The workflow resolves that channel to an exact commit, checks the tag target and main reachability, then binds the action's `action-sha` input to the resolved commit. There is no per-repository SHA override or emergency bypass; changes advance through the central channel's reviewed promotion. See review-yeti-ai/review-yeti-bot `docs/RELEASING.md`.
