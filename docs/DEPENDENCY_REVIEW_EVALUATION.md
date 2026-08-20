# Dependency Review Evaluation

Review Yeti's bounded dependency investigation is evaluated in two stages.

## Deterministic contract gate

Run:

```bash
npm run test:dependency-eval
```

The matrix at `tests/fixtures/dependency-evaluation.json` contains 16 labeled fixtures:

- eight seeded dependency faults;
- four clean controls;
- four evidence-boundary cases, including missing, excluded, oversized, and rejected evidence.

The evaluator runs three repeated baseline/candidate comparisons. The baseline models the legacy findings-only parser, which ignored `review_status` and `evidence_requests`. The candidate applies the bounded evidence adapter and fail-closed arbitration.

This gate proves orchestration and boundary behavior only. It is not a claim about LLM defect recall because the fixture responses are controlled inputs.

## Live promotion gate

Promotion requires a separate provider-backed run using the same model and configuration for both arms. Record, per fixture and repetition:

- seeded-fault recall and correct finding path;
- clean false-positive rate;
- unsafe `SHIP` when required evidence is unavailable;
- valid evidence-request rate;
- correct post-evidence decisions;
- unnecessary follow-ups;
- reported input/output tokens, provider cost, wall-clock latency, and p95 latency.

Keep the feature default-on only when all of these hold:

- zero unsafe `SHIP` outcomes on evidence-boundary cases;
- at least a 15-point recall improvement or two additional seeded defects found;
- at least 90% valid evidence requests and post-evidence decisions;
- clean false-positive rate no more than five points worse than baseline and no higher than 10%;
- total cost no higher than 1.30x baseline;
- p95 latency no higher than 1.50x baseline.

The deterministic command reports `promotionReady: false` until live cost and latency receipts are supplied.

## Provider-backed evaluation

> **Currently broken, pending a port.** `npm run test:dependency-live-eval` (`scripts/
> evaluate-dependency-investigation-live.mjs`) drove both arms through `reviewWithModel`'s legacy
> single-shot findings/`evidence_requests` contract, which was deleted along with the rest of the
> legacy single-shot review path -- there is no "legacy baseline" left to compare against, and the
> bounded engine's evidence model is tool-based (`file_read`/`file_read_diff`/`code_search`/
> `library_docs`), not the path+kind+reason dependency-evidence shape this evaluator measures.
> Whether dependency evidence becomes a first-class bounded evidence tool, or this evaluator is
> retired in favor of the general evidence-tool-based engine, is an open product decision. The
> script fails fast with an explicit message rather than a generic crash; do not run it expecting
> a result. The deterministic contract gate above (`npm run test:dependency-eval`) is unaffected.

Run only with an explicitly provisioned review-fleet key:

```bash
npm run test:dependency-live-eval
```

The live runner uses the configured dependency persona and model, reuses the same first-turn result for the legacy baseline, and charges only the candidate's bounded follow-up when evidence is available. It writes no GitHub comments and does not run as part of CI. A nonzero result means the promotion thresholds were not met; it is not permission to merge automatically.

### Current pilot receipt

On 2026-08-11, a three-fixture, one-repetition pilot using the review-fleet key and `deepseek/deepseek-v4-flash-0731` completed with these results:

| Arm | Expected-decision accuracy | Fault recall | Unsafe `SHIP` | Tokens | Cost | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy baseline | 66.67% | 100% | 100% | 5,641 | $0.000966 | 16.725s |
| Candidate | 100% | 100% | 0% | 5,641 | $0.000966 | 16.725s |

The pilot is safety evidence for the missing-lockfile case, not a promotion result: it is too small to establish recall or cost/latency thresholds, and the full 16-fixture × 3-repetition run remains pending.
