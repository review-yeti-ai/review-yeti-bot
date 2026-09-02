#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${REVIEW_PR_NUMBER:?REVIEW_PR_NUMBER is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"

sha_re='^[0-9a-fA-F]{40,64}$'
repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'

[[ "$REVIEW_REPOSITORY" =~ $repo_re ]] || { echo "::error::repository is invalid"; exit 1; }
[[ "$EXPECTED_BASE_SHA" =~ $sha_re ]] || { echo "::error::base-sha is invalid"; exit 1; }
[[ "$EXPECTED_HEAD_SHA" =~ $sha_re ]] || { echo "::error::head-sha is invalid"; exit 1; }
[[ "$REVIEW_PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "::error::pr-number is invalid"; exit 1; }

metadata="$(gh api "repos/${REVIEW_REPOSITORY}/pulls/${REVIEW_PR_NUMBER}")"
actual_repo="$(jq -r '.base.repo.full_name // empty' <<<"$metadata")"
actual_base="$(jq -r '.base.sha // empty' <<<"$metadata")"
actual_head="$(jq -r '.head.sha // empty' <<<"$metadata")"
state="$(jq -r '.state // empty' <<<"$metadata")"

[[ "$actual_repo" == "$REVIEW_REPOSITORY" ]] || { echo "::error::PR repository identity changed"; exit 1; }
[[ "$actual_base" == "$EXPECTED_BASE_SHA" ]] || { echo "::error::PR base SHA changed: expected $EXPECTED_BASE_SHA, got $actual_base"; exit 1; }

# A superseded head is not a validation failure of the PR -- it means a newer run has already
# been dispatched for the real current head, and this run is now reviewing a dead SHA. Painting
# that "failure" is pure noise (example-api #4396: failures at 16:04/16:06, SHIP at 16:08 on the
# newer head). Cancel this run instead. This is the ONLY branch that may cancel; every other
# check in this script keeps a plain exit 1, and the exit code here stays non-zero regardless of
# whether cancellation is confirmed -- exit 0 would mint a passing review for an unreviewed
# commit, the single worst outcome available.
if [[ "$actual_head" != "$EXPECTED_HEAD_SHA" ]]; then
  echo "::notice::PR head SHA moved from $EXPECTED_HEAD_SHA to $actual_head while this run was in flight. Self-cancelling instead of failing a superseded SHA that no longer blocks merge."
  "$(dirname "${BASH_SOURCE[0]}")/self-cancel-run.sh" || true
  exit 1
fi

[[ "$state" == open ]] || { echo "::error::PR is not open"; exit 1; }

path_state() {
  local path="$1"
  local ref="$2"
  local response
  local rc
  set +e
  response="$(gh api "repos/${REVIEW_REPOSITORY}/contents/${path}?ref=${ref}" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf '%s\n' exists
    return 0
  fi
  if ! grep -q 'HTTP 404' <<<"$response"; then
    echo "::error::Could not determine whether consumer review configuration exists at ${path}."
    echo "$response"
    exit 1
  fi
  printf '%s\n' absent
}

# Third-party reviewer config files are not Review Yeti configuration and are not checked here.
for path in \
  .review-yeti.yaml \
  .review-yeti.yml \
  .ct-review.yaml \
  .ct-review.yml \
  .review-yeti \
  .ct-review; do
  head_state="$(path_state "$path" "$EXPECTED_HEAD_SHA")"
  # Operator directive 2026-08-20: consumer review-config files are INERT, not
  # forbidden. The action reads reviewer configuration only from the trusted
  # base and central policy, so these files cannot influence a review — their
  # presence is dead config worth a cleanup nag, never a full review outage.
  if [[ "$head_state" == exists ]]; then
    echo "::warning::Dead consumer review configuration ignored: ${path}. Central policy owns all review configuration; please delete this file."
  fi
done

echo "Validated ${REVIEW_REPOSITORY}#${REVIEW_PR_NUMBER} at exact base ${EXPECTED_BASE_SHA} and head ${EXPECTED_HEAD_SHA}."
