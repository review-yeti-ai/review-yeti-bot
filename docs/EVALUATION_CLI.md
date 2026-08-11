# Manual evaluation CLI and TUI

Review Yeti's evaluation suite is an explicit developer and release-candidate tool. It does not
add a GitHub Actions trigger and it does not run a provider call on every commit.

## Offline evaluation

Offline mode replays checked-in fixtures and cassettes. It requires no credentials and is safe to
run locally:

```bash
npx review-yeti eval run \
  --fixture tests/fixtures/review-intelligence/offline-promotion-matrix.json \
  --mode offline
```

The command writes a JSON receipt and a Markdown report to
`.review-yeti/evaluations/` (override with `--output-dir`). The receipt is bound to the source
SHA and the fixture digest.

## Manual live evaluation

Live mode is intentionally opt-in and requires an explicit confirmation flag:

```bash
npx review-yeti eval run \
  --fixture tests/fixtures/dependency-evaluation.json \
  --mode live --repetitions 3 --concurrency 4 --yes
```

The live dependency evaluator uses the configured OpenRouter credentials and records provider,
model, token, cost, latency, and scenario results. Missing credentials, provider timeouts, or
malformed responses produce `INCONCLUSIVE`; they cannot become a passing evaluation.

## Compare and inspect receipts

```bash
npx review-yeti eval list
npx review-yeti eval report --receipt .review-yeti/evaluations/<run>.json
npx review-yeti eval compare \
  --baseline .review-yeti/evaluations/<baseline>.json \
  --candidate .review-yeti/evaluations/<candidate>.json
```

Comparison checks fixture identity, unsafe ships, accuracy regressions, cost growth above 1.3x,
and p95 latency growth above 1.5x. A comparison with missing or inconclusive evidence is
`INCONCLUSIVE`.

## Terminal TUI

```bash
npx review-yeti eval tui
```

The TUI uses the same runner and receipt APIs as the CLI. Its line-oriented controls are:

| Command | Action |
|---|---|
| `r [fixture]` | Run an offline evaluation |
| `l [fixture] --yes` | Run a confirmed live evaluation |
| `c <baseline> <candidate>` | Compare two receipts |
| `q` | Quit |

When output is redirected, the TUI automatically falls back to a receipt table rather than
emitting terminal control sequences.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Pass |
| `1` | Fail or blocked comparison |
| `2` | Invalid usage or live confirmation missing |
| `3` | Inconclusive or provider unavailable |

The existing GitHub Action review path is unchanged. The full baseline/epic suite remains a
manual release-level measurement until an explicit automation policy is approved.
