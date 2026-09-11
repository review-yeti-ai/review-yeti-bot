#!/usr/bin/env bash
set -euo pipefail

target_repo="${TARGET_REPO:-${REVIEW_REPOSITORY:-}}"
pr_number="${PR_NUMBER:-${REVIEW_PR_NUMBER:-}}"
head_sha="${HEAD_SHA:-${EXPECTED_HEAD_SHA:-}}"
base_sha="${BASE_SHA:-${EXPECTED_BASE_SHA:-}}"
execution_backend="${REVIEW_YETI_EXECUTION_BACKEND:-local}"

if [[ -z "$target_repo" || -z "$pr_number" || -z "$head_sha" || -z "$base_sha" ]]; then
  echo "::error::Missing required environment coordinates for Review Yeti passthrough delivery."
  exit 1
fi

# Passthrough never claims SHIP. Legacy hosted/local execution publishes
# skipped checks, while DOKS suppresses worker dispatch and therefore publishes
# no check at all; its protected raw App check remains unsatisfied.
if [[ "$execution_backend" == "doks" ]]; then
  passthrough_impact="DOKS passthrough suppresses worker dispatch. No Review Yeti check is published. The protected raw App check remains unsatisfied, so merge remains blocked."
  merge_eligible="false"
else
  passthrough_impact="This is not a SHIP. The Gate check is **skipped** so the merge queue can continue without pretending a panel ran."
  merge_eligible="true"
fi

echo "====================================================="
echo "Review Yeti: Passthrough Mode Active"
echo "Target: ${target_repo}#${pr_number} at ${head_sha}"
echo "No review was completed; scheduled maintenance in progress."
echo "Verdict: SKIPPED (not a SHIP)"
echo "$passthrough_impact"
echo "====================================================="

comment_body="### Review Yeti: SKIPPED (passthrough)

**No automated review was performed on this head.** Review Yeti is in passthrough mode.

${passthrough_impact}

<!-- ct-review-bot:passthrough:SKIPPED -->"

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
    verdict: "SKIPPED",
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

echo "Emitted SKIPPED run report to ${report_path}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "run-report-path=${report_path}" >> "$GITHUB_OUTPUT"
  echo "review-status=SKIPPED" >> "$GITHUB_OUTPUT"
  echo "gate-decision=SKIPPED" >> "$GITHUB_OUTPUT"
  echo "merge-eligible=${merge_eligible}" >> "$GITHUB_OUTPUT"
  echo "files-omitted=0" >> "$GITHUB_OUTPUT"
  echo "review-dispatch-reflection-status=complete" >> "$GITHUB_OUTPUT"
  echo "review-dispatch-provider-receipt-digest=" >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Review Yeti: SKIPPED (passthrough)"
    echo "No automated review was performed. ${passthrough_impact}"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Passthrough delivery completed cleanly."
