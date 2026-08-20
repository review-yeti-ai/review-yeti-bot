# OpenRouter settings (optional)

OpenRouter settings are optional and must come from the trusted PR-base configuration. The
canonical location is `github_action.openrouter`; the top-level `openrouter` block remains a
compatibility alias. Omit both for defaults.

```yaml
# Optional — all keys optional
github_action:
  openrouter:
    model: openrouter/auto-beta
    allowed_models: [openrouter/auto-beta]
    fallback_models: [deepseek/deepseek-v4-flash-0731]
    timeout_ms: 30000
    data_collection: deny
    cost_quality_tradeoff: 5
    ignore_providers: []
    # Optional raw OpenRouter provider routing policy. This is forwarded as the
    # `provider` request object; use snake_case API field names. Omitting it uses
    # the production default shown in the table below.
    provider_routing:
      order: [examplecloud]
      allow_fallbacks: false
      require_parameters: true
      sort:
        by: throughput
        partition: none
      max_price:
        prompt: 1
```

Defaults (when section or keys are missing):

| Key | Default |
|-----|---------|
| `model` | `openrouter/auto-beta` |
| `fallback_models` | empty |
| `timeout_ms` | `30000` |
| `provider_routing` | `allow_fallbacks: true`, `require_parameters: true`, `quantizations: [fp16, bf16]`, `sort: throughput`, `preferred_min_throughput: {p90: 40}`, `preferred_max_latency: {p99: 3}` |

Provider models default to `openrouter/auto-beta` (see `DEFAULT_OPENROUTER_MODEL`).
`openrouter/auto` and `openrouter/auto-beta` are never rewritten into each other.

## Supported YAML keys and precedence

| YAML key | Meaning | Default |
| --- | --- | --- |
| `model` | Default model when no action input overrides it | `openrouter/auto-beta` |
| `allowed_models` | Model allowlist | empty (no additional allowlist) |
| `fallback_models` | Ordered fallback models for transient failures | empty |
| `structured_output` | Optional `strict` JSON Schema contract; unsupported providers fail closed | unset |
| `timeout_ms` | Per-request timeout, clamped to `500..600000` | `30000` |
| `data_collection` | Provider data-collection header policy: `allow` or `deny` | unset |
| `cost_quality_tradeoff` | Auto Router quality/cost band, `0..10` | unset |
| `ignore_providers` | Optional provider slugs to ignore | `[]` |
| `provider_routing` | Validated OpenRouter provider-selection object | fallbacks enabled; FP16/BF16 full precision; throughput sorting; p90 throughput at least 40 tokens/s preferred; p99 latency at most 3 seconds preferred |

Precedence is: explicit Action input/environment, trusted `github_action.openrouter` YAML, then
defaults. Action inputs cannot select an untrusted configuration ref. `provider_routing` accepts
`order`, `only`, `ignore`, `quantizations`, `allow_fallbacks`, `require_parameters`,
`data_collection`, `zdr`, `enforce_distillable_text`, `sort`, throughput/latency preferences, and
`max_price`; unknown fields fail closed. See the [canonical YAML example](YAML_CONFIGURATION_EXAMPLES.md#recommended-production-configuration).

The throughput and latency settings are OpenRouter preferences based on endpoint percentile
statistics, not a literal uptime guarantee. Latency values are measured in seconds. The default
policy injects no endpoint blocklist; OpenRouter remains responsible for endpoint eligibility.

## Fixed model/provider compatibility

The action keeps fixed-model compatibility explicit and validates it before persona fan-out. The
current registry includes `openai/gpt-5.6-luna`, which is approved for the `openai` and `azure`
provider slugs. A policy such as `only: [examplecloud]` therefore fails early for Luna with an actionable
error; it is not treated as evidence that the model was retired. The validator never removes an
`ignore`, `data_collection`, `zdr`, or `require_parameters` restriction and never enables a
fallback to make an incompatible policy work.

## Strict structured output

Set `structured_output: strict` only in trusted base configuration after a canary proves that the
selected fixed model and closed provider cohort support JSON Schema responses. The action sends a
bounded `review_investigation` JSON schema for evidence-investigation turns and sets
`provider.require_parameters: true`; it does not broaden routing or accept a provider that ignores
the schema. The local investigation parser still validates every identifier, dispatch assignment,
evidence receipt, and final disposition, so schema-valid semantic violations remain a blocking
incomplete lane.

If a consumer has approved OpenAI/Azure for Luna, route it explicitly:

```yaml
github_action:
  openrouter:
    model: openai/gpt-5.6-luna
    provider_routing:
      only: [openai, azure]
      allow_fallbacks: false
      # Keep the repository's existing data-policy and ignore settings here.
```

If the consumer must remain ExampleCloud-only, choose a model that the ExampleCloud provider serves instead.

Docs: https://openrouter.ai/docs/guides/routing/routers/auto-router

Provider routing fields and semantics: https://openrouter.ai/docs/guides/routing/provider-selection
