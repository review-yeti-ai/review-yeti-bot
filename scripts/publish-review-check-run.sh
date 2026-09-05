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

# DISPATCHED is not a verdict -- it means the review was handed to the DOKS queue and
# the Review Yeti GitHub App gate will report the real outcome on this same head.
# scripts/check-review-verdict.sh already treats DISPATCHED + PENDING as a pass for
# exactly that reason, but this publisher mapped "anything not SHIP" to `failure`, so
# the two disagreed: the run succeeded while the published check said the review had
# failed. Consumers saw a red required check for a review that had not concluded, and
# nothing ever superseded it.
#
# Publish it as still running instead. `in_progress` carries no conclusion, so it keeps
# the required check blocking (a stuck dispatch must not merge) without asserting a
# failure that never happened. The App gate completes this check when the verdict lands.
if [[ "${REVIEW_STATUS:-}" == "DISPATCHED" ]]; then
  echo "Publishing Check Run 'Review Yeti' (in_progress, awaiting App gate) to ${TARGET_REPO} on ${HEAD_SHA}..."
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$(jq -nc \
      --arg name "Review Yeti" \
      --arg head_sha "${HEAD_SHA}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg summary "Review Yeti was dispatched to the DOKS queue for this exact head. The Review Yeti GitHub App gate reports the verdict and completes this check. See [central run](${CENTRAL_RUN_URL})." \
      '{
        name: $name,
        head_sha: $head_sha,
        status: "in_progress",
        details_url: $details_url,
        output: {
          title: "Review Yeti: dispatched, awaiting verdict",
          summary: $summary
        }
      }')" || {
    echo "::warning::Failed to publish in-progress check-run to ${TARGET_REPO}."
  }
  exit 0
fi

# REVIEW_YETI_PASSTHROUGH mode fabricates a SHIP verdict with zero review lanes run
# (see scripts/deliver-passthrough.sh). Before this change the publisher below mapped
# that fabricated SHIP the same as a real one and posted `success`, so a PR merged on
# the strength of a genuinely passing-looking required check when no persona had run.
# `neutral` does not block a required check, so the escape hatch keeps unblocking the
# fleet, but the PR timeline honestly shows that nothing reviewed this head.
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

conclusion="success"
if [[ "${REVIEW_STATUS:-}" != "SHIP" ]]; then
  conclusion="failure"
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
    --arg title "Review Yeti: ${REVIEW_STATUS:-SHIP}" \
    --arg summary "Review Yeti central evaluation finished with verdict: ${REVIEW_STATUS:-SHIP}. See details in [central run](${CENTRAL_RUN_URL})." \
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
