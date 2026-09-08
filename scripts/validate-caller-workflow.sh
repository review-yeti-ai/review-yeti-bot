#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"

repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
sha_re='^[0-9a-fA-F]{40,64}$'

[[ "$REVIEW_REPOSITORY" =~ $repo_re ]] || { echo "::error::repository is invalid"; exit 1; }
[[ "$EXPECTED_BASE_SHA" =~ $sha_re ]] || { echo "::error::base-sha is invalid"; exit 1; }

if [[ "$REVIEW_REPOSITORY" == 'exampleorg/example-review-actions' ]]; then
  caller_workflow='.github/workflows/self-review.yml'
  central_ref="${CENTRAL_REF:-main}"
  [[ "$central_ref" == main ]] || { echo "::error::central self-review must use the development ref main"; exit 1; }
else
  caller_workflow='.github/workflows/ct-review-bot.yml'
  central_ref="${CENTRAL_REF:-v1}"
  [[ "$central_ref" =~ ^v[0-9]+$ ]] || { echo "::error::central-ref must be a platform-owned major release ref such as v1"; exit 1; }
fi

# pull_request_target always executes the copy of the caller workflow that lives at the PR's base
# branch/commit (EXPECTED_BASE_SHA), never the repository's default branch. Validating any other
# ref checks an artifact that did not run and produces false failures during pin advances.
workflow_content="$({
  gh api "repos/${REVIEW_REPOSITORY}/contents/${caller_workflow}?ref=${EXPECTED_BASE_SHA}" |
    jq -r '.content // empty' |
    tr -d '\n' |
    base64 --decode
} 2>&1)" || {
  echo "::error::Could not read ${caller_workflow} at base ${EXPECTED_BASE_SHA}."
  echo "$workflow_content"
  exit 1
}

# Require the standard caller shape so consumers do not carry a second, manually rotated SHA claim.
workflow_content="$(sed -E 's/[[:space:]]+#.*$//' <<<"$workflow_content")"
expected_uses="    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@${central_ref}"

release_uses_count="$(grep -Fxc "$expected_uses" <<<"$workflow_content" || true)"
immutable_uses_count="$(grep -Ec '^    uses: exampleorg/example-review-actions/\.github/workflows/review-yeti\.yml@[0-9a-fA-F]{40}$' <<<"$workflow_content" || true)"
uses_count=$((release_uses_count + immutable_uses_count))

if [[ "$uses_count" -ne 1 ]]; then
  echo "::error::${caller_workflow} must contain exactly one central Review Yeti ref at ${central_ref} or one immutable SHA pin."
  exit 1
fi
if [[ "$immutable_uses_count" -eq 1 ]]; then
  immutable_pin="$(grep -E '^    uses: exampleorg/example-review-actions/\.github/workflows/review-yeti\.yml@[0-9a-fA-F]{40}$' <<<"$workflow_content" | sed -E 's/.*@([0-9a-fA-F]{40})$/\1/')"
  central_comparison_status="$({
    gh api "repos/exampleorg/example-review-actions/compare/${immutable_pin}...${central_ref}" |
      jq -r '.status // empty'
  } 2>&1)" || {
    echo "::error::Could not verify immutable Review Yeti pin ${immutable_pin} against ${central_ref}."
    echo "$central_comparison_status"
    exit 1
  }
  if [[ "$central_comparison_status" != ahead && "$central_comparison_status" != identical ]]; then
    echo "::error::Immutable Review Yeti pin ${immutable_pin} is not reachable from central ${central_ref}."
    exit 1
  fi
fi
if grep -Eq '^[[:space:]]+central-sha:' <<<"$workflow_content"; then
  echo "::error::${caller_workflow} must not duplicate the central release ref as central-sha."
  exit 1
fi
# A direct caller could otherwise self-serve a fabricated SHIP by passing
# `with: passthrough: true`, bypassing the platform-owned REVIEW_YETI_PASSTHROUGH
# repository variable entirely. Passthrough may only be enabled centrally.
if grep -Eq '^[[:space:]]+passthrough:' <<<"$workflow_content"; then
  echo "::error::${caller_workflow} must not set passthrough; only the platform-owned repository variable may enable it."
  exit 1
fi
# execution_backend selects local vs. DOKS review execution; a consumer overriding it
# could route its own reviews around the central policy's transport decision.
if grep -Eq '^[[:space:]]+execution_backend:' <<<"$workflow_content"; then
  echo "::error::${caller_workflow} must not override execution_backend; the central policy is the only authority for backend selection."
  exit 1
fi

echo "Validated ${caller_workflow} at base ${EXPECTED_BASE_SHA} uses central Review Yeti ${central_ref} or a reachable immutable SHA pin."
