# OpenRouter SSE reliability and qualification plan

## Objective

Make OpenRouter observable and bounded enough to qualify as a possible production route without
changing the current review route. The action must consume the provider's streaming response as
SSE, distinguish connection/TTFT/inactivity/total failures, and retain only safe diagnostic
metadata. Qualification remains manual, non-publishing, and capped at 15 minutes.

## Safety boundary

- Production order is unchanged: Ollama, Fireworks, then OpenRouter fallback.
- No canary, scheduled probe, traffic split, automatic activation, or provider-order mutation.
- Changes land in the bot and central policy repositories independently; no parent gitlink update
  is implied.
- A quality result cannot override an incomplete or unattributed terminal result.
- A future activation is a separate, explicit decision after exact-head review and rollback proof.

## Execution ledger

- [x] Replace buffered qualification parsing with an incremental SSE reader using
  `ReadableStream.getReader()` and `TextDecoder`; negotiate `Accept: text/event-stream`, handle
  fragmented events, comments/keepalives, `[DONE]`, and a bounded compatibility case for
  providers that omit an event separator.
- [x] Apply separate connection, TTFT, inactivity, and total request budgets. Cancel the reader
  on every timeout and keep the child hard deadline below the workflow's 15-minute cap.
- [x] Make the hosted action use the same SSE semantics and preserve OpenRouter's
  `reasoning_details` alongside legacy reasoning fields.
- [x] Emit `X-OpenRouter-Metadata: enabled` and capture only bounded, hashed router metadata in
  receipts and response-attempt telemetry.
- [x] Carry the explicit 30-second TTFT contract through policy, handoff, and receipt integrity
  checks; keep the existing transport order.
- [x] Route OpenRouter chat completions through the pinned official `@openrouter/sdk` client and
  HTTP client, with SDK retries disabled so review-pipeline retry and 15-minute deadline policy
  stays authoritative; keep the existing CommonJS action artifact and production order.
- [x] Add deterministic unit/contract coverage for delayed first data, keepalives, fragmented
  frames, reasoning details, metadata, and timeout classification.
- [x] Run a manual one-fixture OpenRouter-only probe, serially, with a 10-minute child hard kill
  and a 15-minute workflow maximum. Record request fingerprint, model, route policy, TTFT,
  inactivity, total timeout, attempts, terminal status, and sanitized router metadata. The
  2026-08-28 proof run [33193664445](https://github.com/review-yeti-ai/review-yeti-bot/actions/runs/33193664445)
  ran on merged `46abe269`, completed one streamed request in 1.9 seconds (TTFT 295 ms),
  returned HTTP 200 and a parseable response on the first attempt, and recorded no retry or
  failure. This is transport evidence only; it does not authorize production activation.
- [ ] Repeat with three fixtures only if the one-fixture probe has 100% terminal completion and
  complete attempt attribution. Keep this probe evidence-only and non-publishing.
- [ ] Run separate direct-fixed-model and Auto Router/provider-routing comparisons. Keep model,
  prompt, stream mode, deadlines, and fixture order identical within each comparison; do not claim
  provider equivalence across different sampler or route policies.
- [ ] Compare recall, false positives, malformed recovery, TTFT, p95 latency, and usage/cost
  completeness only after terminal reliability passes. Treat missing usage/cost as unknown, not
  zero.
- [ ] Review the receipts and rollback procedure manually. Only then decide whether to propose a
  production-order change in a separate protected change.

## Latest bounded proof

The receipt from run [33193664445](https://github.com/review-yeti-ai/review-yeti-bot/actions/runs/33193664445)
is `openrouter-live-proof-v1`: `terminal=true`, `publication=none`, `failover=disabled`,
`schedule=manual-only`, requested model `openrouter/auto`, resolved route
`moonshotai/kimi-k2.6`, `responseMode=stream`, `finishReason=stop`, `outputShape=direct_json_object`,
and one parsed attempt. The policy fingerprint is recorded and the router metadata is limited to
strategy, region, and attempt. No credential-like strings were present in the downloaded receipt.
One successful fixture proves the SDK/SSE connection path; it does not establish provider quality or
long-run reliability. The three-fixture qualification remains intentionally pending.

## Acceptance gates

1. All focused bot and central tests pass, including lint/type checks and `git diff --check`.
2. SSE tests prove first-data TTFT is measured from the first `data` event, not headers or
   keepalives, and that active streams cannot run past the total deadline indefinitely.
3. The manual probe is serial, one transport, no publication, no failover, no schedule, and
   terminates within 15 minutes.
4. Every attempted request has a provider/transport attribution and a terminal classification;
   any gap blocks quality interpretation.
5. No production routing, caller contract, action release channel, or secret material changes in
   this plan.
