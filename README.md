# exampleorg Review Actions

This private repository owns the organization-wide Review Yeti workflow contract.
Consumer repositories contain only a small, identical `pull_request_target` shim. The
review policy, provider routing, exact-head validation, verdict gate, and recovery contract
live here. Central development runs on `main`; consumer repositories use the promoted `v1`
release channel.

## Infrastructure ownership

This repository owns Review Yeti policy and runtime behavior, not shared cloud
infrastructure. The Bifrost gateway manifests, deployment script, secret
materialization contract, and operational runbook are maintained in the
private `exampleorg/example-infra` repository under
`deploy/bifrost-pilot/`. Review Yeti retains only its independently revocable
virtual key and the provider-routing policy that consumes the gateway.

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
the rollback record. The workflow captures the exact old `v1`, then performs one atomic push
leased against both that ref and the validated `main` tip. Ref movement rejects the whole
operation. A successful or idempotent run uploads a receipt containing the actor, release and
check-run identities, validation digest, old/new SHAs, and rollback baseline. Revert the
corresponding change on `main` and promote that new descendant to roll back; never rewind `v1`.

The central policy selects the Review Yeti action by the single `v1` release channel. The reusable
workflow resolves that channel to the exact commit for each run, checks out that commit (never the
mutable ref), and verifies that it is reachable from the bot repository's `main` and targeted by
the exact `v1` release tag before executing it. This keeps the action self-updating at the release
channel without per-repository SHA edits or mutable, unverified code execution.

## No consumer-owned Review Yeti configuration

The policy is `policy/review-yeti.json` in this repository. Consumer repositories must not
contain `.review-yeti*`, `.ct-review*`, or persona override files. The reusable workflow rejects
those paths before any model request.

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
3. The promotion workflow atomically compare-and-swaps the `v1` branch to the merged `main`
   commit and records an immutable receipt. A legacy `v1` tag, if present, is removed in the
   same transaction.
4. New consumer PRs automatically use the new policy; no consumer PR or body stamp is required.

The central policy is intentionally boring: changes are reviewed by the trusted development line,
then promoted only after validation. The model may identify recurring failures and propose a PR,
but it never writes directly to `main` or `v1`, changes release policy, or self-approves a
promotion.

### Ref protection inventory (example-meta ADR 0431)

The invariants above are mechanically enforced by repository settings, recorded here because
settings are not visible in the tree:

| Guard | Mechanism | What it prevents |
| --- | --- | --- |
| `v1 release channel branch protection` (ruleset 21052007) | deletion + non-fast-forward on `refs/heads/v1` | rewinding or deleting the channel |
| `v1 tag shadow guard (ADR 0431)` (ruleset 21752583) | creation + update + deletion blocked on `refs/tags/v1` | recreating the legacy `v1` tag, which would shadow the branch in `uses:` resolution (git resolves tags before heads) |
| `release tags immutable once created (ADR 0431)` (ruleset 21752607) | update + deletion blocked on `refs/tags/v*.*.*` | moving or deleting a published release tag |
| `main` classic protection | required `validate` + `review / Review Yeti` checks | unvalidated commits becoming promotable |
| `promote-v1.yml` / `scripts/promote-v1.sh` | atomic compare-and-swap push leased against the observed old `v1` and validated `main` tip, sha256 receipts | racing or stale promotions |
| `scripts/validate-release-provenance.sh` | run-time fail-closed check that the resolved release-channel commit is reachable from `main` | executing a hijacked or disjoint channel commit |

Known residual (accepted in ADR 0431): the built-in GitHub Actions app cannot be added to a
ruleset bypass list or a classic push allowlist via the API, so an org member with push access
can still fast-forward push onto `v1` out-of-band. A divergent push fails the next promotion's
ancestor check and the provenance guard; a main-reachable push has already passed `main`'s
required checks. If full push prevention is ever required, promote via a token minted from the
org-owned `ct-review-bot` GitHub App and allowlist only that app.

Consumer repositories reference this channel as `@v1` and their required contracts reject SHA
pins by design — see example-meta ADR 0431 for the decision record and revisit triggers.

## Fireworks timeout debug

The hosted panel uses `openrouter-ttft-ms` across the enabled model transports. Fireworks, Gemini,
Ollama, and the OpenRouter route all stream their responses, so the 60-second TTFT deadline
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
receipt without printing credentials or response content. Fireworks is disabled in the production
transport plan; this probe remains available for an explicitly dispatched diagnostic comparison.

## Provider order

