#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_YETI_REPOSITORY:?REVIEW_YETI_REPOSITORY is required}"
: "${REVIEW_YETI_ACTION_CHANNEL:?REVIEW_YETI_ACTION_CHANNEL is required}"
: "${RESOLVED_SHA:?RESOLVED_SHA is required}"
: "${RESOLVED_REF_SHA:?RESOLVED_REF_SHA is required}"

sha_re='^[0-9a-f]{40}$'
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/review-yeti-release.sh"

is_review_yeti_release_channel "$REVIEW_YETI_ACTION_CHANNEL" || {
  echo "::error::REVIEW_YETI_ACTION_CHANNEL is not a release channel"
  exit 1
}

[[ "$RESOLVED_SHA" =~ $sha_re ]] || {
  echo "::error::RESOLVED_SHA is invalid"
  exit 1
}

[[ "$RESOLVED_REF_SHA" =~ $sha_re ]] || {
  echo "::error::RESOLVED_REF_SHA is invalid"
  exit 1
}

compare_status="$(gh api "repos/${REVIEW_YETI_REPOSITORY}/compare/main...${RESOLVED_SHA}" --jq '.status' 2>&1)" || {
  echo "::error::Could not compare ${REVIEW_YETI_REPOSITORY}@main with resolved commit ${RESOLVED_SHA}."
  echo "$compare_status"
  exit 1
}

if [[ "$compare_status" != "identical" && "$compare_status" != "behind" ]]; then
  echo "::error::Resolved commit ${RESOLVED_SHA} is not reachable from ${REVIEW_YETI_REPOSITORY}@main (compare status: ${compare_status})."
  exit 1
fi

tag_ref_json="$(gh api "repos/${REVIEW_YETI_REPOSITORY}/git/ref/tags/${REVIEW_YETI_ACTION_CHANNEL}" 2>&1)" || {
  echo "::error::Could not resolve release tag ${REVIEW_YETI_ACTION_CHANNEL} for ${REVIEW_YETI_REPOSITORY}."
  echo "$tag_ref_json"
  exit 1
}

tag_sha="$(resolve_review_yeti_ref_sha "$tag_ref_json")"
current_ref_sha="$(jq -r '.object.sha' <<<"$tag_ref_json")"

if [[ "$current_ref_sha" != "$RESOLVED_REF_SHA" ]]; then
  echo "::warning::Release channel ${REVIEW_YETI_ACTION_CHANNEL} advanced during this run (resolved ref ${RESOLVED_REF_SHA}, current ref ${current_ref_sha}); continuing with the immutable resolved commit ${RESOLVED_SHA}."
elif [[ "$tag_sha" != "$RESOLVED_SHA" ]]; then
  echo "::error::Resolved commit ${RESOLVED_SHA} does not match release tag ${REVIEW_YETI_ACTION_CHANNEL} (${tag_sha})."
  exit 1
fi

echo "Provenance OK: ${REVIEW_YETI_REPOSITORY}@${REVIEW_YETI_ACTION_CHANNEL} resolved ref ${RESOLVED_REF_SHA} to ${RESOLVED_SHA}, reachable from main."
