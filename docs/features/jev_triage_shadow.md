# Jev triage in shadow mode (REL-1081)

Plan: `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`, section 4, item W4.
Code: `src/review/jevTriageShadow.ts`. It is started from `runPublishingReviewWorker` in `src/cli/publishingReview.ts`.

## What it does

For each changed file in a review run, the worker asks Jev (TypeSafe AI System One) three closed questions:

| Key | Type | Options |
| --- | --- | --- |
| `category` | `choice` | `mechanical_rename`, `formatting`, `generated`, `test`, `config`, `docs`, `source_low_risk`, `source`, `security_sensitive` |
| `risk` | `score` | 5 levels. The written criteria are in `JEV_RISK_CRITERIA`. |
| `lane__<persona id>` | `noul` | One question per enabled persona: should this persona review this file? |

Jev also receives the file path, its extension, the file's hunks, and a set of facts computed in code:

- added and removed line counts
- hunk count
- change kind
- whether the file is a test, docs, a lockfile, generated, or on the security-sensitive path list
- whether the hunks were truncated

Hunks are capped at 12,000 characters per file, and the truncation flag records when the cap was hit. Jev never counts anything itself.

The worker logs Jev's answers. When the panel finishes, it logs them again next to the findings the panel actually produced on each file.

## What it never does

- It never changes the review. The panel request, the published check, every completion callback, and the worker receipt are byte-identical with the flag on or off. `tests/unit/publishingReviewJevShadow.test.ts` pins this.
- It never blocks or slows the review. The triage runs alongside the panel with at most 4 concurrent calls and a maximum of 40 files. All calls share a 15 s client budget, with a 5 s cap per call and 1 retry. A hard deadline of 16 s resolves the triage even if a call ignores its abort signal. The join is the last await in the worker, after the check and all callbacks are published. If the run fails, the `finally` block aborts the triage.
- It never fails closed. The triage fails open when:
  - the flag is off
  - `TYPESAFE_*` is unset or only partly set
  - the client cannot be constructed
  - a call throws
  - Jev returns any `unavailable` reason
  - the answer is malformed
  - the triage times out

  In each case the worker logs the problem and the review runs exactly as before.

## Enabling it

The flag is `REVIEW_YETI_JEV_SHADOW` on the worker. It is off by default.

- `true`, `1`, `on`, `all` or `*` enables it for every repository.
- A comma-separated list of `owner/repo` enables it only for those repositories. Start with `review-yeti-ai/review-yeti-bot`.
- It also needs all four of `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL`, `TYPESAFE_API_KEY` and `TYPESAFE_MODEL_PIN`. If none are set, the triage logs one `jev_triage_shadow_skipped reason=unconfigured` line and does nothing else.

To revert, unset the flag.

In DOKS the Go operator builds the worker Pod env (`k8s-operator/pkg/job/job.go`, REL-1086). Two operator settings control this feature, and both are unset by default:

- `REVIEW_YETI_JEV_SHADOW` is passed to app-gate workers exactly as set. It must not contain spaces, so write an allow-list as `a/b,c/d`.
- `REVIEW_YETI_JEV_SECRET_NAME` names one Secret. The operator copies its four `TYPESAFE_*` keys into the worker as optional secret references. If the Secret is missing, all four are absent and the triage logs `unconfigured`.

## Telemetry

Metrics:

- `review_yeti_jev_requests_total{seam="triage_shadow",outcome}`
- `review_yeti_jev_duration_seconds{seam="triage_shadow"}`
- `review_yeti_jev_input_tokens_total`
- `review_yeti_jev_cost_usd_total`
- `review_yeti_jev_model_pin_mismatch_total`

`JevClient` emits the metrics above. This feature adds two more:

- `review_yeti_jev_triage_shadow_files_total{outcome,category,risk_level}`
- `review_yeti_jev_triage_shadow_join_total{risk_level,finding_class}`

Every structured log line carries `runId`, `repository`, `prNumber` and `headSha`. The `event` field identifies the line:

| `event` | When | Key fields |
| --- | --- | --- |
| `jev_triage_shadow_decision` | Once per file, as each answer arrives | `outcome`, `reason`, `category`, `category_valid`, `category_confidence`, `category_probabilities.*`, `risk_level`, `risk_score`, `risk_confidence`, `risk_probabilities.level_N`, `lanes.<persona>.noul`, `model`, `model_pin`, `model_pin_match`, `input_tokens`, `cost_usd`, `latency_ms`, `facts.*` |
| `jev_triage_shadow_join` | Once per file, after the panel | The answers above plus `panel_mode`, `verdict`, `conclusion`, `findings_total`, `findings_p0`, `findings_p1`, `findings_p2`, `finding_class`, and `lanes.<persona>.{noul,said_yes,ran,applicable,findings,blocking}` |
| `jev_triage_shadow_summary` | Once per run | `status`, `files`, `asked`, `ok`, `outcomes.*`, `input_tokens`, `cost_usd`, `wall_ms`, `models`, `model_pin` |
| `jev_triage_shadow_skipped` | Once per run when the triage did not start | `reason` (`unconfigured`, `misconfigured`, `client_error`, `start_error`) |

`outcome` takes one of these values: `ok`, `unavailable`, `error`, `file_cap` (the file was beyond the 40-file cap), or `not_started` (the run hit the deadline or was aborted first).

## Calibration queries (VictoriaLogs LogsQL)

These are the calibration questions from plan W4, to run after about 7 days of traffic.

How often do files that Jev scored risk 1 or 2 get P0 or P1 findings? The answer bounds how much depth reduction is safe:

```text
event:"jev_triage_shadow_join" outcome:"ok" panel_mode:"panel" risk_level:in(1,2)
| stats by (risk_level) count() files, count() if (finding_class:"blocking") blocking_files
```

For each persona, how often does a file Jev said "no" to still get findings from that persona? The answer bounds lane skipping. Replace `sec-lane` with each persona in turn:

```text
event:"jev_triage_shadow_join" outcome:"ok" panel_mode:"panel" lanes.sec-lane.ran:true lanes.sec-lane.said_yes:false
| stats count() said_no, count() if (lanes.sec-lane.findings:>0) missed
```

Confidence against correctness, used to set thresholds:

```text
event:"jev_triage_shadow_join" outcome:"ok" panel_mode:"panel"
| math round(risk_confidence, 0.1) as conf_bucket
| stats by (conf_bucket, risk_level) count() files, count() if (finding_class:"blocking") blocking_files
```

Availability, latency and cost:

```text
event:"jev_triage_shadow_summary" | stats by (status) count() runs, sum(cost_usd) usd, quantile(0.9, wall_ms) p90_wall_ms
```

Restrict every query to runs where `model_pin_match:true`. Answers from a different model version belong to a different calibration.
