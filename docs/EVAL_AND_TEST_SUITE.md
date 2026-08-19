# Evaluation & Test Suite Guide

The complete map of Review Yeti's test and evaluation surface: what each lane
proves, how to run it, the scenario catalogs, the production telemetry loop,
and the measured concurrency/provider-limit and failure-taxonomy analysis that
backs the current tuning. Snapshot date: 2026-08-19, bot `efb0d6d`.

## Goals

1. **Deterministic first.** Every behavioral guarantee — verdict arbitration,
   fail-closed coverage, injection containment, publication invariants — is
   proven by deterministic suites with scripted model output. Live model calls
   are never required to know the machinery is correct.
2. **Fail-closed is the tested property, not the hoped-for one.** The scenario
   catalogs enumerate the degraded states (provider outage, malformed output,
   stale head, cancelled runner, budget exhaustion) and pin the exact verdict
   each must produce. An unsafe SHIP in any eval matrix is a hard failure.
3. **Live verification is a canary, not a substitute.** Consumer-repo canary
   PRs (real diffs, real transports) validate the last mile — transport
   failover, publication, gate enforcement — after the deterministic layers
   pass.
4. **Production telemetry closes the loop.** Every review emits a
   `review-run-report.v1` artifact; harvested reports feed the noise-analysis
   CLI so reviewer quality is measured continuously, not assumed.

## Suite inventory

Run everything: `npm run test:all` (~2 min locally, exit 0 required).

| Command | Proves | Size | Local time |
|---|---|---|---|
| `test:unit` | All modules: parsers, ledger, arbitration, transports, telemetry, overview brief, calibration, rebuttal, cross-confirm, conditional lanes | 97 files / 1072 tests | ~33s |
| `test:cassettes` | Recorded provider/GitHub exchanges replay byte-stable | 16 | <1s |
| `test:fixtures` | Workflow scenario corpus is complete and safe (required-ID set, unsafe-content guards) | 26 | <1s |
| `test:memory-vcr` | Memory provider adapters incl. failure paths | 15 | <1s |
| `test:workflow` | Full pipeline integration over the scenario fixtures (scripted model, stubbed GitHub) | 19 | ~5s |
| `test:outbox` | Durable outbox replay after runner cancellation | 6 | <1s |
| `test:security` | Memory boundary security contracts | 3 | <1s |
| `test:chaos` | Chaos-mode pipeline behavior | 2 | <1s |
| `test:receipts` | Sanitized receipt contract (artifact-published) | script | <1s |
| `test:action-contract` | action.yml inputs/outputs/env wiring preflight | script | <1s |
| `test:action-runtime` | Runtime boot + SIGTERM/telemetry cancellation seams (Node 20 & 24 in CI) | 9 | <1s |
| `test:pi-adapter` | Pi MCP adapter | 15 | <1s |
| `test:intelligence-eval` | Offline promotion matrix (adversarial scenarios, below) | 10 scenarios | <1s |
| `test:bounded-review-eval` | Verdict matrix for the bounded engine (below) | 12 cases | <1s |
| `test:dependency-eval` | Dependency-investigation A/B eval (below) | 16 fixtures × 3 reps | ~1s |
| `test:equivalence` | Action ↔ CLI behavioral equivalence | 1 | <1s |
| `test:intelligence-promotion` | Promotion gate over the intelligence eval | script | <1s |
| `lint` + `build` | Typecheck + tsc build | — | ~15s |

## Scenario catalogs

### Workflow fixture corpus (`tests/fixtures/review-workflows/`, drop-guarded)

13 required scenarios; removing one fails `test:fixtures`:
`fresh-clean`, `ignored-authorized`, `ignored-unauthorized`,
`intelligence-evaluation`, `open-finding-carried`, `partial-review`,
`provider-malformed`, `provider-unavailable`, `publication-race`,
`replay-dead-letter`, `resolved-and-reopened`, `runner-cancelled`,
`stale-head`. Each fixture scripts the GitHub responses, model responses, and
the exact expected outcome (verdict, coverage, published counts, forbidden
strings). The prompt-injection twin suite layers on `fresh-clean`: an
injection-laden diff with identical scripted model output must produce an
identical verdict with zero payload text on any published surface.

### Bounded-engine verdict matrix (`tests/fixtures/bounded-review-engine/`)

12 cases; `unsafeShips` and `hiddenSkippedUnits` must both be 0:

| Case | Verdict | Case | Verdict |
|---|---|---|---|
| clean-guard-present | SHIP | unknown-evidence-receipt | INCOMPLETE_REVIEW |
| confirmed-auth-bypass | FIX_FIRST | third-identical-call | INCOMPLETE_REVIEW |
| dependency-api-mismatch | FIX_FIRST | partial-diff-budget | PARTIAL_REVIEW |
| dependency-clean-upgrade | SHIP | provider-timeout-after-evidence | PARTIAL_REVIEW |
| prompt-injection-in-diff | SHIP | runner-cancelled | INCOMPLETE_REVIEW |
| invalid-line-anchor | INCOMPLETE_REVIEW | stale-head-before-publish | INCOMPLETE_REVIEW |

