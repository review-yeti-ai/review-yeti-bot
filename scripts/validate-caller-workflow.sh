#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${CENTRAL_REF:=v1}"

repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
sha_re='^[0-9a-fA-F]{40,64}$'

[[ "$REVIEW_REPOSITORY" =~ $repo_re ]] || { echo "::error::repository is invalid"; exit 1; }
[[ "$EXPECTED_BASE_SHA" =~ $sha_re ]] || { echo "::error::base-sha is invalid"; exit 1; }
[[ "$CENTRAL_REF" =~ ^v[0-9]+$ ]] || { echo "::error::central-ref must be a platform-owned major release ref such as v1"; exit 1; }

caller_workflow='.github/workflows/ct-review-bot.yml'
if [[ "$REVIEW_REPOSITORY" == 'exampleorg/example-review-actions' ]]; then
  caller_workflow='.github/workflows/self-review.yml'
fi

# pull_request_target always executes the copy of the caller workflow that lives on the PR's base
# branch/commit (EXPECTED_BASE_SHA), never the repository's default branch. Validating any other
# ref checks an artifact that did not run and produces false failures whenever the default branch
# and the PR's base branch carry different central-ref pins (e.g. mid pin-advance).
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
expected_uses="    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@${CENTRAL_REF}"

uses_count="$(grep -Fxc "$expected_uses" <<<"$workflow_content" || true)"

if [[ "$uses_count" -ne 1 ]]; then
  echo "::error::${caller_workflow} must contain exactly one central Review Yeti ref at ${CENTRAL_REF}."
  exit 1
fi
if grep -Eq '^[[:space:]]+central-sha:' <<<"$workflow_content"; then
  echo "::error::${caller_workflow} must not duplicate the central release ref as central-sha."
  exit 1
fi

echo "Validated ${caller_workflow} at base ${EXPECTED_BASE_SHA} uses central Review Yeti ${CENTRAL_REF}."
