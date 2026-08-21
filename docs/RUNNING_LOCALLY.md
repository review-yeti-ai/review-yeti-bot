# 💻 Running Review Yeti Locally via CLI

This guide provides step-by-step instructions for executing the Review Yeti review pipeline, live PR reviews, and evaluation benchmarks locally from your workstation without relying on GitHub Actions.

---

## 1. Prerequisites

- **Node.js**: v18.0.0 or higher
- **GitHub CLI (`gh`)**: (Optional, required only for fetching live pull request context)
- **OpenRouter API Key**: Exported as `OPENROUTER_API_KEY` (or compatible OpenAI-compatible LLM endpoint)

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
# Optional overrides:
export OPENROUTER_MODEL="google/gemini-3.7-flash:high"
export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
```

---

## 2. Option A: Review Local Git Changes

To run Review Yeti against your current working tree diff before opening a pull request:

```bash
# 1. Export unified diff of your local branch against main
git diff origin/main...HEAD > /tmp/my_feature.diff

# 2. Execute local Review Yeti review pipeline
PR_DIFF_FILE=/tmp/my_feature.diff \
PR_NUMBER=1 \
GITHUB_REPOSITORY="calltelemetry/ct-review-bot" \
PR_HEAD_SHA="$(git rev-parse HEAD)" \
PR_BASE_SHA="$(git rev-parse origin/main)" \
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
node .github/workflows/pipelines/review-pipeline.js
```

---

## 3. Option B: Review a Target PR or Diff File

To review a specific diff file or reproduction case:

```bash
PR_DIFF_FILE="tests/fixtures/scenarios/2101.diff" \
PR_NUMBER=2101 \
GITHUB_REPOSITORY="calltelemetry/ct-meta" \
PR_HEAD_SHA="517968afa8a1ce28e2e3883df2a57a4edc2521d6" \
PR_BASE_SHA="bddb8ed916926e1b0a23de7a22ab0d40b79ebbf4" \
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
node .github/workflows/pipelines/review-pipeline.js
```

---

## 4. Option C: Live PR Review CLI (`src/cli/runLiveReview.ts`)

To evaluate a live remote pull request on GitHub via the CLI runner (automatically fetches the diff, commit SHA, and PR title using your local `gh` credentials):

```bash
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
npx ts-node src/cli/runLiveReview.ts --pr=2119 --repo=calltelemetry/ct-meta
```

---

## 5. Option D: Run Evaluation Benchmark Harness

To run the 190-scenario telecom benchmark evaluation suite locally:

```bash
# 1. Run offline deterministic evaluation (zero network calls, uses recorded VCR cassettes)
node scripts/evaluate-release-benchmark.mjs --offline

# 2. Run live benchmark against OpenRouter
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" node scripts/evaluate-release-benchmark.mjs --live

# 3. Generate standalone Pareto Frontier SVG charts (Accuracy vs. Cost)
node scripts/generate-benchmark-charts.mjs
```

---

## 6. Running Unit & Integration Tests

```bash
# Run all unit tests
npm run test:unit

# Run specific panel engine parallel tests
npx vitest run tests/unit/panelEngineParallel.test.ts tests/unit/streamingWatchdog.test.ts
```
