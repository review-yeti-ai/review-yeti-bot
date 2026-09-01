# Provider fixture comparison — 2026-08-31

Status: bounded manual comparison completed. Production routing, review publication, and
scheduled execution were not changed.

## Scope and safety boundary

- All calls used the production `reviewWithModel` request boundary with explicit, single-provider
  transport plans.
- The model was pinned to `deepseek/deepseek-v4-flash-0731` on OpenRouter and to the equivalent
  DeepSeek V4 Flash model on Fireworks.
- Streaming was enabled, reasoning effort was `high`, and the output ceiling was 24,576 tokens.
- No GitHub API reads or writes, comments, check runs, merges, or publication occurred.
- No scheduler, canary, traffic split, operator Deployment, or persistent qualification resource
  was created. Local JSON receipts remain ignored under `artifacts/` and contain only sanitized
  telemetry.

## Direct streaming proof

The three-fixture OpenRouter live proof completed all fixtures in 20.957 seconds. Every response
was HTTP 200, direct JSON, streamed, and contained both content and reasoning:

| Fixture | Terminal | Latency | TTFT | Output tokens | Router attempt |
| --- | --- | ---: | ---: | ---: | ---: |
| harmless-documentation-diff | yes | 4.566s | 5ms | 31 | 1 |
| security-header-validation | yes | 5.190s | 0ms | 145 | 1 |
| error-path-logging | yes | 11.197s | 0ms | 273 | 2 |

This proves the official OpenRouter SDK plus the repository's SSE adapter can complete ordinary
requests. It does not prove quality parity or stable latency on the larger evaluation corpus.

## Same-fixture quality slice

One pass used the same three fixtures for each provider: two seeded defects and one clean control.
The lane deadline was 120 seconds per attempt; a timeout receives one bounded same-route retry.

| Provider | Terminal rows | Defects detected | Clean false positives | Median latency | Slowest row |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenRouter / DeepSeek V4 Flash | 2/3 | 1/2 | 0/1 (the clean row timed out) | 31.425s | 241.022s (two bounded timeout attempts) |
| Fireworks / DeepSeek V4 Flash | 3/3 | 2/2 | 1/1 | 50.005s | 117.403s |

OpenRouter's two successful defect rows returned valid direct JSON on the first attempt. The
vacuous-test finding was semantically relevant but pointed at the source function instead of the
fixture's expected test path, so the structural grader correctly counted it as a miss. The clean
control returned HTTP 200 with no content or reasoning on both attempts and failed closed with
`timeoutKind=total`; it did not become an approval or a false positive.

Fireworks completed all three rows and detected both seeded defects, but it incorrectly reported
two findings on the clean control. Its clean-control response used 14,524 output tokens and took
117.403 seconds, so 100% terminal completion alone is not sufficient evidence of a safe cutover.

## Isolated repeat

The exact OpenRouter clean-control execution was repeated alone with a 45-second per-attempt
deadline. It completed in 42.294 seconds on its first attempt, returned HTTP 200 direct JSON,
and produced an empty findings array. OpenRouter reported router attempt 2 for that success.

This repeat means the stall is intermittent rather than a deterministic fixture failure. The
current evidence is four OpenRouter quality rows total: three terminal successes and one terminal
failure after two bounded attempts (75% observed terminal completion, with a sample too small for
an approval claim). The direct proof is healthy, but the quality slice is not yet safe for a
production provider flip.

## Decision and next bounded gate

Keep production routing unchanged. A code-level semantic-output watchdog is now landed: it
distinguishes “an SSE envelope arrived” from “usable content or reasoning arrived,” and keeps the
TTFT budget active for empty role/metadata envelopes. Timeout receipts also retain bounded
partial-output presence so a future RCA can distinguish an empty stream from reasoning that never
reached a final JSON object.

The next live gate is still manual and receipt-only: three repetitions of the isolated clean
control plus the two defect fixtures, serially, with the same exact model and no fallback. Do not
promote OpenRouter until that run shows 100% terminal completion and the quality thresholds are
reviewed together with the clean-control false-positive result.

## Receipt hashes

The local sanitized receipts used for this evidence were:

| Receipt | SHA-256 |
| --- | --- |
| `openrouter-live-proof-2026-08-31.json` | `dce2c9c832b1d8ce6b2da5a30b840886e9cfca68219ace962d9f608ffefb46f2` |
| `openrouter-quality-lanes-2026-08-31.json` | `3642195d18296c56475f8f29c87348b81ad1d06252350908402a011de0d9b891` |
| `openrouter-clean-repeat-2026-08-31.json` | `3e1f4e399e55bb843d198dc5638459ebaa16de144e40769ddf8599f09171993f` |
| `fireworks-quality-lanes-2026-08-31.json` | `a73a9c871cbba9dcdb4ccd4117b05312fe843c3dc1c8f4d19494e4732c619b86` |

