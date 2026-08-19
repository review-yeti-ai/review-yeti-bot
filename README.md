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
or rotating claim. Consumer runs never check out or execute the pull-request head. The central
same-repository self-review is the deliberate exception: it checks out the immutable PR head so
policy and workflow changes are actually exercised; fork PRs remain on trusted `main`.

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

The central repository reviews same-repository pull requests through `self-review.yml` using the
immutable PR-head contract, while fork PRs use trusted development `main`. Consumer repositories
use `v1`; they do not need synchronized per-repository edits when policy or budgets change.

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
three transports *declare* `stream: true` and `openrouter_stream=true`, but a
live run of this exact policy showed `stream=disabled` in the job log for
several persona calls -- the declaration was not honored at runtime, because
of a single-slot streaming gate that serializes concurrent persona lanes.
Making streaming unconditional in the hosted action (collapsing the
disagreeing `openRouterPolicy.stream` / `transport.stream` / `openrouter-stream`
input into one always-on source, and deleting the non-streaming fallback from
the real review path) is being fixed separately, in the action itself, not in
this repo. See "TTFT is not always TTFT" below for why that live observation
still shapes `openrouter_ttft_ms` here even though the fix lives elsewhere.

A live local probe against Fireworks with the production model and a
panel-sized (~26k char) prompt measured `ttfbMs=634` and a full streaming
completion in `totalMs=3389`; a non-streaming call against the same prompt
took `totalMs=4398` to return anything at all, which is the gap streaming
exists to close -- when it actually happens. OpenRouter requires
full-precision `bf16`/`fp16` quants, sorts by latency for the fastest overall
response time (with a p90 ≥ 40 tok/s throughput floor and a p99 ≤ 3s latency
preference), and allows eligible hosts to fall. Smoke sends `stream: true`
(SSE) and accepts either an SSE or a fully buffered JSON response depending on
the responder's `content-type`.

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

The OpenRouter entry requires `bf16`/`fp16`, sorts by `latency` (OpenRouter's rolling 5-minute
per-provider percentiles) so the fastest-responding host is tried first, allows remaining hosts to
fail over (`allow_fallbacks: true`), and denies provider data collection. `sort: latency`
optimizes for lowest overall request completion time; the alternative, `sort: throughput`,
optimizes for tokens/sec once a provider is already generating, which is the wrong axis when the
goal is not blowing through a lane deadline. `only` and `order` are never used here: both pin
routing to a fixed provider list, which previously froze routing and produced 404s when that list
went stale. Each caller must expose the named environment variables through its inherited GitHub
Actions secrets.

The central budget is also fixed here: three investigation turns, one 24-request per-lane call
budget, a four-minute (240s) lane deadline, and a 5-second time-to-first-token budget.

- **timeout_ms = 60000 per transport.** The fast local probe (3.4s end to end for a ~26k char
  panel-sized prompt) is a lower bound, not a ceiling -- `max_diff_chars` allows prompts up to
  2,000,000 chars, far larger than that probe's payload. 60000ms is a conservative, sizeable cut
  from the prior 180000ms (3x) that still leaves generous room for larger real reviews.
- **openrouter_ttft_ms = 5000ms.** The measured TTFB was 634ms for a panel-sized streaming call;
  5000ms is ~7.9x that single sample. This is safe *because* every transport here declares
  `stream: true` and `openrouter_stream` is `"true"` -- see "TTFT is not always TTFT" below for why
  that declaration is load-bearing and what stops it from silently lying.

A provider that does not answer within that envelope fails over or fails closed; it cannot stretch
a hosted job or silently consume an unbounded retry budget.

**Two timeout knobs, kept in lockstep.** The policy carries both a per-transport `timeout_ms`
(embedded in the `transports` JSON blob emitted by `emit-policy.mjs`, covering all three
transports including OpenRouter) and a separate top-level `openrouter_timeout_ms` /
`openrouter_ttft_ms` pair, forwarded as the dedicated `openrouter-timeout-ms` / `openrouter-ttft-ms`
action inputs. Which one the OpenRouter-compat code path in the hosted action actually honors is
not visible from this repository. `timeout_ms` (60000 on every transport) and
`openrouter_timeout_ms` ("60000") are kept in lockstep so that ambiguity can't leave either one
silently carrying the old, oversized budget.

