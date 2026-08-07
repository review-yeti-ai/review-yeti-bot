# OpenRouter settings (optional)

In `.review-yeti.yaml`, the `openrouter:` block is **optional**. Omit it entirely for defaults.

```yaml
# Optional — all keys optional
openrouter:
  # Pin model+provider for multi-turn persona/moderator/arbiter work
  # via session_id (OpenRouter Auto Router stickiness). Default: true
  session_sticky: true

  # Prefix for generated session ids (max 64 chars). Default: review-yeti
  session_id_prefix: review-yeti

  # Optional Auto Router cost/quality band. Omit for OpenRouter product default.
  # low | medium | high | xhigh | max
  # cost_tier: high

  # Optional raw OpenRouter provider routing policy. This is forwarded as the
  # `provider` request object; use snake_case API field names.
  provider_routing:
    order: [novita, akash]
    allow_fallbacks: false
    require_parameters: true
    sort:
      by: throughput
      partition: none
    max_price:
      prompt: 1

  # DeepInfra is always ignored by the action, even when other providers are configured.
```

Defaults (when section or keys are missing):

| Key | Default |
|-----|---------|
| `session_sticky` | `true` |
| `session_id_prefix` | `review-yeti` |
| `cost_tier` | unset (OpenRouter default) |
| `provider_routing` | unset, except for the enforced `ignore: [deepinfra]` action policy |

Provider models default to `openrouter/auto-beta` (see `DEFAULT_OPENROUTER_MODEL`).  
`openrouter/auto` and `openrouter/auto-beta` are never rewritten into each other.

Docs: https://openrouter.ai/docs/guides/routing/routers/auto-router

Provider routing fields and semantics: https://openrouter.ai/docs/guides/routing/provider-selection
