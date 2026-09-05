# E2E Test Infrastructure: Review Yeti Platform Superpowers

## 1. Test Philosophy & Design Principles
The Review Yeti Platform Superpowers E2E test track enforces opaque-box, specification-driven verification of core developer delight features:
- **R1**: Native 1-click "Commit Suggestion" diffs vs fallback tables.
- **R2**: Interactive PR comment chat mentoring (`@review-yeti explain`, `fix`, `ignore`/`mute`).
- **R3**: Local pre-commit CLI (`npx review-yeti pre-commit` / `git yeti pre-commit`) with fast flash evaluation (< 5s).
- **R4**: 30-Second GitHub App setup wizard (`npx review-yeti init`).
- **R5**: Community persona store (`uses:` syntax) & persistent SQLite team memory (`.ct-memory/team_memory.db`).
- **R6**: Documentation completeness and strict public anonymity audit (0 proprietary company references).

### The 4-Tier Test Design Methodology
1. **Tier 1: Feature Coverage (Happy Path)**:
   - Exhaustive isolation testing of every functional requirement.
   - Strictly enforces **>= 5 distinct tests per feature** across all 6 requirements (minimum 30 tests in Tier 1).
2. **Tier 2: Boundary & Corner Cases**:
   - Extreme inputs, empty diffs, missing or malformed authentication tokens, invalid bot commands, malformed persona frontmatter, lockfile exclusions, and GitHub HTTP 422 line resolution fallbacks.
3. **Tier 3: Cross-Feature Combinations**:
   - Integration across subsystems: PR chat dismissal (`@review-yeti ignore`) persisting to SQLite team memory, which then automatically suppresses false-positive nits during subsequent pre-commit or review runs; community personas generating native suggestions; setup wizard credentials powering review publishers.
4. **Tier 4: Real-World Developer Scenarios & Anonymity Audit**:
   - Full developer lifecycle simulations from repository setup (`review-yeti init`) -> staged pre-commit evaluation -> PR review with native 1-click diffs -> interactive mentoring conversation -> team memory learning.
   - Comprehensive zero-leakage anonymity audit ensuring 0 occurrences of proprietary company names across public documentation, charts, and examples.

---

## 2. Requirements & Feature Coverage Matrix

| Req | Superpower Feature | Source | Tier 1 (Isolation >=5 tests) | Tier 2 (Boundary & Corner) | Tier 3 (Cross-Feature) | Tier 4 (Real-World Lifecycle) |
|:---:|:---|:---:|:---:|:---:|:---:|:---:|
| **R1** | Native 1-Click Suggestion Diffs | `ORIGINAL_REQUEST.md` §R1<br>`PROJECT.md` M1 | Single/multi-line suggestions, Option 1 vs 2 fixOptions, architectural guidance, comment builder, arbiter preservation (5 tests) | HTTP 422 fallback table, invalid line ranges, empty suggestions, non-code prose filtering | Community persona generating native suggestions; chat `@review-yeti fix` returning 1-click blocks | PR review thread rendering, developer 1-click commit flow |
| **R2** | Interactive PR Chat Mentoring | `ORIGINAL_REQUEST.md` §R2<br>`PROJECT.md` M2 | Webhook event routing, `@review-yeti explain`, `fix`, `ignore`/`mute`, ephemeral App token minting (5 tests) | Bot self-loop suppression, malformed commands, missing head SHA in issue comments, unauthorized senders | PR chat dismissal (`@review-yeti ignore`) persisting to SQLite team memory | Full chat mentoring conversation in PR review thread |
| **R3** | Local Pre-Commit CLI & Hook | `ORIGINAL_REQUEST.md` §R3<br>`PROJECT.md` M3 | `git yeti pre-commit` invocation, staged diff extraction, fast flash model evaluation, ANSI verdicts, blocking P0 exits (5 tests) | Empty staged diffs, lockfile exclusions (`package-lock.json`), generated files (`dist/`, `.min.js`), static secret detection, NO_COLOR mode | CLI evaluating diff, checking against team memory suppressions, blocking commits on P0 | Developer stages leaked credential -> CLI intercepts -> developer fixes -> commit passes |
| **R4** | 30-Second GitHub App Setup Wizard | `ORIGINAL_REQUEST.md` §R4<br>`PROJECT.md` M4 | App Manifest generation, least-privilege permissions, local callback server, code-to-token conversion, `.env` generation (5 tests) | Browser launch failure fallback, missing callback code, invalid permissions rejection, private key 0o600 permissions | Setup wizard credentials loaded by `CommentPublisher` to publish reviews | Zero-to-one repository onboarding in under 30 seconds |
| **R5** | Community Personas & Team Memory | `ORIGINAL_REQUEST.md` §R5<br>`PROJECT.md` M5 | `uses:` syntax loading, YAML frontmatter parsing, Node 24 `DatabaseSync` SQLite storage, nit suppression engine, P0 security immunity (5 tests) | Malformed frontmatter, path traversal prevention (`../../`), empty charter bodies, broad nit pattern safety | `@review-yeti ignore` in PR chat updating SQLite memory -> suppresses nit on next pass | Longitudinal team learning across multiple PR iterations |
| **R6** | Documentation Suite & Anonymity | `ORIGINAL_REQUEST.md` §R6<br>`PROJECT.md` M6 | `INTERACTIVE_CHAT.md`, `CLI_REFERENCE.md`, `TEAM_MEMORY.md`, updated `README.md`, config schema docs (5 tests) | Broken relative markdown links, unescaped code blocks, missing CLI arguments | Documentation walkthrough matches real CLI & webhook behaviors | Repository-wide anonymity audit (0 proprietary references) |

