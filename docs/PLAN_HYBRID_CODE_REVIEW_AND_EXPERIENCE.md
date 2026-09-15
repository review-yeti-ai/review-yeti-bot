# Architecture Plan & Strategic Specification: Review Yeti Hybrid Quality & Experience Engine (v2)

**Target Systems**: Review Yeti (`calltelemetry/review-yeti-bot`), DOKS Infrastructure (`calltelemetry/ct-infrastructure`), Bifrost Gateway (`llm-gateway-service`)  
**Benchmarks Evaluated**: Alibaba Open Code Review (`alibaba/open-code-review`), Qodo `pr-agent`, CodeRabbit Enterprise  
**Author**: Call Telemetry Engineering Architecture (Refined via Deep Static & Comparative Synthesis)  
**Status**: Authoritative Architectural Plan  

---

## 1. Ground Truth Baseline: What Review Yeti Actually Does Today

A rigorous audit of `review-yeti-bot` (~95k lines TypeScript, 522 test files) reveals that the system is already far more capable than a naive LLM diff wrapper:

| Capability | What the Code Actually Does Today | Relevant Source Reference |
|---|---|---|
| **Diff & Context Ingestion** | Zero raw diff inlining in prompt. Personas run an **agentic loop** with tools (`read_file`, `get_diff`, `search_code`, `zoekt`), capped at 10 turns. Lockfiles/generated assets stripped by `hunkFilter.ts`. | `src/panel/panelEngine.ts:953`, `src/pipeline/hunkFilter.ts:29` |
| **Line Mapping & Drift** | Emits `path`, `line`, `side`. Out-of-hunk lines are dropped or demoted to file-level. Posts are idempotent. **Zero relocation ladder exists**—minor line offsets cause silent finding loss. | `src/review/findingPublication.js:54`, `src/review/reviewCore.js:97` |
| **Developer Commands** | Extensive command dispatcher already exists (`review`, `explain`, `fix`, `refactor`, `ignore`, `mute`, `summarize`, `ask`, `learn`, `remember`, `forget`). Suggestion blocks supported. | `src/chat/commandDispatcher.ts:10`, `src/comments/commentPublisher.ts:136` |
| **Repository Admission** | `GITHUB_APP_WEBHOOK_OWNER_IDS` whitelist exists. The webhook allowlist is intentionally a strict subset of the Actions OIDC policy for security demarcation. Config file is `.ct-review.yaml`. | `src/auth/githubWebhookConfig.ts:20`, `src/config/configLoader.ts` |
| **Web Dashboard** | Full Next.js 14 web app (`src/app/`) with Overview, Repos, Settings, Onboarding, and Memory pages. The dispatch pod is an intentionally minimal, isolated webhook listener. | `src/app.ts:791`, `src/dispatchServer.ts` |
| **Domain Charters** | 15 built-in charters, Elixir ecosystem pack (`domains/ecosystems/elixir.json`), Elixir BEAM specialist in stack scanner, 8 Elixir/OTP evaluation scenarios. | `src/config/schema.ts:100`, `src/evaluation/scenarios.ts:1161` |
| **Enclosing Scope Slicer** | Retired in favor of Zoekt pre-check and sandbox static analyzers. | `src/services/zoektPreCheckService.ts` |

### The Real Architectural Problem
The primary problem is **not phantom comments** (the pipeline already suppresses out-of-hunk findings). The real problems are:
1. **Silent Finding Dropping**: When an agentic persona identifies a genuine bug but references an offset line, the lack of a relocation ladder silently drops or demotes the finding with zero recovery.
2. **Review Noise & Developer Fatigue**: Lack of strict per-profile comment caps, lack of confidence-based dual publishing (inline vs collapsed table), and re-posting unchanged findings across re-pushes.
3. **Unmeasured Quality Metrics**: Lack of instrumentation on address rate, relocation success/drop rates, and persona turn efficiency.
4. **Onboarding Friction & Dormant Portal**: Manual repository ID management, and the dashboard is not currently deployed as an authenticated service.

---

## 2. Comparative Benchmark Reality

