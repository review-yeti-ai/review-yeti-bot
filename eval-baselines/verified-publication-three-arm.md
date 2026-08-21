# Verified publication — three-arm evaluation (NO-SHIP)

**Verdict: NO-SHIP against the pre-stated acceptance criterion.** The falsification stage is
landed config-gated **off** and must stay off until a configuration passes the bar below.

- Corpus: `tests/fixtures/testing-charter/evaluation-matrix.json` (9 fixtures x 8 repetitions,
  72 rows per arm; defect N=40, clean N=32), bounded investigation path, model
  `deepseek/deepseek-v4-flash-0731`, measured 2026-08-20.
- Arms: `baseline` (frozen pre-depth charter, live lanes), `candidate` (deep charter, live
  lanes), `verified` (the same candidate lane rows + `src/review/findingFalsification.js`
  applied per finding — paired, so the verifier's marginal effect is measured on identical
  hypotheses). Verifier model was the same `deepseek-v4-flash-0731` in a fresh context: the
  OpenRouter account's data-policy guardrails reject every other model family
  ("No endpoints available matching your guardrail restrictions"), so the cross-model variant
  could not be measured (see Limitations).

## Acceptance criterion (fixed before measurement)

> recall >= candidate (0.600), FPR <= baseline's measured 0.031, error rate < candidate's 16/72.

## Results

| Metric | baseline | candidate | verified |
|---|---|---|---|
| Detection rate (recall) | 0.400 (95% CI 0.264–0.554) | 0.600 (95% CI 0.446–0.737) | **0.450 (95% CI 0.307–0.602)** |
| False-positive rate | 0.094 (95% CI 0.032–0.242) | 0.188 (95% CI 0.089–0.353) | **0.0625 (95% CI 0.017–0.202)** |
| Precision (hits/(hits+noise)) | 0.615 | 0.676 | **0.818** |
| SNR ((hits+valid)/noise) | 2.40 | 2.33 | **4.75** |
| Errored runs | 14/72 | 19/72 | 19/72 (verifier added 0) |
| Findings/run | 0.472 | 0.556 | 0.319 |
| Latency ms median / P95 | 47,930 / 190,391 | 92,837 / 180,264 | 115,635 / 308,081 |
| Cost (USD, 72 rows) | 0.0214 | 0.0303 | 0.0432 |

Verifier stage totals: 40 hypotheses across 31 rows → 23 CONFIRM / 13 REFUTE / 4 ABSTAIN /
0 verifier-unavailable. Added cost $0.0130 for 72 reviews (~$0.0004/review with findings
present ≈ +43% of lane cost); added latency ~72s median per review that had findings (serial
per-finding calls on a reasoning-heavy flash model).

Provider weather note: this replay day was materially worse than the recorded baseline day
(baseline arm errored 14/72 vs the recorded 6/72), on all arms equally. The paired
candidate-vs-verified comparison is unaffected; cross-day absolute comparisons are.

## Why it fails

- **Recall**: paired on identical lane rows, verification cut detections 24 → 18. The losses
  concentrate on `vacuous-default-value-test` (4→1) and `dual-cause-diagnostic-named-for-one`
  (3→1): the verifier refutes true-but-subtle test-quality claims with defensible-sounding
  benign explanations (e.g. "the explicit-marker test still pins the value if the default
  changes"). At flash tier the falsifier is a noisy discriminator, not an oracle.
- **FPR**: 0.188 → 0.0625 is a real, large improvement but still above the 0.031 bar. Both
  surviving "false positives" are the same claim on the
  `function-scoped-fixture-avoids-shared-state` control — see Corpus validity below.

## Per-fixture (hits/8; clean rows show FPs/8)

| Fixture | Category | baseline | candidate | verified |
|---|---|---|---|---|
| vacuous-default-value-test | defect | 0 | 4 | 1 |
| format-evadable-absence-guard | defect | 0 | 5 | 5 |
| dual-cause-diagnostic-named-for-one | defect | 3 | 3 | 1 |
| active-skip-marker-left-in-suite | defect | 6 | 7 | 7 |
| shared-module-state-order-dependent-test | defect | 7 | 5 | 4 |
| clean-behavioural-guard | clean | 1 | 2 | 0 |
| clean-rename-only | clean | 0 | 0 | 0 |
| table-driven-consolidation-preserves-coverage | clean | 0 | 0 | 0 |
| function-scoped-fixture-avoids-shared-state | clean | 2 | 4 | 2 |

## Corpus validity flag

Both verified-arm "false positives" are the claim that the control's
`it('allows the second call')` test executes only ONE `allow()` call on a `beforeEach`-fresh
limiter — byte-equivalent to the first test, i.e. a genuinely arguable vacuous test inside a
fixture labeled clean. The verifier's CONFIRM carries a correct causal reconstruction. FPR on
this control partly measures obedience to the charter's do-not-flag list (which the verifier
never sees), not falsity.

## Limitations / next step

The measured verifier is the SAME model in a fresh context — close to the "same model
reconsidering its own claim" trap this stage exists to escape. The design's real test is a
cross-family verifier; it is currently impossible on this OpenRouter account (data-policy
guardrails admit only `deepseek/deepseek-v4-flash-0731`). Prerequisite for the next
measurement: widen the account data policy or provision a second-family credential, then rerun
`scripts/evaluate-verified-publication.mjs verify --model <other-family>` against the same
captured candidate lane shards.