**TTFT is not always TTFT.** On a non-streaming call, the abort controller `openrouter_ttft_ms`
drives wraps the *entire* fetch, not just the wait for a first byte -- a buffered response's
headers only arrive once generation is complete. So on that path, "TTFT" is not a
time-to-first-token gate; it is a hard total-generation cap. This was not a hypothetical found by
reading code: a live run of this exact policy showed a Fireworks call fall back to non-streaming
(`stream=disabled` in the job log, despite the policy declaring `stream: true`) because of a
single-slot streaming gate that serializes concurrent persona lanes. Making streaming unconditional
in the hosted action is a separate fix, tracked outside this repo; what belongs here is making sure
that if a transport is *ever* declared non-streaming again -- by that bug, by a future edit, by
anything -- a tight `openrouter_ttft_ms` cannot silently become a generation ceiling. `emit-policy.mjs`
enforces that: if any transport has `stream !== true`, or `openrouter_stream !== "true"`, then
`openrouter_ttft_ms` must be `>=` the largest configured timeout (every transport's `timeout_ms` and
`openrouter_timeout_ms`), or policy load fails loudly with the offending transport named in the
error. When every transport genuinely declares streaming on -- the committed state today -- a tight
TTFT is exactly the healthy, intended shape and is left alone. `scripts/emit-policy.test.sh` proves
both halves: the committed policy (ttft 5000 < timeout 60000, streaming on) loads cleanly, and two
counterfactuals -- flipping a transport's `stream` to `false`, and flipping the global
`openrouter_stream` to `"false"` -- each with that same 5000ms ttft, are rejected by the guard.

**Lane-deadline arithmetic invariant.** A lane advances through the declared transports in order,
so the worst case for one lane is every transport burning its full `timeout_ms` before the lane
gives up. `emit-policy.mjs` enforces `sum(transport.timeout_ms) <= budget.lane_deadline_ms` at
policy-load time (both in the reusable workflow and in CI) -- summed over however many transports
the policy declares, not a hardcoded count -- and `scripts/emit-policy.test.sh` re-checks the same
inequality against the committed policy plus a counterfactual fixture that violates it. Separately,
`max_passes * lane_deadline_ms` must stay inside the job's own `timeout-minutes`
(`.github/workflows/review-yeti.yml`), or a hosted run can be killed mid-lane by the runner instead
of failing closed on its own terms; `emit-policy.test.sh` checks that too. With 3 transports at
60000ms each: `3 x 60000 = 180000 <= 240000` (60s of the lane deadline spare), and
`max_passes(3) x lane_deadline_ms(240000) = 720000 <= 1200000` (the 20-minute job cap). This guards
against a repeat of the incident that motivated this change: at `timeout_ms: 180000` per transport,
even 2 of the 3 transports alone summed to 360s against a 240s lane deadline, so a slow or stalled
primary made the OpenRouter fallback structurally unreachable in exactly the case it exists for.

Before the model action starts, the reusable workflow runs `scripts/review-yeti-smoke.mjs` against
each configured transport using a bounded, review-shaped JSON request. The smoke test records only
transport names and status, never credentials or response bodies, and fails closed when no
transport can complete the request. Its contract tests run in the central validation workflow so
provider order, OpenRouter routing, response validation, fallback behavior, and policy-drift
rejection are checked before a release can advance.

## Distribution

The Review Yeti bot is selected by the platform release channel (`action_channel: v1` in `policy/review-yeti.json`). The workflow resolves that channel to an exact commit, checks the tag target and main reachability, then binds the action's `action-sha` input to the resolved commit. There is no per-repository SHA override or emergency bypass; changes advance through the central channel's reviewed promotion. See review-yeti-ai/review-yeti-bot `docs/RELEASING.md`.