The current standard transport plan is deliberately limited and ordered:

1. OpenRouter (`OPENROUTER_REVIEW_FLEET_KEY`) as the primary reviewer
2. Synthetic (`SYNTHETIC_API_KEY`)
3. Gemini (`GEMINI_API_KEY`, `enabled: false`) retained for quick re-enable
4. Ollama (`OLLAMA_PR_REVIEW_API_KEY`, `enabled: false`) retained for explicit qualification
5. Fireworks (`FIREWORKS_PR_REVIEW_API_KEY`, `enabled: false`) retained for explicit qualification only

Synthetic is a direct OpenAI-compatible transport using `hf:zai-org/GLM-5.3-Flash`. This is the
current catalog model selected for its supported high reasoning, JSON mode, structured outputs,
and low published subscription price; Synthetic does not currently expose a DeepSeek V4 0731 model
identifier. The model is deliberately explicit rather than using a moving `syn:` alias.
Synthetic is admitted with a policy ceiling of `max_in_flight: 5` and
`concurrency_scope: model`. Synthetic documents one concurrent request per model and 500 rolling
five-hour requests per subscription pack. Hosted admission derives `/v2/quotas` only from the
already validated `https://api.synthetic.new` provider origin, derives a live pack count only from
an exact 500-request multiple, clamps the handoff at or below the five-slot policy ceiling, and
fails safe to one slot when the endpoint or its under-development response shape is unavailable.
Weekly-credit state remains telemetry rather than a concurrency signal.

`OLLAMA_PR_REVIEW_API_KEY` is sourced from the masked Doppler secret in
`example-workspace/prd` and synchronized to the repository's GitHub Actions secret of the same name.
`GEMINI_API_KEY` and `SYNTHETIC_API_KEY` must likewise be populated from production-scoped
credentials before the `v1` release channel is promoted. A development-only credential may be
used for one-time qualification, but it is not sufficient evidence for production activation.

The Ollama-only repository set (`exampleorg/example-api`, `example-infra`,
`example-release`, `example-meta`) enables only Ollama (operator directive 2026-09-02: OpenRouter is
removed from the live review path for these repositories, including as a fallback). Their
six-call `max_in_flight` value matches the current six-persona panel width; it is a local
ceiling, not a reservation of the Ollama Team plan's shared account capacity. Provider capacity
responses still enter the runtime's cumulative 30-second wait/retry budget, so concurrent
non-review workloads can consume account slots.
The workflow references only the GitHub secret; neither policy nor workflow files contain the
credential value.

The action uses deterministic weighted striping across persona lanes: OpenRouter has weight 2 and
Synthetic has weight 1, so OpenRouter remains primary by volume while Synthetic receives normal
review work rather than waiting for an outage. Each lane still carries the other healthy transport
as a fallback, and the total remains one baseline model call per persona. Gemini, Ollama, and
Fireworks remain declared for explicit qualification, but their `enabled: false` settings keep them
out of production admission. Re-enabling Gemini or Ollama later adds its existing weight-1 stripe
without changing consumer repositories. OpenRouter admits at most two provider-scoped calls at a
time and lets later lanes wait up to 120 seconds for a slot. This keeps a six-persona large-diff
panel from presenting four large prompts to the gateway concurrently or abandoning queued work at
the former 30-second admission limit. The runtime requires compatible
request parameters, the policy's
`strict` output marker, and throughput-ranked provider routing while delegating endpoint eligibility
to OpenRouter's live policy except for the account-level Morph and Fireworks exclusions recorded
after their verified incidents. Model selection is explicit: OpenRouter receives
`deepseek/deepseek-v4-flash-0731` first and `z-ai/glm-5.3-flash` as its only model fallback via
the documented `models` array; the Auto Router alias and plugin are not used. In the current hosted
panel, `strict` is a policy declaration: the runtime sends JSON mode
(`response_format: { type: "json_object" }`) and validates the terminal payload, but it does not
enforce one cross-provider JSON Schema. Each caller must expose the five named environment
variables through its inherited GitHub Actions secrets. Fireworks stays on the default serverless
tier. All five transports use `high` reasoning. Provider/model semaphores bound concurrency;
direct HTTP 429 responses retry only when `Retry-After` fits the declared five-second retry budget,
then fail over under a provider-scoped circuit breaker. OpenRouter retains its own model fallback
and endpoint-selection recovery.

The central budget is also fixed here: two investigation turns, one 24-request per-lane call
budget, an 860-second lane deadline with a two-minute non-generation reserve and a 40-second
job-cap reserve, and a 60-second OpenRouter first-token budget.

