# Original User Request

> [!WARNING]
> **Historical request record; non-authoritative.** This preserves the original requested scope and
> model assumptions; it is not current runtime, release, or fleet policy. See
> [Documentation authority](docs/DOCUMENTATION_AUTHORITY.md).

## Initial Request — 2026-08-20T15:39:04-05:00

Expand the Review Yeti evaluation benchmark suite by 50% (from 62 to 93+ scenarios) with exceptionally challenging, multi-file, multi-turn, and adversarial review scenarios (distributed race conditions, second-order injections, complex OTP/Go concurrency hazards, and AST evasions). Update release automation to automatically run benchmarks and publish both an embedded evaluation summary table and downloadable asset links in the GitHub release digest.

Working directory: `/Users/jasonbarbee/termic/tasks/ai-workspace/ct-review-bot`
Agent metadata directory: `/Users/jasonbarbee/termic/tasks/ai-workspace/ct-review-bot/.agents/orchestrator`

## Key Objectives & Requirements
1. Author 31+ hard & challenging review scenarios (reaching 93+ total) in `src/evaluation/scenarios.ts` with matching unified diff fixtures in `tests/fixtures/scenarios/`. Target:
   - Distributed Concurrency & Memory Leaks (distributed lock TTL race, Go time.NewTicker background leaks, ETS concurrency table race conditions, slice memory aliasing corruption)
   - Subtle Security & Logic Bypasses (second-order JSONB SQL injection, Unicode normalization bypass on tenant IDs, TOCTOU file permission vulnerabilities, ReDoS in authorization regex filters)
   - Multi-Turn Evidence Chaining (multi-file refactors requiring 3+ turn tool investigations: file_read -> file_find -> code_search to uncover hidden architectural coupling)
   - Adversarial Injections & Stealth Defect Cloaking (malicious comment payloads in diffs attempting reviewer instruction hijacking)
2. Automated Release Digest Benchmark Publishing:
   - Update `.github/workflows/release.yml` and release automation scripts to automatically execute `scripts/evaluate-release-benchmark.mjs` during the release workflow.
   - Generate versioned benchmark baseline artifacts (`eval-baselines/model-benchmark-matrix-${VERSION}.md` and `.json`).
   - Automatically attach both the `.json` and `.md` benchmark reports as downloadable assets on the GitHub release (`gh release upload`).
   - Append an embedded summary benchmark table to the GitHub release description/notes (`gh release edit --notes`) with direct links to the generated artifacts.
3. Quality Gate & Benchmark Suite Validation:
   - Ensure all 93+ scenarios execute deterministically in offline cassette replay and live OpenRouter modes across approved model lineup (`deepseek/deepseek-v4-flash-0731:high`, `openrouter/5.6-luna-high`, `qwen/qwen-3.8-27b:high`, `google/gemini-3.7-flash:high`).
   - Update `scripts/compare-release-baselines.mjs` and test suites to validate 93-scenario release candidates against baseline versions.
   - Ensure 100% unit, integration, and E2E test pass rates.

## Request — 2026-09-04T14:43:03Z

Implement core developer delight and platform superpowers for Review Yeti (native GitHub suggestion diffs, interactive PR chat mentoring, local pre-commit CLI, automated GitHub App manifest wizard, community persona store, and persistent team memory), with complete documentation updates (excluding marketplace publishing).

Working directory: `/tmp/review-yeti-bot`
Integrity mode: development

## Requirements

### R1. Native 1-Click "Commit Suggestion" Diffs
- Enhance the comment publisher and arbiter to emit native GitHub suggestion blocks:
  ````markdown
  ```suggestion
  <replacement code>
  ```
  ````
- When a persona generates an actionable code fix for a specific hunk in the PR diff, format it so developers can click "Commit suggestion" directly in GitHub PR review threads.
- Preserve fallback table rendering for multi-file or architectural advice where a single-line suggestion is not applicable.

