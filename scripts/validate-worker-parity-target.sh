#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${CONFIRM:?CONFIRM is required}"
: "${TARGET_OWNER:?TARGET_OWNER is required}"
: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"
: "${WORKER_IMAGE:?WORKER_IMAGE is required}"

[[ "$TARGET_OWNER" == exampleorg ]] || { echo 'repo_owner must be exampleorg' >&2; exit 1; }
[[ "$TARGET_REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || {
  echo 'repo_name is invalid' >&2
  exit 1
}
[[ "$CONFIRM" == PARITY ]] || { echo 'confirm must be PARITY' >&2; exit 1; }
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo 'pr_number must be positive' >&2; exit 1; }
for value in "$EXPECTED_BASE_SHA" "$EXPECTED_HEAD_SHA"; do
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { echo 'base/head SHAs must be exact lowercase 40-hex commits' >&2; exit 1; }
done
[[ "$WORKER_IMAGE" =~ ^registry\.digitalocean\.com/exampleorg/review-yeti-worker@sha256:[0-9a-f]{64}$ ]] || {
  echo 'worker_image must be an exact digest in the trusted worker repository' >&2
  exit 1
}

target_repo="$TARGET_OWNER/$TARGET_REPOSITORY"
actual="$(gh api "repos/$target_repo/pulls/$PR_NUMBER" --jq '[.base.sha,.head.sha] | @tsv')"
[[ "$actual" == "$EXPECTED_BASE_SHA"$'\t'"$EXPECTED_HEAD_SHA" ]] || {
  echo 'the pull request head or base moved; refuse stale qualification' >&2
  exit 1
}
repository_id="$(gh api "repos/$target_repo" --jq '.id')"
[[ "$repository_id" =~ ^[1-9][0-9]*$ ]] || { echo 'target repository id is invalid' >&2; exit 1; }
printf 'repository_id=%s\n' "$repository_id" >> "$GITHUB_OUTPUT"
