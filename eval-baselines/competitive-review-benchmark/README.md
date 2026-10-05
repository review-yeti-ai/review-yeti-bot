# Actual-runtime review benchmark

This benchmark keeps model-assisted comment verification and code-review discovery as separate tasks. The existing release benchmark remains a deterministic regression simulator; its `expected findings` are synthesized from profiles and are not product-quality evidence.

## Pinned public source

The panel data comes from the Hugging Face [`Alibaba-Aone/aacr-bench` dataset](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench), pinned to dataset revision `47be1d6df1e7faf222cf531587772d92f79fe6b2` with SHA-256 `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86` (Apache-2.0). This dataset revision is separate from the GitHub evaluation-adapter source at [`alibaba/aacr-bench` commit `68a569759289a83654a59d06db2a72910edf0a4a`](https://github.com/alibaba/aacr-bench/tree/68a569759289a83654a59d06db2a72910edf0a4a); this benchmark does not invoke or substitute the adapter's judge. The checked-in manifest contains ten repository-held-out pull requests, one in each of ten languages, with immutable base and head commits. The split is deterministic and happens by repository so no repository appears in both train and held-out data.

AACR-Bench annotates review comments. Its “correct” comments are not an exhaustive list of defects, and a correct comment does not establish P0/P1 severity. Verification results therefore report positive and negative comment agreement separately, with abstention and uncertainty visible. Discovery results can report reference-anchor matches, but unmatched findings remain unjudged. Overall precision stays null until every generated finding receives a separately identified independent judgment; `adjudicatedSubsetPrecision` is a diagnostic over only its explicitly reported denominator and is never presented as overall precision. These annotations cannot establish exhaustive discovery recall.

## Runtime boundary

`competitive-review-benchmark.mjs` has no synthetic provider fallback. `run-verification` calls the production falsification stage and refuses to run without one explicitly selected credentialed transport. The preparer emits a local input file containing only an opaque case id, the review hypothesis, source snapshot data, and source identity. Scoring labels and annotation ids are regenerated from the pinned dataset only by `score-verification`; neither is sent to the model.

The `prepare-*` commands check the pinned public source. The `run-*` commands consume the caller-supplied local JSON and do not re-fetch or independently attest its snapshot contents. Each run receipt records the SHA-256 of the exact prepared-file bytes and marks source verification as preparation-stage-only; preserve that digest with any comparison and assume the local artifact was left unchanged after preparation.

The verifier-only lane proves only comment verification. It does not qualify persona coverage, composed discovery, default engine selection, durable history, or end-to-end publication. A qualifying discovery run must exercise `runPublishingReviewWorker` after WS3 integration is accepted, so the source diff is planned against the effective base policy, the resolved engine is recorded, and coverage, quorum, verifier, history, and review-decision receipts are retained. Each result must identify adapter-only source/dependency seams. A direct `reviewWithModel` call is a lane test only.

The production falsification adapter currently sees the PR diff, not independently retrieved full-file or repository context. A completed request in the File Level or Repo Level stratum is transport evidence only; the scorer reports those rows as not comparable and does not count them as correct or incorrect. The Diff Level stratum is the only context-aligned lane for this adapter. Any source omission makes a verifier case incomplete, including omissions that may be unrelated to its anchor; the omission codes stay in the result, and incomplete cases do not enter qualified metrics. Missing source, unavailable verifier output, and abstention remain incomplete or unknown, never a negative label.

`run-discovery` currently accepts only `--purpose smoke`. It defaults to one pinned PR with a smoke ceiling of two tasks, four total turns, and one turn per task. This checks the production-selected entrypoint and credentialed transport, but deliberately does not qualify discovery quality or authorize a product-budget reduction. The CLI discovery scorer rejects smoke receipts. The composed engine's production configuration is separate: its source defines eight planned tasks, 100 total turns, a four-turn plan phase, 12 turns per single-path task, and up to 18 turns for multi-path tasks; the task ceiling scales by two turns per additional path and reserves up to three terminal turns for a bound result. Policy may narrow these ceilings. Run any baseline/revised comparison with the accepted effective configuration and the same model, policy, source coverage, and resource envelope; report each omitted or exhausted case as incomplete.

## Commands

Generate the fixed public-source panel (source acquisition uses read-only Git fetches and never checks out or executes repository files):

```sh
node scripts/competitive-review-benchmark.mjs manifest \
  --dataset /path/to/aacr-bench-dataset.json \
  --out eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json

node scripts/competitive-review-benchmark.mjs prepare-verification \
  --dataset /path/to/aacr-bench-dataset.json \
  --manifest eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json \
  --cache /tmp/review-yeti-aacr-public-repos \
  --out /tmp/review-yeti-aacr-verification-input.json

node scripts/competitive-review-benchmark.mjs prepare-discovery \
  --manifest eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json \
  --cache /tmp/review-yeti-aacr-public-repos \
  --out /tmp/review-yeti-aacr-discovery-input.json
```

Before `run-verification`, provide the approved provider's gateway settings and secret through process environment. Do not put credentials, gateway URLs, prompts, model responses, or private source data in this repository. Select one transport explicitly when the production model configuration includes more than one.

```sh
node scripts/competitive-review-benchmark.mjs run-verification \
  --runtime-root /path/to/runtime-checkout \
  --transport pr-reviewer \
  --cases /tmp/review-yeti-aacr-verification-input.json \
  --out /tmp/review-yeti-aacr-verification-run.json

node scripts/competitive-review-benchmark.mjs score-verification \
  --dataset /path/to/aacr-bench-dataset.json \
  --manifest eval-baselines/competitive-review-benchmark/aacr-heldout-v1.json \
  --run /tmp/review-yeti-aacr-verification-run.json

node scripts/competitive-review-benchmark.mjs run-discovery \
  --runtime-root /path/to/runtime-checkout \
  --cases /tmp/review-yeti-aacr-discovery-input.json \
  --purpose smoke \
  --max-cases 1 \
  --max-tasks 2 \
  --max-turns-total 4 \
  --max-turns-per-task 1 \
  --out /tmp/review-yeti-aacr-discovery-smoke.json
```

An absent credential, missing dataset/source, unselected route, provider failure, excessive diff, out-of-diff annotation, or abstention remains an incomplete/unknown result; it is never converted into a success or simulated score. Runtime artifacts record request and response-reported model names, whitelisted route hints, hashed request identifiers, HTTP status, fetch-to-response-header time, token usage, and requested effort. For streaming requests this timing ends when headers arrive, not when the model finishes generating; use the runtime's aggregate completion duration for the whole review. Artifacts never serialize gateway URLs, raw request identifiers, prompts, or completions. Response metadata remains unverified unless independently tied to an upstream route.
