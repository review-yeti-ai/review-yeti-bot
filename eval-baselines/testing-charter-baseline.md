## Testing-charter evaluation — `tests/fixtures/testing-charter/evaluation-matrix.json`

- Model: `deepseek/deepseek-v4-flash-0731`
- Path: `bounded` (max_tokens=uncapped (production default))
- Repetitions per fixture/arm: 8

| Metric | baseline | candidate |
|---|---|---|
| Detection rate (recall) | 0.525 (95% CI 0.375–0.671) N=40 | 0.600 (95% CI 0.446–0.737) N=40 |
| Anchored rate | 0.600 N=40 | 0.675 N=40 |
| False-positive rate | 0.031 N=32 | 0.281 N=32 |
| Precision (hits / (hits+noise)) | 0.750 | 0.686 |
| SNR ((hits+valid)/noise) | 4.429 | 2.909 |
| Hits / valid suggestions / noise | 21 / 10 / 7 | 24 / 8 / 11 |
| Errored runs | 6/72 (provider_failure: 6) | 16/72 (provider_failure: 11, malformed_response: 5) |
| Findings/run (output-contract breaches) | 0.528 (0 > 3) | 0.597 (0 > 3) |
| Total latency ms, median / P95 | 27062 / 180254 | 53143 / 180255 |
| TTFB ms, median / P95 (measured N) | 1106 / 4154 (N=72) | 1561 / 6642 (N=72) |
| First-content ms, median / P95 (measured N) | 14418 / 79659 (N=70) | 17789 / 82054 (N=63) |
| First-chunk kind (reasoning/content/other) | reasoning 62 / content 10 / other 0 | reasoning 59 / content 13 / other 0 |
| Prompt / completion tokens | 94913 / 50421 | 115347 / 70029 |
| Cost (USD) | 0.024073 | 0.028894 |

### Per-fixture detection

| Fixture | Category | baseline | candidate |
|---|---|---|---|
| vacuous-default-value-test | defect | 0.125 (95% CI 0.022–0.471) N=8 | 0.250 (95% CI 0.071–0.591) N=8 |
| format-evadable-absence-guard | defect | 0.125 (95% CI 0.022–0.471) N=8 | 0.250 (95% CI 0.071–0.591) N=8 |
| dual-cause-diagnostic-named-for-one | defect | 0.500 (95% CI 0.215–0.785) N=8 | 0.875 (95% CI 0.529–0.978) N=8 |
| clean-behavioural-guard | clean | 0.000 (95% CI 0.000–0.324) N=8 | 0.500 (95% CI 0.215–0.785) N=8 |
| clean-rename-only | clean | 0.000 (95% CI 0.000–0.324) N=8 | 0.000 (95% CI 0.000–0.324) N=8 |
| active-skip-marker-left-in-suite | defect | 0.875 (95% CI 0.529–0.978) N=8 | 1.000 (95% CI 0.676–1.000) N=8 |
| shared-module-state-order-dependent-test | defect | 1.000 (95% CI 0.676–1.000) N=8 | 0.625 (95% CI 0.306–0.863) N=8 |
| table-driven-consolidation-preserves-coverage | clean | 0.000 (95% CI 0.000–0.324) N=8 | 0.000 (95% CI 0.000–0.324) N=8 |
| function-scoped-fixture-avoids-shared-state | clean | 0.125 (95% CI 0.022–0.471) N=8 | 0.625 (95% CI 0.306–0.863) N=8 |

