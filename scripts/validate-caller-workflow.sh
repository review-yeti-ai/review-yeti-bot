#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${CENTRAL_SHA:?CENTRAL_SHA is required}"

repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
sha_re='^[0-9a-f]{40}$'

[[ "$REVIEW_REPOSITORY" =~ $repo_re ]] || { echo "::error::repository is invalid"; exit 1; }
[[ "$EXPECTED_BASE_SHA" =~ $sha_re ]] || { echo "::error::base-sha is invalid"; exit 1; }
[[ "$CENTRAL_SHA" =~ $sha_re ]] || { echo "::error::central-sha is invalid"; exit 1; }

caller_workflow='.github/workflows/ct-review-bot.yml'
if [[ "$REVIEW_REPOSITORY" == 'exampleorg/example-review-actions' ]]; then
  caller_workflow='.github/workflows/self-review.yml'
fi

workflow_content="$({
  gh api "repos/${REVIEW_REPOSITORY}/contents/${caller_workflow}?ref=${EXPECTED_BASE_SHA}" |
    jq -r '.content // empty' |
    tr -d '\n' |
    base64 --decode
} 2>&1)" || {
  echo "::error::Could not read ${caller_workflow} at base SHA ${EXPECTED_BASE_SHA}."
  echo "$workflow_content"
  exit 1
}

# The base branch owns this workflow under pull_request_target. Require the exact standard
# caller shape so the central input cannot drift from the immutable reusable-workflow pin.
workflow_content="$(sed -E 's/[[:space:]]+#.*$//' <<<"$workflow_content")"
expected_uses="    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@${CENTRAL_SHA}"
expected_input="      central-sha: ${CENTRAL_SHA}"

uses_count="$(grep -Fxc "$expected_uses" <<<"$workflow_content" || true)"
input_count="$(grep -Fxc "$expected_input" <<<"$workflow_content" || true)"

if [[ "$uses_count" -ne 1 ]]; then
  echo "::error::${caller_workflow} must contain exactly one central Review Yeti pin at ${CENTRAL_SHA}."
  exit 1
fi
if [[ "$input_count" -ne 1 ]]; then
  echo "::error::${caller_workflow} must pass central-sha ${CENTRAL_SHA}."
  exit 1
fi

echo "Validated ${caller_workflow} at ${EXPECTED_BASE_SHA} uses central Review Yeti ${CENTRAL_SHA}."