## Post-fix watchdog verification

The semantic-output watchdog and partial-timeout telemetry were landed in PRs #350, #352, and
#353. The parser now keeps TTFT active until non-whitespace content or reasoning arrives, and a
timeout receipt records whether partial content or reasoning was observed before cancellation.

One manual repeat of the same OpenRouter clean control after the final merge completed on its
first attempt:

| Field | Value |
| --- | --- |
| Model | `deepseek/deepseek-v4-flash-0731` |
| Terminal | `true` |
| Latency | 20.998s |
| TTFT | 73ms |
| HTTP status | 200 |
| Output | direct JSON, streamed, 724 completion tokens |
| Content / reasoning present | `true` / `true` |
| Findings | `0` |
| Router metadata | direct, `atl`, attempt 1 |

This is a successful post-fix sample, not a reliability qualification. The next gate remains a
manual three-repetition run over the two defect fixtures and the clean control, serially, with no
fallback or publication. The production route stays unchanged until that larger receipt set is
reviewed.

Final post-fix receipt SHA-256:

`0fd0f9ef503f50521272eef417061ed9f68bdce12e67b2acbe06a0e396056dc3`

## Three-repetition clean-control result

The next bounded gate ran three serial repetitions of the same clean control with the exact
OpenRouter model, no fallback, streaming enabled, a 45-second attempt deadline, and one bounded
retry. It finished within the 15-minute safety window but did not pass the terminal gate:

| Repetition | Terminal | Attempts | Total latency | Terminal outcome | Partial output telemetry |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | no | 2 | 48.530s | timeout, then malformed output | reasoning observed; no final content |
| 2 | no | 2 | 92.254s | timeout, then timeout | reasoning observed; no final content |
| 3 | yes | 2 | 61.816s | timeout, then parsed empty findings | reasoning observed before retry |

All attempts returned HTTP 200. The two failed rows were fail-closed and produced no findings;
the successful retry also produced zero findings. There were no false-positive clean approvals,
but terminal completion was only 1/3 (33%) and every repetition required the recovery path.
The partial-output fields show that these are reasoning-to-final-JSON stalls, not disconnected
requests. This is not safe evidence for an OpenRouter production flip.

The next targeted change is therefore recovery-only: keep the first attempt at the configured
high reasoning effort, but disable optional reasoning on the single timeout retry so the retry
reserves its bounded output budget for the required JSON object. This remains a same-route,
receipt-only experiment until a new fixture run proves it.

Three-repetition receipt SHA-256:

`17778b12184cfcac467e8e960122888dfe749b8d4619011c7dd0923518ef941f`

## Full fixture result after reasoning-disabled recovery

After PR #356, the same exact OpenRouter model was run against the two seeded defects and the
clean control, three serial repetitions each. The lane kept the first attempt at high reasoning,
used a 45-second per-attempt deadline, and allowed only one same-route retry with optional
reasoning disabled. No fallback, publication, or GitHub write was enabled.

| Fixture | Terminal | Detector result | Clean false positives | Recovery use | Latency range |
| --- | ---: | ---: | ---: | ---: | ---: |
| `active-skip-marker-left-in-suite` | 3/3 | 3/3 detected | — | 0/3 | 3.372–10.163s |
| `vacuous-default-value-test` | 3/3 | 1/3 detected | — | 3/3 | 55.665–69.170s |
| `clean-behavioural-guard` | 3/3 | — | 0/3 | 3/3 | 46.196–47.186s |

The aggregate terminal result is 9/9 (100%), with 4/6 seeded defects detected (67%) and 0/3
clean false positives. Every clean row and every vacuous-defect row first timed out while
optional reasoning was enabled; the retry then returned a directly parsed JSON object. The
active-marker defect completed on the first attempt each time. This confirms that the bounded
retry restores terminal output, but it also makes the latency and recall tradeoff explicit: the
vacuous defect remains inconsistent and the clean path pays roughly 46–47 seconds while waiting
for the first attempt to expire.

This is evidence for a safer recovery mechanism, not approval to promote OpenRouter. Keep the
production route unchanged until a quality-focused follow-up improves the vacuous-defect recall
without weakening the clean-control result or the 15-minute job bound.

Full nine-row receipt SHA-256:

`3c00510d3ad2c8c47e6d5f51053b72855b4df79b86c742cb9d9da117acbe9bbd`

## GLM reasoning-capability recovery result