### Intelligence promotion matrix (`tests/fixtures/review-intelligence/`)

10 adversarial scenarios, score must be 1.0: repeated-pr-feedback-transitions,
session-recap-exact-head, stale-head-rejected, provider-failure-fail-open,
compaction-bounded, otel-receipt-redacted, mcp-poisoning-rejected,
lease-loss-fenced, replay-dead-letter-authorized, secret-free-receipts.

### Dependency investigation A/B (`tests/fixtures/dependency-evaluation.json`)

16 fixtures × 3 repetitions, baseline arm vs candidate arm. Current standing:
candidate 100% expected-decision accuracy / 100% fault recall / 0% unsafe-ship
vs baseline 37.5% / 0% / 100%. Five deterministic gates must hold; promotion
stays blocked on `live_provider_cost_and_latency_not_measured` until a live
measurement is attached.

### Reviewer-noise feature suites (`tests/unit/`)

- `promptInjectionContainment` + `promptInjectionTwins`: five payload families
  (instruction override, role smuggling, verdict-marker forgery, fabricated
  receipts, delimiter escape) contained at the prompt layer and inert at every
  published surface.
- `prOverviewBrief`, `calibrationNotes`, `rebuttalRerun`, `crossModelConfirm`,
  `conditionalLanes`, `runReport`: contracts for each pipeline stage —
  bounds, attribution routing, marker guards, demotion annotations,
  aggregation math.

## Production telemetry loop (run reports)

Every completed review emits `review-run-report.v1` three ways: a
`[RunReport] {json}` log line, a JSON file under `RUNNER_TEMP`, and the
`run-report-path` action output. Harvest and analyze:

```bash
# Harvest from CI logs (no caller changes needed)
for id in $(gh run list -R <consumer> --workflow "Review Yeti" -L 15 \
    --json databaseId,conclusion --jq '.[] | select(.conclusion=="success") | .databaseId'); do
  gh run view $id -R <consumer> --log | grep -o '\[RunReport\] {.*}' \
    | sed 's/^\[RunReport\] //' > reports/run-$id.json
done
node scripts/run-report-summary.mjs reports/
```

The summary prints per-persona flake rate + failure-class histogram, severity
distribution, cross-persona finding overlap, and same-diff re-roll verdict
variance. Current production standing (8-run window, cisco-cdr): all five
personas 0% failure, 8/8 SHIP, 3 re-roll groups with 0 inconsistent verdicts.

## CI topology and optimization analysis

`ci-cd.yaml` fans out 8 parallel jobs (measured on a recent green run):

| Job | Runs | Time |
|---|---|---|
| test | full vitest + typecheck | 60s |
| Unit and fixture contracts | test:unit + test:fixtures | 47s |
| Action runtime (Node 20 / 24) | test:action-runtime + test:workflow | 22s / 17s |
| Cassette replay + receipts | test:cassettes + test:receipts artifact | 15s |
| Full workflow and outbox harness | test:workflow + test:outbox | 15s |
| Security and boundary contracts | test:security + test:chaos | 12s |
| Typecheck and build | lint + build | 14s |

Observations:

- **Known redundancy, deliberately kept.** `test:unit` runs twice (inside
  `test` and in `unit-contract`) and `test:workflow` three times (in `test`,
  `action-runtime`, `workflow-harness`). Wall time is unaffected (jobs are
  parallel; the 60s `test` job is the critical path) and this repository is
  public, so Actions minutes are free — the duplication buys independent,
  narrowly-named required checks at zero marginal cost. Revisit only if the
  repository goes private or the `test` job exceeds ~3 minutes.
- **`npm ci` runs 8×** (~10–20s each). If wall time ever matters, a shared
  `actions/setup-node` dependency cache or a single install + artifact reuse
  is the first lever.

## Concurrency model and provider limits

### Per-review request shape

- **Persona fan-out is fully concurrent**: all 5 lanes launch via
  `Promise.all`; within a lane, investigation turns are sequential. Peak
  in-flight completions per review = **5** (one per lane), plus one earlier
  sequential preflight.
- **Pre/post passes are sequential and additive to wall time, not to peak
  concurrency**: overview brief (1 call, before fan-out), rebuttal re-runs
  (≤3, sequential), cross-model confirmations (≤6, sequential, rotated
  transport), conditional lanes (≤4, sequential). None overlap the lane
  fan-out.
