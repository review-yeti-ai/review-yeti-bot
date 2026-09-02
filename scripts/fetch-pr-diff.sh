#!/usr/bin/env bash
# Fetch the pull request diff for the "Fetch pull request diff" action.yml
# step, with a local-diff fallback for pull requests GitHub's diff media
# type refuses to serve.
#
# `gh pr diff` requests GitHub's `application/vnd.github.diff` media type,
# which 406s once a pull request exceeds 300 changed files or 20,000 changed
# lines ("Sorry, the diff exceeded the maximum number of files (300)" / "...
# maximum number of lines (20000)"). Before this script existed that 406
# propagated straight through `set -euo pipefail`, failing the whole run
# with no verdict even though the REQUIRED check still gated merge
# (review-yeti-bot#REL-513). Forward-merges and large backports hit this
# routinely.
#
# Three tiers, in order:
#   1. `gh pr diff` (unchanged fast path for ordinary-sized pull requests).
#   2. Local clone fallback: a blob-less partial clone of just the base and
#      head commits, diffed locally with no GitHub-imposed size limit.
#   3. `pulls/{pr}/files` API fallback, only if the clone itself cannot
#      reach the remote -- GitHub's own 406 message names this as the
#      documented alternative.
#
# A forward-merge pull request (title `chore: forward-merge ...` with a
# 2-parent head) reviews the conflict-resolution delta (second parent vs.
# head) instead of the full three-dot diff against base, so the review stays
# scoped to what a human actually resolved by hand.
#
# Whichever tier produced the diff, the result is passed through
# reorder-diff-sections.mjs so generated/lock/vendor/snapshot and test files
# sort to the tail -- the existing char-budget truncation in
# review-pipeline.js (planDiffBudget) already discloses omitted files
# honestly; this only controls which files it omits first when a diff is too
# large to review in full.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${PR_HEAD_SHA:?PR_HEAD_SHA is required}"
: "${PR_BASE_SHA:?PR_BASE_SHA is required}"
: "${DIFF_OUTPUT_PATH:?DIFF_OUTPUT_PATH is required}"

