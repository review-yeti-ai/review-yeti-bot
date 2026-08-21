# Review Bot OpenRouter Terraform Guide Design

## Goal

Teach ct-review-bot operators how to build and safely manage the OpenRouter
review deployment without coupling runtime review execution to Terraform or
storing credentials in the repository.

## Architecture

Add `infra/openrouter/` as a credential-free consumer template and
`docs/OPENROUTER_TERRAFORM.md` as the operator guide. The template is
deliberately small and mirrors the canonical ct-meta skill: it provisions a
workspace, a model allowlist guardrail, and a bounded completion-key resource
using the pinned OpenRouter provider. Operators can point to the canonical
ct-meta skill for policy changes instead of editing action code.

The guide defines a three-secret boundary: the OpenRouter management key is
used only by Terraform/OpenTofu, the generated fleet completion key is stored
in Doppler and GitHub Actions secrets, and the GitHub token is used only for
publication. It explains how to use `TF_VAR_openrouter_management_key`, how to
import existing resources, how to assign the completion key to the guardrail,
and how to verify exact model, budget, and endpoint policy before enabling the
action. No Terraform apply, secret rotation, or live provider call is part of
the repository tests.

## Boundaries

- Runtime code remains OpenRouter-only and does not invoke OmniRoute.
- Terraform state and `terraform.tfvars` are ignored and must use protected
  remote or operator-managed storage before shared CI applies changes.
- The template never outputs a secret; key handoff is an explicit Doppler
  operation outside Terraform.
- Review workflow examples use a dedicated completion secret and fail closed
  when it is absent.

## Validation

- `tofu fmt -check` or `terraform fmt -check` passes for the template.
- `tofu validate` or `terraform validate` runs without credentials.
- A documentation test checks the template, secret names, OpenRouter endpoint,
  and explicit prohibition on OmniRoute.
- Existing unit, replay, lint, and build checks remain unchanged and are run
  before the PR is merged.
