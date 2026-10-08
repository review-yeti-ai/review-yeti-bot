# ⚙️ Review Yeti — Configuration Reference

> [!IMPORTANT]
> **Public Action reference.** [`action.yml`](../action.yml) and the base-ref configuration loader
> are authoritative when this guide disagrees with executable behavior. Sections explicitly scoped
> to the self-hosted service do not configure the Action. Fleet policy is external;
> see [Documentation authority](DOCUMENTATION_AUTHORITY.md).

This is a mixed reference: it documents the narrow public Action configuration boundary and
retains the broader optional-service schema. It is not a 1:1 schema for the public Action.

## Public Action configuration boundary

The Action fetches configuration from the pull request's trusted base ref. It currently consumes:

- `personas` and `.ct-review/personas/*.md` for roster and charters;
- `limits.max_diff_bytes` as a bounded diff limit;
- the `submodules` block for bounded gitlink handling; and
- `github_action.openrouter` for a direct standalone OpenRouter policy.

Caller Action inputs may narrow these controls. A managed caller's explicit central transport plan
owns provider routing. The service-only sections below—including `reviews`, `chat`,
`knowledge_base`, `path_filters`, `auto_review`, `dials`, and CodeRabbit translation—do not select
the public Action panel.

Managed callers may set the Action input `dispatch-mode` to `ordered` or `striped`. A striped
transport plan can carry `dispatch_weight`, `max_in_flight`, `concurrency_scope`,
`capacity_wait_timeout_ms`, `rate_limit`, and `quota_probe`. These fields are trusted caller policy,
not pull-request configuration. Synthetic's supported quota probe identifier is `synthetic-v2`;
its result is telemetry only and does not override explicit concurrency.

### Pi workflow runtime bootstrap

`review-engine` defaults to `legacy`. Selecting `pi-workflow` requires the caller workflow to
provision Node 24 before Review Yeti runs; the engine fails fast below Node 22.19.0. The composite
Action installs only from Review Yeti's reviewed `pi-runtime/package-lock.json` in an empty runner prefix with
dependency lifecycle scripts disabled. It validates an exact 40-hex `action-sha`, generates
`review-yeti-build-provenance.v1`, and attests the installed Pi closure before importing the trusted
static wrapper. Target-repository and pull-request files cannot provide workflow source or Pi deps.

The pinned direct runtime roots are `@quintinshaw/pi-dynamic-workflows@3.7.0`,
`@earendil-works/pi-ai@0.84.1`, `@earendil-works/pi-coding-agent@0.84.1`,
`@earendil-works/pi-tui@0.84.1`, and `typebox@1.3.7`. Npm release tarballs bundle all five plus
their transitive closure; provenance is generated from the exact clean release commit during pack.

---

## 📋 Table of Contents

