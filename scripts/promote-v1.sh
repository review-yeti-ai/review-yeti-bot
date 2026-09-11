#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"
: "${EXPECTED_OLD_V1_SHA:?EXPECTED_OLD_V1_SHA is required}"

if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::SOURCE_SHA must be an exact lowercase 40-character commit SHA."
  exit 1
fi
if [[ ! "$EXPECTED_OLD_V1_SHA" =~ ^[0-9a-f]{40}$ && "$EXPECTED_OLD_V1_SHA" != absent ]]; then
  echo "::error::EXPECTED_OLD_V1_SHA must be an exact lowercase 40-character commit SHA or 'absent'."
  exit 1
fi

repository="${GITHUB_REPOSITORY:-exampleorg/example-review-actions}"
actor="${GITHUB_ACTOR:-unknown}"
review_yeti_app_id="4385771"
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
source_check_runs="$(gh api "repos/${repository}/commits/${SOURCE_SHA}/check-runs?filter=all&per_page=100")"
pr_check_runs="$(gh api "repos/${repository}/commits/${pr_head}/check-runs?filter=all&per_page=100")"

require_success() {
  local check_runs="$1"
  local name="$2"
  local coordinate="$3"
  local endpoint="${4:-}"
  local required_app_id="${5:-}"
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
    latest="$(jq -c --arg name "$name" --arg app_id "$required_app_id" '
      [.check_runs[]
       | select(.name == $name)
       | select($app_id == "" or ((.app.id | tostring) == $app_id))] |
      sort_by(.id) | last // {}
    ' <<<"$check_runs")"
    status="$(jq -r '.status // empty' <<<"$latest")"
    conclusion="$(jq -r '.conclusion // empty' <<<"$latest")"

    if [[ "$status" == completed && "$conclusion" == success ]]; then
      required_check_id="$(jq -r '.id // empty' <<<"$latest")"
      [[ "$required_check_id" =~ ^[0-9]+$ ]] || {
        echo "::error::Required central check for ${coordinate} has no immutable check-run id."
        exit 1
      }
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
  "repos/${repository}/commits/${SOURCE_SHA}/check-runs?filter=all&per_page=100"
validate_check_id="$required_check_id"

# Promotion is release-channel authority, so review evidence is exact-head and
# exact-App only. An earlier PR commit or same-name Actions check cannot qualify.
# The deployed DOKS worker owns the raw `Review Yeti` check. Binding both its
# exact name and App ID makes it authoritative without confusing it with the
# similarly named Actions job. The legacy local `Review Yeti Gate` alias is not
# promotion evidence; that name remains reserved in DOKS for the separately
# controlled service-owned gate rollout.
require_success "$pr_check_runs" 'Review Yeti' "PR #${pr_number} head ${pr_head}" \
  "repos/${repository}/commits/${pr_head}/check-runs?filter=all&per_page=100" \
  "$review_yeti_app_id"
green_review_sha="$pr_head"
green_review_check_id="$required_check_id"

[[ "$green_review_check_id" =~ ^[0-9]+$ ]] || {
  echo "::error::Review Yeti evidence has no immutable check-run id."
  exit 1
}

old_v1=""
branch_exists=false
tag_exists=false
legacy_tag_ref_sha=""
if git ls-remote --exit-code origin refs/heads/v1 >/dev/null 2>&1; then
  branch_exists=true
  git fetch --no-tags origin refs/heads/v1:refs/remotes/origin/v1
  old_v1="$(git rev-parse refs/remotes/origin/v1)"
fi

if tag_ref="$(git ls-remote --exit-code origin refs/tags/v1 2>/dev/null)"; then
  tag_exists=true
  legacy_tag_ref_sha="$(awk 'NR == 1 { print $1 }' <<<"$tag_ref")"
  git fetch --no-tags origin refs/tags/v1:refs/tags/v1-legacy
  legacy_v1="$(git rev-parse refs/tags/v1-legacy^{})"
  if [[ "$branch_exists" == true && "$legacy_v1" != "$old_v1" ]]; then
    echo "::error::Ambiguous v1 refs: branch ${old_v1} and legacy tag ${legacy_v1} diverge; refusing promotion."
    exit 1
  fi
  old_v1="${old_v1:-$legacy_v1}"
fi

if [[ "$EXPECTED_OLD_V1_SHA" == absent ]]; then
  [[ -z "$old_v1" ]] || {
    echo "::error::Expected v1 to be absent, but it currently resolves to ${old_v1}; refusing stale promotion."
    exit 1
  }
elif [[ "$old_v1" != "$EXPECTED_OLD_V1_SHA" ]]; then
  echo "::error::Expected v1 at ${EXPECTED_OLD_V1_SHA}, but observed ${old_v1:-<absent>}; refusing stale promotion."
  exit 1
fi

if [[ -n "$old_v1" ]]; then
  git merge-base --is-ancestor "$old_v1" "$SOURCE_SHA" || {
    echo "::error::Refusing non-fast-forward v1 promotion from ${old_v1} to ${SOURCE_SHA}."
    exit 1
  }
fi

validation_payload="$(jq -cn \
  --arg repository "$repository" \
  --arg source_sha "$SOURCE_SHA" \
  --argjson pr_number "$pr_number" \
  --arg pr_head_sha "$pr_head" \
  --arg review_sha "$green_review_sha" \
  --argjson review_app_id "$review_yeti_app_id" \
  --argjson validate_check_run_id "$validate_check_id" \
  --argjson review_check_run_id "$green_review_check_id" \
  '{repository:$repository,source_sha:$source_sha,pr_number:$pr_number,pr_head_sha:$pr_head_sha,review_sha:$review_sha,review_app_id:$review_app_id,validate_check_run_id:$validate_check_run_id,review_check_run_id:$review_check_run_id}')"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

validation_digest="$(printf '%s' "$validation_payload" | sha256)"
receipt_path="${PROMOTION_RECEIPT_PATH:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/review-yeti-v1-promotion-receipt.json}"

prepare_receipt() {
  local result="$1"
  local write_performed="$2"
  local promoted_at

  promoted_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  prepared_receipt_tmp="${receipt_path}.prepared.$$"
  mkdir -p "$(dirname "$receipt_path")"
  jq -n \
    --arg actor "$actor" \
    --arg promoted_at "$promoted_at" \
    --arg repository "$repository" \
    --arg source_sha "$SOURCE_SHA" \
    --argjson pr_number "$pr_number" \
    --arg pr_head_sha "$pr_head" \
    --arg review_sha "$green_review_sha" \
    --argjson review_app_id "$review_yeti_app_id" \
    --argjson validate_check_run_id "$validate_check_id" \
    --argjson review_check_run_id "$green_review_check_id" \
    --arg validation_digest "$validation_digest" \
    --arg expected_old_v1_sha "$EXPECTED_OLD_V1_SHA" \
    --arg observed_old_v1_sha "${old_v1:-absent}" \
    --arg new_v1_sha "$SOURCE_SHA" \
    --arg result "$result" \
    --argjson write_performed "$write_performed" \
    '{schema:"exampleorg.review-yeti-v1-promotion-receipt.v1",actor:$actor,promoted_at:$promoted_at,repository:$repository,release:{source_sha:$source_sha,pr_number:$pr_number,pr_head_sha:$pr_head_sha},validation:{review_sha:$review_sha,review_app_id:$review_app_id,validate_check_run_id:$validate_check_run_id,review_check_run_id:$review_check_run_id,digest:$validation_digest},refs:{expected_old_v1_sha:$expected_old_v1_sha,observed_old_v1_sha:$observed_old_v1_sha,new_v1_sha:$new_v1_sha},rollback:{strategy:"create-reviewed-revert-on-main-then-promote",baseline_sha:$observed_old_v1_sha,direct_ref_rewind_allowed:false},result:$result,write_performed:$write_performed}' \
    >"$prepared_receipt_tmp"
}

publish_receipt() {
  mv "$prepared_receipt_tmp" "$receipt_path"
}

if [[ "$old_v1" == "$SOURCE_SHA" && "$branch_exists" == true && "$tag_exists" == false ]]; then
  prepare_receipt already-promoted false
  publish_receipt
  echo "Review Yeti v1 already points to ${SOURCE_SHA}."
else
  push_args=(
    push
    --atomic
    "--force-with-lease=refs/heads/main:${SOURCE_SHA}"
  )
  if [[ "$branch_exists" == true ]]; then
    push_args+=("--force-with-lease=refs/heads/v1:${EXPECTED_OLD_V1_SHA}")
  else
    push_args+=("--force-with-lease=refs/heads/v1:")
  fi
  if [[ "$tag_exists" == true ]]; then
    push_args+=("--force-with-lease=refs/tags/v1:${legacy_tag_ref_sha}")
  fi
  push_args+=(origin "${SOURCE_SHA}:refs/heads/main" "${SOURCE_SHA}:refs/heads/v1")
  if [[ "$tag_exists" == true ]]; then
    push_args+=(':refs/tags/v1')
  fi

  # The no-op main refspec and its lease put the final main-tip assertion in
  # the same server-side atomic transaction as the v1 update. Any movement of
  # main, v1, or the legacy tag rejects the entire push before a ref changes.
  # Construct the complete receipt before that transaction so a successful
  # push has only a same-directory atomic rename left to publish it.
  prepare_receipt promoted true
  git "${push_args[@]}"
  publish_receipt
  echo "Promoted Review Yeti v1 from ${old_v1:-<uninitialized>} to ${SOURCE_SHA} via PR #${pr_number}."
  if [[ "$tag_exists" == true ]]; then
    echo "Removed legacy Review Yeti v1 tag in the same atomic promotion."
  fi
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Review Yeti v1 promotion"
    echo "- Source: \`${SOURCE_SHA}\`"
    echo "- Originating PR: #${pr_number}"
    echo "- Previous v1: \`${old_v1:-<uninitialized>}\`"
    echo "- New v1: \`${SOURCE_SHA}\`"
    echo "- Validation digest: \`${validation_digest}\`"
    echo "- Receipt: \`${receipt_path}\`"
    echo "- Mode: atomic compare-and-swap, fast-forward only"
  } >>"$GITHUB_STEP_SUMMARY"
fi
