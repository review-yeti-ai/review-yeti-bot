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

The hosted panel uses `openrouter-ttft-ms` across the model transports. Fireworks, Ollama,
and the OpenRouter fallback all stream their responses, so the 30-second TTFT deadline
measures the first SSE token rather than a fully buffered JSON body. OpenRouter requires
BF16/FP16 endpoints, sorts the eligible provider catalog by throughput, applies a p90
throughput floor and p99 latency preference, and allows eligible hosts to fall over.
Smoke sends `stream: true` for every configured transport.

Smoke logs `elapsed_ms` and `http` per transport. For a panel-sized probe:

```bash
doppler run --project example-workspace --config prd -- \
  node scripts/review-yeti-fireworks-debug.mjs
```

The script never prints the API key. Both probes are streaming and record their first-byte
receipt without printing credentials or response content.

## Provider order

The current standard transport plan is deliberately limited and ordered:

1. Fireworks (`FIREWORKS_PR_REVIEW_API_KEY`)
2. Ollama (`OLLAMA_PR_REVIEW_API_KEY`)
3. OpenRouter (`OPENROUTER_REVIEW_FLEET_KEY`) as the final fallback

`OLLAMA_PR_REVIEW_API_KEY` is sourced from the masked Doppler secret in
`example-workspace/prd` and synchronized to the repository's GitHub Actions secret of the same name.
The workflow references only the GitHub secret; neither policy nor workflow files contain the
credential value.

The action starts each model turn at Fireworks and advances through the declared order when a
transport fails. The OpenRouter entry requires compatible request parameters, strict investigation
output, and throughput-ranked routing while delegating quantization and endpoint eligibility to
OpenRouter's live policy except for the account-level Morph exclusion recorded after its verified
timeout incident. Each caller must expose the
three named environment variables through its inherited GitHub Actions secrets. Fireworks stays
on the default serverless tier; Fireworks and
OpenRouter use maximum reasoning, while Ollama uses its documented `high` setting. Each transport
gets one retry, and OpenRouter owns endpoint selection after a timeout.

The central budget is also fixed here: two investigation turns, one 24-request per-lane call
budget, a fifteen-minute (900s) lane deadline with a two-minute non-generation reserve, and a
30-second OpenRouter first-token budget.

- **timeout_ms = 120000 for Fireworks, 90000 for Ollama and the OpenRouter fallback.** Since
  `review-yeti-bot` PR #163, an actively-streaming response is never aborted by a duration cap --
  the engine's stall/idle timer re-arms on every SSE chunk -- so `timeout_ms` is now primarily a
  ceiling on the non-streaming fallback path and a sanity bound (1ms-180000ms), not a budget that
  every healthy call is assumed to burn in full. These values were raised from a previous
  75000/30000/45000 once the CI invariant below stopped modeling them as a wall-clock sum (see
  exampleorg/example-meta ADR 0337 for the full decision).
- **stall_ms = 20000.** The engine's liveness window: if a transport goes silent for a full
  `stall_ms` after connecting (no SSE chunk, including `reasoning_content`), the call is declared
  dead and the lane fails over. This matches the engine's own default and is declared in policy so
  it participates in the lane-deadline invariant below and is tunable without an engine change.
- **openrouter_ttft_ms = 30000ms.** The action uses this value as the OpenRouter first-token/connect
  budget. Because every configured transport streams, TTFT is measured at the first SSE chunk and
  does not cap a generation after streaming has begun.

A provider that never connects, or that goes silent for a full `stall_ms` window, fails over or
fails closed; a healthy, actively-streaming provider cannot stretch a hosted job past what a
duration cap used to allow, because there no longer is one.

**Two timeout knobs, kept in lockstep.** The policy carries both a per-transport `timeout_ms`
(embedded in the `transports` JSON blob emitted by `emit-policy.mjs`, covering all three configured
transports including OpenRouter) and a separate top-level `openrouter_timeout_ms` /
`openrouter_ttft_ms` pair, forwarded as the dedicated `openrouter-timeout-ms` / `openrouter-ttft-ms`
action inputs. Which one the OpenRouter-compat code path in the hosted action actually honors is
not visible from this repository. The OpenRouter transport timeout (90000) and
`openrouter_timeout_ms` ("90000") are kept in lockstep so that ambiguity can't leave either one
silently carrying a stale budget.

**Streaming is an invariant.** Every transport declares `stream: true` and the global
`openrouter_stream` flag is `"true"`. The action's single-slot streaming gate serializes the full
Fireworks-to-Ollama-to-OpenRouter transport plan per persona, so a failover never opens a sibling SSE stream
over the active one. `emit-policy.mjs` rejects a future policy that makes only one transport
non-streaming while retaining a tight TTFT budget; `scripts/emit-policy.test.sh` exercises that
counterfactual. This keeps provider attribution and first-token telemetry intact without disabling
SSE to hide upstream failures.