- Worst-case calls per review ≈ 1 preflight + 1 overview + 5 lanes × ≤3 turns
  + 3 rebuttals + 6 confirmations + 4 conditional lanes ≈ **30 completions**,
  but the common clean run is 7 (preflight + overview + 5 single-turn lanes).

### Measured provider standing (30-run production window)

- **Zero HTTP 429 / rate-limit events** at concurrency 5 on Fireworks
  serverless; zero on Ollama Cloud (fallback + cross-confirm traffic).
- **Zero provider outage lane deaths**; the only provider-adjacent event was
  a Fireworks contract-violation on one overview call that failed over to
  Ollama mid-run and recovered (the transport plan working as designed).

### Limits exposure and guidance

- **The org shares one `FIREWORKS_PR_REVIEW_API_KEY`** across every consumer
  repo and the central self-review. N simultaneous PR reviews stack to ~5N
  concurrent Fireworks requests on one account. At the current fleet (a few
  PRs per hour) this is far below observable throttling; if the fleet grows
  to many simultaneous reviews, watch for 429s in `[OpenRouter] HTTP_FAIL`
  log lines and split keys per repo, or serialize via the per-PR concurrency
  group (already present — pushes to the same PR cancel superseded runs, but
  distinct PRs run unbounded).
- **Ollama Cloud is capacity-capped by plan** (hourly/weekly usage on the
  subscription dashboard), not by observed request rejects. Its roles —
  failover target and cross-confirm second opinion — keep its volume a small
  fraction of Fireworks'. If cross-confirm volume grows (finding-heavy
  repos), its usage meters are the thing to watch, not latency.
- **Parallelization headroom (recommended next optimization):** the
  cross-confirm (≤6) and rebuttal (≤3) loops are sequential today for
  simplicity; a bounded `Promise.all` would cut up to ~20–30s of wall time on
  finding-heavy runs at a peak-concurrency cost of +6 requests. Safe at
  current provider standing; do it behind the existing receipts so the
  run-report timing shows the effect.

## Failure taxonomy — last 30 production runs (cisco-cdr Review Yeti)

Outcomes: 10 success · 14 failure · 4 skipped · 2 cancelled. Every failure
classified:

| Class | Count | Meaning | Action |
|---|---|---|---|
| Release-binding races (`central pin` / `central-sha` mismatch) | 6 | A run in flight while the consumer shim's central pin advanced; validate-caller fails closed by design. Clustered because four promotions landed in one day. | Expected during promotion windows; re-roll clears. If promotion cadence stays high, teach validate-caller to accept {current, previous} pin for a short grace window. |
| Genuine verdicts (FIX_FIRST / BLOCK / PARTIAL_REVIEW) | 5 | The gate doing its job: 2 were live-demo canary defects (real injected bugs), 3 were PARTIAL/BLOCK from a real P1 (mutable `v1` tag delegation caught by security) plus an `architecture` lane `budget_exhausted` after 3 turns. | The budget_exhausted class is the known residual persona-behavior flake (NEEDS_EVIDENCE through the final turn). Durable fix is persona restructuring (REL-277): force-COMPLETE semantics on the final turn or a deterministic pre-check. Run reports now quantify its rate. |
| Consumer config forbidden (`.coderabbit.yaml`) | 1 | Pre-fix: central policy rejected a file every consumer legitimately carries. | Fixed permanently (bot no longer reads `.coderabbit.*`; policy no longer forbids it). Cannot recur. |
| Stale-pin validation (pre-promotion run) | 1 | Same race class as above, older window. | Same. |
| PR not open | 1 | Review raced a PR close/merge. | Benign; fail-closed is correct. |
| Provider outages / rate limits / timeouts | **0** | — | The original disaster class is extinct in this window. |

## Live canary procedure (last-mile verification)

After any pin advance, open a short-lived PR against a consumer repo (never
merged, closed after evidence): a neutral-framed diff containing a real defect
class. Expected observations, all verified live on 2026-08-19: panel BLOCK on
the real defects; `[CrossConfirm]` second opinions on the rotated transport;
thread-outdating when the flagged line is fixed (obsolete entries drop from
carried-open); `[Rebuttal]` affirm/withdraw posted on-thread after an
author-reply-only re-roll. Framing matters: a diff labeled "deliberately
flawed" in the PR title is rationally approved — the overview brief propagates
the label to every persona. Neutral framing is part of the procedure.

## Related documents

- `docs/ARCHITECTURE.md` — pipeline structure
- `docs/CONFIGURATION_REFERENCE.md` — config schema
- `docs/EVALUATION_CLI.md` — the `eval` CLI
- `docs/DEPENDENCY_REVIEW_EVALUATION.md` — dependency A/B methodology
- `docs/ADVERSARIAL_REVIEW_PATTERNS.md` — attack patterns the suites encode
