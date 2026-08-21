#!/usr/bin/env bash
# Fetch a PR's unified diff, with a fallback for diffs GitHub refuses to serve.
#
# `gh pr diff` hits the `.diff` media type, which GitHub caps at 300 files:
#
#   HTTP 406: Sorry, the diff exceeded the maximum number of files (300).
#   Consider using 'List pull requests files' API or locally cloning the
#   repository instead.
#
# Measured on calltelemetry/ct-meta#2118 (325 files): the fetch step exited 1,
# every downstream step went `conclusion=skipped`, and the run surfaced only
# "Review Yeti did not produce a verdict; an earlier workflow step failed" --
# naming neither the file count nor the 406. A large PR is exactly the kind that
# most wants review, and it silently got none.
#
# So: try the fast path, and on the size-cap failure fetch the immutable base
# and head Git objects and generate the diff locally. This avoids both the
# Files API's 3000-file ceiling and its omission of patches for binary or
# oversized files.
#
# Usage: fetch-pr-diff.sh <pr-number> <owner/repo> <output-path> <base-sha> <head-sha>
set -euo pipefail

PR="${1:?pr number required}"
REPO="${2:?owner/repo required}"
OUT="${3:?output path required}"
BASE_SHA="${4:?base sha required}"
HEAD_SHA="${5:?head sha required}"

sha_re='^[0-9a-fA-F]{40,64}$'
if [[ ! "$BASE_SHA" =~ $sha_re ]] || [[ ! "$HEAD_SHA" =~ $sha_re ]]; then
  echo "::error::base and head must be immutable Git SHAs" >&2
  exit 1
fi

if gh pr diff "$PR" --repo "$REPO" >"$OUT" 2>"${OUT}.err"; then
  echo "Fetched $(wc -l <"$OUT") diff lines."
  rm -f "${OUT}.err"
  exit 0
fi

err="$(cat "${OUT}.err" 2>/dev/null || true)"
rm -f "${OUT}.err"

# Only the size cap is recoverable this way. A 404, an auth failure or a network
# error must still fail loudly -- reconstructing a diff from a Files API call
# that is itself broken would hand the panel a silently empty review.
if ! grep -qiE "exceeded the maximum number of files|too_large" <<<"$err"; then
  echo "::error::could not fetch PR diff for ${REPO}#${PR}: ${err}" >&2
  exit 1
fi

echo "::warning::${REPO}#${PR} exceeds GitHub's 300-file .diff cap; generating the immutable Git diff locally."

temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
repo_dir="$(mktemp -d "${temp_root%/}/review-yeti-diff.XXXXXX")"
cleanup() {
  rm -rf -- "$repo_dir"
}
trap cleanup EXIT

git -C "$repo_dir" init --quiet
git -C "$repo_dir" remote add origin "https://github.com/${REPO}.git"

git_auth=()
if [ -n "${GH_TOKEN:-}" ]; then
  encoded_token="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
  git_auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded_token}")
fi

# Fetch full commit history without blobs so merge-base matches GitHub's PR
# semantics. `git diff` lazily downloads only blobs needed for the final diff.
git "${git_auth[@]}" -C "$repo_dir" fetch --quiet --no-tags --filter=blob:none \
  origin "$BASE_SHA" "$HEAD_SHA"

git -C "$repo_dir" cat-file -e "${BASE_SHA}^{commit}"
git -C "$repo_dir" cat-file -e "${HEAD_SHA}^{commit}"
merge_base="$(git -C "$repo_dir" merge-base "$BASE_SHA" "$HEAD_SHA")"
if [[ ! "$merge_base" =~ $sha_re ]]; then
  echo "::error::could not resolve the merge base for ${REPO}#${PR}" >&2
  exit 1
fi

git "${git_auth[@]}" -C "$repo_dir" diff --no-color --no-ext-diff \
  --find-renames "$merge_base" "$HEAD_SHA" -- >"$OUT"

file_count="$(git -C "$repo_dir" diff --name-only "$merge_base" "$HEAD_SHA" -- | wc -l | tr -d ' ')"
echo "Fetched $(wc -l <"$OUT") diff lines from immutable Git objects (${file_count} files)."
