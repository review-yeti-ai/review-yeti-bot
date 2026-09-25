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

# DOKS is an asynchronous handoff. The worker owns the only raw `Review Yeti`
# check-run publication for this backend; the central action must not create a
# placeholder or try to reuse a check ID that does not exist in this workflow.
if [[ "${REVIEW_YETI_EXECUTION_BACKEND}" == "doks" ]] || [[ "${REVIEW_YETI_EXECUTION_BACKEND}" == "mars" ]]; then
  doks_status="${REVIEW_STATUS:-MISSING_VERDICT}"
  backend_label="DOKS"
  if [[ "${REVIEW_YETI_EXECUTION_BACKEND}" == "mars" ]]; then
    backend_label="MARS"
  fi
  if [[ "${REVIEW_YETI_PASSTHROUGH:-}" == "true" ]]; then
    doks_publication="passthrough does not dispatch a worker, so this central action publishes no target check and the protected raw check remains unsatisfied"
  else
    doks_publication="the ${backend_label} worker is the only publisher and publishes only the raw 'Review Yeti' check"
  fi
  doks_receipt="Review Yeti ${backend_label} backend returned ${doks_status} for ${TARGET_REPO}@${HEAD_SHA}; central check-run publication was skipped because ${doks_publication}."
  echo "::notice::${doks_receipt}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Review Yeti: ${backend_label} dispatch/publication receipt"
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

# Legacy hosted/local execution publishes the raw check plus `Review Yeti Gate`
# as a compatibility alias. This includes local passthrough, where both checks
# are honestly SKIPPED. Governed DOKS repositories must require only the raw
# App-owned `Review Yeti` check; the DOKS branch above always writes zero checks.
if [[ "${REVIEW_YETI_PASSTHROUGH:-}" == "true" ]]; then
  echo "Publishing legacy local passthrough Check Runs (skipped, not SHIP) to ${TARGET_REPO} on ${HEAD_SHA}..."
  publish_passthrough_check "Review Yeti"
  publish_passthrough_check "Review Yeti Gate"
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

publish_completed_check() {
  local name="$1"
  local check_title="${title/#Review Yeti:/${name}:}"

  echo "Publishing Check Run '${name}' (${conclusion}) to ${TARGET_REPO} on ${HEAD_SHA}..."
  curl -sS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${TARGET_REPO}/check-runs" \
    -d "$(jq -nc \
      --arg name "${name}" \
      --arg head_sha "${HEAD_SHA}" \
      --arg conclusion "${conclusion}" \
      --arg details_url "${CENTRAL_RUN_URL}" \
      --arg title "${check_title}" \
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
    echo "::warning::Failed to publish check-run '${name}' to ${TARGET_REPO}."
  }
}

if [[ -n "${CHECK_ID:-}" ]]; then
  echo "Updating Check Run 'Review Yeti' (${conclusion}) in ${TARGET_REPO} on ${HEAD_SHA}..."
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
  publish_completed_check "Review Yeti"
fi

# Preserve the legacy hosted/local compatibility alias. It is App-owned and
# bound to the same head, but it is not the governed DOKS protection contract.
publish_completed_check "Review Yeti Gate"