The same nine-row gate was also run against `z-ai/glm-5.3-flash`. Before the capability-aware
change, every timeout recovery attempted `reasoning: { effort: "none" }`; this model rejected
that request with HTTP 400 because reasoning is mandatory. The new recovery policy keeps required
reasoning at low effort for GLM Flash (or any transport explicitly marked
`reasoning_required=true`).

| Model | Terminal | Seeded defects detected | Clean false positives | Recovery attempts | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `z-ai/glm-5.3-flash` | 8/9 | 6/6 | 2/3 | 3/9 | no reasoning-disabled 400s; one retry returned HTTP 500 |

The compatibility defect is fixed: the recovery request now respects the endpoint's reasoning
contract. This is not a model promotion result, however. The clean-control false-positive rate
and the remaining transient 500 mean GLM stays qualification-only while the production route is
unchanged.

GLM capability-recovery receipt SHA-256:

`ff2b099a55d75995f0bb858ca4b81006f1d9e0bba9f8d6691486283134f93cfd`

## Remaining-blocker RCA and bounded 5xx recovery

The GLM receipt exposed two separate problems, not one:

1. The transport sequence `HTTP 200 stream timeout → recovery request → HTTP 500` exhausted
   the fixed two-attempt envelope. The second response was classified correctly as `http_5xx`,
   but there was no remaining attempt, so a transient gateway error became a terminal review
   error.
2. The clean-control findings were valid semantic counterexamples to the fixture's
   literal-token assertion (bracket access, `run:` checkout, and environment indirection), not
   malformed JSON or a disconnected stream. The fixture is labelled clean even though its
   implementation does not enforce the property described in its comment. Suppressing these
   findings would be test hacking; GLM therefore remains quality-blocked until the corpus is
   independently adjudicated or the implementation is corrected.

The transport fix is intentionally narrow. After a recovery has already been attempted, an
OpenRouter 5xx may use exactly one additional retry. That retry is capped at 30 seconds (or the
lower configured transport timeout), honours a bounded `Retry-After`, preserves the model's
reasoning capability, and remains fail-closed if it cannot produce canonical findings JSON. The
normal two-attempt envelope is unchanged for healthy requests, direct providers, and ordinary
format recovery; the action still has no scheduler or canary path.

The regression test reproduces both observed sequences: timeout → 500 → parsed response, and
500 → 500 → parsed response. The focused model, OpenRouter contract, failover, rate-limit, and
charter suites pass 114/114 tests. A fresh three-row GLM clean-control receipt completed 3/3
terminally, but produced the same semantic finding on all three rows (1/3, 1/3, and 1/3
findings). That confirms the remaining quality blocker is reproducible model/corpus semantics,
not the transport 500 path.

Production routing and the deployed image remain unchanged. The next promotion gate is a
human-adjudicated corpus decision plus a full, manual GLM fixture run showing no unaccepted clean
findings; until then, keep DeepSeek/GLM qualification-only and do not flip the review action.

Bounded clean-control receipt SHA-256:

`5081a4157d198132b3085f53cf10d6375567581cdfb1a5d08fe8c68c7898610c`

The follow-up full matrix run used the same exact GLM route, three serial repetitions per fixture,
and the same 45-second per-attempt bound. It completed all 39 rows with no terminal errors:

| Metric | Result |
| --- | ---: |
| Terminal rows | 39/39 |
| Seeded defect rows detected | 20/21 (95.2%) |
| Clean rows with findings | 4/18 (22.2%) |
| First-attempt timeouts recovered | 3 |
| Output-contract breaches | 0 |
| Median / P95 row latency | 11.787s / 60.721s |
| Measured provider cost | $0.009097 |

Only three rows needed timeout recovery; all three recovered to canonical JSON. No HTTP 5xx was
observed in this sample, so the new 5xx branch remains covered by the deterministic regression
tests rather than being presented as a live provider-rate estimate. The terminal blocker is
resolved, but the 4/18 clean findings (three from the behavioural-guard control and one from the
per-key isolation control) still prevent a GLM quality promotion.

A generic scope-boundary instruction was tested against the two affected clean controls. It did
not change the result (4/6 clean rows still carried the same concrete findings), so it was not
retained. This preserves recall and avoids teaching the reviewer to ignore real semantic coverage
gaps merely to improve a benchmark label.

Scope-boundary experiment receipt SHA-256:

`2b7a637ff1c0ceb7cb0dbe9c977a1e7f557fcd678b2d2ac2c7484ceddd3f2c8c`

Full-matrix receipt SHA-256:

`1d8161cc40f5c69d4c69638671ca0c9cf65c4697746d3f0e8d11c8fa24187107`
