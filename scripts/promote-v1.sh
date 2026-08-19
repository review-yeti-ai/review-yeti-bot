#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"

repository="${GITHUB_REPOSITORY:-exampleorg/example-review-actions}"
default_branch="$(gh api "repos/${repository}" --jq '.default_branch // empty')"
[[ "$default_branch" == main ]] || {
  echo "::error::Review Yeti v1 promotion requires main as the default branch."
  exit 1
}

source_sha="$(gh api "repos/${repository}/commits/${SOURCE_SHA}" --jq '.sha // empty')"
[[ "$source_sha" == "$SOURCE_SHA" ]] || {
  echo "::error::Source commit ${SOURCE_SHA} is not available in ${repository}."
  exit 1
}

git fetch --no-tags origin main
main_sha="$(git rev-parse refs/remotes/origin/main)"
[[ "$main_sha" == "$SOURCE_SHA" ]] || {
  echo "::error::Validated source ${SOURCE_SHA} is no longer the current main tip (${main_sha}); refusing stale promotion."
  exit 1
}

merged_prs="$(gh api --paginate --slurp "repos/${repository}/commits/${SOURCE_SHA}/pulls?per_page=100")"
merged_pr="$(jq -c '[.[][] | select(.base.ref == "main" and .merged_at != null)] | sort_by(.merged_at) | last // empty' <<<"$merged_prs")"
[[ -n "$merged_pr" ]] || {
  echo "::error::No merged main pull request is associated with ${SOURCE_SHA}; refusing promotion."
  exit 1
}

pr_number="$(jq -r '.number' <<<"$merged_pr")"
pr_head="$(jq -r '.head.sha' <<<"$merged_pr")"
source_tree="$(gh api "repos/${repository}/commits/${SOURCE_SHA}" --jq '.commit.tree.sha // empty')"
head_tree="$(gh api "repos/${repository}/commits/${pr_head}" --jq '.commit.tree.sha // empty')"
[[ -n "$source_tree" && "$source_tree" == "$head_tree" ]] || {
  echo "::error::Merged main tree ${source_tree:-<missing>} does not exactly match PR #${pr_number} head tree ${head_tree:-<missing>}; refusing promotion."
  exit 1
}

# The merge commit owns the central validation check. The pull-request head owns the
# pull_request_target Review Yeti check, because GitHub does not copy that check onto the
# post-merge commit. Keep both coordinates explicit instead of silently checking only the PR head.
source_check_runs="$(gh api "repos/${repository}/commits/${SOURCE_SHA}/check-runs?per_page=100")"
pr_check_runs="$(gh api "repos/${repository}/commits/${pr_head}/check-runs?per_page=100")"

require_success() {
  local check_runs="$1"
  local name="$2"
  local coordinate="$3"
  local latest
  latest="$(jq -c --arg name "$name" '
    [.check_runs[] | select(.name == $name)] |
    sort_by(.completed_at // "") | last // {}
  ' <<<"$check_runs")"
  if [[ "$(jq -r '.status // empty' <<<"$latest")" != completed || "$(jq -r '.conclusion // empty' <<<"$latest")" != success ]]; then
    echo "::error::Required central check did not pass for ${coordinate}: ${name}."
    jq -c '{name,status,conclusion,completed_at}' <<<"$latest"
    exit 1
  fi
}

require_success "$source_check_runs" validate "source ${SOURCE_SHA}"
require_success "$pr_check_runs" 'review / Review Yeti' "PR #${pr_number} head ${pr_head}"

old_v1=""
if git ls-remote --exit-code origin refs/heads/v1 >/dev/null 2>&1; then
  git fetch --no-tags origin refs/heads/v1:refs/remotes/origin/v1
  old_v1="$(git rev-parse refs/remotes/origin/v1)"
  git merge-base --is-ancestor "$old_v1" "$SOURCE_SHA" || {
    echo "::error::Refusing non-fast-forward v1 promotion from ${old_v1} to ${SOURCE_SHA}."
    exit 1
  }
fi

if [[ "$old_v1" == "$SOURCE_SHA" ]]; then
  echo "Review Yeti v1 already points to ${SOURCE_SHA}."
else
  git push origin "${SOURCE_SHA}:refs/heads/v1"
  echo "Promoted Review Yeti v1 from ${old_v1:-<uninitialized>} to ${SOURCE_SHA} via PR #${pr_number}."
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Review Yeti v1 promotion"
    echo "- Source: \`${SOURCE_SHA}\`"
    echo "- Originating PR: #${pr_number}"
    echo "- Previous v1: \`${old_v1:-<uninitialized>}\`"
    echo "- New v1: \`${SOURCE_SHA}\`"
    echo "- Mode: fast-forward only"
  } >>"$GITHUB_STEP_SUMMARY"
fi