## One-time OpenRouter qualification

The manually dispatched `One-time OpenRouter qualification` workflow is the bounded proof path
for the direct DeepSeek-to-GLM route. It is not scheduled and cannot publish a review or mutate
provider policy. A full run executes the three fixed fixtures twice with two calls in flight, which
matches the OpenRouter transport's provider-scoped capacity instead of allowing a third lane to
expire in the local queue. The child process is capped at ten minutes and the workflow at fifteen.

The sanitized receipt separates integrity from acceptance. Integrity proves exact refs, fixture
identity, request shape, and OpenRouter attribution. Acceptance fails closed unless all six rows
terminate, at least three of the four defect rows detect their defect, and neither clean row
produces a false positive. Failed evidence is still uploaded by the workflow for diagnosis, but it
cannot be mistaken for a successful qualification or authorize activation.

The clean sentinel is `table-driven-consolidation-preserves-coverage`. The former
`clean-behavioural-guard` fixture is intentionally excluded from this promotion gate after human
adjudication found real semantic bypasses in its literal-token implementation. Treating those
findings as false positives would reward a model for overlooking a defect; changing the sentinel
preserves the review charter and does not add fixture-specific model instructions.

## One-time Fireworks/Ollama comparison

When an operator wants evidence for moving more work to Ollama, use the manually dispatched
`One-time Fireworks/Ollama comparison` workflow. It requires the exact target repository, PR
number, base/head SHAs, and exact `review-yeti-bot` commit, then verifies those coordinates through
the GitHub API before starting a model request. Each dispatch runs thirteen fixed fixtures once
through a Fireworks-only arm and once through an Ollama-only arm. Fixtures are serial within each
arm (`concurrency: 1`); the two arms run in parallel. Both arms use high reasoning, streaming, a
150-second inactivity window, a 30-second connection window, and a 24,576-token output ceiling.
Both also invoke the same current-testing evaluator arm and synthetic prompt identity.

This is a bounded evidence run, not a canary or a review trigger: it has no schedule, pull-request
event, recurring rerun, traffic split, comment/check/review publication, merge authority, or
provider mutation. Neither arm is authoritative. The uploaded receipt
contains only aggregate counts, bounded per-fixture outcomes and routing labels, latency, cost,
exact-head coordinates, digests, and at most two content-free response-attempt summaries per
fixture. Attempt summaries retain only closed outcome/effort/output classifications and bounded
status, latency, token counts, and presence/size fields; they contain no findings, model text,
reasoning trace, provider error body, exception message, or credentials. A
completed comparison is only evidence for a later manual decision. One receipt represents one
independent run; at least three sequential manual dispatches are required before a provider
decision. The qualification workflow itself never mutates provider order or the `v1` consumer path;
those are controlled by a separate, reviewed control-plane policy change.

The receipt embeds both implementation identities: the exact central-action commit selected by
the manual dispatch and the exact `review-yeti-bot` commit checked out for both arms.

Both arms use the same fail-closed integrity checks: exact fixture ids and categories, provider and
transport attribution, first-attempt reasoning and token settings, bounded attempt history,
terminal parseability, streaming, and telemetry consistency. The workflow fails when that evidence
is incomplete or misattributed. A valid run with missed defects, clean false positives, or malformed
output recovery remains a successful evidence run and records the stricter per-arm quality gate as
failed; it does not activate either provider. Route sampling is intentionally not identical:
Fireworks uses its configured temperature without a deterministic seed, while Ollama uses its
configured deterministic sampling. Receipts therefore compare the two configured operational
routes, not pure model weights under an identical sampler. Missing provider usage or cost data is
recorded as unavailable rather than zero, so this workflow cannot support a pricing conclusion
without complete telemetry.

The qualification receipt schema is `review-yeti.ollama-qualification.v7`. It retains the bot's
output-contract provenance per fixture and records whether policy intent, the observed request
mode, provider capability, and terminal parsing were reported. These fields are evidence only:
they do not alter the provider order, verdict gate, or activation boundary.

- **timeout_ms = 120000 for Synthetic and disabled Fireworks, 90000 for Gemini, Ollama, and the OpenRouter route.**
  Streaming body reads re-arm the engine's stall/idle timer on every SSE chunk, while the released
  runtime also enforces `timeout_ms` as the hard total wall-clock ceiling for each generation.
  Synthetic's ceiling is 120 seconds because a hosted exact-head run remained healthy but was cut
  off immediately after the former 90-second limit. These values were raised from a previous
  75000/30000/45000 once the CI invariant below stopped modeling them as a wall-clock sum (see
  exampleorg/example-meta ADR 0337 for the full decision).
