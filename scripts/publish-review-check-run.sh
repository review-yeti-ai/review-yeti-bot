#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${TARGET_REPO:=}"
: "${HEAD_SHA:=}"
: "${REVIEW_STATUS:=}"
: "${CENTRAL_RUN_URL:=}"
: "${REVIEW_YETI_PASSTHROUGH:=}"

if [[ -z "${TARGET_REPO:-}" || -z "${HEAD_SHA:-}" ]]; then
  echo "::warning::Missing TARGET_REPO or HEAD_SHA; skipping check-run publication."
  exit 0
fi

# DISPATCHED is not a verdict -- it means the review was handed to the DOKS queue
# and no persona has judged this head yet. scripts/check-review-verdict.sh already
# treats DISPATCHED + PENDING as a pass for exactly that reason.
#
# The publisher used to map "anything not SHIP" to `failure`, so a review that had
# merely been queued was published as a failed review, and nothing superseded it.
# Publishing `in_progress` instead replaced that false red with a check that never
# completes: nothing in this repository finishes it, so every dispatched PR was
# left with a permanently pending check.
#
# Publish it the way passthrough is published: `completed` with `neutral`. Neutral
# asserts neither success nor failure and does not block a required check, so the
# PR timeline honestly shows that this head was queued rather than judged, and the
# check reaches a terminal state instead of hanging forever.
if [[ "${REVIEW_STATUS:-}" == "DISPATCHED" ]]; then
  echo "Publishing Check Run 'Review Yeti' (neutral, dispatched) to ${TARGET_REPO} on ${HEAD_SHA}..."
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$(jq -nc \
      --arg name "Review Yeti" \
      --arg head_sha "${HEAD_SHA}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg summary "Review Yeti dispatched this exact head to the DOKS queue; no persona verdict was published for it. This is a queue handoff, not an approval. See [central run](${CENTRAL_RUN_URL})." \
      '{
        name: $name,
        head_sha: $head_sha,
        status: "completed",
        conclusion: "neutral",
        details_url: $details_url,
        output: {
          title: "Review Yeti: DISPATCHED (no verdict for this head)",
          summary: $summary
        }
      }')" || {
    echo "::warning::Failed to publish dispatched check-run to ${TARGET_REPO}."
  }
  exit 0
fi

if [[ "${REVIEW_YETI_PASSTHROUGH:-}" == "true" ]]; then
  echo "Publishing Check Run 'Review Yeti' (neutral, passthrough) to ${TARGET_REPO} on ${HEAD_SHA}..."
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$(jq -nc \
      --arg name "Review Yeti" \
      --arg head_sha "${HEAD_SHA}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg summary "Review Yeti is in passthrough mode (REVIEW_YETI_PASSTHROUGH). No panel review was performed for this head; this is a maintenance escape hatch, not an approval. See [central run](${CENTRAL_RUN_URL})." \
      '{
        name: $name,
        head_sha: $head_sha,
        status: "completed",
        conclusion: "neutral",
        details_url: $details_url,
        output: {
          title: "Review Yeti: PASSTHROUGH (no review performed)",
          summary: $summary
        }
      }')" || {
    echo "::warning::Failed to publish passthrough check-run to ${TARGET_REPO}."
  }
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