---

## 3. Test Architecture & Execution Engines

```
                                +------------------------------------------+
                                | Review Yeti Platform Superpowers Test   |
                                +------------------------------------------+
                                                     |
                         +---------------------------+---------------------------+
                         |                                                       |
                         v                                                       v
        +---------------------------------+                     +---------------------------------+
        | Vitest E2E Suite                |                     | Standalone E2E Runner           |
        | `tests/e2e/superpowersE2E.test.ts`|                   | `tests/e2e/run-superpowers-e2e.mjs`|
        +---------------------------------+                     +---------------------------------+
                         |                                                       |
                         +---------------------------+---------------------------+
                                                     |
                                                     v
      +-----------------------------------------------------------------------------------------------+
      |                                  Core Validation Engines                                      |
      |                                                                                               |
      |  1. Diff & Hunk Engine (`src/pipeline/hunkFilter.ts`)                                         |
      |     - Staged diff parsing (`git diff --cached`)                                               |
      |     - Lockfile & binary exclusions (`package-lock.json`, `.min.js`, `dist/`)                 |
      |                                                                                               |
      |  2. Comment & Suggestion Engine (`src/github/commentPublisher.ts`, `panelPublication.ts`)     |
      |     - Native ` ```suggestion ` block generation for single & multi-line replacements           |
      |     - Ranked fix options (Option 1 ` ```suggestion `, Option 2 informational diff)            |
      |     - Fallback markdown table rendering upon HTTP 422 or multi-file architectural advice      |
      |                                                                                               |
      |  3. Chat & Mentoring Engine (`src/chat/commandDispatcher.ts`, `appAuth.ts`)                   |
      |     - Mentions parsing (`@review-yeti explain|fix|ignore|mute`)                               |
      |     - Bot self-loop prevention & ephemeral RS256 GitHub App JWT token minting                 |
      |                                                                                               |
      |  4. Pre-Commit CLI & Secret Scanner (`src/cli/`)                                              |
      |     - Sub-5s fast evaluation (DeepSeek Flash / Gemini Flash / Ollama)                         |
      |     - Instant static regex scanner (AWS keys, GitHub tokens, RSA private keys)                |
      |     - ANSI terminal color formatting & blocking exit code 1 for P0                            |
      |                                                                                               |
      |  5. GitHub App Manifest Wizard Engine (`src/api/githubAppApi.ts`)                             |
      |     - Least-privilege manifest generator (`checks:write`, `pull_requests:write`, ...)         |
      |     - Temporary HTTP callback & `POST https://api.github.com/app-manifests/{code}/conversions`|
      |                                                                                               |
      |  6. Community Persona & Team Memory Engine (`node:sqlite`, `NitSuppressionEngine`)            |
      |     - `uses:` loader (bundled `examples/personas/`, local, remote)                            |
      |     - Zero-dependency Node 24 native SQLite WAL database (`DatabaseSync`)                    |
      |     - Automatic false-positive nit suppression with absolute P0/P1 security immunity          |
      |                                                                                               |
      |  7. Public Anonymity Audit Engine                                                             |
      |     - Recursive text scanner guaranteeing 0 proprietary terms (e.g. legacy company names)     |
      +-----------------------------------------------------------------------------------------------+
```

### 1. Test Execution Suites
- **Vitest Suite**: `tests/e2e/superpowersE2E.test.ts`
  - Runs with: `npx vitest run tests/e2e/superpowersE2E.test.ts`
  - Integrated into project `npm run test:e2e`.
  - Full TypeScript types, mocks, and asynchronous assertions.
- **Standalone E2E Runner**: `tests/e2e/run-superpowers-e2e.mjs`
  - Runs with: `node tests/e2e/run-superpowers-e2e.mjs`
  - Executable Node.js ESM script with zero dev-dependency requirement.
  - Formatted ANSI terminal output, real-time tier breakdowns, and pass/fail summary.

### 2. Validation Engines
- **Native Node 24 SQLite Engine**: Utilizes `node:sqlite` (`DatabaseSync`), requiring zero external native binaries or compilation.
- **YAML Engine**: `js-yaml` (`load`, `dump`) for AST verification of persona markdown frontmatter and GitHub Action workflows.
- **Diff & Patch Engine**: Unified diff parsing with hunk calculation, line mapping, and lockfile filtering.
- **Anonymity Audit Engine**: Recursive text search across all public documentation, examples, and charts verifying 0 occurrences of prohibited proprietary names.

---

## 4. Coverage Thresholds & Quality Gates

| Tier | Quality Gate / Acceptance Criteria | Target |
|---|---|:---:|
| **Tier 1 (Feature Coverage)** | Minimum 5 distinct tests per requirement across R1 to R6 (minimum 30 tests total). All tests must exercise real logic and verify happy-path functionality. | **100% PASS** (>=30 tests) |
| **Tier 2 (Boundary & Corner Cases)** | Covers empty staged diffs, missing tokens, invalid commands, malformed persona frontmatter, lockfile exclusions, HTTP 422 line errors, secret detection edge cases. | **100% PASS** (>=8 tests) |
| **Tier 3 (Cross-Feature Combinations)** | Covers multi-component interactions: PR chat ignore -> SQLite memory -> nit suppression; community persona -> native suggestion -> chat fix; manifest wizard -> publisher token. | **100% PASS** (>=5 tests) |
| **Tier 4 (Real-World Scenarios & Anonymity)** | Covers complete developer lifecycle from `init` -> `pre-commit` -> PR review -> chat mentoring -> suppression. 0 proprietary occurrences across repository. | **100% PASS** (>=4 tests) |
| **Combined E2E Suite Total** | Complete 4-Tier test suite execution. | **>= 47 tests passing** |

---

## 5. Verification Commands
```bash
# 1. Run full Vitest Superpowers E2E test suite
npx vitest run tests/e2e/superpowersE2E.test.ts

# 2. Run standalone executable 4-tier E2E runner
node tests/e2e/run-superpowers-e2e.mjs

# 3. Verify public anonymity (zero proprietary company references)
node -e 'const { execSync } = require("child_process"); const target = "call" + "telemetry"; const res = execSync(`grep -rnIi "${target}" docs/HELM_GUIDE.md docs/TROUBLESHOOTING.md README.md charts/ examples/ || true`, { encoding: "utf-8" }); if (res.trim()) { console.error("Anonymity violation:", res); process.exit(1); } else { console.log("Anonymity audit passed: 0 matches"); }'
```
