# Managed OpenRouter deployment

`ct-review-bot` runs review traffic directly through OpenRouter. The canonical
fleet policy and reference stack live in the ct-meta
[`ct-platform/openrouter` skill](https://github.com/calltelemetry/ct-meta/tree/main/plugins/ct-platform/skills/openrouter);
this repository's [`infra/openrouter/`](../infra/openrouter/) directory is a
consumer template for operators who need the deployment beside the bot.

The template manages three OpenRouter resources:

- the `CT Review Fleet` workspace;
- a guardrail with an explicit privacy-reviewed model allowlist, training and
  publication disabled, and a bounded monthly budget;
- a bounded `review-fleet-worker` completion-key resource.

It does not run reviews, store secrets, or apply infrastructure in CI.

## Key and state boundary

Use separate credentials for separate jobs:

| Secret | Where it lives | Use |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Doppler `ai-workspace` | Terraform/OpenTofu management and provisioning only |
| `OPENROUTER_REVIEW_FLEET_KEY` | Doppler `ai-workspace` | Guarded completion key for review traffic |
| `OPENROUTER_PR_REVIEW_API_KEY` | Target GitHub repository secret | Compatibility name consumed by the deployed Action workflow |
| `GITHUB_TOKEN` | GitHub Actions runtime | Read the PR and publish its comment |

The management key enters Terraform through the standard `TF_VAR_` convention;
the value is never written to a file or printed:

```bash
export TF_VAR_openrouter_management_key="$(doppler secrets get OPENROUTER_API_KEY --project ai-workspace --config dev --plain)"
trap 'unset TF_VAR_openrouter_management_key' EXIT
```

The template ignores `terraform.tfvars`, `.terraform/`, state, and saved plan
files. It intentionally has no default remote backend. Keep state in protected
operator storage or configure an approved remote backend before shared CI or
multiple operators use this stack. Do not commit state or a raw API key.

## Bootstrap or import

The checked-in `import.tf` targets the existing CT Review Fleet workspace and
guardrail. Review the IDs before use. A separate fleet must use its own import
identifiers or remove the import blocks before its first apply; do not delete or
recreate the existing fleet to resolve drift.

From the repository root:

```bash
tofu -chdir=infra/openrouter init
tofu -chdir=infra/openrouter plan -out=review-fleet.tfplan
tofu -chdir=infra/openrouter show review-fleet.tfplan
tofu -chdir=infra/openrouter apply review-fleet.tfplan
```

The default policy is overrideable with Terraform variables such as
`allowed_models`, `guardrail_limit_usd`, `completion_key_limit`, and the
workspace/guardrail names. Provider privacy and cost must be re-audited before
changing the model list or budget.

Validate without credentials or an apply:

```bash
tofu -chdir=infra/openrouter fmt -check
tofu -chdir=infra/openrouter init -backend=false -input=false
tofu -chdir=infra/openrouter validate
```

## Guardrail assignment and Doppler handoff

The provider creates the completion-key resource but does not write its raw
value to Doppler. It also does not currently manage guardrail key assignment.
Treat those as explicit post-provisioning operations. The provider exposes a
sensitive `completion_key_hash` output for the assignment API; it is not the
raw key:

```bash
export OPENROUTER_KEY_HASH="$(tofu -chdir=infra/openrouter output -raw completion_key_hash)"
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg hash "$OPENROUTER_KEY_HASH" '{key_hashes:[$hash]}')" \
  "https://openrouter.ai/api/v1/guardrails/81fcf882-973a-4d95-8a84-c1c075c3795e/assignments/keys"
unset OPENROUTER_KEY_HASH
```

Obtain the raw completion key through the approved OpenRouter key handoff
process and store it in Doppler as `OPENROUTER_REVIEW_FLEET_KEY`. Synchronize
that value to the target repository's `OPENROUTER_PR_REVIEW_API_KEY` secret
without printing it:

```bash
doppler secrets get OPENROUTER_REVIEW_FLEET_KEY --project ai-workspace --config dev --plain \
  | gh secret set OPENROUTER_PR_REVIEW_API_KEY --repo calltelemetry/REPOSITORY --body -
```

Do not put the raw key in Terraform outputs, workflow YAML, a shell history, or
the repository.

## Review Action wiring

Use the guarded completion secret and the OpenRouter endpoint explicitly:

```yaml
name: Review
on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: JBJMLLC/ct-review-bot@main
        with:
          llm-base-url: https://openrouter.ai/api/v1
          model: openrouter/auto-beta
          llm-api-key: ${{ secrets.OPENROUTER_PR_REVIEW_API_KEY }}
```

The action fails closed when the key is absent or the provider returns an
invalid result; it must never turn a provider failure into `SHIP`. Keep the
review path OpenRouter-only. Do not configure OmniRoute variables, restore the
deprecated OmniRoute route, or use `Dockerfile.omniroute` as part of this
deployment.

## Drift, rotation, and rollback

Use a no-apply plan for drift checks:

```bash
tofu -chdir=infra/openrouter show
tofu -chdir=infra/openrouter plan
```

For rotation, create and validate the replacement management or completion key
in the secret manager first, update the consuming workflow secret, then disable
the old key through the approved OpenRouter management path. For rollback,
restore the last reviewed Terraform variable values and apply a newly saved
plan. Never use destroy or force-reconciliation to resolve policy drift.