- **stall_ms = 20000 per transport.** The engine's liveness window: if a transport goes silent for a full
  `stall_ms` after connecting (no SSE chunk, including `reasoning_content`), the call is declared
  dead and the lane fails over. This matches the engine's own default and is declared in policy so
  it participates in the lane-deadline invariant below and is tunable without an engine change.
- **ttft_ms = 60000 per transport.** The action uses this value as the first-meaningful-output
  budget. Because every configured transport streams, TTFT is measured at the first SSE chunk and
  does not cap a generation after streaming has begun.

A provider that never connects, goes silent for a full `stall_ms` window, or reaches its total
`timeout_ms` ceiling fails over or fails closed.

**One explicit deadline contract per transport.** Every emitted transport now carries
`timeout_ms`, `connect_timeout_ms`, `ttft_ms`, and `stall_ms`; the handoff validator rejects a plan
that loses any one of them. The released runtime consumes those transport fields directly. The
top-level `openrouter_timeout_ms`, `openrouter_ttft_ms`, and `stall_ms` fields remain compatibility
aliases for existing callers. Policy validation keeps them in lockstep with the OpenRouter
transport so they cannot silently diverge; other transports remain free to use their own
provider-qualified liveness windows.

**Streaming is an invariant.** Every transport declares `stream: true` and the global
`openrouter_stream` flag is `"true"`. Each persona lane owns one active request at a time, while
provider/model semaphores permit independent providers to stream concurrently without exceeding
their declared capacity. `emit-policy.mjs` rejects a future policy that makes only one transport
non-streaming while retaining a tight TTFT budget; `scripts/emit-policy.test.sh` exercises that
counterfactual. This keeps provider attribution and first-token telemetry intact without disabling
SSE to hide upstream failures.

**Lane-deadline arithmetic invariant (dead-transport envelope).** The runtime applies each
transport's `timeout_ms` as a total generation ceiling. The separate policy-load invariant below
guards the faster **dead-transport** path: a transport that
never produces a first byte (`connect_timeout_ms`) or that goes silent after connecting for a full
`stall_ms` interval. `emit-policy.mjs` enforces
`sum(transport.connect_timeout_ms + transport.stall_ms) * openrouter_max_attempts * max_investigation_turns + budget.lane_overhead_ms <= budget.lane_deadline_ms`
at policy-load time (both in the reusable workflow and in CI) -- summed over however many
enabled transports the policy admits, not a hardcoded count -- and `scripts/emit-policy.test.sh` and
`scripts/review-yeti-smoke.mjs` (a previously-drifted duplicate of the same check) re-check the
same inequality against the committed policy plus counterfactual fixtures that violate it.
Separately,
`max_passes * lane_deadline_ms` must stay inside the job's own `timeout-minutes`
(`.github/workflows/review-yeti.yml`), or a hosted run can be killed mid-lane by the runner instead
of failing closed on its own terms; `emit-policy.test.sh` checks that too. With 2 enabled transports at
`connect_timeout_ms` `20000 + 15000 = 35000`, plus `2 x 20000 = 40000` stall reserve,
`(35000 + 40000) x 2 attempts x 2 turns + 120000 overhead = 420000 <= 860000`, and
`max_passes(1) x lane_deadline_ms(860000) = 860000 <= 900000` (the 15-minute job cap, leaving
40s for workflow setup, publishing, and verdict enforcement). The workflow's hard 15-minute job
timeout remains the final backstop. Validation,
failover dispatch, and evidence work are accounted for by the lane overhead reserve rather than by
an unbounded wait. This still guards against a repeat of the incident that
originally motivated this invariant -- a full sequential failover of transports that never connect
or never stream must still finish inside the lane deadline.

Before the model action starts, the reusable workflow runs `scripts/review-yeti-smoke.mjs` against
each configured transport using a bounded, review-shaped JSON request. The smoke test records only
transport names and status, never credentials or response bodies, and fails closed when no
transport can complete the request. Before smoke runs, the workflow decodes the base64 transport
handoff and verifies that it exactly matches the checked-out policy, has unique names, and streams
every entry. Its contract tests run in the central validation workflow so
provider order, OpenRouter routing, response validation, fallback behavior, and policy-drift
rejection are checked before a release can advance. The smoke result is also an admission filter:
the action receives only transports that passed preflight. The runtime then applies the configured
striped weights to that healthy subset and retains deterministic lane-local failover order. A
known-unhealthy provider therefore remains configured and visible in telemetry but cannot consume
every lane's runtime budget before healthy failover begins.