### Alibaba `open-code-review` (`ocr`)
- **Origin & Architecture**: Go-based CLI released May 2026 (24.8k stars). 
- **Reality Check**: Does **not** contain Tree-sitter or AST parsing in its public repo. Its "built-in rules" are glob-matched prompt templates injected into the LLM context.
- **Transferable Principles**: Precision-first filtering (trading recall to guarantee high signal), file bundling into bounded sub-agent review units, and glob-scoped rule packs.

### Qodo `pr-agent`
- **Origin & Architecture**: Python-based multi-tool PR agent.
- **The Anchoring Gold Standard**: Requires the LLM to echo an `existing_code` snippet. Validates against the hunk, relocates with `difflib` at a `0.93` similarity cutoff, and extends context backward 10 lines to the hunk section header as a fast function boundary.
- **Noise Control**: Strict finding cap (3 per review), self-reflection scoring (0–10), and persistent in-place comment edits.

### CodeRabbit
- **Deterministic Pre-Processing**: Runs ~37 static analyzers (`semgrep`, `ast-grep`, `gitleaks`, `ruff`, `eslint`) in an isolated sandbox. Findings serve as **hypotheses** that an agentic persona must verify before posting.

---

## 3. Refined Architectural Specification

### Component 1: Anchoring v2 with the Relocation Ladder & Fingerprint Persistence

Instead of relying on fragile raw line numbers:
1. **Echoed Snippet Contract**:
   - Update the finding schema to require `existing_code: string` representing the 1–3 lines being commented on.
2. **Deterministic 4-Step Relocation Ladder**:
   - **Rung 1 (Exact Match)**: Search for `existing_code` within the modified file's changed RIGHT-side hunks.
   - **Rung 2 (Whitespace Normalized)**: Strip indentation and trailing whitespace.
   - **Rung 3 (Fuzzy Match)**: Levenshtein / sequence matcher with a `0.93` similarity threshold restricted to diff hunks.
   - **Rung 4 (AST Symbol Anchor via `ASTParser` / Zoekt)**: Match the enclosing AST node containing the snippet.
   - **Fallback**: Demote to top-level PR summary table only if all 4 rungs fail.
3. **Cross-Push Fingerprint Deduplication**:
   - Utilize `findingFingerprint.ts` to compute a structural hash: `hash(path, symbol_id, finding_type)`.
   - On GitHub `synchronize` events:
     - If the code at the anchored node was modified/fixed &rarr; **Auto-resolve the GitHub review thread**.
     - If unchanged &rarr; Do not re-post or spam the author.

---

### Component 2: Noise Fatigue Suppression & Tiered Dual-Publishing

1. **Concrete Profile Knobs**:
   Wire `.ct-review.yaml` profiles (`chill`, `balanced`, `assertive`) to explicit publishing thresholds:
   - **`chill`**: Max 3 inline findings per review. Only findings with `confidence >= 0.9` and severity `P0/P1` appear inline. All `P2/P3` collapsed.
   - **`balanced`** (default): Max 6 inline findings. `confidence >= 0.75`. `P2` collapsed into summary table.
   - **`assertive`**: Max 12 inline findings. `confidence >= 0.6`.
2. **Dual Publishing Format**:
   - **Inline Code Comments**: Reserved exclusively for high-confidence, actionable bugs with clear solutions.
   - **Collapsed Summary Overview**: Non-critical suggestions, architecture notes, and informational feedback rendered in a single collapsible `<details>` table in the main PR review body.
3. **Conversational UX & Native Suggestion Blocks**:
   - Support both `@review-yeti fix` and `@review-yeti /fix` syntax.
   - Single-file fixes emit GitHub native ````suggestion ```` blocks for one-click commit.
   - Multi-file fixes route through the existing approval-gated sandbox workflow (`piWorkspacePlugin.ts`).
   - Listen to GitHub `pull_request.ready_for_review` to automatically initiate reviews when drafts open.

---

### Component 3: Sandbox Static Analyzers as Persona Hypotheses

Rather than writing custom, unmaintained AST regexes:
1. **Leverage Sandbox Static Analysis Tools**:
   - In the worker sandbox (`piWorkspacePlugin.ts`), run established linters and analyzers on the PR diff:
     - **Elixir**: `credo --strict`, `sobelow --dry-run`
     - **TypeScript / JavaScript**: `eslint`, `semgrep`
     - **Go**: `govet`, `golangci-lint`
     - **Secrets**: `gitleaks detect --no-git`
