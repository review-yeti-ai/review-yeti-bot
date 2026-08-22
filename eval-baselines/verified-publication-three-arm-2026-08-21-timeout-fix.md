# Verified publication — three-arm re-measurement after the verdict-latency fix (2026-08-21 evening, still NO-SHIP)

**Verdict: NO-SHIP against the pre-stated acceptance criterion; the stage stays config-gated OFF.**
This run tests the fix for the sole remaining blocker from the morning re-measurement: the hard
60s per-call verifier budget was shorter than a buffered reasoning-model verdict's latency tail,
so 9 of 27 hypotheses were withheld as `verifier_unavailable` without ever being checked.

## The fix under test

`src/review/findingFalsification.js` + `callFalsificationModelTurn`:

- Per-call `timeoutMs`: default 60s → **180s**, hard ceiling **300s** (the measured buffered-lane
  requirement for this model class). Still clamped; config can never exceed the ceiling.
- New **`stageBudgetMs`** (default 300s, hard ceiling 900s): a stage-level wall clock that now
  carries the boundedness guarantee the per-call cap never actually provided (12 calls x 3
  attempts x 60s was ~36 min of theoretical exposure). Effective per-call timeout is
  `min(per-call cap, remaining stage budget)`; a call that cannot start before the deadline
  abstains `stage_budget_exhausted` without dialing.
- Receipts now separate **"never verified"** from "examined and withheld": `verifier_timeout`
  (per-call deadline fired) vs `verifier_unavailable` (provider failure) vs
  `stage_budget_exhausted`, aggregated as `summary.neverVerified`. A reviewer-facing surface can
  no longer present an unchecked claim as a rejected one.

## Setup

- Corpus: `eval-baselines/verified-publication-fixtures/evaluation-matrix.json` (9 fixtures x 8
  repetitions, 72 rows per arm; defect N=40, clean N=32), model
  `deepseek/deepseek-v4-flash-0731`, measured 2026-08-21 evening.
- Transport pinned to a single OpenRouter transport via `REVIEW_YETI_TRANSPORTS` (the ambient
  multi-provider env routed the OpenRouter model slug to Fireworks/Ollama/Gemini and 404'd).
- Same harness, same structural grading, same production `reviewWithModel` lane path as the
  morning run. Lanes are provider-weather dependent; arms within this run are directly
  comparable, cross-run absolutes are not.

## Acceptance criterion (fixed 2026-08-20, before any measurement — unchanged)

> recall >= 0.600, FPR <= 0.031, error rate < 16/72.

## Results

| Metric | baseline | candidate | verified |
|---|---|---|---|
| Detection rate (recall) | 0.600 [0.446-0.737] | 0.575 [0.422-0.715] | **0.400 [0.264-0.554]** |
| False-positive rate | 0.250 [0.133-0.421] | 0.000 [0.000-0.107] | **0.000 [0.000-0.107]** |
| Precision (hits/(hits+noise)) | 0.703 | 0.958 | **1.000** |
| SNR | 3.82 | 26 | **unbounded (0 noise)** |
| Errored runs | 0/72 | 0/72 | 0/72 (verifier added 0) |
| Findings/run | 0.736 | 0.375 | 0.236 |
| Latency median (ms) | 10,890 | 22,894 | 29,827 |
| Cost/72 rows (USD) | $0.0147 | $0.0166 | $0.0189 |

Verifier verdict totals (27 hypotheses on 26 rows): **17 CONFIRM, 5 REFUTE, 1 examined ABSTAIN,
4 never-verified — all 4 `verifier_unavailable` (provider failures), 0 `verifier_timeout`, 0
`stage_budget_exhausted`.**

**The timeout fix worked mechanically.** Verifier verdict latency ran median 16.2s / p95 82.8s /
max 107.9s per row: several verdicts that the old 60s cap would have converted into silent
withholdings completed normally under the 180s cap. The timeout-abstention class went 9/27 → 0/27.

## Against the bar

- **Errors: PASS** (0/72, bar <16).
- **FPR: PASS** (0.000, bar <=0.031).
- **Recall: FAIL** — verified 0.400 vs bar 0.600.

**This failure is now structural, not mechanical.** The stage can only narrow, so verified recall
is bounded above by candidate recall, and the candidate lane itself measured **0.575 < 0.600** on
this run: no verifier behavior — including a perfect one — could have passed the bar today. The
morning diagnosis ("the measured lever is the verdict latency budget") is now exhausted: with
timeouts eliminated, the remaining verified-arm loss decomposes as

- 4 hypotheses never verified (`verifier_unavailable`, provider failures whose error text the
  receipt does not yet carry; retry-once already applied) — the fail-open counterfactual below
  bounds their worth;
- 5 refutations + 1 examined abstention, several on true-detection rows
  (`vacuous-default-value-test`, `dual-cause-diagnostic-named-for-one`,
  `shared-module-state-order-dependent-test`) — the flash-tier falsifier remains a noisy
  discriminator on subtle test-quality claims, exactly as the 08-20 run found.

## Fail-open counterfactual (measured, not assumed)

Regrading the same verified rows with never-verified hypotheses KEPT (fail-open on
`verifier_unavailable`, refutations still dropped): recall **0.475** [0.329-0.625], FPR 0.000,
precision 1.000. Fail-open recovers less than half the gap to candidate (0.575) and still fails
the 0.600 bar, while abandoning the stage's core "uncertainty must not publish" contract. Not
recommended on this evidence.

## Reading

The purity thesis keeps reproducing: FPR 0, precision 1.0 on both measurement days. The recall
bar does not: candidate lane recall has now measured 0.600 (08-20), 0.475 (08-21 morning), 0.575
(08-21 evening) across engine/provider variations — the bar sits above the lane's own
day-to-day recall on 2 of 3 runs, and a narrowing-only gate cannot exceed its input. A future
attempt has two honest levers, neither of which is the timeout any more: (1) a stronger or
cross-family verifier model (blocked on account data-policy at last check), aimed at the
refutations-of-true-detections class; (2) acceptance against paired candidate-vs-verified deltas
on materially larger N (72 rows/arm gives ~±0.15 CI half-width, too wide to resolve
0.575-vs-0.600). Enabling the stage remains a separate operator decision gated on a passing
re-measure against the unchanged bar.

Artifacts: `eval-baselines/verified-publication-three-arm-2026-08-21-timeout-fix.json` (full
rows, per-hypothesis verdict reasons via `perRowOutcomes`, verifier stats — both now persisted
by the report phase so timeout-vs-refute attribution never again needs latency forensics).
Prior measurements preserved unchanged: `verified-publication-three-arm.{md,json}` (08-20),
`verified-publication-three-arm-2026-08-21.{md,json}` (08-21 morning, pre-fix).
