#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/validate-worker-parity-scope.sh"

target_repo="$TARGET_OWNER/$TARGET_REPOSITORY"
actual="$(gh api "repos/$target_repo/pulls/$PR_NUMBER" --jq '[.base.sha,.head.sha] | @tsv')"
[[ "$actual" == "$EXPECTED_BASE_SHA"$'\t'"$EXPECTED_HEAD_SHA" ]] || {
  echo 'the pull request head or base moved; refuse stale qualification' >&2
  exit 1
}
repository_id="$(gh api "repos/$target_repo" --jq '.id')"
[[ "$repository_id" =~ ^[1-9][0-9]*$ ]] || { echo 'target repository id is invalid' >&2; exit 1; }
printf 'repository_id=%s\n' "$repository_id" >> "$GITHUB_OUTPUT"
