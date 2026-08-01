# ⚙️ ct-review-bot — Configuration Reference

This reference guide provides a complete, 1:1 schema specification for `.ct-review.yaml` and `.coderabbit.yaml` repository configuration files in **ct-review-bot**.

---

## 📋 Table of Contents

1. [Configuration File Resolution](#configuration-file-resolution)
2. [Top-Level Schema Overview](#top-level-schema-overview)
3. [The 6 Standard Sections](#the-6-standard-sections)
   - [1. `reviews`](#1-reviews)
   - [2. `chat`](#2-chat)
   - [3. `knowledge_base`](#3-knowledge_base)
   - [4. `path_filters`](#4-path_filters)
   - [5. `auto_review`](#5-auto_review)
   - [6. `dials`](#6-dials)
4. [Clean Key Toggles](#clean-key-toggles)
5. [Multi-LLM Personas & Provider Schema](#multi-llm-personas--provider-schema)
6. [CodeRabbit 1:1 Translation Mapping (`translateCodeRabbitToV3`)](#coderabbit-11-translation-mapping-translatecoderabbittov3)
7. [Full Configuration Examples](#full-configuration-examples)
   - [Native `.ct-review.yaml` (V3)](#native-ct-reviewyaml-v3)
   - [CodeRabbit-Compatible `.coderabbit.yaml`](#coderabbit-compatible-coderabbityaml)

---

## 🔍 Configuration File Resolution

When a GitHub Pull Request webhook is received, `ct-review-bot` checks the target repository for a configuration file in the following order of precedence:

1. `.ct-review.yaml` in PR target branch
2. `.ct-review.yml` in PR target branch
3. `ct-review.yaml` in PR target branch
4. `.coderabbit.yaml` in PR target branch
5. Organization-level `.github` repository (`.ct-review.yaml`, `.coderabbit.yaml`)
6. Built-in system default configuration (`createDefaultV3Config()`)

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

---

## 📦 The 6 Standard Sections

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

`ct-review-bot` supports direct, clean configuration toggles that map cleanly into the underlying engine:

- **`memory_engine`** (`boolean`): Enables/disables `.ct-memory/` SQLite learning graph and duplicate nit suppression.
- **`mascot`** (`boolean`): Controls whether ASCII art mascot headers are rendered in comments.
- **`persona_model`** (`string`): Supported flagship persona models:
  - `claude-5-sonnet` (Anthropic / OmniRoute)
  - `gpt-5.6-sol` (OpenAI / OmniRoute)
  - `deepseek-v4-pro` (DeepSeek / OmniRoute)
  - `glm-5.2` (Z-AI / OmniRoute)
  - V3 Provider models: `codex/gpt-5.6-sol-high`, `grok-cli/grok-4.5`, `agy/claude-opus-4-6-thinking`, `claude/claude-opus-4-8`.
- **`confidence_threshold`** (`number`): Integer threshold from `0` to `100`.
- **`ticket_enforcement`** (`boolean`): Enforces ticket links across Linear (`PROJ-123`), Jira (`KEY-456`), or GitHub (`#789`).
- **`reviewer_effort`** (`enum`): Controls latency and reasoning depth (`low`, `medium`, `high`, `xhigh`, `max`).

---

## 👥 Multi-LLM Personas & Provider Schema

### Persona Definition (`personas`)

A `personas:` list in `.ct-review.yaml` selects which reviewers run, and may define new ones.
When the key is absent, every built-in persona runs.

**Built-in ids** — `security`, `performance`, `architecture`, `style`, `testing`,
`documentation`, `accessibility`, `database`, `devops`, `i18n`, `dependencies`, `licensing`.

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

### Persona Files (`.ct-review/personas/*.md`)

A charter long enough to be useful is awkward as a YAML string. Each reviewer may instead live
in its own markdown file, where optional YAML frontmatter carries the metadata and the body is
the charter:

```markdown
<!-- .ct-review/personas/tenancy.md -->
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
