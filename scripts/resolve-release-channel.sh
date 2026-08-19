#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_YETI_REPOSITORY:?REVIEW_YETI_REPOSITORY is required}"
: "${REVIEW_YETI_ACTION_CHANNEL:?REVIEW_YETI_ACTION_CHANNEL is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

sha_re='^[0-9a-f]{40}$'
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/review-yeti-release.sh"

is_review_yeti_release_channel "$REVIEW_YETI_ACTION_CHANNEL" || {
  echo "::error::REVIEW_YETI_ACTION_CHANNEL is not a release channel"
  exit 1
}

ref_json="$(gh api "repos/${REVIEW_YETI_REPOSITORY}/git/ref/tags/${REVIEW_YETI_ACTION_CHANNEL}" 2>&1)" || {
  echo "::error::Could not resolve ${REVIEW_YETI_REPOSITORY}@${REVIEW_YETI_ACTION_CHANNEL}."
  echo "$ref_json"
  exit 1
}

resolved_sha="$(resolve_review_yeti_ref_sha "$ref_json")"

[[ "$resolved_sha" =~ $sha_re ]] || {
  echo "::error::Release channel resolved to an invalid commit"
  exit 1
}

printf 'sha<<CT_REVIEW_RESOLVED_SHA\n%s\nCT_REVIEW_RESOLVED_SHA\n' "$resolved_sha" >> "$GITHUB_OUTPUT"
printf 'channel<<CT_REVIEW_ACTION_CHANNEL\n%s\nCT_REVIEW_ACTION_CHANNEL\n' "$REVIEW_YETI_ACTION_CHANNEL" >> "$GITHUB_OUTPUT"
echo "Resolved ${REVIEW_YETI_REPOSITORY}@${REVIEW_YETI_ACTION_CHANNEL} to ${resolved_sha}."
