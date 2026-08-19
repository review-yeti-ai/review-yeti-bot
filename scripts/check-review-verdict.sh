#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${REVIEW_PR_NUMBER:?REVIEW_PR_NUMBER is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"
: "${REVIEW_STATUS:?REVIEW_STATUS is required}"
: "${GATE_DECISION:?GATE_DECISION is required}"
: "${MERGE_ELIGIBLE:?MERGE_ELIGIBLE is required}"
: "${FILES_OMITTED:?FILES_OMITTED is required}"
: "${DISPATCH_REFLECTION_STATUS:?DISPATCH_REFLECTION_STATUS is required}"
# PROVIDER_RECEIPT_DIGEST is legitimately empty on a non-SHIP verdict (e.g.
# INCOMPLETE_REVIEW/BLOCKED) -- do not `:?`-crash the whole script on it.
# The regex check below already fails closed with a clean ::error:: BLOCK
# message for a missing or invalid digest.
: "${PROVIDER_RECEIPT_DIGEST:=}"

metadata="$(gh api "repos/${REVIEW_REPOSITORY}/pulls/${REVIEW_PR_NUMBER}")"
actual_base="$(jq -r '.base.sha // empty' <<<"$metadata")"
actual_head="$(jq -r '.head.sha // empty' <<<"$metadata")"

[[ "$actual_base" == "$EXPECTED_BASE_SHA" ]] || { echo "::error::Review became stale because the PR base changed"; exit 1; }

# See validate-review-request.sh for the full rationale: a superseded head means a newer run
# already owns this PR, so cancel instead of failing a dead SHA. Only this branch may cancel;
# every other check below keeps a plain exit 1, and this branch's own exit code stays non-zero
# regardless of whether cancellation is confirmed -- a SHIP/PASS verdict must never be accepted
# for a head that no longer matches the PR.
if [[ "$actual_head" != "$EXPECTED_HEAD_SHA" ]]; then
  echo "::notice::Review became stale because the PR head changed from $EXPECTED_HEAD_SHA to $actual_head. Self-cancelling instead of failing a superseded SHA that no longer blocks merge."
  "$(dirname "${BASH_SOURCE[0]}")/self-cancel-run.sh" || true
  exit 1
fi

[[ "$REVIEW_STATUS" == SHIP ]] || { echo "::error::Review Yeti verdict is ${REVIEW_STATUS}, not SHIP"; exit 1; }
[[ "$GATE_DECISION" == PASS ]] || { echo "::error::Review Yeti gate decision is ${GATE_DECISION}, not PASS"; exit 1; }
[[ "$MERGE_ELIGIBLE" == true ]] || { echo "::error::Review Yeti did not declare this exact-head review merge eligible"; exit 1; }
[[ "$FILES_OMITTED" == 0 ]] || { echo "::error::Review Yeti omitted ${FILES_OMITTED} changed files"; exit 1; }
[[ "$DISPATCH_REFLECTION_STATUS" == complete ]] || { echo "::error::Review Yeti dispatch reflection is ${DISPATCH_REFLECTION_STATUS}, not complete"; exit 1; }
[[ "$PROVIDER_RECEIPT_DIGEST" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "::error::Review Yeti provider receipt digest is missing or invalid"; exit 1; }
[[ -n "${RUN_REPORT_PATH:-}" ]] || { echo "::error::Review Yeti run report path is missing"; exit 1; }

[[ -f "$RUN_REPORT_PATH" ]] || { echo "::error::Review Yeti run report is missing: ${RUN_REPORT_PATH}"; exit 1; }

report_summary="$({
  jq -er \
    --arg expected_repository "$REVIEW_REPOSITORY" \
    --arg expected_pr "$REVIEW_PR_NUMBER" \
    --arg expected_base "$EXPECTED_BASE_SHA" \
    --arg expected_head "$EXPECTED_HEAD_SHA" \
    --arg expected_status "$REVIEW_STATUS" \
    '
      def nonnegative_integer:
        type == "number" and floor == . and . >= 0;
      def valid_pr_number:
        if (.prNumber | type) != "number" then
          false
        elif (.prNumber | floor) != .prNumber then
          false
        else
          .prNumber == ($expected_pr | tonumber)
        end;
      def valid_lane:
        type == "object"
        and (.decision | type == "string")
        and (.findings | type == "array")
        and (.severity | type == "object")
        and ((.severity) as $severity
          | (["P0", "P1", "P2"] | all(.[]; . as $key | ($severity[$key] | nonnegative_integer))));
      def valid_finding:
        type == "object"
        and (.severity == "P0" or .severity == "P1" or .severity == "P2");

      if .schemaVersion != "review-run-report-v1" then
        error("unsupported run-report schema")
      elif (.repository | type) != "string" or .repository != $expected_repository then
        error("run-report repository does not match the reviewed repository")
      elif (valid_pr_number | not) then
        error("run-report PR number does not match the reviewed PR")
      elif .baseSha != $expected_base or .headSha != $expected_head then
        error("run-report base/head does not match the exact reviewed head")
      elif .verdict != $expected_status then
        error("run-report verdict does not match the action output")
      elif (.lanes | type) != "array" or (.lanes | length) == 0 then
        error("run-report lanes are missing")
      elif any(.lanes[]; valid_lane | not) then
        error("run-report contains an invalid lane")
      elif any(.lanes[]?.findings[]?; valid_finding | not) then
        error("run-report contains an invalid finding")
      else
        ([.lanes[]?.findings[]? | select(.severity == "P2")] | length) as $finding_p2
        | ([.lanes[]?.severity.P2] | add // 0) as $summary_p2
        | if $finding_p2 != $summary_p2 then
            error("run-report P2 count is inconsistent")
          else
            { p2_count: $finding_p2 }
          end
      end
    ' \
    "$RUN_REPORT_PATH"
} 2>&1)" || {
  echo "::error::Review Yeti run report failed closed: ${report_summary}";
  exit 1;
}

p2_count="$(jq -er '.p2_count' <<<"$report_summary")"
[[ "$p2_count" == 0 ]] || {
  echo "::error::Review Yeti found ${p2_count} unresolved P2 advisory finding(s); SHIP/PASS is blocked";
  exit 1;
}

echo "Review Yeti SHIP/PASS accepted for ${REVIEW_REPOSITORY}#${REVIEW_PR_NUMBER} at exact head ${EXPECTED_HEAD_SHA}."
