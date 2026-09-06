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

# DISPATCHED is not a verdict: the review was handed to the DOKS queue and no
# persona has judged this head.
#
# This state has now been all three conclusions, and the first two were wrong for
# opposite reasons. `failure` was a false red on a review that had merely been
# queued. `in_progress` never completed, because nothing in this repository
# finishes it, so every dispatched PR hung forever. `neutral` fixed the hang and
# is honest in its text -- but neutral does not block a required check, so 29 PRs
# across example-meta and example-api merged against a check that had never judged them.
#
# Honest and non-blocking is the worst combination available: it reads as a
# completed review to the merge button while asserting nothing. An absent verdict
# must block. `failure` is correct here precisely because it is not terminal in
# practice -- when publishing is enabled the real verdict supersedes this check
# run on the same head, and until then "no persona judged this commit" is a
# reason not to merge, not a neutral fact.
if [[ "${REVIEW_STATUS:-}" == "DISPATCHED" ]]; then
  echo "Publishing Check Run 'Review Yeti' (failure, dispatched — no verdict yet) to ${TARGET_REPO} on ${HEAD_SHA}..."
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$(jq -nc \
      --arg name "Review Yeti" \
      --arg head_sha "${HEAD_SHA}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg summary "Review Yeti dispatched this exact head to the DOKS queue; no persona verdict was published for it. This is a queue handoff, not an approval, and it blocks until a verdict supersedes it. See [central run](${CENTRAL_RUN_URL})." \
      '{
        name: $name,
        head_sha: $head_sha,
        status: "completed",
        conclusion: "failure",
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
