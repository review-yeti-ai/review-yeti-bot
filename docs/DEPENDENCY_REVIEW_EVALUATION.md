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
