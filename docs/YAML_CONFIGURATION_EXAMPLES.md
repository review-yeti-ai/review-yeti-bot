# YAML configuration examples

`.review-yeti.yaml` is read from the trusted pull-request base ref. The pull-request head cannot
change providers, endpoints, credentials, reviewer policy, memory domains, or trust settings for
the run. Action inputs may disable features or reduce limits, but cannot widen this file.

This page is the copy-and-edit starting point. The [configuration reference](CONFIGURATION_REFERENCE.md)
contains the field-by-field contract and compatibility notes.

## Recommended production configuration

```yaml
version: 4

# Whole-review and per-file safety limits.
limits:
  max_diff_bytes: 1000000       # legacy whole-diff budget name; Action clamps the effective budget
  max_file_diff_chars: 5000     # complete per-file diff cap; oversized files are reported
  max_prompt_tokens: 60000      # receipt/policy ceiling
  max_completion_tokens: 8000   # receipt/policy ceiling
  max_cost_usd: 5               # receipt/policy ceiling
  max_turns: 20
  max_concurrency: 12

# Submodules are metadata-only by default and must be pinned.
submodules:
  mode: metadata_only           # ignore | metadata_only | recursive
  max_depth: 1
  max_files: 500
  require_pinned_commit: true
  missing_access: block          # block | metadata_only
  allowed_hosts: [github.com]
  allowed_repositories: []
  url_change: block              # block | review

# Extra exclusions. Prefix with ! to restore a built-in exclusion.
exclude:
  - '**/generated/**'
  - '**/*.min.js'
  - '!src/generated/handwritten/**'

# Coverage is binding: partial/incomplete coverage never becomes merge-eligible.
coverage_policy:
  quorum: two_thirds             # two_thirds | simple_majority | unanimous
  min_personas: 3
  mandatory_personas: [security]
  provider_diversity_min: 1

personas:
  - id: security
  - id: performance
  - id: architecture
  - id: testing
  - id: dependencies
  - id: tenancy
    name: Multi-Tenant Isolation
    charter: |
      Verify every customer-data query is scoped by the authenticated tenant.

# One API-backed memory provider per run. GitHub remains authoritative.
memory:
  enabled: true
  provider: honcho               # honcho | mem0 | hindsight | supermemory | retaindb
  mode: single
  transport: mcp                 # mcp | rest | auto (auto is diagnostic only)
  fallback: github_ledger_only
  contract: memory-provider-v1
  same_pr_decisions: true
  session_recap: true
  context: true                  # perform the bounded provider read
  write: true                    # persist normalized events after publication
  max_entries: 40
  max_prompt_chars: 8000
  maintainer_commands: true
  query:
    timeout_ms: 1500
    max_context_chars: 4000
    max_entries: 40
  recall:
    decision_feedback: true
    session_recap: true
    code_signals: true
    rule_signals: true
  persist:
    processing: true
    decision_feedback: true
    session_recap: true
    code_signals: true
    rule_signals: true
  providers:
    honcho:
      enabled: true
      transport: mcp
      endpoint_env: HONCHO_URL
      credential_env: HONCHO_API_KEY
      workspace_env: HONCHO_WORKSPACE_ID
    mem0:
      enabled: false
      transport: rest
      endpoint_env: MEM0_URL
      credential_env: MEM0_API_KEY
      namespace_env: MEM0_NAMESPACE
    hindsight:
      enabled: false
      transport: rest
      endpoint_env: HINDSIGHT_URL
      credential_env: HINDSIGHT_API_KEY
    supermemory:
      enabled: false
      transport: rest
      endpoint_env: SUPERMEMORY_URL
      credential_env: SUPERMEMORY_API_KEY
    retaindb:
      enabled: false
      transport: rest
      endpoint_env: RETAINDB_URL
      credential_env: RETAINDB_API_KEY

# Optional documentation lookup. A secret is still required.
mcp:
  context7:
    enabled: false
    libraries: [github-actions, node.js]
    max_snippets: 5

# Optional deterministic compaction of untrusted memory/documentation context.
review:
  context:
    compaction:
      enabled: false
      max_bytes: 8000
      summary_bytes: 2000
      frozen_overflow: fail
  units:
    enabled: false
    generated_patterns: []
    vendor_patterns: []
    allow_waived: false
  finding_verifier:
    mode: report_only             # report_only | enforce

# Optional exact-base OpenTelemetry export. Values come from named environment variables.
telemetry:
  otel:
    enabled: false
    endpoint_env: REVIEW_YETI_OTEL_TRACES_ENDPOINT
    credential_env: REVIEW_YETI_OTEL_BEARER_TOKEN

# OpenRouter model/routing policy. `github_action.openrouter` is canonical; `openrouter` is a
# compatibility alias. Action inputs win over this block and are still bounded by trust policy.
github_action:
  openrouter:
    model: openrouter/auto-beta
    allowed_models: [openrouter/auto-beta]
    fallback_models: [deepseek/deepseek-v4-flash-0731]
    timeout_ms: 30000
    stream: false
    data_collection: deny       # allow | deny
    cost_quality_tradeoff: 5    # 0..10
    ignore_providers: [deepinfra]
    provider_routing:
      allow_fallbacks: false
      require_parameters: true
      sort: { by: throughput, partition: none }
      max_price: { prompt: 1, completion: 1 }
```

## Small configurations

### GitHub-ledger-only review

```yaml
version: 4
memory:
  enabled: false
review:
  finding_verifier:
    mode: report_only
```

### Honcho recall and feedback persistence

```yaml
memory:
  enabled: true
  provider: honcho
  transport: mcp
  recall:
    decision_feedback: true
    session_recap: true
  persist:
    decision_feedback: true
    session_recap: true
```

The Action writes normalized events only after successful GitHub publication. Events include
authorized ignore/unignore transitions, resolved/reopened/obsolete findings, session recaps, code
signals, and rule signals. Raw comment bodies, authors, credentials, and model transcripts are not
stored.

### Strict exact-snapshot verification

```yaml
review:
  units:
    enabled: true
    allow_waived: false
  finding_verifier:
    mode: enforce
```

Invalid anchors, stale heads, uncovered files, and verifier uncertainty become incomplete/blocking
results; they never become `SHIP`.

## Compatibility-only sections

These sections are accepted for compatibility with hosted configuration formats but do not enable
an Action database or replace the API-backed `memory` contract:

```yaml
reviews: { profile: balanced, reviewer_effort: medium }
chat: { auto_reply: true, max_context_turns: 10 }
knowledge_base: { learnings: true, issues: true, pull_requests: true }
path_filters: ['!dist/**']
auto_review: { enabled: true, ignore_drafts: true }
dials: { mascot: true, confidence_threshold: 70 }
```

Use `personas`, `exclude`, `limits`, `coverage_policy`, `memory`, `mcp`, `review`, `telemetry`,
and `github_action.openrouter` for Action-native behavior.
