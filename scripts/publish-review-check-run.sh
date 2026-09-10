#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${TARGET_REPO:=}"
: "${HEAD_SHA:=}"
: "${REVIEW_STATUS:=}"
: "${CENTRAL_RUN_URL:=}"
: "${REVIEW_YETI_PASSTHROUGH:=}"
: "${REVIEW_YETI_EXECUTION_BACKEND:=local}"
: "${CHECK_ID:=}"

if [[ -z "${TARGET_REPO:-}" || -z "${HEAD_SHA:-}" ]]; then
  echo "::warning::Missing TARGET_REPO or HEAD_SHA; skipping check-run publication."
  exit 0
fi

publish_passthrough_check() {
  local name="$1"
  local payload
  payload="$(jq -nc \
    --arg name "$name" \
    --arg head_sha "${HEAD_SHA}" \
    --arg details_url "${CENTRAL_RUN_URL}" \
    --arg summary "Review Yeti is in passthrough mode (REVIEW_YETI_PASSTHROUGH). No panel ran. Conclusion is skipped — not a SHIP. The merge queue may proceed on a skipped required check. See [central run](${CENTRAL_RUN_URL})." \
    --arg title "${name}: SKIPPED (passthrough — no review)" \
    '{
      name: $name,
      head_sha: $head_sha,
      status: "completed",
      conclusion: "skipped",
      details_url: $details_url,
      output: {
        title: $title,
        summary: $summary
      }
    }')"
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$payload" || {
    echo "::warning::Failed to publish passthrough check-run '${name}' to ${TARGET_REPO}."
  }
}

# Passthrough must publish even when the fleet backend is DOKS: the worker is
# not dispatched, so if we skip Checks API writes here the required App gate
# never appears and merges stay blocked.
if [[ "${REVIEW_YETI_PASSTHROUGH:-}" == "true" ]]; then
  echo "Publishing passthrough Check Runs (skipped, not SHIP) to ${TARGET_REPO} on ${HEAD_SHA}..."
  publish_passthrough_check "Review Yeti"
  publish_passthrough_check "Review Yeti Gate"
  exit 0
fi

# DOKS is an asynchronous handoff. The worker owns the only raw `Review Yeti`
# check-run publication for this backend; the central action must not create a
# placeholder or try to reuse a check ID that does not exist in this workflow.
if [[ "${REVIEW_YETI_EXECUTION_BACKEND}" == "doks" ]]; then
  doks_status="${REVIEW_STATUS:-MISSING_VERDICT}"
  doks_receipt="Review Yeti DOKS backend returned ${doks_status} for ${TARGET_REPO}@${HEAD_SHA}; central check-run publication was skipped because the DOKS worker is the only raw 'Review Yeti' publisher."
  echo "::notice::${doks_receipt}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Review Yeti: DOKS dispatch/publication receipt"
      echo
      echo "${doks_receipt}"
      echo "- Central Checks API writes: 0"
      if [[ -n "${CENTRAL_RUN_URL}" ]]; then
        echo "- Central run: ${CENTRAL_RUN_URL}"
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

# An ABSENT verdict is not a verdict. This block used to interpolate the verdict
# with a shell default of SHIP, so when check-review-verdict.sh had just
# errored with "Review Yeti did not produce a verdict; an earlier workflow step
# failed", the published check still read "Review Yeti: SHIP" and its summary
# still said "central evaluation finished with verdict: SHIP". The conclusion was
# correctly `failure`, so the gate held -- but the text asserted an approval that
# no persona ever gave, on a head no panel ever reviewed. Observed on
# example-workspace#2554. That is manufactured evidence, and it reads as approval to
# anyone scanning the PR rather than the run log.
#
# Name the absence instead, and keep it failing.
conclusion="success"
verdict="${REVIEW_STATUS:-}"
if [[ -z "${verdict}" ]]; then
  conclusion="failure"
  title="Review Yeti: NO VERDICT (no panel result for this head)"
  summary="Review Yeti published no verdict for this head: an earlier step in the central run did not complete, so no persona judged this commit. This is a failure to review, not a review that failed, and it is not an approval. See [central run](${CENTRAL_RUN_URL})."
elif [[ "${verdict}" != "SHIP" ]]; then
  conclusion="failure"
  title="Review Yeti: ${verdict}"
  summary="Review Yeti central evaluation finished with verdict: ${verdict}. See details in [central run](${CENTRAL_RUN_URL})."
else
  title="Review Yeti: ${verdict}"
  summary="Review Yeti central evaluation finished with verdict: ${verdict}. See details in [central run](${CENTRAL_RUN_URL})."
fi

echo "Publishing Check Run 'Review Yeti' (${conclusion}) to ${TARGET_REPO} on ${HEAD_SHA}..."
if [[ -n "${CHECK_ID:-}" ]]; then
  curl -sS -X PATCH \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs/${CHECK_ID}" \
    -d "$(jq -nc \
      --arg name "Review Yeti" \
      --arg conclusion "${conclusion}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg title "${title}" \
      --arg summary "${summary}" \
      '{
        name: $name,
        status: "completed",
        conclusion: $conclusion,
        details_url: $details_url,
        output: {
          title: $title,
          summary: $summary
        }
      }')" || {
    echo "::warning::Failed to update check-run ${CHECK_ID} in ${TARGET_REPO}."
  }
else
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$(jq -nc \
      --arg name "Review Yeti" \
      --arg head_sha "${HEAD_SHA}" \
      --arg conclusion "${conclusion}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg title "${title}" \
      --arg summary "${summary}" \
      '{
        name: $name,
        head_sha: $head_sha,
        status: "completed",
        conclusion: $conclusion,
        details_url: $details_url,
        output: {
          title: $title,
          summary: $summary
        }
      }')" || {
    echo "::warning::Failed to publish check-run to ${TARGET_REPO}."
  }
fi
