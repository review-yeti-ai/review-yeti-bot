# Verified publication — three-arm re-measurement (2026-08-21, still NO-SHIP)

**Verdict: NO-SHIP against the pre-stated acceptance criterion; the stage stays config-gated OFF.**
This re-measurement was run to test the hypothesis that the 2026-08-20 run's 19/72 errored rows
(errors count as failures) depressed recall/FPR through provider flakiness that PRs #217
(failover dead providers) and #218 (policy-safe format recovery) have since fixed.

- Corpus: `eval-baselines/verified-publication-fixtures/evaluation-matrix.json` (9 fixtures x 8
  repetitions, 72 rows per arm; defect N=40, clean N=32), model
  `deepseek/deepseek-v4-flash-0731` via OpenRouter, measured 2026-08-21.
- **Lane engine differs from the 2026-08-20 run** and the two measurements are NOT directly
  comparable arm-to-arm: the bounded-investigation harness this eval originally rode on was
  retired on main, so lanes here run the production single-shot `reviewWithModel` path
  (buffered, 300s timeout). Verifier: same model in a fresh context via
  `callFalsificationModelTurn` (the same code path the dormant pipeline stage uses).
- Arms: `baseline` (frozen pre-depth charter), `candidate` (live testing charter), `verified`
  (the same candidate lane rows + `src/review/findingFalsification.js` applied per finding —
  paired, so the verifier's marginal effect is measured on identical hypotheses).

## Acceptance criterion (fixed 2026-08-20, before any measurement)

> recall >= candidate's (then 0.600), FPR <= baseline's measured 0.031, error rate < candidate's 16/72.

## Results

| Metric | baseline | candidate | verified |
|---|---|---|---|
| Detection rate (recall) | 0.525 [0.375-0.671] | 0.475 [0.329-0.625] | **0.275 [0.161-0.428]** |
| False-positive rate | 0.125 [0.050-0.281] | 0.031 [0.005-0.157] | **0.000 [0.000-0.107]** |
| Precision (hits/(hits+noise)) | 0.774 | 0.950 | **1.000** |
| SNR ((hits+valid)/noise) | 4.14 | 26 | **unbounded (0 noise)** |
| Errored runs | 0/72 | 0/72 | 0/72 (verifier added 0) |
| Findings/run | 0.500 | 0.375 | 0.167 |
| Latency median (ms) | 10043 | 9943 | 41872 |
| Cost/72 rows (USD) | $0.0071 | $0.0065 | $0.0083 |

Verifier verdict totals (27 hypotheses on 27 rows): 12 CONFIRM, 6 REFUTE, 9 ABSTAIN — **all 9
abstentions are `verifier_unavailable`**: the stage's hard per-call budget
(`HARD_FALSIFICATION_LIMITS.timeoutMs = 60_000`, not configurable upward by design) is shorter
than this reasoning model's verdict-latency tail, and abstention withholds.

## Reading

- **The error-rate hypothesis was confirmed.** 0 errored rows in 216 (was 14+19+19 across the
  08-20 arms). #217/#218 eliminated the provider-flakiness failure class; the errors criterion
  and the FPR criterion now PASS (verified FPR 0.000 <= 0.031).
- **Recall still fails the bar, and by more, for a different and now clearly-attributed
  reason:** the verifier withheld 15 of 27 hypotheses (6 refuted + 9 timeout-abstained),
  taking paired recall from 0.475 to 0.275 against a bar of >= candidate. One-third of the
  loss is refutations (the adversarial contract working, including on some true detections);
  the larger share is the 60s hard verdict budget colliding with reasoning-model latency.
- The thesis-direction effects remain exactly as designed: FPR 0, precision 1.0, SNR
  unbounded. The stage buys purity and pays recall; under the pre-stated bar that trade still
  loses. If a future revision wants to clear the bar, the measured lever is the verdict
  latency budget (raise the hard cap or stream verdicts), then re-measure — enabling anything
  remains a separate decision gated on that.

Prior measurement (2026-08-20, retired bounded lane engine):
`eval-baselines/verified-publication-three-arm.{md,json}` — preserved unchanged.
