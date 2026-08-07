<p align="center">
  <img src="assets/review-yeti-panel.png" alt="Review Yeti and five reviewers checking green checklists on a snowy mountain" width="720">
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

<p align="center">Review Yeti runs specialist AI reviewers in parallel, reconciles their findings, and posts one actionable GitHub review.</p>

## Contents

- [Why Review Yeti](#why-review-yeti)
- [Get started](#get-started)
- [Meet the review panel](#meet-the-review-panel)
- [What happens on a run](#what-happens-on-a-run)
- [What gets published](#what-gets-published)
- [Trust and safety](#trust-and-safety)
- [Cost and coverage](#cost-and-coverage)
- [Configure the panel](#configure-the-panel)
- [Reference documentation](#reference-documentation)
- [Develop and contribute](#develop-and-contribute)
- [License](#license)

## Why Review Yeti

Review Yeti is a composite GitHub Action for teams that want useful AI review without handing their repository to a hosted review platform.

- **A panel, not a single opinion.** Focused personas cover different failure modes and stay in their lanes.
- **One useful review.** Findings are deduplicated, reconciled, and arbitrated into SHIP, FIX_FIRST, or BLOCK.
- **Your key and prompts.** You bring the OpenRouter-compatible API key and control the reviewer charters.
- **Nothing to host.** The action runs inside your workflow. There is no app installation, webhook service, database, or checkout step.
- **Evidence you can act on.** Findings point to exact changed lines, while incomplete coverage is reported instead of hidden.

## Get started

Add this workflow to the repository you want reviewed:

```yaml
# .github/workflows/review.yml
name: Review Yeti

on:
  pull_request:
    # A moved PR head or base branch does not start another model review by default.
    # Add synchronize only when that rerun policy is intentional.
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
          # Optional: enables Linear issue sync when the secret exists.
          linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

That is the complete setup. actions/checkout is not required: Review Yeti reads the exact pull request diff through the GitHub API and publishes with the workflow's built-in GITHUB_TOKEN. Add `synchronize` only as an explicit opt-in when you want a new model review after a push.

### Secrets and permissions

| Secret or permission | Why it is needed |
| --- | --- |
| OPENROUTER_API_KEY | Required inference key supplied by you. |
| LINEAR_API_KEY | Optional API-key-only Linear sync; OAuth Linear MCPs are rejected. |
| contents: read | Lets the action read the trusted repository configuration. |
| pull-requests: write | Lets the action publish the consolidated review and resolvable P0/P1 conversations. |

If the inference key is missing or the model panel cannot complete safely, the action fails closed rather than presenting static checks as a successful model review.

## Meet the review panel

The default panel has five specialist reviewers. The mascot mirrors the product: one bespectacled lead moderates the result while five reviewers check their own clipboard.

| Reviewer | Focus |
| --- | --- |
| 🛡️ **Security & Tenancy Guardian** | Credentials, injection, authorization, and tenant boundaries |
| ⚡ **Performance & Scalability Specialist** | N+1 work, unbounded complexity, and hot-path regressions |
| 🏛️ **System Architecture & Design** | Layering violations, duplicated business rules, and coupling |
| 🧪 **Testing & Quality Assurance** | Missing behavior coverage and tests that assert the wrong thing |
| 📦 **Dependency Safety & Supply Chain** | Floating versions, lockfile drift, and risky dependency changes |

Optional built-ins include style, documentation, accessibility, database, DevOps, internationalization, and licensing. You can also write a custom persona in .review-yeti.yaml or .review-yeti/personas/.

## What happens on a run

1. **Read trusted policy.** Reviewer charters and repository defaults come from the pull request's base ref, not from the pull request head.
2. **Fetch the exact diff.** The action binds the run to the pull request head SHA and builds a complete changed-file manifest.
3. **Plan coverage.** Generated files, binaries, and configured exclusions are classified before model input. Large eligible diffs are packed into bounded passes.
4. **Run the panel.** Enabled personas evaluate their lanes concurrently using the configured OpenRouter-compatible provider.
5. **Reconcile findings.** Duplicate claims are merged conservatively, findings are checked against changed lines, and a moderator pass produces one coherent summary.
6. **Arbitrate the result.** A binding arbiter determines the verdict and records persona coverage, provider provenance, token usage, and cost.
7. **Publish once.** The summary is updated in place, and high-severity findings become resolvable line conversations. Stale work cannot publish against a moved head.

## What gets published

The pull request receives one compact review summary:

> ## 🟡 Verdict: FIX_FIRST
>
> **Panel:** 5/5 personas completed · **Quorum:** satisfied
> **Findings:** P0 0 · P1 1 · P2 2
> **Mode:** model-backed (openrouter/auto-beta)
>
> **Security & Tenancy Guardian** · 1 finding
> **Performance & Scalability Specialist** · approve
> **System Architecture & Design** · 2 findings
> **Testing & Quality Assurance** · approve
> **Dependency Safety & Supply Chain** · approve

Every finding links to an exact changed line. P0/P1 findings are published as resolvable GitHub conversations; the rest remain grouped in the summary.

The action exposes machine-readable outputs for verdict, review status, coverage, gate decision, merge eligibility, finding counts, persona completion, reviewed/omitted files, passes, tokens, and provider cost. See the [full outputs reference](docs/CONFIGURATION_REFERENCE.md#action-terminal-outcomes-and-coverage-outputs).

+### Machine-readable outputs

The action exposes these terminal and coverage contracts for merge gates:

| Output | Description |
| --- | --- |
| `verdict` | SHIP, FIX_FIRST, BLOCK, or NO_VERDICT when the review cannot complete safely. Legacy NO_REVIEWABLE_FILES is no longer emitted for policy exclusions; migrate consumers to SHIP plus coverage outputs. |
| `review-status` | Terminal review status: SHIP, FIX_FIRST, BLOCK, PARTIAL_REVIEW, or INCOMPLETE_REVIEW. Expected policy exclusions do not create a coverage gap; partial and incomplete review statuses are never merge-eligible. |
| `coverage-status` | Coverage state: complete, partial, or incomplete. Partial and incomplete are never merge-eligible. |
| `gate-decision` | Derived gate decision: PASS only for a complete clean review; otherwise BLOCKED. |
| `merge-eligible` | Derived merge eligibility. True only for complete SHIP with a passing gate and no P0/P1 findings. |
| `files-skipped-generated` | Changed files skipped by the built-in generated-file catalog or configured repository path-policy/exclude globs. Intentional, and not a coverage gap. |
| `files-oversized` | Changed files whose complete per-file diff exceeded the configured limit. Excluded before model input and noted in the review comment; non-blocking by itself, while other coverage gaps can still produce INCOMPLETE_REVIEW. |

A publication can be durable even when the review outcome is partial or failed; `INCOMPLETE_REVIEW` and `BLOCKED` remain non-mergeable.

## Trust and safety

Review Yeti is deliberately opinionated about what it can trust:

- **Base-ref charters.** A pull request cannot rewrite the prompts reviewing it or add unlimited reviewers against your API key. Configuration changes take effect after they merge.
- **Exact-head publication.** Every read and write is tied to the reviewed commit SHA. If the head changes while a run is in flight, publication is refused as stale.
- **Fail-closed coverage.** Provider failures, missing required personas, incomplete coverage, and unsafe arbitration produce a blocked/incomplete status instead of a clean-looking approval.
- **Grounded findings.** Reviewers must name an exact changed file and line. Findings about paths outside the diff are discarded.
- **Provider transparency.** The review records the model and provider provenance. The default Auto Router can select a vendor; name an explicit model when retention or vendor identity matters.
- **Your data boundary.** The pull request diff is sent to the endpoint you configure. Review Yeti does not proxy it through a hosted review service.

Read the [architecture](docs/ARCHITECTURE.md) and [publication policy](docs/PUBLICATION_POLICY.md) for the detailed contracts.

## Cost and coverage

The default roster makes one model request per enabled persona per pass. The default full-request ceiling is 2,000,000 diff characters; the effective per-file ceiling defaults to 5,000 characters. max-passes is a ceiling, not a target.

Before model input:

- Generated files, lockfiles, snapshots, build output, binaries, source maps, and configured exclusions are reported as intentional policy skips.
- Oversized files are reported through files-oversized and excluded before model input; they do not create a coverage gap by themselves.
- Eligible files that do not fit the configured packing budget are reported through files-omitted and keep the review incomplete.

A clean SHIP means no blocking finding was established in the reviewable evidence. It does not claim an excluded or oversized file was reviewed. Use the outputs as merge gates when your repository requires complete coverage.

+### Per-file limits and path policy

The whole-request budget and complete per-file cap are separate. The effective per-file value follows this precedence:

1. `max-file-diff-chars` Action input
2. `limits.max_file_diff_chars` repository value from the trusted base ref
3. built-in default of **5,000**

The curated catalog skips lockfiles, snapshots, generated files, build output, dependency caches, minified assets, source maps, and binary files. Generated OpenAPI artifacts such as `openapi.generated.json` and `schema.generated.yaml` are included; an ordinary source `openapi.yaml` is not excluded.

Patterns without a slash are filename-only and match at any depth. A `!` restores a matching path after a positive rule. Restored files still obey the effective per-file limit or cap.

The older `NO_REVIEWABLE_FILES` status is no longer emitted for policy-only changes. Expected intentional skips and oversized files are non-blocking; omitted eligible files and provider failures make coverage incomplete.

Durable coverage is configured on the trusted base ref:

```yaml
coverage_policy:
  quorum: two_thirds
  min_personas: 3
  mandatory_personas: [security]
  provider_diversity_min: 2
```

A complete clean panel can be `SHIP`; a quorum-met but incomplete panel is `PARTIAL_REVIEW`; a below-quorum or safety-floor failure is `INCOMPLETE_REVIEW`. Both incomplete outcomes are `BLOCKED` and never merge-eligible.

## Configure the panel

Choose the built-in roster in the repository being reviewed:

```yaml
# .review-yeti.yaml
version: 4

personas:
  - id: security
  - id: testing
  - id: database
  - id: tenancy
    name: "🏢 Multi-Tenant Isolation"
    charter: |
      Every query touching customer data must be scoped by orgId.
      Flag repository methods accepting a raw id without a tenant bound.
```

For longer prompts, add one Markdown charter per reviewer:

```markdown
<!-- .review-yeti/personas/tenancy.md -->
---
name: "🏢 Multi-Tenant Isolation"
---

Every query touching customer data must be scoped by orgId.

## What to flag
- Repository methods accepting a raw id without a tenant bound
- Raw SQL missing a tenant predicate
```

The personas action input accepts comma-separated IDs, a JSON array, or all. Action inputs override repository defaults. See the [configuration reference](docs/CONFIGURATION_REFERENCE.md) for all inputs, outputs, path policies, quorum rules, and custom persona fields.

## Reference documentation

- [Architecture](docs/ARCHITECTURE.md) — run lifecycle, trust boundaries, and component responsibilities
- [Configuration reference](docs/CONFIGURATION_REFERENCE.md) — every input/output and .review-yeti.yaml key
- [OpenRouter settings](docs/OPENROUTER_SETTINGS.md) — model pinning, fallbacks, routing, and provider policy
- [Publication policy](docs/PUBLICATION_POLICY.md) — exact-head writes, idempotent comments, and stale-run handling
- [Adversarial review patterns](docs/ADVERSARIAL_REVIEW_PATTERNS.md) — why the panel stays in lane
- [Test infrastructure](TEST_INFRA.md) — offline cassettes and fail-closed replay

## Develop and contribute

```bash
npm ci
npm test
npm run lint
```

Tests run offline against recorded cassettes in tests/fixtures/cassettes/; unmatched replay requests fail rather than reaching the network. Contributions that improve persona precision, coverage evidence, documentation, and provider safety are welcome. Open an [issue](https://github.com/review-yeti-ai/review-yeti-bot/issues) for questions or a [pull request](https://github.com/review-yeti-ai/review-yeti-bot/pulls) for changes.

## License

MIT — see [LICENSE](LICENSE).