### R2. Interactive PR Comment Chat & Mentoring (`@review-yeti`)
- Extend the webhook / GitHub event handler (`src/github/eventHandler.ts` and `src/github/webhookServer.ts`) to listen for issue comments and PR review comments mentioning `@review-yeti` (or `@ct-review`):
  - `@review-yeti explain`: Provides architectural/security rationale for a specific finding.
  - `@review-yeti fix`: Generates a code suggestion or diff for the discussed thread.
  - `@review-yeti ignore` / `@review-yeti mute`: Records the finding as a suppressed nit for this repository.
- Ensure authentication uses the ephemeral installation token minted from the GitHub App.

### R3. Local Pre-Commit CLI & Git Hook (`git yeti` / `npx review-yeti pre-commit`)
- Add a lightweight CLI command in `src/cli/` (and executable script `bin/review-yeti.js`):
  - Accepts `pre-commit` command to evaluate staged changes (`git diff --cached`).
  - Supports quick local evaluation using fast flash models (DeepSeek Flash, Gemini Flash, or local Ollama) in < 5 seconds.
  - Outputs concise terminal color-coded verdicts and blocking P0 checks before commits are made.

### R4. 30-Second GitHub App Setup Wizard (`npx review-yeti init`)
- Implement an automated CLI onboarding wizard using GitHub's App Manifest Flow (`POST https://api.github.com/app-manifests/{code}/conversions`):
  - Opens browser to pre-configured GitHub App creation page with least-privilege permissions (`Checks: write`, `Pull requests: write`, `Contents: read`, `Issues: write`).
  - Automatically exchanges code for App ID, Installation ID, and Private Key PEM.
  - Generates ready-to-use `.env` or updates repository secrets via GitHub CLI (`gh secret set`).

### R5. Community Persona Store & Persistent Team Memory
- **Community Persona Loader**: Allow `.ct-review.yaml` to reference external persona charters (e.g. `uses: review-yeti/personas/django-security@v1` or local community folders in `domains/personas/`).
- **Persistent Team Memory (`.ct-memory/` / SQLite)**: Connect the reflection engine (`src/reflection/`) to record team-accepted rules, dismissed nits, and architectural decisions, automatically suppressing false positives on future PRs.

### R6. Documentation Suite Overhaul
- Update `README.md`, `docs/USER_GUIDE.md`, `docs/CONFIGURATION_REFERENCE.md`, `docs/ONBOARDING_GUIDE.md`, and create:
  - `docs/INTERACTIVE_CHAT.md`: Comprehensive guide to interactive PR chat commands.
  - `docs/CLI_REFERENCE.md`: Local CLI usage and git pre-commit hook setup.
  - `docs/TEAM_MEMORY.md`: How session reflection, nit suppression, and team memory work.
- Ensure 0 proprietary company references (`calltelemetry`) exist across all public docs.

## Acceptance Criteria

### Functionality & Tests
- [ ] Arbiter and CommentPublisher generate valid ` ```suggestion ` blocks when line replacements are available.
- [ ] Interactive comment handler parses `@review-yeti explain`, `fix`, and `ignore` commands with unit and integration tests.
- [ ] `bin/review-yeti.js` runs `pre-commit` on git diffs and reports verdicts cleanly to stdout.
- [ ] GitHub App manifest configuration generator produces valid GitHub App manifest JSON matching the permissions matrix.
- [ ] Reflection & memory engine persists learned rules and suppresses matching nits on subsequent evaluation passes.

### Verification & Documentation
- [ ] All unit and integration tests (`npm run test:unit`, `npm test`) pass cleanly.
- [ ] `docs/INTERACTIVE_CHAT.md`, `docs/CLI_REFERENCE.md`, and `docs/TEAM_MEMORY.md` exist and render cleanly with examples.
- [ ] Zero marketplace publishing steps executed.
- [ ] Anonymity audit passes with 0 proprietary references across docs and examples.
- [ ] Changes committed cleanly, pushed to origin, PR created, and merged into `main`.
