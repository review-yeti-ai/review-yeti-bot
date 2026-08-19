#!/usr/bin/env bash

review_yeti_release_policy="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../policy" && pwd)/review-yeti.json"
review_yeti_release_channel_re="$(jq -r '.review_yeti.action_channel_pattern // empty' "$review_yeti_release_policy")"

[[ -n "$review_yeti_release_channel_re" ]] || {
  echo "::error::review_yeti.action_channel_pattern is missing"
  return 1 2>/dev/null || exit 1
}

is_review_yeti_release_channel() {
  [[ "${1:-}" =~ $review_yeti_release_channel_re ]]
}

resolve_review_yeti_ref_sha() {
  local ref_json="$1"
  local object_type="$(jq -r '.object.type' <<<"$ref_json")"
  local object_sha="$(jq -r '.object.sha' <<<"$ref_json")"

  case "$object_type" in
    commit)
      printf '%s\n' "$object_sha"
      ;;
    tag)
      local tag_json
      tag_json="$(gh api "repos/${REVIEW_YETI_REPOSITORY}/git/tags/${object_sha}")"
      [[ "$(jq -r '.object.type' <<<"$tag_json")" == commit ]] || {
        echo "::error::Release tag resolves to a non-commit object" >&2
        return 1
      }
      jq -r '.object.sha' <<<"$tag_json"
      ;;
    *)
      echo "::error::Release ref resolves to unsupported object type: ${object_type}" >&2
      return 1
      ;;
  esac
}