## Transport telemetry

The `Transport telemetry` workflow (`.github/workflows/transport-telemetry.yml`) is a scheduled
(daily, off-peak) plus manually-dispatched, read-only, non-publishing smoke run. It exists to give
`example-meta` ADR 0481 ("keep Fireworks disabled, tune OpenRouter; revisit on multi-run per-provider
evidence") and ADR 0467 ("revisit provider weights and capacities only with account-tier evidence
plus per-provider latency, queue, rate-limit, and review-quality receipts") the multi-run evidence
stream their revisit bars require, without adding a second review path.

It probes every transport declared in `policy/review-yeti.json` -- enabled or not, so Gemini,
Ollama, and Fireworks accrue evidence alongside the active OpenRouter/Synthetic pair -- using the
same bounded `probeTransport()` machinery `review-yeti-smoke.mjs` uses for production admission
(`scripts/transport-telemetry.mjs`). It never touches a pull request, runs the review panel, or
publishes a comment, check, review verdict, merge decision, or provider mutation; a missing
credential is recorded as `skipped: no_credential`, never a failure.

Each run appends one JSON line per transport (schema
`exampleorg.review-yeti.transport-telemetry.v1`: transport, model, enabled, outcome, HTTP
status, failure class, TTFT/total latency, timeout/rate-limit flags, run id, timestamp) to an
orphan `telemetry` branch's `transport-ledger.jsonl`, and uploads the same run's ledger as a
90-day workflow artifact. The durable ledger lives on its own branch, never on `main`, so the
review-contract history stays uncluttered by daily telemetry commits.

Read the ledger with `scripts/transport-telemetry-report.mjs`, which prints per-transport p50/p90
TTFT, p50/p90 total latency, timeout rate, rate-limit rate, and sample count over a lookback
window:

```bash
git fetch origin telemetry
node scripts/transport-telemetry-report.mjs --days 7
# or against a local export / CI artifact:
node scripts/transport-telemetry-report.mjs --ledger /path/to/transport-ledger.jsonl --days 30
```

This ledger covers exactly what a bounded chat-completion smoke can observe: latency and
rate-limit/timeout evidence. It does not measure queue depth or review-quality (false-positive/
false-negative rate); those remain open ADR-0467 revisit-bar columns for a future, differently-
scoped instrument and are intentionally not fabricated here.

## One-time same-engine DOKS comparison

The `One-time same-engine worker parity qualification` workflow is the manual hosted half of a
DOKS comparison. It pulls one exact `review-yeti-worker@sha256:...` artifact, reviews an exact pull
request head through the worker's `same-head` profile, and uploads only the sanitized receipt.
The matching DOKS run must use that same worker digest, model, timeout, policy digest, and config
digest. Receipt comparison fails closed if the engine, provider topology, or resolved lane models
differ.

This workflow has no schedule or pull-request trigger, cannot publish a review, has read-only
GitHub permissions, and is capped at 15 minutes. Registry credentials should be short-lived,
read-only credentials installed only for the explicit run and removed afterward. A successful
comparison is qualification evidence; it does not enable the DOKS App gate or make DOKS a required
check.

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

The Review Yeti bot is selected by the platform release channel (`action_channel: v1` in the
`policy/review-yeti.json`). The workflow resolves that channel to an exact commit, checks the
tag target and main reachability, then executes the checked-out action. There is no
per-repository SHA override or emergency bypass; changes advance through the central channel's
reviewed promotion. Until the dedicated release guide lands, see the
[review-yeti-bot release section](https://github.com/review-yeti-ai/review-yeti-bot#5-reviewed-semver-releases).

The credential-free execution-plan fixture records the provider behavior that central policy
claims to configure without exposing endpoint URLs or credential environment names. It marks
runtime-owned retry/default behavior as uncharacterized instead of inventing a value. Validate
the committed normalized plan and digest with:

```bash
node scripts/emit-execution-plan.mjs --check
```

Unknown policy keys and unclassified endpoint families fail this check. The fixture is
characterization evidence only; the production workflow does not consume it.

See also: Ollama-only repository set (operator directive 2026-09-02) — `example-api`, `example-infra`, `example-release`, `example-meta` enable only Ollama.
