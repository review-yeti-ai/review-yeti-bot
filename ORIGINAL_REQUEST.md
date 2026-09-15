# Original User Request

## Initial Request — 2026-09-14T15:08:44Z

Retire and delete the `miller` AST tool from Review Yeti, replacing its scoping responsibilities with a Zoekt-powered symbol/context pre-check and CodeRabbit-style deterministic static analyzers in the review sandbox. Ensure all pre-checks are configurable via `.ct-review.yaml` (optional, defaulting to enabled).

Working directory: `/Users/jasonbarbee/work/review-yeti-bot`
Integrity mode: development

## Requirements

### R1. Retire and Remove the Miller Tool
- Completely delete `src/services/millerTool.ts` and its associated unit test `tests/unit/millerTool.test.ts`.
- Remove all invocations, tool declarations, imports, and references to `miller` from `src/panel/panelEngine.ts`, `tests/unit/r2EmpiricalChallenger.test.ts`, and evaluation baselines/ablation scripts.
- Ensure the agentic persona tool registry no longer advertises or executes `miller`.

### R2. Zoekt-Driven Symbol & Context Pre-Check
- Leverage the existing `zoektSearchTool` / `zoektIndexBuilder` to perform deterministic pre-check symbol discovery on modified diff hunks.
- For changed files and symbols in a PR diff, query the Zoekt index for symbol definitions, call sites, and surrounding context.
- Provide this discovered symbol context as structured pre-check evidence to the reviewer personas prior to their evaluation turns, eliminating blind diff gaps without custom AST slicing.

### R3. Deterministic Sandbox Static Analyzers (CodeRabbit Pattern)
- Implement a pre-check analysis runner in the review sandbox (`src/pi/piWorkspacePlugin.ts` or dedicated pre-check module).
- Execute standard static analyzers on modified PR files based on ecosystem:
  - **TypeScript/JavaScript**: `eslint`, `semgrep`
  - **Elixir**: `credo --strict`, `sobelow --dry-run`
  - **Go**: `govet`
  - **Secrets/Credentials**: `gitleaks detect --no-git`
- Format analyzer hits into structured **candidate hypotheses** (with path, line range, analyzer rule, and message) passed into the persona context so agentic reviewers can verify or refute them, preventing raw SAST false positives from being published directly.

### R4. Configuration Schema & Default-On Wiring
- Extend the Zod configuration schema in `src/config/schema.ts` and `.ct-review.yaml` loader to support pre-checks:
  ```yaml
  pre_checks:
    enabled: true        # default: true
    zoekt:
      enabled: true      # default: true
      max_symbols: 25
    analyzers:
      enabled: true      # default: true
      linters: true
      security: true
      secrets: true
  ```
- All pre-checks must be strictly optional from the repository config, but enabled (`true`) by default when omitted.
- Gracefully fail-soft if any analyzer binary or Zoekt index is unavailable (record receipt status without failing the overall review).

## Verification Resources & Test Harness
- `npm test tests/unit/panelEngine.test.ts`
- `npm test tests/unit/evidenceRegistryComposer.test.ts`
- `npm test tests/unit/r2EmpiricalChallenger.test.ts`
- `npm test tests/unit/schema.test.ts`
- `npm run build`
- Dedicated unit tests validating:
  1. Complete absence of `miller` tool in panel engine.
  2. Zoekt symbol pre-check ingestion.
  3. Sandbox analyzer hypothesis formatting and fail-soft behavior.
  4. Config schema validation for default-on and explicit override settings.

## Acceptance Criteria

### Miller Retirement
- [ ] `src/services/millerTool.ts` and `tests/unit/millerTool.test.ts` are completely deleted.
- [ ] No remaining references to `executeMillerTool` or the `miller` tool name exist in `src/panel/panelEngine.ts`.
- [ ] All existing test suites pass cleanly without `miller`.

### Zoekt Pre-Checks
- [ ] Zoekt symbol search executes as an automated pre-check against PR diff hunks.
- [ ] Discovered symbol definitions and callers are injected as structured pre-check evidence for reviewer personas.
- [ ] Fails soft to standard file search if Zoekt is disabled or unindexed.

### Sandbox Analyzers
- [ ] Static analyzer pre-check runner executes applicable linters/scanners for changed files in the sandbox.
- [ ] Analyzer outputs are formatted as candidate hypotheses for persona verification rather than direct comments.
- [ ] Analyzer execution handles missing binaries gracefully without crashing the review run.

### Configuration & GitOps
- [ ] Zod schema in `src/config/schema.ts` validates `pre_checks` configuration.
- [ ] Default configuration enables Zoekt and analyzer pre-checks when unconfigured in `.ct-review.yaml`.
- [ ] Explicitly setting `pre_checks.enabled: false` or individual flags bypasses the respective pre-checks cleanly.
- [ ] TypeScript builds with zero type errors (`npm run build`).
