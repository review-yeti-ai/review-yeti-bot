# Review Bot OpenRouter Terraform Guide Implementation Plan

> [!WARNING]
> **Historical plan; non-authoritative.** This records a point-in-time proposal, not current runtime,
> provider, release, or fleet policy. See
> [Documentation authority](../../DOCUMENTATION_AUTHORITY.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, credential-free OpenRouter Terraform/OpenTofu consumer template and operator guide to ct-review-bot.

**Architecture:** Add a small `infra/openrouter/` stack that mirrors the canonical ct-meta OpenRouter provider and fleet policy while keeping variables overrideable. Add `docs/OPENROUTER_TERRAFORM.md` to explain secret/state boundaries, exact review-action wiring, imports, guardrail assignment, drift, rotation, and OpenRouter-only execution.

**Tech Stack:** Markdown documentation, Terraform/OpenTofu HCL, OpenRouter provider `0.1.30`, Vitest documentation contract test, GitHub Actions.

## Global Constraints

- Never commit API keys, `terraform.tfvars`, Terraform state, or customer data.
- OpenRouter is the only runtime model route; do not add or restore OmniRoute fallback behavior.
- The template must be safe to validate without credentials and must not run `tofu apply` in CI.
- Terraform/OpenTofu manages configuration; Doppler and GitHub Secrets manage secret distribution explicitly.
- Preserve existing review-bot replay, lint, build, and action behavior.

---

### Task 1: Add a credential-free OpenRouter Terraform/OpenTofu template

**Files:**
- Create: `infra/openrouter/main.tf`
- Create: `infra/openrouter/variables.tf`
- Create: `infra/openrouter/outputs.tf`
- Create: `infra/openrouter/import.tf`
- Create: `infra/openrouter/.gitignore`
- Create: `infra/openrouter/.terraform.lock.hcl`
- Test: `infra/openrouter/*.tf` with OpenTofu formatting and validation

**Interfaces:**
- Consumes: `TF_VAR_openrouter_management_key` plus optional variable overrides.
- Produces: a review workspace, privacy guardrail, and bounded completion-key resource; outputs contain workspace/guardrail IDs, a sensitive assignment hash, and names only.

- [ ] **Step 1: Add the pinned provider and typed variables**

Use provider source `registry.terraform.io/OpenRouterTeam/openrouter` version `0.1.30`. Define the sensitive management-key variable and overrideable workspace, guardrail, model allowlist, monthly limits, reset intervals, and completion-key name.

- [ ] **Step 2: Add the managed resources and imports**

Create the workspace, guardrail, and API-key resources using resource-to-resource IDs and explicit `enable_*_training=false` and `enable_*_publication=false` settings. Preserve the current CT Review Fleet import IDs in `import.tf` and document that operators remove those import blocks only when intentionally creating a separate fleet.

- [ ] **Step 3: Add non-secret outputs and ignore rules**

Output workspace ID, guardrail ID, sensitive completion-key hash, and completion-key name only. Ignore `*.tfvars`, `.terraform/`, and both state files while retaining the provider lock file.

- [ ] **Step 4: Format and validate without credentials**

Run:

```bash
tofu -chdir=infra/openrouter fmt -check
tofu -chdir=infra/openrouter init -backend=false -input=false
tofu -chdir=infra/openrouter validate
```

Expected: all checks pass without `OPENROUTER_API_KEY`, `OPENROUTER_REVIEW_FLEET_KEY`, or network writes.

- [ ] **Step 5: Commit the template**

```bash
git add infra/openrouter
git commit -m "feat(infra): add OpenRouter review fleet template"
```

### Task 2: Document the operator workflow and action wiring

**Files:**
- Create: `docs/OPENROUTER_TERRAFORM.md`
- Modify: `README.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Test: `tests/unit/openrouterTerraformGuide.test.ts`

**Interfaces:**
- Consumes: the `infra/openrouter` variables/resources from Task 1 and action inputs from `action.yml`.
- Produces: copyable operator instructions and a documentation contract test.

- [ ] **Step 1: Document the key boundary**

Explain that `OPENROUTER_API_KEY` is management-only, `OPENROUTER_REVIEW_FLEET_KEY` is the guarded completion key in Doppler, and `OPENROUTER_PR_REVIEW_API_KEY` is the repository-secret compatibility name used by deployed workflows. Show the `TF_VAR_openrouter_management_key` Doppler pipeline without printing secret values.

- [ ] **Step 2: Document plan/apply/import/drift/rotation**

Provide exact `tofu -chdir=infra/openrouter init`, plan, saved-plan apply, show, and import commands. State that state must be protected or moved to an approved remote backend before shared CI applies changes. Explain that Terraform does not automatically write the generated raw completion key to Doppler and that guardrail key assignment is an explicit post-provisioning operation.

- [ ] **Step 3: Add the OpenRouter-only review workflow example**

Show a workflow using `JBJMLLC/ct-review-bot@main`, `llm-base-url: https://openrouter.ai/api/v1`, `model: openrouter/auto-beta`, and `llm-api-key: ${{ secrets.OPENROUTER_PR_REVIEW_API_KEY }}`. State that missing credentials fail closed and that OmniRoute variables and `Dockerfile.omniroute` are not part of the deployment path.

- [ ] **Step 4: Link the guide from repository entry points**

Add a short “Managed OpenRouter deployment” section to `README.md` and the configuration reference pointing to the full guide and the canonical ct-meta skill.

- [ ] **Step 5: Add a documentation contract test**

Create a Vitest test that reads the guide and template and asserts the provider source/version, OpenRouter endpoint, required secret names, `tofu` commands, guardrail assignment language, and absence of case-insensitive `omniroute` in the runtime/template instructions. The test must not load credentials or make network calls.

- [ ] **Step 6: Run focused tests and commit the guide**

```bash
npx vitest run tests/unit/openrouterTerraformGuide.test.ts
npm run lint
git diff --check
git add README.md docs/CONFIGURATION_REFERENCE.md docs/OPENROUTER_TERRAFORM.md tests/unit/openrouterTerraformGuide.test.ts
git commit -m "docs: teach OpenRouter Terraform deployment"
```

### Task 3: Verify the complete review-bot branch

**Files:**
- Test: `infra/openrouter`, documentation contract, replay suite, full unit suite, build

- [ ] **Step 1: Run replay and focused suites**

```bash
npm run test:replay
npx vitest run tests/unit/openrouterTerraformGuide.test.ts
```

- [ ] **Step 2: Run lint and build**

```bash
npm run lint
npm run build:backend
```

- [ ] **Step 3: Inspect tracked files for secrets and state**

```bash
git diff --check
if git ls-files | rg -q '(^|/)(terraform\.tfvars|terraform\.tfstate|\.terraform/)'; then echo 'tracked Terraform secret/state artifact' >&2; exit 1; fi
if git grep -n -I -E 'sk-[A-Za-z0-9]|Bearer [A-Za-z0-9_-]{20,}' -- infra/openrouter docs/OPENROUTER_TERRAFORM.md; then echo 'possible credential value found' >&2; exit 1; fi
```

Expected: no tracked state/variable files and no credential values.

- [ ] **Step 4: Commit any verification-only fixes**

```bash
git status --short
```

If verification exposed a documentation or template defect, fix it, rerun the failed check, and commit with a focused message. If clean, make no empty commit.

### Task 4: Push, review, and merge the review-bot PR

**Files:**
- Review: all files in the review-bot branch
- Test: hosted PR checks at the exact pushed SHA

- [ ] **Step 1: Push the branch and open the PR**

```bash
git push -u origin codex/openrouter-terraform-guide
gh pr create -R review-yeti-ai/review-yeti-bot --base main --head codex/openrouter-terraform-guide --title "docs: teach OpenRouter Terraform deployment" --body-file /tmp/ct-review-bot-openrouter-pr.md
```

The PR body must identify ct-meta as the canonical policy source, state that no apply or secret rotation occurred, and list the exact local validation receipts.

- [ ] **Step 2: Verify exact-head review and hosted checks**

Confirm the PR head SHA, required CI checks, action build, replay suite, and no unexpected OmniRoute runtime change. Re-run review after any SHA change.

- [ ] **Step 3: Merge and record the merge SHA**

Merge only when required checks are green, then verify the PR is merged and record the full merge SHA.
