# ct-review-bot — Enterprise GitHub Review Platform

`ct-review-bot` is a powerhouse, quorum-based GitHub Review Platform competing directly with CodeRabbit and Greptile. It orchestrates multi-LLM reviews via local OmniRoute routing, repo-level `.ct-review.yaml` & `.coderabbit.yaml` configs, operational `constitution.md`, Linear/Jira ticket enforcement, diff-delta incremental state persistence, and native GitHub App webhooks.

---

## 🌟 CodeRabbit Feature Parity Highlights

- 📊 **Executive PR Summaries & Walkthroughs**: High-level overviews, bulleted walkthroughs, and module-level changesets.
- 📐 **Mermaid Architecture Diagrams**: Automatically generates `mermaid` sequence and flowchart diagrams visualizing code execution paths for PR diffs.
- 💬 **Interactive PR Chat (`@ct-review`)**: Handles inline comment replies and top-level commands (`@ct-review ask <question>`, `@ct-review refactor`, `@ct-review explain`, `@ct-review summarize`, `@ct-review review`).
- 🎯 **Confidence Scores & Ranked Fixes**: Every finding includes 0-100% confidence ratings, recommendations, 1-click GitHub apply suggestion blocks (````suggestion ... ````), and up to 2 ranked potential fixes (`Option 1` vs `Option 2`).
- ⚡ **Diff-Delta Incremental Review Engine**: Tracks diff hunks across PR pushes (`synchronize` events) to review ONLY modified hunks, preserving token budget and suppressing resolved comments.
- 🛠️ **Dual YAML Compatibility**: Supports `.ct-review.yaml` and `.coderabbit.yaml` configurations with org-level default inheritance.
- 🚀 **Blacksmith CI/CD & DOKS Rolling Deployment**: High-speed GitHub Actions workflows on Blacksmith runners with Docker Buildx `type=gha` layer caching, multi-arch `linux/amd64` builds, and zero-downtime DOKS deployment.

---

## 👥 Persona Model Roster

| Persona | Default Model | Effort Level | Primary Focus |
| :--- | :--- | :--- | :--- |
| 🛡️ **Security** | `claude-5-sonnet` | `low` / `medium` / `high` | PII leaks, auth checks, fail-closed policy, OWASP Top 10 |
| 📐 **Architecture** | `gpt-5.6-sol` | `low` / `medium` / `high` | ADR compliance, structural design, API contracts |
| ⚡ **Performance** | `deepseek/deepseek-v4-pro` | `low` | Wall-clock latency, token budget, query optimization |
| 🔍 **Quality** | `z-ai/glm-5.2` | `low` | Code hygiene, bash 3.2 safety, path filters, unit test coverage |

---

## ⚙️ Configuration (`.ct-review.yaml` or `.coderabbit.yaml`)

```yaml
version: "1.0"

ticketEnforcement:
  required: true
  providers: [linear, jira, github]

quorum:
  minApprovals: 4
  personas: [security, architecture, performance, quality]
  effortLevel: low
  confidenceThreshold: 90

routing:
  providerGroup: "openrouter/review"

asciiArt: true
```

---

## 🧪 Testing Suite

- **Unit & Integration Tests**: `428 / 428 passing tests` across 52 test files.
- **Run Tests**: `npm test` or `./node_modules/.bin/vitest run`.
