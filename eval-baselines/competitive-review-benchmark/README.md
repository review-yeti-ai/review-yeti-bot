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

`run-discovery --purpose smoke` remains a transport and lane check. It defaults to one pinned PR with a smoke ceiling of two tasks, four total turns, and one turn per task. It cannot produce a quality score or justify a product-budget reduction.

The full-envelope modes are `baseline` for the pinned v1 runtime and `qualification` for an accepted revised runtime. Both require a clean exact runtime commit, a fixed explicit case-ID list, the `pr-reviewer` route alias, and one of the checked-in policy projections. V1 policy source is commit `216d33cd75605d97b0e0b8becb7457ce7e326ecd` (raw policy SHA-256 `fc8fca2983de662b9ae13269c4085dce07ba3ecf71e1375bc7ce8f9ffd0ee3f2`). The projection file hashes are recorded in each receipt and checked by the runner. They are local benchmark inputs, not authenticated service admission or proof of deployed settings.

The composed runtime resolves its own budget: up to eight tasks, 100 total turns, a four-turn plan phase, 12 turns for a single-path task and up to 18 for multi-path tasks. Each additional path adds two turns, up to a six-turn increase; up to three task turns are reserved for finalization within that task ceiling. Task concurrency is capped at three. The independent grounded coverage manifest has a separate ceiling of 24 source assignments. The policy's separate `max_investigation_turns: 20` remains in the requested config receipt; the composed turn resolver does not use that field. Revised qualification reserves 12 investigation-turn units for independent verification, leaving up to 88 discovery-turn units. This is turn accounting, not a claim about physical provider-request count; token and request telemetry are reported separately. V1 baseline has no independent verifier. The output keeps both resource profile and effective configuration receipts so comparisons do not hide this difference. V1 policy requests `reviewer_effort: medium`, but the old composed provider request omits the transport-level reasoning effort; `native_omitted` records the request actually sent. A separate v1 run with `--effort-profile medium --effort-injection medium` is an adapter-controlled effort ablation, not native v1 behavior. Revised qualification uses the medium projection and requires the real WS3 verifier receipt.

The public fixed panel currently has seven text-source-complete cases, one binary-only case suitable only for a separately labeled text-scope diagnostic, and two cases with unavailable pinned source. Use only the seven complete IDs below for a text-source discovery subset. Any full-panel run with incomplete or diagnostic cases is marked `ABSTAIN` and receives no quality score. Public AACR comment labels do not establish exhaustive discovery truth; even a complete seven-case run is only input to separate blind adjudication. The public adapter has no authenticated service-owned PR lifecycle history source, which is disclosed in each run receipt; these results do not qualify history behavior. Synthetic lifecycle fixtures are a separate deterministic feature-acceptance lane.

Do not use a revised runtime candidate whose exact-head hosted checks have failed or remain pending. The benchmark runner requires a clean SHA, but source checks and independent review must also have accepted that exact revision before it is used.

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

After the selected runtime head passes independent review and normal hosted checks, the same prepared input supports a bounded full-envelope comparison. The public panel IDs below select the seven complete-source cases; the other three are disclosed in the run receipt and excluded from this explicitly named subset.

```sh
CASE_IDS='aacr-c-12718,aacr-csharp-24910,aacr-cpp-20825,aacr-go-12185,aacr-php-15217,aacr-python-6044,aacr-rust-3414'

# Actual v1 native-effort baseline. Replace the runtime path with a clean checkout at this exact SHA.
node scripts/competitive-review-benchmark.mjs run-discovery \
  --runtime-root /path/to/runtime-at-e70749fd4b14cb284b1497974306975cbce2d47a \
  --expected-runtime-sha e70749fd4b14cb284b1497974306975cbce2d47a \
  --cases /tmp/review-yeti-aacr-discovery-input.json \
  --case-ids "$CASE_IDS" \
  --purpose baseline \
  --policy-file eval-baselines/competitive-review-benchmark/policy-projections/yeti-v1-native-omitted.json \
  --effort-profile native_omitted \
  --verifier-mode none \
  --out /tmp/review-yeti-aacr-v1-native-baseline.json

# Revised medium-effort qualification. Use only an accepted, clean, exact current runtime SHA.
node scripts/competitive-review-benchmark.mjs run-discovery \
  --runtime-root /path/to/accepted-revised-runtime \
  --expected-runtime-sha <accepted-40-character-runtime-sha> \
  --cases /tmp/review-yeti-aacr-discovery-input.json \
  --case-ids "$CASE_IDS" \
  --purpose qualification \
  --policy-file eval-baselines/competitive-review-benchmark/policy-projections/yeti-v1-medium.json \
  --effort-profile medium \
  --verifier-mode production \
  --out /tmp/review-yeti-aacr-revised-medium.json
```

For a controlled effort comparison, run the baseline again with the medium projection and `--effort-injection medium`; the receipt labels that request as benchmark-adapter-injected. Do not call the v1 native run and this controlled ablation equivalent. Revised qualification refuses smoke budget overrides, missing verifier receipts, altered policy projections, dirty or mismatched runtime trees, and prefix selection such as `--max-cases`.

An absent credential, missing dataset/source, unselected route, provider failure, excessive diff, out-of-diff annotation, or abstention remains an incomplete/unknown result; it is never converted into a success or simulated score. Runtime artifacts record request and response-reported model names, whitelisted route hints, hashed request identifiers, HTTP status, fetch-to-response-header time, token usage, and requested effort. For streaming requests this timing ends when headers arrive, not when the model finishes generating; use the runtime's aggregate completion duration for the whole review. Artifacts never serialize gateway URLs, raw request identifiers, prompts, or completions. Response metadata remains unverified unless independently tied to an upstream route.