sha_re='^[0-9a-f]{40}$'
[[ "$PR_HEAD_SHA" =~ $sha_re ]] || { echo "::error::PR_HEAD_SHA must be an exact 40-character commit SHA"; exit 1; }
[[ "$PR_BASE_SHA" =~ $sha_re ]] || { echo "::error::PR_BASE_SHA must be an exact 40-character commit SHA"; exit 1; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gh_bin="${GH_BIN:-gh}"
pr_title="${PR_TITLE:-}"
work_dir=""

cleanup() {
  # Always exit 0: this runs as an EXIT trap, and its own exit status would
  # otherwise silently replace the script's real exit code (the common case
  # -- work_dir never created because gh pr diff succeeded on the first try
  # -- made `[[ -n "$work_dir" ... ]]` false, which failed the trap and
  # turned a successful run into a reported failure).
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf "$work_dir"
  fi
  return 0
}
trap cleanup EXIT

emit_output() {
  local name="$1" value="$2"
  echo "${name}=${value}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${name}=${value}" >> "$GITHUB_OUTPUT"
  fi
}

# --- Step 1: preemptive size check -----------------------------------------
changed_files="" additions="" deletions=""
if pr_json="$("$gh_bin" api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '{changed_files,additions,deletions}' 2>/dev/null)"; then
  changed_files="$(jq -r '.changed_files // empty' <<<"$pr_json")"
  additions="$(jq -r '.additions // empty' <<<"$pr_json")"
  deletions="$(jq -r '.deletions // empty' <<<"$pr_json")"
fi

decide() {
  PR_DIFF_CHANGED_FILES="$changed_files" \
  PR_DIFF_ADDITIONS="$additions" \
  PR_DIFF_DELETIONS="$deletions" \
  PR_DIFF_TITLE="$pr_title" \
  GH_PR_DIFF_ATTEMPTED="${1:-false}" \
  GH_PR_DIFF_EXIT_CODE="${2:-}" \
  GH_PR_DIFF_STDERR="${3:-}" \
    node "${script_dir}/pr-diff-fallback-policy.mjs"
}

decision="$(decide)"
use_fallback="$(jq -r '.useFallback' <<<"$decision")"
attempt_primary="$(jq -r '.attemptPrimary' <<<"$decision")"
reason="$(jq -r '.reason' <<<"$decision")"
forward_merge="$(jq -r '.forwardMerge' <<<"$decision")"

raw_diff_file=""
fallback_mode="none"

# --- Step 2: primary path ---------------------------------------------------
if [[ "$attempt_primary" == "true" ]]; then
  primary_out="$(mktemp)"
  primary_err="$(mktemp)"
  primary_rc=0
  "$gh_bin" pr diff "$PR_NUMBER" --repo "$REPO" > "$primary_out" 2> "$primary_err" || primary_rc=$?

  if [[ "$primary_rc" -eq 0 ]]; then
    raw_diff_file="$primary_out"
  else
    stderr_text="$(cat "$primary_err")"
    decision="$(decide true "$primary_rc" "$stderr_text")"
    use_fallback="$(jq -r '.useFallback' <<<"$decision")"
    reason="$(jq -r '.reason' <<<"$decision")"
    fatal="$(jq -r '.fatal // false' <<<"$decision")"

    if [[ "$fatal" == "true" ]]; then
      echo "::error::gh pr diff failed for a reason other than the GitHub diff size limit:"
      cat "$primary_err" >&2
      exit "$primary_rc"
    fi
    echo "::warning::gh pr diff hit the GitHub diff size limit for ${REPO}#${PR_NUMBER}; falling back to a local diff. ($(tr '\n' ' ' < "$primary_err" | cut -c1-300))"
  fi
fi

# --- Step 3: local-clone fallback ------------------------------------------
if [[ "$use_fallback" == "true" && -z "$raw_diff_file" ]]; then
  work_dir="$(mktemp -d)"
  clone_diff_file="${work_dir}/clone.diff"
  clone_ok=false
  clone_err_file="${work_dir}/clone.err"

  # NOTE: a subshell used as the tested command of `&&`/`if` loses `set -e`
  # even when it re-declares `set -e` internally -- POSIX exempts "any
  # command of an AND-OR list other than the last" from errexit, and bash
  # applies that exemption to the whole subshell, so a failing `git fetch`
  # or `git merge-base` inside would silently be ignored and execution would
  # continue on with empty/wrong shas. Disabling the outer `set -e` around a
  # *standalone* subshell invocation, then reading $? explicitly, is the
  # documented-safe way to run a `set -e` subshell and still check whether
  # it failed.
  set +e
  (
    set -euo pipefail
    cd "$work_dir"
    git init -q
    remote_url="${PR_DIFF_REMOTE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git}"
    git remote add origin "$remote_url"
    git -c protocol.version=2 fetch -q --filter=blob:none --no-tags origin "$PR_BASE_SHA" "$PR_HEAD_SHA"

    diff_base="$PR_BASE_SHA"
    used_mode="git-clone"

    if [[ "$forward_merge" == "true" ]]; then
      parent_count="$(git show -s --format=%P "$PR_HEAD_SHA" | wc -w | tr -d ' ')"
      if [[ "$parent_count" == "2" ]]; then
        second_parent="$(git show -s --format=%P "$PR_HEAD_SHA" | awk '{print $2}')"
        if git -c protocol.version=2 fetch -q --filter=blob:none --no-tags origin "$second_parent"; then
          diff_base="$second_parent"
          used_mode="forward-merge-conflict-delta"
        fi
      fi
    fi

    merge_base_sha="$(git merge-base "$diff_base" "$PR_HEAD_SHA")"
    git diff --find-renames "$merge_base_sha" "$PR_HEAD_SHA" > "$clone_diff_file"
    echo "$used_mode" > "${work_dir}/mode"
  ) 2> "$clone_err_file"
  clone_rc=$?
  set -e
  if [[ "$clone_rc" -eq 0 ]]; then
    clone_ok=true
  fi

  if [[ "$clone_ok" == "true" ]]; then
    raw_diff_file="$clone_diff_file"
    fallback_mode="$(cat "${work_dir}/mode")"
  else
    echo "::warning::Local-clone diff fallback could not reach ${REPO}; trying the pull request files API instead. ($(tr '\n' ' ' < "$clone_err_file" | cut -c1-300))"
  fi
fi

# --- Step 4: gh files API fallback (clone unreachable) ----------------------
if [[ "$use_fallback" == "true" && -z "$raw_diff_file" ]]; then
  files_json="$(mktemp)"
  # `gh api --paginate` merges every page's array response into a single
  # JSON array in its own output when no --jq is given.
  if "$gh_bin" api --paginate "repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100" > "$files_json" 2>/dev/null; then
    synthesized="$(mktemp)"
    node "${script_dir}/synthesize-diff-from-files-api.mjs" < "$files_json" > "$synthesized"
    raw_diff_file="$synthesized"
    fallback_mode="gh-files-api"
  else
    echo "::error::Every diff-acquisition path failed for ${REPO}#${PR_NUMBER} (gh pr diff, local clone, and the files API)."
    exit 1
  fi
fi

# --- Step 5: reorder and publish --------------------------------------------
if [[ -z "$raw_diff_file" ]]; then
  echo "::error::No diff was produced and no fallback was attempted; this is a bug in fetch-pr-diff.sh."
  exit 1
fi

node "${script_dir}/reorder-diff-sections.mjs" < "$raw_diff_file" > "$DIFF_OUTPUT_PATH"

used_fallback_bool="false"
[[ "$fallback_mode" != "none" ]] && used_fallback_bool="true"

emit_output used-fallback "$used_fallback_bool"
emit_output fallback-mode "$fallback_mode"
emit_output fallback-reason "$reason"
echo "Fetched $(wc -l < "$DIFF_OUTPUT_PATH" | tr -d ' ') diff lines for ${REPO}#${PR_NUMBER} (fallback=${used_fallback_bool}, mode=${fallback_mode})."