**Lane-deadline arithmetic invariant (dead-transport envelope, not a timeout_ms sum).** Since an
actively-streaming call is never aborted by a duration cap, `timeout_ms` no longer bounds a lane's
worst-case wall time and summing it across every transport, attempt, and investigation turn (the
pre-#163 model) would reject healthy configurations that could never actually exceed the deadline
-- exactly the failure mode that once forced Fireworks' `timeout_ms` down from a requested 120000
to 75000. What genuinely bounds the worst case is the **dead-transport** path: a transport that
never produces a first byte (`connect_timeout_ms`) or that goes silent after connecting for a full
`stall_ms` interval. `emit-policy.mjs` enforces
`(sum(transport.connect_timeout_ms) + transports.length * stall_ms) * openrouter_max_attempts * max_investigation_turns + budget.lane_overhead_ms <= budget.lane_deadline_ms`
at policy-load time (both in the reusable workflow and in CI) -- summed over however many
transports the policy declares, not a hardcoded count -- and `scripts/emit-policy.test.sh` and
`scripts/review-yeti-smoke.mjs` (a previously-drifted duplicate of the same check) re-check the
same inequality against the committed policy plus counterfactual fixtures that violate it.
Separately,
`max_passes * lane_deadline_ms` must stay inside the job's own `timeout-minutes`
(`.github/workflows/review-yeti.yml`), or a hosted run can be killed mid-lane by the runner instead
of failing closed on its own terms; `emit-policy.test.sh` checks that too. With 3 transports at
`connect_timeout_ms` `15000 + 30000 + 30000 = 75000`, plus `3 x 20000 = 60000` stall reserve,
`(75000 + 60000) x 2 attempts x 2 turns + 120000 overhead = 660000 <= 900000`, and
`max_passes(2) x lane_deadline_ms(900000) = 1800000 <= 2400000` (the 40-minute job cap, leaving
600s for workflow setup, publishing, and verdict enforcement). The explicit overhead reserve
covers streaming-gate wait, validation, failover dispatch, and evidence work that connect/stall
arithmetic alone cannot represent. This still guards against a repeat of the incident that
originally motivated this invariant -- a full sequential failover of transports that never connect
or never stream must still finish inside the lane deadline -- while no longer treating a slow but
healthy, actively-streaming generation as if it were that failure.

Before the model action starts, the reusable workflow runs `scripts/review-yeti-smoke.mjs` against
each configured transport using a bounded, review-shaped JSON request. The smoke test records only
transport names and status, never credentials or response bodies, and fails closed when no
transport can complete the request. Before smoke runs, the workflow decodes the base64 transport
handoff and verifies that it exactly matches the checked-out policy, has unique names, and streams
every entry. Its contract tests run in the central validation workflow so
provider order, OpenRouter routing, response validation, fallback behavior, and policy-drift
rejection are checked before a release can advance. The smoke result is also an admission filter:
the action receives only transports that passed preflight, in configured order. A known-unhealthy
provider therefore remains configured and visible in telemetry but cannot consume every lane's
runtime budget before healthy failover begins.

## CLI-first local reviews

The central policy can be exercised locally through the same bounded, read-only review engine used
by the hosted action. The launcher validates `policy/review-yeti.json`, materializes it into an
ephemeral 0600 config, and delegates to an already-installed `reviewyeti` executable. It never
downloads code, publishes to GitHub, or writes a repository configuration file.

```bash
# Validate the policy without credentials or network access.
./scripts/review-yeti-local check --json

# Confirm the installed local engine is available.
./scripts/review-yeti-local doctor --json

# Validate an MCP server manifest without connecting to servers or calling tools.
./scripts/review-yeti-local mcp validate --config ./mcp.json --json

# Review an immutable commit range from the current checkout.
./scripts/review-yeti-local review \
  --base "$BASE_SHA" --head "$HEAD_SHA" \
  --mcp-config ./mcp.json --json --output review-yeti.json

# Review an exact diff or a read-only GitHub pull request instead.
./scripts/review-yeti-local review --diff-file ./change.diff --json
./scripts/review-yeti-local review --pr exampleorg/example-review-actions#65 --json
```

`--base` and `--head` require full commit SHAs. The launcher exits with the delegated Review Yeti
status, preserves machine-readable stdout, and sends diagnostics to stderr. Set `REVIEW_YETI_BIN`
or pass `--cli-bin` when the executable is installed outside the default `PATH`; the wrapper does
not install or fetch it. Provider credentials remain in the caller's environment and are never
printed or written to the temporary config. MCP manifests are JSON with a `servers` array; the
launcher validates IDs, transports, endpoints, stdio commands, environment-key shape, duplicate
servers, and the API-key-only Linear policy. `mcp validate` performs no network requests or tool
calls. A validated manifest is passed to the installed engine through `MCP_CONFIG_JSON` for the
review process only; local reviews remain read-only and never publish MCP results to GitHub.

## Distribution

The Review Yeti bot is selected by the platform release channel (`action_channel: v1` in `policy/review-yeti.json`). The workflow resolves that channel to an exact commit, checks the tag target and main reachability, then binds the action's `action-sha` input to the resolved commit. There is no per-repository SHA override or emergency bypass; changes advance through the central channel's reviewed promotion. See review-yeti-ai/review-yeti-bot `docs/RELEASING.md`.

<!-- inert-config + target-config:none promoted with this change -->
