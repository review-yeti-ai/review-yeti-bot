#!/usr/bin/env bash
set -uo pipefail

# Best-effort self-cancellation for a run whose review request is provably stale (the PR head
# moved while this run was in flight). Cancelling paints the run "cancelled" instead of
# "failure" on a SHA that no longer blocks anything -- pure noise otherwise (example-api #4396:
# failures at 16:04 and 16:06, then SHIP at 16:08 on the newer head).
#
# This script never causes its caller to treat the run as a pass. `gh run cancel` only
# *requests* cancellation; GitHub applies it to the run asynchronously, so a caller invoking
# this script must still exit non-zero afterward as a fail-closed backstop -- both because the
# request can be lost or delayed, and because a cancellation this script cannot confirm must
# never silently look like a pass. Exit 0 here means cancellation was observed to take effect
# (best case: GitHub reports the run cancelled before the caller's own exit runs and races it).
# Exit 1 means cancellation was requested but not confirmed within the bounded wait.
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required to self-cancel}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"

gh run cancel "$GITHUB_RUN_ID" --repo "$REVIEW_REPOSITORY" >/dev/null 2>&1 || true

attempts="${SELF_CANCEL_WAIT_ATTEMPTS:-30}"
interval="${SELF_CANCEL_WAIT_INTERVAL:-2}"

i=0
while (( i < attempts )); do
  cancellation_state="$(gh run view "$GITHUB_RUN_ID" --repo "$REVIEW_REPOSITORY" --json status,conclusion --jq 'if .status == "completed" and .conclusion == "cancelled" then "cancelled" else "not-cancelled" end' 2>/dev/null || true)"
  if [[ "$cancellation_state" == "cancelled" ]]; then
    echo "::notice::Run ${GITHUB_RUN_ID} in ${REVIEW_REPOSITORY} confirmed cancelled."
    exit 0
  fi
  i=$((i + 1))
  if (( i < attempts )); then
    sleep "$interval"
  fi
done

echo "::warning::Requested cancellation of run ${GITHUB_RUN_ID} in ${REVIEW_REPOSITORY} but could not confirm it within ${attempts} attempts. Falling through to a fail-closed exit."
exit 1
