#!/usr/bin/env bash
set -euo pipefail

target_repo="${TARGET_REPO:-${REVIEW_REPOSITORY:-}}"
pr_number="${PR_NUMBER:-${REVIEW_PR_NUMBER:-}}"
head_sha="${HEAD_SHA:-${EXPECTED_HEAD_SHA:-}}"
base_sha="${BASE_SHA:-${EXPECTED_BASE_SHA:-}}"

if [[ -z "$target_repo" || -z "$pr_number" || -z "$head_sha" || -z "$base_sha" ]]; then
  echo "::error::Missing required environment coordinates for Review Yeti passthrough delivery."
  exit 1
fi

# Plan item 0.1. Passthrough used to publish SHIP with a body stating no review
# was completed, and a pull request merged on one. A verdict that reviewed
# nothing is not an approval, so this path now emits NO_REVIEW and blocks by
# default. Passthrough remains a legitimate maintenance escape hatch; what
# changes is that using it can no longer be mistaken for a passing review.
#
# There is deliberately no environment knob that unblocks. `ON_NO_REVIEW=neutral`
# used to be documented here as an operator escape hatch; it never worked --
# check-review-verdict.sh rejects any status that is not SHIP, so a NEUTRAL gate
# decision from this script was overruled one step later regardless. A capability
# that is described but does not exist is the exact failure this lane keeps
# producing, so the knob is gone rather than plumbed: an absent review must
# block, and the recorded operator path is a human review, not a flag.

echo "====================================================="
echo "Review Yeti: Passthrough Mode Active"
echo "Target: ${target_repo}#${pr_number} at ${head_sha}"
echo "No review was completed; scheduled maintenance in progress."
echo "Verdict: NO_REVIEW (blocks; passthrough is not an approval)"
echo "====================================================="

comment_body="### 🛑 Review Yeti: NO_REVIEW (Passthrough Mode)

**No automated review was performed on this head.** Review Yeti is in passthrough mode for scheduled maintenance.

This is not an approval. Nothing about this pull request has been assessed, so
this check must not be read as evidence that it is safe to merge.

**What you can do:** wait for passthrough to be lifted and push a new commit (or
re-run the review) to get a real verdict, or have an operator merge deliberately
with a human review recorded in its place.

<!-- ct-review-bot:passthrough:NO_REVIEW -->"

if command -v gh >/dev/null 2>&1 && [[ -n "${GH_TOKEN:-}" ]]; then
  echo "Publishing passthrough comment to ${target_repo}#${pr_number}..."
  gh pr comment "$pr_number" --repo "$target_repo" --body "$comment_body" || {
    echo "::warning::Failed to post passthrough comment to PR via gh CLI."
  }
else
  echo "gh CLI or GH_TOKEN not available; skipping PR comment publishing."
fi

report_dir="${RUNNER_TEMP:-/tmp}"
report_path="${report_dir}/review-yeti-run-report-${pr_number}-${head_sha:0:12}.json"

jq -nc \
  --arg repo "$target_repo" \
  --argjson pr "$pr_number" \
  --arg base "$base_sha" \
  --arg head "$head_sha" \
  '{
    schemaVersion: "review-run-report-v1",
    repository: $repo,
    prNumber: $pr,
    baseSha: $base,
    headSha: $head,
    verdict: "NO_REVIEW",
    lanes: [],
    scope: {
      schemaVersion: "review-scope-v1",
      mode: "passthrough",
      planDigest: "passthrough",
      fullDiffDigest: "passthrough",
      fullDiffChars: 0,
      reviewedDiffDigest: "passthrough",
      reviewedDiffChars: 0,
      parentHeadSha: null,
      parentReportDigest: null,
      reviewedPersonaIds: [],
      reusedPersonaIds: [],
      fallbackReason: "passthrough_mode"
    }
  }' > "$report_path"

echo "Emitted NO_REVIEW run report to ${report_path}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "run-report-path=${report_path}" >> "$GITHUB_OUTPUT"
  echo "review-status=NO_REVIEW" >> "$GITHUB_OUTPUT"
  echo "gate-decision=BLOCK" >> "$GITHUB_OUTPUT"
  echo "merge-eligible=false" >> "$GITHUB_OUTPUT"
  echo "files-omitted=0" >> "$GITHUB_OUTPUT"
  echo "review-dispatch-reflection-status=complete" >> "$GITHUB_OUTPUT"
  echo "review-dispatch-provider-receipt-digest=" >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### 🛑 Review Yeti: NO_REVIEW (Passthrough Mode)"
    echo "No automated review was performed on this head. This is not an approval."
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Passthrough delivery completed cleanly."
