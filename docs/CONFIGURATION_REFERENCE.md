# ⚙️ review-yeti-bot — Configuration Reference

This reference guide provides a complete, 1:1 schema specification for `.review-yeti.yaml` and `.coderabbit.yaml` repository configuration files in **review-yeti-bot**.

---

## 📋 Table of Contents

1. [Configuration File Resolution](#configuration-file-resolution)
2. [Canonical YAML Examples](#canonical-yaml-examples)
3. [Top-Level Schema Overview](#top-level-schema-overview)
4. [V4 Execution Policy](#v4-execution-policy)
4. [The 6 Compatibility Sections](#the-6-compatibility-sections)
   - [1. `reviews`](#1-reviews)
   - [2. `chat`](#2-chat)
   - [3. `knowledge_base`](#3-knowledge_base)
   - [3a. `memory`](#3a-memory-provider-selection)
   - [3b. `memory.honcho`](#3b-memoryhoncho)
   - [4. `path_filters`](#4-path_filters)
   - [5. `auto_review`](#5-auto_review)
   - [6. `dials`](#6-dials)
5. [Clean Key Toggles](#clean-key-toggles)
6. [Multi-LLM Personas & Provider Schema](#multi-llm-personas--provider-schema)
7. [CodeRabbit 1:1 Translation Mapping (`translateCodeRabbitToV3`)](#coderabbit-11-translation-mapping-translatecoderabbittov3)
8. [Full Configuration Examples](#full-configuration-examples)
   - [Native `.review-yeti.yaml` (V3)](#native-review-yetiyaml-v3)
   - [CodeRabbit-Compatible `.coderabbit.yaml`](#coderabbit-compatible-coderabbityaml)

---

## 🔍 Configuration File Resolution

On each pull request event, `review-yeti-bot` checks the repository for a configuration file in the following order of precedence:

1. `.review-yeti.yaml` in PR target branch at the immutable PR base SHA
2. `.review-yeti.yml` in PR target branch
3. `review-yeti.yaml` in PR target branch
4. `.coderabbit.yaml` in PR target branch
5. Organization-level `.github` repository (`.review-yeti.yaml`, `.coderabbit.yaml`)
6. Built-in system default configuration (`createDefaultV4Config()`)

## Canonical YAML Examples

The complete annotated copy-and-edit configuration is in
[YAML configuration examples](YAML_CONFIGURATION_EXAMPLES.md). It includes the Action-native
limits, submodule policy, coverage policy, personas, API-backed memory providers, Context7,
compaction, review units, finding verification, telemetry, and OpenRouter routing settings.

Use that page together with this reference as follows:

| Need | Use |
| --- | --- |
| Start a new repository configuration | [Recommended production configuration](YAML_CONFIGURATION_EXAMPLES.md#recommended-production-configuration) |
| Turn on Honcho feedback persistence | [Honcho example](YAML_CONFIGURATION_EXAMPLES.md#honcho-recall-and-feedback-persistence) |
| Require exact-snapshot verification | [Strict verification example](YAML_CONFIGURATION_EXAMPLES.md#strict-exact-snapshot-verification) |
| Understand legacy/hosted keys | [Compatibility-only sections](YAML_CONFIGURATION_EXAMPLES.md#compatibility-only-sections) |

Only settings marked Action-native affect the composite Action. Compatibility sections are parsed
so existing configuration files remain usable, but they do not create a local database, grant
memory authority, or enable a feature by themselves.

## Bounded investigation limits

The production Action always runs the bounded evidence engine. Trusted-base configuration may set
these values lower, while the runtime clamps every value to its hard ceiling; no key disables the
engine or permits arbitrary tools:

```yaml
review:
  investigation:
    max_calls: 12
    max_read_lines: 400
    max_search_matches: 50
    max_result_bytes: 8000
    max_repeated_calls: 2
    max_candidate_findings: 5
    max_verifier_calls_per_finding: 3
    max_turns: 2
```

`max_turns` (default `2`, hard ceiling `3`) is the same concept as the `max-investigation-turns`
Action input / `MAX_INVESTIGATION_TURNS` environment variable documented under [Bounded evidence
investigation](#bounded-evidence-investigation) below — the input wins over this YAML value, which
in turn wins over the default. This is a direct multiplier on the whole retry chain (`turns x
attempts` HTTP calls per lane), so setting it explicitly is the primary lever for controlling
review cost and latency.

## Local CLI configuration

`reviewyeti review` accepts exactly one immutable source (`--base/--head`, `--diff-file`, or
`--pr`) and never reads CI-only configuration implicitly. `OPENROUTER_API_KEY` supplies the model
credential; PR reads use `GITHUB_TOKEN`, `GH_TOKEN`, or the existing `gh auth token` command. No
credential is persisted. See [CLI.md](CLI.md) for exit codes and atomic receipt output.

Incomplete execution is represented by a redacted receipt and is always non-mergeable.

---

## 🌐 Direct OpenAI-compatible gateways (`llm-base-url`)

`llm-base-url` (env `OPENROUTER_BASE_URL`) may point at a supported direct
gateway instead of OpenRouter. The engine detects the gateway from the URL
host (`resolveGatewayIdentity` in `openRouterPolicy.js`) and sends a clean
OpenAI-shape request there: the OpenRouter-only fields — `provider` routing,
`session_id` stickiness, and the auto-router `plugins` block — are omitted
(Fireworks hard-rejects them with `400 Extra inputs are not permitted,
field: 'provider'`). Provider-routing policy checks and provider bans are
OpenRouter concepts and do not judge direct-gateway responses. Route labels
use a namespaced gateway id (`fireworks-direct`, never `fireworks`) so they
cannot collide with OpenRouter provider slugs, and so lane retries stay
available (the `openrouter` label is the no-retry unknown-route sentinel).

Supported gateways and model id shapes:

| Gateway | `llm-base-url` | Model id example | Notes |
|---|---|---|---|
| Fireworks serverless | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/deepseek-v4-flash-0731` | Chat Completions is zero-data-retention by default (prompts/generations live only in volatile request memory). **If any caller migrates to the Fireworks Responses API, it MUST send `store: false`** — `store: true` is that API's default and retains conversations for 30 days (see docs.fireworks.ai/guides/security_compliance/data_handling). |
| Ollama Cloud | `https://ollama.com/v1` | `deepseek-v4-flash:0731` | Subscription-metered (session/weekly limits), not per-token. Verify limit headroom for CI volume. |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `deepseek-v4-flash` | Per-token billing. |

OpenRouter-only knobs (`openrouter-provider-routing`,
`openrouter-ignore-providers`, `openrouter-allowed-models`,
`openrouter-cost-quality-tradeoff`, session stickiness) are inert on a direct
gateway; timeouts, streaming, structured output, personas, and budgets apply
unchanged. Any host that is not a listed gateway — including a private proxy
in front of OpenRouter — keeps full OpenRouter semantics; add new direct
gateways to `KNOWN_DIRECT_GATEWAYS` explicitly.

### Explicit transport plan (`github_action.transports`) — recommended

Host detection above is the implicit fallback. The explicit, ordered transport
plan is the recommended configuration style: each entry declares its gateway
compatibility (`compat`), model id, and credential env var, and entries are
tried **in declared order per model call** — the first non-failed result wins.
This restores cross-gateway failover (a Fireworks outage fails over to a
pinned-OpenRouter transport instead of failing the lane) and removes any
dependence on the built-in host list.

```yaml
github_action:
  transports:
    - name: ollama
      base_url: https://ollama.com/v1
      api_key_env: OLLAMA_PR_REVIEW_API_KEY
      model: deepseek-v4-flash:0731
      compat: openai
    - name: fireworks
      base_url: https://api.fireworks.ai/inference/v1
      api_key_env: FIREWORKS_PR_REVIEW_API_KEY
      model: accounts/fireworks/models/deepseek-v4-flash-0731
      compat: openai
    - name: openrouter-fallback
      base_url: https://openrouter.ai/api/v1
      api_key_env: OPENROUTER_PR_REVIEW_API_KEY
      model: deepseek/deepseek-v4-flash-0731
      compat: openrouter
      provider_routing: { order: [coreweave, phala], allow_fallbacks: false, data_collection: deny }
```

Rules:

- `compat: openai | openrouter` (default: detected from `base_url`).
  OpenRouter-only keys (`provider_routing`, `ignore_providers`,
  `data_collection`, `allowed_models`, `cost_quality_tradeoff`,
  `allow_banned_providers`) are **rejected** on `compat: openai` entries. The legacy
  `allow_banned_providers` field is accepted on OpenRouter entries only as a deprecated
  compatibility no-op; Review Yeti no longer injects a built-in provider blocklist.
- `api_key_env` names the env var carrying that transport's key; the CALLER
  workflow must export it on the action step. It must end in `_API_KEY` or
  `_KEY` and may never name a CI credential (`GITHUB_*`, `ACTIONS_*`,
  `RUNNER_*`, `INPUT_*`, `GH_TOKEN` are rejected).
- An entry whose key env is empty at runtime is dropped with a warning (so a
  fallback can be declared before its secret exists); a plan with zero usable
  entries fails the run closed. At most 6 entries.
- Unset per-entry `timeout_ms` /
  `structured_output` inherit the global action inputs; per-entry values are
  clamped by the same rules as the global ones.
- The action input `transports` (JSON array, env `REVIEW_YETI_TRANSPORTS`)
  wins over the YAML block. The chat preflight targets `transports[0]`.
- Every model turn starts again from `transports[0]`, so the primary stays
  authoritative and a transient failover does not pin later turns to the
  fallback.

---

## 📐 Top-Level Schema Overview

A Version 3 configuration contains core policy settings along with six CodeRabbit-mirrored
compatibility sections. The Action's native API-backed memory contract is the separate `memory`
section documented below; it does not activate the legacy `knowledge_base` or `.review-yeti-memory`
database settings.

```yaml
version: 3
profile: "balanced"          # "chill" | "balanced" | "assertive"
quorum: 4
mascot: true
confidence_threshold: 80
reviewer_effort: "high"

reviews: { ... }
chat: { ... }
knowledge_base: { ... }
path_filters: [ ... ]
auto_review: { ... }
dials: { ... }

personas: [ ... ]
reviewers: { ... }
path_instructions: [ ... ]
rules: [ ... ]
```

## V4 Execution Policy

Version 4 is the additive execution-policy layer. Version 3 remains accepted and is normalized to
these defaults. The App and Action read policy from the trusted base reference; pull-request
payloads and model output cannot change these limits.

```yaml
version: 4
submodules:
  mode: metadata_only       # ignore | metadata_only | recursive
  max_depth: 1
  max_files: 500
  require_pinned_commit: true
  missing_access: block      # block | metadata_only
  allowed_repositories: []
  allowed_hosts: [github.com]
  url_change: block          # block | review
limits:
  max_files: 1000
  max_diff_bytes: 1000000
  max_file_diff_chars: 5000  # complete per-file diff limit; see the ignore catalog below
  max_prompt_tokens: 60000
  max_completion_tokens: 8000
  max_cost_usd: 5
  max_turns: 20
  max_investigation_turns: 2
  max_concurrency: 12

memory:
  same_pr_decisions: true   # authenticated decisions from this pull request only
  max_entries: 40           # 1-100 entries supplied to each reviewer
  max_prompt_chars: 8000    # 1000-20000 characters
  maintainer_commands: true # allow authenticated ignore/unignore commands

# Optional MCP integrations (Action path)
mcp:
  context7:
    enabled: true            # default true when CONTEXT7_API_KEY is set; false disables
    # libraries: [typescript, github-actions]  # optional force list; else inferred from diff
    # max_snippets: 5

# Optional best-effort OpenTelemetry export. It is disabled by default and becomes active only
# when this file was fetched by the Action into its trusted base-SHA temp directory.
telemetry:
  otel:
    enabled: false
    endpoint_env: REVIEW_YETI_OTEL_TRACES_ENDPOINT
    credential_env: REVIEW_YETI_OTEL_BEARER_TOKEN

# Exact-snapshot finding verification is enforced by the production bounded engine. This block is
# read only from the trusted PR base reference after the Action proves the current base/head pair.
review:
  finding_verifier:
    mode: enforce
```

### Exact-snapshot finding verification

`review.finding_verifier` is a trusted-base boundary for model findings. The verifier
normalizes a relative path, checks the exact changed `RIGHT` or `LEFT` line from the unified
patch, permits file-level findings only for binary, gitlink, or patchless files, optionally
compares a supplied content hash with the immutable snapshot, and assigns a deterministic claim
fingerprint. Its receipt contains only bounded reason codes, stable keys, digests, and anchors;
it never contains model title/body text, author, source, prompt, or blob content.

```yaml
review:
  finding_verifier:
    mode: enforce
```

The production engine removes rejected findings before
arbitration and publication. A `needs_review` result (including an exact identity/snapshot,
ambiguous anchor, or content-hash uncertainty) forces `INCOMPLETE_REVIEW`, `BLOCKED`, and a
non-merge-eligible result; it can never produce `SHIP`. Immediately before any GitHub publication
operation, the Action re-reads the PR head and aborts all writes if it no longer equals the head
that was reviewed.

### Independent finding reflection

`review.finding_reflection` runs one bounded, independent LLM self-critique turn per already
finding-verifier-verified finding, judging it `KEEP`, `DOWNGRADE`, `DROP`, or `NEEDS_REVIEW`.
It requires `review.finding_verifier` to be enabled (reflection re-verifies through the same
exact-blob machinery and has nothing to reflect on without it) and is otherwise opt-in and off by
default.

```yaml
review:
  finding_verifier:
    mode: enforce
  finding_reflection: true
```

Reflection can only narrow the published set, never expand it:

- `KEEP` and `NEEDS_REVIEW` (including any finding that was never selected as a verified
  candidate, was cut by the bounded per-run candidate cap, or failed to get a model response)
  leave the finding untouched.
- `DOWNGRADE` lowers severity in place and annotates the body; title, path, and line are
  untouched. The module refuses a downgrade to a severity that is not strictly lower.
- `DROP` removes the finding from the published review. A `P0`/`P1` finding can never resolve to
  `DROP` — the module itself forces `NEEDS_REVIEW` (`high_severity_disagreement`) instead, so
  reflection can never silently delete a gate-relevant finding.

Set `REVIEW_YETI_FINDING_REFLECTION=false` to force it off regardless of config. The
`review-dispatch-run.v2` receipt (see `review-dispatch-digest`/`review-dispatch-receipt-path`
above) reports this stage's outcome under its own `reflection` field
(`candidates`/`kept`/`downgraded`/`dropped`/`needs_review`), separate from the deterministic
finding verifier's checks, which are the `verification` field. `v1` conflated the two under one
`reflection` field that actually reported the verifier's counts — describing a self-critique stage
that had never run in production.

### Deterministic review units

`review.units` creates an exact-head manifest for changed files. The production engine always
creates this manifest from trusted-base rules. Unit IDs include canonical path/range, content/blob identity,
repository/head identity, and policy digest. A failed or uncovered unit is never merge-eligible.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Legacy compatibility key; production generation cannot be disabled. |
| `generated_patterns` | `string[]` | `[]` | Additional trusted-base generated-file patterns. |
| `vendor_patterns` | `string[]` | `[]` | Additional trusted-base vendored-file patterns. |
| `allow_waived` | `boolean` | `false` | Allows only explicitly trusted maintainer waivers. Failed or uncovered evidence still cannot become `SHIP`. |

```yaml
review:
  units:
    enabled: true
    generated_patterns: ['**/*.generated.ts']
    vendor_patterns: ['vendor/**']
    allow_waived: false
```

### Durable publication resume

Durable publication replay is deliberately opt-in; omitting it preserves the existing synchronous
publication path. A caller may persist a `durable-review-resume-v1` artifact under `sessions/` and
upload it with the existing Action artifact step. Artifact names are a SHA-256-derived identity and
attempt token, rather than repository or pull-request text.

The artifact contains an immutable, digested exact identity (`repository`, pull request, base SHA,
head SHA, and trusted policy digest) plus a publication plan digest and chunk IDs. Mutable delivery
state is fenced by a short lease plus sidecar-lock/CAS generation. A replay must provide the exact expected identity, explicit
authorization, and an authenticated GitHub-ledger reader. The ledger is authoritative for already
published chunk IDs: local state alone is never proof that a prior GitHub write occurred.

Retryable publication failures use bounded exponential backoff. A non-retryable or exhausted chunk
is dead-lettered without silently retrying it on a later worker. Cancellation leaves pending chunks
in the artifact; a later explicitly authorized worker can continue only after acquiring a newer
lease fence. The replay seam is intentionally injected, so callers must perform their normal
exact-head check before every GitHub read and write.

### Optional OpenTelemetry receipts

`telemetry.otel` is advisory and disabled by default. It never changes model routing, verdicts,
or publication. The Action reads only the *names* of `endpoint_env` and `credential_env` from the
trusted base configuration; endpoint and credential values are resolved from the runner environment
after the Action proves the immutable base SHA against a fresh PR snapshot. The endpoint must be
an HTTPS URL without userinfo, query parameters, or fragments. Telemetry receipts contain only
status and bounded identifiers—not the endpoint, credential, prompts, comments, authors, source,
transcripts, raw errors, or provider receipt IDs.

`credential_env` is a bearer-token environment variable (not the OpenTelemetry
`OTEL_EXPORTER_OTLP_HEADERS` key/value-list format); it is sent only as the Authorization header.

### Same-PR decision memory

The Action snapshots authenticated Review Yeti finding threads once before the parallel reviewer
fan-out. Every reviewer receives byte-identical, bounded state for open, ignored, and neutrally
resolved findings. Human reply text, names, reactions, and command reasons never enter model
prompts. This is same-PR memory only; it does not carry decisions across pull requests or
repositories.

GitHub resolution has unknown intent and never implies fixed, rejected, or accepted risk. Open
P0/P1 findings remain in arbitration without duplicate publication. A resolved finding that the
current diff still demonstrates is eligible for a fresh conversation.

Only collaborators with current `write`, `maintain`, or `admin` permission may reply on a finding
thread with these commands:

```text
/review-yeti ignore accepted until API-1234 is delivered
/review-yeti unignore API-1234 has landed; evaluate this normally again
```

The command must be the first nonblank line and its reason must contain 3-500 characters. An ignore
is thread-scoped and reversible. If pagination or permission lookup is incomplete, the Action does
not grant suppression authority.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `same_pr_decisions` | `boolean` | `true` | Render authenticated same-PR state to reviewers. Setting false removes prompt context only; deterministic open-finding and decision enforcement remains active. |
| `max_entries` | `integer` | `40` | Maximum ledger entries rendered for each reviewer; valid range 1-100. |
| `max_prompt_chars` | `integer` | `8000` | Maximum rendered ledger characters; valid range 1000-20000. |
| `maintainer_commands` | `boolean` | `true` | Honor authenticated thread-scoped ignore and unignore commands. |

### Per-file diff limit and ignore catalog (Action path)

`limits.max_file_diff_chars` is the complete diff-character limit for one changed file. The
default is **5,000 characters** (a file at exactly 5,000 is included; a file at 5,001 is reported
as oversized). This is separate from `max_diff_bytes`, which bounds the whole review request.

The effective value follows this precedence, from strongest to weakest:

1. `max-file-diff-chars` Action input or `MAX_FILE_DIFF_CHARS` environment value when non-empty.
2. `limits.max_file_diff_chars` repository value in `.review-yeti.yaml` from the trusted PR base ref.
   A repository can raise or lower the limit deliberately, subject to the hard cap of 2,000,000
   characters.
3. built-in default of **5,000**.

The Action input is empty by default so the repository override can take effect. For example:

```yaml
# .review-yeti.yaml in the repository being reviewed
version: 4
limits:
  max_file_diff_chars: 10000
```

`max-file-diff-chars` is the workflow-level override; `limits.max_file_diff_chars` is the
per-repository override. If an excluded built-in file is restored with a `!` pattern, it becomes
eligible for review but still obeys the effective per-file size cap.

### Bounded evidence investigation

`limits.max_investigation_turns` (default `2`, clamped to `1-3`) gives a persona a small number of
targeted follow-up turns when it requests dependency evidence such as a changed manifest,
lockfile, registry configuration, or provenance line. Evidence is assembled from the pull-request
diff only and is bounded before it enters the follow-up prompt. If the requested path is not part of
the diff, the lane ends as `INCOMPLETE_REVIEW`; it never silently becomes `APPROVE`. The composite
Action input `max-investigation-turns` / environment variable `MAX_INVESTIGATION_TURNS` wins over
the trusted YAML value and is always clamped to three. This also drives the bounded
`review.investigation.max_turns` limit ([Bounded investigation limits](#bounded-investigation-limits)
above) — the two are the same clamp applied to both execution paths.

`lane-deadline-ms` (Action input, default `240000` = 4 minutes) is a per-lane wall-clock backstop
checked at the turn loop and threaded into every in-flight OpenRouter request for that lane. A lane
that somehow exceeds it fails closed with termination `lane_deadline` instead of running until the
job is killed, making the ceiling a stated number immune to future knob drift (turns, attempts, and
per-request budgets can all be reconfigured independently of this backstop).

The built-in catalog is deliberately curated rather than language-based. Ordinary source files
are not excluded merely because of their language or extension. The categories are:

| Category | Built-in examples |
| :--- | :--- |
| Lockfiles | `package-lock.json`, `Gemfile.lock`, `mix.lock`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `poetry.lock`, `Pipfile.lock`, `composer.lock`, `npm-shrinkwrap.json`, `bun.lockb`, `packages.lock.json` |
| Test snapshots | `**/__snapshots__/**`, `*.snap` |
| Generated files | `*.generated.ts`, `*.generated.js`, `*.generated.json`, `*.generated.yaml`, and protobuf outputs such as `*.pb.go` |
| Build output | `dist/**`, `build/**`, `out/**` |
| Dependency caches | `node_modules/**`, `.next/**`, `.nuxt/**` |
| Minified assets | `*.min.js`, `*.min.css`, `*.min.map` |
| Source maps | `*.map` |
| Binary files | Images, fonts, archives, PDFs, and native libraries by extension |

Generated OpenAPI or other API-spec artifacts, such as `openapi.generated.json` or
`schema.generated.yaml`, are a typical generated-files use case. A hand-written `openapi.yaml`
remains ordinary source and is included. A pattern without `/` is filename-only and matches that
filename at any depth; slash-bearing patterns match the path shape.

### Zoekt review-time search: warm index caching

The `code_search_zoekt` evidence tool (ADR 0329) indexes the reviewed repository so a persona can
search across files it did not otherwise read. Building that index from scratch costs real
wall-clock time before any lane can start (measured live against a 14.2k-file repository: ~7.9s to
fetch and extract the repository tarball, ~4.7s to build the index — a flat ~12.6s tax on every
review). Provisioning that index once, outside the request path, is far cheaper than rebuilding it
per review.

review-yeti-bot restores a warm index from the reviewed repository's own **GitHub Actions cache**
before ever falling back to a from-scratch build — never from a server review-yeti-ai operates.
This is deliberate: `## Why this rather than a hosted review service` above states plainly that no
Review Yeti-managed server, database, or codebase index is required, and a warm index review-yeti-ai
hosted would break that. The cache entry lives entirely in the reviewed repository's own account.

- **Restore is the only thing this version does.** review-yeti-bot never writes to this cache from
  a review run — an untrusted pull request must never be able to influence what a future review
  trusts as a warm index. Populating the cache (a scheduled or push-to-default-branch refresh
  workflow that builds and saves an index) is a deliberate, separate provisioning step and is not
  shipped yet; until a repository adds one, every review builds fresh, exactly as before this
  feature existed. This is a strict superset with no regression either way.
- **A cache miss changes nothing.** No refresh workflow configured, a first run, or a 7-day-unused
  cache eviction all fall straight through to the existing from-scratch materialize-and-build path.
- **Staleness is a known, bounded risk, not silently ignored.** A restored index almost never
  reflects this exact review's own head commit — it reflects whatever commit the last refresh
  indexed. Every match on a path this review itself changed is tagged `stale: true` in the tool's
  response (that gap is exact and free: it is precisely this review's own diff). Any other drift —
  unrelated commits landed on the default branch since the last refresh — is a smaller, separate
  risk that shrinks with refresh cadence. Crucially, this only affects search *usefulness*: any
  finding a persona actually publishes is independently checked against the real, immutable
  content at this review's exact head commit by the finding verifier
  ([Exact-snapshot finding verification](#exact-snapshot-finding-verification) above), regardless
  of what the Zoekt index told it. A stale search result can mislead a persona toward a wrong
  conclusion; it cannot make a wrong claim survive to publication.

### Action terminal outcomes and coverage outputs

If every changed file is removed by the built-in generated-file catalog or configured repository
path-policy/exclude globs, or exceeds the configured per-file limit, the Action emits `SHIP` as the
`verdict` and `review-status`. No model review runs when no eligible files remain. The comment
records each expected policy exclusion, including bounded path and size details for oversized
files. Oversized files are excluded before model input and do not create a coverage gap or block by
themselves. `SHIP` applies when no other coverage gap exists; `INCOMPLETE_REVIEW` remains reserved
for real gaps such as omitted or truncated eligible files, provider failures, or incomplete
trusted-submodule coverage.

Persona coverage is evaluated separately from the existing top-level numeric `quorum`, which
continues to describe distinct provider/model quorum. The versioned trusted-base policy is:

```yaml
coverage_policy:
  quorum: two_thirds             # two_thirds | simple_majority | unanimous
  min_personas: 3
  mandatory_personas: [security]
  provider_diversity_min: 2
```

The denominator is the enabled persona roster resolved from the trusted PR base ref. Only a lane
with `APPROVE` or `FINDINGS`, a findings array, provider/model provenance, and no error, timeout,
empty, or partial marker counts as trustworthy. `two_thirds` is
`ceil(2 * expected / 3)`; `simple_majority` is `floor(expected / 2) + 1`. Mandatory personas,
the minimum roster floor, and actual provider diversity must also be satisfied.

A complete clean review is `SHIP` with `gate-decision=PASS`. A quorum-met but incomplete panel is
`PARTIAL_REVIEW`; a panel below quorum or missing a safety floor is `INCOMPLETE_REVIEW`. Both
partial and incomplete outcomes retain findings as durable evidence, force `BLOCKED`, and are
never merge-eligible. Publication success does not imply a successful review outcome.

This is an explicit policy tradeoff: `SHIP` means no blocking finding was established in the
reviewable evidence; it does not claim that an oversized file was reviewed. A repository that
requires every changed file to be reviewed can raise the cap or add a merge gate for
`files-oversized != '0'`. The default remains non-blocking so generated specs and similar
expected artifacts cannot hold up an otherwise valid review.

Migration note: older versions emitted `NO_REVIEWABLE_FILES` for all-policy-excluded changes.
That legacy status is no longer emitted. Consumers should accept `SHIP` and use
`files-skipped-generated` / `files-oversized` when they need to distinguish a policy-only review
from a model-backed review.

| Output | Description |
| :--- | :--- |
| `verdict` | SHIP, FIX_FIRST, BLOCK, or NO_VERDICT when the review cannot complete safely. Legacy NO_REVIEWABLE_FILES is no longer emitted for policy exclusions; migrate consumers to SHIP plus coverage outputs. |
| `review-status` | Terminal review status: SHIP, FIX_FIRST, BLOCK, PARTIAL_REVIEW, or INCOMPLETE_REVIEW. Expected policy exclusions do not create a coverage gap; partial and incomplete review statuses are never merge-eligible. |
| `coverage-status` | Coverage state: complete, partial, or incomplete. Partial and incomplete are never merge-eligible. |
| `gate-decision` | Derived gate decision: PASS only for a complete clean review; otherwise BLOCKED. |
| `merge-eligible` | Derived merge eligibility. True only for complete SHIP with a passing gate and no P0/P1 findings. |
| `review-dispatch-digest` | Digest of the provider-owned review-dispatch-run.v2 receipt for this exact head. |
| `review-dispatch-policy-digest` | Trusted policy digest bound into the provider-owned dispatch receipt when the provider emitted one. |
| `review-dispatch-manifest-digest` | Canonical JSON digest of the complete bounded manifest bound into the provider-owned dispatch receipt. |
| `review-dispatch-manifest-artifact-digest` | Digest of the exact complete manifest artifact bytes written by the provider run. |
| `review-dispatch-provider-receipt-digest` | Digest of the provider generation-receipt set when the provider returned receipt-backed usage IDs. |
| `review-dispatch-receipt-path` | Exact local path to the provider-owned review-dispatch-run.v2 receipt artifact. Upload or attach this file for durable evidence. |
| `review-dispatch-manifest-path` | Exact local path to the complete review-unit manifest artifact. Upload or attach this file for durable evidence. |
| `files-skipped-generated` | Changed files skipped by the built-in generated-file catalog or configured repository path-policy/exclude globs. Intentional, and not a coverage gap. |
| `files-oversized` | Changed files whose complete per-file diff exceeded the configured limit. Excluded before model input and noted in the review comment; non-blocking by itself, while other coverage gaps can still produce INCOMPLETE_REVIEW. |

### `github_action.openrouter` (Action path)

OpenRouter **client** settings for the composite Action (read from the PR base ref only).

```yaml
github_action:
  openrouter:
    model: openrouter/auto-beta # primary model; Action `model` input can override
    allowed_models: [openrouter/auto-beta]
    timeout_ms: 30000         # hard per-request timeout
    data_collection: deny     # allow | deny
    cost_quality_tradeoff: 5  # 0=cheapest … 10=highest quality
    ignore_providers: []
    fallback_models:
      - deepseek/deepseek-v4-flash-0731  # ordered fallback after transient primary failures
    provider_routing:
      allow_fallbacks: false
      require_parameters: true
      sort: { by: throughput, partition: none }
      max_price: { prompt: 1, completion: 1 }
```

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeout_ms` | `number` | `30000` | Per-request hard timeout in milliseconds. Lanes that do not return in time fail as `timeout`. Action input `openrouter-timeout-ms` / env `OPENROUTER_TIMEOUT_MS` / var `OPENROUTER_TIMEOUT_MS` override YAML. Clamped to 500–600000. |
| `ttft_ms` | `number` | `30000` | Time-to-first-token deadline. It starts at request dispatch and clears on the first SSE chunk; on expiry it aborts with failure class `ttft_timeout` and adds the provider to **no** ignore/quarantine/ban set (OpenRouter's own `sort:latency` routing stays the sole authority — the retry simply re-asks). Also sets `provider_routing.preferred_max_latency` when not explicitly configured. Action input `openrouter-ttft-ms` / env `OPENROUTER_TTFT_MS` override YAML. Clamped to 500ms–`timeout_ms`. |
| `max_attempts` | `number` | `2` | Maximum attempts per model per persona lane (one initial attempt plus one retry — "1 retry max per lane"). No budget escalation and no bonus attempt after a provider is identified; the attempt loop is the whole retry. Action input `openrouter-max-attempts` / env `OPENROUTER_MAX_ATTEMPTS` override YAML. Clamped to 1–5. |
| `model` | `string` | `openrouter/auto-beta` | Primary model id. The explicit Action `model` input/environment has precedence. |
| `fallback_models` | `string[]` | `[]` | Ordered model ids used after the primary exhausts its transient-failure retries. Timeouts, network failures, 408, 429, and 5xx responses can move to the next model. Action input `openrouter-fallback-models` / env `OPENROUTER_FALLBACK_MODELS` overrides YAML. |
| `allowed_models` | `string[]` | `[]` | Auto Router model allowlist. |
| `ignore_providers` | `string[]` | `[]` | Optional provider slugs excluded from routing. The action injects no permanent endpoint exclusions. |
| `cost_quality_tradeoff` | `number` | unset | Auto Router cost/quality 0–10. |
| `data_collection` | `allow`\|`deny` | unset | When `deny`, sends OpenRouter training opt-out header. |
| `provider_routing` | object | unset | Validated provider-selection fields: order/only/ignore/quantizations, fallbacks, parameters, data collection/ZDR, sort, throughput/latency, and max price. The default enables fallbacks, requires requested parameters, restricts endpoints to FP16/BF16 full precision, and prefers healthy throughput/latency percentiles without forcing a provider cohort. Fixed models are checked against explicit model/provider compatibility before fan-out. |

**Precedence:** action input / env → `.review-yeti.yaml` → defaults (`timeout_ms=30000`, `fallback_models=[]`).
Provider requests always use the SSE streaming transport; streaming is not a configuration option.

In the central review workflow, repository variable `OPENROUTER_MODEL` overrides the primary and
`OPENROUTER_FALLBACK_MODELS` overrides the ordered fallback list. The workflow defaults to
`openrouter/auto-beta` with `deepseek/deepseek-v4-flash-0731` as fallback; other repositories can
use `fallback_models` from their trusted base configuration when the Action input is empty.

### `mcp.context7` (Action path)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` when `CONTEXT7_API_KEY` is set | When true **and** the Action has a non-empty `context7-api-key` / `CONTEXT7_API_KEY`, Context7 docs are fetched once and injected into **every** persona prompt. Set `false` to disable for this repo even if the secret exists. |
| `libraries` | `string[]` | inferred from the diff | Optional explicit library names for Context7 search. |
| `max_snippets` | `number` | `5` | Cap on snippets requested per library (max 10). |

### `review.context.compaction`

This optional Action policy bounds only untrusted Context7 and remote-memory material before
reviewer fan-out. It does not compact the diff, file manifest, decision ledger, or reviewer
rules. The block is applied only when the Action has fetched configuration into its temporary
trusted directory, the supplied base SHA is immutable, and a fresh pull-request snapshot matches
that SHA; otherwise it remains disabled.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `false` | Enables deterministic metadata-only compaction for optional tool and advisory context. |
| `max_bytes` | positive integer | `8000` | Maximum UTF-8 bytes for frozen, active, and compacted context combined. Frozen or active content that cannot fit causes the review path to fail rather than sending an oversized prompt. |
| `summary_bytes` | positive integer | `2000` | Maximum UTF-8 bytes reserved for the compacted metadata block. It must not exceed `max_bytes`; if metadata cannot fit, the compacted block is omitted. |
| `frozen_overflow` | `fail` | `fail` | Required overflow behavior for frozen context. No truncation mode is supported. |

```yaml
review:
  context:
    compaction:
      enabled: true
      max_bytes: 8000
      summary_bytes: 2000
      frozen_overflow: fail
```

The GitHub secret `CONTEXT7_API_KEY` is the hard gate. Without it, Context7 stays off regardless of YAML.

Gitlink changes are never treated as ordinary text files. `metadata_only` requires pinned old/new
commit IDs, while `recursive` records an incomplete review until a nested snapshot resolver is
available. An incomplete submodule review cannot produce `SHIP`. Trusted Action inputs may narrow
these settings, but immutable safety caps always win; the effective policy digest is part of the
run identity.

---

## 📦 The 6 Compatibility Sections

### 1. `reviews`
Controls automated code review behaviors, summaries, status publishing, and inline comment formatting.

GitHub PR conversation output is quiet by default: one stable sticky final review
summary is updated across pushes, earlier rounds are kept in collapsed history,
P0/P1 findings publish as resolvable review conversations, and persona/model/P2
details are kept in the current summary.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `profile` | `enum` | `'balanced'` | Review stance: `'chill'` (relaxed, non-blocking), `'balanced'` (standard), `'assertive'` (strict enforcement). |
| `reviewer_effort` | `enum` | `'medium'` | Effort level: `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`. Maps to model reasoning depth and latency budgets. |
| `confidence_threshold` | `number` | `70` | Numeric finding cutoff filter (0-100). Findings below threshold are suppressed. |
| `mascot` | `boolean` | `true` | Toggles ASCII art mascot in PR comments (`PUBLISHER_MASCOT`). |
| `ticket_enforcement` | `boolean` | `false` | Mandates valid Linear, Jira, or GitHub issue ticket references in PR titles/descriptions. |
| `request_changes_workflow` | `boolean` | `false` | Deprecated compatibility field. Reviews use `COMMENT` plus resolvable P0/P1 threads; this value no longer changes publication behavior. |
| `high_level_summary` | `boolean` | `true` | Generates CodeRabbit-style Executive Overview and Walkthrough sections. |
| `sequence_diagrams` | `boolean` | `true` | Automatically generates `mermaid` sequence/flowchart diagrams for complex diffs. |
| `poem` | `boolean` | `false` | Generates a playful poem summary at the bottom of the review. |
| `review_status` | `boolean` | `true` | Posts GitHub commit Check Runs (`in_progress`, `success`, `failure`). |
| `collapse_walkthrough` | `boolean` | `false` | Wraps the walkthrough bullet list inside a `<details>` block. |
| `auto_title_instructions` | `string` | `undefined` | Instructions for automated PR title suggestions. |
| `path_instructions` | `array` | `[]` | Array of path-specific review instruction objects (`{ path: "src/db/**", instructions: "..." }`). |

```yaml
reviews:
  profile: "assertive"
  reviewer_effort: "high"
  confidence_threshold: 85
  mascot: true
  ticket_enforcement: true
  request_changes_workflow: false
  high_level_summary: true
  sequence_diagrams: true
  path_instructions:
    - path: "src/auth/**"
      instructions: "Enforce strict fail-closed authorization checks and audit log emissions."
```

---

### 2. `chat`
Governs interactive `@review-yeti` PR comment responses and context turn memory.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `auto_reply` | `boolean` | `true` | Enables automated responses to `@review-yeti` mentions and inline thread replies. |
| `max_context_turns` | `number` | `10` | Maximum comment thread history turns passed to LLMs. |
| `art_mascot_response` | `boolean` | `true` | Includes ASCII mascot header in chat responses. |

```yaml
chat:
  auto_reply: true
  max_context_turns: 15
  art_mascot_response: true
```

---

### 3. `knowledge_base`
Compatibility-only configuration for hosted/app consumers and CodeRabbit-style files. The public
composite Action does not build a local SQLite/vector database from this section. Use the native
`memory` section below to select one API-backed provider for review-time recall and persistence.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `learnings` | `boolean` | `true` | Hosted/app compatibility flag; ignored by the composite Action. |
| `issues` | `boolean` | `true` | Hosted/app compatibility flag; the Action does not index issues from this key. |
| `pull_requests` | `boolean` | `true` | Hosted/app compatibility flag; the Action does not index merged PRs from this key. |
| `custom_instructions` | `string[]` | `[]` | Global repository guidelines and Architectural Decision Records (ADRs). |

```yaml
knowledge_base:
  learnings: true
  issues: true
  pull_requests: true
  custom_instructions:
    - "ADR-004: All database access must use parameterized queries."
    - "ADR-012: Prefer explicit return types on public TypeScript functions."
```

### 3a. `memory` provider selection

Review-time API-backed memory is configured in trusted base-ref YAML. Exactly one provider is active
per run; production does not fan out writes or merge reads. Honcho remains the default, while
`mem0`, `hindsight`, `supermemory`, and `retaindb` are selectable adapters. Provider failures
degrade to GitHub-ledger-only review behavior.

Every provider profile names an HTTP endpoint and credential environment reference. The Action calls
the provider API through its adapter; it does not open a direct database connection. A local hashed
outbox may be uploaded for replay, but it is delivery infrastructure rather than a memory backend.

```yaml
memory:
  enabled: true
  provider: honcho
  mode: single
  transport: mcp
  fallback: github_ledger_only
  query:
    timeout_ms: 1500
    max_context_chars: 4000
    max_entries: 40
  recall:
    decision_feedback: true
    session_recap: true
    code_signals: true
    rule_signals: true
  persist:
    processing: true
    decision_feedback: true
    session_recap: true
    code_signals: true
    rule_signals: true
  providers:
    honcho:
      enabled: true
      transport: mcp
      endpoint_env: HONCHO_URL
      credential_env: HONCHO_API_KEY
      workspace_env: HONCHO_WORKSPACE_ID
    mem0: { enabled: false, transport: rest, endpoint_env: MEM0_URL, credential_env: MEM0_API_KEY, namespace_env: MEM0_NAMESPACE }
    hindsight: { enabled: false, transport: rest, endpoint_env: HINDSIGHT_URL, credential_env: HINDSIGHT_API_KEY }
    supermemory: { enabled: false, transport: rest, endpoint_env: SUPERMEMORY_URL, credential_env: SUPERMEMORY_API_KEY }
    retaindb: { enabled: false, transport: rest, endpoint_env: RETAINDB_URL, credential_env: RETAINDB_API_KEY }
```

`memory.provider` must be one of the five built-in IDs, `mode` must be `single`, and
`fallback` must be `github_ledger_only`. Endpoints and credentials are environment references
resolved from trusted runtime configuration/Doppler; pull-request YAML cannot retarget them. The
router intersects the requested domains with provider capabilities and reports omitted domains in
the receipt. Supermemory and RetainDB remain experimental until live ingestion/readiness evidence
passes. Cross-provider comparisons use offline outbox replay, never runtime fan-out.

### 3b. `memory.honcho`

Honcho is an optional advisory memory provider for repository-scoped pull-request review context.
The GitHub decision ledger remains authoritative for finding state, maintainer commands, and
arbitration. Honcho failures are fail-open and never block publication.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `false` | Enables the Honcho adapter. |
| `transport` | `string` | `rest` for legacy configs | `mcp` selects the provider-neutral MCP-compatible memory path; `rest` is explicit compatibility/rollback. There is no pipeline-level fallback. |
| `context` | `boolean` | `false` | Reads bounded Honcho context before reviewer fan-out. |
| `write` | `boolean` | `false` | Writes normalized review events after GitHub publication. |
| `timeout_ms` | `number` | `1500` | Request timeout, clamped to `250..5000`. |
| `max_context_chars` | `number` | `4000` | Prompt context cap, clamped to `1000..8000`. |
| `recall` | `object` | legacy decision/session only | Enables bounded `decision_feedback`, `session_recap`, `code_signals`, and `rule_signals`; intersected with provider capabilities. |
| `persist` | `object` | legacy processing/decision/session only | Enables normalized processing, session, code, rule, and feedback event persistence. |

```yaml
memory:
  honcho:
    enabled: true
    transport: mcp
    context: true
    write: true
    timeout_ms: 1500
    max_context_chars: 4000
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

The Action inputs `honcho-enabled`, `honcho-context`, `honcho-write`,
`honcho-timeout-ms`, and `honcho-max-context-chars` preserve legacy behavior. New
`honcho-mcp-enabled` and `honcho-mcp-transport` inputs explicitly opt into or roll back the MCP
provider path. Precedence is explicit MCP input, trusted `memory.honcho.transport`, then legacy
REST-compatible defaults. Class toggles remain controlled by trusted YAML and cannot be widened by
Action inputs. Pass `doppler-token` (and optionally `doppler-project` / `doppler-config`) to resolve
`HONCHO_URL`/`HONCHO_BASE_URL`, `HONCHO_API_KEY` or `HONCHO_WORKSPACE_JWT`, and
`HONCHO_WORKSPACE_ID`/`HONCHO_WORKSPACE` through the dependency-free Action runtime client. When no
explicit workspace is supplied, the adapter uses the scoped JWT workspace claim. That runtime uses
environment, cache, and Doppler REST API tiers; it deliberately does not
invoke the Doppler CLI on a GitHub runner. `HONCHO_BASE_URL` and `HONCHO_WORKSPACE` are accepted
aliases for self-hosted configurations. Do not place credentials in repository configuration.

```yaml
- uses: review-yeti-ai/review-yeti-bot@<40-hex-action-sha>
  with:
    action-sha: <40-hex-action-sha>
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    honcho-enabled: 'true'
    honcho-context: 'true'
    honcho-write: 'true'
    doppler-token: ${{ secrets.DOPPLER_TOKEN }}
    doppler-project: review-yeti-bot
    doppler-config: production
```

The provider recalls only normalized, bounded context. GitHub's same-PR decision ledger remains
authoritative for comments, resolutions, ignores, corrections, and arbitration. PR session recaps
contain head SHA, turn, verdict, coverage, claim fingerprints, and state transitions—not raw
comment bodies, authors, or model transcripts. Code signals contain claim fingerprints and
locations; rule signals contain trusted base SHA/policy digest and are never executable; feedback
contains authenticated permission class, command kind, transition ID, reason taxonomy, and reason
hash. A cancelled runner leaves a versioned outbox artifact for replay. Composite-action
consumers that need recovery after runner termination must upload the emitted `memory-outbox-path`
output (the file is under `sessions/`):

```yaml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: review-yeti-memory-outbox-${{ github.run_id }}
    path: ${{ steps.review.outputs.memory-outbox-path }}
    if-no-files-found: ignore
```

An operator can replay an authorized artifact with
`node scripts/replay-memory-outbox.mjs --path <hashed-outbox> --lease <operator-id> --provider honcho --authorize yes`.
Replay validates the stored repository/PR/head/policy identity, uses the current trusted Doppler
endpoint, takes a lease, retries with bounded backoff, and moves repeated failures to dead-letter.

### Optional Review Yeti Cloud link

Pass `dashboard-api-key` to publish the bounded review event to Review Yeti Cloud. On an accepted
or idempotent duplicate response that includes a run id, the final GitHub review links to the exact
cloud run and the action exposes it through its `dashboard-review-url` output. Set
`dashboard-api-url` and `dashboard-url` together for a self-hosted deployment. Delivery is
fail-soft and never changes the GitHub verdict, review publication, or merge gate.

```yaml
- uses: review-yeti-ai/review-yeti-bot@<40-hex-action-sha>
  with:
    action-sha: <40-hex-action-sha>
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    dashboard-api-key: ${{ secrets.REVIEW_YETI_CLOUD_KEY }}
    dashboard-api-url: https://api.reviewyeti.ai/api/v1/review-events
    dashboard-url: https://reviewyeti.ai
```

For DigitalOcean self-hosting, require HTTPS at the reverse proxy, JWT authentication with a
workspace-scoped token, PostgreSQL with pgvector, Redis, a configured LLM provider, and a running
deriver. Honcho `/health` only proves process reachability; it does not prove representations can
be derived. Set `honcho-enabled: 'false'` to roll back to GitHub-only behavior without changing the
decision ledger.

---

### 4. `path_filters`
List of glob patterns to ignore or target during automated code reviews.

```yaml
path_filters:
  - "!node_modules/**"
  - "!dist/**"
  - "!*.min.js"
  - "!vendor/**"
  - "!coverage/**"
```

---

### 5. `auto_review`
Rules governing when `review-yeti-bot` automatically triggers PR reviews.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Master toggle for automated review pipeline upon PR open/synchronize events. |
| `ignore_drafts` | `boolean` | `true` | Skips review execution while PR is marked as Draft. |
| `drafts` | `boolean` | `false` | Explicitly enables reviews on Draft PRs if set to `true`. |
| `labels` | `string[]` | `[]` | Required GitHub labels to trigger review (e.g. `["needs-review"]`). |

```yaml
auto_review:
  enabled: true
  ignore_drafts: true
  labels:
    - "review-requested"
```

---

### 6. `dials`
High-level control knobs providing clean, top-level overrides across the platform.

| Knob | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `memory_engine` | `boolean` | `true` | Hosted/app compatibility switch; it does not select or enable the Action's API-backed `memory` provider. |
| `mascot` | `boolean` | `true` | Master toggle for ASCII mascot output across reviews and chats. |
| `confidence_threshold` | `number` | `70` | Global finding confidence cutoff rating (0-100). |
| `ticket_enforcement` | `boolean` | `false` | Master toggle for Linear / Jira / GitHub ticket validation. |
| `persona_model` | `string` | `undefined` | Overrides model across all persona lanes. |

```yaml
dials:
  memory_engine: true
  mascot: true
  confidence_threshold: 80
  ticket_enforcement: true
  persona_model: "claude-5-sonnet"
```

---

## 🎛️ Clean Key Toggles

`review-yeti-bot` supports direct, clean configuration toggles that map cleanly into the underlying engine:

- **`memory_engine`** (`boolean`): Hosted/app compatibility toggle. It does not enable a local
  database or replace the Action's API-backed `memory` provider configuration.
- **`mascot`** (`boolean`): Controls whether ASCII art mascot headers are rendered in comments.
- **`persona_model`** (`string`): Supported flagship persona models:
  - `claude-5-sonnet` (Anthropic / OpenRouter)
  - `gpt-5.6-sol` (OpenAI / OpenRouter)
  - `deepseek-v4-pro` (DeepSeek / OpenRouter)
  - `glm-5.2` (Z-AI / OpenRouter)
  - V3 Provider models: `codex/gpt-5.6-sol-high`, `grok-cli/grok-4.5`, `agy/claude-opus-4-6-thinking`, `claude/claude-opus-4-8`.
- **`confidence_threshold`** (`number`): Integer threshold from `0` to `100`.
- **`ticket_enforcement`** (`boolean`): Enforces ticket links across Linear (`PROJ-123`), Jira (`KEY-456`), or GitHub (`#789`).
- **`reviewer_effort`** (`enum`): Controls latency and reasoning depth (`low`, `medium`, `high`, `xhigh`, `max`).

---

## 👥 Multi-LLM Personas & Provider Schema

### Persona Definition (`personas`)

A `personas:` list in `.review-yeti.yaml` selects which reviewers run, and may define new ones.
When the key is absent, every built-in persona runs.

**On by default** — `security`, `performance`, `architecture`, `testing`, `dependencies`. These
apply to essentially any codebase.

**Situational, off by default** — `style`, `documentation`, `accessibility`, `database`,
`devops`, `i18n`, `licensing`. Running all twelve everywhere reports on internationalisation in
projects that ship one language and licence headers in projects that use none, which teaches
people to ignore the bot. Opt in by id, or use `all` for the complete roster.

```yaml
personas:
  # Reference a built-in by id.
  - id: security

  # Disable one explicitly.
  - id: style
    enabled: false

  # Override a built-in's instructions, keeping its id and name.
  - id: architecture
    charter: "Flag any import that crosses a module boundary without going through its index."

  # Define a reviewer of your own. Custom personas require a charter.
  - id: tenancy
    name: "🏢 Multi-Tenant Isolation"
    charter: |
      Every query touching customer data must be scoped by orgId.
      Flag any repository method accepting a raw id without a tenant bound.
```

| Key | Required | Description |
| :--- | :--- | :--- |
| `id` | yes | Built-in id, or a new id for a custom persona. |
| `charter` | for custom personas | Instructions used as the reviewer's system prompt. |
| `name` | no | Display name in the review comment. Defaults to the built-in's name, or the id. |
| `enabled` | no | Set `false` to exclude. Defaults to `true`. |
| `model` | no | Per-persona model override. Defaults to the workflow's model. |

### `exclude`

Path globs removed from the diff **before** the per-persona budget is spent, on top of the
built-in generated-content list above. `*` stops at a path separator, `**` spans them. A pattern
without `/` is filename-only and matches at any depth.

A glob prefixed with `!` **restores** matching files instead. Exclusion is a guess about what
nobody needs to read, and the built-in list is fixed, so without a way back a repository that
keeps its scripts in `bin/` cannot get them reviewed at all.

```yaml
exclude:
  - '**/generated/**'                  # the API client, the protobuf output, …
  - '!src/entities/generated/**'       # …but this one is hand-maintained despite the name
  - '!bin/**'                          # our scripts live here; the built-in list assumes binaries
```

Negations are applied after every positive pattern, so the list means the same thing whatever
order it is written in. The built-in categories and configured/path-policy matches are expected
skips and are reported through `files-skipped-generated`, not as missing coverage. A restored file
is eligible only if it also fits the effective per-file limit. An oversized source file is reported
through the separate `files-oversized` output, excluded before model input, and noted in the PR
comment with path and size; it does not by itself make the review incomplete or block `SHIP`. If all changed
files are policy exclusions, the terminal `verdict` and `review-status` are `SHIP`; no model review
runs, and the comment explains that the result is policy-compliant.

The action's `exclude:` input takes the same syntax as a comma-separated list, and the two are
combined rather than one overriding the other.

### Persona Files (`.review-yeti/personas/*.md`)

A charter long enough to be useful is awkward as a YAML string. Each reviewer may instead live
in its own markdown file, where optional YAML frontmatter carries the metadata and the body is
the charter:

```markdown
<!-- .review-yeti/personas/tenancy.md -->
---
name: "🏢 Multi-Tenant Isolation"
enabled: true
model: anthropic/claude-sonnet-4
---

Every query that touches customer data must be scoped by `orgId`.

## What to flag
- Repository methods accepting a raw `id` without a tenant bound

## What not to flag
- Admin-only endpoints under `src/admin/**`, which are intentionally cross-tenant
```

| Frontmatter key | Required | Description |
| :--- | :--- | :--- |
| `id` | no | Defaults to the filename without its extension. |
| `name` | no | Display name. Falls back to a built-in's name when overriding one, else the id. |
| `enabled` | no | Set `false` to keep the file without running the reviewer. |
| `model` | no | Per-persona model override. |

Rules:

- **Frontmatter is optional.** A file containing only prose is a valid persona; its id comes from
  the filename.
- **Files extend the default roster.** Adding one persona file does not switch the twelve
  built-ins off. Narrow the roster with a `personas:` list or the action's `personas:` input.
- **A file may override a built-in** by using its id; the body replaces that reviewer's charter.
- **Declaring one id in two places is an error.** A file and an inline `personas:` entry with the
  same id fails the run rather than silently picking a winner.
- **An empty body is an error**, as is malformed frontmatter. Both fail the run rather than
  dropping the reviewer silently.

> **Unknown ids are fatal.** An id that is neither a built-in nor accompanied by a `charter`
> fails the run with a non-zero exit and a message listing the valid ids. This is deliberate:
> an unrecognised id previously selected zero reviewers, and a review with zero reviewers
> reports `SHIP` — a typo would silently turn the bot into a rubber stamp.

> **Not implemented on the Action path.** Earlier revisions of this document described
> `paths:`, `providers:` and `required:` keys, and a `charter: "builtin:security"` indirection.
> Those belong to the `src/panel/panelEngine.ts` configuration schema, not to the GitHub Action,
> and are ignored by it. Path scoping for personas is not currently available.

### Reviewers & Arbiter Definition (`reviewers`)
Defines execution mode, provider pool details, and binding arbiter order:

```yaml
reviewers:
  execution: "personas"
  fallback: "ordered"
  overall_timeout_s: 60
  providers:
    - id: "codex"
      enabled: true
      model: "codex/gpt-5.6-sol-high"
      effort: "max"
      review_timeout_s: 30
      arbiter_timeout_s: 30
    - id: "claude"
      enabled: true
      model: "claude-5-sonnet"
      effort: "high"
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: ["codex", "claude"]
```

---

## 🔄 CodeRabbit 1:1 Translation Mapping (`translateCodeRabbitToV3`)

`review-yeti-bot` provides native compatibility with `.coderabbit.yaml` configuration files. When `.coderabbit.yaml` is detected, the internal parser invokes `translateCodeRabbitToV3()`, which maps CodeRabbit structures directly into `review-yeti-bot` V3 schemas.

### Cascading Resolution Logic
To maintain backward compatibility, toggle settings cascade with sensible fallbacks:

```text
dials.mascot  ──>  reviews.mascot  ──>  chat.art_mascot_response  ──>  default (true)
dials.memory_engine  ──>  knowledge_base.learnings  ──>  default (true)
dials.confidence_threshold  ──>  reviews.confidence_threshold  ──>  default (70)
dials.ticket_enforcement  ──>  reviews.ticket_enforcement  ──>  default (false)
reviews.reviewer_effort  ──>  rawObj.reviewer_effort  ──>  default ("medium")
```

### Translation Code Example
```typescript
// Internal translation mechanism (src/config/configLoader.ts)
export function translateCodeRabbitToV3(raw: any): ReviewYetiConfigV3 {
  const mascot = dials.mascot ?? reviews.mascot ?? chat.art_mascot_response ?? true;
  const memory_engine = dials.memory_engine ?? kb.learnings ?? true;
  const confidence_threshold = Math.max(0, Math.min(100, dials.confidence_threshold ?? reviews.confidence_threshold ?? 70));
  const ticket_enforcement = dials.ticket_enforcement ?? reviews.ticket_enforcement ?? false;
  const reviewer_effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(reviews.reviewer_effort) 
    ? reviews.reviewer_effort 
    : 'medium';

  return {
    version: 3,
    profile: reviews.profile || 'balanced',
    reviewer_effort,
    confidence_threshold,
    mascot,
    reviews: { ...defaultConfig.reviews, ...reviews, mascot, ticket_enforcement, confidence_threshold },
    chat: { ...defaultConfig.chat, ...chat, art_mascot_response: mascot },
    knowledge_base: { ...defaultConfig.knowledge_base, ...kb, learnings: memory_engine },
    path_filters: Array.isArray(pathFilters) ? pathFilters : [],
    auto_review: { ...defaultConfig.auto_review, ...autoReview },
    dials: { memory_engine, mascot, confidence_threshold, ticket_enforcement },
    // ...
  };
}
```

---

## 📜 Full Configuration Examples

### Native `.review-yeti.yaml` (V3)

```yaml
version: 3
profile: "assertive"
quorum: 2
mascot: true

dials:
  memory_engine: true
  mascot: true
  confidence_threshold: 80
  ticket_enforcement: true

reviews:
  profile: "assertive"
  reviewer_effort: "high"
  confidence_threshold: 80
  mascot: true
  ticket_enforcement: true
  request_changes_workflow: false
  high_level_summary: true
  sequence_diagrams: true
  path_instructions:
    - path: "src/security/**"
      instructions: "Perform zero-trust code analysis and check for timing attacks."

chat:
  auto_reply: true
  max_context_turns: 10
  art_mascot_response: true

knowledge_base:
  learnings: true
  issues: true
  pull_requests: true
  custom_instructions:
    - "ADR-001: All external network calls must go through the shared HTTP client."

path_filters:
  - "!node_modules/**"
  - "!dist/**"

auto_review:
  enabled: true
  ignore_drafts: true

personas:
  - id: "sec-lane"
    enabled: true
    required: true
    charter: "builtin:security"
    paths: ["**"]
    providers: ["codex"]
  - id: "arch-lane"
    enabled: true
    required: true
    charter: "builtin:contract"
    paths: ["src/**"]
    providers: ["claude"]

reviewers:
  execution: "personas"
  fallback: "ordered"
  overall_timeout_s: 60
  providers:
    - id: "codex"
      enabled: true
      model: "gpt-5.6-sol"
      effort: "high"
      review_timeout_s: 30
      arbiter_timeout_s: 30
    - id: "claude"
      enabled: true
      model: "claude-5-sonnet"
      effort: "high"
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: ["codex", "claude"]
```

---

### CodeRabbit-Compatible `.coderabbit.yaml`

```yaml
# Drop-in CodeRabbit configuration automatically translated by review-yeti-bot
language: "en-US"
tone_instructions: "Be concise, analytical, and actionable."

reviews:
  profile: "balanced"
  request_changes_workflow: false
  high_level_summary: true
  poem: false
  review_status: true
  collapse_walkthrough: false
  sequence_diagrams: true
  path_instructions:
    - path: "src/api/**"
      instructions: "Ensure all endpoints validate input schemas via Zod."

chat:
  auto_reply: true
  max_context_turns: 10

knowledge_base:
  learnings: true
  issues: true
  pull_requests: true

path_filters:
  - "!*.min.js"
  - "!dist/**"

auto_review:
  enabled: true
  ignore_drafts: true
```
