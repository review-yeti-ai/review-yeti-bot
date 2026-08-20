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

promotion_wait_seconds="${PROMOTION_WAIT_SECONDS:-600}"
promotion_poll_seconds="${PROMOTION_POLL_SECONDS:-10}"
[[ "$promotion_wait_seconds" =~ ^[0-9]+$ && "$promotion_poll_seconds" =~ ^[0-9]+$ ]] || {
  echo "::error::PROMOTION_WAIT_SECONDS and PROMOTION_POLL_SECONDS must be non-negative integers."
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
pr_merge_commit="$(jq -r '.merge_commit_sha // empty' <<<"$merged_pr")"
[[ -n "$pr_head" && "$pr_merge_commit" == "$SOURCE_SHA" ]] || {
  echo "::error::Source ${SOURCE_SHA} is not the merge commit for PR #${pr_number} (reported ${pr_merge_commit:-<missing>}); refusing promotion."
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
  local endpoint="${4:-}"
  local latest
  local status
  local conclusion
  local deadline=$((SECONDS + promotion_wait_seconds))

  while :; do
    # Key off attempt recency (check-run id, monotonically assigned), never completion time.
    # A rerun of a failed check creates a new check-run on the SAME commit SHA; sorting by
    # completed_at treats "no completed_at yet" (an in-flight rerun) as earliest, so a stale
    # completed FAILURE from a superseded attempt would permanently shadow the live rerun and
    # fail closed forever -- the exact "check was red once, can never promote" deadlock.
    latest="$(jq -c --arg name "$name" '
      [.check_runs[] | select(.name == $name)] |
      sort_by(.id) | last // {}
    ' <<<"$check_runs")"
    status="$(jq -r '.status // empty' <<<"$latest")"
    conclusion="$(jq -r '.conclusion // empty' <<<"$latest")"

    if [[ "$status" == completed && "$conclusion" == success ]]; then
      return 0
    fi

    if [[ "$status" != queued && "$status" != in_progress ]] || [[ -z "$endpoint" ]] || (( SECONDS >= deadline )); then
      echo "::error::Required central check did not pass for ${coordinate}: ${name}."
      jq -c '{name,status,conclusion,completed_at}' <<<"$latest"
      exit 1
    fi

    echo "Waiting for ${coordinate}: ${name} (${status}); retrying in ${promotion_poll_seconds}s."
    sleep "$promotion_poll_seconds"
    check_runs="$(gh api "$endpoint")"
  done
}

require_success "$source_check_runs" validate "source ${SOURCE_SHA}" \
  "repos/${repository}/commits/${SOURCE_SHA}/check-runs?per_page=100"

# The Review Yeti check lives on a PR head, and heads move: an update-branch
# right before merge (or a merge landing while the re-review is in flight)
# leaves the final head without its own green check even though an earlier
# head of the SAME pull request was reviewed green. That stranded promotion
# three times in one day. Accept a green review on the exact head first;
# otherwise walk the PR's recent commits (newest first) and accept the first
# green review with a loud warning. A pull request with NO green review on
# any commit still refuses — a deliberately unreviewed merge stays stranded.
green_review_sha=""
if jq -e '[.check_runs[] | select(.name == "review / Review Yeti")] | sort_by(.id) | last // {} | select(.status == "completed" and .conclusion == "success")' >/dev/null <<<"$pr_check_runs"; then
  green_review_sha="$pr_head"
else
  # Fail-soft walk: any API/parse hiccup here simply falls through to the
  # original exact-head requirement below — the fallback can only rescue,
  # never produce a new failure mode.
  pr_commits="$(gh api --paginate --slurp "repos/${repository}/pulls/${pr_number}/commits?per_page=100" 2>/dev/null | jq -r '.[][].sha' 2>/dev/null | tail -10 || true)"
  for candidate in $(printf '%s\n' "$pr_commits" | tail -r 2>/dev/null || printf '%s\n' "$pr_commits" | tac 2>/dev/null || true); do
    [[ "$candidate" == "$pr_head" ]] && continue
    candidate_runs="$(gh api "repos/${repository}/commits/${candidate}/check-runs?per_page=100" 2>/dev/null || true)"
    [[ -n "$candidate_runs" ]] || continue
    if jq -e '[.check_runs[] | select(.name == "review / Review Yeti")] | sort_by(.id) | last // {} | select(.status == "completed" and .conclusion == "success")' >/dev/null 2>&1 <<<"$candidate_runs"; then
      green_review_sha="$candidate"
      echo "::warning::PR #${pr_number} head ${pr_head} has no green Review Yeti check; accepting the green review on earlier PR commit ${candidate} (head moved before its re-review completed)."
      break
    fi
  done
fi
if [[ -z "$green_review_sha" ]]; then
  require_success "$pr_check_runs" 'review / Review Yeti' "PR #${pr_number} head ${pr_head}" \
    "repos/${repository}/commits/${pr_head}/check-runs?per_page=100"
fi

old_v1=""
branch_exists=false
tag_exists=false
if git ls-remote --exit-code origin refs/heads/v1 >/dev/null 2>&1; then
  branch_exists=true
  git fetch --no-tags origin refs/heads/v1:refs/remotes/origin/v1
  old_v1="$(git rev-parse refs/remotes/origin/v1)"
fi

if git ls-remote --exit-code origin refs/tags/v1 >/dev/null 2>&1; then
  tag_exists=true
  git fetch --no-tags origin refs/tags/v1:refs/tags/v1-legacy
  legacy_v1="$(git rev-parse refs/tags/v1-legacy^{})"
  if [[ "$branch_exists" == true && "$legacy_v1" != "$old_v1" ]]; then
    echo "::error::Ambiguous v1 refs: branch ${old_v1} and legacy tag ${legacy_v1} diverge; refusing promotion."
    exit 1
  fi
  old_v1="${old_v1:-$legacy_v1}"
fi

if [[ -n "$old_v1" ]]; then
  git merge-base --is-ancestor "$old_v1" "$SOURCE_SHA" || {
    echo "::error::Refusing non-fast-forward v1 promotion from ${old_v1} to ${SOURCE_SHA}."
    exit 1
  }
fi

if [[ "$old_v1" == "$SOURCE_SHA" && "$branch_exists" == true ]]; then
  echo "Review Yeti v1 already points to ${SOURCE_SHA}."
else
  git push origin "${SOURCE_SHA}:refs/heads/v1"
  echo "Promoted Review Yeti v1 from ${old_v1:-<uninitialized>} to ${SOURCE_SHA} via PR #${pr_number}."
fi

if [[ "$tag_exists" == true ]]; then
  git push origin ':refs/tags/v1'
  echo "Removed legacy Review Yeti v1 tag after branch promotion."
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
