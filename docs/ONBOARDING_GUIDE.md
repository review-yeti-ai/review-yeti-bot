# 🚀 ct-review-bot — Zero-Config Onboarding & Session Learning Guide

Complete reference guide for deploying **ct-review-bot** to any codebase in under 60 seconds using the 1-Click Onboarding Wizard and configuring persistent team session learning.

---

## ⚡ Quick Start: 1-Click Onboarding Setup

### Option 1: Web Dashboard (Recommended)
1. Navigate to the Web Dashboard at `http://localhost:3000/dashboard/onboarding` (or your deployed server endpoint).
2. Enter your target repository path or name (e.g. `calltelemetry/cisco-cdr`).
3. Click **Scan Repository & Generate Config**.
4. The scanner completes in **< 1 second**, auto-detecting your tech stack, languages, frameworks, infrastructure manifests, and path exclusion defaults.
5. Review the auto-generated `.ct-review.yaml` configuration and click **Apply to Repository**.

### Option 2: REST API
Execute a single POST request to the onboarding wizard API:

```bash
curl -X POST http://localhost:3000/api/onboarding/wizard \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ct_live_your_api_key" \
  -d '{
    "repo": "calltelemetry/cisco-cdr",
    "autoCommit": true
  }'
```

---

## 🔍 Tech Stack Auto-Detection Scanner Reference

The Onboarding Engine (`src/onboarding/stackScanner.ts`) scans the target directory structure in **< 1000ms**, inspecting root manifests and file extensions across 8 major tech stacks:

| Technology / Stack | Detection Pattern | Auto-Configured Settings |
| :--- | :--- | :--- |
| **TypeScript / Node.js** | `package.json`, `tsconfig.json`, `.ts`/`.tsx` | Enables TypeScript AST indexing; adds `node_modules/`, `dist/`, `package-lock.json` to path filters. |
| **Python** | `requirements.txt`, `pyproject.toml`, `pipfile`, `.py` | Enables Python AST symbol graph; excludes `venv/` & `__pycache__/`. |
| **Go** | `go.mod`, `.go` | Enables Go parser rules; filters `vendor/` & `go.sum`. |
| **Java** | `pom.xml`, `build.gradle`, `.java` | Enables Java symbol inspection; filters `target/` & `build/`. |
| **Elixir** | `mix.exs`, `.ex`/`.exs` | Enables Elixir parser rules; filters `_build/` & `deps/`. |
| **Docker** | `Dockerfile`, `docker-compose.yml` | Configures DevOps & Cloud Infrastructure Specialist persona. |
| **Kubernetes / Helm** | `Chart.yaml`, `k8s/*.yaml` | Enables infrastructure policy and security compliance rules. |
| **HTML / CSS** | `.html`, `.css`, `.scss` | Applies frontend code review rules and asset filters. |

---

## ⚙️ Auto-Generated `.ct-review.yaml` Reference Schema

The configuration generator (`src/onboarding/configGenerator.ts`) produces a standard, CodeRabbit-compatible `.ct-review.yaml` schema:

```yaml
version: 3
profile: balanced # chill | balanced | assertive
quorum: 2

reviews:
  profile: balanced
  reviewer_effort: medium # low | medium | high
  confidence_threshold: 70
  ticket_enforcement: false
  request_changes_workflow: true
  high_level_summary: true

path_filters:
  - "node_modules/**"
  - "dist/**"
  - "build/**"
  - "target/**"
  - "vendor/**"
  - "coverage/**"
  - "package-lock.json"
  - "yarn.lock"

personas:
  - id: security-arbiter
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: ["claude", "codex"]
  - id: ts-node-architect
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**/*.ts", "**/*.tsx", "**/*.js", "package.json"]
    providers: ["codex", "grok"]

dials:
  memory_engine: true
  mascot: true
  confidence_threshold: 70
  ticket_enforcement: false

reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 180
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: medium
      review_timeout_s: 60
      arbiter_timeout_s: 45
    - id: grok
      enabled: true
      model: grok-cli/grok-4.5
      effort: medium
      review_timeout_s: 60
      arbiter_timeout_s: 45
  arbiter:
    order: ["claude", "codex", "grok"]
```

---

## 🧠 Session Reflection & Team Memory (`@ct-review learn`)

`ct-review-bot` dynamically adapts to your team's coding conventions, architectural guidelines, and past PR feedback through session reflection (`src/reflection/`).

### 1. Explicit Learning Command Syntax
Teach the bot new project rules directly in PR comment threads:

```text
@ct-review learn <pattern | rule>
```

**Examples**:
- `@ct-review learn Always prefer named exports over default exports in src/components/`
- `@ct-review learn Use logger.error() instead of console.error() in API routes`
- `@ct-review learn Ignore magic numbers inside unit test assertions (*.test.ts)`

When issued, the bot parses the command via `src/reflection/commandParser.ts`, acknowledges registration in a comment reply, and persists the rule into `.ct-memory/` (or SQLite).

### 2. Automatic Reaction & Comment Feedback Listener
The bot observes PR comment replies and reaction emojis:
- **Thumbs Up (👍)** / **"Good call"**: Increments confidence weight for that rule pattern.
- **Thumbs Down (👎)** / **"Ignore this / false positive"**: Marks the finding as a suppressed nit for that file path.

### 3. Precision Nit Suppression Engine
Once a nit rule is learned or dismissed, `src/reflection/nitSuppressionEngine.ts` automatically filters matching non-critical review findings on subsequent PR pushes with **100% precision**.

---

## 🛠️ Verification & Health Monitoring

1. **Verify Setup**: Confirm `.ct-review.yaml` is present in your repository root.
2. **Verify Memory**: Call `GET /api/memory/query?repo=calltelemetry/cisco-cdr` to view active learned rules.
3. **Health Endpoint**: Call `GET /health` to verify system readiness:
   ```json
   {
     "status": "ok",
     "service": "ct-review-bot",
     "memoryEngineReady": true,
     "onboardingWizardReady": true
   }
   ```
