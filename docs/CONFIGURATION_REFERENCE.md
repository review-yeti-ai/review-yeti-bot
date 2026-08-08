# ⚙️ review-yeti-bot — Configuration Reference

This reference guide provides a complete, 1:1 schema specification for `.review-yeti.yaml` and `.coderabbit.yaml` repository configuration files in **review-yeti-bot**.

---

## 📋 Table of Contents

1. [Configuration File Resolution](#configuration-file-resolution)
2. [Top-Level Schema Overview](#top-level-schema-overview)
3. [V4 Execution Policy](#v4-execution-policy)
4. [The 6 Standard Sections](#the-6-standard-sections)
   - [1. `reviews`](#1-reviews)
   - [2. `chat`](#2-chat)
   - [3. `knowledge_base`](#3-knowledge_base)
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

---

## 📐 Top-Level Schema Overview

A Version 3 configuration contains core policy settings along with six CodeRabbit-mirrored top-level sections:

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
```

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
| `files-skipped-generated` | Changed files skipped by the built-in generated-file catalog or configured repository path-policy/exclude globs. Intentional, and not a coverage gap. |
| `files-oversized` | Changed files whose complete per-file diff exceeded the configured limit. Excluded before model input and noted in the review comment; non-blocking by itself, while other coverage gaps can still produce INCOMPLETE_REVIEW. |

### `github_action.openrouter` (Action path)

OpenRouter **client** settings for the composite Action (read from the PR base ref only).

```yaml
github_action:
  openrouter:
    timeout_ms: 30000         # hard per-request timeout (default 30000 = 30s)
    stream: false             # SSE streaming (default false)
    fallback_models:
      - deepseek/deepseek-v4-flash-0731  # ordered fallback after transient primary failures
    # allowed_models: []
    # cost_quality_tradeoff: 5   # 0=cheapest … 10=highest quality
    # data_collection: deny
```

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeout_ms` | `number` | `30000` | Per-request hard timeout in milliseconds. Lanes that do not return in time fail as `timeout`. Action input `openrouter-timeout-ms` / env `OPENROUTER_TIMEOUT_MS` / var `OPENROUTER_TIMEOUT_MS` override YAML. Clamped to 500–600000. |
| `stream` | `boolean` | `false` | When true, use OpenRouter SSE streaming. Action input `openrouter-stream` / env `OPENROUTER_STREAM` / var `OPENROUTER_STREAM` override YAML. |
| `fallback_models` | `string[]` | `[]` | Ordered model ids used after the primary exhausts its transient-failure retries. Timeouts, network failures, 408, 429, and 5xx responses can move to the next model. Action input `openrouter-fallback-models` / env `OPENROUTER_FALLBACK_MODELS` overrides YAML. |
| `allowed_models` | `string[]` | — | Auto Router allowlist. |
| `cost_quality_tradeoff` | `number` | — | Auto Router cost/quality 0–10. |
| `data_collection` | `allow`\|`deny` | — | When `deny`, sends OpenRouter training opt-out header. |

**Precedence:** action input / env → `.review-yeti.yaml` → defaults (`timeout_ms=30000`, `stream=false`, `fallback_models=[]`).

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

The GitHub secret `CONTEXT7_API_KEY` is the hard gate. Without it, Context7 stays off regardless of YAML.

Gitlink changes are never treated as ordinary text files. `metadata_only` requires pinned old/new
commit IDs, while `recursive` records an incomplete review until a nested snapshot resolver is
available. An incomplete submodule review cannot produce `SHIP`. Trusted Action inputs may narrow
these settings, but immutable safety caps always win; the effective policy digest is part of the
run identity.

---

## 📦 The 6 Standard Sections

### 1. `reviews`
Controls automated code review behaviors, summaries, status publishing, and inline comment formatting.

GitHub PR conversation output is quiet by default: one stable final review summary
is updated across pushes, P0/P1 findings publish as resolvable review
conversations, and persona/model/P2 details are kept in the review summary.

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
Configures persistent codebase learnings, vector indexing, and custom repository rules.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `learnings` | `boolean` | `true` | Enables Persistent PR Memory (`.review-yeti-memory/`) for past PR learnings and nit suppression. |
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

### 3a. `memory.honcho`

Honcho is an optional advisory memory provider for repository-scoped pull-request review context.
The GitHub decision ledger remains authoritative for finding state, maintainer commands, and
arbitration. Honcho failures are fail-open and never block publication.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `false` | Enables the Honcho adapter. |
| `context` | `boolean` | `false` | Reads bounded Honcho context before reviewer fan-out. |
| `write` | `boolean` | `false` | Writes normalized review events after GitHub publication. |
| `timeout_ms` | `number` | `1500` | Request timeout, clamped to `250..5000`. |
| `max_context_chars` | `number` | `4000` | Prompt context cap, clamped to `1000..8000`. |

```yaml
memory:
  honcho:
    enabled: true
    context: true
    write: true
    timeout_ms: 1500
    max_context_chars: 4000
```

The Action inputs `honcho-enabled`, `honcho-context`, `honcho-write`,
`honcho-timeout-ms`, and `honcho-max-context-chars` override these trusted base-ref values when
non-empty. The adapter resolves `HONCHO_URL`, `HONCHO_API_KEY`, and `HONCHO_WORKSPACE_ID` through
the existing Doppler secret manager (environment, cache, CLI, then REST API). In the composite
Action, pass `doppler-token` (and optionally `doppler-project` / `doppler-config`) to resolve these
values through the Doppler REST API. `HONCHO_BASE_URL` and `HONCHO_WORKSPACE` are accepted aliases
for self-hosted Honcho configurations. Do not place credentials in repository configuration.

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
| `memory_engine` | `boolean` | `true` | Master switch for `.review-yeti-memory/` Graph Learning Engine and nit suppression. |
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

- **`memory_engine`** (`boolean`): Enables/disables `.review-yeti-memory/` SQLite learning graph and duplicate nit suppression.
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
