<p align="center">
  <img src="assets/review-yeti-panel.png" alt="Review Yeti and five specialist reviewers checking a pull request" width="720">
</p>

<h1 align="center">Review Yeti</h1>

<p align="center">A focused panel of AI reviewers for every pull request.</p>

<p align="center">
  <a href="https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/ci-cd.yaml"><img src="https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/ci-cd.yaml/badge.svg" alt="CI"></a>
  <a href="https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/review-bot.yaml"><img src="https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/review-bot.yaml/badge.svg" alt="Review Yeti workflow"></a>
  <a href="https://github.com/review-yeti-ai/review-yeti-bot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/review-yeti-ai/review-yeti-bot?label=license" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-43853d?logo=node.js&logoColor=white" alt="Node.js 20 or newer">
  <img src="https://img.shields.io/badge/action-v1-2088ff?logo=githubactions&logoColor=white" alt="GitHub Action v1">
</p>

# 🤖 review-yeti-bot

[![Review Bot](https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/review-bot.yaml/badge.svg)](https://github.com/review-yeti-ai/review-yeti-bot/actions/workflows/review-bot.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A GitHub Action that reviews your pull requests with a panel of AI reviewers and posts one
consolidated comment.**

Each reviewer is a persona with a narrow charter — security, performance, testing and so on —
and you can write your own in markdown. Install it with ten lines of YAML. There is no app to
install, no webhook to configure, and nothing to host.

**You bring an OpenRouter API key. Your code goes to the provider you chose, and the prompts
reviewing it are files in your repository.**

### Contents

| | |
|---|---|
| [Install](#install) | The ten lines of YAML |
| [What you get](#what-you-get) | An example of the posted comment |
| [Where reviewer configuration is read from](#where-reviewer-configuration-is-read-from) | Why config comes from the base ref |
| [What it costs](#what-it-costs) | Requests per run, diff budgets, large PRs |
| [Pi/MCP and CLI](#pimcp-and-cli) | In-repository execution and command-line surfaces |
| [Reference](#reference) | Every input and output |
| [Configuration](#configuration) | Choosing reviewers and writing your own |
| [Documentation](#documentation) | Deeper guides |

---

## Install

Add one file to any repository you want reviewed:

```yaml
# .github/workflows/review.yml
name: Review
on:
  pull_request:
    # Deliberately omit `synchronize`: a moved PR head or target/base branch
    # must not start another model review by default.
    types: [opened, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: review-yeti-ai/review-yeti-bot@v1
        with:
          llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          # Optional — enables Linear issue sync when the secret exists (API key only)
          linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

That is the whole setup — note there is no `actions/checkout` step, and none is needed. The
action reads the pull request diff, runs the reviewers in parallel, and comments on the PR using
your workflow's built-in `GITHUB_TOKEN`; no personal access token required.

The explicit `opened`/`reopened` list is intentional. GitHub otherwise includes `synchronize`,
which runs when the pull request head changes; the default examples do not start a new model
review when the PR head moves or the target/base branch advances. Add `synchronize` only as an
explicit opt-in when that rerun policy is wanted. Every run remains bound to the event's exact PR
head, and the action refuses stale publication if that head changes during execution.

You supply an OpenRouter API key (and may override its compatible base URL). **You own the key
and the prompts**; nothing is sent to a third-party review service beyond OpenRouter.

**Linear (optional, API key only):** set `LINEAR_API_KEY` as a repository secret and pass it via
`linear-api-key`. When present, Linear tools/sync are enabled; when absent, Linear is skipped
and the review still runs. The central `review-yeti-ai/review-yeti-bot` runner enables this by default
from its own `secrets.LINEAR_API_KEY`.

- **Auth policy:** `LINEAR_API_KEY` only. OAuth Linear MCPs are **rejected** (including
  `https://mcp.linear.app/sse`, `mcp-remote`, and `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET`).
- **Approved package:** [cline/linear-mcp](https://github.com/cline/linear-mcp) (stdio +
  `LINEAR_API_KEY`). Built-in `builtin-linear` adapter uses the same API-key model.

> **No key yet?** The action fails closed without posting a successful verdict. It never presents
> static pattern checks as a model review.

## Pi/MCP and CLI

Review Yeti is one repository containing the GitHub Action, CLI/runtime contracts, and Pi/MCP
integration. The Pi adapter lives under `src/pi/` and is tested by `npm run test:pi-adapter`.
It uses the same exact-head identity and trusted-base policy as the Action, but exposes only
bounded read-only tools. It cannot run shell commands, mutate GitHub, write memory, or discover
arbitrary tools. See [the Pi/MCP adapter guide](docs/PI_MCP_ADAPTER.md) for the construction and
security contract.

### Manual evaluation toolkit

The full baseline evaluation is an explicit release-level tool, not an automatic pull-request
workflow. Run the credential-free fixture suite with:

```bash
npx review-yeti eval run --fixture tests/fixtures/review-intelligence/offline-promotion-matrix.json
```

Use `npx review-yeti eval tui` for the terminal view, or see
[the evaluation CLI guide](docs/EVALUATION_CLI.md) for live runs, receipts, comparisons, and exit
codes.

### Local bounded review

The production bounded engine is also available as a no-publication local command. Use one
immutable source mode per run and keep diagnostics off machine-readable stdout:

```bash
reviewyeti review --base "$BASE_SHA" --head "$HEAD_SHA" --json
reviewyeti review --diff-file ./change.diff --output ./review-run.json
reviewyeti review --pr review-yeti-ai/review-yeti-bot#31 --json
reviewyeti doctor --json
```

See [the local CLI guide](docs/CLI.md) and [operations guide](docs/OPERATIONS.md). Local mode
cannot publish to GitHub; incomplete coverage, provider failure, and cancellation exit nonzero.

---

## What you get

A single comment on the pull request, in this shape:

> ## 🟡 **Verdict: FIX_FIRST**
>
> ### 📊 AI Review Panel Summary
> - **Repository**: `acme/checkout`
> - **Commit SHA**: `a1b2c3d`
> - **Review Mode**: Model-backed (`openrouter/auto-beta`)
> - **Parallel Personas Evaluated**: `5/5`
> - **Quorum Status**: `SATISFIED`
> - **Total Findings**: P0: `0` | P1: `1` | P2: `2`
> - **Rationale**: Changes requested for 1 P1 finding(s) and 2 P2 nit(s).
>
> ### 📋 Persona Evaluation Roster
> | Reviewer Persona | Model | Decision | Findings |
> |---|---|---|---|
> | 🛡️ Security & Tenancy Guardian | `openrouter/auto-beta` | ⚠️ FINDINGS | 1 |
> | ⚡ Performance & Scalability Specialist | `openrouter/auto-beta` | ✅ APPROVE | 0 |
> | 🏛️ System Architecture & Design | `openrouter/auto-beta` | ⚠️ FINDINGS | 2 |
> | 🧪 Testing & Quality Assurance | `openrouter/auto-beta` | ✅ APPROVE | 0 |
> | 📦 Dependency Safety & Supply Chain | `openrouter/auto-beta` | ✅ APPROVE | 0 |
>
> **🛡️ Security & Tenancy Guardian (1 finding)**
>
> 🟠 **P1** · **Order lookup not scoped to tenant**
> [`src/api/orders.ts:42`](#)
>
> The handler accepts a raw id and queries by primary key, so a caller can read another
> organisation's order.
>
> > **Fix:** Add `orgId` to the where clause.

Each finding links to the exact line on the reviewed commit. Findings for each reviewer sit in a
collapsible section, so a quiet review stays short.

Findings that name a file outside the diff are discarded before posting, so the bot cannot
comment on code that isn't there.

---

## Where reviewer configuration is read from

Reviewer charters are prompts executed with **your** API key, so the action deliberately does
**not** read them from the pull request under review. `.review-yeti.yaml` and
`.review-yeti/personas/` are fetched over the API from the pull request's **base** branch — code
that is already merged and reviewed.

Without this, a pull request could add its own persona files, rewrite the instructions of the
reviewer examining it, and declare as many reviewers as it liked against your account.
`config-ref` is retained only for compatibility and, when set, must equal the immutable pull
request base SHA; it cannot select another ref. `max-personas` bounds how large a roster may grow
regardless.

A consequence worth knowing: **changes to reviewer configuration take effect once merged**, not
on the pull request that proposes them.

### What is sent to your model provider

The pull request diff is sent to whichever endpoint you configure. The default `openrouter/auto-beta`
lets OpenRouter select a provider, which means you cannot state in advance which vendor received
your code or what their retention policy is. If that matters — proprietary code, regulated data,
a customer commitment — name an explicit model so the vendor is known:

```yaml
        with:
          model: anthropic/claude-sonnet-4     # a named vendor, not "auto"
          llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

Transient provider failures are retried and then move through the ordered fallback models in
the trusted base-ref configuration. The repository default keeps
`deepseek/deepseek-v4-flash-0731` as the fallback for a slow or unavailable primary model:

```yaml
github_action:
  openrouter:
    model: openrouter/auto-beta
    fallback_models:
      - deepseek/deepseek-v4-flash-0731
```

The `openrouter-fallback-models` Action input can override that list. If every configured model
fails, the review remains `INCOMPLETE_REVIEW` rather than shipping with missing model coverage.
When the configured persona roster is large enough and a trustworthy two-thirds quorum survives,
the Action may publish `PARTIAL_REVIEW` evidence. That status retains findings, but it is always
`BLOCK`, `BLOCKED`, and non-mergeable.

`llm-base-url` points at any endpoint that speaks the OpenAI chat-completions shape — OpenAI
itself, or a gateway such as LiteLLM or vLLM in your own network. It is **not** a way to call a
vendor whose API differs: Anthropic's own endpoint takes `/v1/messages` with an `x-api-key`
header, so pointing this at `api.anthropic.com` fails. Reach Anthropic models by naming one
through OpenRouter, as above, or by putting a translating gateway in front.

## Why this rather than a hosted review service

- **You own the prompts.** Reviewer charters are markdown files in your repository. When the bot
  says something unhelpful, you edit the file that caused it.
- **You own the key.** Bring any OpenAI-compatible provider. Your code and diffs go to the
  provider you chose, not to an intermediary.
- **It is a GitHub Action.** No Review Yeti app installation, webhook endpoint, or Review Yeti
  managed server or database is required. When enabled, review continuity calls the API of one
  provider you select; Honcho is the default and the other adapters share the same contract.
- **Cost is bounded and visible.** One request per reviewer per push, with a per-reviewer diff
  budget you set.

It is deliberately simpler than a full review platform: no Review Yeti-managed codebase index or
general chat. By default it retains only authenticated decisions from the same pull request. An
optional API-backed memory provider can add bounded repository-scoped code signals, trusted-base
rules, feedback transitions, and PR session recaps when explicitly enabled; it never replaces the
authenticated GitHub decision ledger.

---

## What it costs

One request per enabled reviewer, per push. The default roster is five reviewers, and each
receives up to `max-diff-chars` of reviewable diff per pass (default **2_000_000**, the safety
ceiling — there is no cheap 24k throttle). Lower the budget only if you intentionally want to
bound cost; raise `max-passes` if a huge PR still omits files after packing. Each changed file also
has a complete per-file diff limit: the effective default is **5,000 characters**, independent of
the whole-request budget. Configure it with the Action input `max-file-diff-chars`, or with
`limits.max_file_diff_chars` in the reviewed repository's `.review-yeti.yaml`:

```yaml
        with:
          max-diff-chars: '2000000'   # default
          max-file-diff-chars: '10000' # optional per-file override
          max-passes: '3'            # ceiling when packing oversized diffs, not "always 3"
```

The effective value follows this precedence, from strongest to weakest:

1. `max-file-diff-chars` Action input or `MAX_FILE_DIFF_CHARS` environment value when non-empty.
2. `limits.max_file_diff_chars` repository value in `.review-yeti.yaml` from the trusted PR base ref.
3. built-in default of **5,000**.

The hard per-file ceiling is 2,000,000 characters.

### Large pull requests

Two things happen before the budget is spent.

**Generated content is skipped.** The curated built-in catalog covers lockfiles, test snapshots,
generated files, build output, dependency caches, minified assets, source maps, and binary files.
Generated OpenAPI/API-spec artifacts such as `openapi.generated.json` and `schema.generated.yaml`
are included in the generated-files category. Ordinary source is not excluded by language; for
example, a hand-written `openapi.yaml` remains reviewable. A large pull request is often large
*because* of generated content — reviewing it spends the budget that source code needs and
produces findings nobody can act on. Add your own globs with `exclude`. Deliberate built-in
generated-file and configured repository path-policy/exclude skips are reported through
`files-skipped-generated`, separately from files that went unreviewed, because the two mean very
different things.

If every changed file is an intentional policy exclusion and no other coverage gap exists, the
Action emits `SHIP` as both the verdict and terminal review status. No model review runs; the
comment records the excluded paths as expected policy metadata. Oversized files are reported
separately through `files-oversized`, excluded before model input, and do not create a coverage gap
or block by themselves. `INCOMPLETE_REVIEW` remains for real coverage gaps such as omitted or
truncated eligible files, provider failures, or incomplete trusted-submodule coverage.

This is an explicit policy tradeoff: `SHIP` means no blocking finding was established in the
reviewable evidence; it does not claim that an oversized file was reviewed. A repository that
requires every changed file to be reviewed can raise the cap or add a merge gate for
`files-oversized != '0'`. The default remains non-blocking so generated specs and similar
expected artifacts cannot hold up an otherwise valid review.

Migration note: older versions emitted `NO_REVIEWABLE_FILES` for all-policy-excluded changes.
That legacy status is no longer emitted. Consumers should accept `SHIP` and use
`files-skipped-generated` / `files-oversized` when they need to distinguish a policy-only review
from a model-backed review.

The built-in patterns use the same glob rules as `exclude`: a pattern without `/` is
**filename-only** and matches that filename at any depth, while a slash-bearing pattern
matches the path shape. A glob prefixed with `!` **restores** matching files, including files
caught by a built-in pattern. Use restoration when the built-in list is wrong for your repository —
scripts kept in `bin/`, a vendored fork you actually maintain — or to carve an exception out of a
broad glob of your own:

```yaml
exclude:
  - '**/generated/**'                  # the orval client, the protobuf output, …
  - '!src/entities/generated/**'       # …but this one is hand-maintained despite the name
```

Negations are applied after every positive pattern, so the list means the same thing whatever
order you write it in. Restoration only removes the ignore match: the restored file still obeys
the effective 5,000-character (or configured) per-file cap.

An oversized source file is an expected policy exclusion. It is reported as oversized, named in the
review comment with its bounded diff size, and excluded before Context7/model input so giant specs
cannot balloon cost or invite hallucinated findings. It does not by itself block `SHIP`. This is distinct
from `files-omitted`, which reports eligible files that did not fit the whole-request packing
budget and still make coverage incomplete.

**What remains is packed into passes only if it exceeds one request.** `max-passes` is a
**ceiling**, not a required count: most PRs use **1** pass. If the reviewable diff still does not
fit one `max-diff-chars` budget (default 2_000_000), each reviewer makes **up to** `max-passes`
passes and findings are merged. That costs `personas × passes` requests; the comment reports how
many passes ran.

Only when a change exceeds even that are files **reported as not reviewed rather than dropped**:
the comment names them and marks the verdict as covering only part of the change.

A clean verdict on a partially reviewed diff is the most dangerous output this tool can produce,
so it is stated where the verdict is, not buried. `files-omitted` is also a step output, so a
workflow can fail when coverage is incomplete:

```yaml
      - if: steps.review.outputs.files-omitted != '0'
        run: exit 1
```

### Durable persona coverage and partial reviews

The Action measures persona coverage against the enabled roster resolved from the trusted PR base
configuration, never against the number of lanes that happened to launch. A lane counts as
trustworthy only when it returns a structured `APPROVE` or `FINDINGS` result with a findings array
and provider/model provenance. Errors, timeouts, empty or partial results do not count, although
findings they emitted remain durable evidence and can still be published.

The default fail-closed policy can be overridden in `.review-yeti.yaml`:

```yaml
coverage_policy:
  quorum: two_thirds             # two_thirds | simple_majority | unanimous
  min_personas: 3
  mandatory_personas: [security]
  provider_diversity_min: 2
```

`two_thirds` means `ceil(2 * expected_personas / 3)`; `simple_majority` means
`floor(expected_personas / 2) + 1`. Mandatory personas and the provider-diversity floor still
apply. A complete clean panel is `SHIP` with `gate-decision=PASS`. A quorum-met but incomplete
panel is `PARTIAL_REVIEW`; a below-quorum panel or one missing a safety floor is
`INCOMPLETE_REVIEW`. Both partial and incomplete outcomes force `BLOCKED` and
`merge-eligible=false`. Publication success therefore records evidence; it does not imply a
successful or mergeable review.

### What a reviewer is allowed to conclude from a partial view

A reviewer that sees one pass of a multi-pass diff cannot tell a file it was not shown from a file
that does not exist — and left to itself it reports the second. On a 32-file pull request this
produced four P1 findings claiming a 960-line service and a 1,088-line generated client were
missing; all were false, and disproving them took the author three round-trips.

Two things prevent it:

- **Every reviewer gets the whole file manifest**, on every pass, separate from its diff slice:
  each path with its added and removed line counts, and paths removed by `exclude:` marked
  `excluded_from_review: true` and stated as present. The charter makes the manifest, not the
  slice, the authority on what the change contains.
- **Findings whose entire claim is that something is absent are not published** when no reviewer
  saw the whole change — more than one pass, or any path excluded, truncated, or unreviewed. They
  are listed in the summary instead, so a real one stays visible without opening a conversation the
  author has to disprove. This runs before arbitration, so a verdict is never derived from a claim
  the panel could not establish.

### Rerunning remembers this pull request

If `synchronize` is explicitly enabled, the panel runs again, but the pull request does not
accumulate a fresh copy of everything it already said:

- the review summary and the "Review started" notice are **edited in place**, one of each per pull
  request rather than one per push;
- before the parallel reviewers run, the bot takes one authenticated snapshot of the conversations
  it already opened. Every reviewer receives the same bounded same-PR decision ledger; raw human
  replies, names, and command reasons are never sent to the model;
- prior findings are matched **by claim rather than by title**. An unresolved P0/P1 remains in the
  current verdict and reuses its existing conversation instead of being posted again;
- GitHub thread resolution has unknown intent. It does not mean fixed, false positive, or accepted
  risk; if the current diff still demonstrates a resolved finding, the bot publishes a fresh
  conversation;
- near-duplicate findings from different personas are merged into one conversation credited to all
  of them, with the other titles kept under "Also reported as".

An authorized maintainer can make a thread-scoped, reversible decision by replying to the finding
conversation. Only collaborators whose current repository permission is `write`, `maintain`, or
`admin` can change decision state:

```text
/review-yeti ignore accepted until API-1234 is delivered
/review-yeti unignore API-1234 has landed; evaluate this normally again
```

The command must be the first nonblank line and include a reason. Its author and reason are kept out
of reviewer prompts; the summary shows the ignored finding so accepted risk stays auditable. This is
the GitHub decision ledger's same-PR authority boundary. Optional remote memory is separately
controlled by the trusted recall/persist matrix and stores only normalized, exact-head-scoped
metadata through the selected provider API; it never learns raw comments, authors, transcripts, or
executable instructions.

### Configurable advisory memory providers

Review Yeti selects one remote memory provider per review run. Honcho is the default; mem0,
Hindsight, Supermemory, and RetainDB are opt-in adapters behind the same bounded provider contract.
Provider context is advisory, while GitHub's authenticated decision ledger remains authoritative.
Use trusted base-ref YAML to select the provider and domains:

```yaml
memory:
  enabled: true
  provider: honcho       # honcho | mem0 | hindsight | supermemory | retaindb
  mode: single
  transport: mcp         # provider-supported; REST is explicit compatibility mode
  fallback: github_ledger_only
  recall: { decision_feedback: true, session_recap: true, code_signals: true, rule_signals: true }
  persist: { processing: true, decision_feedback: true, session_recap: true, code_signals: true, rule_signals: true }
  providers:
    honcho: { enabled: true, transport: mcp, endpoint_env: HONCHO_URL, credential_env: HONCHO_API_KEY, workspace_env: HONCHO_WORKSPACE_ID }
    mem0: { enabled: false, transport: rest, endpoint_env: MEM0_URL, credential_env: MEM0_API_KEY, namespace_env: MEM0_NAMESPACE }
    hindsight: { enabled: false, transport: rest, endpoint_env: HINDSIGHT_URL, credential_env: HINDSIGHT_API_KEY }
    supermemory: { enabled: false, transport: rest, endpoint_env: SUPERMEMORY_URL, credential_env: SUPERMEMORY_API_KEY }
    retaindb: { enabled: false, transport: rest, endpoint_env: RETAINDB_URL, credential_env: RETAINDB_API_KEY }
```

The five providers are not runtime fan-out targets. To compare or migrate providers, replay the
sanitized exact-head outbox in isolation. Unsupported memory domains, provider readiness, delivery
semantics, and omitted classes are recorded in receipts. Raw comments, authors, command reasons,
transcripts, credentials, and executable instructions are never stored.

These are API adapters, not direct database drivers. The Action resolves an endpoint and credential
from trusted configuration, performs one bounded provider query before reviewer fan-out, and sends
normalized events to that provider API after publication. The local `sessions/` outbox is only a
durable delivery artifact for retries and replay; it is not the memory store. VCR cassettes exercise
these API contracts offline and do not imply live provider access.

### Honcho compatibility configuration

Honcho is an opt-in, fail-open provider for repository-scoped review context. Enable it only when
you have a self-hosted or hosted Honcho instance and want prior review patterns available to every
reviewer lane:

```yaml
- uses: review-yeti-ai/review-yeti-bot@main
  with:
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    honcho-enabled: 'true'
    honcho-context: 'true'
    honcho-write: 'true'
    honcho-mcp-enabled: 'true'
    honcho-mcp-transport: mcp
    doppler-token: ${{ secrets.DOPPLER_TOKEN }}
    doppler-project: review-yeti-bot
    doppler-config: production
```

The Doppler config must contain `HONCHO_URL` (or `HONCHO_BASE_URL`) and either `HONCHO_API_KEY` or
`HONCHO_WORKSPACE_JWT`. The workspace may be supplied as `HONCHO_WORKSPACE_ID`/`HONCHO_WORKSPACE`,
or derived from the trusted JWT workspace claim. The Action resolves them through its dependency-free
runtime client using environment, cache, and Doppler REST API tiers; it does not invoke the Doppler
CLI on a GitHub runner. Honcho context is bounded and inserted into reviewer user messages as
untrusted data. Writes contain only normalized event metadata, never comment bodies, author names,
command reasons, or secrets. Configure recall and persistence classes in trusted base-ref YAML:

```yaml
memory:
  session_recap: true
  honcho:
    enabled: true
    transport: mcp
    recall:
      decision_feedback: true
      session_recap: true
      code_signals: true
      rule_signals: true
    persist:
      processing: true
      session_recap: true
      decision_feedback: true
      code_signals: true
      rule_signals: true
```

The reviewer recalls one bounded provider result per run. GitHub's authenticated decision ledger
remains authoritative for comments, resolutions, ignores, corrections, and arbitration. PR session
recaps contain only turn/head/verdict/coverage and claim-state summaries. Code/rule signals are
metadata-only and advisory; raw comments, authors, transcripts, and executable instructions are
never stored or recalled. Honcho delivery is at-least-once: deterministic canonical event IDs aid
tracing, but Honcho message creation is not treated as an idempotency guarantee. A hashed outbox
artifact and replay command recover events after runner cancellation.

Upload the Action's `memory-outbox-path` output with `actions/upload-artifact@v4` when runner
recovery matters; replay only from a trusted artifact using
`node scripts/replay-memory-outbox.mjs --path <hashed-outbox> --lease <operator-id> --provider honcho --authorize yes`.

For a DigitalOcean self-host, put Honcho behind HTTPS, enable JWT authentication with a scoped
workspace token, configure PostgreSQL with pgvector, Redis, an LLM provider, and the deriver. The
`/health` endpoint only proves that the process is reachable; it does not prove that representations
are being derived. To roll back immediately, set `honcho-enabled: 'false'` or remove the Honcho
inputs; alternatively set trusted `memory.honcho.transport: rest` for explicit compatibility mode.
There is no hidden pipeline-level REST fallback; GitHub-only review behavior remains authoritative.

`memory.same_pr_decisions: false` disables the reviewer prompt block, not the deterministic safety
state: authenticated open blockers and maintainer decisions still affect arbitration and publication.

Merging is deliberately conservative. It is calibrated so that leaving a duplicate in is preferred
over collapsing two distinct defects, since the second hides one.

## Reference

### Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `llm-api-key` | required | The sole OpenRouter inference API key, passed explicitly in the workflow action call. Management keys and alternate provider-key environment variables are not accepted. |
| `llm-base-url` | `https://openrouter.ai/api/v1` | OpenRouter-compatible base URL. |
| `openrouter-provider-routing` | `{"only":["morph"],"allow_fallbacks":false}` | JSON `provider` policy forwarded to OpenRouter. The default pins review requests to the certified Morph provider and fails closed rather than escaping to another provider. Fixed models are checked against an explicit provider cohort before persona fan-out; `openai/gpt-5.6-luna` requires `only` to include `openai` or `azure`. Wafer and Novita are hard-banned after repeated timeout/provider-error lanes. It supports provider order/allow-fallbacks, parameter requirements, data-collection/ZDR policy, provider allow/deny lists, quantizations, sorting, throughput/latency preferences, and price caps. The built-in degraded-provider blocklist remains hard-banned. |
| `openrouter-fallback-models` | — | Comma-separated ordered model fallbacks for transient timeouts, network errors, rate limits, and 5xx responses. Empty uses `github_action.openrouter.fallback_models` from the trusted base ref. |
| `context7-api-key` | — | Optional Context7 API key. With a non-empty key and `mcp.context7.enabled` in the target `.review-yeti.yaml` (default on when the key is set), Context7 docs are injected into every persona. |
| `model` | `openrouter/auto-beta` | Model identifier passed to the provider. |
| `personas` | — | Comma-separated reviewer persona ids, a JSON array, or "all". Defaults to the five that apply to any codebase: security, performance, architecture, testing, dependencies. Also available: style, documentation, accessibility, database, devops, i18n, licensing. |
| `max-diff-chars` | `2000000` | Per-persona **per-pass** diff budget (characters). Default is the full safety ceiling so PRs are not cut at 24k. |
| `max-file-diff-chars` | `''` (effective `5,000`) | Complete per-file diff limit. A non-empty workflow value overrides `limits.max_file_diff_chars` in `.review-yeti.yaml`; empty falls back to that repository value and then the 5,000-character default. |
| `max-passes` | `3` | **Maximum** packing passes per persona for oversized diffs (not a required count). Most PRs use 1. Files that still do not fit are reported as unreviewed. |
| `max-investigation-turns` | `2` | Bounded dependency-evidence follow-up turns per persona pass (1-3). Requests are limited to changed-file evidence; unresolved evidence yields `INCOMPLETE_REVIEW` and blocks merge approval. The Action input overrides `limits.max_investigation_turns`. |
| `exclude` | — | Extra comma-separated path globs to skip, on top of the curated built-in list (lockfiles, snapshots, generated files, build output, dependency caches, minified assets, source maps, binaries). |
| `max-personas` | `25` | Maximum reviewers a resolved roster may contain. Each is one model request per push, so this bounds what a configuration change can spend. |
| `skip-unchanged` | `false` | When true, a push that changed only excluded paths since the last reviewed commit carries the previous verdict forward instead of re-running the panel. The summary is still updated in place with the new head SHA. Off by default because wrongly skipping ships an unreviewed change, while wrongly re-reviewing only costs a rerun. |
| `config-ref` | — | Deprecated compatibility input. When set, it must equal the immutable pull request base SHA. Reviewer charters are prompts run with your API key, so configuration is never read from the pull request head or another mutable ref. |
| `pr-number` | — | Pull request to review. Defaults to the PR that triggered the workflow. |
| `repo` | — | Repository owning the pull request, as owner/name. Defaults to the current repository. |
| `github-token` | workflow token | Token used to read the diff and post the review comment. The default workflow token is sufficient for same-repository reviews. |
| `dashboard-api-key` | — | Optional Review Yeti Cloud ingestion key. It is sent only as a Bearer credential and is never logged; delivery failures never change the GitHub review verdict. |
| `dashboard-api-url` | — | Optional full `review-event.v1` ingestion endpoint, such as `https://api.reviewyeti.ai/api/v1/review-events`. Must be paired with `dashboard-api-key`. |
| `dashboard-url` | `https://reviewyeti.ai` | Cloud site origin used to build the safe `dashboard-review-url` output and link in the final GitHub review. |
| `dashboard-detail` | `full` | Cloud detail level: `full` retains structured findings; `metrics` sends aggregates only. |
| `dashboard-timeout-ms` | `10000` | Fail-soft cloud delivery timeout in milliseconds. |

When `dashboard-api-key` is configured and the cloud accepts the event, the final GitHub review
includes a link to the exact cloud run when the response includes a review run id. The action also
exposes that URL as `dashboard-review-url`. Cloud delivery is advisory: a disabled or unavailable
dashboard never changes the GitHub verdict or publication result.

Provider routing uses OpenRouter's raw API field names. For example:

```yaml
          openrouter-provider-routing: >-
            {"order":["novita","akash"],"allow_fallbacks":false,"require_parameters":true,
             "sort":{"by":"throughput","partition":"none"},"max_price":{"prompt":1}}
```

Fixed-model routing is fail-closed. The action does not infer compatibility from the model owner's
namespace, remove `ignore` or data-policy restrictions, or fall back to an unapproved provider. For
the fixed `openai/gpt-5.6-luna` model, OpenRouter's compatible provider cohort is explicitly
`openai`/`azure`, so a consumer that has approved those providers can use:

```yaml
          model: openai/gpt-5.6-luna
          openrouter-provider-routing: >-
            {"only":["openai","azure"],"allow_fallbacks":false}
```

Retain any existing `data_collection`, `zdr`, `require_parameters`, and `ignore` fields when
making that change. If the repository must remain Morph-only, select a model served by Morph
instead. A mismatch fails before persona requests with an actionable compatibility error.

The action also reads reviewer personas and repository defaults from the target
`.review-yeti.yaml`; configure this object as `github_action.openrouter.provider_routing` there.
The action input takes precedence. See OpenRouter's [provider selection documentation](https://openrouter.ai/docs/guides/routing/provider-selection)
for the complete field semantics.

### Outputs

| Output | Description |
| :--- | :--- |
| `verdict` | SHIP, FIX_FIRST, BLOCK, or NO_VERDICT when the review cannot complete safely. Legacy NO_REVIEWABLE_FILES is no longer emitted for policy exclusions; migrate consumers to SHIP plus coverage outputs. |
| `review-status` | Terminal review status: SHIP, FIX_FIRST, BLOCK, PARTIAL_REVIEW, or INCOMPLETE_REVIEW. Expected policy exclusions do not create a coverage gap; partial and incomplete review statuses are never merge-eligible. |
| `coverage-status` | Coverage state: complete, partial, or incomplete. Partial and incomplete are never merge-eligible. |
| `gate-decision` | Derived gate decision: PASS only for a complete clean review; otherwise BLOCKED. |
| `merge-eligible` | Derived merge eligibility. True only for complete SHIP with a passing gate and no P0/P1 findings. |
| `findings-count` | Total findings across all personas. |
| `p0-count` | Count of P0 (exploitable or data-losing) findings. |
| `p1-count` | Count of P1 (must fix before merge) findings. |
| `p2-count` | Count of P2 (nit) findings. |
| `personas-completed` | Persona lanes that completed successfully. |
| `files-reviewed` | Changed files the reviewers were shown. |
| `files-omitted` | Changed files the diff budget excluded. Non-zero means the verdict covers only part of the change. |
| `files-skipped-generated` | Changed files skipped by the built-in generated-file catalog or configured repository path-policy/exclude globs. Intentional, and not a coverage gap. |
| `files-oversized` | Changed files whose complete per-file diff exceeded the configured limit. Excluded before model input and noted in the review comment; non-blocking by itself, while other coverage gaps can still produce INCOMPLETE_REVIEW. |
| `review-passes` | Budgeted passes each reviewer made over the diff. |
| `total-tokens` | Tokens consumed across every reviewer and pass. |
| `cost-usd` | Cost reported by the provider, or 0 when the provider does not report one. |

Gate a merge on any of them:

```yaml
      - uses: review-yeti-ai/review-yeti-bot@v1
        id: review
        with:
          llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
      - if: steps.review.outputs.verdict == 'BLOCK' || steps.review.outputs.files-omitted != '0'
        run: exit 1
```

---

## Configuration

### Which reviewers run

Five reviewers apply to essentially any codebase and are **on by default**:

`security` · `performance` · `architecture` · `testing` · `dependencies`

Seven more are situational and **off by default**, because enabling them everywhere produces
findings about internationalisation in single-language projects and licence headers in projects
that use none:

`style` · `documentation` · `accessibility` · `database` · `devops` · `i18n` · `licensing`

Opt in by id, or ask for the lot with `all`:

```yaml
          personas: security,database,devops    # a specific set
          personas: all                         # every built-in
```

### How verdicts are decided

| Verdict | Condition |
| :--- | :--- |
| `BLOCK` | any P0, or P1 count reaching `max(3, reviewers / 2)` |
| `FIX_FIRST` | any P1, or P2 count reaching `max(5, reviewers)` |
| `SHIP` | everything else |

Thresholds scale with the size of the panel. A fixed "three P1s blocks" was calibrated for
sparse pattern matches; with a dozen reviewers each free to raise a concern it means nearly
every pull request blocks, and a reviewer that always blocks gets ignored. The posted comment
names the thresholds it applied.

### Defining your own reviewers

Drop a `.review-yeti.yaml` in the repository being reviewed to pick which personas run — and to
write reviewers that know your codebase's own rules:

```yaml
personas:
  - id: security                        # a built-in
  - id: style
    enabled: false                      # turn one off
  - id: tenancy                         # one of your own
    name: "🏢 Multi-Tenant Isolation"
    charter: |
      Every query touching customer data must be scoped by orgId.
      Flag any repository method accepting a raw id without a tenant bound.
```

A custom persona needs a `charter`; it becomes that reviewer's system prompt. Supplying a
`charter` for a built-in id overrides its instructions instead. An id that is neither built-in
nor given a charter fails the run rather than quietly reviewing nothing.

#### One file per reviewer

Charters worth writing are usually too long for a YAML string. Put each reviewer in its own
markdown file under `.review-yeti/personas/` instead — optional frontmatter for the metadata, and
the body is the charter:

```markdown
<!-- .review-yeti/personas/tenancy.md -->
---
name: "🏢 Multi-Tenant Isolation"
---

Every query that touches customer data must be scoped by `orgId`.

## What to flag
- Repository methods accepting a raw `id` without a tenant bound
- Raw SQL missing a `WHERE org_id = $n` clause
- Cache keys omitting the tenant prefix

## What not to flag
- Admin-only endpoints under `src/admin/**`, which are intentionally cross-tenant
- Migrations, which run outside request context
```

The id defaults to the filename, so `tenancy.md` defines the `tenancy` reviewer and no other
configuration is needed — frontmatter is optional, and a file containing nothing but prose works.

Persona files **add to** the default roster rather than replacing it, so dropping one in does not
silently switch the built-ins off. To narrow the roster, list the ids you want in
`.review-yeti.yaml` or in the action's `personas:` input. Declaring the same id in both a file and
`.review-yeti.yaml` is an error rather than a guess about precedence.

See the [Configuration Reference](docs/CONFIGURATION_REFERENCE.md#persona-definition-personas)
for the full key list.

### Central review repository (dispatch mode)

Alternatively, keep personas, prompts and keys in one repository and have others dispatch
into it. The receiving workflow lives at `.github/workflows/review-bot.yaml` and
accepts a `repository_dispatch` with a `client_payload` of `{ target_repo, pr_number }`.

The default consumer workflow should use the same explicit trigger policy shown above:

```yaml
on:
  pull_request:
    # No automatic review when the PR head or target/base branch moves.
    types: [opened, reopened]
```

If a central dispatcher is used, include the exact `base_sha` and `head_sha` in its payload and
have the dispatcher treat a changed target head as stale work before invoking a model review. The
action's exact-head publication check remains a final safety boundary; stale work is not a new
review request.

Hosted evidence is generic: a complete clean single-provider panel produces a
normal `PASS` result. Consumers may optionally add `evidence_policy_json` to the
dispatch payload when their own merge gate needs signed attestations, quorum
metadata, or advisory semantics; the bot does not assume any particular source
repository, persona roster, model, or provider.

This mode needs two tokens — one in the calling repository allowed to dispatch here, and a
`REVIEW_BOT_TOKEN` here allowed to read and comment on the calling repository — because the
default `GITHUB_TOKEN` is scoped to a single repository. Prefer the action above unless you
specifically need centralized keys and session data.

---

### Repository configuration (`.review-yeti.yaml`)

The action reads reviewer selection and the trusted per-file diff policy from `.review-yeti.yaml` on
the PR base ref. `limits.max_file_diff_chars` is the per-repository override; the non-empty Action
input `max-file-diff-chars` takes precedence over it, and the built-in default is 5,000.

```yaml
# .review-yeti.yaml — in the repository being reviewed
version: 4
limits:
  max_file_diff_chars: 10000 # raise the per-file cap for this repository
memory:
  same_pr_decisions: true
  max_entries: 40
  max_prompt_chars: 8000
  maintainer_commands: true

personas:
  - id: security
  - id: testing
  - id: style
    enabled: false
  - id: tenancy
    name: "🏢 Multi-Tenant Isolation"
    charter: |
      Every query touching customer data must be scoped by orgId.
```

Longer charters belong in their own files under `.review-yeti/personas/`, described above. See the
[Configuration Reference](docs/CONFIGURATION_REFERENCE.md) for the full catalog, filename-only
glob behavior, `!` restoration, and every key.

For a complete copy-and-edit file covering limits, submodules, coverage, personas, memory recall
and persistence, Context7, compaction, review units, finding verification, telemetry, and
OpenRouter routing, use [YAML Configuration Examples](docs/YAML_CONFIGURATION_EXAMPLES.md).

> Earlier versions of this file documented `profile`, `quorum`, `mascot`, `dials`, `reviews`,
> `chat`, `knowledge_base` and `auto_review` keys. The action ignores them; they are accepted
> without error so a `.coderabbit.yaml` can be reused as-is.

---


## Documentation

- **[Configuration Reference](docs/CONFIGURATION_REFERENCE.md)** — every `.review-yeti.yaml` and
  persona-file key, glob semantics, and `!` restoration.
- **[YAML Configuration Examples](docs/YAML_CONFIGURATION_EXAMPLES.md)** — annotated production,
  GitHub-ledger-only, Honcho feedback, strict-verification, and compatibility configurations.
- **[OpenRouter Settings](docs/OPENROUTER_SETTINGS.md)** — model pinning, session stickiness, and
  provider routing.
- **[Architecture](docs/ARCHITECTURE.md)** — how a run is put together and why config comes from
  the base ref.
- **[Publication Policy](docs/PUBLICATION_POLICY.md)** — what gets posted where, and how reruns
  stay idempotent.
- **[Memory Provider Operations](docs/MEMORY_PROVIDER_OPERATIONS.md)** — API-backed provider
  selection, readiness, canaries, outbox replay, and promotion gates.
- **[Test Infrastructure](TEST_INFRA.md)** — offline API-boundary replay, workflow fixtures, and
  live-canary separation.
- **[Adversarial Review Patterns](docs/ADVERSARIAL_REVIEW_PATTERNS.md)** — the reasoning behind
  multi-persona cross-examination.

## Contributing

```bash
npm install
npm test      # full suite, no network access required
npm run lint  # tsc --noEmit
```

Tests run fully offline against recorded cassettes in `tests/fixtures/cassettes/`. Replay is
fail-closed: an unmatched request throws rather than reaching the network. See
[TEST_INFRA.md](TEST_INFRA.md).

The extended PR gate is available with `npm run test:all`; it covers fixture contracts, provider
VCRs, the injected end-to-end workflow, outbox replay/dead-letter behavior, security boundaries,
plain-Node Action loading, lint, and build. Provider credentials are never required for that gate.
Live Mem0, Hindsight, Supermemory, and RetainDB checks are isolated to the manual **Memory Provider
Canary** workflow and report `not_configured` when their Doppler-backed secrets are absent. See
[Memory Provider Operations](docs/MEMORY_PROVIDER_OPERATIONS.md).

---

## License

MIT — see [LICENSE](LICENSE).
