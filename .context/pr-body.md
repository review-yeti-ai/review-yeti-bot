## The failure

Every review run whose winning transport was **not** OpenRouter died before producing a verdict:

```
[Review Yeti smoke] fireworks: healthy elapsed_ms=1044 http=200 ttft_ms=523
[Review Yeti smoke] ollama: healthy elapsed_ms=4705 http=200 ttft_ms=4522
[Review Yeti smoke] openrouter-fallback: healthy elapsed_ms=1646 http=200 ttft_ms=960
[Review Yeti smoke] resolved_transport=fireworks

Fatal error during review pipeline execution:
Error: OpenRouter review policy base url must normalize exactly to https://openrouter.ai/api/v1
Review Yeti did not produce a verdict; an earlier workflow step failed
```

All three transports healthy, `resolved_transport=fireworks`, **no `DEGRADED` marker** — Fireworks is the intended primary, not a fallback. So this was not an outage or a flake; it was the normal path.

## Why

`ct-review-actions/.github/workflows/review-yeti.yml` hands the winning transport's base url to the action as the generic `llm-base-url` input. `action.yml` maps that onto the env var `OPENROUTER_BASE_URL` — which is where the confusion starts, because that name implies an OpenRouter url when it now carries whichever transport won.

`resolveActionReviewRuntime` then called `resolveOpenRouterReviewPolicy` **unconditionally**, and `validateOpenRouterReviewPolicy` requires `base_url` to normalize exactly to OpenRouter's. Fireworks' base url therefore threw, and the throw happened before any lane ran.

Everything in `openrouter-policy.js` — the auto-router plugin, the canonical five-model allow-list, the `data_collection` provider block — is OpenRouter-specific. The bug is that it was being applied transport-agnostically.

## The fix

Scope the OpenRouter policy to OpenRouter transports. Two places:

1. **`resolveActionReviewRuntime`** — build the policy only when the effective transport's base url really is OpenRouter. Otherwise keep the resolved transport's own `baseUrl`/`model` (previously both were overwritten with the policy's values) and attach no policy. The decision is pushed into `runtime.notes` rather than being silent.

2. **Request construction** — `requestOptions.plugins` / `requestOptions.provider` (derived from the OpenRouter policy) were used as a fallback for *every* transport, so OpenRouter-only fields were being posted to Fireworks/Ollama/Anthropic. They are now only applied when that specific transport is OpenRouter. A transport's own `plugins`/`provider` still win, unchanged.

New `isOpenRouterBaseUrl()` compares **hosts**, not prefixes, so `https://openrouter.ai.evil.example/api/v1` is correctly *not* OpenRouter.

## The validator is not weakened

This changes **which runs are policy-checked**, never **how strictly**. Two tests pin that:

- a url with the right host but wrong path (`https://openrouter.ai/api/v2`) is admitted to the OpenRouter path and **still rejected** by the exact-url validator — so the predicate is not a bypass;
- a look-alike host is **not** promoted onto the OpenRouter path.

Real OpenRouter runs still get the full policy: exact base url, `data_collection: deny`, canonical allowed models, and a policy fingerprint.

## Verification

`npx vitest run tests/unit/reviewPipelineDispatch.test.ts tests/unit/transportFailover.test.ts` — **43 passed**.

Mutation proof:

| Mutation | Result |
|---|---|
| resolve the OpenRouter policy unconditionally (the original bug) | **4 failed** |
| let OpenRouter `plugins`/`provider` fall back onto any transport | **1 failed** |
| restored | 43 passed |

Related suites green: `openRouterPolicy` + `actionPolicyContract` + `openRouterClient` — 47 passed.

Full unit suite: 2239 passed, 1 failed — `tests/unit/lib/modelFiltering.test.ts > correctly resolves provider ID for various model names`. That failure **reproduces on a clean tree with my changes stashed**, so it is pre-existing and unrelated.

Note on the first draft of these tests: an earlier assertion tried to prove the validator still rejects a bogus url injected via trusted config, but the env overlay legitimately takes precedence over trusted config, so nothing threw. The test premise was wrong, not the code; it was replaced with the right-host/wrong-path case above, which is a sharper guard anyway.
