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
