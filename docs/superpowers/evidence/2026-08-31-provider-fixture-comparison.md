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

Keep production routing unchanged. The next improvement should be a code-level semantic-output
watchdog: distinguish “an SSE envelope arrived” from “usable content or reasoning arrived,” and
abort a stream that has produced only an empty role/metadata envelope within a shorter bounded
window. The watchdog must preserve the existing one-retry/fail-closed contract, emit a distinct
telemetry timeout kind, and be covered by deterministic stream tests before another live run.

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
