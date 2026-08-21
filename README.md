# 🤖 ct-review-bot

[![Review Bot](https://github.com/JBJMLLC/ct-review-bot/actions/workflows/review-bot.yaml/badge.svg)](https://github.com/JBJMLLC/ct-review-bot/actions/workflows/review-bot.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A GitHub Action that reviews your pull requests with a panel of AI reviewers and posts one
consolidated comment.**

Each reviewer is a persona with a narrow charter — security, performance, testing and so on —
and you can write your own in markdown. Install it with ten lines of YAML. There is no app to
install, no webhook to configure, and nothing to host.

---

## Install

Add one file to any repository you want reviewed:

```yaml
# .github/workflows/review.yml
name: Review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: JBJMLLC/ct-review-bot@v1
        with:
          llm-base-url: https://openrouter.ai/api/v1
          model: openrouter/auto-beta
          llm-api-key: ${{ secrets.OPENROUTER_PR_REVIEW_API_KEY }}
```

That is the whole setup — note there is no `actions/checkout` step, and none is needed. The
action reads the pull request diff, runs the reviewers in parallel, and comments on the PR using
your workflow's built-in `GITHUB_TOKEN`; no personal access token required.

You supply a model-provider API key and may override the compatible base URL. **You own the key
and the prompts**; prompts are sent to the endpoint you configure. The default endpoint is OpenRouter.

> **No key yet?** The action fails closed without posting a successful verdict. It never presents
> static pattern checks as a model review.

---

## What you get

A single comment on the pull request, in this shape:

> ## 🟡 **Verdict: FIX_FIRST**
>
> ### 📊 AI Review Panel Summary
> - **Repository**: `acme/checkout`
> - **Commit SHA**: `a1b2c3d`
> - **Review Mode**: Model-backed (`openrouter/auto`)
> - **Parallel Personas Evaluated**: `5/5`
> - **Quorum Status**: `SATISFIED`
> - **Total Findings**: P0: `0` | P1: `1` | P2: `2`
> - **Rationale**: Changes requested for 1 P1 finding(s) and 2 P2 nit(s).
>
> ### 📋 Persona Evaluation Roster
> | Reviewer Persona | Model | Decision | Findings |
> |---|---|---|---|
> | 🛡️ Security & Tenancy Guardian | `openrouter/auto` | ⚠️ FINDINGS | 1 |
> | ⚡ Performance & Scalability Specialist | `openrouter/auto` | ✅ APPROVE | 0 |
> | 🏛️ System Architecture & Design | `openrouter/auto` | ⚠️ FINDINGS | 2 |
> | 🧪 Testing & Quality Assurance | `openrouter/auto` | ✅ APPROVE | 0 |
> | 📦 Dependency Safety & Supply Chain | `openrouter/auto` | ✅ APPROVE | 0 |
>
> **🛡️ Security & Tenancy Guardian (1 finding)**
>
> | Severity | Path | Line | Title | Suggestion |
> |---|---|---|---|---|
> | 🟠 P1 | `src/api/orders.ts` | 42 | **Order lookup not scoped to tenant** | Add `orgId` to the where clause. |

Plus a mermaid diagram of the panel, and the findings for each reviewer in a collapsible section.

Findings that name a file outside the diff are discarded before posting, so the bot cannot
comment on code that isn't there.

---

## Where reviewer configuration is read from

Reviewer charters are prompts executed with **your** API key, so the action deliberately does
**not** read them from the pull request under review. `.ct-review.yaml` and
`.ct-review/personas/` are fetched over the API from the pull request's **base** branch — code
that is already merged and reviewed.

Without this, a pull request could add its own persona files, rewrite the instructions of the
reviewer examining it, and declare as many reviewers as it liked against your account. Point
`config-ref` at a different ref to override, and `max-personas` bounds how large a roster may
grow regardless.

A consequence worth knowing: **changes to reviewer configuration take effect once merged**, not
on the pull request that proposes them.

### What is sent to your model provider

The pull request diff is sent to whichever endpoint you configure. The default `openrouter/auto`
lets OpenRouter select a provider, which means you cannot state in advance which vendor received
your code or what their retention policy is. If that matters — proprietary code, regulated data,
a customer commitment — pin an explicit model and provider:

```yaml
        with:
          model: anthropic/claude-sonnet-4
          llm-base-url: https://api.anthropic.com/v1
          llm-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Why this rather than a hosted review service

- **You own the prompts.** Reviewer charters are markdown files in your repository. When the bot
  says something unhelpful, you edit the file that caused it.
- **You own the key.** Bring any OpenAI-compatible provider. Your code and diffs go to the
  provider you chose, not to an intermediary.
- **It is a GitHub Action.** No app installation, no webhook endpoint, no server, no database.
- **Cost is bounded and visible.** One request per reviewer per push, with a per-reviewer diff
  budget you set.

It is deliberately simpler than a full review platform: no cross-PR memory, no codebase-wide
semantic index, no chat. If you need those, a hosted service will serve you better.

---

## What it costs

One request per enabled reviewer, per push. The default roster is five reviewers, and each
receives at most `max-diff-chars` of diff (24,000 characters by default), so a large pull request
does not turn into a large bill. Lower the budget, or narrow the roster, to spend less:

```yaml
        with:
          personas: security,testing
          max-diff-chars: '8000'
```

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

Drop a `.ct-review.yaml` in the repository being reviewed to pick which personas run — and to
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
markdown file under `.ct-review/personas/` instead — optional frontmatter for the metadata, and
the body is the charter:

```markdown
<!-- .ct-review/personas/tenancy.md -->
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
`.ct-review.yaml` or in the action's `personas:` input. Declaring the same id in both a file and
`.ct-review.yaml` is an error rather than a guess about precedence.

See the [Configuration Reference](docs/CONFIGURATION_REFERENCE.md#persona-definition-personas)
for the full key list.

### Central review repository (dispatch mode)

Alternatively, keep personas, prompts and keys in one repository and have others dispatch
into it. The receiving workflow lives at `.github/workflows/review-bot.yaml` and
accepts a `repository_dispatch` with a `client_payload` of `{ target_repo, pr_number }`.

This mode needs two tokens — one in the calling repository allowed to dispatch here, and a
`REVIEW_BOT_TOKEN` here allowed to read and comment on the calling repository — because the
default `GITHUB_TOKEN` is scoped to a single repository. Prefer the action above unless you
specifically need centralized keys and session data.

---

### Repository configuration (`.ct-review.yaml`)

The action reads one key from `.ct-review.yaml`: `personas`. Everything else that influences a
review is an action input.

```yaml
# .ct-review.yaml — in the repository being reviewed
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

Longer charters belong in their own files under `.ct-review/personas/`, described above. See the
[Configuration Reference](docs/CONFIGURATION_REFERENCE.md) for every key.

> Earlier versions of this file documented `profile`, `quorum`, `mascot`, `dials`, `reviews`,
> `chat`, `knowledge_base` and `auto_review` keys. Those belong to the self-hosted service below;
> the action ignores them.

---

## Managed OpenRouter deployment

For the Terraform/OpenTofu workspace, guardrail, and bounded completion-key
template, see [Managed OpenRouter deployment](docs/OPENROUTER_TERRAFORM.md).
The canonical fleet policy lives in the ct-meta OpenRouter skill; this repo
does not apply infrastructure or store provider credentials.

---

## 💻 Running Locally via CLI

You can run Review Yeti locally directly from your terminal to inspect diffs, test custom personas, or benchmark models without creating a GitHub Actions run.

### 1. Run Review Pipeline on a Local Unified Diff

Pass your OpenRouter API key and target diff file to run the full parallel persona panel and binding arbitration locally:

```bash
# 1. Export your OpenRouter API key
export OPENROUTER_API_KEY="sk-or-v1-..."

# 2. (Optional) Set model or base URL override
export OPENROUTER_MODEL="google/gemini-3.7-flash:high"   # or deepseek/deepseek-v4-flash-0731:high
export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"

# 3. Run review against a diff file
PR_DIFF_FILE="path/to/my_change.diff" \
PR_NUMBER=123 \
GITHUB_REPOSITORY="calltelemetry/ct-meta" \
PR_HEAD_SHA="$(git rev-parse HEAD)" \
PR_BASE_SHA="$(git rev-parse origin/main)" \
node .github/workflows/pipelines/review-pipeline.js
```

### 2. Review Uncommitted Git Changes in Current Repo

You can review changes in your current working branch directly against `main`:

```bash
# Generate diff of uncommitted/local branch changes
git diff origin/main...HEAD > /tmp/current_changes.diff

# Execute local Review Yeti review
PR_DIFF_FILE=/tmp/current_changes.diff \
PR_NUMBER=1 \
GITHUB_REPOSITORY="JBJMLLC/ct-review-bot" \
PR_HEAD_SHA="$(git rev-parse HEAD)" \
PR_BASE_SHA="$(git rev-parse origin/main)" \
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
node .github/workflows/pipelines/review-pipeline.js
```

### 3. Run Live PR Review via GitHub CLI (`runLiveReview.ts`)

Review any live GitHub pull request directly using `gh` CLI credentials:

```bash
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
npx ts-node src/cli/runLiveReview.ts --pr=2119 --repo=calltelemetry/ct-meta
```

### 4. Run the 190-Scenario Release Benchmark Harness

Execute the complete 190-scenario benchmark evaluation suite across all 4 production models:

```bash
# Offline cassette replay (zero network required, deterministic)
node scripts/evaluate-release-benchmark.mjs --offline

# Live evaluation across OpenRouter
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" node scripts/evaluate-release-benchmark.mjs --live

# Generate Pareto Frontier SVG charts (Accuracy vs. Cost)
node scripts/generate-benchmark-charts.mjs
```

### 5. Reviewed SemVer releases

Merges to `main` are evaluated by Release Please using Conventional Commits. It
opens a release PR instead of publishing directly from an ordinary merge:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer produces a major release.
- `docs:`, `chore:`, `test:`, and `ci:` do not create a release.

The release PR must pass the normal branch-protection and Review Yeti gates. When
it is merged, Release Please creates an immutable `vMAJOR.MINOR.PATCH` tag. The
single canonical tag workflow then runs the full test and benchmark gates and
publishes the GitHub release assets. Only after that workflow succeeds is the
matching tested commit promoted to the rolling `v1` tag. The `v1` tag is never
advanced by an ordinary `main` merge.

This repository's organization policy disables pull-request creation by the
built-in `GITHUB_TOKEN`. The release workflow therefore uses the encrypted
`RELEASE_PLEASE_TOKEN` repository secret (with `GITHUB_TOKEN` as a fallback for
repositories where the organization permits workflow-created pull requests).

---

## Optional: self-hosted dashboard service

> **Not required to review pull requests.** The GitHub Action above needs none of this. The
> repository also contains a separate long-running service (`npm start`) providing a web
> dashboard, an AST code indexer and persistent review memory. It is independent of the Action
> and is not covered by the install instructions above.

Its REST endpoints:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/auth/login` | `POST` | Dashboard login endpoint returning user session tokens |
| `/api/auth/session` | `GET` / `DELETE` | Validate or invalidate active session tokens |
| `/api/auth/apikeys` | `GET` / `POST` / `DELETE` | Manage SHA-256 hashed API keys |
| `/api/dashboard/overview` | `GET` | Aggregate overview metrics, token spend, provider health, memory stats |
| `/api/dashboard/repositories` | `GET` / `PATCH` | Manage repository review automation status and custom profiles |
| `/api/dashboard/settings` | `GET` / `PUT` | Configure global model overrides, memory thresholds, and financial cost caps |
| `/api/dashboard/logs` | `GET` | Retrieve real-time PR review activity logs |
| `/api/memory/query` | `POST` | Query persistent PR review memory & resolved nit patterns |
| `/api/memory/record` | `POST` | Record review outcomes and ADR learnings into `.ct-memory/` |
| `/api/code/symbol-graph` | `GET` / `POST` | Retrieve AST symbol call graphs, definitions, and references |
| `/api/code/search` | `POST` | Semantic vector & keyword code search across indexed repositories |
| `/api/router/providers` | `POST` | Dynamically register new LLM models at runtime without redeployment |

---

## Documentation

### Trusted Pi workflow runtime

The optional `review-engine: pi-workflow` path installs the pinned Pi runtime from the small
`pi-runtime/package-lock.json` manifest into an empty bounded prefix. It requires caller-provisioned Node 24, an exact
`action-sha`, lifecycle scripts disabled during install, and source-bound build provenance before
the wrapper is imported. `legacy` remains the default rollback path.

- **[Running Locally via CLI](docs/RUNNING_LOCALLY.md)** — how to run Review Yeti, live PR reviews, and evaluation benchmarks locally.
- **[Configuration Reference](docs/CONFIGURATION_REFERENCE.md)** — full `.ct-review.yaml` and
  persona-file schema.
- **[Architecture](docs/ARCHITECTURE.md)** — how the review pipeline is put together.

---

## 📄 License
Distributed under the MIT License. See `LICENSE` for details.