1. [Optional-service Configuration File Resolution](#optional-service-configuration-file-resolution)
2. [Optional-service Top-Level Schema Overview](#optional-service-top-level-schema-overview)
3. [V4 Execution Policy](#v4-execution-policy)
   - [Provider concurrency and rate limiting (service and worker environment)](#provider-concurrency-and-rate-limiting)
4. [Optional-service Standard Sections](#optional-service-standard-sections)
   - [1. `reviews`](#1-reviews)
   - [2. `chat`](#2-chat)
   - [3. `knowledge_base`](#3-knowledge_base)
   - [4. `path_filters`](#4-path_filters)
   - [5. `auto_review`](#5-auto_review)
   - [6. `dials`](#6-dials)
5. [Optional-service Clean Key Toggles](#optional-service-clean-key-toggles)
6. [Multi-LLM Personas & Provider Schema](#multi-llm-personas--provider-schema)
7. [CodeRabbit 1:1 Translation Mapping (`translateCodeRabbitToV3`)](#coderabbit-11-translation-mapping-translatecoderabbittov3)
8. [Full Configuration Examples](#full-configuration-examples)
   - [Native `.ct-review.yaml` (V3)](#native-ct-reviewyaml-v3)
   - [CodeRabbit-Compatible `.coderabbit.yaml`](#coderabbit-compatible-coderabbityaml)
9. [Historical OpenRouter infrastructure record](#historical-openrouter-infrastructure-record)
10. [Hierarchical Configuration Passthrough & Extensibility](#hierarchical-configuration-passthrough--extensibility)

---

<a id="optional-service-configuration-file-resolution"></a>

## 🔍 Optional-service configuration file resolution

When the optional GitHub App service receives a pull-request webhook, it checks the target
repository in the following order. The public Action instead fetches its trusted base-ref files in
the order implemented by [`action.yml`](../action.yml).

1. `.ct-review.yaml` in PR target branch at the immutable PR base SHA
2. `.ct-review.yml` in PR target branch
3. `ct-review.yaml` in PR target branch
4. `.coderabbit.yaml` in PR target branch
5. Organization-level `.github` repository (`.ct-review.yaml`, `.coderabbit.yaml`)
6. Built-in system default configuration (`createDefaultV4Config()`)

---

<a id="optional-service-top-level-schema-overview"></a>

## 📐 Optional-service top-level schema overview

The optional service's Version 3 configuration contains core policy settings along with six
CodeRabbit-mirrored top-level sections:

```yaml
version: 3
profile: "balanced"          # "chill" | "balanced" | "assertive"
mascot: true
confidence_threshold: 80
reviewer_effort: "high"

# Next-Gen Swarm Architecture & Gating
composed:
  swarm_context_isolation: true   # default: true (unbounded AST outline streaming & get_hunk)
  inline_token_budget: 25000      # default: 25000 (task-scoped inline token budget)

quorum_policy:
  mode: "file_coverage"           # "file_coverage" (default) | "all_tasks" | "blocker_fast_path"
  blocker_fast_path_enabled: true # default: true (halts lanes immediately on P0 blocker)

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

## 🌐 Next-Gen Swarm Architecture & Quorum Policies

### `composed`
- `composed.swarm_context_isolation` (boolean, default: `true`):
  When enabled, Review Yeti replaces monolithic diff broadcasting with path-bounded AST file-tree outlines. Subagents retrieve code lines on-demand using `get_hunk(filePath, startLine, endLine)` and evict raw diffs from history post-turn (`[DIFF_EVICTION_RECEIPT]`), eliminating 25k token walls and supporting arbitrarily large PRs.
- `composed.inline_token_budget` (number, default: `25000`):
  Sets the token budget for inline task-scoped hunks before falling back to on-demand retrieval.

### `quorum_policy`
- `quorum_policy.mode` (`"file_coverage"` | `"all_tasks"` | `"blocker_fast_path"`, default: `"file_coverage"`):
  - `"file_coverage"`: Quorum is satisfied when every touched file in the PR has been evaluated by at least one relevant persona domain.
  - `"all_tasks"`: Legacy mode requiring 100% of planned persona tasks to complete.
  - `"blocker_fast_path"`: Quorum short-circuits immediately as soon as a P0 blocker is detected, or falls back to legacy completion.
- `quorum_policy.blocker_fast_path_enabled` (boolean, default: `true`):
  When enabled, any confirmed P0 blocker immediately halts remaining exploratory/style lanes and aborts active model streams via `taskAbort.abort()` / `AbortController`.


## V4 Execution Policy

Version 4 is the additive service execution-policy layer. Version 3 remains accepted and is
normalized to these defaults. The public Action reads only `limits.max_diff_bytes` and the
`submodules` block from this example; other service limits are not Action controls. Both paths read
trusted configuration from the base reference rather than model output or pull-request-head policy.

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
  max_prompt_tokens: 60000
  max_completion_tokens: 8000
  max_cost_usd: 5
  max_turns: 20
  max_concurrency: 12
```

Gitlink changes are never treated as ordinary text files. `metadata_only` requires pinned old/new
commit IDs, while `recursive` records an incomplete review until a nested snapshot resolver is
available. An incomplete submodule review cannot produce `SHIP`. Trusted Action inputs may narrow
these settings, but immutable safety caps always win; the effective policy digest is part of the
run identity.

<a id="provider-concurrency-and-rate-limiting"></a>

### Provider concurrency and rate limiting (service and worker environment)

Each review runs in its own worker pod and fans out several concurrent provider calls (persona
lanes, map-reduce chunks, composed tasks, moderator and arbiter). When the one upstream account
behind the review model has a hard concurrent-request cap, for example 15 slots shared with other
gateway keys, several reviews in flight exceed it together and the upstream rejects the overflow
with HTTP 429 `Concurrent limit reached ... 15/15 slots in use`. Three mechanisms address that.
All are off by default; an un-upgraded or unconfigured deployment behaves exactly as before.

**1. Cross-review concurrency leases.** The dispatch service keeps a Postgres lease table
(`provider_concurrency_leases`, created by the schema gate) keyed by provider/model. Before each
provider call a worker leases one slot over its authenticated channel
(`POST /api/dispatch/provider-lease`, the same per-run bearer as the checkpoint route), renews it
while the call runs (every third of the TTL) and releases it afterwards. Acquire reaps expired
leases and counts the remaining ones under a per-key transaction lock, so two workers can never take
the last slot together; a crashed worker's slot frees itself when its lease expires. When every slot
is held, the worker waits with jitter and asks again, never past its call's deadline (it keeps up to
60 s, at most half the call budget, for the call itself) and never past the worker's work cutoff.

**Fail open.** A coordinator that is not configured, unreachable, slow, throttled or answering
malformed data never fails a review: the worker proceeds under its local cap and skips the
coordinator for 30 s. A wait that runs out of budget proceeds without a lease. At worst the
provider then answers 429 and the rate-limit ladder below rides it out.

**2. Per-worker local cap.** An in-process FIFO cap on concurrent provider calls in one worker.

**3. Rate-limit retry ladder.** Both review engines (fan-out and composed) send an observed 429 to a
dedicated ladder instead of the five-retry outage ladder: exponential backoff with full jitter (base
2 s, factor 2, at most 30 s per sleep), floored at the sanitized `Retry-After`, bounded by the
remaining persona/panel/terminal budget (and a 15-minute safety window) rather than a small attempt
count. When no further wait fits, the lane fails with failure class `rate_limit`. A free-form
"rate limited" message with no observed 429 keeps its existing fast-failover behaviour.

**No fallback transport.** The publishing worker is Bifrost-only by invariant: the gateway owns model
routing and any fallback targets. Rate limiting is never answered by switching to another transport
or provider; the provider pool in the policy schema does not change that for this lane.

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `REVIEW_YETI_PROVIDER_CONCURRENCY` | dispatch service | unset (route not mounted) | Comma-separated `key=slots` pairs, keys lower-cased (for example `pr-reviewer=12`). `*=N` sets the capacity for any other key; without it, unlisted keys are unmanaged (workers use only their local cap). A malformed value is logged and leaves the route unmounted; it never stops the service. |
| `REVIEW_YETI_PROVIDER_LEASE_TTL_MS` | dispatch service | `60000` | Lease time-to-live, 5000 to 600000. A holder that stops renewing frees its slot after this long. |
| `REVIEW_YETI_PROVIDER_LEASES` | worker | unset (off) | `true` to lease a slot from the service before each provider call. |
| `REVIEW_YETI_PROVIDER_LEASE_KEY` | worker | the request model, lower-cased | Fixed capacity key for every call. Set it when every model the worker uses routes to the same upstream account. |
| `REVIEW_YETI_PROVIDER_LOCAL_CONCURRENCY` | worker | unset: no local cap; `8` when leases are on | Per-worker cap on concurrent provider calls, 1 to 64. It is also the bound that applies when the coordinator is unreachable. |

Sizing: give the review key fewer slots than the upstream's real cap when the account is shared with
other keys (for example 12 of 15), and keep the gateway's own provider concurrency setting at or
below the upstream cap. Both the service and the workers must be configured: the service variable
mounts the route, the worker flag makes workers use it. Either side alone is a no-op.

---

## Historical OpenRouter infrastructure record

[`OPENROUTER_TERRAFORM.md`](OPENROUTER_TERRAFORM.md) preserves an earlier historical fleet
workspace, guardrail, budget, Doppler, and secret-handoff procedure. It is non-operational and its
commands must not be executed without a separate current infrastructure audit. A direct standalone
Action uses reviewed Action inputs and repository secrets; a managed fleet inherits provider policy
from its central control plane.

---

<a id="optional-service-standard-sections"></a>

## 📦 Optional-service standard sections

### 1. `reviews`
Controls automated code review behaviors, summaries, status publishing, and inline comment formatting.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `profile` | `enum` | `'balanced'` | Review stance: `'chill'` (relaxed, non-blocking), `'balanced'` (standard), `'assertive'` (strict enforcement). |
| `reviewer_effort` | `enum` | `'medium'` | Effort level: `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`. Maps to model reasoning depth and latency budgets. |
| `confidence_threshold` | `number` | `70` | Numeric finding cutoff filter (0-100). Findings below threshold are suppressed. |
| `mascot` | `boolean` | `true` | Toggles ASCII art mascot in PR comments (`PUBLISHER_MASCOT`). |
| `ticket_enforcement` | `boolean` | `false` | Mandates valid Linear, Jira, or GitHub issue ticket references in PR titles/descriptions. |
| `request_changes_workflow` | `boolean` | `true` | Enables `REQUEST_CHANGES` review verdicts when P0/P1 findings occur. |
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
  request_changes_workflow: true
  high_level_summary: true
  sequence_diagrams: true
  path_instructions:
    - path: "src/auth/**"
      instructions: "Enforce strict fail-closed authorization checks and audit log emissions."
```

---

### 2. `chat`
Governs interactive `@ct-review` PR comment responses and context turn memory.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `auto_reply` | `boolean` | `true` | Enables automated responses to `@ct-review` mentions and inline thread replies. |
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
Configures persistent codebase learnings, vector indexing, and custom repository rules.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `learnings` | `boolean` | `true` | Enables Persistent PR Memory (`.ct-memory/`) for past PR learnings and nit suppression. |
| `issues` | `boolean` | `true` | Indexes repository issues for cross-reference context. |
| `pull_requests` | `boolean` | `true` | Indexes merged pull request history. |
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
Rules governing when `ct-review-bot` automatically triggers PR reviews.

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
| `memory_engine` | `boolean` | `true` | Master switch for `.ct-memory/` Graph Learning Engine and nit suppression. |
| `memory_provider` | `enum` | `'auto'` | Memory backend adapter: `'sqlite'`, `'honcho'`, `'composite'`, `'postgres'`, `'auto'`. |
| `mascot` | `boolean` | `true` | Master toggle for ASCII mascot output across reviews and chats. |
| `confidence_threshold` | `number` | `70` | Global finding confidence cutoff rating (0-100). |
| `ticket_enforcement` | `boolean` | `false` | Master toggle for Linear / Jira / GitHub ticket validation. |
| `persona_model` | `string` | `undefined` | Overrides model across all persona lanes. |

```yaml
dials:
  memory_engine: true
  memory_provider: "composite"
  mascot: true
  confidence_threshold: 80
  ticket_enforcement: true
  persona_model: "claude-5-sonnet"
```

---

<a id="optional-service-clean-key-toggles"></a>

## 🎛️ Optional-service clean key toggles

`ct-review-bot` supports direct, clean configuration toggles that map cleanly into the underlying engine:

- **`memory_engine`** (`boolean`): Enables/disables `.ct-memory/` SQLite learning graph and duplicate nit suppression.
- **`memory_provider`** (`enum`): Memory backend adapter (`'sqlite'`, `'honcho'`, `'composite'`, `'postgres'`, `'auto'`). Automatically routes to composite synchronization when `HONCHO_API_KEY` is present.
- **`mascot`** (`boolean`): Controls whether ASCII art mascot headers are rendered in comments.
- **`persona_model`** (`string`): OpenRouter model identifier used by the
  persona in the optional service. A direct standalone Action uses the explicit
  `deepseek/deepseek-v4-flash-0731` route (with the configured GLM, Ollama, and Synthetic
  fallbacks) or another policy-allowed model. Managed fleet provider selection belongs to its
  central control plane.
- **`confidence_threshold`** (`number`): Integer threshold from `0` to `100`.
- **`ticket_enforcement`** (`boolean`): Enforces ticket links across Linear (`PROJ-123`), Jira (`KEY-456`), or GitHub (`#789`).
- **`reviewer_effort`** (`enum`): Controls latency and reasoning depth (`low`, `medium`, `high`, `xhigh`, `max`).

---

## 👥 Multi-LLM Personas & Provider Schema

### Persona Definition (`personas`)

A `personas:` list in `.ct-review.yaml` selects which reviewers run, and may define new ones.
When the key is absent, the five default-enabled personas run; `personas: all` opts into every
built-in persona.

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
| `id` | no | Persona identifier (auto-derived from `name` or `uses` if omitted). |
| `name` | no | Display name in the review comment. |
| `uses` | no | Reference to an external, community, or local charter (e.g. `review-yeti/personas/django-security@v1`). |
| `charter` | for custom inline personas | Instructions used as the reviewer's system prompt (not required when `uses` is specified). |
| `enabled` | no | Set `false` to exclude. Defaults to `true`. |
| `required` | no | Whether finding consensus requires this persona. Defaults to `false`. |
| `paths` | no | Array of path globs this persona evaluates (e.g. `["src/api/**"]`). Defaults to `["**"]`. |
| `providers` | no | Provider IDs allocated to this persona. Defaults to `["openrouter"]`. |
| `model` | no | Per-persona model override. Defaults to the workflow's model. |
| `effort` | no | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). |
| `maxTurns` | no | Maximum conversational turns (1-20). |

### External & Community Charters (`uses:`)

Review Yeti supports loading persona charters from external repositories, local folders, or bundled community charters:

```yaml
personas:
  # 1. Bundled community persona (from domains/personas/ or examples/personas/)
  - name: "🏢 Multi-Tenant Isolation"
    uses: tenancy

  # 2. Local relative file
  - name: "🗄️ SQL Migration Safety"
    uses: ./charters/sql-migrations.md

  # 3. Remote GitHub repository reference with semantic version tag
  - name: "🔒 Django Security Specialist"
    uses: review-yeti/personas/django-security@v1
```

#### 3-Tier Resolution Precedence
1. **Bundled**: Looks up pre-compiled personas in `domains/personas/` and `examples/personas/`.
2. **Local**: Relative paths starting with `./` or `../` resolved against repository root.
3. **Remote**: Formatted as `owner/repo/path@ref`, fetched via HTTPS, validated, and cached in `.ct-memory/cache/personas/`.

👉 **See the [Team Memory Guide](TEAM_MEMORY.md) for full details on community charters and caching.**

### Persona Files & Frontmatter (`.ct-review/personas/*.md`)

A charter long enough to be useful is awkward as a YAML string. Each reviewer may instead live
in its own markdown file, where YAML frontmatter carries the metadata and the body is
the charter:

```markdown
<!-- .ct-review/personas/tenancy.md -->
---
name: "🏢 Multi-Tenant Isolation Guardian"
id: tenancy
model: openrouter/deepseek/deepseek-v4-flash-0731
enabled: true
reasoning_effort: high
paths:
  - "src/api/**"
  - "src/db/**"
providers:
  - openrouter
---

Every query that touches customer data must be scoped by `orgId`.

## What to flag
- Repository methods accepting a raw `id` without a tenant bound

## What not to flag
- Admin-only endpoints under `src/admin/**`, which are intentionally cross-tenant
```

| Frontmatter key | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Display name in PR review comments. |
| `id` | `string` | Optional unique identifier; defaults to the filename without `.md`. |
| `model` | `string` | Model identifier override (e.g. `openrouter/deepseek/deepseek-v4-flash-0731`). |
| `enabled` | `boolean` | Set `false` to keep the file without running the reviewer. |
| `reasoning_effort` / `effort` | `enum` | Reasoning depth (`low`, `medium`, `high`, `xhigh`, `max`). |
| `paths` | `string[]` | Path globs scoped for evaluation (e.g. `["src/**", "!src/vendor/**"]`). |
| `providers` | `string[]` | Ordered provider IDs. |
| `maxTurns` | `number` | Multi-turn ceiling (1-20). |
| `description` | `string` | Short description of reviewer mission. |

Rules:
- **Frontmatter is optional.** A file containing only prose is a valid persona; its id comes from the filename.
- **Files extend the default roster.** Adding one persona file does not switch the default built-ins off.
- **A file may override a built-in** by using its id; the body replaces that reviewer's charter.
- **Declaring one id in two places is an error.** A file and an inline `personas:` entry with the same id fails the run rather than silently picking a winner.
- **An empty body is an error**, as is malformed frontmatter. Both fail the run rather than dropping the reviewer silently.

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

`ct-review-bot` provides native compatibility with `.coderabbit.yaml` configuration files. When `.coderabbit.yaml` is detected, the internal parser invokes `translateCodeRabbitToV3()`, which maps CodeRabbit structures directly into `ct-review-bot` V3 schemas.

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
export function translateCodeRabbitToV3(raw: any): CtReviewConfigV3 {
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

### Native `.ct-review.yaml` (V3)

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
  request_changes_workflow: true
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
    - "ADR-001: All external network calls must use Doppler secret routing."

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
# Drop-in CodeRabbit configuration automatically translated by ct-review-bot
language: "en-US"
tone_instructions: "Be concise, analytical, and actionable."

reviews:
  profile: "balanced"
  request_changes_workflow: true
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

---

<a id="hierarchical-configuration-passthrough--extensibility"></a>

## 10. Hierarchical Configuration Passthrough & Extensibility

Review Yeti supports transparent passthrough of extended enterprise configuration elements. All nested configuration sections (`personaSchema`, `reviewsSchema`, `chatSchema`, `knowledgeBaseSchema`, `autoReviewSchema`, `enforcementPolicySchema`, and `dialsSchema`) use Zod `.passthrough()`, ensuring that specialized fields, tool definitions, and custom dials pass through schema normalization without truncation.

### Extended Configuration Keys

The following top-level configuration keys can be declared in `.ct-review.yaml`, injected via central organization policies (such as `policy/review-yeti.json` in `exampleorg/example-review-actions`), or passed as Action inputs:

| Key | Action Input Equivalent | Type | Description |
|---|---|---|---|
| `skills` | `skills` | `array` \| `string` \| `object` | Passthrough skill configurations, tools, and capability definitions available to persona agents. |
| `knowledge` | `knowledge` | `array` \| `string` \| `object` | Knowledge base paths, documents, and reference mappings for domain-specific review context. |
| `metrics` / `telemetry` | `metrics` | `object` \| `string` | Observability configurations, metric prefixes, cumulative temporality (`cumulative`), and exporter settings. |
| `event_plane` | `event-plane` | `object` \| `string` | Private NATS JetStream event plane settings, stream names (`CT_REVIEW_EVENTS`, `CT_REVIEW_PROGRESS`), and outbox options. |
| `storage` | `storage` | `object` \| `string` | Worker pod storage profile (e.g., `type: emptyDir`, `size_limit: 1Gi` for 0 PVC delay). |
| `retry_analysis` / `retro_analysis` | `retry-analysis` | `object` \| `string` | Error categorization rules, transient vs deterministic failure classification, and retro feedback hooks. |
| *(N/A)* | `policy-json` | `string` (JSON) | Raw policy overrides passed directly to the DOKS admission dispatcher. |

### Resolution Hierarchy

Configuration values are resolved hierarchically from most-specific to broadest default:

1. **GitHub Action Inputs / Workflow Dispatch**: Explicit inputs provided in caller workflow files (`with: skills: ...`, `with: metrics: ...`).
2. **Repository-Level Config**: `.ct-review.yaml` (or `.coderabbit.yaml`) at the immutable PR base SHA.
3. **Organization Default Repository**: `.github/.ct-review.yaml` in the organization's `.github` repository.
4. **Central Organization Policy**: Central policy definitions (`policy/review-yeti.json` hosted in `exampleorg/example-review-actions`).
5. **System Defaults**: Built-in V4 defaults (`createDefaultV4Config()`).

### Example: Passthrough Configuration

```yaml
# .ct-review.yaml with passthrough extensions
version: 3
profile: "assertive"

skills:
  - name: "telemetry-auditor"
    path: "plugins/ct-workflow/skills/telemetry"
  - name: "elixir-best-practices"
    path: "plugins/ct-elixir/skills/elixir-quality"

knowledge:
  sources:
    - "knowledge/review-learnings/*.md"
    - "docs/architecture/*.md"

metrics:
  exporter: "opentelemetry"
  endpoint: "http://otel-collector.observability:4318/v1/metrics"
  service_name: "review-yeti-ci"
  aggregation_temporality: "cumulative"    # REL-817: ensures monotonic counters across scrapes

event_plane:
  enabled: true
  schema: "review-yeti-event.v1"
  stream_prefix: "CT_REVIEW"
  outbox:
    enabled: true
    table: "review_yeti_events_outbox"
    poll_interval_ms: 1000

storage:
  type: "emptyDir"
  size_limit: "1Gi"                       # High-speed ephemeral storage, 0 PVC delay

retry_analysis:
  transient_error_codes: [429, 502, 503, 504]
  max_transient_retries: 3
  fail_closed_on_schema_error: true
```