2. **Hypothesis Verification Pattern**:
   - Static analysis output is passed to the persona as **hypotheses** (`"Sobelow reported potential SQL injection at line 42"`).
   - The LLM persona inspects the surrounding context to verify if it is an actual vulnerability or a false positive. Only verified, contextualized findings are published.

---

### Component 4: Zero-Touch Onboarding & Self-Serve Experience

1. **Safe Org-Level Auto-Admission**:
   - Avoid silent, unconfigured auto-admission of all repositories (which creates unbounded token expenditure across 10-turn personas).
   - Admit any repository under `GITHUB_APP_WEBHOOK_OWNER_IDS=57884877` (`calltelemetry`) that satisfies **either**:
     - Contains a `.ct-review.yaml` file in its base branch, OR
     - Has an explicit `review-yeti` / `ai-review` PR label applied.
2. **Turnkey Setup Bot (`@review-yeti init`)**:
   - Running `@review-yeti init` invokes `configGenerator.ts` and `stackScanner.ts`.
   - Scans the repo stack (e.g. Phoenix, TypeScript, Helm) and opens an onboarding PR adding a tuned `.ct-review.yaml`.
   - Security rule: Config only takes effect after merging into the base branch (preventing untrusted PR branches from overriding security policies).

---

### Component 5: Independent Portal Deployment & Honest ROI Telemetry

1. **Separate Dashboard Deployment on DOKS**:
   - Maintain strict boundary: Keep `ct-review-action-dispatch` minimal, stateless, and fail-closed for webhooks and Actions OIDC.
   - Deploy `src/app.ts` as a separate Kubernetes Deployment (`ct-review-dashboard`) in `ct-review-system`, sharing the ingress with path routing (`/dashboard`, `/repos`, `/settings`, `/onboarding`) protected by SSO.
2. **Honest Engineering Metrics (Replacing Counterfactual ROI)**:
   - **Address Rate**: Percentage of bot findings where the developer committed code to the referenced hunk or resolved the thread.
   - **Relocation Success Rate**: Percentage of findings rescued by the 4-rung relocation ladder vs dropped.
   - **Token & Turn Efficiency**: Average agentic turns and tokens consumed per persona, tracked via OpenTelemetry (`ct_review_tokens_total`).
   - **Cycle Time & Gating Impact**: Median time to first review and merge block resolutions.

---

## 4. Phased Implementation Roadmap

```
Week 1: Measurement Baseline & Ground Truth
├── Instrument anchoring drop/demote metrics & relocation counters
├── Record turns & tokens per persona from ct_review_tokens_total
├── Implement address rate metric (thread resolution via GraphQL + commit diffs)
└── Curate a benchmark evaluation set of 30-50 historical Call Telemetry PRs

Weeks 2–3: Anchoring v2 & Noise Fatigue Controls
├── Implement echoed snippet contract (`existing_code`) in finding schema
├── Deploy 4-rung relocation ladder (Exact -> Whitespace -> Fuzzy 0.93 -> AST Node)
├── Implement cross-push deduplication and auto-resolution via symbol fingerprints
├── Wire `chill`, `balanced`, and `assertive` profiles to strict inline finding caps
└── Support `ready_for_review` webhook and dual syntax (`@review-yeti /fix` & `fix`)

Weeks 3–4: Sandbox Analyzers & Hypothesis Verification
├── Run Credo, Sobelow, ESLint, and Gitleaks in sandbox plugin
├── Pipe analyzer outputs as candidate hypotheses for persona verification
├── Integrate Zoekt pre-check symbol queries for Elixir (handling def/defmodule call nodes)
└── Consolidate duplicate lockfile lists between hunkFilter and diffCompactor

Weeks 5–6: Zero-Touch Onboarding & Dedicated Portal Deployment
├── Ship `@review-yeti init` onboarding PR bot via stackScanner
├── Update webhook admission for label-based or config-based org auto-enrollment
├── Deploy `ct-review-dashboard` as a separate Deployment with SSO
└── Expose real-time Address Rate, Turn Efficiency, and Cost analytics
```
